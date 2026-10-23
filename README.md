# my-remote

DSH（DeepSeek Harness）桌面端的**自建远程访问**：在外面用手机或另一台电脑打开家里正在运行的 Desktop，直接接着原有对话干下去，而不是另开一个实例。

不经过任何第三方中继。流量只走**你自己的** Cloudflare 隧道。

```
手机 / 外网浏览器
   │ HTTPS
   ▼
Cloudflare 边缘 ──► cloudflared（作为 dsh 子进程）
                        │ 127.0.0.1:3080
                        ▼
                   固定入口转发器
                        │ 自动跟随端口
                        ▼
                   dsh Desktop（127.0.0.1:<随机端口>）
```

## 它解决什么问题

DSH 桌面版的 Web 端口**每次启动都会变**（实测 `45717 → 45735 → 43689`），而 Cloudflare 隧道的 ingress 必须写死端口。这个插件在 `3080` 起一个常驻转发器，每次请求时重新发现桌面实例的真实端口，隧道配置永远不用改。

## 组成

| 路径 | 作用 |
|---|---|
| `lib/index.js` | Host 半区：`/myremote` 门控通道、配对码、设备表、子进程托管 |
| `lib/page.js` | 远程侧配对页（手机友好，无依赖） |
| `bin/fixed-entry.js` | 固定端口转发器：自动跟随端口变化、透传 WebSocket |
| `settings/` | 设置页子路径：在「设置 → 远程控制」里生成配对码、管理设备 |

## 安装

```bash
git clone https://github.com/emocow-liuyun/my-remote.git
cd my-remote
dsh plugin --profile desktop add link:$PWD
```

Windows：

```powershell
git clone https://github.com/emocow-liuyun/my-remote.git
dsh plugin --profile desktop add link:$PWD
```

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加：

```yaml
- id: my-remote
  name: "@local/my-remote"
  config:
    # 可选：设备 cookie 名、空闲过期、设备数上限
    cookieName: dsh-myremote
    idleExpireMs: 2592000000   # 30 天
    maxDevices: 5
    remoteEntry:
      enabled: true
      port: 3080               # 固定入口端口
    tunnel:
      enabled: true
      tokenFile: /home/you/.cloudflare/dsh-tunnel.token
      binary: /home/you/.local/bin/cloudflared
```

Windows 路径写正斜杠或双反斜杠，`binary` 缺省走 PATH 上的 `cloudflared.exe`。

## 使用

1. 打开 DSH Desktop → 设置 → **远程控制** → 生成配对码（8 位，60 秒有效，只能用一次）
2. 手机打开 `https://<你的域名>/myremote/`，输入这 8 位码
3. 配对成功后直接进入家里这台 Desktop 的完整界面

设备记住 30 天。随时可在设置页点「断开全部设备」立即吊销。

## 安全模型

- 转发器**只绑 `127.0.0.1`**，不暴露局域网
- 外部请求必须携带配对凭据，未配对一律 403
- 控制面（生成码、吊销、设备列表）**仅应答本机回环**
- 配对码单次消费；设备凭据是 `httpOnly` cookie，落盘 `0600`
- 请求带 `CF-Connecting-IP` / `X-Forwarded-For` 一律判为远程，防止反代把公网请求伪装成本机

> **配对设备等同于完全控制凭据**：能执行命令、读写文件。只配对你自己的设备，用完及时吊销。

## 生命周期

转发器与隧道都是 dsh 的**子进程**：

- dsh 启动 → 两者随之启动
- dsh 退出 → 两者随之退出
- dsh 被强杀 → 转发器检测父进程消失后 2 秒内自行退出

不会留下「dsh 没开、隧道还挂着」的半死状态。

## 已知限制

- 一次只能有一个实例对外：不同机器需要各自的 tunnel 和域名
- 配对设备库按机器独立（`$DSH_HOME/my-remote-devices.json`）
- 远程页保留了 DSH 自己的响应式窄屏行为，侧栏默认收起
- dsh-purge 等第三方插件的首次确认弹窗已在远程侧跳过，仅本机生效

## 跨平台

Linux 与 Windows 均已适配：

| 差异点 | 处理 |
|---|---|
| `schemastery` 不在 profile 依赖树 | 依次尝试插件依赖树 → `DSH_ROOT` → 进程 argv 推导 |
| cloudflared 默认路径 | Linux `~/.local/bin/cloudflared`；Windows 走 PATH |
| 端口探测 | Linux `ss -lntH`；Windows `netstat -ano -p TCP` |

## 许可

[MIT](LICENSE)
