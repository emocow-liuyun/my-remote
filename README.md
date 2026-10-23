# my-remote

DSH（DeepSeek Harness）桌面端的自建远程访问：一次性配对码、设备会话、门控反向代理。

不使用任何第三方中继，流量只经过你自己的 Cloudflare 隧道。

## 组成

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半区：`/myremote` 门控通道、配对码、设备表、子进程托管 |
| `lib/page.js` | 远程侧配对页（手机友好） |
| `lib/client.js` | 已拆分，保留兼容占位 |
| `bin/fixed-entry.js` | 固定端口转发器：自动跟随桌面实例端口变化 |
| `../my-remote-settings` | 独立设置页包（需单独安装） |

## 安装

```bash
dsh plugin --profile desktop add link:/path/to/my-remote
```

## 配置

```yaml
- id: my-remote
  name: "@local/my-remote"
  config:
    remoteEntry:
      enabled: true
      port: 3080
    tunnel:
      enabled: true
      tokenFile: /path/to/tunnel.token
      binary: /path/to/cloudflared
```

## 安全模型

- 转发器只绑 `127.0.0.1`，不暴露局域网
- 外部请求必须带配对凭据，未配对一律 403
- 控制面（生成码、吊销）仅应答本机回环
- 配对码 8 位、60 秒有效、单次消费
- 设备凭据为 httpOnly cookie，30 天过期，可随时吊销

**配对设备等同于完全控制凭据**：能执行命令、读写文件。用完请点“断开全部设备”。

## 跨平台

Linux / Windows 均已适配（端口探测、cloudflared 路径、模块解析）。详见 README。

## 许可

MIT
