# Changelog

Pier 的所有重要变更都记录在这里。版本号规则：日常发版只递增最后一位（0.2.1、0.2.2……），`x.y.0` 留给大版本；1.0 之前，大版本可能包含不兼容的变更。

## 未发布

### 新增

- **收起左侧边栏**：桌面端侧边栏顶部「Pier」右侧新增收起按钮，也可以按 Ctrl/⌘+B；收起后会话标题栏左侧（以及工作区首页、新建会话页左上角）显示展开按钮。开关状态会被记住。
- **预览工作区文件**：桌面端右侧文件面板中单击文件即可查看内容（双击仍然把路径插入输入框）。文本文件显示行号并按扩展名高亮，Markdown 可以在渲染预览和源码之间切换，常见图片格式直接显示；超过 512 KB 的文本只显示开头部分，二进制文件和超过 8 MB 的图片会给出提示。预览窗口可以复制内容、复制路径、把路径插入输入框或重新读取。私钥（`id_ed25519` 等）、`.env`、`*.pem`/`*.key`、`.netrc` 这类可能包含凭据的文件，需要先确认「仍然显示」才会读取。
- **协议 1.7**（向后兼容）：新增 `workspace.readFile`，读取工作区中的一个文件（只能访问工作区内的路径）。旧版 Host 上，预览窗口提示需要更新 Pier。
- **文件标签**：从文件面板双击文件（或点击行尾按钮、预览窗口中的「插入路径」）后，输入框中插入的不再是纯文本路径，而是显示文件名的标签：点击标签打开文件预览，悬停可查看完整路径；可以用标签上的 × 或退格键整体删除，和文字一样可以在任意位置插入、换行。发送时标签会替换为相对工作区的路径，Agent 收到的内容与之前一致；草稿切换会话后仍然保留标签。
- **内置终端**：桌面端可以直接打开终端，不必再切换到系统终端。点会话标题栏（以及工作区首页、新建会话页右上角）的终端按钮或按 Ctrl+`（macOS 上同样是 Ctrl+`）打开底部终端面板，新终端在当前工作区目录中启动；文件面板中目录行尾的终端按钮可以直接在该目录打开终端。支持多个终端标签、拖动调整面板高度（双击恢复默认）、清屏，链接可以点击在浏览器中打开；Linux / Windows 上用 Ctrl+Shift+C / V 复制粘贴，macOS 上用 ⌘C / ⌘V，⌘K 清屏。隐藏面板或切换会话时终端继续运行，关闭标签才会结束进程；在终端里执行 `exit` 会关闭标签，非零退出码会保留输出供查看。终端使用用户的默认 shell（macOS / Linux 上作为登录 shell 启动，Windows 上为 PowerShell），只在本机运行，不会经过 Pier Host，也不会暴露给手机端。

### 变更

- **个人中心只列出已配置的分组**：「分组与令牌」默认只显示已配置到本地的分组，不再一次列出账号的全部分组；点右上角「添加分组」从下拉框中选择要使用的分组，加入列表后再选择令牌并「配置到本地」。还没配置的分组可以点 × 移除。

## v0.2.4 — 2026-09-29

新增云链API 个人中心与一键登录、斜杠命令、右侧文件面板和删除会话，自动识别中转模型的推理等能力，并改用 Bun 管理依赖。

### 新增

- **个人中心**：「设置」最上方新增「账号 → 个人中心」，直连云链API：
  - 在 Pier 中直接用账号密码登录（支持两步验证）或注册（支持邮箱验证码和邀请码）；用 GitHub、LinuxDO 等第三方账号登录的用户可以用系统访问令牌登录。「忘记密码」「在网页上注册」会在浏览器中打开对应页面。
  - 登录后显示当前余额、历史消耗和请求次数（按站点设置显示为美元、人民币或额度），「充值」「网页控制台」「管理令牌」在浏览器中打开对应页面。
  - 按分组列出令牌和倍率。选择分组的令牌（或直接新建令牌），点「配置到本地」，Pier 会读取这个令牌可用的全部模型，保存为服务商「云链API · 分组」；再次点击「更新本地配置」会同步新的模型，已有的模型设置保留。「模型与服务商」中这些服务商显示「个人中心」按钮。
  - 登录由 Pier Host 保存（`~/.pier/account.json`，仅当前用户可读），重启后仍然有效，30 天后需要重新登录；只保存站点的刷新凭据，不保存密码，访问令牌过期时自动续期。令牌密钥不会显示在界面上。
- **自动识别模型能力**：从云链API、NewAPI 或自定义接口导入的模型，不再全部被当成不支持思考的普通模型。Pier 会按 pi 内置的模型目录识别推理、图片输入、上下文和最大输出长度，所以 `claude-opus-4-5`、`gpt-5`、`gemini-2.5-pro` 这类模型导入后，模型选择器里就会显示思考等级，不需要再手动勾选「推理」。带厂商前缀、日期后缀、`4.5`/`4-5` 等不同写法，以及 `-thinking` 变体都能识别；目录中没有的模型只按常见推理系列的名称推断，其他保持原样。已经配置过的服务商会在 Pier 启动时自动补全缺少的设置；手动修改过的设置保持不变，取消勾选的「推理」也会被记住。修改服务商配置后，已打开的会话会立即使用新的模型设置，不需要重新选择模型；模型刚变成推理模型时，思考等级会从「不思考」改为默认等级。
- **协议 1.6**（向后兼容）：新增仅限本地连接的 `account.status` / `login` / `verify` / `sendCode` / `register` / `overview` / `createToken` / `useToken` / `logout`。新增 `session.delete`（删除会话并把文件移到 Pier 回收站），`session.closed` 新增 `reason: "deleted"`。`provider.probeModels` 返回的模型会带上 pi 模型目录中的能力信息。NewAPI 登录会话的访问令牌过期后也会自动续期，不再在 15 分钟后失效。
- **斜杠命令**：桌面端和手机端的输入框中输入 `/` 会弹出命令菜单，可以按名称或说明过滤，桌面端支持 ↑↓ 选择、Enter 执行、Tab 补全、Esc 关闭。菜单列出 Pier 内置命令和当前会话可用的 pi 命令（扩展命令、提示词模板与 `/skill:<名称>`）：
  - `/new` 新建会话、`/model` 切换模型、`/thinking` 设置思考等级、`/compact [摘要要点]` 压缩上下文、`/fork` 从历史消息分叉、`/name <名称>` 重命名会话、`/reload` 重新加载扩展、skills、提示词模板与上下文文件。`/model`、`/thinking`、`/fork` 在菜单里直接列出可选的模型、等级和历史消息。
  - 扩展命令在 Agent 运行时也可以执行；需要回答对话框的扩展命令不再让输入框一直等待。
  - 无法识别的命令会提示“未知命令”，不再原样发给模型；`/usr/bin` 这类路径仍按普通消息发送。
- **云链API 服务商**：「设置 → 模型与服务商 → 添加服务商」的第一项改为内置的「云链API」（`api.yunnet.top`），点「浏览器登录」即可：Pier 在浏览器中打开云链API 的授权页面，用任意方式登录并点击「授权」后，自动保存令牌和全部可用模型，不需要填写站点地址、选择令牌或确认表单。已添加后，在已配置列表中点「重新登录」可以更新令牌和模型列表，已有的模型设置会保留。没有可用模型时，首页提示也提供「登录云链API」。
- **缓存命中率**：桌面端会话底部状态栏新增「缓存命中 xx%」，按本会话累计的缓存读取 token ÷ 输入 token（含缓存读写）计算；悬停可查看缓存读取、缓存写入与输入合计。模型未返回任何输入用量时不显示。
- **右侧文件面板**：桌面端会话标题栏右上角（以及工作区首页和新建会话页右上角）新增「文件」按钮，也可以按 Ctrl/⌘+Shift+E，在右侧打开当前工作区的文件树：目录在前，按需逐级展开，不显示 `.git` 等版本库目录；悬停可查看大小与修改时间。双击文件或点击行尾按钮可以把相对路径插入到输入框的光标处，也可以复制相对路径。Agent 运行结束、窗口重新获得焦点或点击刷新时自动更新。面板宽度可以拖动左边缘调整（双击恢复默认），开关状态和宽度会被记住。
- **删除会话**：桌面端侧栏中鼠标悬停在会话上会出现删除按钮，再点一次确认即可删除；会话标题栏的「更多操作」菜单也新增「删除会话」。手机端可以在会话列表中长按会话，或在会话页的菜单中删除。正在运行的会话会先中止再删除。会话文件不会被直接抹掉，而是移到电脑上的 `~/.pier/trash/sessions`，需要时可以手动移回 pi 的会话目录恢复。
- **协议 1.5**（向后兼容）：新增 `session.commands`（列出会话的斜杠命令）、`session.reload`，以及列出工作区目录的 `workspace.files`（只能访问工作区内的路径）。旧版 Host 上，客户端仍提供内置命令，其他命令照常发送；文件面板提示需要更新。

### 变更

- **新建会话先选工作区**：桌面端点「新建会话」（侧栏按钮、工作区行的 `+`、工作区首页按钮或 `/new`）会打开空白的新对话页面，显示「我们应该在〈工作区〉中做些什么？」；输入框下方的工作区芯片可以切换工作区或添加新的工作区，也可以直接调整该工作区的审批策略、附加图片。发送第一条消息时才在所选工作区中创建会话并切换过去继续对话，只打开不发送不会留下空会话；草稿在离开页面后保留。
- **不再单独发布 Pier Host**：Pier Host 已内置在桌面端安装包中，无需单独下载安装，GitHub Release 不再附带 `pier-host-v<版本>-<系统>-<架构>` 压缩包。发版流水线改为直接冒烟测试各平台安装包内置的 sidecar。需要单独运行 Host 时，可以按 README 用 `bun run build:sidecar` 从源码构建。
- **改用 Bun 管理依赖**：仓库从 pnpm 换成 Bun workspaces（`bun.lock`，`bunfig.toml` 保持 hoisted 布局以兼容 Expo/Metro），开发只需 Node 与 Bun，不再需要 pnpm / Corepack；README 中的命令相应改为 `bun install`、`bun run …`。CI 与发版流水线同步改用 Bun，Bun 版本由 `package.json` 的 `packageManager` 固定。
- **移除通用的「NewAPI 登录」**：「添加服务商」不再单独提供 NewAPI 登录按钮和账号密码 / 访问令牌登录对话框，改为上面的「云链API」服务商；其他 NewAPI 中转站可以用「自定义接口」填写 Base URL 和 API Key。Host 的 `newapi.*` 协议方法保持不变。

### 修复

- **macOS 程序坞图标偏小**：桌面端图标按 macOS 图标网格重新生成（1024 画布中 824 的圆角方块，四周留 100 像素透明边距）。此前图标几乎铺满画布，macOS 26 会把它当成不规范的图标，缩小后放进浅灰色底板里，看起来比其他应用的图标小一圈。Windows 图标保持不变。
- **发送消息后回复区域一片空白**：模型开始回复但还没有输出可见内容时（尤其是开启思考、服务商只回传空的或加密的思考块时），桌面端和手机端的「正在输入」动画会立刻消失，直到正文开始输出前都是空白。现在正在进行的思考块会显示为「思考中…」，回复还没有任何可见内容时继续显示「正在输入」动画。

## v0.2.3 — 2026-09-29

新增 NewAPI 浏览器授权登录，macOS 安装包改为本机签名，不再提示“已损坏”。

### 新增

- **NewAPI 浏览器授权**：「NewAPI 登录」新增并默认选中「浏览器授权」。填写站点地址后，Pier 会在浏览器中打开站点的授权页面，用站点支持的任意方式登录（包括 GitHub、LinuxDO、Passkey 等第三方或无密码登录）并确认后，站点为 Pier 新建一个令牌，Pier 自动读取模型并预填自定义接口，全程不需要在 Pier 中输入密码或复制访问令牌。需要站点使用支持「应用授权」的 NewAPI 并由管理员开启；其他站点仍可用账号密码或访问令牌登录。对话框会记住上次使用的站点地址。
- **协议 1.4**（向后兼容）：新增仅限本地连接的 `newapi.authorizeStart` / `authorizeWait` / `authorizeCancel`（RFC 8252 回环重定向 + PKCE）。

### 修复

- **macOS 安装包不再提示“已损坏”**：macOS 安装包之前完全未签名，从浏览器下载后打开会被误报为“已损坏，无法打开”，只能在终端里移除隔离属性。现在安装包改为本机签名（ad-hoc，含 Pier Host sidecar，启用 hardened runtime 并授予 Bun 所需的 JIT 权限），首次打开时 macOS 改为提示“无法验证开发者”，在「系统设置 → 隐私与安全性」中点「仍要打开」即可。发版流水线会校验签名并在签名后的 `.app` 中冒烟测试 sidecar。仍未进行 Apple 公证。
- **可以移除 `models.json` 中的密钥**：内置服务商（如 DeepSeek）的密钥直接写在 `models.json` 的 `apiKey` 里（明文或 `!命令`）时，「设置 → 模型与服务商」之前既不显示「删除」也不显示「移除密钥」，只能手动改文件。现在这类服务商也会显示「移除密钥」，Pier 只删除该条目的 `apiKey`，其他覆盖配置保留；条目只剩名称时整项删除。`provider.logout` 在没有 `auth.json` 凭据时会删除这类密钥，环境变量不受影响。

## v0.2.2 — 2026-09-29

支持直接登录 NewAPI 中转站配置模型，桌面端新增设置界面，并开始提供 Android 安装包。

### 新增

- **NewAPI 登录**：「设置 → 模型与服务商」新增「NewAPI 登录」。填写站点地址，用账号密码（支持两步验证和站点开启的登录密码加密）或系统访问令牌登录后，选择一个令牌或直接新建（可选分组），Pier 会读取它可用的模型列表，并预填名称、Base URL 和全部模型，确认后保存为自定义接口。令牌密钥由 Pier Host 直接读取并保存到 pi 的 `auth.json`，不会出现在界面或协议消息中；登录会话只在内存中保留，关闭对话框即退出。同时兼容新版本的访问令牌登录和旧版本的 Cookie 会话。
- **协议 1.3**（向后兼容）：新增仅限本地连接的 `newapi.login` / `verify` / `createToken` / `useToken` / `close`；`provider.saveCustom` 与 `provider.probeModels` 新增 `apiKeyRef` 参数。
- **Android 安装包**：GitHub Release 开始附带签名的 Android APK（`pier-mobile-v<版本>-android.apk`，包含 arm64-v8a / armeabi-v7a / x86_64），可以直接下载安装手机端；之后的版本可以覆盖升级。

### 变更

- **桌面端新增设置界面**：侧边栏左下角的连接状态、模型、手机、更新和退出按钮合并为一个「设置」入口（保留连接状态点，有更新或缺少模型时显示提示点）。设置界面左侧为可搜索的分组导航，右侧为卡片式设置页：
  - 常规：Host 连接状态、版本、配置目录、本地地址，重启 Host 与退出 Pier；
  - 模型与服务商、手机与远程：原先的对话框移入设置页；
  - 工作区：集中管理各工作区的工具审批策略，添加或移除工作区；
  - 日志、关于与更新：Host 日志与软件更新（托盘菜单「检查更新…」会直接打开此页）。

  按 Esc 或「返回应用」回到会话界面。

## v0.2.1 — 2026-09-29

直接在 Pier 里配置模型，并支持桌面端自动更新。

### 新增

- **在 Pier 中直接配置模型**：不再需要另外安装 pi 命令行。桌面端新增「模型与服务商」面板（入口在侧边栏、会话的模型选择器；没有可用模型时，首页也会提示），可以：
  - 登录 pi 内置的任一服务商，支持 API Key 和账号登录（包括浏览器授权、设备码和粘贴授权码）；
  - 添加、编辑、删除 OpenAI / Anthropic / Gemini 兼容的自定义接口（中转站、公司网关、Ollama / LM Studio / vLLM 等），并可一键从接口获取模型列表；
  - 设置新会话的默认模型，移除已保存的凭据。

  凭据保存在 pi 的 `auth.json`，自定义接口写入 `models.json`（只改动编辑的那一项；文件含注释时会先备份为 `models.json.bak`，pi 无法加载时自动回滚），终端里的 `pi` 看到的是同一份配置。这些操作只能在电脑本机的桌面端进行，已配对的手机无权调用，接口返回的内容中也不包含任何密钥。
- **协议 1.2**（向后兼容）：新增仅限本地连接的 `provider.list` / `login` / `loginRespond` / `loginCancel` / `logout` / `saveCustom` / `removeCustom` / `probeModels` 与 `model.setDefault`，新增 Host 事件 `provider.changed`，以及只发给发起登录的连接的 `auth.*` 登录事件。
- **桌面端自动更新**（Tauri updater）：Pier 启动后不久以及之后每 6 小时检查一次最新的 GitHub Release（可关闭）。有新版本时显示提示和角标，可以在「软件更新」对话框中查看更新说明、下载进度并安装（入口：侧边栏角标、托盘菜单，或 Pier Host 面板中的「检查更新」）。
  - 更新包使用 Pier 的更新密钥签名，安装前会校验签名，被篡改或未签名的更新包会被拒绝。
  - 安装前先停止 Pier Host（如果还有正在运行或等待审批的会话，对话框会提醒），安装完成后自动重启 Pier；安装失败时 Host 会重新启动。
  - 支持 Linux 的 AppImage 和 deb、macOS 的应用包以及 Windows 的 NSIS 安装包。开发版会提示无法更新。

### 发布文件

- 桌面端：`pier-desktop-v0.2.1-linux-x64.deb` 与 `.AppImage`、`pier-desktop-v0.2.1-darwin-arm64.dmg`、`pier-desktop-v0.2.1-darwin-x64.dmg`、`pier-desktop-v0.2.1-windows-x64.setup.exe`。每个安装包都内置 Pier Host 和 pi 的运行时资源。
- 自动更新：各平台的更新包（macOS 为 `.app.tar.gz`）、对应的 `.sig` 签名，以及 `latest.json`。
- 独立 Host：`pier-host-v0.2.1-<系统>-<架构>` 压缩包，覆盖 linux-x64、linux-arm64、darwin-arm64、darwin-x64、windows-x64。
- `SHA256SUMS.txt` 列出所有文件的校验和。
- 手机 App 暂未作为发布文件提供，请参考 README 用 Expo 从源码运行。

### 已知限制

- v0.2.0 及更早的版本没有自动更新功能，需要手动安装一次 v0.2.1，之后的版本即可自动更新。
- 自动更新目前只在 Linux AppImage 上完整验证过，macOS 和 Windows 尚未在真机上验证。
- 账号登录（OAuth）尚未用真实账号在各平台上验证过。
- 安装包仍未做代码签名：macOS 需要移除隔离属性（`xattr -dr com.apple.quarantine /Applications/Pier.app`）或在「系统设置 → 隐私与安全性」中允许打开；Windows 的 SmartScreen 可能会要求确认。

## v0.2.0 — 2026-09-29

The mobile app and LAN remote access (milestone M3): pair a phone with the desktop by scanning a QR code, then watch and drive agents, answer approvals, and steer or abort runs from the phone over an end-to-end encrypted connection.

### Added

- **Remote access** in the Pier Host (off by default): an encrypted listener on port 7433 (configurable) for the local network and Tailscale / WireGuard, plus mDNS advertising (`_pier._tcp`). See `docs/security.md`.
  - `@pier/crypto`: Noise XX (pairing) and IK (reconnects) over X25519 / ChaCha20-Poly1305 / SHA-256 in pure JS, verified against the cacophony test vectors; encrypted channel frames; pairing links; a channel benchmark.
  - Pairing uses a single-use code (valid for 5 minutes) in a QR code that also pins the host key, and requires confirmation on the desktop. Paired devices are stored in `~/.pier/devices.json`; revoking one disconnects it immediately.
  - An audit log (`~/.pier/audit.log`) records what remote devices did (connections, pairing, prompts by length only, approvals).
  - New host flags: `--no-remote`, `--remote-port`, `--remote-address`, `--no-mdns`.
- **Protocol 1.1** (backwards compatible): `remote.status` / `remote.configure`, `pairing.start` / `cancel` / `respond`, `device.list` / `rename` / `revoke`, local-only host events for pairing and devices, a `session.activity` host event, and `pendingUi` counts in session summaries.
- **`@pier/client`**: `SecureWebSocket` / `createSecureSocketFactory` (encrypted transport with address fallback), `pairWithHost`, terminal close codes (a revoked device stops reconnecting), `reconnectNow()`, and an optional heartbeat.
- **Desktop app**: a "手机" panel to turn remote access on, show the pairing QR code, confirm pairing requests, and rename or revoke devices.
- **Mobile app** (`apps/mobile`, Expo SDK 57): scan or paste a pairing link (or open a `pier://pair` link), multiple computers, session lists with running / needs-approval badges, streaming chat with tool cards and diffs, approvals and extension dialogs, steer / follow-up / abort, image attachments, model and thinking-level switching, compaction, automatic reconnect with replay, revocation handling, and a crypto benchmark (Spike 3).
- `pier-cli`: `/remote`, `/pair`, `/devices`, `/revoke`.
- `pnpm faux-host --remote` for mobile UI work without real credentials.

### Changed

- The shared `ChatController` moved from the desktop app into `@pier/chat-state`.
- React is pinned to 19.2.3 across the workspace (the version Expo SDK 57 uses).
- **Desktop**: the model and thinking-level pickers are merged into one control in the session header, and the composer has a permission-mode (approval policy) picker that applies to the whole workspace.
- **Desktop UI refresh**: a more modern look across the app, in both dark and light themes.
  - New design tokens with the icon's blue-to-teal brand gradient, softer surfaces, rounded corners, and a floating main panel next to the sidebar.
  - SVG icons replace text glyphs throughout: sidebar, tool cards, menus, banners, toasts, and dialogs.
  - The sidebar has a brand header, a "New session" button, a folder tree with guide lines, and a host-status footer.
  - User messages appear as chat bubbles. Tool cards show per-tool icons and status badges with icons, and code blocks show their language label.
  - The composer has a toolbar with an image-attach button, the permission-mode picker, and a round send/stop button. The status bar shows a context-usage meter.
  - Approval cards, dropdowns, and modals are restyled with icons, blurred backdrops, and short enter animations. Animations respect `prefers-reduced-motion`.
  - The welcome screen and workspace home were redesigned with step cards, a workspace header, and a recent-sessions list.

### Release assets

- Desktop app: `pier-desktop-v0.2.0-linux-x64.deb` and `.AppImage`, `pier-desktop-v0.2.0-darwin-arm64.dmg`, `pier-desktop-v0.2.0-darwin-x64.dmg`, and `pier-desktop-v0.2.0-windows-x64.setup.exe`. Each bundle includes the Pier Host sidecar and pi's runtime assets.
- Standalone host: `pier-host-v0.2.0-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64.
- `SHA256SUMS.txt` lists the checksums of all assets.
- The mobile app is not attached as a release asset yet; run it from source with Expo (see the README).

### Known limitations

- The desktop bundles are still not code-signed; see the v0.1.0 notes for the macOS and Windows workarounds.
- The mobile app has been verified with its web build and the Hermes bundles for Android and iOS, but not yet on real phones; there are no store builds yet.
- The phone only reaches the desktop directly (same network or tailnet). Relay access and push notifications arrive in M5.

## v0.1.0 — 2026-09-28

The desktop app (milestone M2): run pi coding agents from a native window, with approvals, tool output, and diffs, without opening a terminal. The Pier Host keeps running in the tray when the window is closed.

### Added

- **Desktop app** (`apps/desktop`, milestone M2): a Tauri 2 shell that bundles the Pier Host as a sidecar.
  - The Rust side starts the host, reads its `pier.ready` line, restarts it after crashes (with backoff, giving up after repeated fast failures), keeps a log buffer, and shuts it down gracefully on quit. The host also exits when the shell dies.
  - Closing the window hides Pier in the system tray; agents keep running. A second launch focuses the running instance.
  - The React UI covers workspaces (add, remove, approval policy), sessions (create, open, rename, fork, close), streaming chat with Markdown and code highlighting, collapsible thinking, tool cards (terminal output, edit diffs, file previews), approval and dialog cards, steer / follow-up / abort, image attachments, model and thinking-level switching, context compaction, token and cost totals, and a host log viewer.
- **`@pier/chat-state`**: a pure reducer from snapshots and events to a chat view model, shared by the desktop and (later) mobile apps, with a transcript builder that folds tool results into their calls.
- `pnpm faux-host`: a development host backed by pi's faux model for UI work without real credentials.
- CI builds the desktop shell on Linux, macOS, and Windows; releases attach unsigned desktop bundles.

### Release assets

- Desktop app: `pier-desktop-v0.1.0-linux-x64.deb` and `.AppImage`, `pier-desktop-v0.1.0-darwin-arm64.dmg`, `pier-desktop-v0.1.0-darwin-x64.dmg`, and `pier-desktop-v0.1.0-windows-x64.setup.exe`. Each bundle includes the Pier Host sidecar and pi's runtime assets.
- Standalone host: `pier-host-v0.1.0-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64, as in v0.0.1.
- `SHA256SUMS.txt` lists the checksums of all assets.

Models and credentials come from pi's configuration (`~/.pi/agent`). If no model is available yet, run `pi` once in a terminal and log in.

### Known limitations

- The bundles are not code-signed. On macOS, remove the quarantine attribute (`xattr -dr com.apple.quarantine /Applications/Pier.app`) or allow the app in System Settings → Privacy & Security. On Windows, SmartScreen may ask you to confirm the installer.
- The desktop app has been verified end to end on Linux. The macOS and Windows bundles are built and checked in CI but have not yet been tested on real machines.
- There is no auto-update, autostart, desktop notifications, or session search yet.
- Only local connections are supported. Remote access, pairing, and the mobile app arrive in M3.

## v0.0.1 — 2026-09-28

First developer preview: the Pier Host core (milestones M0 and M1). There is no desktop or mobile app yet; you drive the Host with the `pier-cli` debug client.

### Added

- **Pier Host** (`packages/host`), built on the pi SDK 0.87.1 and reusing pi's configuration (`~/.pi/agent`):
  - workspaces with per-workspace approval policies (`ask` / `smart` / `auto`), stored in `~/.pier/config.json`;
  - an active session pool (create, open, fork, rename, close, idle eviction) that is compatible with `pi --resume`;
  - an extension UI bridge (select / confirm / input / editor, notifications, status, widgets) where the first client to answer wins;
  - the built-in `pier-approval` extension (read-only whitelist, dangerous-command detection, allow once / for this session / deny with a reason);
  - a per-session event log with replay-or-snapshot resume after disconnects, and optional merging of streaming deltas;
  - session file locks and detection of external writes to session files;
  - a local WebSocket gateway on `127.0.0.1` with token authentication and an Origin allowlist.
- **Protocol v1.0** (`packages/protocol`, documented in `docs/protocol.md`).
- **Client library and `pier-cli`** (`packages/client`) with automatic reconnect and seq-based resume.
- **Single-file sidecar builds** made with `bun build --compile`, shipped together with pi's runtime assets.

### Release assets

`pier-host-v0.0.1-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64. Each archive contains the `pier-host` executable plus the pi assets it needs next to it; `SHA256SUMS.txt` lists the checksums. The binaries are not code-signed. On macOS, remove the quarantine attribute (`xattr -d com.apple.quarantine pier-host`) or allow the binary in System Settings.

### Known limitations

- Only local connections are supported. Remote access, pairing, and the mobile app arrive in M3.
- The desktop app (M2) is not included yet.
