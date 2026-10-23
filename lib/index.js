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
 * - 一次性配对码（默认 60 秒、单次消费），只能从回环连接铸造。
 * - 兑换成功签发 httpOnly 设备 cookie，写入磁盘（0600），重启后仍然有效。
 * - 每条 /myremote 请求先验设备 cookie，未通过直接 403，不转发。
 * - 吊销立即生效：下一次请求即 403。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { gzipSync } from 'node:zlib'
import { existsSync as fsExists } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// dsh 自带的 @deepseek-ai/schemastery 不在 profile 的依赖树里。
// 依次尝试：插件自身的依赖树 → dsh 安装目录（由 DSH_ROOT 或从本进程 argv 推出）。
const resolveSchemastery = () => {
  const candidates = []
  try { candidates.push(createRequire(import.meta.url)) } catch { /* ignore */ }
  const roots = [process.env.DSH_ROOT, ...process.argv.slice(0, 3)].filter(Boolean)
  for (const root of roots) {
    candidates.push(createRequire(`${root}/package.json`))
    candidates.push(createRequire(`${root}/node_modules/@deepseek-ai/dsh/package.json`))
  }
  for (const req of candidates) {
    try { return req('@deepseek-ai/schemastery') } catch { /* try next */ }
  }
  throw new Error('my-remote: 找不到 @deepseek-ai/schemastery，请设置 DSH_ROOT 指向 dsh 安装目录')
}
const schemaModule = resolveSchemastery()
const z = schemaModule.z ?? schemaModule.default ?? schemaModule
const schemaObject = z.object.bind(z)
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { PAIR_PAGE_HTML, pairedPageHtml } from './page.js'

export const name = 'my-remote'
export const inject = ['webServer']

/** 远程通道前缀；改它等于让所有已配对设备的书签失效。 */
const PREFIX = '/myremote'
const PAIR_PATH = '/myremote/pair'
const DEVICES_PATH = '/myremote/devices'

/** 配对码有效期。 */
const CODE_TTL_MS = 60_000

function sha256(input) {
  // 只用于等长比较，不需要抗碰撞强度以外的性质。
  return createHash('sha256').update(input).digest()
}

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
  const route = (spec) => {
    const handler = spec.handler
    disposers.push(ctx.webServer.register({ ...spec, handler(req, res) {
      // Electron 页面使用 dsh-app://app，控制请求仍限定本机回环。
      if (req.headers.origin === 'dsh-app://app' && isLoopbackClient(req)) {
        res.setHeader('Access-Control-Allow-Origin', 'dsh-app://app')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'content-type')
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      }
      return handler(req, res)
    } }))
  }

  const cookieName = config.cookieName ?? 'dsh-myremote'
  const idleExpireMs = config.idleExpireMs ?? 1000 * 60 * 60 * 24 * 30
  const maxDevices = config.maxDevices ?? 5

  const state = { code: null, devices: loadDevices() }

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
        codeActive: state.code !== null && state.code.expiresAt > Date.now(),
      })
    },
  })

  route({
    kind: 'exact',
    path: '/myremote/code',
    handler: (req, res) => {
      if (!isLoopbackClient(req)) return sendJson(res, 403, { ok: false, code: 'loopback-only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      const code = randomBytes(4).toString('hex').toUpperCase()
      state.code = { hash: sha256(code), expiresAt: Date.now() + CODE_TTL_MS }
      sendJson(res, 200, { ok: true, code, expiresAt: Date.now() + CODE_TTL_MS })
    },
  })

  route({
    kind: 'exact',
    path: '/myremote/revoke',
    handler: (req, res) => {
      if (!isLoopbackClient(req)) return sendJson(res, 403, { ok: false, code: 'loopback-only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      state.devices.clear()
      state.code = null
      saveDevices(state.devices)
      sendJson(res, 200, { ok: true, revoked: 'all' })
    },
  })

  // ---- 配对：凭一次性码换取设备 cookie ----
  route({
    kind: 'exact',
    path: PAIR_PATH,
    handler: (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
      const current = state.code
      if (current === null || current.expiresAt < Date.now()) {
        state.code = null
        return sendJson(res, 401, { ok: false, code: 'code-expired' })
      }
      const header = String(req.headers['x-pair-code'] ?? '')
      const given = sha256(header.trim().toUpperCase())
      if (given.length !== current.hash.length || !timingSafeEqual(given, current.hash)) {
        return sendJson(res, 401, { ok: false, code: 'code-invalid' })
      }
      // 单次消费：无论后续成功与否，这枚码立即作废。
      state.code = null
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

  /** 进程内插件 bundle 缓存：rev 变更即换键，旧键自然淘汰。 */
  const bundleCache = new Map()

  const forward = async (req, res) => {
    const logger = ctx.logger
    // 未变资源直接命中缓存：公网隧道单次传输越少，越不容易触发边缘 502。
    const cacheKey = req.url.startsWith('/plugins/') ? req.url.replace(/[&?]rev=[^&]*/, '') : ''
    if (req.method === 'GET' && cacheKey && bundleCache.has(cacheKey)) {
      const hit = bundleCache.get(cacheKey)
      res.writeHead(200, {
        'content-type': cacheKey.includes('.js') ? 'text/javascript; charset=utf-8' : 'application/json; charset=utf-8',
        'content-length': String(hit.length),
        'cache-control': 'private, max-age=31536000, immutable',
      })
      return res.end(hit)
    }
    const base = target()
    const stripped = req.url.replace(PREFIX, '') || '/'
    const url = new URL(stripped, base)
    const cookie = await innerAuth.ready()
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue
      // 不透传外部的 host/origin/forwarded 链，避免内层栅栏误判。
      if (['host', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-pair-code'].includes(k)) continue
      if (['connection', 'upgrade', 'accept-encoding', 'content-length'].includes(k)) continue
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
    headers.host = base.host
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
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'content-md5'].includes(key)) return
        out[key] = value
      })
      const type = upstream.headers.get('content-type') ?? ''
      // 插件 bundle 是带 rev 的不可变资源：缓存原文，公网只拉一次，避免逐次重传导致 502。
      if (upstream.ok && url.pathname.startsWith('/plugins/') && (type.includes('javascript') || type.includes('json'))) {
        const bytes = Buffer.from(await upstream.arrayBuffer())
        if (bundleCache.size > 2000) bundleCache.clear()
        bundleCache.set(url.pathname + url.search.replace(/[&?]rev=[^&]*/, ''), bytes)
        res.writeHead(upstream.status, out)
        return res.end(bytes)
      }
      if (type.includes('text/html')) {
        let html = await upstream.text()
        // 启动器必须在主应用执行前完成注册；单独请求在弱网下会失败并导致白屏，这里内联进 HTML。
        const match = html.match(/<script src="([^"]*dsh-client-modules\/client\.js[^"]*)"><\/script>/)
        if (match) {
          const boot = await retry(() => fetch(new URL(match[1].replaceAll('&amp;', '&'), base), { headers: cookie ? { cookie } : {} }))
          if (boot.ok) {
            const code = (await boot.text()).replace(/<\/script/gi, '<\\/script')
            html = html.replace(match[0], () => '<script>' + code + '</script>')
          } else {
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
      const port = ctx.webServer.port ?? ctx.webServer.getOrigin?.()
      const p = typeof port === 'number' ? port : undefined
      if (conn?.authenticatedUrl === undefined || p === undefined) return undefined
      return conn.authenticatedUrl(`http://127.0.0.1:${p}/`)
    }
    return {
      async ready() {
        if (cached !== undefined) return cached
        const url = launchUrl()
        if (url === undefined) return undefined
        try {
          const r = await fetch(url, { redirect: 'manual' })
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

  const target = () => {
    const origin = ctx.webServer.getOrigin()
    return new URL(origin)
  }

  disposers.push(ctx.webServer.registerUpgrade({
    path: '/myremote/api/remote.mux',
    handler: async (req, socket, head) => {
      if (!verify(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      const base = target()
      const cookie = await innerAuth.ready()
      if (!cookie) { socket.destroy(); return }
      const headers = { ...req.headers, host: base.host, origin: base.origin, cookie }
      for (const k of ['cf-connecting-ip','x-forwarded-for','x-forwarded-proto','referer']) delete headers[k]
      const upstream = httpRequest({ hostname: base.hostname, port: base.port, path: '/api/remote.mux', headers })
      upstream.on('upgrade', (response, peer, rest) => {
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
  }))

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
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        detached: false,
      })
      child.stdout?.on('data', (d) => ctx.logger?.info?.(`[${label}] ${String(d).trim()}`))
      child.stderr?.on('data', (d) => ctx.logger?.warn?.(`[${label}] ${String(d).trim()}`))
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
      startChild('fixed-entry', nodeBin, [entryScript], {
        MYREMOTE_PORT: String(config.remoteEntry?.port ?? 3080),
        // 插件自己知道真实端口，直接把上游钉死，免掉探测环节。
        MYREMOTE_UPSTREAM: String(upstreamPort),
      })
    } else {
      ctx.logger?.warn?.('my-remote: webServer 尚未绑定端口，固定入口未启动')
    }

    const tunnelTokenFile = config.tunnel?.tokenFile
    const isWin = process.platform === 'win32'
    const cloudflaredBin = config.tunnel?.binary
      ?? (isWin
        ? 'cloudflared.exe'
        : `${process.env.HOME ?? ''}/.local/bin/cloudflared`)
    if (config.tunnel?.enabled === true && tunnelTokenFile !== undefined && fsExists(tunnelTokenFile) && fsExists(cloudflaredBin)) {
      startChild('tunnel', cloudflaredBin, [
        'tunnel', 'run', '--token-file', tunnelTokenFile, '--protocol', 'http2',
      ])
    } else if (config.tunnel?.enabled === true) {
      ctx.logger?.warn?.('my-remote: 隧道已启用但 token 文件或 cloudflared 缺失，已跳过')
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const off of disposers) { try { off() } catch { /* 已撤销 */ } }
      for (const { label, child } of children) {
        try { child.kill('SIGTERM') } catch { ctx.logger?.warn?.(`[${label}] 终止失败`) }
      }
      saveDevices(state.devices)
    })
  }

  ctx.logger?.info?.('my-remote: 远程通道已挂载于 ' + PREFIX + '，已配对设备 ' + state.devices.size + ' 台')
}
