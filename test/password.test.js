import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPairLimiter } from '../lib/password.js'

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'myremote-password-')), previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { apply } = await import('../lib/index.js')
  let routes, effects
  const start = () => {
    routes = []; effects = []
    apply({ webServer: { port: server.address().port, register: r => { routes.push(r); return () => {} }, registerUpgrade: () => () => {} }, effect: f => effects.push(f()), logger: {} }, { remoteEntry: { enabled: false } })
  }
  const server = createServer((req, res) => {
    const route = routes.find(r => r.kind === 'exact' && r.path === req.url)
    if (!route) { res.writeHead(404); res.end(); return }
    Promise.resolve().then(() => route.handler(req, res)).catch(() => { res.writeHead(500); res.end() })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); start()
  t.after(async () => { effects.forEach(f => f()); server.closeAllConnections(); await new Promise(r => server.close(r)); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(home, { recursive: true, force: true }) })
  const call = (path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/myremote/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  return { home, call, restart() { effects.forEach(f => f()); start() } }
}

test('password persistence, exact matching, reusable login, rotation and explicit revocation survive restart', async t => {
  const { home, call, restart } = await fixture(t)
  assert.equal((await (await call('status')).json()).passwordSet, false)
  let r = await call('pair', { password: 'Whatever42' }); assert.equal(r.status, 403); assert.equal((await r.json()).code, 'password-not-set')
  assert.equal((await call('code', {})).status, 410)
  const password = ' MixedCase 密码42 '
  r = await call('password', { password }); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, passwordSet: true })
  const disk = readFileSync(join(home, 'my-remote-password.json'), 'utf8'), record = JSON.parse(disk)
  assert.doesNotMatch(disk, /MixedCase|密码42/); assert.equal(record.algorithm, 'scrypt'); assert.equal(record.salt.length, 32); assert.equal(record.hash.length, 128)
  for (const value of [password.toUpperCase(), password.trim()]) { r = await call('pair', { password: value }); assert.equal(r.status, 401); assert.equal((await r.json()).code, 'password-invalid') }
  r = await call('pair', { password }); assert.equal(r.status, 200)
  const cookie = r.headers.get('set-cookie').split(';')[0]
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/)
  restart()
  assert.equal((await (await call('status')).json()).passwordSet, true)
  assert.equal((await call('devices', undefined, { cookie })).status, 200)
  assert.equal((await call('pair', { password })).status, 200)
  const next = 'NewPassword42'
  assert.equal((await call('password', { password: next })).status, 200)
  assert.equal((await call('pair', {}, { 'x-remote-password': next })).status, 200)
  assert.notEqual(JSON.parse(readFileSync(join(home, 'my-remote-password.json'), 'utf8')).salt, record.salt)
  assert.equal((await call('devices', undefined, { cookie })).status, 200)
  assert.equal((await call('pair', { password })).status, 401)
  assert.equal((await call('password', { password: next, revokeDevices: true })).status, 200)
  assert.equal((await call('devices', undefined, { cookie })).status, 403)
  restart(); assert.equal((await call('devices', undefined, { cookie })).status, 403)
  assert.equal((await call('pair', { password: next })).status, 200)
})

test('password control validates bounds/types/JSON and rejects remote or foreign-origin changes', async t => {
  const { call } = await fixture(t)
  for (const password of ['', null, 123]) assert.equal((await call('password', { password })).status, 400)
  assert.equal((await call('password', { password: 'password42', revokeDevices: 'true' })).status, 400)
  for (const body of ['{', '[]', 'null', JSON.stringify({ password: 'x'.repeat(4100) })]) assert.equal((await call('password', body)).status, 400)
  assert.equal((await call('status')).status, 200, 'oversized request must leave server healthy')
  for (const headers of [{ origin: 'https://evil.example' }, { 'cf-connecting-ip': '203.0.113.1' }, { 'x-forwarded-for': '203.0.113.2' }]) assert.equal((await call('password', { password: 'password42' }, headers)).status, 403)
  for (const password of ['7', '1234', 'x'.repeat(129), '密'.repeat(256)]) {
    assert.equal((await call('password', { password })).status, 200)
    assert.equal((await call('pair', { password })).status, 200)
  }
  assert.equal((await call('pair', '{', { 'cf-connecting-ip': '203.0.113.5' })).status, 401)
  assert.equal((await call('pair', { password: 123 }, { 'cf-connecting-ip': '203.0.113.6' })).status, 401)
  assert.equal((await call('pair', JSON.stringify({ password: 'x'.repeat(4100) }), { 'cf-connecting-ip': '203.0.113.7' })).status, 401)
})

test('five failures rate-limit per IP; successful login resets its window', async t => {
  const { call } = await fixture(t)
  await call('password', { password: 'Password42' })
  const ip = { 'cf-connecting-ip': '203.0.113.1' }
  for (let i = 0; i < 4; i++) assert.equal((await call('pair', { password: 'wrongpass' }, ip)).status, 401)
  assert.equal((await call('pair', { password: 'Password42' }, ip)).status, 200)
  for (let i = 0; i < 5; i++) assert.equal((await call('pair', { password: 'wrongpass' }, ip)).status, 401)
  const r = await call('pair', { password: 'Password42' }, ip)
  assert.equal(r.status, 429); assert.equal((await r.json()).code, 'rate-limited'); assert.ok(Number(r.headers.get('retry-after')) <= 300)
  assert.equal((await call('pair', { password: 'Password42' }, { 'cf-connecting-ip': '203.0.113.2' })).status, 200)
})

test('limiter expires after five minutes and bounded overflow does not evict blocked IPs', () => {
  const original = Date.now; let now = original(); Date.now = () => now
  try {
    const limiter = createPairLimiter(), req = ip => ({ headers: { 'cf-connecting-ip': ip }, socket: {} })
    for (let i = 0; i < 5; i++) assert.equal(limiter.attempt(req('blocked')).blocked, false)
    for (let i = 0; i < 2000; i++) limiter.attempt(req(`other-${i}`))
    assert.equal(limiter.attempt(req('blocked')).blocked, true)
    assert.equal(limiter.attempt(req('new-overflow')).blocked, true)
    now += 300001
    assert.equal(limiter.attempt(req('blocked')).blocked, false)
  } finally { Date.now = original }
})

test('password write failures do not advertise an unpersisted password', async t => {
  const { home, call } = await fixture(t)
  mkdirSync(join(home, 'my-remote-password.json'))
  const r = await call('password', { password: 'Password42' })
  assert.equal(r.status, 500); assert.equal((await r.json()).code, 'password-save-failed')
  assert.equal((await (await call('status')).json()).passwordSet, false)
})

test('corrupt password store fails closed without damaging existing device store', async t => {
  const { home, call, restart } = await fixture(t)
  await call('password', { password: 'Password42' })
  const r = await call('pair', { password: 'Password42' }), cookie = r.headers.get('set-cookie').split(';')[0]
  writeFileSync(join(home, 'my-remote-password.json'), '{invalid')
  restart()
  assert.equal((await (await call('status')).json()).passwordSet, false)
  assert.equal((await call('devices', undefined, { cookie })).status, 200)
  assert.equal((await call('pair', { password: 'Password42' })).status, 403)
})
