import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const listen = async s => { s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s.address().port }
for (const legacyOrigin of [false, true]) test(`Desktop bridge survives renderer fence (getOrigin: ${legacyOrigin})`, { timeout: 10000 }, async t => {
  const { apply } = await import('../lib/index.js')
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'myremote-bridge-')); process.env.DSH_HOME = home
  const host = createServer((req, res) => {
    if (req.headers['x-dsh-desktop-renderer'] !== 'server-only-capability') { res.writeHead(403); res.end('forbidden'); return }
    if (req.url === '/launch') { res.writeHead(302, { 'set-cookie': 'dsh-auth-test=inner; Path=/' }); res.end(); return }
    assert.match(req.headers.cookie ?? '', /dsh-auth-test=inner/)
    res.setHeader('content-type', 'text/html'); res.end('<html><head></head><body>Desktop</body></html>')
  })
  const port = await listen(host)
  const reserve = createServer(); const fixed = await listen(reserve); await new Promise(r => reserve.close(r))
  const effects = []
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const routes = [], upgrades = []
  apply({ webServer: { port, host: '127.0.0.1', ...(legacyOrigin ? { getOrigin: () => `http://127.0.0.1:${port}` } : {}), register: route => { routes.push(route); return () => {} }, registerUpgrade: route => { upgrades.push(route); return () => {} } }, get(name) { return name === 'desktopBrowserAccess' ? { rendererHeader: { name: 'x-dsh-desktop-renderer', value: 'server-only-capability' } } : name === 'connection' ? { authenticatedUrl: () => `http://127.0.0.1:${port}/launch` } : undefined }, effect: f => effects.push(f()), logger: { info(msg) { if (msg.includes('固定入口已就绪')) ready() } } }, { remoteEntry: { port: fixed } })
  t.after(async () => {
    effects.forEach(f => f())
    host.closeAllConnections(); await new Promise(r => host.close(r))
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  await started
  const base = `http://127.0.0.1:${fixed}`
  assert.equal((await fetch(`http://127.0.0.1:${port}/myremote/status`)).status, 403)
  const origin = `http://127.0.0.1:${port}`
  let r = await fetch(base + '/myremote/password', { method: 'OPTIONS', headers: { origin } })
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), origin)
  assert.equal((await fetch(base + '/myremote/password', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403)
  const password = 'Bridge Password42'
  assert.equal((await fetch(base + '/myremote/password', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })).status, 200)
  r = await fetch(base + '/myremote/pair', { method: 'POST', headers: { 'x-remote-password': password } })
  const cookie = r.headers.get('set-cookie').split(';')[0]
  r = await fetch(base + '/myremote/', { headers: { cookie } })
  const html = await r.text()
  assert.equal(r.status, 200); assert.match(html, /Desktop/); assert.doesNotMatch(html, /server-only-capability/)
  assert.equal((await fetch(base + '/myremote/password', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.1', origin } })).status, 403)
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 403, 'host boundary remains unchanged')
  // A synchronous plugin error must become a response, not uncaughtException.
  const statusRoute = routes.find(route => route.path === '/myremote/status')
  const originalHandler = statusRoute.handler
  statusRoute.handler = () => { throw new Error('sync HTTP regression probe') }
  assert.equal((await fetch(base + '/myremote/status')).status, 500)
  statusRoute.handler = originalHandler
  assert.equal((await fetch(base + '/myremote/status')).status, 200)
  upgrades[0].handler = () => { throw new Error('sync upgrade regression probe') }
  await new Promise((resolve, reject) => {
    const req = request(base + '/myremote/api/remote.mux', { headers: { connection: 'Upgrade', upgrade: 'websocket' } })
    req.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error))
    req.on('response', () => reject(new Error('expected upgrade socket to close')))
    req.end()
  })
  assert.equal((await fetch(base + '/myremote/status')).status, 200, 'bridge survives sync upgrade failure')
})
