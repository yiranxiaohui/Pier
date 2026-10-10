# Pier Relay

手机和电脑都没有公网 IP、也不在同一个网络时，用 Pier Relay 转发它们之间的连接。

- **优先 P2P 直连。** 手机经中继连上电脑后，双方会通过中继交换 WebRTC 信令，借助中继内置的 STUN 服务尝试 NAT 打洞。打通后连接自动切换到点对点数据通道，不再经过中继，切换过程中会话、订阅与进行中的请求都不受影响。打不通（例如对称 NAT）时继续使用中继转发。
- **中继看不到内容。** 手机与电脑之间仍然运行端到端的 Noise 握手（与局域网直连相同），中继只转发密文，无法冒充任何一方：电脑注册时要证明自己持有静态私钥，手机只会接受配对时固定的电脑公钥。
- **两种模式。**
  - `private`（私有模式，默认）：只有提供访问令牌的电脑才能注册。适合自己或团队使用。
  - `open`（开放模式）：任何电脑都可以注册，受连接数与带宽限制约束。适合提供公共中继。

  两种模式下手机都不需要令牌：手机只能连到已注册的电脑，且必须通过与那台电脑的配对验证。模式可以在管理后台中在线切换。
- **网页管理后台。** 账号注册与登录，每个账号创建自己的访问令牌并查看自己在线的电脑；管理员审核账号、在线切换模式、调整连接数与带宽限制。见下文「管理后台」。

## 部署

需要一台有公网 IP 的服务器，开放：

| 端口 | 协议 | 用途 |
|---|---|---|
| 7480（或反向代理的 443） | TCP | WebSocket（电脑与手机连接中继）与网页管理后台 |
| 3478 | UDP | STUN（P2P 打洞），需要从公网直接访问，不能经过 HTTP 反向代理 |

### Docker Compose

```yaml
services:
  pier-relay:
    image: ghcr.io/yiranxiaohui/pier-relay:latest
    restart: unless-stopped
    environment:
      PIER_RELAY_MODE: private
      PIER_RELAY_TRUST_PROXY: "1"
    volumes:
      - pier-relay-data:/data   # 账号、令牌与管理后台中的设置
    ports:
      - "127.0.0.1:7480:7480"
      - "3478:3478/udp"
volumes:
  pier-relay-data:
```

启动后打开中继的网址（例如 `https://relay.example.com`），注册第一个账号（它自动成为管理员），再在「访问令牌」中创建令牌。不想用管理后台时，可以只用 `PIER_RELAY_TOKENS` 配置固定令牌（两者也可以同时使用）。

完整示例见 [docker-compose.example.yml](docker-compose.example.yml)。也可以在仓库根目录自行构建镜像：`docker build -f apps/relay/Dockerfile -t pier-relay .`。

不用 Docker 时：`bun run relay -- --data-dir ./relay-data`（或 `--mode private --token <令牌>`，开发），或 `bun run --cwd apps/relay build` 打包成单个 `dist/pier-relay.mjs` 后用 Node 22+ 运行。

### TLS 反向代理

请在中继前放一个 TLS 反向代理，让 Pier 使用 `wss://` 地址（iOS 只允许局域网内的明文连接）。代理需要支持 WebSocket 升级，并把空闲超时设得长一些（中继每 30 秒发一次 ping）。

nginx / OpenResty：

```nginx
location / {
    proxy_pass http://127.0.0.1:7480;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 0;
}
```

Caddy：`relay.example.com { reverse_proxy 127.0.0.1:7480 }`。

中继可以挂在子路径下（例如 `wss://example.com/pier-relay`），只要代理把该路径原样转发；管理后台此时在 `https://example.com/pier-relay/`。代理最好同时传递 `X-Forwarded-Proto`（登录 Cookie 会带上 `Secure`）。

### 管理后台

指定数据目录（`--data-dir` / `PIER_RELAY_DATA_DIR`）后，中继在自己的网址上提供网页管理后台。Docker 镜像默认使用 `/data`，请挂载卷，否则重建容器后账号与令牌会丢失。绑定宿主机目录时，容器以 UID 1000（`node`）运行，需要先 `chown 1000:1000` 该目录。

- **第一个账号**：还没有账号时，打开中继的网址会显示「创建管理员账号」，第一个注册的账号自动成为管理员（不受注册方式限制）。部署后请尽快注册，以免被别人抢先；之后的账号按注册方式处理。
- **账号**：管理员可以在「系统设置」中选择注册方式——注册需审核（默认）、开放注册或关闭注册；在「用户」中通过审核、停用、设为管理员、重置密码或删除账号。
- **访问令牌**：每个账号在「访问令牌」中创建自己的令牌（`prt_` 开头，只显示一次），填到 Pier 的中继设置中；「电脑」列出用自己令牌注册的在线电脑（管理员看到全部），可以单独「踢出」电脑以立即断开当前连接。电脑仍可使用有效令牌重新连接；要禁止再次连接，请删除对应的访问令牌。删除令牌、停用或删除账号后，用它注册的电脑立即断开（私有模式）。开放模式下也可以填令牌，电脑会关联到账号。
- **系统设置**：在线切换私有 / 开放模式（切到私有模式时，没有有效令牌的电脑立即断开），调整最多注册的电脑数、每台电脑的连接数、带宽上限、每分钟连接次数、STUN 公网地址与额外的 STUN 服务器，都不需要重启。**在后台保存过设置后，保存的设置优先于启动参数与环境变量**（令牌、端口、`--trust-proxy` 等除外）。

数据保存在数据目录的 `pier-relay.json` 中（0600）：密码为 scrypt 哈希，令牌与登录会话只保存 SHA-256。备份这个文件即可；忘记密码时可以让其他管理员重置。不指定数据目录时没有管理后台，行为与之前相同。

### 在 Pier 中启用

电脑上打开「设置 → 设备与远程 → 中继服务器」，填写中继地址（例如 `wss://relay.example.com`）和访问令牌（私有模式；管理后台中创建的令牌或 `PIER_RELAY_TOKENS` 中的令牌），保存并开启。状态显示「在线」后，新生成的配对二维码会带上中继地址。已经配对过的手机需要重新扫码，或在手机上「修改连接地址」中填写中继地址。「优先点对点直连（P2P）」默认开启。

连接其他电脑时同样适用：那台电脑开启中继后，复制它的配对链接添加即可。

## 选项

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--mode private\|open` | `PIER_RELAY_MODE` | 默认 `private` |
| `--data-dir <路径>` | `PIER_RELAY_DATA_DIR` | 数据目录，开启网页管理后台与账号令牌；Docker 镜像默认 `/data` |
| `--token <令牌>`（可重复） | `PIER_RELAY_TOKENS`（逗号分隔） | 私有模式的固定访问令牌，至少 16 个字符；没有数据目录时私有模式必须提供 |
| `--token-file <路径>` | `PIER_RELAY_TOKEN_FILE` | 每行一个令牌，`#` 开头为注释 |
| `--port <n>` | `PIER_RELAY_PORT` | WebSocket 端口，默认 7480 |
| `--host <地址>` | `PIER_RELAY_HOST` | 监听的地址，默认全部 |
| `--stun-port <n>` | `PIER_RELAY_STUN_PORT` | STUN 的 UDP 端口，默认 3478，`0` 关闭（关闭后不再尝试 P2P，除非另外指定 STUN） |
| `--public-host <名称>` | `PIER_RELAY_PUBLIC_HOST` | 告诉电脑与手机的 STUN 地址中的主机名，默认取电脑连接中继时的 `Host` 头 |
| `--ice-server <url>`（可重复） | `PIER_RELAY_ICE_SERVERS`（逗号分隔） | 另外提供的 STUN 服务器；不填写时使用下面的默认列表 |
| `--max-hosts <n>` | `PIER_RELAY_MAX_HOSTS` | 最多注册的电脑数，私有模式默认 10000，开放模式默认 1000 |
| `--max-streams <n>` | `PIER_RELAY_MAX_STREAMS` | 每台电脑同时经中继的连接数，默认 32 |
| `--rate-limit <字节/秒>` | `PIER_RELAY_RATE_LIMIT` | 每个连接每个方向的带宽上限，`0` 不限；私有模式默认不限，开放模式默认 2 MiB/s |
| `--trust-proxy` | `PIER_RELAY_TRUST_PROXY=1` | 从 `X-Forwarded-For` / `X-Real-IP` 读取客户端地址（在反向代理后面时开启） |

`GET /health` 返回 `{"ok":true,"service":"pier-relay","version":"…","mode":"…"}`，可用于健康检查。每个 IP 每分钟最多发起 120 次连接。

以下选项也可以在管理后台中修改，保存后以后台为准：模式、`--public-host`、`--ice-server`、`--max-hosts`、`--max-streams`、`--rate-limit`。

除中继自己的 STUN（未关闭时）外，未指定 `--ice-server` / `PIER_RELAY_ICE_SERVERS` 时还会公布这些公共 STUN 服务器：

```text
stun:stun.miwifi.com:3478        # 国内
stun:stun.qq.com:3478            # 国内
stun:stun.l.google.com:19302     # 国外
stun:stun.cloudflare.com:3478    # 国外
stun:global.stun.twilio.com:3478 # 国外
```

命令行或环境变量显式填写服务器后，会替换这组默认值；在管理后台保存设置时也可以清空列表来停用额外服务器。

## 协议

- 电脑：`/v1/host`。中继发送 `challenge`（一次性随机数与临时 X25519 公钥），电脑回复 `register`：静态公钥、`HMAC-SHA256(X25519(电脑静态私钥, 临时公钥), 标签‖随机数‖公钥)` 形式的证明，以及私有模式的令牌。中继按公钥登记电脑，同一公钥的新连接会顶替旧连接。注册成功后中继回复 `registered`（模式与 STUN 地址），之后用 `incoming` 通知新的设备连接。
- 设备：`/v1/connect?host=<电脑公钥>`。电脑不在线时直接返回 HTTP 404。
- 电脑收到 `incoming { id }` 后打开 `/v1/accept?id=<id>`，中继在两个 WebSocket 之间原样转发文本帧（只有密文）。电脑 10 秒内没有接起时关闭设备连接（4608）。

细节见 [docs/security.md](../../docs/security.md) 的「中继与 P2P」一节与 `packages/crypto/src/relay.ts`。
