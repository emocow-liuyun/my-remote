// 无依赖冒烟测试：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

test('host 半区导出 apply 与 Config', async () => {
  process.env.DSH_ROOT ||= '/opt/DeepSeek Harness/resources/dsh'
  const mod = await import('../lib/index.js')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config, 'Config schema 缺失会导致插件不激活')
  assert.deepEqual(mod.inject, ['webServer'])
})

test('配对页含 8 位码输入与提交逻辑', () => {
  const page = read('lib/page.js')
  assert.match(page, /maxlength="8"/)
  assert.match(page, /\/myremote\/pair/)
})

test('转发器不绑定 0.0.0.0', () => {
  const entry = read('bin/fixed-entry.js')
  assert.match(entry, /const HOST = '127\.0\.0\.1'/)
  // 只检查监听调用，注释里提到 0.0.0.0 不影响。
  assert.match(entry, /server\.listen\(FIXED_PORT, HOST/)
  assert.doesNotMatch(entry, /server\.listen\([^)]*0\.0\.0\.0/)
})

test('Windows 分支存在', () => {
  assert.match(read('bin/fixed-entry.js'), /win32/)
  assert.match(read('lib/index.js'), /cloudflared\.exe/)
})

test('设置页走子路径并注册 settings.section', () => {
  const client = read('settings/client.js')
  assert.match(client, /'settings\.section'/)
  assert.match(client, /@local\/my-remote\/settings/)
})

test('清单声明的文件都存在', () => {
  const pkg = JSON.parse(read('package.json'))
  for (const entry of Object.values(pkg.exports)) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(join(root, entry)), `缺少 ${entry}`)
  }
})
