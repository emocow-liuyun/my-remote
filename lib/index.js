/**
 * @local/my-remote — 自家专用远程访问。
 *
 * 设计取舍（为什么不用市面上的插件）：
 * - 不绑 0.0.0.0：把 webserver 暴露到局域网等于绕过所有鉴权，官方 0.2.1-rc.2 起也拒绝通配绑定。
 * - 不做中继：流量只在你和 Cloudflare 隧道之间，不经任何第三方 Worker。
 * - 自带门控前缀 /myremote：官方运行时没有 api/gate 的 emitter，直连 /api 只受 harness 围栏约束，
 *   因此必须自己开一条代理通道，在转发任何字节前校验设备凭据。
 *
 * 安全模型：
 * - 本机设置固定密码，salt + scrypt 持久化；远程校验后签发设备凭据。
 * - 兑换成功签发 httpOnly 设备 cookie，写入磁盘（0600），重启后仍然有效。
 * - 每条 /myremote 请求先验设备 cookie，未通过直接 403，不转发。
 * - 吊销立即生效：下一次请求即 403。
 */
import { randomBytes } from 'node:crypto'
import { loadPassword, savePassword, verifyPassword, validPassword, readJson, createPairLimiter } from './password.js'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync as fsExists } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveSchemastery, nodeChildEnv, resolveCloudflared } from './runtime.js'

// dsh 自带的 @deepseek-ai/schemastery 不在 profile 的依赖树里。
// 依次尝试：插件自身的依赖树 → dsh 安装目录（由 DSH_ROOT 或从本进程 argv 推出）。
const schemaModule = resolveSchemastery()
const z = schemaModule.z ?? schemaModule.default ?? schemaModule
const schemaObject = z.object.bind(z)
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { PAIR_PAGE_HTML } from './page.js'

export const name = 'my-remote'
export const inject = ['webServer']

/** 远程通道前缀；改它等于让所有已配对设备的书签失效。 */
const PREFIX = '/myremote'
const PAIR_PATH = '/myremote/pair'
const DEVICES_PATH = '/myremote/devices'

function devicesFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'my-remote-devices.json')
}

function loadDevices() {
  const file = devicesFile()
  try {
    if (!existsSync(file)) return new Map()
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const map = new Map()
    for (const d of raw.devices ?? []) {
      if (typeof d?.id === 'string' && d.id.length >= 32) map.set(d.id, d)
    }
    return map
  } catch {
    return new Map()
  }
}

function saveDevices(devices) {
  const file = devicesFile()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify({ version: 1, devices: [...devices.values()] }, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch {
    // 写盘失败不应让服务瘫掉；内存态仍然生效。
  }
}

function readCookie(header, cookieName) {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** 转发头存在即视为经代理而来，绝不当成本机。 */
function isProxied(req) {
  return req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined
}

function isLoopbackClient(req) {
  if (isProxied(req)) return false
  const addr = (req.socket).remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

export const Config = schemaObject({
  cookieName: z.string().default('dsh-myremote'),
  idleExpireMs: z.number().default(1000 * 60 * 60 * 24 * 30),
  maxDevices: z.number().default(5),
  remoteEntry: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(3080),
  }).default({}),
  tunnel: z.object({
    enabled: z.boolean().default(false),
    tokenFile: z.string(),
    binary: z.string(),
  }).default({}),
})

export function apply(ctx, config = {}) {
  // 每个路由的 disposer 交给插件 fiber 管理，重载/禁用时随之撤销。
  const disposers = []
  // Desktop wraps every public webServer route in its renderer capability fence.
  // A private loopback bridge exposes only this plugin's device gate; host traffic
  // still goes through the unchanged Desktop + connection authentication fences.
  const bridgeRoutes = []
  const bridgeUpgrades = []
  // Current Desktop exposes port/host; older carriers may also expose getOrigin.
  // Keep all origin consumers on one lazy resolver (port can bind after apply).
  const hostOrigin = () => typeof ctx.webServer.getOrigin === 'function'
    ? ctx.webServer.getOrigin()
    : `http://127.0.0.1:${ctx.webServer.port}`
  const rendererHeader = () => ctx.get?.('desktopBrowserAccess')?.rendererHeader
  const hostHeaders = () => {
    const header = rendererHeader()
    return header ? { [header.name]: header.value } : {}
  }
  const route = (spec) => {
    const handler = spec.handler
    const registered = { ...spec, handler(req, res) {
      // Allow only the real local renderer origins, never arbitrary websites.
      const origin = req.headers.origin
      const allowed = origin === 'dsh-app://app' || origin === hostOrigin()
      if (origin && !allowed && ['/myremote/status', '/myremote/code', '/myremote/revoke', '/myremote/password'].includes(spec.path)) return sendJson(res, 403, { ok: false, code: 'origin-denied' })
      if (allowed && isLoopbackClient(req)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'content-type')
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      }
      return handler(req, res)
    } }
    bridgeRoutes.push(registered)
    disposers.push(ctx.webServer.register(registered))
  }

  const cookieName = config.cookieName ?? 'dsh-myremote'
  const idleExpireMs = config.idleExpireMs ?? 1000 * 60 * 60 * 24 * 30
  const maxDevices = config.maxDevices ?? 5

  const state = { password: loadPassword(), devices: loadDevices() }
  const limiter = createPairLimiter()
  const deviceSockets = new Set()
  const disconnectDevices = () => {
    state.devices.clear()
    for (const socket of deviceSockets) socket.destroy()
    deviceSockets.clear()
    saveDevices(state.devices)
  }

  const activeDevices = () => {
    const now = Date.now()
    let dirty = false
    for (const [id, d] of state.devices) {
      if (now - d.lastSeenAt > idleExpireMs) {
        state.devices.delete(id)
        dirty = true
      }
    }
    if (dirty) saveDevices(state.devices)
    return [...state.devices.values()]
  }

  const verify = (req) => {
    const id = readCookie(req.headers.cookie, cookieName)
    if (id === undefined) return undefined
    const device = state.devices.get(id)
    if (device === undefined) return undefined
    if (Date.now() - device.lastSeenAt > idleExpireMs) { state.devices.delete(id); saveDevices(state.devices); return undefined }
    device.lastSeenAt = Date.now()
    return device
  }

  // ---- 控制面：只应答回环（桌面本体），远程浏览器一律拒绝 ----
  route({
    kind: 'exact',
    path: '/myremote/status',
    handler: (req, res) => {
      if (!isLoopbackClient(req)) return sendJson(res, 403, { ok: false, code: 'loopback-only' })
      sendJson(res, 200, {
        ok: true,
        prefix: PREFIX,
        devices: activeDevices().map((d) => ({ name: d.name, online: Date.now() - d.lastSeenAt < 120_000, lastSeenAt: d.lastSeenAt })),
        passwordSet: state.password !== null,
      })
    },
  })

  route({
    kind: 'exact',
    path: '/myremote/code',
    handler: (req, res) => {
      if (!isLoopbackClient(req)) return sendJson(res, 403, { ok: false, code: 'loopback-only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      sendJson(res, 410, { ok: false, code: 'code-retired' })
    },
  })

  route({
    kind: 'exact',
    path: '/myremote/password',
    handler: async (req, res) => {
      if (!isLoopbackClient(req)) return sendJson(res, 403, { ok: false, code: 'loopback-only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      let body
      try { body = await readJson(req) } catch { return sendJson(res, 400, { ok: false, code: 'invalid-json' }) }
      if (!validPassword(body.password) || (body.revokeDevices !== undefined && typeof body.revokeDevices !== 'boolean')) return sendJson(res, 400, { ok: false, code: 'invalid-password' })
      try { state.password = await savePassword(body.password) } catch { return sendJson(res, 500, { ok: false, code: 'password-save-failed' }) }
      if (body.revokeDevices === true) disconnectDevices()
      sendJson(res, 200, { ok: true, passwordSet: true })
    },
  })

  route({
    kind: 'exact',
    path: '/myremote/revoke',
    handler: (req, res) => {
      if (!isLoopbackClient(req)) return sendJson(res, 403, { ok: false, code: 'loopback-only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      disconnectDevices()
      sendJson(res, 200, { ok: true, revoked: 'all' })
    },
  })

  // ---- 配对：凭固定密码换取设备 cookie ----
  route({
    kind: 'exact',
    path: PAIR_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      const current = state.password
      if (current === null) return sendJson(res, 403, { ok: false, code: 'password-not-set' })
      const attempt = limiter.attempt(req)
      if (attempt.blocked) {
        res.setHeader('retry-after', String(attempt.retryAfter))
        return sendJson(res, 429, { ok: false, code: 'rate-limited' })
      }
      let password
      try {
        const body = req.headers['x-remote-password'] === undefined ? await readJson(req) : undefined
        password = body?.password ?? req.headers['x-remote-password']
        if (!await verifyPassword(password, current) || state.password !== current) return sendJson(res, 401, { ok: false, code: 'password-invalid' })
      } catch { return sendJson(res, 401, { ok: false, code: 'password-invalid' }) }
      attempt.success()
      activeDevices()
      if (state.devices.size >= maxDevices) {
        const oldest = [...state.devices.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
        if (oldest !== undefined) state.devices.delete(oldest.id)
      }
      const id = randomBytes(32).toString('base64url')
      const ua = String(req.headers['user-agent'] ?? '')
      const device = {
        id,
        name: /iphone|android|mobile/i.test(ua) ? '手机' : /ipad|tablet/i.test(ua) ? '平板' : '浏览器',
        userAgent: ua.slice(0, 200),
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      }
      state.devices.set(id, device)
      saveDevices(state.devices)
      // 设备凭据只在此刻下发一次；httpOnly 防 XSS 读取，SameSite=Lax 够用（同站导航）。
      const secure = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https'
      const maxAge = Math.floor(idleExpireMs / 1000)
      res.setHeader('set-cookie',
        `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`)
      sendJson(res, 200, { ok: true, device: device.name, next: `${PREFIX}/` })
    },
  })


  /**
   * 把 /myremote/* 的请求转发给本机 harness 本体。
   * 只在设备验签通过后调用；转发时丢弃外部 Host，改用内层 origin，并附上本进程的浏览器凭据。
   */
  /** 上游瞬时失败（5xx/网络抖动）重试一次；事件流只连一次，避免重复订阅。 */
  const retry = async (run, times = 2) => {
    let last
    for (let i = 0; i < times; i += 1) {
      try {
        const response = await run()
        if (response.status < 500 || i === times - 1) return response
      } catch (error) { last = error }
    }
    if (last) throw last
  }

  const forward = async (req, res) => {
    const logger = ctx.logger
    // 资源身份（包括完整 rev 查询）与缓存策略由上游决定，不另建去版本的缓存。
    const base = target()
    const stripped = req.url.slice(PREFIX.length) || '/'
    const url = new URL(stripped, base)
    if (url.origin !== base.origin) return sendJson(res, 400, { ok: false, code: 'invalid-path' })
    const cookie = await innerAuth.ready()
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue
      // 不透传外部的 host/origin/forwarded 链，避免内层栅栏误判。
      if (['host', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-pair-code', 'x-remote-password'].includes(k)) continue
      if (['connection', 'upgrade', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'accept-encoding', 'content-length'].includes(k)) continue
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
    headers.host = base.host
    Object.assign(headers, hostHeaders())
    if (cookie !== undefined) headers.cookie = cookie
    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
        redirect: 'manual',
      })
      const out = {}
      upstream.headers.forEach((value, key) => {
        // fetch 会解压实体，移除原传输长度/编码；未改写资源保留 ETag/CSP/MIME。
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer', 'content-md5'].includes(key)) return
        out[key] = value
      })
      const type = upstream.headers.get('content-type') ?? ''
      // HEAD/304/204 没有实体，即使带 text/html 也不能进入解码/内联分支。
      if (req.method === 'HEAD' || upstream.status === 304 || upstream.status === 204) {
        res.writeHead(upstream.status, out)
        return res.end()
      }
      if (type.includes('text/html')) {
        let html = await upstream.text()
        // 启动器必须在主应用执行前完成注册；单独请求在弱网下会失败并导致白屏，这里内联进 HTML。
        const match = html.match(/<script src="([^"]*dsh-client-modules\/client\.js[^"]*)"><\/script>/)
        // CSP/带属性脚本保留原标签；不把本机凭据发送给 HTML 中的外部主机。
        if (match && !out['content-security-policy']) {
          try {
            const bootUrl = new URL(match[1].replaceAll('&amp;', '&'), url)
            if (bootUrl.origin === base.origin) {
              const boot = await retry(() => fetch(bootUrl, { redirect: 'manual', headers: { ...hostHeaders(), ...(cookie ? { cookie } : {}) } }))
              const bootType = boot.headers.get('content-type') ?? ''
              if (!boot.ok || !/(?:javascript|ecmascript)/i.test(bootType)) throw new Error('invalid boot response')
              const code = (await boot.text()).replace(/<\/script/gi, '<\\/script')
              html = html.replace(match[0], () => '<script>' + code + '</script>')
            }
          } catch {
            logger?.warn?.('my-remote: 启动器内联失败，回退为外部脚本')
          }
        }
        delete out.etag
        out['cache-control'] = 'no-store'
        let page = html
        // 远程侧跳过本机插件的首次免责弹窗：它在本机已确认过，不该在手机上再挡一次全屏。
        page = page.replace('<head>', '<head><script>try{localStorage.setItem("dsh-purge-user-notice-v1","1")}catch(e){}</script>')
        res.writeHead(upstream.status, out)
        return res.end(page)
      }
      res.writeHead(upstream.status, out)
      if (upstream.body === null) return res.end()
      for await (const chunk of upstream.body) res.write(chunk)
      res.end()
    } catch (error) {
      if (!res.headersSent) sendJson(res, 502, { ok: false, code: 'upstream-failed' })
      else res.end()
    }
  }

  // ---- 内层凭据：以本进程身份兑换浏览器 cookie，转发时附上 ----
  // 官方的浏览器认证 cookie 与 authority 绑定且无回环豁免，所以代理转发到 127.0.0.1 时必须
  // 带上*本进程自己*兑换到的凭据；设备自己的 cookie 到内层是不被认可的。
  const innerAuth = (() => {
    let cached
    const launchUrl = () => {
      const conn = ctx.get ? ctx.get('connection') : undefined
      if (typeof conn?.authenticatedUrl !== 'function') return undefined
      return conn.authenticatedUrl(new URL('/', hostOrigin()).href)
    }
    return {
      async ready() {
        if (cached !== undefined) return cached
        const url = launchUrl()
        if (url === undefined) return undefined
        try {
          const r = await fetch(url, { redirect: 'manual', headers: hostHeaders() })
          const raw = r.headers.get('set-cookie')
          if (raw === null) return undefined
          const entry = raw.split(',').map((x) => x.trim()).find((x) => x.startsWith('dsh-auth-'))
          const pair = entry?.split(';')[0]?.trim()
          if (pair !== undefined && pair.includes('=')) cached = pair
          return cached
        } catch {
          return undefined
        }
      },
      invalidate() { cached = undefined },
    }
  })()

  const target = () => new URL(hostOrigin())

  const muxUpgrade = {
    path: '/myremote/api/remote.mux',
    handler: async (req, socket, head) => {
      if (!verify(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      const base = target()
      const cookie = await innerAuth.ready()
      if (!cookie) { socket.destroy(); return }
      const headers = { ...req.headers, ...hostHeaders(), host: base.host, origin: base.origin, cookie }
      for (const k of ['cf-connecting-ip','x-forwarded-for','x-forwarded-proto','referer','x-remote-password','x-pair-code']) delete headers[k]
      const upstream = httpRequest({ hostname: base.hostname, port: base.port, path: req.url.slice(PREFIX.length), headers })
      upstream.on('upgrade', (response, peer, rest) => {
        if (!verify(req)) { socket.destroy(); peer.destroy(); return }
        deviceSockets.add(socket)
        socket.on('close', () => deviceSockets.delete(socket))
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n')
        if (rest.length) socket.write(rest)
        if (head.length) peer.write(head)
        socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy())
        socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy())
        socket.pipe(peer).pipe(socket)
      })
      upstream.on('response', response => { socket.end('HTTP/1.1 ' + response.statusCode + ' Error\r\nConnection: close\r\n\r\n'); response.resume() })
      upstream.on('error', () => socket.destroy())
      upstream.end()
    }
  }
  bridgeUpgrades.push(muxUpgrade)
  disposers.push(ctx.webServer.registerUpgrade(muxUpgrade))

  // ---- 远程侧页面：配对界面与落地页 ----
  route({
    kind: 'exact',
    path: PREFIX,
    handler: (req, res) => {
      const device = verify(req)
      if (device === undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(PAIR_PAGE_HTML)
      }
      return forward(req, res)
    },
  })
  route({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      const device = verify(req)
      if (device === undefined) {
        if (req.url.split('?')[0] !== PREFIX + '/') return sendJson(res, 403, { ok: false, code: 'unpaired' })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(PAIR_PAGE_HTML)
      }
      return forward(req, res)
    },
  })

  // ---- 设备列表（供远程侧自检，不回显凭据） ----
  route({
    kind: 'exact',
    path: DEVICES_PATH,
    handler: (req, res) => {
      const device = verify(req)
      if (device === undefined) return sendJson(res, 403, { ok: false, code: 'unpaired' })
      sendJson(res, 200, { ok: true, current: device.name, count: state.devices.size })
    },
  })

  // ---- 远程服务的生命周期跟随 dsh 本体 ----
  // 转发器与隧道作为子进程启动：dsh 起来它们就起来，dsh 退出它们随之退出，
  // 不再需要独立的 systemd 单元，也不会出现“dsh 没开、隧道还挂着”的半死状态。
  const children = []
  const startChild = (label, command, args, env) => {
    try {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...nodeChildEnv(), MYREMOTE_PARENT_PID: String(process.pid), ...env },
        detached: false,
        windowsHide: true,
      })
      child.stdout?.on('data', (d) => ctx.logger?.info?.(`[${label}] ${String(d).trim()}`))
      child.stderr?.on('data', (d) => ctx.logger?.warn?.(`[${label}] ${String(d).trim()}`))
      child.on('error', (error) => ctx.logger?.warn?.(`[${label}] 启动失败：${error.message}`))
      child.on('exit', (code, signal) => {
        ctx.logger?.warn?.(`[${label}] 退出 code=${String(code)} signal=${String(signal)}`)
      })
      children.push({ label, child })
      return child
    } catch (error) {
      ctx.logger?.warn?.(`[${label}] 启动失败：${String(error?.message ?? error)}`)
      return undefined
    }
  }

  if (config.remoteEntry?.enabled !== false) {
    const nodeBin = process.execPath
    const entryScript = fileURLToPath(new URL('../bin/fixed-entry.js', import.meta.url))
    const upstreamPort = ctx.webServer.port
    if (upstreamPort !== undefined) {
      const bridge = createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname
        const match = bridgeRoutes.find(x => x.kind === 'exact' && x.path === pathname)
          ?? bridgeRoutes.find(x => x.kind === 'prefix' && (pathname === x.path || pathname.startsWith(x.path + '/')))
        if (!match) return sendJson(res, 404, { ok: false })
        Promise.resolve().then(() => match.handler(req, res)).catch(() => { if (!res.headersSent) sendJson(res, 500, { ok: false }); else res.end() })
      })
      bridge.on('upgrade', (req, socket, head) => {
        const match = bridgeUpgrades.find(x => x.path === req.url.split('?')[0])
        if (!match) { socket.destroy(); return }
        Promise.resolve().then(() => match.handler(req, socket, head)).catch(() => socket.destroy())
      })
      const bridgeSockets = new Set()
      bridge.on('connection', socket => { bridgeSockets.add(socket); socket.on('close', () => bridgeSockets.delete(socket)) })
      let stopped = false
      disposers.push(() => { stopped = true; for (const socket of bridgeSockets) socket.destroy(); bridge.close() })
      bridge.on('error', error => ctx.logger?.warn?.('my-remote bridge: ' + error.message))
      bridge.listen(0, '127.0.0.1', () => {
        if (stopped) { bridge.close(); return }
        startChild('fixed-entry', nodeBin, [entryScript], {
          MYREMOTE_PORT: String(config.remoteEntry?.port ?? 3080),
          MYREMOTE_UPSTREAM: String(bridge.address().port),
        })
      })
    } else {
      ctx.logger?.warn?.('my-remote: webServer 尚未绑定端口，固定入口未启动')
    }

    const tunnelTokenFile = config.tunnel?.tokenFile
    const cloudflaredBin = resolveCloudflared(config.tunnel?.binary)
    if (config.tunnel?.enabled === true && tunnelTokenFile !== undefined && fsExists(tunnelTokenFile) && cloudflaredBin) {
      startChild('tunnel', process.execPath, [
        fileURLToPath(new URL('../bin/tunnel-runner.js', import.meta.url)), cloudflaredBin,
        'tunnel', '--protocol', 'http2', 'run', '--token-file', tunnelTokenFile,
      ])
    } else if (config.tunnel?.enabled === true) {
      ctx.logger?.warn?.('my-remote: 隧道已启用但 token 文件或 cloudflared 缺失，已跳过')
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const off of disposers) { try { off() } catch { /* 已撤销 */ } }
      for (const { label, child } of children) {
        try {
          if (child.connected) child.send('shutdown')
          else child.kill('SIGTERM')
        } catch { ctx.logger?.warn?.(`[${label}] 终止失败`) }
      }
      saveDevices(state.devices)
    })
  }

  ctx.logger?.info?.('my-remote: 远程通道已挂载于 ' + PREFIX + '，已配对设备 ' + state.devices.size + ' 台')
}
