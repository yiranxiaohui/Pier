# M0 技术验证（Spikes）

> 历史记录：pi 已不再编译进 sidecar（协议 1.61），Host 在运行时加载用户自己安装的 pi（见 `packages/host/src/pi/sdk.ts`），下文关于 pi 资源、`PI_PACKAGE_DIR` 与 Photon wasm 重定向的内容只适用于之前的版本。
>
> 记录日期：2026-09-28。环境：Ubuntu x86_64，Node 24.21，Bun 1.4.2，pi SDK `@earendil-works/pi-coding-agent` 0.87.1。

## 结论速览

| Spike | 状态 | 结论 |
|---|---|---|
| 1. Host 打包为 sidecar | ✅ Linux 端到端验证；五个平台的原生冒烟测试已随 v0.0.1 通过 | 采用 **`bun build --compile` 单文件 + pi 资源目录** |
| 2. Tauri `externalBin` 启动 sidecar | ✅ Linux 端到端验证（开发构建与 `.deb` 安装布局）；macOS / Windows 由 CI 编译检查 | `externalBin` 负责打包，Rust 侧用 `std::process` 自行管理进程；pi 资源作为 Tauri resource，经 `PI_PACKAGE_DIR` 传给 sidecar |
| 3. Expo 中 WebSocket + `@noble/*` 性能 | 🟡 桌面运行时已测、Hermes 打包与 Web 端到端已验证；iOS / Android 真机数据待补 | 纯 JS `@noble/*` + 文本帧足够（Node 上 1 KiB 帧 0.09 ms，1 MiB 帧约 25 MiB/s）；App 内置测试页，拿到真机后直接运行 |

## Spike 1：Host 打包为 sidecar

### 做法

`bun run build:sidecar [--target <bun-target>]`（`packages/host/scripts/build-sidecar.mjs`）：

1. `bun build --compile --no-compile-autoload-bunfig src/main.ts` 生成单文件可执行程序；
2. 按 pi 自身 `build:binary` 的布局，把 SDK 运行时需要的资源复制到可执行文件旁：`package.json`（pi 的版本号与 `piConfig`）、`theme/*.json`、`export-html/`、`assets/`、`docs/`、`examples/`、`photon_rs_bg.wasm`。

pi 在 Bun 二进制中通过 `dirname(process.execPath)` 查找这些资源；资源无法与可执行文件放在一起时（例如放进 app bundle 的 Resources），设置 `PI_PACKAGE_DIR` 指向资源目录即可。

### 验证结果

| 项目 | 结果 |
|---|---|
| 构建 | 原生 < 1 s；交叉编译 `bun-darwin-arm64`（Mach-O arm64，73 MB）、`bun-windows-x64`（PE32+，97 MB）各约 2.5 s；Linux x64 二进制 92 MB，连同资源 96 MB |
| `~/.pi/agent` 配置 | 默认模型、`auth.json` 凭据、`models.json`、7 个可用模型均与 Node 一致 |
| 扩展 | 与 Node 完全一致：3 个本地 `.ts` 扩展（运行时经 jiti 转译）+ 2 个 npm 包扩展（`pi-web-access`、`pi-subagents`），0 个加载错误 |
| Skills / 上下文文件 | 6 个 skills、全局 `AGENTS.md` 均加载 |
| 端到端 | 用编译后的二进制完成：真实模型 prompt、流式输出、`bash` 工具调用触发审批并放行、断线重连后按 seq 恢复、`--watch-stdin` 优雅退出（清理锁文件与 `run/host.json`） |
| 启动耗时（构建 runtime 到可用） | Bun 二进制热启动约 0.5 s（首次冷启动 4.6 s）；Node + tsx 约 1.0 s |

诊断脚本：`packages/host/spikes/sidecar-check.ts` 通过 Pier 的 pi 适配层创建内存会话，并输出已加载的扩展、skills、上下文文件、工具与模型。它可以直接用 tsx 运行，也可以用 `bun build --compile` 编译后运行，对比两种运行时的结果。

### 发现的问题与处理

1. **缺少 pi 资源时版本号为 `0.0.0`，且主题初始化失败。** 有扩展在 `session_start` 时访问 `ctx.ui.theme`，会导致会话创建失败。处理：构建脚本复制资源；UI 桥接在主题不可用时回退为无样式主题（样式函数原样返回文本），不会再抛错。
2. **图片缩放 worker 未嵌入二进制，且 Photon 的 wasm 读的是构建机路径。** pi 会自动回退为进程内缩放，但 `photon-node` 用 `__dirname` 读取 `photon_rs_bg.wasm`，`bun build --compile` 把构建机上的 `node_modules` 路径写死进了二进制；pi 自带的回退只查找可执行文件目录、`<可执行文件目录>/photon` 和工作目录，找不到桌面端放在 `pi-assets`（`PI_PACKAGE_DIR`）里的那份。于是在构建机以外的电脑上 Photon 加载失败，所有图片都被替换为 "[Image omitted: could not be resized below the inline image size limit.]"（v0.2.9 之前的版本都有这个问题；构建机上不会复现）。处理：`packages/host/src/pi/photon-wasm.ts` 在启动时把对 `photon_rs_bg.wasm` 的读取重定向到 `PI_PACKAGE_DIR` 或可执行文件目录中的那份；`pier-host --check-images` 会通过 pi 实际缩放一张图片，`smoke-sidecar.mjs` 据此校验 wasm 确实来自安装包。
3. **偶发一次退出卡住，未能复现。** 该次日志已打印 "shutting down"，但进程未退出，且 `unref()` 的 10 s 强制退出定时器也未触发。随后在空闲、运行中断开、prompt 完成后等场景各复现数次，均正常退出（约 30 ms）。已加固：强制退出定时器不再 `unref`；每个会话的 dispose 限时 5 s（防止扩展的 `session_shutdown` 挂住）；退出各步骤写入 stderr，便于再次出现时定位。

### 决定

- 桌面端 sidecar 采用 Bun 单文件二进制，pi 资源作为同目录文件（或 Tauri resources + `PI_PACKAGE_DIR`）一起分发。
- 备选方案（内置 Node 运行时 + JS bundle，或 Node SEA）暂不需要；若 M2 在 macOS / Windows 真机上验证失败，再启用备选。
- v0.0.1 发版时，在 GitHub Actions 原生 runner（linux-x64、linux-arm64、darwin-arm64、darwin-x64、windows-x64）上用 `scripts/smoke-sidecar.mjs` 验证了编译产物：启动、`pier.ready`、协议握手、通过二进制内的 pi SDK 创建会话、stdin 关闭后优雅退出（此后还加入了 `--check-images` 图片缩放检查）。
- 待在 M2 / M6 验证：macOS / Windows 上配合真实 `~/.pi/agent` 与真实模型运行；Bun 二进制在 macOS 上的签名与公证；带原生依赖的扩展。

## Spike 2：Tauri 启动 sidecar

> 历史记录：pi 已不再编译进 sidecar（协议 1.61），Host 在运行时加载用户自己安装的 pi（见 `packages/host/src/pi/sdk.ts`），下文关于 pi 资源、`PI_PACKAGE_DIR` 与 Photon wasm 重定向的内容只适用于之前的版本。
>
> 记录日期：2026-09-28。环境：Ubuntu 26.04 x86_64，Tauri 2.12，WebKitGTK 2.52，Rust 1.98。

### 做法

- **打包**：`apps/desktop/scripts/prepare-sidecar.mjs` 按 Rust 目标三元组构建 `src-tauri/binaries/pier-host-<triple>`（Tauri `externalBin`），并把 pi 运行时资源放到 `src-tauri/pi-assets/`（Tauri `bundle.resources`）。开发构建和安装包中，Tauri 都会把 sidecar 放在主程序旁边并去掉三元组后缀。
- **进程管理**：没有使用 `tauri-plugin-shell`，而是在 `src-tauri/src/host.rs` 中用 `std::process::Command` 直接启动 sidecar。原因：
  1. 需要自己持有 stdin 管道：关闭 stdin 就是 Host 的优雅退出信号（`--watch-stdin`），应用被强杀时管道也会随之关闭；
  2. 崩溃重启、就绪超时、日志环形缓冲都要自己控制，插件只多一层事件转发；
  3. 不必给 WebView 开放任何 shell 权限，前端只能调用 `host_status` / `host_logs` / `host_restart` 三个命令。
- **握手**：读取 stdout 的 `pier.ready` 行获得端口与本地 token（由 Host 随机生成，不经环境变量传递），通过 `pier://host-status` 事件推给 WebView；WebView 用 `@pier/client` 直接连 `ws://127.0.0.1:<port>`。CSP 放行 `ws://127.0.0.1:*`；Origin 为 `tauri://localhost`（Windows 为 `http://tauri.localhost`，开发时为 `http://localhost:1420`），都在 Host 默认白名单内。
- **pi 资源**：Rust 侧把 `resource_dir()/pi-assets` 作为 `PI_PACKAGE_DIR` 传给 sidecar。未设置时 pi 版本号会退化为 `0.0.0`（已复现），设置后为 `0.87.1`。

### 验证结果（Linux，Xvfb 下运行真实应用）

| 项目 | 结果 |
|---|---|
| 启动 | 应用启动约 0.5 s 后 Host 就绪，UI 显示“已连接 · pi 0.87.1” |
| 崩溃恢复 | `kill -9` sidecar → 约 1 s 后自动重启（新端口），UI 自动切换到新连接；连续快速失败 5 次后停止重试并提示手动重启 |
| 退出 | 界面“退出”/托盘“退出 Pier” → `RunEvent::Exit` → 关闭 stdin，Host 优雅退出并删除 `run/host.json` |
| 外壳被强杀 | `kill -9` 主进程 → stdin 管道关闭，Host 随即退出，无残留进程 |
| `SIGTERM` | 主进程与 Host 均退出 |
| 单实例 | 第二次启动把焦点交给已运行的实例并以 0 退出，只保留一个 Host |
| 关闭窗口 | 窗口隐藏到托盘，Host 与运行中的 Agent 不受影响 |
| `.deb` 安装布局 | 通过，见下方“打包验证” |

### 打包验证

`bun run --cwd apps/desktop build --bundles deb` 生成 `Pier_0.0.1_amd64.deb`（43.7 MiB，依赖 `libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`）。安装布局：

```
usr/bin/pier-desktop            主程序
usr/bin/pier-host               sidecar（externalBin，已去掉三元组后缀）
usr/lib/Pier/pi-assets/         pi 运行时资源（resource_dir()/pi-assets → PI_PACKAGE_DIR）
usr/share/applications/Pier.desktop
```

从解包目录运行：sidecar 的 `PI_PACKAGE_DIR` 正确指向 `usr/lib/Pier/pi-assets`，WebView 以生产 Origin `tauri://localhost` 和 CSP 连上 Host。用真实模型（`~/.pi/agent` 中的默认模型）完成了一次任务：流式输出、`cat *.txt` 被智能策略的只读白名单直接放行、上下文与 token 统计正常。Markdown 中的链接通过 `tauri-plugin-opener` 交给系统默认浏览器打开。

其他发现：

- WebKitGTK 会接受 fontconfig 为**第一个**字体族返回的替代字体（`ui-monospace`、`SF Mono` 都被映射成 Noto Sans CJK），导致代码块不是等宽字体。Linux 上改用通用族 `monospace`。
- 开发时可以用 `PIER_HOST_BIN` 让桌面端运行别的 Host（例如包装 `bun run faux-host` 的脚本，它输出同样的 `pier.ready` 行并支持 `--watch-stdin`），便于在真实外壳里调界面。

### 待验证

- macOS / Windows 真机：CI 只做编译与 clippy 检查；`.dmg` / NSIS 安装包在发版流水线中构建，需要在真机上确认 sidecar 路径、资源目录与 Origin。
- macOS 签名与公证（M6）：sidecar 作为 `externalBin` 需要一并签名。

## Spike 3：Expo 加密性能

> 历史记录：pi 已不再编译进 sidecar（协议 1.61），Host 在运行时加载用户自己安装的 pi（见 `packages/host/src/pi/sdk.ts`），下文关于 pi 资源、`PI_PACKAGE_DIR` 与 Photon wasm 重定向的内容只适用于之前的版本。
>
> 记录日期：2026-09-28。Expo SDK 57（React Native 0.86.3，Hermes），`@noble/curves` / `@noble/ciphers` / `@noble/hashes` 2.4。

### 做法

- 加密通道全部用纯 JS 实现（`packages/crypto`，见 `docs/security.md`）：Noise XX / IK、ChaCha20‑Poly1305、base64 文本帧。同一份代码在 Host（Node / Bun）、桌面 WebView 和手机（Hermes）上运行。
- 基准测试 `runChannelBenchmark()` 走真实代码路径（IK 握手两端、`SecureTransport.seal` + `open`，含 JSON 与 base64 封装）。命令行：`bun run --cwd packages/crypto bench`；手机：App“设置 → 加密性能测试”。
- 加解密热路径优先用引擎自带的实现：`TextEncoder` / `TextDecoder`、`Uint8Array.fromBase64` / `toBase64`（Bun、新版浏览器）或 Node 的 `Buffer`，没有时回退到纯 JS（`@scure/base` 与自带的 UTF‑8 编解码，已测试）。Hermes 没有 `crypto.getRandomValues`，App 启动时用 `expo-crypto` 补上。

### 结果（x86_64 Linux，16 线程）

| 用例 | Node 24.21 | Bun 1.4.2 |
|---|---|---|
| X25519 生成密钥对 | 0.55 ms | 0.19 ms |
| Noise IK 握手（两端合计） | 16.3 ms | 7.0 ms |
| 1 KiB 帧 seal + open | 0.09 ms | 0.07 ms |
| 64 KiB 帧 seal + open | 2.5 ms（25 MiB/s） | 2.1 ms（30 MiB/s） |
| 1 MiB 帧 seal + open | 41 ms（25 MiB/s） | 33 ms（30 MiB/s） |

瓶颈是 ChaCha20‑Poly1305 本身（纯 JS 单向约 100 MiB/s）。改用原生 base64 与 TextEncoder 之前，同一测试只有约 10 MiB/s。

### 已验证

- `expo export --platform android|ios` 成功生成 Hermes 字节码（`.hbc`）：workspace 包的 `.ts` 源码（含 `.ts` 扩展名导入）、zod、`@noble/*` 均能被 Metro 解析和编译。
- Web 构建在无头 Chromium（390×844 手机视口）中端到端通过：粘贴配对链接 → 桌面确认 → 连接 → 新建会话 → 流式回复 → 手机上批准命令 → 任务完成；吊销后约 0.8 s 内手机显示“已被电脑移除”，重新配对后恢复；回复中途断开远程访问，重连后回复完整且只渲染一次。
- `@pier/client` 只依赖 WHATWG WebSocket API，与 React Native 的 WebSocket 兼容；加密层以 `createWebSocket` 注入，重连与按 seq 恢复逻辑无需改动。

### 待补（需要真机）

- iOS 与 Android 真机上的基准数据（预期 Hermes 比 Node 慢 3–10 倍：握手约 50–150 ms、1 KiB 帧不到 1 ms，都在可接受范围内；大图片帧会慢一些）。
- 真机上的扫码、局域网权限（iOS“本地网络”弹窗、Android 明文 `ws://`）、前后台切换后的重连。

### 决定

- 保持纯 JS 加密与 JSON 文本帧；不引入原生加密模块。若真机测得大帧过慢，再考虑二进制帧（省去 base64）或原生 ChaCha20。
