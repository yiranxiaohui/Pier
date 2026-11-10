# Pier 开发指南

项目结构、本地开发、构建与发版。功能说明见[使用指南](guide.md)。

## 项目结构

M0–M2（Host 核心、桌面端 MVP）已完成；M3（手机端 MVP，局域网）的代码已完成，待 iOS / Android 真机验证：

| 包 | 说明 |
|---|---|
| `packages/protocol` | 协议 schema（zod）、类型、`PROTOCOL_VERSION` |
| `packages/host` | Pier Host：工作区配置、会话池、Agent 运行时适配层（pi SDK、Claude Code、Codex）、UI 桥接、`pier-approval` 审批扩展、pi 扩展包管理、EventLog、本地 WebSocket Gateway、sidecar 入口 |
| `packages/crypto` | Noise XX / IK（X25519、ChaCha20‑Poly1305、SHA‑256，纯 JS）、加密通道帧、配对链接、性能测试 |
| `packages/client` | 通用客户端（握手、请求关联、自动重连、按 seq 恢复）、加密 WebSocket 与配对，以及调试 CLI `pier-cli` |
| `packages/chat-state` | 快照 + 事件 → 聊天视图状态的纯逻辑 reducer、会话控制器与斜杠命令解析执行（桌面端与手机端共用） |
| `apps/desktop` | Tauri 2 桌面应用：管理 Host sidecar（启动、崩溃重启、日志）、托盘常驻、单实例；React 界面含工作区与会话管理、流式聊天、工具卡片（终端输出、diff、文件预览）、审批、模型与思考等级切换、压缩、分叉、斜杠命令菜单、右侧工作区文件面板（支持在本地或远程工作区新建文件 / 文件夹、上传本地文件 / 文件夹、拖入上传、下载到本地及工作区间复制 / 剪切 / 粘贴）与 Git 源代码管理（查看更改与差异、暂存、提交、切换 / 新建分支、工作树管理、拉取、推送与同步、储藏、提交记录）、底部内置终端（xterm.js + 桌面端的 PTY；在工作区所在的电脑上打开，其他电脑的终端经它的 Pier Host 转发）、底部状态栏的主机状态（本机与已添加的其他电脑的 CPU、内存、磁盘、网络占用）、pi 扩展与扩展包管理（安装、移除、更新、启用 / 停用）、pi 配置（`settings.json`）以及 Claude Code（`settings.json`）与 Codex（`config.toml`）配置的可视化编辑，远程访问、配对二维码与设备管理，以及电脑之间互联（添加其他电脑，它们的工作区与会话和本机的统一列在侧边栏中） |
| `apps/relay` | Pier Relay：手机 / 电脑都没有公网 IP 时转发端到端加密的连接，内置 STUN 帮助 P2P 打洞；私有模式（令牌）与开放模式，Docker 镜像 `ghcr.io/yiranxiaohui/pier-relay` |
| `apps/mobile` | Expo（SDK 57）手机 App：扫码配对、多台电脑、会话列表、流式聊天、工具卡片、审批、steer / follow-up / 中止、附图、模型切换、斜杠命令、上下文与 token 用量、重命名 / 分叉 / 压缩、工作区文件（预览、编辑、新建文件 / 文件夹、上传下载）、远程终端、主机状态、pi 扩展管理、断线重连补发、Android 应用内更新 |

## 环境与检查

需要 Node 22+（推荐 24）和 [Bun](https://bun.sh)：Bun 管理依赖（`bun.lock`，版本见 `package.json` 的 `packageManager`）并编译 sidecar，脚本和测试仍在 Node 上运行。

```bash
bun install
bun run lint       # Biome
bun run typecheck  # tsc -b（项目引用）
bun run test       # Vitest：单元测试 + 基于 faux 模型的端到端测试
```

## 本地运行 Host 与调试 CLI

不打包桌面端时，可以直接从源码运行 Host，并用调试客户端 `pier-cli` 连接：

```bash
# 终端 1：启动 Host（监听 127.0.0.1 的随机端口，并写入 ~/.pier/run/host.json）
bun run host

# 终端 2：调试客户端（自动读取 ~/.pier/run/host.json）
bun run pier-cli
> /ws add ~/project  # 路径按 Tab 补全 Host 上的目录，~ 为 Host 的家目录
> /new
> 列出当前目录的文件
> /model            # 用 ↑/↓ 选择模型、Enter 切换（可输入文字筛选，Esc 取消）；也可 /model <provider/id|id>
> /open             # 用 ↑/↓ 选择并打开会话；/ws use、/revoke 不带参数时同样可选择
> /agents           # 列出这台电脑上的 Agent（pi、Claude Code、Codex）及版本、是否可用
> /new -a claude    # 新建 Claude Code 会话（-a / --agent 接编号、id、名称或唯一前缀，默认 pi）
> /models codex     # 列出某个 Agent 的模型（● 为它在当前工作区的默认模型）
> /allow            # 响应审批请求；/deny <理由>、/allow session
> /drop             # 模拟断线，验证重连补发
> /help             # 按 Tab 补全命令、模型、思考等级、Agent、子命令和目录，以及会话、工作区、设备、分叉点、选项的编号（有多个候选时列在输入行上方）
```

调试时 `bun run faux-host --agents` 会同时提供电脑上的 Claude Code 与 Codex（真实会话，会消耗额度）；`npx tsx packages/host/scripts/live-agent-check.ts claude-code [模型]` 用真实 CLI 走一遍创建、流式输出、审批、重命名、重新打开与分叉。

## 桌面端

除 Node 与 Bun 外还需要 Rust（stable），以及 Tauri 的[系统依赖](https://v2.tauri.app/start/prerequisites/)（Linux 上为 `libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等）。

```bash
bun run desktop                               # 构建 sidecar，然后 tauri dev（热更新前端）
bun run --cwd apps/desktop build              # 打包安装包（deb / AppImage / dmg / NSIS，取决于平台）
```

只调界面时可以不启动 Tauri：用假模型（faux）起一个 Host，再在浏览器里打开 Vite 开发服务器：

```bash
bun run faux-host                             # 输出 url 与 token，状态放在临时目录
bun run --cwd apps/desktop dev:web            # http://localhost:1420/?url=<url>&token=<token>
```

发送包含“演示”的消息会运行一段脚本化任务（bash、write、edit 与一次需要审批的命令）。加 `--fake-codex` 时还提供一个脚本化的 Codex（测试用的假 `codex app-server`，不消耗额度）：发送包含 `delegate` 的消息会派出 sub-agent，`delegate slow team` 放慢步骤并派出两个，`delegate-hold` 一直运行到被停止，用来调试 Subagent 卡片与右侧的对话面板。在地址后加 `&terminal=demo` 可以用一个模拟的回显 shell 调试终端面板（浏览器模式下没有真实终端）。

## 手机端

```bash
bun run --cwd apps/mobile start               # Metro 开发服务器
bun run --cwd apps/mobile android             # 本地构建并安装 Android 开发版（需要 Android SDK）
bun run --cwd apps/mobile ios                 # 本地构建 iOS 开发版（需要 macOS 与 Xcode）
cd apps/mobile && eas build --profile development   # 或用 EAS 云构建开发版
```

iOS 模拟器需要 macOS 和 Xcode；真机还需要在 Xcode 中选择自己的签名团队、连接设备并按系统提示开启开发者模式，然后运行 `cd apps/mobile && bunx expo run:ios --device`。也可用 `bunx eas-cli build --platform ios --profile preview` 云构建，首次使用需登录 Expo、关联自己的 EAS 项目并配置 Apple 签名和测试设备。免费个人签名有有效期与功能限制；Ad Hoc 分发、TestFlight 和 App Store 需要 Apple Developer 账号及相应证书 / 描述文件。仓库不提供 Apple 私钥或可通用安装的 IPA，构建成功也不代表已经上架。不要提交签名凭据。

App 用到相机、安全存储等原生模块，推荐使用开发构建（development build），而不是 Expo Go。每个 GitHub Release 都附带签好名的 Android 安装包 `pier-v<版本>-android.apk`，可以直接安装到手机上试用。iOS 暂时没有打包，需要自行构建。没有设备时可以用 Web 版调界面（安全存储回退为 localStorage，仅供开发）：

```bash
bun run faux-host --remote                    # 假模型 Host，并在 7433 端口开启远程访问
bun run --cwd apps/mobile web                 # 在浏览器中“添加电脑 → 粘贴配对链接”
```

配对链接可以从桌面「设置 → 设备与远程 → 显示配对二维码 → 复制配对链接」获得；只运行 faux-host 时，也可以用 `bun run pier-cli --url <url> --token <token>` 输入 `/pair` 显示终端二维码及链接，手机扫码后再用 `/pair yes` 确认（`/remote`、`/devices`、`/revoke` 管理远程访问与设备）。Android 模拟器访问宿主机时，用 `bun run faux-host --remote --remote-address 10.0.2.2:7433` 让二维码里带上模拟器可达的地址。

## Sidecar

构建桌面 sidecar 及旁边的 pi 运行时资源（输出到 `packages/host/bin/`）：

```bash
bun run build:sidecar                            # 当前平台
bun run build:sidecar --target bun-darwin-arm64  # 交叉编译
packages/host/bin/pier-host --help
```

## 发版

版本号统一由根 `package.json` 与各包的 `version` 决定（`packages/host/test/version.test.ts` 会校验它们与 `PIER_HOST_VERSION`、`pier-cli` 版本及 `CHANGELOG.md` 一致）。

**版本号规则**：日常发版只递增最后一位（`v0.2.1`、`v0.2.2`……），`x.y.0` 留给大版本。

**发布说明**：GitHub Release 和应用内「软件更新」显示的说明都取自 `CHANGELOG.md` 中对应版本的小节，请尽量用中文撰写。

1. 更新所有版本号，并在 `CHANGELOG.md` 中新增 `## v<版本> — <日期>` 小节；合并到 `main`。
2. 在 `main` 的该提交上打 tag 并推送：`git tag -a v<版本> -m "Pier v<版本>" && git push origin v<版本>`。
3. `.github/workflows/release.yml` 会校验 tag、版本号以及该提交是否在 `main` 上，然后运行完整检查；接着在各平台 runner 上用 `tauri build` 打包桌面端安装包（deb / AppImage / dmg / NSIS；macOS 包为 ad-hoc 签名并校验签名，未公证；其他平台未签名），并用 `packages/host/scripts/smoke-sidecar.mjs` 冒烟测试安装包内置的 sidecar；Linux x64 / arm64 runner 还会用 `packages/host/scripts/build-host-release.mjs` 构建独立 Host 压缩包（包含 `pier-cli`、pi 资源和服务管理脚本），在没有 DISPLAY / WAYLAND_DISPLAY 的环境中进行冒烟测试；同时用 `expo prebuild` + Gradle 构建 Android APK（arm64-v8a / armeabi-v7a / x86_64）；最后创建 GitHub Release，附带桌面端安装包、更新包及其签名、独立 Host 压缩包、`latest.json`、Android APK、`latest-android.json` 和 `SHA256SUMS.txt`，发布说明取自 CHANGELOG。版本号带 `-` 后缀（如 `0.1.0-rc.1`）时标记为 prerelease。

打 tag 之前可以先在 `main` 上手动触发一次试运行：`gh workflow run release.yml --ref main`。它会构建并冒烟测试全部产物（上传为 workflow artifacts），但跳过 tag 校验和发布。

**跟进 pi 版本**：pi SDK 编译在 Pier Host 里，`packages/host/package.json` 把所有 pi 包固定在同一个精确版本。`.github/workflows/pi-update.yml` 每天检查 npm 上的最新 pi（也可以手动触发并指定版本：`gh workflow run pi-update.yml -f version=<x.y.z>`），有新版本时用 `packages/host/scripts/pi-update.mjs` 改好版本号、刷新 `bun.lock`，推送到 `deps/pi-<版本>` 分支并开 PR；PR 说明列出这期间 pi 的 CHANGELOG，破坏性变更放在最前面，旧的 pi 更新 PR 会被关闭。它用默认的 `GITHUB_TOKEN` 开 PR 时，会在该分支上手动触发 CI（这种 PR 不会自动触发 `pull_request`），需要在仓库「Settings → Actions → General」中开启「Allow GitHub Actions to create and approve pull requests」；也可以配置 secret `PI_UPDATE_TOKEN`（有 contents 与 pull requests 写权限的 fine-grained token），用它开 PR 并走正常的 PR CI。CI 通过、确认破坏性变更不影响 Pier 后合并，再按上面的流程发一个补丁版本，用户就会通过应用内更新拿到新的 pi。关闭某个 pi 更新 PR 而保留分支，可以跳过这个版本。

**更新签名**：`tauri.conf.json` 开启了 `createUpdaterArtifacts`，桌面端打包时会用仓库 secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为更新包（AppImage、deb、macOS `.app.tar.gz`、NSIS 安装包）生成 `.sig`；缺少 secret 时打包直接失败。`updater-manifest` job 用 `apps/desktop/scripts/updater-manifest.mjs` 把这些签名汇总成 `latest.json`（发布说明同样取自 CHANGELOG），随 Release 一起发布；已安装的应用通过 `releases/latest/download/latest.json` 获取更新，因此 prerelease 不会推送给用户。对应的公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey` 中。私钥一旦丢失，已安装的版本将无法再校验新版本，只能让用户手动重装；轮换密钥时，要先用旧私钥签名发布一个内置新公钥的版本，之后的版本再改用新私钥签名。同一个 job 还用 `apps/mobile/scripts/android-update-manifest.mjs` 生成 `latest-android.json`（版本、发布说明、APK 下载地址、大小与 SHA-256 / MD5），供 Android App 通过 `releases/latest/download/latest-android.json` 检查更新。

**Android 签名**：Android 的 `versionCode` 由版本号推导而来（`主版本 × 1000000 + 次版本 × 1000 + 修订号`，prerelease 与正式版相同），APK 用 Pier 的发布密钥签名（PKCS12，别名 `pier`，证书 SHA-256 为 `00:78:F4:4A:DA:16:1B:2F:A4:4B:5B:DF:B9:71:82:AA:CE:34:C9:EC:9D:4E:57:36:2D:9A:62:C1:68:C2:98:1D`）。签名配置由 `apps/mobile/plugins/withAndroidRelease.js` 在 `expo prebuild` 时写入 Gradle 工程。keystore 以 base64 形式保存在仓库 secret `ANDROID_RELEASE_KEYSTORE` 中，密码保存在 `ANDROID_RELEASE_KEYSTORE_PASSWORD` 中（密钥密码与之相同）；缺少 secret 时打包直接失败，签名证书与上面的指纹不一致时也会失败。keystore 一旦丢失，已安装的 App 无法覆盖升级，只能让用户卸载后重装，因此除 secret 外务必另外离线备份。本地打正式包时，可以在 `~/.gradle/gradle.properties` 中设置 `pierUploadStoreFile`、`pierUploadStorePassword`、`pierUploadKeyAlias`、`pierUploadKeyPassword`；未设置时，release 构建回退为使用 debug 签名。
