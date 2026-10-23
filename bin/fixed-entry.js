#!/usr/bin/env node
/**
 * 固定入口转发器（方案 A）。
 *
 * 桌面版的 dsh 端口每次启动都会变（实测 45717 → 45735），而 Cloudflare 隧道
 * 的 ingress 必须写死一个端口。这个进程常驻在 3080，做两件事：
 *
 *   1. 动态发现当前桌面 dsh 实例的真实端口（扫本机监听表 + 探活）
 *   2. 把请求原样转发过去，并把门控交给已安装的 /myremote 插件
 *
 * 为什么不让隧道直连桌面端口：那样桌面重启一次隧道就废一次，而域名是要固定的。
 *
 * 安全边界：本进程不绑定 0.0.0.0，只监听 127.0.0.1。外部流量必须经过
 * cloudflared（它拨 127.0.0.1:3080），请求里带 CF-Connecting-IP 头，
 * 插件据此判定为“转发而来”而不是本机，从而强制要求配对凭据。
 */
import { createServer, request as httpRequest } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const FIXED_PORT = Number(process.env.MYREMOTE_PORT ?? 3080)
/** 插件传入的精确上游端口；有值时跳过探测。 */
const FIXED_UPSTREAM = Number(process.env.MYREMOTE_UPSTREAM ?? 0)
const HOST = '127.0.0.1'
/** 已知的固定端口，绝不当作桌面实例。 */
const RESERVED = new Set([FIXED_PORT, 22, 80, 443, 3306, 8083, 24443, 24444, 45859])

/** 缓存：{ port, at }，避免每个请求都扫一遍监听表。 */
let cached = { port: 0, at: 0 }
const CACHE_TTL_MS = 5_000

/** 用系统工具列出本机 LISTEN 的 TCP 端口（Windows 走 netstat）。 */
async function listeningPorts() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { timeout: 3000 })
      const ports = new Set()
      for (const line of stdout.split('\n')) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 4 || cols[3] !== 'LISTENING') continue
        const local = cols[1]
        const port = Number(local.slice(local.lastIndexOf(':') + 1))
        if (!Number.isFinite(port) || port < 1024) continue
        if (!/^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0):/.test(local) && !local.startsWith('127.')) continue
        ports.add(port)
      }
      return [...ports]
    }
    const { stdout } = await execFileAsync('ss', ['-lntH'], { timeout: 3000 })
    const ports = new Set()
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s/)
      if (m === null) continue
      const [, addr, port] = m
      // 只认回环监听；桌面 dsh 绑的是 127.0.0.1。
      if (!/^127\.0\.0\.1$|^\[::1\]$|^\[::ffff:127\.0\.0\.1\]$/.test(addr)) continue
      ports.add(Number(port))
    }
    return [...ports]
  } catch {
    return []
  }
}

/** 判断某端口上是否是 dsh 的桌面实例：访问 / 应返回 401（需要浏览器凭据）。 */
function probe(port) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: HOST, port, path: '/', method: 'GET', timeout: 1500, headers: { host: `${HOST}:${port}` } }, (res) => {
      res.resume()
      // 桌面实例对未认证请求回 401；别的服务不会恰好如此。
      resolve(res.statusCode === 401 || res.statusCode === 200)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/** 找出当前的桌面端口；找不到返回 0。 */
async function discover() {
  // 插件知道自己监听哪个端口，直接用它，避免探测误判到别的服务。
  if (FIXED_UPSTREAM > 0) return FIXED_UPSTREAM
  const now = Date.now()
  if (cached.port !== 0 && now - cached.at < CACHE_TTL_MS) {
    if (await probe(cached.port)) return cached.port
  }
  const candidates = (await listeningPorts())
    .filter((p) => p >= 1024 && !RESERVED.has(p))
    .sort((a, b) => b - a) // 桌面端口是高位随机值，优先新分配的
  for (const port of candidates) {
    if (await probe(port)) {
      cached = { port, at: Date.now() }
      return port
    }
  }
  cached = { port: 0, at: Date.now() }
  return 0
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'])

function proxyHeaderList(headers) {
  const out = []
  for (const [key, value] of Object.entries(headers)) {
    if (HOP.has(key) || value === undefined) continue
    out.push([key, Array.isArray(value) ? value.join(', ') : value])
  }
  return out
}

const server = createServer(async (req, res) => {
  const target = await discover()
  if (target === 0) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('桌面版 dsh 未在运行。请先打开 DeepSeek Harness 桌面客户端。')
    return
  }
  // 原样管道转发，不缓冲、不改写实体，保持在请求开始瞬间解析到的端口上。
  const upstream = httpRequest(
    {
      host: HOST, port: target, path: req.url, method: req.method,
      headers: Object.fromEntries(proxyHeaderList({ ...req.headers, host: `${HOST}:${target}` })),
      // 长连接事件流不能被默认超时截断。
      timeout: 0,
      agent: false,
    },
    (up) => {
      const headers = {}
      for (const [key, value] of proxyHeaderList(up.headers)) headers[key] = value
      res.writeHead(up.statusCode ?? 502, headers)
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    cached = { port: 0, at: 0 } // 端口变了，下次重新发现
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('上游不可达，正在重新定位桌面实例。')
    } else res.destroy()
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})

// WebSocket 升级同样需要转发，否则配对后的实时通道会断。
server.on('upgrade', async (req, socket, head) => {
  const target = await discover()
  if (target === 0) { socket.destroy(); return }
  const upstream = httpRequest({
    host: HOST, port: target, path: req.url, method: req.method,
    headers: { ...req.headers, host: `${HOST}:${target}` },
  })
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    if (upHead.length > 0) upSocket.unshift(upHead)
    if (head.length > 0) upSocket.write(head)
    upSocket.pipe(socket).pipe(upSocket)
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
})

server.listen(FIXED_PORT, HOST, () => {
  process.stdout.write(`my-remote 固定入口已就绪：http://${HOST}:${String(FIXED_PORT)}\n`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// 父进程（dsh）被强杀时收到不到 disposer，这里兜底：父进程消失即自行退出，
// 避免留下一个指向已死端口的孤儿转发器。
const parentPid = process.ppid
setInterval(() => {
  if (process.ppid !== parentPid) shutdown()
}, 2_000).unref()
