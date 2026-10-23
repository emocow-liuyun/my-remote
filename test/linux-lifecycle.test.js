import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProcessAlive } from '../lib/runtime.js'
const script = name => fileURLToPath(new URL('../bin/' + name, import.meta.url))
const linux = process.platform === 'linux'
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
function output(child) { let stderr = ''; child.stderr?.on('data', data => { stderr += data }); return () => stderr }

for (const mode of ['SIGTERM', 'absent parent']) test(`Linux supervisor ${mode} force-kills native child ignoring TERM`, { skip: !linux, timeout: 12000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myremote native space '))
  const binary = join(dir, 'native tunnel')
  // POSIX shell is a real native executable; its busy loop has no grandchildren.
  writeFileSync(binary, '#!/bin/sh\ntrap "" TERM\necho "ready $$"\nwhile :; do :; done\n', { mode: 0o700 })
  const child = spawn(process.execPath, [script('tunnel-runner.js'), binary], { env: { ...process.env, ...(mode === 'absent parent' ? { MYREMOTE_PARENT_PID: '2147483647' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  const errors = output(child)
  let pid
  try {
    const [data] = await once(child.stdout, 'data'); pid = Number(String(data).match(/ready (\d+)/)?.[1]); assert.ok(pid)
    const done = once(child, 'exit')
    if (mode === 'SIGTERM') child.kill('SIGTERM')
    const [code] = await done
    assert.equal(code, 0, errors())
    assert.equal(isProcessAlive(pid), false, 'native tunnel must be reaped before supervisor exits')
  } finally {
    if (pid && isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Linux actual parent demise cleans up supervisor and native process', { skip: !linux, timeout: 12000 }, async () => {
  const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,${JSON.stringify([script('tunnel-runner.js'), '/bin/sh', '-c', 'trap "" TERM; echo native=$$; while :; do :; done'])},{stdio:'inherit',env:{...process.env,MYREMOTE_PARENT_PID:String(process.pid)}});console.log('supervisor='+child.pid);setInterval(()=>{},1000)`
  const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  output(parent)
  let text = ''; let native; let supervisor
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native startup timed out')), 4000)
      parent.stdout.on('data', data => {
        text += data
        native = Number(text.match(/native=(\d+)/)?.[1]); supervisor = Number(text.match(/supervisor=(\d+)/)?.[1])
        if (native && supervisor) { clearTimeout(timer); resolve() }
      })
    })
    const gone = once(parent, 'exit'); parent.kill('SIGKILL'); await gone
    const deadline = Date.now() + 7000
    // The supervisor reaps its native child before exiting; allow parent detection + TERM deadline.
    while (isProcessAlive(native) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(isProcessAlive(native), false, 'native child survived its actual parent demise')
  } finally {
    if (native && isProcessAlive(native)) process.kill(native, 'SIGKILL')
    if (supervisor && isProcessAlive(supervisor)) process.kill(supervisor, 'SIGKILL')
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
  }
})

test('fixed entry listen error is logged and exits without uncaught exception', { timeout: 8000 }, async () => {
  const busy = createServer(); busy.listen(0, '127.0.0.1'); await once(busy, 'listening')
  const child = spawn(process.execPath, [script('fixed-entry.js')], { env: { ...process.env, MYREMOTE_PORT: String(busy.address().port) }, stdio: ['ignore', 'ignore', 'pipe'] })
  const errors = output(child)
  try { const [code] = await once(child, 'exit'); assert.equal(code, 1); assert.match(errors(), /fixed-entry failed:.*EADDRINUSE/); assert.doesNotMatch(errors(), /Unhandled 'error' event|throw er;/) }
  finally { if (child.exitCode === null) child.kill(); await new Promise(resolve => busy.close(resolve)) }
})

test('fixed entry bounded graceful shutdown closes persistent upgraded WebSocket', { timeout: 8000 }, async () => {
  const peers = new Set()
  const upstream = createServer()
  upstream.on('connection', peer => { peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer)) })
  upstream.on('upgrade', (req, peer) => { peer.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n') })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const port = await freePort()
  const child = spawn(process.execPath, [script('fixed-entry.js')], { env: { ...process.env, MYREMOTE_PORT: String(port), MYREMOTE_UPSTREAM: String(upstream.address().port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const errors = output(child)
  let socket
  try {
    await once(child.stdout, 'data')
    socket = connect(port, '127.0.0.1'); socket.on('error', () => {}); await once(socket, 'connect')
    socket.write('GET /myremote/api/remote.mux HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    const [data] = await once(socket, 'data'); assert.match(String(data), /101 Switching/)
    const done = once(child, 'exit'); const start = Date.now()
    child.send('shutdown')
    const [code] = await done
    assert.equal(code, 0, errors()); assert.ok(Date.now() - start < 4000)
  } finally {
    socket?.destroy(); for (const peer of peers) peer.destroy()
    if (child.exitCode === null) child.kill()
    await new Promise(resolve => upstream.close(resolve))
  }
})

test('Linux fixed-entry SIGTERM exits normally', { skip: !linux, timeout: 8000 }, async () => {
  const child = spawn(process.execPath, [script('fixed-entry.js')], { env: { ...process.env, MYREMOTE_PORT: String(await freePort()), MYREMOTE_UPSTREAM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  output(child)
  try { await once(child.stdout, 'data'); const done = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await done)[0], 0) }
  finally { if (child.exitCode === null) child.kill('SIGKILL') }
})
