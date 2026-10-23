import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
const script = name => fileURLToPath(new URL('../bin/' + name, import.meta.url))
const exit = child => once(child, 'exit')

test('tunnel supervisor handles executable spawn error without unhandled event', async () => {
  const child = spawn(process.execPath, [script('tunnel-runner.js'), 'myremote-executable-that-does-not-exist'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const [code] = await exit(child)
  assert.equal(code, 1)
  assert.match(stderr, /spawn failed/)
})

test('supervisor IPC shutdown terminates native child', { timeout: 8000 }, async () => {
  const child = spawn(process.execPath, [script('tunnel-runner.js'), process.execPath, '-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  try {
    await once(child.stdout, 'data')
    const done = exit(child)
    child.send('shutdown')
    const [code] = await done
    assert.equal(code, 0)
  } finally { if (child.exitCode === null) child.kill() }
})

test('fixed entry exits when captured parent PID is absent on Windows', { timeout: 8000 }, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  const child = spawn(process.execPath, [script('fixed-entry.js')], { env: { ...process.env, MYREMOTE_PARENT_PID: '2147483647', MYREMOTE_PORT: String(port), MYREMOTE_UPSTREAM: '1' }, stdio: 'ignore' })
  try { const [code] = await exit(child); assert.equal(code, 0) } finally { if (child.exitCode === null) child.kill() }
})
