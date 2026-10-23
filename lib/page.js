/**
 * 远程侧入口：/myremote/ 渲染配对页与已配对设备的落地页。
 * 不依赖官方 SPA 的鉴权 cookie——设备凭据就是本命名的 cookie。
 */
const HTML = (title, body) => `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  :root{color-scheme:light dark;--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--acc:#2f81f7}
  @media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--acc:#0969da}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       padding:24px;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
  main{width:100%;max-width:380px}
  h1{font-size:20px;margin:0 0 6px}
  p{color:var(--muted);font-size:14px;margin:0 0 20px}
  input,button{width:100%;font:inherit;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg)}
  input{height:56px;text-align:center;font-size:18px;
        padding:0 12px;font-variant-numeric:tabular-nums}
  button{height:52px;margin-top:12px;background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
  button:disabled{opacity:.5}
  .msg{margin-top:14px;font-size:14px;min-height:20px}
  .err{color:#f85149}.ok{color:#3fb950}
  .hint{margin-top:24px;font-size:12px;color:var(--muted);line-height:1.5}
</style></head>
<body><main>${body}</main></body></html>`

const PAIR_PAGE = HTML('远程登录', `
<h1>远程登录</h1>
<p>输入在家里电脑设置的远程密码（区分大小写）</p>
<form id="f">
  <input id="c" type="password" autocomplete="current-password" placeholder="远程密码" required>
  <button id="b" type="submit">登录</button>
</form>
<div class="msg" id="m"></div>
<div class="hint">请先在家里电脑的“设置 → 远程控制”中设置密码。配对成功后本设备会被记住 30 天，在家里电脑上点“断开全部”可立即吊销。</div>
<script>
const f=document.getElementById('f'),c=document.getElementById('c'),b=document.getElementById('b'),m=document.getElementById('m')
f.addEventListener('submit',async e=>{
  e.preventDefault()
  b.disabled=true;m.className='msg';m.textContent='正在登录…'
  try{
    const r=await fetch('/myremote/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:c.value})})
    const j=await r.json()
    if(j.ok){m.className='msg ok';m.textContent='登录成功，正在进入…';location.replace('/myremote/')}
    else{m.className='msg err';m.textContent=j.code==='password-not-set'?'本机尚未设置远程密码，请先在电脑上设置':j.code==='rate-limited'?'尝试过于频繁，请 5 分钟后重试':'密码不正确，请重试'}
  }catch(err){m.className='msg err';m.textContent='网络错误，请重试'}
  finally{b.disabled=false}
})
</script>`)

const PAIRED_PAGE = (deviceName) => HTML('已配对', `
<h1>已配对</h1>
<p>本设备：${deviceName}</p>
<div class="hint">远程通道已就绪。要打开完整 GUI，请在这台设备上访问家里电脑的 dsh 地址——
本插件负责鉴权与通道门控，不替代官方界面。</div>`)

export const PAIR_PAGE_HTML = PAIR_PAGE
export const pairedPageHtml = PAIRED_PAGE
