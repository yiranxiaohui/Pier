# Pier 开发计划

> Pier：编码 Agent 的跨设备工作台。通过桌面端（Tauri）与手机端（Expo / React Native）统一管理多台电脑上的工作区与会话，查看进度、发送指令和审批操作；Agent 常驻在各自的电脑上运行。支持内置的 [pi](https://github.com/earendil-works/pi)，以及电脑上安装的 Claude Code 与 Codex。
>
> 本文档是项目的总体规划与里程碑，随开发进度持续更新。
>
> **当前进度（2026-09-28）**：M0–M2 已完成；M3 手机端 MVP（局域网）的代码已完成：加密通道、Host 远程访问与配对、桌面配对与设备管理、Expo App，并在 Linux 上用编译后的 sidecar 与 Web 版 App 端到端验证。待办：iOS / Android 真机验证（含 Spike 3 真机数据）、macOS / Windows 安装包真机验证。下一步：M4 体验完善。M5 的中继与 P2P 已实现（`apps/relay`，私有 / 开放两种模式，经中继建立 WebRTC 打洞并无缝切换），推送待做。

## 1. 目标与非目标

### 目标

- 桌面端常驻一个 **Pier Host** 守护进程，通过 pi SDK 管理多个工作区、多个会话。
- 桌面 UI（Tauri）和手机 App（Expo）都是 Host 的**客户端**，使用同一套协议。
- 手机可以：查看会话、流式查看 Agent 输出、发送消息 / 引导（steer）/ 追加（follow-up）/ 中止、审批高危工具调用、接收通知。
- 连接方式逐步演进：局域网直连 → 自建中继（端到端加密）；Tailscale / WireGuard 天然可用。
- 安全优先：Host 等同于桌面的远程执行入口，必须具备设备配对、加密、审批和吊销能力。

### 非目标（首个版本）

- 多用户 / 团队协作。
- 在手机或云端运行 Agent（Agent 始终运行在桌面）。
- 自研模型接入层：模型、凭据、settings 全部复用 pi 的配置体系。

## 2. 总体架构

```
┌───────────────────────── 桌面机器 ─────────────────────────┐
│                                                            │
│  Tauri 桌面应用 (Rust + React)                              │
│   ├─ 负责 sidecar 生命周期、托盘、开机自启、单实例           │
│   └─ WebView UI ──WS(127.0.0.1 + 本地 token)──┐            │
│                                               ▼            │
│  Pier Host sidecar (TypeScript, pi SDK)                    │
│   ├─ WorkspaceManager / SessionManager 池                  │
│   ├─ UI 桥接 (ExtensionUIContext → 协议 ui.request)         │
│   ├─ pier-approval 内置扩展（工具审批策略）                  │
│   ├─ EventLog（每会话 seq + 环形缓冲，断线重放）             │
│   ├─ Gateway：WebSocket + 配对 + 设备鉴权 + E2E 加密          │
│   └─ mDNS 广播 (_pier._tcp)                                 │
│                    ▲                          ▲            │
└────────────────────┼──────────────────────────┼────────────┘
          局域网 / Tailscale 直连          出站长连接
                     │                          │
                     │                 ┌────────┴────────┐
                     │                 │  Pier Relay     │  (M5，仅转发密文
                     │                 │  + 推送代理     │   + 推送令牌)
                     │                 └────────┬────────┘
                     ▼                          ▼
              ┌──────────────────────────────────────┐
              │ Pier Mobile (Expo / React Native)     │
              └──────────────────────────────────────┘
```

关键决策：

| 决策 | 选择 | 理由 |
|---|---|---|
| pi 集成方式 | **SDK 进程内**（`createAgentSession` / `AgentSessionRuntime`） | 完整 API、可注入 `uiContext`、内置扩展、单进程多会话；需要隔离时再退回 RPC 子进程 |
| Host 与 UI 分离 | Host 作为 Tauri **sidecar** 独立进程 | 窗口关闭后 Agent 继续运行、手机仍可连接；Host 崩溃可由 Rust 侧重启 |
| 桌面 UI 与 Host 通信 | 与手机**同一协议**，走 `127.0.0.1` WebSocket | 一套协议、一套客户端库；本地连接使用 Tauri 注入的随机 token，不做 E2E |
| 手机端 | Expo（开发构建 / EAS），非 Expo Go | 需要原生模块（相机、安全存储、通知、加密） |
| 配置与凭据 | 复用 pi 的 `~/.pi/agent`（模型、认证、settings、会话目录） | 与 pi CLI 互通，可在终端 `pi --resume` 同一会话 |

## 3. 技术栈

| 层 | 技术 |
|---|---|
| Monorepo | Bun workspaces（`bunfig.toml` 设 `linker = "hoisted"` 以兼容 Expo/Metro），TypeScript strict |
| 代码规范 | Biome（lint + format）、Vitest；Rust 侧 `cargo fmt` + `clippy` |
| Host | Node 22+（开发） / 打包为单文件 sidecar；`@earendil-works/pi-coding-agent`、`ws`、`zod`、`bonjour-service`（mDNS） |
| 协议 | `packages/protocol`：zod schema + 推导出的 TS 类型，Host 与客户端共享 |
| 加密 | `@noble/curves`、`@noble/ciphers`、`@noble/hashes`（纯 JS，RN 与 Node 通用）；握手采用 Noise 模式（配对用 XX，之后用 IK） |
| 桌面 | Tauri 2 + React + Vite + Tailwind；插件：shell（sidecar）、single-instance、autostart、updater、notification |
| 手机 | Expo（最新 SDK）+ expo-router；expo-camera（扫码）、expo-secure-store（设备密钥）、expo-notifications、expo-image-picker、react-native-markdown-display |
| 中继（M5） | 自托管 Node 服务（`apps/relay`，ws + 内置 STUN，Docker 镜像）：Cloudflare Workers 无法提供 P2P 打洞所需的 UDP STUN，国内访问也不稳定。P2P：Host 端 werift（纯 TS，不影响单文件 sidecar），手机端 react-native-webrtc |
| CI | GitHub Actions：lint / typecheck / test；Tauri 多平台构建；Android APK（Gradle）；iOS 待接入 EAS Build |

## 4. 仓库结构（规划）

```
Pier/
├─ apps/
│  ├─ desktop/            # Tauri 2：src-tauri (Rust) + src (React)
│  ├─ mobile/             # Expo App（SDK 57，expo-router）
│  └─ relay/              # M5：中继（只转发密文）+ STUN；推送代理待做
├─ packages/
│  ├─ host/               # Pier Host（pi SDK、Gateway、EventLog、UI 桥接）
│  ├─ protocol/           # 协议 schema 与类型、版本号
│  ├─ client/             # 通用客户端：连接、握手、重连、请求关联、seq 补发
│  ├─ crypto/             # 配对、Noise 握手、帧加解密
│  └─ chat-state/         # 事件 → 视图模型的 reducer（桌面与手机共用的纯逻辑）
├─ docs/
│  ├─ PLAN.md             # 本文件
│  ├─ protocol.md         # 协议详细定义（M1 产出）
│  └─ security.md         # 威胁模型与配对流程（M3 产出）
├─ biome.json
├─ bunfig.toml
└─ package.json
```

> UI 组件无法在 React DOM 与 React Native 之间直接共享；共享范围限定在 `protocol`、`client`、`crypto`、`chat-state` 等纯逻辑包。

## 5. Host 设计要点

### 5.1 工作区与会话

- **工作区（Workspace）**：用户在 Pier 中登记的目录（`cwd`），保存在 `~/.pier/config.json`（Pier 自身配置，与 pi 配置分开）。
- **会话列表**：`SessionManager.list(cwd)`；打开：`SessionManager.open(path)`；新建：`SessionManager.create(cwd)`。
- **活跃会话池**：`sessionId → AgentSession`，按需加载，空闲超时（如 30 分钟无订阅且非运行中）后 `dispose()`。
- 每个活跃会话调用 `session.bindExtensions({ uiContext, mode, abortHandler, shutdownHandler, onError })`，其中 `uiContext` 由 Host 实现并桥接到协议。
- 使用 `AgentSessionRuntime` 处理 new / switch / fork，替换后**重新绑定订阅**（参见 pi `examples/sdk/13-session-runtime.ts`）。
- **与 pi CLI 并发**：同一会话文件被 CLI 与 Pier 同时写入会冲突，Host 对打开的会话加文件锁或检测后提示只读。

### 5.2 UI 桥接（ExtensionUIContext）

- 实现 `select` / `confirm` / `input` / `editor`：生成 `requestId`，向该会话所有订阅者广播 `ui.request`，**先到先得**，其余客户端收到 `ui.resolved`；支持超时。
- 实现 `notify` / `setStatus` / `setWidget` / `setTitle` / `setEditorText`：转为 fire-and-forget 事件。
- 其余 TUI 专属方法（`custom`、`setFooter`、主题等）按 pi RPC 模式的方式降级为 no-op。
- 无任何客户端在线时：对话框请求进入待处理队列并触发推送通知；超时后按策略默认拒绝。

### 5.3 内置审批扩展 `pier-approval`

- 以 inline extension 形式注入，监听 `tool_call`。
- 每个工作区一个策略：
  - `ask`：`bash`、`write`、`edit` 全部需审批；
  - `smart`（默认）：只读命令白名单直接放行，危险模式（`rm -rf`、`sudo`、`git push --force` 等）和工作区外路径写入需审批；
  - `auto`：全部放行（显式开启并高亮警告）。
- 审批选项：允许一次 / 本会话内同类允许 / 拒绝（可附理由，作为 `block.reason` 返回给模型）。

### 5.4 EventLog 与断线重放

- 每个会话维护单调递增的 `seq` 和内存环形缓冲（如最近 5000 条事件）。
- 客户端订阅时携带 `sinceSeq`：
  - 在缓冲范围内 → 补发增量；
  - 超出范围或首次订阅 → 先发 `session.snapshot`（完整消息 + 进行中的 partial 消息 + 待处理 UI 请求 + 队列状态），再发增量。
- `message_update` 文本增量对远程客户端按约 50ms 合并，降低手机流量与渲染压力。

## 6. 协议草案（详细定义在 M1 写入 `docs/protocol.md`）

传输：WebSocket，JSON 帧；远程连接在握手后全部为加密帧 `{ "t": "enc", "n": <nonce>, "c": <ciphertext> }`。

```jsonc
// 请求 / 响应
{ "type": "req", "id": "r1", "method": "session.prompt", "params": { "sessionId": "...", "text": "..." } }
{ "type": "res", "id": "r1", "ok": true, "result": {} }
{ "type": "res", "id": "r1", "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }

// 事件
{ "type": "evt", "sessionId": "...", "seq": 42, "event": { "type": "message_update", ... } }
```

方法（初版）：

| 分组 | 方法 |
|---|---|
| host | `host.hello`（协议版本协商）、`host.info` |
| workspace | `workspace.list` / `add` / `remove` / `setPolicy` |
| session | `session.list` / `create` / `open` / `close` / `fork` / `rename` / `subscribe` / `unsubscribe` / `snapshot` |
| 运行 | `session.prompt`（含 `images`、`streamingBehavior`）/ `steer` / `followUp` / `abort` / `compact` |
| 模型 | `model.list` / `model.set` / `thinking.set` |
| UI | `ui.respond` |
| 设备 | `device.list` / `device.revoke` / `pairing.start`（仅本地桌面 UI 可调用） |

事件：透传 pi 会话事件（`message_update`、`message_end`、`tool_execution_*`、`agent_start`、`agent_end`、`agent_settled`、`queue_update`、`compaction_*`、重试相关），并新增 Pier 事件：`ui.request`、`ui.resolved`、`session.status`、`session.snapshot`、`host.notice`。

版本策略：`protocol` 包导出 `PROTOCOL_VERSION`；`host.hello` 协商，主版本不一致时拒绝连接并提示升级。

## 7. 安全设计

- **威胁模型**：任何能与 Host 建立会话的设备都能执行任意命令；因此网络层必须视为不可信（包括局域网和中继）。
- **设备身份**：每台手机生成 Ed25519 / X25519 密钥对，私钥存 `expo-secure-store`；Host 同样持有长期密钥，保存在 `~/.pier/`（权限 0600），后续可迁移到系统钥匙串。
- **配对流程**：
  1. 桌面 UI 调用 `pairing.start`，Host 生成一次性配对码（有效期 5 分钟、仅可使用一次）。
  2. 桌面显示二维码：`pier://pair?v=1&host=<hostId>&pk=<hostPubKey>&addr=<ip:port,...>&relay=<url?>&code=<pairingCode>`。
  3. 手机扫码 → Noise XX 握手，校验 Host 公钥与二维码一致 → 提交配对码与设备公钥、设备名。
  4. 桌面弹窗确认"允许 <设备名> 连接" → Host 登记设备。
- **后续连接**：Noise IK（手机已知 Host 公钥），双向认证 + 前向保密；未登记设备一律拒绝。
- **吊销**：桌面设备管理页可吊销，吊销后立即断开现有连接。
- **暴露面**：远程访问默认关闭，需在桌面设置中显式开启；本地 WS 仅监听 `127.0.0.1` 并校验 Tauri 注入的 token 与 Origin。
- **其他**：高危工具默认审批；审计日志记录远程设备发起的 prompt 与审批操作；可选手机端生物识别解锁。

## 8. 连接方式

1. **局域网直连（M3）**：开启远程访问后 Host 监听 `0.0.0.0:<port>`（默认 `7433`，可配置），并广播 mDNS `_pier._tcp`；二维码携带所有候选地址，手机依次尝试。
2. **Tailscale / WireGuard**：无需额外开发，二维码中包含 Tailscale 地址即可。
3. **中继（M5，已实现）**：Host 与手机都主动出站连接中继，中继按 Host 公钥配对转发**密文**，无法解密内容；Host 注册时证明持有私钥，私有模式另需访问令牌。连上后双方在加密通道内交换 WebRTC 信令、借助中继的 STUN 打洞，成功则无缝切换到 P2P 数据通道（同一会话密钥，按 nonce 排序），失败则继续经中继。之后还将承担推送代理（保存设备推送令牌，转发不含敏感内容的通知）。

## 9. 功能清单

### 桌面端（Tauri）

- 托盘常驻、开机自启、单实例、关闭窗口不退出 Host。
- Sidecar 管理：启动、健康检查、崩溃自动重启、日志查看。
- 工作区管理、会话列表（按工作区分组、搜索）、新建 / 重命名 / fork。
- 聊天视图：Markdown + 代码高亮、思考内容折叠、工具调用卡片（bash 输出、edit diff、write 预览）、队列状态、中止按钮。
- 审批对话框、模型与思考等级切换、压缩上下文。
- 设置：远程访问开关、端口、中继地址、审批策略默认值。
- 设备管理：配对二维码、设备列表、吊销。
- 自动更新（Tauri updater）。

### 手机端（Expo）

- 首次引导：扫码配对；支持多个桌面 Host。
- 连接状态指示、自动重连、断线补发。
- 会话列表、聊天视图（流式输出、工具卡片、diff 简化展示）。
- 发送消息 / steer / follow-up / 中止；附图（相机、相册）。
- 审批请求卡片与推送通知（任务完成、需要审批、出错）。
- 可选：生物识别锁、深色模式。

## 10. 里程碑

每个里程碑结束时都要求：CI 通过、`docs/` 同步更新、在独立 worktree 中完成并合并到 `main`。

### M0 脚手架与技术验证

- [x] monorepo（最初用 pnpm，现为 Bun workspaces）、Biome、Vitest、TypeScript 项目引用、GitHub Actions（lint / typecheck / test）。
- [x] **Spike 1：Host 打包为 sidecar**（Linux 已端到端验证，macOS / Windows 已交叉编译，结论见 `docs/spikes.md`）。验证 pi SDK 能否用 `bun build --compile` 打成单文件，并能正常加载扩展、skills 与 `~/.pi/agent` 配置；失败则改为"内置 Node 运行时 + JS bundle"或 Node SEA。
- [x] **Spike 2**：Tauri 2 通过 `externalBin` 启动 sidecar，并通过 stdout 获取端口与本地 token（Linux 已验证，结论见 `docs/spikes.md`）。
- [ ] **Spike 3**：Expo 开发构建中 WebSocket + `@noble/*` 加解密性能验证（iOS / Android 各一台真机）。桌面运行时基准、Hermes 打包与 Web 端到端已完成（见 `docs/spikes.md`）；App 内置测试页，真机数据待补。
- 验收：三个 spike 的结论写入 `docs/spikes.md`，确定打包方案。

### M1 Host 核心

- [x] `packages/protocol`：schema、类型、版本号；`docs/protocol.md`。
- [x] `packages/host`：工作区配置、会话池、`AgentSessionRuntime` 绑定、UI 桥接、EventLog、`pier-approval`。
- [x] 本地 WS Gateway（`127.0.0.1` + token）。
- [x] `packages/client` + 一个命令行调试客户端（`bun run pier-cli`）。
- 验收：通过 CLI 客户端完成新建会话 → prompt → 流式输出 → 触发审批并响应 → 断开重连后补发事件；单元测试覆盖 EventLog 与协议校验。

### M2 桌面端 MVP

- [x] Tauri 应用骨架、sidecar 生命周期管理（启动、就绪、崩溃重启、日志、优雅退出）、托盘、单实例。
- [x] 开机自启：本机常规设置中启用 / 停用 Windows、macOS、Linux 的登录启动项，默认关闭；自启时在托盘运行，手动打开仍显示窗口。
- [x] `packages/chat-state` reducer；聊天视图、会话列表、工作区管理、审批对话框、模型切换。
- [ ] macOS / Windows 真机验证安装包（sidecar 路径、资源目录、Origin）。
- 未纳入 M2、留到后续：桌面通知（M4）、会话搜索（M4）。自动更新已提前完成（见 M6）。
- 验收：不打开终端即可在桌面端完成日常 pi 编码任务；关闭窗口后 Agent 继续运行。

### M3 手机端 MVP（局域网）

- [x] `packages/crypto`：Noise XX / IK（通过 cacophony 测试向量）、帧加密、配对链接；`docs/security.md`。
- [x] Host：远程监听（默认关闭，端口 7433）、mDNS、配对（一次性配对码 + 桌面确认）、设备登记与吊销、审计日志；协议 1.1（`remote.*`、`pairing.*`、`device.*`、`session.activity`）。
- [x] 桌面：远程访问开关、配对二维码、配对确认框、设备管理页（改名、吊销、在线状态）。
- [x] Expo（SDK 57）：扫码 / 粘贴链接 / `pier://` 深链接配对、多台电脑、会话列表（运行中 / 待批准标记）、聊天（流式、工具卡片、diff）、审批与对话框、steer / follow-up / 中止、附图、模型与思考等级、压缩、重连补发、吊销提示、加密性能测试页。
- [ ] iOS / Android 真机验证（扫码、本地网络权限、前后台切换）；EAS 开发构建。
- 验收：同一局域网内手机扫码配对后，可查看并驱动桌面会话、审批命令；桌面吊销后手机立即断开；抓包只能看到密文。（除真机外均已由集成测试与 Web 版 App 端到端验证。）
- [x] 电脑之间互联（协议 1.9）：每台电脑都是节点，Host 用自身密钥作为设备密钥与其他电脑配对（`peer.*`），桌面经本地 Gateway 的 `/peer/<id>` 代理同时连接所有电脑，侧边栏统一列出各电脑的工作区与会话；被连接方按远程设备对待（见 `docs/security.md` §4.4）。
- [x] 配对即完全信任（协议 1.10）：远程设备可以管理工作区、审批策略、文件与模型 / 扩展配置，经 `host.listDirectories` 浏览那台电脑的目录添加工作区；只有配对、设备、远程访问与 `peer.*` 仍仅限本机。

### M4 体验完善

- [ ] 图片输入、diff 视图、fork / 会话树、压缩、会话搜索。
- [x] 斜杠命令：桌面与手机输入框的命令菜单；内置 `/new`、`/model`、`/thinking`、`/compact`、`/fork`、`/name`、`/reload`，以及 pi 的扩展命令、提示词模板与 skill（`session.commands`、`session.reload`，协议 1.5）。
- [ ] 本地通知（桌面）；手机前台通知。
- [ ] 流式增量合并、长会话分页加载、性能优化。
- 验收：长会话（上千条消息）在手机上流畅滚动；弱网下断线恢复无丢失。

### M5 远程访问与推送

- [x] `apps/relay`：按 Host 公钥路由 WebSocket、只转发密文、限流、认证（私有模式令牌 / 开放模式限额）、内置 STUN、Docker 镜像（协议 1.26）。
- [x] P2P：经中继交换 WebRTC 信令并打洞，成功后会话无缝切换到数据通道，失败回退中继；手机与电脑之间、电脑与电脑之间均适用。
- [ ] 推送：手机上报 Expo push token（经加密通道交给 Host，Host 注册到 relay）；Host 在 `agent_settled`、`ui.request`、错误时触发推送，推送内容不含代码与命令原文。
- 验收：手机使用移动网络（非同一局域网）可完成配对后的全部操作；锁屏状态下能收到审批通知。

### 多 Agent 运行时

- [x] Host 抽象出 Agent 运行时接口（`packages/host/src/runtimes/`：`AgentRuntime` + `ManagedSession` 基类），`packages/host/src/pi/` 作为第一个实现；非 pi 运行时通过 `LiveTranscript` 输出 pi 形态的消息与事件，客户端无需区分（协议 1.22）。
- [x] 接入 Claude Code（Claude Agent SDK，驱动用户安装的 `claude`）：会话、流式输出、工具调用与权限审批映射到 Pier 协议（`packages/host/src/claude/`）。
- [x] 接入 Codex（`codex app-server`）：同上，并按工作区策略设置其沙箱与审批模式（`packages/host/src/codex/`）。
- [x] 桌面与手机端：新建会话时选择 Agent，按运行时显示可用的模型、思考等级与能力（压缩、分叉等）。
- [x] 桌面端可视化编辑 Claude Code 的 `settings.json`（全局 / 项目 / 本地）与 Codex 的 `config.toml`（全局 / 项目，保留注释与格式），包括中转接口、模型、权限与 Codex 服务商（协议 1.23 `agentConfig.*`）。
- [ ] 真机验证：Codex 的完整回合（本次只用模拟的 app-server 与未登录的真实 CLI 验证过）、Windows / macOS 上的 CLI 查找与启动。
- 验收：同一台电脑上 pi、Claude Code、Codex 会话可以并存，手机端均可驱动和审批。

### M6 发布

- [x] 桌面：Tauri updater 发布通道（签名的更新包 + GitHub Release 上的 `latest.json`，应用内检查、下载、校验、安装并重启；Linux AppImage 已端到端验证）。
- [ ] 桌面：macOS 签名与公证、Windows 签名；macOS / Windows 上的自动更新真机验证。
- [x] 手机：Android APK 随 GitHub Release 发布（GitHub Actions 上 `expo prebuild` + Gradle 构建，固定发布密钥签名，校验证书指纹）。
- [ ] 手机：iOS 构建（EAS Build）、TestFlight / 内部测试轨道。
- [ ] 用户文档：安装、配对、安全建议。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| pi SDK API 变动 | pi 是用户自己的安装，Host 运行时加载（`sdk.ts`，最低版本 `MIN_PI_VERSION`，加载时检查必需接口）；所有 pi 调用集中在 `packages/host/src/pi/` 适配层；用开发依赖中的 pi 跑集成测试 |
| 多运行时能力不一致（Claude Code / Codex 的会话、审批、压缩模型各不相同） | 协议只暴露公共能力，运行时差异通过能力声明呈现；每个运行时独立适配层与集成测试 |
| 单文件打包后扩展（运行时加载 TS）无法工作 | M0 Spike 1 优先验证；备选内置 Node 运行时 |
| iOS 后台会挂起 WebSocket | 不依赖后台长连接：回到前台用 `sinceSeq` 补发，后台靠推送 |
| 远程执行带来的安全风险 | 默认关闭远程访问、强制配对 + E2E、默认审批策略、审计日志、可吊销 |
| 与 pi CLI 同时操作同一会话 | 会话文件锁 / 只读提示 |
| Windows 平台路径与 shell 差异 | CI 增加 Windows 构建与 Host 测试 |
| 中继成本与可用性 | 局域网 / Tailscale 优先；中继可自托管 |

## 12. 待确认问题

- 目标桌面平台优先级（macOS / Windows / Linux）？
- 是否开源、采用什么许可证？
- `smart` 审批策略的默认白名单范围？
- ~~中继采用 Cloudflare Workers 还是自托管服务器？~~ 自托管（见 §3）。
- 是否需要 Pier 自己的模型 / 凭据配置界面，还是先完全依赖 pi CLI 的 `/login` 与配置文件？

## 13. 下一步

1. ~~按 M0 初始化 monorepo 与 CI。~~ ✅
2. ~~执行 Spike 1（Host 打包）。~~ ✅ 采用 Bun 单文件 + pi 资源目录，见 `docs/spikes.md`。
3. ~~起草 `docs/protocol.md`，与 M1 Host 实现同步推进。~~ ✅
4. ~~Spike 2：Tauri 2 通过 `externalBin` 启动 sidecar。~~ ✅ Linux 已验证；macOS / Windows 安装包待真机确认。
5. ~~M2：`apps/desktop` 骨架与 `packages/chat-state` reducer。~~ ✅
6. Spike 3：Expo 真机加密性能。🟡 桌面运行时与 Hermes 打包已验证，真机数据待补（App“设置 → 加密性能测试”）。
7. ~~M3：`packages/crypto`、Host 远程监听与配对、桌面端配对二维码与设备管理、Expo 手机端。~~ ✅ 真机验证待补。
8. M4：图片输入完善、会话搜索与分页、桌面通知与手机前台通知、长会话性能。
