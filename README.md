# Pier

A cross-device workbench for coding agents.

<p align="center">
  <img src="docs/images/pier-overview.png" alt="Pier 跨设备编程 Agent 工作台：电脑上运行，手机上掌控（界面示意）" width="640" />
</p>

<p align="center">
  <a href="https://github.com/yiranxiaohui/Pier/releases/latest"><img src="https://img.shields.io/github/v/release/yiranxiaohui/Pier?label=release" alt="最新版本" /></a>
  <a href="https://github.com/yiranxiaohui/Pier/actions/workflows/ci.yml"><img src="https://github.com/yiranxiaohui/Pier/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
</p>

Pier 是编码 Agent 的跨设备工作台：在同一个界面中使用内置的 [pi](https://github.com/earendil-works/pi) 和电脑上安装的 [Claude Code](https://code.claude.com)、[Codex](https://github.com/openai/codex)，统一管理多台电脑上的工作区与会话，并提供文件、Git 和终端操作。Agent 常驻在各自的电脑上运行，你可以从桌面端或手机端查看进度、发送指令和审批操作。

## 特性

- **一个界面，三种 Agent**：内置 pi，并驱动电脑上安装的 Claude Code 与 Codex；它们的会话与终端中的 CLI 共用，随时可以用 `claude --resume` / `codex resume` 在终端继续。
- **多台电脑统一管理**：每台电脑都是一个节点。粘贴配对链接，或通过 SSH 登录 Linux 电脑自动安装 Pier 并配对，那台电脑的工作区和会话与本机的一起列在侧边栏中。
- **手机随时跟进**：原生 App（Expo / React Native）扫码配对后查看进度、发送指令、审批操作，断线自动重连补发。
- **完整的工作台**：文件浏览、预览与编辑，Git（含工作树）、内置终端、远程浏览器、端口映射、进程管理、定时任务、Skills 与 MCP 管理、语音输入。
- **端到端加密的远程访问**：配对后的连接全程加密；不在同一网络时经自建的 [Pier Relay](apps/relay/README.md) 连接，优先打洞 P2P 直连，中继只看得到密文。
- **安装与更新省心**：桌面端与 Android 应用内更新（签名校验，可选国内加速线路）；Linux 服务器一条命令安装为后台服务。

## 安装

### Linux 一键安装

适用于 Linux 服务器和无图形界面的电脑（x86_64 / arm64）。用之后要运行 Agent 的账号执行：

```bash
curl -fsSL https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.sh | bash
```

脚本从 GitHub Release 下载最新的 `pier` 单文件，按 Release 的 `SHA256SUMS.txt` 校验并核对版本，再用 `pier install` 安装为后台服务和 `pier` 命令：

- 普通账号安装为 systemd 用户服务（程序在 `~/.local/share/pier`，命令为 `~/.local/bin/pier`），并在无需密码时开启 linger，让服务在退出 SSH 后继续运行、开机自动启动；用 `curl … | sudo bash` 以 root 执行则安装为系统服务（`/opt/pier`、`/usr/local/bin/pier`）。
- 有图形桌面时默认只安装 `pier` 命令（运行 `pier` 打开桌面界面），不安装后台服务，因为桌面窗口和后台服务不能同时使用同一个状态目录；需要服务时加 `--service`。已经安装过的电脑沿用原来的方式。
- 没有 systemd 管理器（例如容器中）时只安装、不启动，之后用 `pier run` 运行。
- 再次执行即更新到最新版，已是最新版时直接退出；安装为服务后也可以用 `pier update` 更新。Pier 状态（`~/.pier`）、配对和 Agent 数据保持不变。

#### 下载线路

安装文件约 225 MB，可以经 GitHub 直连或 GHFast（`ghfast.top`）、GH-Proxy（`gh-proxy.com`）、GHProxy（`ghproxy.net`）加速线路下载：

- **自动选线（默认）**：GitHub 直连足够快（2 MB/s 以上）时直接使用；否则同时测速各条加速线路，从最快的开始下载。某条线路断开或连续 20 秒低于 100 KB/s 时，自动换到下一条线路，并且从已下载的位置接着下载。只有 wget 时不测速，依次尝试 GitHub 与各条加速线路。
- **手动切换**：在终端中下载时按 `s`，立即换到下一条线路，同样接着已下载的部分继续。
- **指定线路**：`--mirror ghfast`（或 `github`、`gh-proxy`、`ghproxy`、自定义的 `https://` 加速前缀）固定从这条线路下载，失败时在这条线路上重试，不会自动换线；按 `s` 仍可手动切换。

无论走哪条线路，校验和都优先直接从 GitHub 获取；GitHub 无法访问时才从加速线路获取，并给出提示。国内网络连不上 `raw.githubusercontent.com` 时，也可以经加速线路获取脚本本身：

```bash
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.sh | bash
```

#### 参数

| 参数 | 说明 |
|---|---|
| `--version v0.2.58` | 安装指定版本，默认为最新正式版 |
| `--service` / `--portable` | 安装后台服务和 `pier` 命令 / 只安装 `pier` 命令 |
| `--user` / `--system` | 服务范围，默认普通账号为用户服务、root 为系统服务 |
| `--no-start` | 安装服务但不启动 |
| `--mirror <线路>` | `auto`（默认，自动选线）、`github`、`ghfast`、`gh-proxy`、`ghproxy` 或自定义的 `https://` 加速前缀 |
| `--force` | 已是该版本时也重新安装 |

参数写在 `bash -s --` 之后。也可以用环境变量 `PIER_VERSION`、`PIER_MIRROR` 代替 `--version`、`--mirror`，用 `PIER_PREFIX`、`PIER_DIR` 指定安装前缀和 Pier 状态目录。

安装后的常用命令：

```bash
pier                  # 打开 CLI：/ws add <目录> 添加工作区，/new 新建会话，/help 查看全部命令
pier status           # 服务状态；pier logs 查看日志，pier start / stop / restart 控制服务
pier update           # 更新到最新正式版（--version vX.Y.Z 指定版本）
pier uninstall        # 卸载服务和程序，保留 ~/.pier（--purge 一并删除 Pier 状态）
```

单文件的其他用法（手动下载运行、bash 补全、从旧版 `pier-host` 迁移）见[使用指南](docs/guide.md#linux-单文件)。

### 安装包

从 [GitHub Releases](https://github.com/yiranxiaohui/Pier/releases/latest) 下载对应平台的文件（`<版本>` 形如 `0.2.58`，可用 Release 中的 `SHA256SUMS.txt` 核对）：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows x64 | `pier-v<版本>-windows-x64.setup.exe` | 安装程序，支持应用内更新 |
| macOS Apple Silicon / Intel | `pier-v<版本>-darwin-arm64.dmg` / `pier-v<版本>-darwin-x64.dmg` | 未经 Apple 公证，首次打开需在「系统设置 → 隐私与安全性」中点「仍要打开」，详见[平台说明](docs/guide.md#平台说明) |
| Linux x64 / ARM64 | `pier-v<版本>-linux-x64.deb` / `.AppImage`，ARM64 为 `linux-arm64` | 桌面安装包，支持应用内更新 |
| Linux x64 / ARM64 | `pier-v<版本>-linux-x64` / `pier-v<版本>-linux-arm64` | 单文件，包含桌面界面、后台服务和 CLI，即一键脚本安装的文件 |
| Android | `pier-v<版本>-android.apk` | 已签名，支持应用内更新 |
| iOS | — | 暂未打包，需要[从源码构建](docs/development.md#手机端) |

## 快速上手

1. **打开 Pier**：桌面端安装后直接打开；Linux 服务器用一键脚本安装后，在终端运行 `pier` 打开 CLI。
2. **准备 Agent**：内置的 pi 在「设置 → 模型与服务商」中登录服务商或填写 API Key；Claude Code / Codex 可以在「设置 → Agent 配置」中一键安装，再按提示登录。
3. **开始会话**：添加工作区（项目目录），新建会话时在输入框下方选择 pi、Claude Code 或 Codex。
4. **连接手机**：在桌面端「设置 → 设备与远程」开启远程访问并显示配对二维码，在手机 App 中点「添加电脑」扫码。服务器上在 `pier` CLI 中依次输入 `/remote on`、`/pair`，在客户端粘贴配对链接后输入 `/pair yes` 确认。
5. **添加其他电脑**：在侧边栏点「添加电脑」，粘贴那台电脑的配对链接，或选择「通过 SSH 添加」自动安装并配对；不在同一网络时配置[中继](docs/guide.md#中继与-p2p-直连)。

## 界面预览

以下截图来自实际运行的 Pier 界面，使用示例工作区与演示模型。桌面端截自浏览器预览，手机端截自 Web 预览。

### 桌面端：会话、工具调用与审批

左侧管理工作区和会话，中间查看 Agent 的回复、文件修改 diff 与操作审批，右侧浏览项目文件。

![Pier 桌面工作台：会话列表、文件修改 diff、操作审批与工作区文件](docs/images/desktop-workbench.png)

### 桌面端：Git 源代码管理

在同一个工作台里查看更改、暂存文件和提交代码，也可以切换分支、查看提交记录。「更多 Git 操作 → 工作树…」可以列出、新建和删除 Git 工作树（worktree），新建的工作树可直接添加为工作区并打开，在独立目录中并行开发不同分支。

![Pier 桌面端 Git 面板：当前分支、更改列表、提交入口与提交记录](docs/images/desktop-git.png)

### 手机端：查看主机与跟进会话

配对后查看电脑的运行状态、工作区和会话；进入同一会话即可查看工具执行结果、发送指令或审批操作。

<p align="center">
  <img src="docs/images/mobile-host.png" alt="Pier 手机端主机概览：连接状态、资源占用、工作区和会话列表" width="320" />
  <img src="docs/images/mobile-chat.png" alt="Pier 手机端会话：工具调用结果、操作审批和消息输入" width="320" />
</p>

## 文档

| 文档 | 内容 |
|---|---|
| [使用指南](docs/guide.md) | 安装与更新、手机与其他电脑、中继、Claude Code / Codex / pi 配置，以及文件、Git、终端、浏览器、端口、进程、定时任务、语音输入等功能的详细说明 |
| [开发指南](docs/development.md) | 项目结构、本地开发与调试、构建桌面端 / 手机端 / sidecar、发版流程 |
| [Pier Relay](apps/relay/README.md) | 自建中继的部署与管理后台 |
| [协议](docs/protocol.md) · [安全设计](docs/security.md) | 客户端与 Host 之间的协议、远程访问的加密与配对设计 |
| [开发计划](docs/PLAN.md) · [技术验证](docs/spikes.md) | 里程碑与技术验证结论 |

## 开发

需要 Node 22+（推荐 24）和 [Bun](https://bun.sh)：

```bash
bun install
bun run lint && bun run typecheck && bun run test
```

桌面端、手机端与 sidecar 的构建，以及发版流程，见[开发指南](docs/development.md)。版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。
