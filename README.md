# my-remote — Linux / Windows

DSH（DeepSeek Harness）桌面端自建远程访问插件。通过自己的 Cloudflare Tunnel，在手机或另一台电脑上接着使用同一台 Desktop、工作区和对话。

本 fork 包含 **Linux / Windows 兼容、固定密码登录、当前 Desktop 认证接口适配**。

```text
远程浏览器 → HTTPS / Cloudflare Tunnel → 127.0.0.1:3080
  → 固定入口 → 随机回环 bridge → 设备凭据校验 → 当前 DSH Desktop
```

## 安装

### Linux

需要正在运行的 DSH Desktop、Git，以及可用的 cloudflared。插件随 DSH 加载，不需要另建 systemd 服务。

```bash
git clone https://github.com/l060122jun-dotcom/my-remote.git
cd my-remote
dsh plugin --profile desktop add "link:$PWD"
```

推荐使用 Cloudflare 官方安装方式，将 `cloudflared` 放到 PATH（例如 `/usr/bin/cloudflared`），或显式设置 `tunnel.binary`。发行版和 CPU 架构请按官方文档选择：
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/

在 Cloudflare 控制台创建或复用 remotely-managed Tunnel，配置 Public Hostname 指向 `http://127.0.0.1:3080`，将该隧道的 **运行 token** 保存为本机文件。不要把 Cloudflare API Token 当成 Tunnel token。

```bash
install -d -m 700 "$HOME/.config/my-remote"
# 将隧道运行 token 写入下面的文件；不要提交到 Git。
chmod 600 "$HOME/.config/my-remote/tunnel.token"
```

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加配置，路径替换为实际绝对路径：

```yaml
- id: my-remote
  name: '@local/my-remote'
  config:
    cookieName: dsh-myremote
    idleExpireMs: 2592000000
    maxDevices: 5
    remoteEntry:
      enabled: true
      port: 3080
    tunnel:
      enabled: true
      tokenFile: /home/YOUR_USER/.config/my-remote/tunnel.token
      # 可省略：优先使用 PATH，再兼容 ~/.local/bin/cloudflared。
      binary: /usr/bin/cloudflared
```

配置的路径不执行 shell 展开，请使用完整路径，不直接写 `~` 或 `$HOME`。

### Windows

```powershell
git clone https://github.com/l060122jun-dotcom/my-remote.git
Set-Location my-remote
dsh plugin --profile desktop add "link:$PWD"
```

配置结构相同，使用实际 Windows 路径：

```yaml
- id: my-remote
  name: '@local/my-remote'
  config:
    remoteEntry:
      enabled: true
      port: 3080
    tunnel:
      enabled: true
      tokenFile: C:/Users/YOUR_USER/.cloudflared/tunnel.token
      binary: C:/Tools/cloudflared.exe
```

Windows 缺省从 PATH 查找 `cloudflared.exe`。Token 文件和设备文件请保存在当前用户专用目录，并使用 Windows ACL 限制访问；POSIX `0600` 不是 Windows DACL 的替代。

## 设置固定密码

1. 本机 DSH Desktop → **设置 → 远程控制**。
2. 输入密码和确认密码，点击 **保存密码**。
3. 在另一台设备访问 `https://YOUR_HOSTNAME/myremote/`，输入固定密码登录。

支持 **4 位密码**，无最低长度或复杂度要求；密码必须非空、区分大小写，首尾空白也参与验证。HTTP JSON 请求体上限为 4096 字节。

密码保存后清空输入框，不回显。修改密码默认保留已有设备；勾选「同时断开全部已配对设备」会吊销其 cookie 并关闭已建立的 mux 连接。也可点击「断开全部设备」。设备空闲期限默认 30 天。

从旧版升级后，原有配对设备仍保留，但不再签发一次性配对码；请先在本机设置固定密码。

## 兼容与生命周期

- Linux 和 Windows：转发器、隧道 supervisor 都是 DSH 子进程，跟随插件启动和停止。
- Electron：Node 子进程使用 `ELECTRON_RUN_AS_NODE=1`；native cloudflared 不继承该开关。
- 退出清理使用 IPC、父 PID 存活检查及关闭超时，处理 WebSocket 长连接和 native 进程忽略 SIGTERM 的情况。
- 当前 Desktop 只有 `webServer.port` 时自动构造回环 origin；旧载体的 `getOrigin()` 仍兼容。
- 固定入口将 `/` 重定向到 `/myremote/`，根绝对资源、API、WebSocket 均映射到设备门控，不将根 API 直接开放。
- Desktop 禁止普通浏览器时，插件使用私有随机回环 bridge；访问宿主的 renderer capability 和 connection cookie 仅在服务端使用，不传到远程页面。
- 设置页由根包的 `dsh.client` 声明加载，无需额外安装 settings 子路径。
- 固定入口由插件传入精确 bridge 端口，正常运行无需扫描监听端口。独立诊断时仅识别本插件状态接口。

安装或升级之后刷新 Desktop 界面。若宿主未启用模块热重载，请正常重启 Desktop 一次，以便加载新 Host 模块及客户端清单。

## 访问控制和持久化

- 只监听 `127.0.0.1`；公网应仅通过自己的隧道入口进入。
- 本机控制面检查回环来源及 Origin；带 `CF-Connecting-IP` / `X-Forwarded-For` 的请求按远程处理。
- 自建反向代理必须保留或设置转发来源头，勿把公网请求伪装为本机。
- 密码以随机 salt + scrypt 哈希原子保存到 `$DSH_HOME/my-remote-password.json`，无明文。
- 设备凭据保存到 `$DSH_HOME/my-remote-devices.json`，cookie 为 HttpOnly / SameSite=Lax，HTTPS 下带 Secure。
- 未设置 `DSH_HOME` 时使用当前用户的 `~/.dsh`；Linux 文件权限为 `0600`。
- 每 IP 5 次失败后限制到 5 分钟窗口结束，成功登录清零；限流桶有界。
- 新设备未登录时显示登录页；受保护 API/WS 需要有效设备 cookie。
- 未设置密码：`403 password-not-set`；错误密码：`401 password-invalid`；限流：`429 rate-limited`；旧 `/myremote/code`：`410 code-retired`。

配对设备拥有这台 DSH 的完整操作能力。请仅向自己的设备提供密码和 cookie。

## 测试

独立测试不需要安装完整 DSH，开发依赖提供与宿主一致的 schema 库：

```bash
npm ci --ignore-scripts
npm test
```

也可在已安装的宿主上测试：

```bash
DSH_ROOT=/path/to/DSH/resources/app node --test test/*.test.js
```

```powershell
$env:DSH_ROOT = 'D:\DSH Desktop\resources\app'
node --test test/*.test.js
```

GitHub Actions 矩阵：Ubuntu / Windows × Node 20 / 22 / 24。测试使用临时设备库、测试密码及回环端口，不接入真实 Cloudflare、不更改用户配置。覆盖密码持久化、短密码、轮换、限流、Desktop 认证桥接、根资源/API/WS、CORS、进程生命周期和平台解析。

## 许可

MIT。基于 https://github.com/emocow-liuyun/my-remote 。
