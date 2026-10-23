/**
 * 远程控制设置页（Client 半区）。
 *
 * 在「设置」面板里加一个独立分区，可以在界面里直接设置远程密码、查看已配对设备、一键吊销。
 * 走的是插件 Host 半区已经注册好的 /myremote/* HTTP 路由，不额外引入 Remote 端点。
 */
window.__ModuleLoader__.load({
  id: '@local/my-remote',
  factory: (require) => {
    // The host claims every unowned style after materializing a factory. Protect
    // styles that existed before ours until that synchronous claim has finished.
    const preservedStyles = typeof document === 'undefined' ? [] : Array.from(document.querySelectorAll('style:not([data-plugin])'))
    const preservedOwner = '@local/my-remote/preexisting-styles'
    for (const tag of preservedStyles) tag.setAttribute('data-plugin', preservedOwner)
    if (preservedStyles.length) queueMicrotask(() => {
      for (const tag of preservedStyles) if (tag.getAttribute('data-plugin') === preservedOwner) tag.removeAttribute('data-plugin')
    })
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
.mr_input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:inherit;background:var(--dsw-alias-bg-layer-1);font:inherit}
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
      const localPath = (globalThis.location?.protocol === 'dsh-app:' || /^http:\/\/127\.0\.0\.1:/.test(globalThis.location?.origin ?? '')) ? 'http://127.0.0.1:3080' + path : path
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
      const [password, setPassword] = react.useState('')
      const [confirmation, setConfirmation] = react.useState('')
      const [passwordSet, setPasswordSet] = react.useState(false)
      const [revokeDevices, setRevokeDevices] = react.useState(false)
      const [devices, setDevices] = react.useState([])
      const [error, setError] = react.useState(undefined)
      const [notice, setNotice] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)

      const refresh = react.useCallback(async () => {
        try {
          const status = await call('/myremote/status', { method: 'GET' })
          setDevices(Array.isArray(status?.devices) ? status.devices : [])
          setPasswordSet(status?.passwordSet === true)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      react.useEffect(() => {
        refresh()
      }, [refresh])

      const save = async () => {
        setError(undefined); setNotice(undefined)
        if (password.length === 0) { setError('请输入密码。'); return }
        if (password !== confirmation) { setError('两次输入的密码不一致。'); return }
        setBusy(true)
        try {
          await call('/myremote/password', { method: 'POST', body: JSON.stringify({ password, revokeDevices }) })
          setPassword(''); setConfirmation(''); setRevokeDevices(false)
          setNotice(revokeDevices ? '密码已保存，已断开全部设备。' : '密码已保存，已配对设备保持连接。')
          await refresh()
        } catch (cause) {
          setError(cause?.message === 'loopback-only' ? '请在本机设置远程密码。' : cause?.message === 'password-save-failed' ? '密码保存失败，请重试。' : String(cause?.message ?? cause))
        } finally { setBusy(false) }
      }

      const revoke = async () => {
        setBusy(true); setError(undefined); setNotice(undefined)
        try {
          await call('/myremote/revoke', { method: 'POST' })
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
        h('style', { key: 'style', 'data-plugin': '@local/my-remote', 'data-plugin-css': '@local/my-remote/settings.css' }, CSS),
        h('section', { className: 'mr_card', key: 'pair' }, [
          h('h3', { className: 'mr_title', key: 't' }, '远程密码'),
          h('p', { className: 'mr_desc', key: 'd' }, '在另一台设备打开 dsh.liuiyunpro.cn/myremote/，输入此密码即可连接。密码区分大小写，支持 4 位密码，无最低长度和复杂度要求。'),
          h('p', { className: 'mr_desc', key: 'status' }, passwordSet ? '已设置密码' : '未设置密码'),
          h('label', { key: 'password' }, ['密码', h('input', { className: 'mr_input', type: 'password', autoComplete: 'new-password', value: password, disabled: busy, onChange: e => setPassword(e.target.value), key: 'input' })]),
          h('label', { key: 'confirmation' }, ['确认密码', h('input', { className: 'mr_input', type: 'password', autoComplete: 'new-password', value: confirmation, disabled: busy, onChange: e => setConfirmation(e.target.value), key: 'input' })]),
          h('label', { className: 'mr_row', key: 'revoke-option' }, [h('input', { type: 'checkbox', checked: revokeDevices, disabled: busy, onChange: e => setRevokeDevices(e.target.checked), key: 'checkbox' }), '同时断开全部已配对设备']),
          h('div', { className: 'mr_row', key: 'b' }, [
            h(Button, { key: 'save', onClick: save, disabled: busy }, passwordSet ? '修改密码' : '保存密码'),
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
