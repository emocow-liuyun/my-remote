/**
 * 远程控制设置页（Client 半区）。
 *
 * 在「设置」面板里加一个独立分区，可以在界面里直接生成配对码、查看已配对设备、一键吊销。
 * 走的是插件 Host 半区已经注册好的 /myremote/* HTTP 路由，不额外引入 Remote 端点。
 */
window.__ModuleLoader__.load({
  id: '@local/my-remote/settings',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const primitives = undefined
    const NS = 'my-remote'

    // ---- 样式：只用主题 token，跟随明暗模式 ----
    const CSS = `
.mr_root{width:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}
.mr_card{display:flex;flex-direction:column;gap:12px;padding:16px 0 24px;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2);border-radius:0}
.mr_card:last-child{border-bottom:0;padding-top:24px}
.mr_title{margin:0;font-size:14px;font-weight:500;line-height:20px}
.mr_desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mr_code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:24px;font-weight:500;letter-spacing:.2em;text-align:left;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);user-select:all;width:100%;box-sizing:border-box}
.mr_code_empty{font-family:inherit;color:var(--dsw-alias-label-secondary);letter-spacing:0;font-size:13px;font-weight:400}
.mr_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mr_list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.mr_item{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:13px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.mr_item:last-child{border-bottom:0}
.mr_meta,.mr_count{color:var(--dsw-alias-label-secondary);font-size:12px}
.mr_dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:8px;vertical-align:middle}
.mr_on{background:var(--dsw-alias-state-success-primary)}.mr_off{background:var(--dsw-alias-state-idle-primary)}
.mr_err,.mr_ok{font-size:12px;line-height:18px;margin:0}.mr_err{color:var(--dsw-alias-state-error-primary)}.mr_ok{color:var(--dsw-alias-label-secondary)}
.mr_btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:32px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .15s}
.mr_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.mr_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.mr_btn:disabled{opacity:.45;cursor:default}
.mr_btn_danger{color:var(--dsw-alias-state-error-primary);background:transparent}
`

    /** 简单 fetch 包装：只处理 JSON 与错误码。 */
    async function call(path, init) {
      const localPath = globalThis.location?.protocol === 'dsh-app:' ? 'http://127.0.0.1:3080' + path : path
      const res = await fetch(localPath, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let body
      try {
        body = await res.json()
      } catch {
        body = undefined
      }
      if (!res.ok) {
        const code = body?.code ?? `http-${String(res.status)}`
        throw new Error(code)
      }
      return body
    }

    function RemoteSection() {
      const [code, setCode] = react.useState(undefined)
      const [expiresAt, setExpiresAt] = react.useState(0)
      const [devices, setDevices] = react.useState([])
      const [error, setError] = react.useState(undefined)
      const [notice, setNotice] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [remaining, setRemaining] = react.useState(0)

      const refresh = react.useCallback(async () => {
        try {
          const status = await call('/myremote/status', { method: 'GET' })
          setDevices(Array.isArray(status?.devices) ? status.devices : [])
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      react.useEffect(() => {
        refresh()
      }, [refresh])

      // 倒计时：配对码 60 秒过期，过期后从界面撤掉，避免显示一个没用的码。
      react.useEffect(() => {
        if (expiresAt === 0) return undefined
        const tick = () => {
          const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
          setRemaining(left)
          if (left === 0) { setCode(undefined); setExpiresAt(0) }
        }
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [expiresAt])

      const mint = async () => {
        setBusy(true); setError(undefined); setNotice(undefined)
        try {
          const value = await call('/myremote/code', { method: 'POST' })
          setCode(value?.code)
          setExpiresAt(Number(value?.expiresAt ?? 0))
          setNotice('配对码已生成，60 秒内有效，只能用一次。')
        } catch (cause) {
          setError(cause?.message === 'loopback-only'
            ? '配对码只能在本机生成。请在这台电脑的浏览器里操作。'
            : String(cause?.message ?? cause))
        } finally { setBusy(false) }
      }

      const revoke = async () => {
        setBusy(true); setError(undefined); setNotice(undefined)
        try {
          await call('/myremote/revoke', { method: 'POST' })
          setCode(undefined); setExpiresAt(0)
          setNotice('已吊销全部设备，需要重新配对才能远程访问。')
          await refresh()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally { setBusy(false) }
      }

      const Button = primitives?.Button ?? ((props) => h('button', {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled === true,
        className: 'mr_btn' + (props.danger ? ' mr_btn_danger' : ''),
      }, props.children))

      return h('div', { className: 'mr_root' }, [
        h('style', { key: 'style' }, CSS),
        h('section', { className: 'mr_card', key: 'pair' }, [
          h('h3', { className: 'mr_title', key: 't' }, '设备配对'),
          h('p', { className: 'mr_desc', key: 'd' },
            '在另一台设备打开 dsh.liuiyunpro.cn/myremote/，输入配对码即可连接。'),
          h('div', {
            className: 'mr_code' + (code === undefined ? ' mr_code_empty' : ''),
            key: 'c',
          }, code ?? '尚未生成配对码'),
          code !== undefined
            ? h('p', { className: 'mr_desc', key: 's' }, `剩余 ${String(remaining)} 秒`)
            : null,
          h('div', { className: 'mr_row', key: 'b' }, [
            h(Button, { key: 'mint', onClick: mint, disabled: busy }, '生成配对码'),
          ]),
          notice !== undefined ? h('p', { className: 'mr_ok', key: 'n' }, notice) : null,
          error !== undefined ? h('p', { className: 'mr_err', key: 'e' }, error) : null,
        ]),

        h('section', { className: 'mr_card', key: 'dev' }, [
          h('div', { className: 'mr_row', key: 'h' }, [
            h('h3', { className: 'mr_title', key: 't', style: { flex: '1' } }, '已配对设备'),
            h('span', { className: 'mr_count', key: 'c' }, `${String(devices.length)} 台`),
          ]),
          devices.length === 0
            ? h('p', { className: 'mr_desc', key: 'empty' }, '还没有设备配对。')
            : h('ul', { className: 'mr_list', key: 'l' }, devices.map((device, index) => h('li', {
              className: 'mr_item',
              key: `${String(device.name)}-${String(index)}`,
            }, [
              h('span', { key: 'n' }, [
                h('span', { className: `mr_dot ${device.online === true ? 'mr_on' : 'mr_off'}`, key: 'd' }),
                device.name ?? '未知设备',
              ]),
              h('span', { className: 'mr_meta', key: 'm' }, device.online === true ? '在线' : '离线'),
            ]))),
          h('div', { className: 'mr_row', key: 'b' }, [
            h(Button, { key: 'r', onClick: revoke, disabled: busy, danger: true }, '断开全部设备'),
          ]),
        ]),
      ])
    }

    /**
     * 挂载本分区。
     * @param ctx - Client 插件上下文。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'my-remote',
        order: 500,
        label: () => '远程控制',
        locale: NS,
      }, RemoteSection))
    }

    exports.name = 'my-remote'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
