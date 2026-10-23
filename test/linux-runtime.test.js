import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolveCloudflared, nativeChildEnv, executableAvailable, parseListeningPorts, probeMyRemote } from '../lib/runtime.js'

test('cloudflared explicit config, PATH and legacy home precedence without HOME', () => {
  const found = new Set(['/custom path/cloudflared', '/usr/bin/cloudflared', '/actual home/.local/bin/cloudflared'])
  const options = { platform: 'linux', env: { PATH: '/bad:/usr/bin' }, home: () => '/actual home', available: value => found.has(value) }
  assert.equal(resolveCloudflared('/custom path/cloudflared', options), '/custom path/cloudflared')
  assert.equal(resolveCloudflared('/missing', options), undefined)
  assert.equal(resolveCloudflared(undefined, options), '/usr/bin/cloudflared')
  assert.equal(resolveCloudflared(undefined, { ...options, env: {} }), '/actual home/.local/bin/cloudflared')
  assert.equal(resolveCloudflared(undefined, { ...options, env: {}, home: () => '' }), undefined)
  assert.equal(resolveCloudflared(undefined, { platform: 'win32', env: { Path: 'C:\\Program Files\\Cloudflared;C:\\Windows' }, available: value => value === 'C:\\Program Files\\Cloudflared\\cloudflared.exe' }), 'C:\\Program Files\\Cloudflared\\cloudflared.exe')
})

test('native child env omits Electron flag rather than serializing undefined', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' }
  assert.deepEqual(nativeChildEnv(env), { KEEP: 'yes' })
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
})

test('ss and netstat parsers cover IPv4, IPv6, wildcard, duplicate and unrelated listeners', () => {
  assert.deepEqual(parseListeningPorts('LISTEN 0 511 127.0.0.1:43120 0.0.0.0:*\nLISTEN 0 511 [::1]:43121 [::]:*\nLISTEN 0 511 [::ffff:127.0.0.1]:43122 *:*\nLISTEN 0 511 *:43123 *:*\nLISTEN 0 511 192.168.1.2:9999 *:*\nLISTEN 0 511 127.0.0.1:80 *:*\nLISTEN 0 511 127.0.0.1:43120 *:*'), [43120,43121,43122,43123])
  assert.deepEqual(parseListeningPorts(' TCP 127.0.0.1:43120 0.0.0.0:0 LISTENING 123\r\n TCP [::1]:43121 [::]:0 LISTENING 123\n TCP 192.168.1.2:7777 0.0.0.0:0 LISTENING 123\n TCP 127.0.0.1:5555 1.1.1.1:80 ESTABLISHED 123', 'netstat'), [43120,43121])
  assert.deepEqual(parseListeningPorts('tcp 0 0 127.0.0.1:43120 0.0.0.0:* LISTEN\ntcp6 0 0 :::43121 :::* LISTEN', 'netstat'), [43120,43121])
})

test('discovery requires local myremote status JSON identity, not root HTTP success', async () => {
  let response = { code: 200, body: '<html>unrelated</html>' }
  const server = createServer((req,res) => { assert.equal(req.url, '/myremote/status'); assert.equal(req.headers['x-forwarded-for'], undefined); res.writeHead(response.code); res.end(response.body) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const port = server.address().port
    for (const value of [{ code: 200, body: '<html>unrelated</html>' }, { code: 401, body: '{}' }, { code: 200, body: '{"ok":true,"prefix":"/other"}' }]) { response = value; assert.equal(await probeMyRemote(port), false) }
    response = { code: 200, body: '{"ok":true,"prefix":"/myremote"}' }
    assert.equal(await probeMyRemote(port), true)
    assert.equal(await probeMyRemote(port, { host: 'example.com' }), false)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('Linux executable permissions and paths containing spaces', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'myremote binary space '))
  try {
    const binary = join(dir, 'cloudflared'); writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
    assert.equal(executableAvailable(binary), false)
    chmodSync(binary, 0o700)
    assert.equal(executableAvailable(binary), true)
    assert.equal(executableAvailable(dir), false)
    assert.equal(resolveCloudflared(undefined, { env: { PATH: dir } }), binary)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
