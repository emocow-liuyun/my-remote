#!/usr/bin/env node
// Supervise native cloudflared without leaking Electron mode into its environment.
import { spawn } from 'node:child_process'
import { watchParent, nativeChildEnv } from '../lib/runtime.js'
const [command, ...args] = process.argv.slice(2)
if (!command) { console.error('my-remote: tunnel executable missing'); process.exit(1) }
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env: nativeChildEnv() })
let stopping = false
let finished = false
let killTimer
const shutdown = () => {
  if (stopping || finished) return
  stopping = true
  child.kill('SIGTERM')
  // Keep this deadline referenced: an ignored TERM must always lead to KILL.
  killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
}
const stopWatching = watchParent(shutdown)
const finish = code => {
  finished = true
  clearTimeout(killTimer)
  stopWatching()
  if (process.connected) process.disconnect()
  process.exitCode = code
}
child.on('error', error => { console.error('my-remote: tunnel spawn failed:', error.message); finish(1) })
child.on('exit', code => finish(stopping ? 0 : (code ?? 1)))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('message', message => { if (message === 'shutdown') shutdown() })
process.on('disconnect', shutdown)
