import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('root package declares a discoverable web client and real module dependencies', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
  assert.deepEqual(pkg.dsh.client.external, ['react'])
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.doesNotMatch(read('../cordis.patch.yml'), /name: '@local\/my-remote\/settings'/)
})

for (const path of ['../lib/client.js', '../settings/client.js']) test(`${path} registers remote section with installed slots contract`, () => {
  let declaration
  runInNewContext(read(path), { window: { __ModuleLoader__: { load(value) { declaration = value } } } })
  assert.equal(declaration.id, path.includes('/lib/') ? '@local/my-remote' : '@local/my-remote/settings')
  const client = declaration.factory(name => {
    assert.equal(name, 'react')
    return { createElement() {} }
  })
  assert.deepEqual(Array.from(client.inject), ['slots'])
  let registered
  client.apply({ slots: {
    inject(name, factory) { assert.equal(name, 'settings.section'); return factory() },
    register(options, component) { registered = { options, component }; return () => {} },
  } })
  assert.equal(registered.options.name, 'settings.section')
  assert.equal(registered.options.id, 'my-remote')
  assert.equal(registered.options.label(), '远程控制')
  assert.equal(typeof registered.component, 'function')
  const source = read(path)
  assert.equal((source.match(/type: 'password'/g) ?? []).length, 2)
  assert.match(source, /type: 'checkbox'/)
  assert.match(source, /passwordSet/)
  assert.match(source, /JSON.stringify\(\{ password, revokeDevices \}\)/)
  assert.doesNotMatch(source, /myremote\/code|toUpperCase|expiresAt|60 秒/)
})

test('root and legacy settings clients stay synchronized except module identity', () => {
  assert.equal(read('../lib/client.js').replace("id: '@local/my-remote',", "id: '@local/my-remote/settings',"), read('../settings/client.js'))
})
