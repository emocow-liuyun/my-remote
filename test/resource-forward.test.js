import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const listen = async server => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test('resource forwarding preserves upstream versions and representations', { timeout: 15000 }, async t => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'myremote-resources-'))
  process.env.DSH_HOME = home
  const id = 'r'.repeat(43)
  writeFileSync(join(home, 'my-remote-devices.json'), JSON.stringify({ devices: [{ id, lastSeenAt: Date.now() }] }))
  const seen = []
  let bootMode = 'ok'
  let htmlMode = 'normal'
  const bootCode = 'globalThis.marker = "</script><style>body{display:none}</style>";'
  const html = () => '<html><head>' + (htmlMode === 'external'
    ? '<script src="https://external.invalid/plugins/dsh-client-modules/client.js"></script>'
    : '<script src="/plugins/dsh-client-modules/client.js?rev=one&amp;other=two"></script>') + '</head></html>'
  const host = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    if (req.url.startsWith('/plugins/dsh-client-modules/')) {
      if (bootMode === 'fail') { res.writeHead(503); res.end('unavailable'); return }
      if (bootMode === 'redirect') { res.writeHead(302, { location: 'https://external.invalid/client.js' }); res.end(); return }
      res.writeHead(200, { 'content-type': bootMode === 'html' ? 'text/html' : 'text/javascript' }); res.end(bootCode); return
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      res.setHeader('etag', '"html"')
      if (htmlMode === 'csp') res.setHeader('content-security-policy', "script-src 'self'")
      if (req.headers['if-none-match'] === '"html"') { res.writeHead(304); res.end(); return }
      res.end(html()); return
    }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.endsWith('.css')) {
      const body = gzipSync(Buffer.from('body{color:rebeccapurple}'))
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'content-encoding': 'gzip', 'content-length': body.length, etag: '"css"', 'content-security-policy': "default-src 'self'" })
      res.end(body); return
    }
    if (url.pathname.endsWith('.js')) {
      const etag = '"' + url.searchParams.get('rev') + '"'
      res.setHeader('etag', etag)
      res.setHeader('cache-control', 'public, max-age=60')
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return }
      res.end('globalThis.rev=' + JSON.stringify(url.searchParams.get('rev'))); return
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"missing":true}')
  })
  const hostPort = await listen(host)
  const routes = []
  const effects = []
  const { apply } = await import('../lib/index.js')
  apply({
    webServer: { port: hostPort, register: route => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    get: () => undefined,
    effect: fn => effects.push(fn()),
  }, { remoteEntry: { enabled: false } })
  const proxy = createServer((req, res) => {
    const path = req.url.split('?')[0]
    const route = routes.find(x => x.kind === 'exact' && x.path === path) ?? routes.find(x => x.kind === 'prefix' && path.startsWith(x.path + '/'))
    if (!route) { res.writeHead(404); res.end(); return }
    Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  const port = await listen(proxy)
  const get = (path, init = {}) => fetch(`http://127.0.0.1:${port}/myremote${path}`, { ...init, headers: { cookie: `dsh-myremote=${id}`, ...init.headers } })
  t.after(async () => {
    effects.forEach(fn => fn())
    for (const server of [proxy, host]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })

  await t.test('rev queries stay intact, no process cache overrides the upstream', async () => {
    for (const rev of ['a', 'b', 'a']) {
      const response = await get(`/plugins/test/client.js?other=1&rev=${rev}&last=2`)
      assert.equal(await response.text(), `globalThis.rev="${rev}"`)
      assert.equal(response.headers.get('cache-control'), 'public, max-age=60')
      assert.equal(response.headers.get('etag'), `"${rev}"`)
      assert.match(response.headers.get('content-type'), /javascript/)
    }
    assert.equal(seen.filter(x => x.url.startsWith('/plugins/test/client.js')).length, 3)
    assert.equal(seen.at(-1).url, '/plugins/test/client.js?other=1&rev=a&last=2')
  })
  await t.test('conditional JS and HTML 304 have no decoded body or injected markup', async () => {
    for (const [path, etag] of [['/plugins/test/client.js?rev=a', '"a"'], ['/', '"html"']]) {
      const response = await get(path, { headers: { 'if-none-match': etag } })
      assert.equal(response.status, 304)
      assert.equal(response.headers.get('etag'), etag)
      assert.equal(await response.text(), '')
    }
  })
  await t.test('root CSS keeps its MIME/CSP/ETag and compressed body is decoded', async () => {
    const response = await get('/assets/site.css')
    assert.equal(await response.text(), 'body{color:rebeccapurple}')
    assert.match(response.headers.get('content-type'), /text\/css/)
    assert.equal(response.headers.get('etag'), '"css"')
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'")
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(seen.at(-1).headers.host, `127.0.0.1:${hostPort}`)
  })
  await t.test('HEAD and missing JS preserve status and MIME instead of fabricating JavaScript', async () => {
    const head = await get('/', { method: 'HEAD' })
    assert.equal(await head.text(), '')
    assert.equal(head.headers.get('etag'), '"html"')
    const missing = await get('/plugins/missing')
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('content-type'), 'application/json')
  })
  await t.test('inline boot escapes closing script, keeps query, invalidates only HTML validators', async () => {
    const response = await get('/')
    const page = await response.text()
    assert.ok(page.includes(bootCode.replace(/<\/script/gi, '<\\/script')))
    assert.equal(response.headers.get('etag'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(seen.at(-1).url, '/plugins/dsh-client-modules/client.js?rev=one&other=two')
  })
  await t.test('boot failures, redirects and wrong MIME retain external script', async () => {
    for (bootMode of ['fail', 'redirect', 'html']) {
      const response = await get('/')
      assert.equal(response.status, 200)
      assert.ok((await response.text()).includes('<script src="/plugins/dsh-client-modules/'))
    }
    bootMode = 'ok'
  })
  await t.test('CSP and external-host scripts are left intact and never fetched with local credentials', async () => {
    for (htmlMode of ['csp', 'external']) {
      const count = seen.length
      const response = await get('/')
      assert.ok((await response.text()).includes('<script src='))
      assert.equal(seen.length, count + 1)
      if (htmlMode === 'csp') assert.equal(response.headers.get('content-security-policy'), "script-src 'self'")
    }
  })
})
