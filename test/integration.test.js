import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
function ws(port, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...(cookie ? { cookie } : {}) } })
    req.on('upgrade', (res, socket, head) => { socket.destroy(); resolve({ status: res.statusCode, head: head.toString() }) })
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }) })
    req.on('error', reject)
    req.setTimeout(4000, () => req.destroy(new Error('WS timed out')))
    req.end()
  })
}

test('real fixed entry + plugin: pairing, root HTML/assets/API/WS, CORS, revocation', async t => {
  const home = mkdtempSync(join(tmpdir(), 'myremote-test-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { apply } = await import('../lib/index.js')
  const routes = [], upgrades = [], effects = []
  const hits = []
  let hostPort
  const host = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const route = routes.find(x => x.kind === 'exact' && x.path === pathname) ?? routes.find(x => x.kind === 'prefix' && (pathname === x.path || pathname.startsWith(x.path + '/')))
    if (route) return route.handler(req, res)
    hits.push(req.url)
    if (pathname === '/launch') { res.writeHead(302, { 'set-cookie': 'dsh-auth-test=inner; Path=/', location: '/' }); res.end(); return }
    assert.match(req.headers.cookie ?? '', /dsh-auth-test=inner/)
    if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<html><head></head><body><script src="/assets/app.js"></script><link href="/assets/app.css"></body></html>'); return }
    res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'application/json')
    res.end(JSON.stringify({ path: req.url }))
  })
  host.on('upgrade', (req, socket, head) => {
    const path = req.url.split('?')[0]
    const route = upgrades.find(x => x.path === path)
    if (route) return route.handler(req, socket, head)
    assert.equal(path, '/api/remote.mux')
    assert.match(req.headers.cookie ?? '', /dsh-auth-test=inner/)
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello')
  })
  hostPort = await listen(host)
  apply({ webServer: { port: hostPort, getOrigin: () => `http://127.0.0.1:${hostPort}`, register: x => { routes.push(x); return () => {} }, registerUpgrade: x => { upgrades.push(x); return () => {} } }, get: () => ({ authenticatedUrl: () => `http://127.0.0.1:${hostPort}/launch` }), effect: f => effects.push(f()), logger: {} }, { remoteEntry: { enabled: false } })
  const reserve = createServer(); const entryPort = await listen(reserve); await close(reserve)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/fixed-entry.js', import.meta.url))], { env: { ...process.env, MYREMOTE_PORT: String(entryPort), MYREMOTE_UPSTREAM: String(hostPort) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited }
    for (const effect of effects) effect()
    await close(host)
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  })
  await once(child.stdout, 'data')
  const url = `http://127.0.0.1:${entryPort}`
  let r = await fetch(url + '/', { redirect: 'manual' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/myremote/')
  assert.match(await (await fetch(url + '/myremote/')).text(), /autocomplete="current-password"/)
  assert.equal((await fetch(url + '/api/private')).status, 403)
  assert.equal((await ws(entryPort, '/api/remote.mux')).status, 403)
  assert.equal(hits.length, 0, 'unpaired traffic must not reach host root API')
  r = await fetch(url + '/myremote/password', { method: 'OPTIONS', headers: { origin: 'dsh-app://app', 'access-control-request-method': 'POST' } })
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'dsh-app://app')
  assert.equal((await fetch(url + '/myremote/password', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.1', origin: 'dsh-app://app' } })).status, 403)
  const password = 'MixedCase Password42'
  assert.equal((await fetch(url + '/myremote/password', { method: 'POST', headers: { origin: 'dsh-app://app', 'content-type': 'application/json' }, body: JSON.stringify({ password }) })).status, 200)
  r = await fetch(url + '/myremote/pair', { method: 'POST', headers: { 'x-remote-password': password } })
  assert.equal(r.status, 200)
  const cookie = r.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(url + '/myremote/pair', { method: 'POST', headers: { 'x-remote-password': password } })).status, 200)
  r = await fetch(url + '/myremote/', { headers: { cookie } }); assert.match(await r.text(), /src="\/assets\/app.js"/)
  for (const path of ['/assets/app.js', '/assets/app.css', '/plugins/demo.js?rev=1', '/api/private?q=2']) {
    r = await fetch(url + path, { headers: { cookie } }); assert.equal(r.status, 200); assert.equal((await r.json()).path, path)
  }
  assert.equal((await ws(entryPort, '/api/remote.mux', cookie)).status, 101)
  assert.equal((await ws(entryPort, '/myremote/api/remote.mux?session=1', cookie)).status, 101)
  assert.equal((await ws(entryPort, '/api/other', cookie)).status, 403)
  await fetch(url + '/myremote/revoke', { method: 'POST' })
  assert.equal((await fetch(url + '/api/private', { headers: { cookie } })).status, 403)
  assert.equal((await ws(entryPort, '/api/remote.mux', cookie)).status, 403)
})
