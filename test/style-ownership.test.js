import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

for (const file of ['../lib/client.js', '../settings/client.js']) test(`${file}: two HMR cycles preserve pre-existing third-party styles`, () => {
  const makeTag = owner => ({ owner, setAttribute(name, value) { if (name === 'data-plugin') this.owner = value }, getAttribute() { return this.owner ?? null }, removeAttribute() { delete this.owner } })
  const foreign = makeTag(), explicit = makeTag('another-plugin')
  const tags = [foreign, explicit], tasks = []
  let declaration
  const context = { document: { querySelectorAll: () => tags.filter(tag => !tag.owner) }, queueMicrotask: fn => tasks.push(fn), window: { __ModuleLoader__: { load(value) { declaration = value } } } }
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ownId = file.includes('/lib/') ? '@local/my-remote' : '@local/my-remote/settings'
  for (let cycle = 0; cycle < 2; cycle++) {
    runInNewContext(source, context)
    declaration.factory(() => ({ createElement() {} }))
    // Reproduce the installed host's claimStyles -> teardown sequence.
    for (const tag of tags) if (!tag.owner) tag.owner = ownId
    while (tasks.length) tasks.shift()()
    assert.equal(foreign.owner, undefined, 'ownership guard must restore pre-existing state')
    assert.equal(explicit.owner, 'another-plugin')
    assert.equal(tags.filter(tag => tag.owner === ownId).length, 0, 'my-remote teardown must not claim foreign CSS')
  }
  assert.match(source, /'data-plugin': '@local\/my-remote'/)
  assert.match(source, /'data-plugin-css': '@local\/my-remote\/settings\.css'/)
})
