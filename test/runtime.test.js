import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gatedPath, resolveSchemastery, nodeChildEnv, executableAvailable, isProcessAlive } from '../lib/runtime.js'

test('schema resolution tolerates relative, missing and option argv candidates', () => {
  const visited = []
  const expected = {}
  const actual = resolveSchemastery({ roots: ['--test', 'missing/entry.js', '.', 'D:/DSH Desktop/resources/app'], load(base) {
    visited.push(base)
    if (visited.length < 10) throw new Error('not installed here')
    return () => expected
  } })
  assert.equal(actual, expected)
  assert.ok(visited.slice(1).every(x => /^[A-Za-z]:[\\/]|^\//.test(x)))
})
test('Electron Node child and PATH executable handling', () => {
  assert.equal(nodeChildEnv({ A: 'b' }, '35.0').ELECTRON_RUN_AS_NODE, '1')
  assert.equal(nodeChildEnv({ A: 'b' }, undefined).A, 'b')
  assert.equal(executableAvailable('cloudflared.exe'), true)
  assert.equal(executableAvailable('./missing/cloudflared.exe'), false)
})
test('parent liveness uses signal zero and preserves EPERM', () => {
  assert.equal(isProcessAlive(123, (pid, signal) => { assert.equal(pid, 123); assert.equal(signal, 0) }), true)
  assert.equal(isProcessAlive(123, () => { throw Object.assign(new Error(), { code: 'ESRCH' }) }), false)
  assert.equal(isProcessAlive(123, () => { throw Object.assign(new Error(), { code: 'EPERM' }) }), true)
})
test('all root assets/API aliases enter device gate; ambiguous paths fail closed', () => {
  for (const path of ['/assets/app.js', '/plugins/a.js?rev=1', '/api/remote.mux', '/favicon.ico']) assert.equal(gatedPath(path), '/myremote' + path)
  assert.equal(gatedPath('/myremote/api/foo?q=1'), '/myremote/api/foo?q=1')
  for (const path of ['//evil.test', '/myremote/../api', '/myremote/%2e%2e/api', '/myremote\\x']) assert.equal(gatedPath(path), undefined)
})
