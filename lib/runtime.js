import { createRequire } from 'node:module'
import { dirname, resolve, isAbsolute, win32, posix } from 'node:path'
import { statSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { request } from 'node:http'

/** Invalid/relative CLI arguments must never abort the candidate search. */
export function resolveSchemastery({ roots = [process.env.DSH_ROOT, ...process.argv.slice(0, 3)], load = createRequire } = {}) {
  const bases = new Set([import.meta.url])
  for (const root of roots.filter(x => typeof x === 'string' && x.length)) {
    let dir = resolve(root)
    try { if (statSync(dir).isFile()) dir = dirname(dir) } catch { /* candidates may not exist */ }
    // Desktop entry scripts can live below resources/dsh; inspect their ancestors.
    for (let depth = 0; depth < 8; depth++) {
      bases.add(resolve(dir, 'package.json'))
      bases.add(resolve(dir, 'node_modules/@deepseek-ai/dsh/package.json'))
      bases.add(resolve(dir, 'resources/dsh/package.json'))
      bases.add(resolve(dir, 'resources/app/package.json'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const base of bases) {
    try { return load(base)('@deepseek-ai/schemastery') } catch { /* try next */ }
  }
  throw new Error('my-remote: 找不到 @deepseek-ai/schemastery，请设置 DSH_ROOT 指向 dsh 安装目录')
}

export function nodeChildEnv(env = process.env, electron = process.versions.electron) {
  return { ...env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
}

/** Native binaries must not inherit Electron's Node-mode flag (even as "undefined"). */
export function nativeChildEnv(env = process.env) {
  const result = { ...env }
  delete result.ELECTRON_RUN_AS_NODE
  return result
}

export function executableAvailable(command, platform = process.platform) {
  if (typeof command !== 'string' || !command) return false
  if (!isAbsolute(command) && !command.includes('/') && !command.includes('\\')) return true
  try {
    if (!statSync(command).isFile()) return false
    accessSync(command, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch { return false }
}

/** Explicit config wins, then PATH, then the historical per-user installation. */
export function resolveCloudflared(binary, { platform = process.platform, env = process.env, home = homedir, available = path => executableAvailable(path, platform) } = {}) {
  if (binary !== undefined) return available(binary) ? binary : undefined
  const paths = platform === 'win32' ? win32 : posix
  const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const pathValue = Object.entries(env).find(([key]) => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')?.[1] ?? ''
  for (const dir of pathValue.split(paths.delimiter).filter(Boolean)) {
    const candidate = paths.join(dir.replace(/^"|"$/g, ''), name)
    if (available(candidate)) return candidate
  }
  const base = home()
  const fallback = base && paths.join(base, '.local', 'bin', name)
  return fallback && available(fallback) ? fallback : undefined
}

/** Parse only local/wildcard TCP listeners; all probes still dial IPv4 loopback. */
export function parseListeningPorts(stdout, format = 'ss') {
  const ports = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    let local
    if (format === 'ss') {
      if (cols[0] !== 'LISTEN') continue
      local = cols[3]
    } else {
      if (!/^tcp6?$/i.test(cols[0]) || !/^(LISTEN|LISTENING)$/.test(cols[3]) && !cols.includes('LISTEN')) continue
      local = /LISTENING/.test(cols[3]) ? cols[1] : cols[3]
    }
    const match = local?.match(/^(.*):(\d+)$/)
    if (!match) continue
    const [, addr, text] = match
    const port = Number(text)
    if (port < 1024 || port > 65535) continue
    if (!/^(127(?:\.\d{1,3}){3}|0\.0\.0\.0|\*|\[?::\]?|\[?::1\]?|\[?::ffff:127\.0\.0\.1\]?)$/.test(addr)) continue
    ports.add(port)
  }
  return [...ports]
}

/** Discovery identifies our local control API, never an unrelated root 200/401. */
export function probeMyRemote(port, { host = '127.0.0.1', timeout = 1500 } = {}) {
  if (host !== '127.0.0.1') return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const req = request({ host, port, path: '/myremote/status', method: 'GET', headers: { host: `${host}:${port}` } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk; if (body.length > 65536) { finish(false); req.destroy() } })
      res.on('end', () => {
        try { const data = JSON.parse(body); finish(res.statusCode === 200 && data.ok === true && data.prefix === '/myremote') } catch { finish(false) }
      })
      res.on('error', () => finish(false))
    })
    const timer = setTimeout(() => { finish(false); req.destroy() }, timeout)
    req.on('error', () => finish(false))
    req.end()
  })
}

export function isProcessAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export function watchParent(shutdown, pid = Number(process.env.MYREMOTE_PARENT_PID) || process.ppid) {
  const timer = setInterval(() => { if (!isProcessAlive(pid)) shutdown() }, 1000)
  timer.unref()
  return () => clearInterval(timer)
}

/** Never send a raw root request to the host: aliases still pass its device gate. */
export function gatedPath(raw = '/') {
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw)) return undefined
  const path = raw.split('?')[0]
  if (/%(?:2f|5c|2e)/i.test(path) || path.split('/').some(x => x === '.' || x === '..')) return undefined
  return path === '/myremote' || path.startsWith('/myremote/') ? raw : '/myremote' + raw
}
