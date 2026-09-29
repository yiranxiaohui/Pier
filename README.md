# Pier

A desktop dock and mobile remote for coding agents.

Pier 是编码 Agent 在桌面上的停靠点：Agent 常驻在你的电脑上运行，桌面端和手机端都能连上去查看、驱动和审批。目前内置 [pi](https://github.com/earendil-works/pi)，计划通过同一套 Host 适配层接入 Claude Code 与 Codex。

- 桌面端：Tauri 2，内置 Pier Host（当前 Agent 运行时为 pi SDK）
- 手机端：Expo / React Native 原生 App，通过配对后的加密连接驱动桌面 Agent

开发计划见 [docs/PLAN.md](docs/PLAN.md)，协议见 [docs/protocol.md](docs/protocol.md)，远程访问的安全设计见 [docs/security.md](docs/security.md)，技术验证结论见 [docs/spikes.md](docs/spikes.md)。

## 当前状态

M0–M2（Host 核心、桌面端 MVP）已完成；M3（手机端 MVP，局域网）的代码已完成，待 iOS / Android 真机验证：

| 包 | 说明 |
|---|---|
| `packages/protocol` | 协议 schema（zod）、类型、`PROTOCOL_VERSION` |
| `packages/host` | Pier Host：工作区配置、会话池、pi SDK 适配层、UI 桥接、`pier-approval` 审批扩展、EventLog、本地 WebSocket Gateway、sidecar 入口 |
| `packages/crypto` | Noise XX / IK（X25519、ChaCha20‑Poly1305、SHA‑256，纯 JS）、加密通道帧、配对链接、性能测试 |
| `packages/client` | 通用客户端（握手、请求关联、自动重连、按 seq 恢复）、加密 WebSocket 与配对，以及调试 CLI `pier-cli` |
| `packages/chat-state` | 快照 + 事件 → 聊天视图状态的纯逻辑 reducer、会话控制器与斜杠命令解析执行（桌面端与手机端共用） |
| `apps/desktop` | Tauri 2 桌面应用：管理 Host sidecar（启动、崩溃重启、日志）、托盘常驻、单实例；React 界面含工作区与会话管理、流式聊天、工具卡片（终端输出、diff、文件预览）、审批、模型与思考等级切换、压缩、分叉、斜杠命令菜单、右侧工作区文件面板、底部内置终端（xterm.js + 本机 PTY，只在桌面端可用），以及远程访问、配对二维码与设备管理 |
| `apps/mobile` | Expo（SDK 57）手机 App：扫码配对、多台电脑、会话列表、流式聊天、工具卡片、审批、steer / follow-up / 中止、附图、模型切换、斜杠命令、断线重连补发 |

## 开发

需要 Node 22+（推荐 24）和 [Bun](https://bun.sh)：Bun 管理依赖（`bun.lock`，版本见 `package.json` 的 `packageManager`）并编译 sidecar，脚本和测试仍在 Node 上运行。

```bash
bun install
bun run lint       # Biome
bun run typecheck  # tsc -b（项目引用）
bun run test       # Vitest：单元测试 + 基于 faux 模型的端到端测试
```

Host 复用 pi 的配置（`~/.pi/agent`：模型、凭据、settings、会话目录）。桌面端可以直接在「设置 → 模型与服务商」中登录服务商（API Key 或账号）、一键「浏览器登录」云链API（在浏览器中授权后自动获取令牌和全部模型），或在「设置 → 个人中心」登录 / 注册云链API 账号、查看余额，并按分组把令牌一键配置为本地服务商、添加 OpenAI / Anthropic / Gemini 兼容的自定义接口并设置默认模型，不需要另外安装 pi；已经用 `pi` 配置过的电脑会直接沿用原有配置。

```bash
# 终端 1：启动 Host（监听 127.0.0.1 的随机端口，并写入 ~/.pier/run/host.json）
bun run host

# 终端 2：调试客户端（自动读取 ~/.pier/run/host.json）
bun run pier-cli
> /ws add /path/to/project
> /new
> 列出当前目录的文件
> /allow            # 响应审批请求；/deny <理由>、/allow session
> /drop             # 模拟断线，验证重连补发
> /help
```

### 桌面端

除 Node 与 Bun 外还需要 Rust（stable），以及 Tauri 的[系统依赖](https://v2.tauri.app/start/prerequisites/)（Linux 上为 `libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等）。

```bash
bun run desktop                               # 构建 sidecar，然后 tauri dev（热更新前端）
bun run --cwd apps/desktop build              # 打包安装包（deb / AppImage / dmg / NSIS，取决于平台）
```

桌面端启动时会拉起内置的 Pier Host（`--watch-stdin`），关闭窗口只会隐藏到托盘，Agent 继续运行；从托盘或“设置 → 常规 → 退出 Pier”才会停止 Host。可用 `PIER_DIR` 隔离 Pier 状态目录，用 `PIER_HOST_BIN` 指定其他 Host 可执行文件。

**自动更新**：打包后的桌面端（Linux AppImage / deb、macOS、Windows NSIS）启动约 20 秒后以及之后每 6 小时检查一次 GitHub 上最新正式版的 `latest.json`（可在“设置 → 关于与更新”中关闭）。发现新版本时会弹出提示，左下角“设置”入口出现提示点；在“设置 → 关于与更新”（点击该入口，或托盘菜单“检查更新…”）中查看发布说明并“更新并重启”：下载更新包、用内置公钥校验签名、停止 Pier Host、安装，然后自动重启。开发构建（`tauri dev`）不支持自动更新。`PIER_UPDATER_ENDPOINT=<https 地址>` 可让打包版本改读其他清单（签名仍按内置公钥校验）；浏览器界面调试时在地址后加 `&updates=demo` 可使用模拟的更新流程。自动检查的开关保存在应用配置目录的 `updater.json` 中。

**macOS 首次打开**：安装包目前只做了本机签名（ad-hoc，`bundle.macOS.signingIdentity: "-"`），没有 Apple Developer ID 签名和公证。从浏览器下载后第一次打开时，macOS 会提示“无法验证开发者”（或“Apple 无法检查其是否包含恶意软件”）：把 Pier 拖进「应用程序」，双击打开一次后到「系统设置 → 隐私与安全性」底部点「仍要打开」并确认即可，之后正常启动；应用内自动更新不会再触发该提示。v0.2.2 及更早的安装包完全未签名，macOS 会误报“已损坏，无法打开”，这时在终端执行 `xattr -dr com.apple.quarantine /Applications/Pier.app` 后再打开（仍不行时再执行 `codesign --force --deep --sign - /Applications/Pier.app`）。

只调界面时可以不启动 Tauri：用假模型（faux）起一个 Host，再在浏览器里打开 Vite 开发服务器：

```bash
bun run faux-host                             # 输出 url 与 token，状态放在临时目录
bun run --cwd apps/desktop dev:web            # http://localhost:1420/?url=<url>&token=<token>
```

发送包含“演示”的消息会运行一段脚本化任务（bash、write、edit 与一次需要审批的命令）。在地址后加 `&terminal=demo` 可以用一个模拟的回显 shell 调试终端面板（浏览器模式下没有真实终端）。

### 手机端

手机 App 通过加密通道连接电脑上的 Host，需要先在桌面端“手机”面板中开启远程访问并扫码配对（原理见 [docs/security.md](docs/security.md)）。

```bash
bun run --cwd apps/mobile start               # Metro 开发服务器
bun run --cwd apps/mobile android             # 本地构建并安装 Android 开发版（需要 Android SDK）
bun run --cwd apps/mobile ios                 # 本地构建 iOS 开发版（需要 macOS 与 Xcode）
cd apps/mobile && eas build --profile development   # 或用 EAS 云构建开发版
```

App 用到相机、安全存储等原生模块，推荐使用开发构建（development build），而不是 Expo Go。每个 GitHub Release 都附带签好名的 Android 安装包 `pier-mobile-v<版本>-android.apk`，可以直接安装到手机上试用。iOS 暂时没有打包，需要自行构建。没有设备时可以用 Web 版调界面（安全存储回退为 localStorage，仅供开发）：

```bash
bun run faux-host --remote                    # 假模型 Host，并在 7433 端口开启远程访问
bun run --cwd apps/mobile web                 # 在浏览器中“添加电脑 → 粘贴配对链接”
```

配对链接可以从桌面“设置 → 手机与远程 → 显示配对二维码 → 复制配对链接”获得；只运行 faux-host 时，也可以用 `bun run pier-cli --url <url> --token <token>` 输入 `/pair` 生成链接，再用 `/pair yes` 确认（`/remote`、`/devices`、`/revoke` 管理远程访问与设备）。Android 模拟器访问宿主机时，用 `bun run faux-host --remote --remote-address 10.0.2.2:7433` 让二维码里带上模拟器可达的地址。

### Sidecar

构建单文件 sidecar（输出到 `packages/host/bin/`，包含 pi 运行时资源）：

```bash
bun run build:sidecar                            # 当前平台
bun run build:sidecar --target bun-darwin-arm64  # 交叉编译
packages/host/bin/pier-host --help
```

Pier 自身状态保存在 `~/.pier`（可用 `PIER_DIR` 覆盖）：`config.json`（工作区、审批策略与远程访问设置）、`run/host.json`（运行中 Host 的端口与本地 token，权限 0600）、`locks/`（会话文件锁）、`identity.json`（Host 的 X25519 私钥）、`devices.json`（已配对设备）、`audit.log`（远程设备的操作记录）。后三个文件权限均为 0600。

远程访问相关的命令行参数：`--no-remote`（本次运行不开启远程访问）、`--remote-port <n>`、`--remote-address <host:port>`（写进配对二维码的地址，可重复，例如 Tailscale 域名）、`--no-mdns`。

## 发版

版本号统一由根 `package.json` 与各包的 `version` 决定（`packages/host/test/version.test.ts` 会校验它们与 `PIER_HOST_VERSION`、`pier-cli` 版本及 `CHANGELOG.md` 一致）。

**版本号规则**：日常发版只递增最后一位（`v0.2.1`、`v0.2.2`……），`x.y.0` 留给大版本。

**发布说明**：GitHub Release 和应用内「软件更新」显示的说明都取自 `CHANGELOG.md` 中对应版本的小节，请尽量用中文撰写。

1. 更新所有版本号，并在 `CHANGELOG.md` 中新增 `## v<版本> — <日期>` 小节；合并到 `main`。
2. 在 `main` 的该提交上打 tag 并推送：`git tag -a v<版本> -m "Pier v<版本>" && git push origin v<版本>`。
3. `.github/workflows/release.yml` 会校验 tag、版本号以及该提交是否在 `main` 上，然后运行完整检查；接着在各平台 runner 上用 `tauri build` 打包桌面端安装包（deb / AppImage / dmg / NSIS；macOS 包为 ad-hoc 签名并校验签名，未公证；其他平台未签名），并用 `packages/host/scripts/smoke-sidecar.mjs` 冒烟测试安装包内置的 sidecar；同时用 `expo prebuild` + Gradle 构建 Android APK（arm64-v8a / armeabi-v7a / x86_64）；最后创建 GitHub Release，附带桌面端安装包、更新包及其签名、`latest.json`、Android APK 和 `SHA256SUMS.txt`，发布说明取自 CHANGELOG。Pier Host 随桌面端一起安装，不再单独发布 sidecar 压缩包。版本号带 `-` 后缀（如 `0.1.0-rc.1`）时标记为 prerelease。

打 tag 之前可以先在 `main` 上手动触发一次试运行：`gh workflow run release.yml --ref main`。它会构建并冒烟测试全部产物（上传为 workflow artifacts），但跳过 tag 校验和发布。

**更新签名**：`tauri.conf.json` 开启了 `createUpdaterArtifacts`，桌面端打包时会用仓库 secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为更新包（AppImage、deb、macOS `.app.tar.gz`、NSIS 安装包）生成 `.sig`；缺少 secret 时打包直接失败。`updater-manifest` job 用 `apps/desktop/scripts/updater-manifest.mjs` 把这些签名汇总成 `latest.json`（发布说明同样取自 CHANGELOG），随 Release 一起发布；已安装的应用通过 `releases/latest/download/latest.json` 获取更新，因此 prerelease 不会推送给用户。对应的公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey` 中。私钥一旦丢失，已安装的版本将无法再校验新版本，只能让用户手动重装；轮换密钥时，要先用旧私钥签名发布一个内置新公钥的版本，之后的版本再改用新私钥签名。

**Android 签名**：Android 的 `versionCode` 由版本号推导而来（`主版本 × 1000000 + 次版本 × 1000 + 修订号`，prerelease 与正式版相同），APK 用 Pier 的发布密钥签名（PKCS12，别名 `pier`，证书 SHA-256 为 `00:78:F4:4A:DA:16:1B:2F:A4:4B:5B:DF:B9:71:82:AA:CE:34:C9:EC:9D:4E:57:36:2D:9A:62:C1:68:C2:98:1D`）。签名配置由 `apps/mobile/plugins/withAndroidRelease.js` 在 `expo prebuild` 时写入 Gradle 工程。keystore 以 base64 形式保存在仓库 secret `ANDROID_RELEASE_KEYSTORE` 中，密码保存在 `ANDROID_RELEASE_KEYSTORE_PASSWORD` 中（密钥密码与之相同）；缺少 secret 时打包直接失败，签名证书与上面的指纹不一致时也会失败。keystore 一旦丢失，已安装的 App 无法覆盖升级，只能让用户卸载后重装，因此除 secret 外务必另外离线备份。本地打正式包时，可以在 `~/.gradle/gradle.properties` 中设置 `pierUploadStoreFile`、`pierUploadStorePassword`、`pierUploadKeyAlias`、`pierUploadKeyPassword`；未设置时，release 构建回退为使用 debug 签名。
