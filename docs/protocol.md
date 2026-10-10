# Pier 协议 v1.36

> 实现：`packages/protocol`（zod schema + TS 类型，Host 与所有客户端共享）。
> 本文档描述线上格式与语义；字段的权威定义以 `packages/protocol/src` 为准。

## 1. 传输与帧

- 传输：WebSocket，**文本帧**，每帧一个 JSON 对象。二进制帧会被拒绝（关闭码 1003）。
- 本地连接：Host 仅监听 `127.0.0.1`，帧为明文。
- 远程连接（开启远程访问后，默认端口 7433）：先完成 Noise 握手（配对用 XX，之后用 IK），之后每一帧都是加密帧 `{ "t": "enc", "n": <nonce>, "c": <ciphertext> }`，其明文即本文档的帧。握手、配对与吊销见 [`docs/security.md`](security.md)。
- 帧类型：

```jsonc
// 客户端 → Host：请求
{ "type": "req", "id": "r1", "method": "session.prompt", "params": { "sessionId": "…", "text": "…" } }

// Host → 客户端：响应（与请求 id 对应；同一连接上的响应可能乱序到达）
{ "type": "res", "id": "r1", "ok": true, "result": { "accepted": true } }
{ "type": "res", "id": "r1", "ok": false, "error": { "code": "NOT_FOUND", "message": "…", "data": … } }

// Host → 客户端：事件
{ "type": "evt", "sessionId": "…", "seq": 42, "event": { "type": "message_update", … } }
{ "type": "evt", "event": { "type": "host.notice", … } }   // Host 级事件：无 sessionId / seq
```

- `id`：1–128 字符，由客户端生成，仅在本连接内唯一即可。
- 无法解析的帧返回 `id: ""` 的 `BAD_REQUEST` 响应。

### 错误码

| code | 含义 |
|---|---|
| `BAD_REQUEST` | 帧或参数校验失败（`data` 为 zod issues） |
| `UNAUTHENTICATED` | 尚未完成 `host.hello`，或 token 错误（Host 随后关闭连接，关闭码 4401） |
| `FORBIDDEN` | 已认证但无权调用（例如远程设备调用仅限本地的方法） |
| `NOT_FOUND` | 工作区 / 会话 / 模型不存在，或会话未在活跃池中 |
| `CONFLICT` | 目标状态不允许（会话运行中、会话文件被外部修改、被其他 Host 锁定等） |
| `PROTOCOL_MISMATCH` | 主版本不一致；`data.hostVersion` 为 Host 的版本 |
| `UNSUPPORTED` | 协议已定义但此 Host 尚未实现 |
| `TIMEOUT` | 客户端本地超时（Host 不会返回此码） |
| `INTERNAL` | 未预期的 Host 错误 |

### 关闭码

| 关闭码 | 含义 | 客户端应 |
|---|---|---|
| 1003 | 收到二进制帧 | 修复客户端 |
| 1013 | 发送缓冲超过 16 MiB（客户端跟不上） | 重连并按 seq 恢复 |
| 4400 | 远程：握手失败、配对失败，或收到无法解密的帧 | 按错误提示处理 |
| 4401 | `host.hello` 失败或超时 | 不要自动重试（token / 版本错误） |
| 4403 | 远程：设备未登记或已被吊销（握手时的 `error` 帧 code 为 `UNKNOWN_DEVICE`） | 停止重连，提示重新配对（`@pier/client` 默认把它视为终止） |
| 4410 | 远程：桌面关闭了远程访问（或关闭了中继，经中继和 P2P 的连接随之断开） | 稍后重连 |
| 4604 / 4608 / 4629 | 中继：电脑不在线 / 电脑没有及时接起 / 中继的连接数或速率限制（见 [`apps/relay`](../apps/relay/README.md)） | 尝试其他路径，稍后重连 |
| 4404 | 本地 `/peer/<id>`：该电脑未配对（或已在本机移除）；`host.hello` 同时返回 `NOT_FOUND` | 不要重连 |
| 4502 | 本地 `/peer/<id>`：连不上那台电脑，或与它的连接中断（原因写在 reason 中） | 稍后重连 |

## 2. 握手与版本

连接后第一个请求必须是 `host.hello`；在其成功前，其他请求返回 `UNAUTHENTICATED`。10 秒内未完成握手的连接会被关闭。握手完成前 Host 按顺序处理帧，因此客户端可以在 `host.hello` 之后立即流水线发送请求。

```jsonc
{ "type": "req", "id": "h", "method": "host.hello", "params": {
  "protocolVersion": "1.30",
  "client": { "name": "pier-desktop", "version": "0.1.0", "platform": "darwin" },
  "token": "<本地 token>",       // 本地连接必填；远程连接由加密通道认证，不需要
  "coalesceMs": 50               // 可选：合并流式增量的窗口（0–1000ms，默认 0）
}}
// → { protocolVersion, host: HostInfo, connectionId, device?: { id, name } }   // device 仅远程连接
```

- 版本号为 `<major>.<minor>`，`PROTOCOL_VERSION` 由 `@pier/protocol` 导出。主版本不同 → `PROTOCOL_MISMATCH`；次版本只做向后兼容的新增（新方法、新可选参数、新事件），客户端必须忽略未知事件类型和未知字段。
- **本地 token**：Host 启动时生成（或取 `PIER_LOCAL_TOKEN`），通过 stdout 的 `pier.ready` 行交给 Tauri，并写入 `~/.pier/run/host.json`（0600）供本地调试工具使用。浏览器 WebSocket 无法设置请求头，所以 token 放在 `host.hello` 中而不是 URL 里（避免进入日志）。
- **远程连接**：握手已经认证了设备，`host.hello` 只再确认设备仍已登记；设备已被吊销时返回 `UNAUTHENTICATED`。远程连接收不到仅限本地的 Host 事件（§4.3）。
- **Origin 校验（本地连接）**：带 `Origin` 头的连接只允许 Tauri WebView 的来源（`tauri://localhost`、`http(s)://tauri.localhost`、开发时的 `http://localhost:1420`），其他网页在握手阶段即被拒绝（HTTP 403）。无 `Origin` 的连接（CLI）允许，但仍须 token。远程监听不检查 Origin（React Native 在 Android 上会自动附带），认证完全由加密通道完成。

## 3. 方法

参数中的 `sessionId` 均为 pi 会话 ID。标注 🔒 的方法仅本地桌面连接可调用（`LOCAL_ONLY_METHODS`），它们决定谁能连接这台电脑：设备、配对、远程访问与 `peer.*`，另外还有在本机回环地址上监听的 `loopback.*`（1.28）。其余方法对已配对的远程设备（手机和其他电脑）同样开放（1.10）：配对即完全信任，可以管理工作区与审批策略、编辑文件、配置服务商与模型、账号和扩展；1.9 及以前这些方法也仅限本地。

### host

| 方法 | 参数 | 结果 |
|---|---|---|
| `host.hello` | 见上 | `{ protocolVersion, host, connectionId }` |
| `host.info` | – | `HostInfo`（hostId、hostName、version、protocolVersion、platform、piVersion、agentDir） |
| `host.listDirectories` | `{ path?(绝对路径) }` | `HostDirectoryListing`：`{ path, parent?, home, separator, entries: { name, path, symlink? }[], truncated?, total? }`；列出 Host 上一个目录的子目录（含指向目录的符号链接），用于在其他电脑上选择工作区（1.10）。省略 `path` 时为用户主目录；`path` 不做 realpath，`parent` 在文件系统根目录时省略。按名称自然排序，最多 2000 项，超出时 `truncated: true` 并给出 `total`。相对路径或不是目录时 `BAD_REQUEST`，不存在时 `NOT_FOUND`，无权限时 `FORBIDDEN` |
| `host.stats` | – | `HostStats`：`{ sampledAt, platform, uptime(秒), cpu: { usage(0–1), cores, model?, loadAverage?[1/5/15 分钟] }, memory: { total, used }, disk?: { path, total, used, available }, network?: { rxRate, txRate, rxTotal, txTotal }, hostRss }`；Host 所在电脑的资源占用（1.12），大小单位为字节，速率为字节/秒。`cpu.usage` 与网络速率按与上一次采样的差值计算（上一次采样超过 10 秒时先取 0.4 秒的基线），1 秒内的重复调用共用一次采样。内存 `used` 不含可回收的缓存（Linux 为 `MemTotal - MemAvailable`，macOS 按 `vm_stat` 计算）；`disk` 为用户主目录所在的文件系统；`network` 统计物理网卡（Linux 上没有物理网卡时统计除回环外的全部网卡，macOS 为 `en*`，Windows 为 `netstat -e` 的总计），无法读取时省略；Windows 上没有 `loadAverage`；`hostRss` 为 Pier Host 进程的常驻内存。对已配对设备开放 |

### 应用更新（1.13）

Host 在桌面端中运行时（Tauri 以 `--watch-stdin` 启动 sidecar），通过 sidecar 的 stdio 驱动桌面端的更新器，让已配对的电脑和手机可以远程更新这台电脑上的 Pier。只会安装 GitHub 最新正式版中、用桌面端内置公钥校验过签名的更新包，更新地址不能由客户端指定。这些方法对已配对设备开放，远程调用 `update.install` 写入审计日志。

| 方法 | 参数 | 结果 |
|---|---|---|
| `update.status` | – | `AppUpdateStatus`：`{ state, currentVersion, autoCheck, version?, notes?, date?, downloaded, total?, error?, lastChecked?, installNeedsAuth? }`。`state` 为 `unsupported`（开发版本、未打包的构建、独立运行的 `pier-host`，或桌面端没有上报更新器）\|`idle`\|`checking`\|`upToDate`\|`available`\|`downloading`\|`installing`\|`error`；`version` / `notes` / `date` 为可安装的新版本（安装失败后仍保留，可重试）；`installNeedsAuth` 表示安装时需要有人在那台电脑上输入管理员密码（Linux `.deb` / `.rpm`） |
| `update.check` | – | `AppUpdateStatus`：立即检查一次（最长约 30 秒，客户端请放宽超时）。检查失败时返回 `state: "error"` 而不是错误响应 |
| `update.install` | – | `AppUpdateStatus`：还没有已知的新版本时先检查；有新版本时在后台开始下载，返回 `downloading`，之后 Host 与所有连接会随安装断开，桌面端安装完成后自动重启，客户端重连后在 `host.hello` 中看到新版本。已是最新版本时返回 `upToDate`，检查失败时返回 `error`，已在更新时返回当前状态。由远程设备发起时，Host 同时向本地连接发出 `host.notice`，告知谁在更新 |

没有可驱动的更新器时，`update.check` / `update.install` 返回 `UNSUPPORTED`，`update.status` 返回 `state: "unsupported"`；桌面端无法回答时返回 `INTERNAL`。更新器的每次状态变化（下载进度约每 200ms 一次）都以 `update.status` 事件发给所有连接。

sidecar 的 stdio 协议（每行一个 JSON 对象，stdout 上 `pier.ready` 之后）：Host 在 stdout 写 `{"type":"pier.shell.request","id","method":"update.check"|"update.install"}`，桌面端在 stdin 回 `{"type":"pier.shell.response","id","ok":true,"result":AppUpdateStatus}` 或 `{"type":"pier.shell.response","id","ok":false,"error"}`，并在 Host 就绪时和每次状态变化时推送 `{"type":"pier.shell.updateStatus","status":AppUpdateStatus}`（缺省字段为 `null`）。

### 终端（1.18）

Host 在桌面端中运行时，可以在它所在的电脑上用桌面端的伪终端启动用户的 shell（Unix 上为 `$SHELL` 登录 shell，Windows 上为 PowerShell），让已配对的电脑远程打开终端。桌面端在 Host 就绪时声明支持终端，此后 `HostInfo.terminals` 为 `true`；独立运行的 `pier-host`、旧版桌面端没有终端，`terminal.open` 返回 `UNSUPPORTED`。这些方法对已配对设备开放（配对即完全信任，远程终端与在那台电脑上登录等价），远程调用 `terminal.open` 写入审计日志（含目录，不记录输入内容）。

终端属于打开它的连接：输出和结束只发给这个连接，其他连接既看不到也不能操作（`NOT_FOUND`）；连接断开、Host 停止或桌面端退出时终端随之挂断，重连后不会恢复。每个连接最多 16 个、每个 Host 最多 64 个终端，超出时 `CONFLICT`。

| 方法 | 参数 | 结果 |
|---|---|---|
| `terminal.open` | `{ cwd?(绝对路径), cols, rows }` | `TerminalInfo`：`{ terminalId, shell, cwd }`。`cwd` 省略或不存在时从用户主目录启动；相对路径为 `BAD_REQUEST`，启动失败为 `INTERNAL`。`cols` / `rows` 为 2–1000。响应之前 shell 已经输出的内容在响应之后才以事件送达，所以客户端总是先拿到 `terminalId` |
| `terminal.write` | `{ terminalId, data, binary? }` | `{ written }`：写入输入（`data` 最长 1 MB，更长的粘贴请分段）。`binary` 表示每个字符是一个字节（xterm 的 `onBinary`）。终端已结束时 `written: false` 或 `NOT_FOUND` |
| `terminal.resize` | `{ terminalId, cols, rows }` | `{ resized }` |
| `terminal.close` | `{ terminalId }` | `{ closed }`：挂断 shell，随后收到 `terminal.exit` |

事件（§4.3）：`terminal.output` 带 `{ terminalId, data }`，`data` 为原始输出字节的 base64（UTF-8 字符可能跨两个事件）；`terminal.exit` 带 `{ terminalId, code, error? }`，之后不再有该终端的事件，`code` 为退出码（被信号结束或未知时为 `null`），`error` 表示终端丢失（例如桌面端退出）而不是程序结束。

输出有流量控制：某个连接待发送的数据超过约 2 MB 时（网络较慢），Host 让桌面端暂停读取该连接终端的输出（shell 写满伪终端缓冲区后阻塞），降到约 512 KB 以下再恢复，因此输出大量内容不会撑爆连接。

sidecar 的 stdio 协议：桌面端用 `--shell-terminals` 启动 Host，声明它能运行终端（这样在 Host 刚开始监听时就重连上来的电脑，`host.hello` 中也已经带有 `terminals`），并在 Host 就绪时再推送一次 `{"type":"pier.shell.capabilities","terminals":true}`。Host 用 `{"type":"pier.shell.request","id","method":"terminal.spawn","params":{"key","cwd"?,"cols","rows"}}` 启动 shell，桌面端回 `{"type":"pier.shell.response","id","ok":true,"result":{"id","shell","cwd"}}`；之后 Host 写 `{"type":"pier.shell.terminal","op":"write"|"resize"|"pause"|"resume"|"kill","id",…}`，桌面端推送 `{"type":"pier.shell.terminalOutput","key","data":"<base64>"}` 与最后一条 `{"type":"pier.shell.terminalExit","key","code"}`。`key` 由 Host 选定，所以在响应之前到达的输出也能对上终端；数字 `id` 用来发送输入。这些 shell 属于启动它们的那次 Host 运行，Host 停止、重启或崩溃时桌面端会把它们全部挂断。桌面窗口自己的内置终端与此无关，不经过 Host。

### workspace

| 方法 | 参数 | 结果 |
|---|---|---|
| `workspace.list` | – | `{ workspaces: WorkspaceInfo[] }` |
| `workspace.add` | `{ path(绝对路径), name?, policy? }` | `{ workspace }`；路径会取 realpath，重复添加返回已有项 |
| `workspace.remove` | `{ workspaceId }` | `{ removed }`；先强制关闭该工作区的活跃会话 |
| `workspace.setPolicy` | `{ workspaceId, policy: "ask"\|"smart"\|"auto" }` | `{ workspace }`；立即对活跃会话生效 |
| `workspace.files` | `{ workspaceId, path? }` | `WorkspaceFilesResult`：`{ path, entries: { name, path, kind: "file"\|"directory"\|"other", symlink?, size?, modifiedAt? }[], truncated?, total? }`；列出工作区中的一个目录（不递归）。`path` 为相对工作区根目录的路径（`/` 分隔，省略或 `""` 为根目录），绝对路径或含 `..` 时 `BAD_REQUEST`，目录（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，不存在时 `NOT_FOUND`。目录在前、再按名称自然排序，不列出 `.git`、`.hg`、`.svn`；每个目录最多返回 2000 项，超出时 `truncated: true` 并给出 `total`。指向工作区外目录的符号链接和失效链接为 `other`（1.5） |
| `workspace.readFile` | `{ workspaceId, path }` | `WorkspaceFileContent`：`{ path, size, modifiedAt, kind: "text"\|"image"\|"binary", text?, truncated?, data?, mimeType?, tooLarge? }`；读取工作区中的一个文件用于预览。`path` 的规则与 `workspace.files` 相同；文件（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，不存在时 `NOT_FOUND`，是目录或特殊文件时 `BAD_REQUEST`。`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp`/`.ico`/`.avif`/`.svg` 为 `image`，`data` 为 Base64（不含 `data:` 前缀），超过 8 MiB 时不返回 `data` 并设 `tooLarge: true`。其他文件按 UTF-8 解码为 `text`，最多返回前 512 KiB（超出时 `truncated: true`，被截断的多字节字符会被丢弃）；包含 NUL 字节或不是合法 UTF-8 的文件为 `binary`，不返回内容（1.7） |
| `workspace.writeFile` | `{ workspaceId, path, text, expectedModifiedAt? }` | `{ path, size, modifiedAt }`；用 UTF-8 文本覆盖工作区中一个已存在的文件（不会新建文件），`path` 与位置的规则同 `workspace.readFile`。文件原地写入，保留权限、属主和硬链接；原文件以 UTF-8 BOM 开头时（`workspace.readFile` 返回的 `text` 不含 BOM）会保留 BOM。`text` 最多 4 MiB（按 UTF-8 字节计）。给出 `expectedModifiedAt`（客户端读取时的 `modifiedAt`）且文件此后被修改过时不写入，返回 `CONFLICT`，`data.modifiedAt` 为磁盘上的当前修改时间；无写权限或只读文件系统时 `FORBIDDEN`（1.8） |
| `workspace.deletePath` | `{ workspaceId, path }` | `{ path, kind: "file"\|"directory"\|"other" }`；永久删除工作区中的一个文件、目录（连同其中所有内容）或符号链接，不进入废纸篓 / 回收站。`path` 的规则同 `workspace.files`，省略或指向工作区根目录（`""`、`.`）时 `BAD_REQUEST`；所在目录（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，不存在时 `NOT_FOUND`，无权限或只读文件系统时 `FORBIDDEN`。条目本身不跟随符号链接：删除符号链接只删除链接，不影响它指向的内容，`kind` 为 `other`。远程调用写入审计日志（1.11） |
| `workspace.readBytes` | `{ workspaceId, path, offset, length }` | `WorkspaceFileBytes = { path, size, modifiedAt, offset, data, eof }`；读取工作区中一个文件从 `offset` 开始的最多 `length`（1 B–4 MiB）个字节，`data` 为 Base64，用于分块下载任意文件（含二进制）。`path` 与位置的规则同 `workspace.readFile`。`size` / `modifiedAt` 是读取时文件的当前状态，客户端可据此发现文件在两块之间被修改；`eof` 表示 `data` 已到文件末尾，`offset` 超出文件大小时 `data` 为空、`eof: true`。只读，不写审计日志（1.21） |
| `workspace.uploadStart` | `{ workspaceId, path, size, overwrite? }` | `WorkspaceUploadStart = { uploadId, path, chunkBytes }`；开始把一个 `size` 字节的文件上传到工作区中的 `path`（1.21）。`path` 的规则同 `workspace.files`；缺少的上级目录会被创建，已有的上级目录（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，是文件时 `BAD_REQUEST`。目标已是目录时 `CONFLICT`（`data.kind: "directory"`）；目标已是文件（或符号链接）且未给 `overwrite: true` 时 `CONFLICT`（`data.kind: "file"`）。数据先写入目标目录中的隐藏临时文件 `.<名称>.<id>.pier-upload`，完成后才替换为真实名称。`chunkBytes` 是一次 `uploadChunk` 最多接受的字节数（4 MiB），文件最大 16 GiB。每个连接最多同时 8 个上传；上传属于发起它的连接，该连接断开或 5 分钟未收到数据时自动取消并删除临时文件。远程调用写入审计日志 |
| `workspace.uploadChunk` | `{ uploadId, offset, data }` | `{ received }`；向上传追加 Base64 数据（1.21）。`offset` 必须等于已收到的字节数，否则 `CONFLICT`（`data.received` 为已收到的字节数，可据此续传）；超过 `chunkBytes` 或累计超过 `size` 时 `BAD_REQUEST`；上传不存在、已过期或属于其他连接时 `NOT_FOUND`；同一上传同时只处理一个请求 |
| `workspace.uploadFinish` | `{ uploadId }` | `{ path, size, modifiedAt }`；把收齐的上传移动到目标路径（1.21）。未收齐时 `BAD_REQUEST`（`data.received`），上传保留可继续；目标在上传期间变成目录，或未给 `overwrite` 而目标已出现时 `CONFLICT`，上传被丢弃。远程调用写入审计日志 |
| `workspace.uploadCancel` | `{ uploadId }` | `{ cancelled }`；取消上传并删除已收到的数据（1.21）。上传不存在或属于其他连接时 `cancelled: false` |

`workspace.previewFile`（1.31）：参数 `{ workspaceId, path }`，返回 `WorkspaceFileContent`，用于聊天和 Markdown 中的图片、文件链接。相对路径以工作区根目录为基准，允许 `.` / `..`，但解析符号链接后必须仍在工作区内；绝对路径必须位于工作区或 Host 的系统临时目录（`os.tmpdir()`，Unix 另含 `/tmp`、`/var/tmp`）中。`file://`、URL 编码和行号后缀由客户端转成文件路径。目录及特殊文件返回 `BAD_REQUEST`，越界返回 `FORBIDDEN`，不存在返回 `NOT_FOUND`；图片、文本大小限制与 `workspace.readFile` 相同。该只读方法可经已认证的远程连接调用，不改变 `workspace.readFile` 及所有写入、下载方法的路径规则。

`workspace.authorizeFilePreview`（本机 1.33，已配对设备 1.35）：参数 `{ workspaceId, path, expectedRealPath }`，返回 `WorkspaceFileContent`。当预览返回 `FORBIDDEN` 且 `data.reason` 为 `OUTSIDE_ALLOWED_ROOTS` 时，客户端显示文件所在电脑与 `data.resolvedPath`，由用户确认后将该实际路径作为 `expectedRealPath` 传入。Host 重新解析文件路径，若与确认路径不一致则返回 `CONFLICT`（`PREVIEW_TARGET_CHANGED`）；否则按相同类型与大小限制只读取这一次。不会保存文件或目录授权，刷新及重新打开须重新确认，系统读取权限错误不能用此方法绕过。远程调用写入审计日志，仅记录工作区、请求路径与确认的实际路径，不记录文件内容。

### Git 源代码管理（1.28）

Host 用它所在电脑上的 `git` 命令行（`PATH` 中的，或环境变量 `PIER_GIT` 指定的绝对路径）管理工作区所在的 Git 仓库，供桌面端右侧面板的「源代码管理」使用。仓库是工作区所在的工作树（工作区可以是仓库的子目录，此时操作整个仓库）；以下 `path` / `paths` 都是相对**仓库根目录**的路径（`/` 分隔，绝对路径或含 `..` 时 `BAD_REQUEST`），按字面匹配（`GIT_LITERAL_PATHSPECS`），不作为通配符。Git 以参数数组直接运行（不经过 shell），在仓库根目录中执行，不继承 `GIT_DIR` 等指向其他仓库的环境变量，并且没有终端：`GIT_TERMINAL_PROMPT=0`，类 Unix 系统上在新会话中运行，凭据或主机密钥需要交互输入时直接失败而不是等待（凭据助手、SSH agent 照常可用）。改变仓库的命令在同一仓库上依次执行。Git 返回非零退出码时为 `CONFLICT`，`message` 为 Git 的输出（去掉 `hint:` 行），`data.exitCode` 为退出码；运行超时（本地命令 60 秒，`commit` 与网络命令 5 分钟）时 `CONFLICT`。工作区不在仓库中时除 `git.status` / `git.init` 外返回 `NOT_FOUND`，没有安装 Git 时返回 `UNSUPPORTED`。对已配对设备开放，远程调用改变仓库的方法写入审计日志（只记录路径数量、分支名，不记录提交信息）。

| 方法 | 参数 | 结果 |
|---|---|---|
| `git.status` | `{ workspaceId }` | `GitStatus = { repository, gitMissing?, root?, prefix?, branch?, head?, upstream?, ahead?, behind?, remotes?, operation?, files?, truncated? }`。不在仓库中时 `{ repository: false }`，没有安装 Git 时另有 `gitMissing: true`。`root` 为仓库根目录的绝对路径，`prefix` 为工作区相对 `root` 的路径（`""` 为根目录）；`branch` 为当前分支（HEAD 游离时省略），`head` 为 HEAD 的完整哈希（还没有提交时省略），`upstream` / `ahead` / `behind` 为上游分支及领先、落后的提交数；`remotes` 为远程仓库名；`operation` 为进行中的 `merge`\|`rebase`\|`cherry-pick`\|`revert`\|`bisect`。`files: GitFileStatus[] = { path, origPath?, index, worktree, conflict?, submodule? }` 来自 `git status --porcelain=v2 --untracked-files=all`，`index` / `worktree` 为暂存区与工作区一侧的状态字母（`.` 未改变，`M` `T` `A` `D` `R` `C` `U`），未跟踪的路径两侧均为 `?`，冲突路径带 `conflict: true`，`origPath` 为重命名或复制前的路径；最多 5000 项，超出时 `truncated: true` |
| `git.diff` | `{ workspaceId, path, origPath?, staged? }` | `GitDiffResult = { diff, truncated? }`；一个路径的统一差异（`git diff` 的输出，最多 2 MiB，超出时 `truncated: true`）。`staged` 时为暂存区相对 HEAD，否则为工作区相对暂存区；未跟踪的文件显示为整个新增；`origPath` 让暂存的重命名作为一个文件比较 |
| `git.log` | `{ workspaceId, limit?(50, ≤500), skip? }` | `{ commits: GitCommitInfo[] }`，`GitCommitInfo = { hash, shortHash, subject, authorName, authorEmail, date, refs?, parents }`；从 HEAD 可达的提交，新的在前，`refs` 为 `git log --format=%D` 的引用名，`date` 为作者时间（ISO 8601）。还没有提交时为空 |
| `git.show` | `{ workspaceId, commit }` | `GitDiffResult`；一个提交（4–64 位十六进制哈希）的完整信息、变更统计与差异（`git show --stat --patch --format=fuller`，最多 2 MiB）。提交不存在时 `NOT_FOUND` |
| `git.branches` | `{ workspaceId }` | `{ branches: GitBranchInfo[] }`，`GitBranchInfo = { name, remote, current?, upstream?, ahead?, behind?, upstreamGone?, shortHash, subject, date }`；本地分支与远程跟踪分支（不含 `<远程>/HEAD`），按最近提交时间排序 |
| `git.stage` | `{ workspaceId, paths? }` | `GitCommandResult = { output }`；暂存路径（`git add -A`，包括删除），省略 `paths` 时暂存所有更改。暂存冲突路径即标记为已解决。`paths` 最多 20000 项 |
| `git.unstage` | `{ workspaceId, paths? }` | `{ output }`；取消暂存路径（`git reset`；还没有提交时从暂存区移除），省略 `paths` 时取消暂存所有更改 |
| `git.discard` | `{ workspaceId, paths }` | `{ output }`；放弃路径在工作区中的更改：已跟踪的文件恢复为暂存区中的内容，未跟踪的文件被删除（`git clean -f`），没有更改的路径被忽略。无法撤销 |
| `git.commit` | `{ workspaceId, message, amend?, all? }` | `GitCommitResult = { hash, output }`；提交暂存区，`all` 时先暂存已跟踪文件的更改（`git commit -a`），`amend` 时修改上一个提交（`message` 为空则保留原提交信息）。不修改时 `message` 不能为空（`BAD_REQUEST`）。会运行仓库的提交钩子 |
| `git.checkout` | `{ workspaceId, branch, create?, startPoint? }` | `{ output }`；切换到本地分支（`git switch`）。`branch` 为远程跟踪分支（如 `origin/x`）时切换到本地分支 `x`，没有时新建并跟踪它；`create` 时新建分支 `branch`（从 `startPoint`，默认 HEAD）并切换。分支名不能以 `-` 开头或含空白，且须通过 `git check-ref-format --branch`，否则 `BAD_REQUEST`；分支不存在时 `NOT_FOUND`。未提交的更改与目标分支冲突时 Git 拒绝切换（`CONFLICT`） |
| `git.deleteBranch` | `{ workspaceId, branch, force? }` | `{ output }`；删除本地分支（`git branch -d`，`force` 时 `-D`，即使没有合并）。不能删除当前分支 |
| `git.fetch` | `{ workspaceId }` | `{ output }`；抓取所有远程仓库并清理已删除的远程分支（`git fetch --all --prune`） |
| `git.pull` | `{ workspaceId, rebase? }` | `{ output }`；从上游拉取当前分支（`git pull --no-edit`，`rebase` 时 `--rebase`），合并方式否则遵循仓库配置 |
| `git.push` | `{ workspaceId, force? }` | `{ output }`；推送当前分支（`force` 时 `--force-with-lease`）。还没有上游时推送到 `origin`（没有时用第一个远程仓库）的同名分支并设为上游；HEAD 游离或没有远程仓库时 `CONFLICT` |
| `git.stash` | `{ workspaceId, action: "push"\|"pop", message? }` | `{ output }`；储藏所有更改（包括未跟踪的文件），或应用并删除最近的储藏 |
| `git.init` | `{ workspaceId }` | `{ output }`；在工作区目录中新建仓库。工作区已在仓库中时 `CONFLICT` |

### Agent 运行时（1.22）

一个 Host 可以运行多种 Agent：内置的 **pi**（`pi`），以及这台电脑上安装的 **Claude Code**（`claude-code`，通过 Claude Agent SDK 驱动用户自己的 `claude` CLI 与登录）和 **Codex**（`codex`，通过 `codex app-server` 驱动用户自己的 `codex` CLI 与登录）。以后可以接入更多运行时。不同运行时的会话在同一个工作区中并存，事件、快照、审批与断线恢复都使用同一套协议：非 pi 运行时把自己的输出转换成 pi 形态的消息与事件（见 §4.1），常用工具映射到 pi 的工具名与参数（Claude Code 的 `Bash` / `Read` / `Write` / `Edit` / `Grep` / `Glob` 分别为 `bash` / `read` / `write` / `edit` / `grep` / `find`；Codex 的命令执行为 `bash`、文件修改为 `edit` 或 `write` 并带 diff），客户端无需区分。

| 方法 | 参数 | 结果 |
|---|---|---|
| `runtime.list` | `{}` | `{ runtimes: AgentRuntimeInfo[] }`；`AgentRuntimeInfo = { id, name, available, reason?, version?, executable?, capabilities }`。`available` 表示能新建会话（CLI 已安装；登录状态在使用时才检查），不可用时 `reason` 说明原因。CLI 依次从 `PIER_CLAUDE_PATH` / `PIER_CODEX_PATH`、用户级公共安装（旧版 Pier 独立安装作为兼容回退）、`PATH` 与常见安装目录中查找 |
| `runtime.installStatus`（1.32） | `{ runtime: "claude-code" \| "codex", refresh?: boolean }` | `{ installation: AgentInstallationStatus, agent: AgentRuntimeInfo }`；`refresh: true` 重新运行版本探测，其余请求使用缓存 |
| `runtime.install`（1.32） | `{ runtime: "claude-code" \| "codex" }` | 同上；异步启动官方最新原生 CLI 的安装或更新，立即返回。不能指定下载地址、路径或命令；同一运行时已有安装任务时返回 `CONFLICT`，显式路径覆盖存在时也返回 `CONFLICT` |

`AgentInstallationStatus = { runtime, state: "idle" | "checking" | "downloading" | "verifying" | "installing" | "ready" | "error", version?, downloadedBytes?, totalBytes?, error? }`。客户端通过 `runtime.installStatus` 轮询进度，连接断开不影响任务；Host 退出会取消安装并清理暂存文件。仅支持 x64 / arm64 的 Windows、macOS、Linux。Claude Code 使用官方原生二进制和平台清单，Codex 使用官方完整原生发行包（含辅助程序），两者都校验 SHA-256 并运行 `--version` 验证后才更新用户级公共命令（`~/.local/bin`），并配置用户 `PATH`；外部终端重新打开后与 Pier 共用安装。程序按版本保存在 `~/.local/share/claude/versions` / `~/.local/share/codex/versions`。失败时恢复旧命令，配置、凭据与会话目录保留；Windows 程序被占用时提示关闭相关会话后重试。旧版 Pier 独立安装在下次更新时迁移，已经是最新版也会迁移；公共安装已经是最新版时检查 `PATH` 后返回 `ready`。成功安装广播 `{ type: "runtime.changed", runtime }`，客户端应刷新 Agent 列表；该事件不含凭据。已打开的 Codex 会话保留原来的 app-server 进程，全部关闭后才切换到新版。这两个方法向已配对设备开放，远程 `runtime.install` 记录运行时名称到审计日志。

`capabilities: AgentRuntimeCapabilities = { steer, followUp, compact, fork, rename, setModel, thinking, reload, images, piExtensions }`：客户端据此隐藏会失败的操作。不支持的方法返回 `UNSUPPORTED`（例如 Claude Code / Codex 会话的 `session.reload`）。`piExtensions` 为 `false` 的运行时不加载 pi 的扩展、技能、提示词模板与 `settings.json`，扩展或设置变更后 Host 也不会重新加载这些会话。

各运行时的差异：

- **模型**：`model.list` 按会话（或 `runtime` 参数）的运行时列出模型，`ModelInfo.provider` 为 `claude-code` / `codex`。Claude Code 的模型与斜杠命令来自 CLI（Host 启动一次不发送消息的 CLI 读取，缓存 10 分钟）；Codex 的来自 `model/list`。`model.set` 只接受本运行时的模型，`persist` 被忽略。思考等级对应 Claude Code 的 effort（`off` 关闭思考）与 Codex 的 reasoning effort。
- **审批**：工作区策略同样适用。Claude Code 自己放行的调用（如只读工具、设置中允许的命令）不再询问；它请求许可时，受策略约束的工具（`bash`、`write`、`edit`）按策略决定，其他工具（`WebFetch`、MCP 工具等）在非 `auto` 策略下询问用户；`AskUserQuestion` 以 `select` 请求逐个提问。Codex 按策略设置审批与沙箱：`ask` → `untrusted` + `workspace-write`，`smart` → `on-request` + `workspace-write`，`auto` → `never` + `danger-full-access`；它请求执行命令、修改文件或更多权限时，按策略决定或询问用户（"本会话内允许"对应 Codex 的 `acceptForSession`）。
- **会话存储**：Claude Code 会话在 `~/.claude/projects`（或 `CLAUDE_CONFIG_DIR`），Codex 会话由 Codex 管理（`~/.codex/sessions`）。`session.list` 列出 cwd 与工作区路径相同的会话，包括在终端中创建的，都可以在 Pier 中继续。`session.delete` 对 Claude Code 会话同样移到 Pier 回收站；对 Codex 会话调用 Codex 的归档（`thread/archive`，可在 Codex 中恢复）。`messageCount` 为估算值。
- **排队**：Claude Code 的 steer / followUp 直接交给 CLI 的消息队列；Codex 的 steer 并入当前回合（`turn/steer`），followUp 由 Host 排队，在当前回合结束后依次发送。
- **压缩**：Claude Code 发送 `/compact`，Codex 调用 `thread/compact/start`；两者的 `summary` 为空字符串。
- **分叉**：Claude Code 用 SDK 的 `forkSession`，Codex 用 `thread/fork`（`position: "at"` 时包含该用户消息所在的整个回合）。
- **进程**：Claude Code 会话在首次发送消息时启动 CLI，空闲 10 分钟后停止（之后自动恢复会话）；所有 Codex 会话共用一个 `codex app-server` 进程，没有打开的 Codex 会话 5 分钟后停止。

### session

| 方法 | 参数 | 结果 |
|---|---|---|
| `session.list` | `{ workspaceId }` | `{ sessions: SessionSummary[] }`，按修改时间倒序，包含所有可用运行时的会话（1.22 起每项带 `runtime`）；活跃会话 `active: true` 并带实时 `state` 与 `pendingUi`（待回答的对话框 / 审批数，1.1）；已归档的会话带 `archived: true`（1.14），未归档时省略该字段 |
| `session.create` | `{ workspaceId, name?, runtime? }` | `{ session }`（已进入活跃池）；`runtime`（1.22）选择 Agent 运行时，默认 `pi`；未知运行时 → `NOT_FOUND`，不可用（CLI 未安装）→ `CONFLICT` |
| `session.open` | `{ workspaceId, sessionId }` 或 `{ workspaceId, path }` | `{ session }`；`path` 必须出现在该工作区的会话列表中 |
| `session.close` | `{ sessionId, force? }` | `{ closed }`；运行中且未 `force` → `CONFLICT` |
| `session.delete` | `{ workspaceId, sessionId, force? }` | `{ deleted }`；关闭会话（`session.closed { reason: "deleted" }`）并把会话文件移到 `~/.pier/trash/sessions/<时间戳>-<文件名>`（可手动移回恢复）。活跃会话属于其他工作区 → `NOT_FOUND`；工作区中没有该会话 → `{ deleted: false }`；运行中且未 `force`，或会话正被其他 Pier Host 打开 → `CONFLICT`。从未写入磁盘的新会话只会被关闭；分叉出的子会话不受影响（1.6） |
| `session.archive` | `{ workspaceId, sessionId, archived }` | `{ session }`；归档（`archived: true`）或取消归档会话（1.14）。归档只是 Host 记录在 `~/.pier/archived-sessions.json` 中的标记，不修改会话文件，也不关闭会话，归档后的会话照常可以打开和继续对话；分叉出的新会话不继承归档状态，`session.delete` 会同时清除标记。会话既不在活跃池中也不在该工作区的会话列表中 → `NOT_FOUND`（属于其他工作区的活跃会话同样）。成功后广播 `session.listChanged` |
| `session.cleanup` | `{ workspaceId, action: "archive"\|"delete", modifiedBefore?, scope?: "all"\|"archived"\|"unarchived", dryRun? }` | `{ sessionIds, skipped: { sessionId, reason: "running"\|"locked"\|"error", message? }[] }`；批量归档或删除工作区中的会话（1.14）。选中 `modifiedAt` 早于 `modifiedBefore`（带时区的 ISO 8601 时间，省略时不限时间）且符合 `scope`（默认 `all`）的会话；`archive` 时已归档的会话不计入。`delete` 与 `session.delete` 相同（移到 `~/.pier/trash/sessions`），但运行中或有待回答请求的会话一律跳过（`running`），被其他 Pier Host 打开的会话跳过（`locked`）；`archive` 不跳过运行中的会话。`sessionIds` 为已处理的会话，`dryRun: true` 时只返回将要处理和将被跳过的会话而不做修改（`locked` 只有实际执行时才能发现）。有会话被处理时广播 `session.listChanged` |
| `session.forkPoints` | `{ sessionId }` | `{ points: { entryId, text }[] }`（可 fork 的用户消息） |
| `session.fork` | `{ sessionId, entryId, position?: "before"\|"at" }` | `{ session, selectedText? }`；生成**新**会话，原会话不变 |
| `session.rename` | `{ sessionId, name }` | `{ session }` |
| `session.subscribe` | `{ sessionId, sinceSeq?, epoch?, known?: { count, fingerprint } }`（`known` 1.27） | `{ mode: "replay"\|"snapshot", currentSeq, epoch }`，见 §5 |
| `session.unsubscribe` | `{ sessionId }` | `{ unsubscribed }` |
| `session.snapshot` | `{ sessionId }` | `SessionSnapshot`（一次性读取，不影响订阅） |
| `session.commands` | `{ sessionId }` | `{ commands: { name, description?, argumentHint?, source: "extension"\|"prompt"\|"skill" }[] }`；会话的 Agent 运行时在 `session.prompt` 中处理的斜杠命令：扩展命令、提示词模板和 `skill:<名称>`（pi 设置 `enableSkillCommands: false` 时不列出 skill，但手动输入仍然有效）。`name` 不含开头的 `/`（1.5） |
| `session.reload` | `{ sessionId }` | `{ reloaded: true }`；重新加载 settings、扩展、skills、提示词模板、主题与上下文文件，相当于 pi 的 `/reload`。Agent 运行中或有待回答的对话框时 → `CONFLICT`（1.5） |

### 运行

| 方法 | 参数 | 结果 |
|---|---|---|
| `session.prompt` | `{ sessionId, text, images?, streamingBehavior? }` | `{ accepted: true }`，在 pi 接受 prompt 后立即返回，输出通过事件流给出。会话运行中且未指定 `streamingBehavior` → `CONFLICT` |
| `session.steer` | `{ sessionId, text, images? }` | `{ queue }` |
| `session.followUp` | `{ sessionId, text, images? }` | `{ queue }` |
| `session.abort` | `{ sessionId }` | `{ aborted: true }`，在会话回到空闲后返回 |
| `session.compact` | `{ sessionId, instructions? }` | `{ summary, tokensBefore }`，压缩完成后返回（可能较慢，客户端应放宽超时） |

`images`：`{ type: "image", data: <base64>, mimeType: "image/…" }[]`，最多 16 张；单帧上限 64 MiB。

#### 斜杠命令

`session.prompt` 的文本以 `/` 开头时，由 pi 按以下顺序处理：扩展命令（立即执行，运行中也可以，不会进入对话）→ `/skill:<名称> [参数]`（展开为 skill 内容）→ `/<模板> [参数]`（展开为提示词模板）→ 其余原样作为普通消息发给模型。可用的命令用 `session.commands` 列出。扩展命令被识别后 `session.prompt` 立即返回 `{ accepted: true }`，不等待命令结束（命令可能在等待 `ui.request` 的回答）；命令的错误以 `extension.error` 事件给出。

`session.steer` / `session.followUp` 会展开 skill 与模板，但不执行扩展命令；运行中发送命令请用带 `streamingBehavior` 的 `session.prompt`。

pi 终端界面自带的命令（`/model`、`/compact`、`/new`、`/fork`、`/name`、`/reload` 等）不经过 `session.prompt`：Pier 客户端在本地识别它们，改为调用对应的协议方法（`model.set`、`session.compact`、`session.create`、`session.fork`、`session.rename`、`session.reload`），无法识别的命令提示“未知命令”而不发送。共用的解析与执行逻辑在 `@pier/chat-state` 的 `slash.ts`。

### 模型

| 方法 | 参数 | 结果 |
|---|---|---|
| `model.list` | `{ sessionId?, workspaceId?, runtime? }` | `{ models: ModelInfo[], current?, thinkingLevel? }`（仅列出已配置凭据的模型）。带 `sessionId` 时列出该会话运行时的模型，否则列出 `runtime`（1.22，默认 `pi`）的模型。带 `sessionId` 时 `current` / `thinkingLevel` 是该会话的模型与思考等级；只带 `workspaceId` 时（1.19）是在该工作区新建会话时会使用的模型与思考等级（与 pi 的解析一致：有凭据的默认模型，否则第一个可用模型；思考等级依次取该模型的设置、默认思考等级、`medium`，再按模型能力钳制），供新建会话前在输入框中选择模型；都不带时只返回 `models` |
| `model.set` | `{ sessionId, provider, modelId, persist? }` | `{ model }`；`persist: true` 写入 pi 全局默认值 |
| `thinking.set` | `{ sessionId, level, persist? }` | `{ level }`（按模型能力钳制后的实际等级） |
| `model.setDefault` | `{ provider, modelId }` | `{ defaultModel }`；写入 pi 全局 settings，只影响新会话（1.2） |

### 服务商与凭据（1.2）

直接在 Pier 中配置模型，无需安装 pi CLI。凭据写入 pi 的 `auth.json`，自定义接口写入 `models.json`（都在 `agentDir` 中，与终端里的 pi 共用）。结果中不包含任何密钥；1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放。

| 方法 | 参数 | 结果 |
|---|---|---|
| `provider.list` | – | `ProviderListResult`：`{ providers: ProviderInfo[], defaultModel?, defaultAvailable, availableCount, agentDir, error? }`。`ProviderInfo` 含登录方式（`apiKey` / `oauth`）、凭据状态与来源、模型数量，自定义接口另有 `custom`（不含密钥，只有 `hasConfiguredKey`） |
| `provider.login` | `{ providerId, method: "api_key"\|"oauth" }` | `{ flowId }`；随后本连接收到 `auth.*` 事件（见 §4.3）。同一连接再次调用会取消之前的登录 |
| `provider.loginRespond` | `{ flowId, promptId, value?, cancelled? }` | `{ accepted }`；回答 `auth.prompt`，`cancelled: true` 取消整个登录 |
| `provider.loginCancel` | `{ flowId }` | `{ cancelled }` |
| `provider.logout` | `{ providerId }` | `{ removed }`；删除 pi 当前使用的凭据：优先删除 `auth.json` 中保存的凭据；没有时，如果密钥来自 `models.json` 里该服务商的 `apiKey`（明文密钥或 `!命令`），则删除这个字段（只剩 `name` 的条目整项删除，pi 无法加载时回滚并返回 `BAD_REQUEST`）。不影响环境变量及 `$VAR` 形式的引用 |
| `provider.saveCustom` | `{ provider: CustomProvider, apiKey?, apiKeyRef?, create? }` | `{ provider, defaultModel? }`；`CustomProvider = { id, name?, api, baseUrl, models: { id, name?, reasoning?, images?, contextWindow?, maxTokens?, api? }[] }`，`api` 为 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` 之一。模型的 `api`（1.7）表示该模型使用与服务商不同的接口：写入 `models.json` 时同时写入该模型的 `api` 和按服务商 Base URL 换算的 `baseUrl`（去掉末尾的 `/v1` / `/v1beta` 得到根地址，OpenAI 类接口加 `/v1`，Anthropic 用根地址，Google 加 `/v1beta`）；改回服务商的接口时一并删除换算出的 `baseUrl`。只改动表单涉及的字段，文件中的其他内容保留（含注释的文件先备份为 `models.json.bak`）；pi 无法加载时回滚并返回 `BAD_REQUEST`。新建时必须提供 `apiKey`（或 1.3 起的 `apiKeyRef`，见下文 NewAPI），编辑时省略则保留原密钥 |
| `provider.removeCustom` | `{ providerId }` | `{ removed }`；同时删除保存的密钥 |
| `provider.probeModels` | `{ api, baseUrl, apiKey?, apiKeyRef?, providerId? }` | `{ models: CustomModel[] }`；请求接口的模型列表（OpenAI：`GET <baseUrl>/models`）。省略 `apiKey` 时使用 `apiKeyRef`（1.3）或 `providerId` 已保存的密钥。1.6 起，pi 内置模型目录认识的模型会带上 `reasoning` / `images` / `contextWindow` / `maxTokens`；1.7 起，NewAPI 站点在模型列表中给出 `supported_endpoint_types` 时，与 `api` 不同的推荐接口会作为模型的 `api` 返回 |

**模型能力自动识别（1.6）**：`GET /models` 只返回模型 ID，因此 Host 会按 pi 内置的模型目录补全能力。ID 会先规范化再匹配：统一小写，去掉 `anthropic/` 这类前缀和 `:free` 这类标签，忽略日期后缀（`-20250929`）以及 `4.5` / `4-5` 的写法差异；`-thinking` / `-nothinking` 后缀分别视为推理 / 非推理变体。目录里没有的模型，只按常见推理系列的名称推断 `reasoning` 和 `images`，其他仍视为未知。`provider.saveCustom` 保存时，模型中未设置（省略）的字段按此补全；显式传入的值（包括 `reasoning: false`、`images: false`）保持不变，并原样写入 `models.json`。Host 启动时也会为 `models.json` 中自定义服务商（不含内置服务商的覆盖配置）缺少 `reasoning`、`input`、`contextWindow`、`maxTokens` 的模型补全这些字段，已有字段不会改动；pi 因此无法加载时回滚。服务商配置变化后，已打开的会话会重新解析当前模型并发送 `session.model`；如果模型刚被识别为推理模型、而会话的思考等级是 `off`，会改用配置的默认思考等级。

登录、保存或删除后，如果当前默认模型不可用，Host 会自动把默认模型设为刚配置的服务商的第一个可用模型，并在结果中返回 `defaultModel`。

### NewAPI 登录（1.3）

登录 [NewAPI](https://github.com/QuantumNous/new-api) 中转站，读取令牌和可用模型，再用 `provider.saveCustom` 保存为自定义接口。登录会话只保存在 Host 内存中，只属于发起的连接；连接断开、调用 `newapi.close` 或 30 分钟未使用后丢弃。令牌密钥由 Host 直接读取，客户端只拿到 `keyRef`，可在同一连接的 `provider.saveCustom` / `provider.probeModels` 中代替 `apiKey`。1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放（浏览器授权回到 Host 所在电脑的回环地址，只适合在那台电脑上使用）。

**模型接口识别（1.7）**：NewAPI 的 `GET /v1/models` 为每个模型列出 `supported_endpoint_types`（服务该模型的所有渠道的并集：Anthropic 渠道为 `anthropic`、`openai`，Gemini 渠道为 `gemini`、`openai`，Codex 渠道只有 `openai-response`，NewAPI / Sub2API 这类透传渠道为全部类型）。Host 据此给出模型的 `api`：支持 `anthropic` 的 Claude 模型（ID 中含 `claude`），以及只支持 `anthropic` 的模型，用 `anthropic-messages`；其余支持 `openai` 的用 `openai-completions`，只支持 `openai-response` 的用 `openai-responses`，只支持 `gemini` 的用 `google-generative-ai`；都不支持（如嵌入模型）时省略。不返回该字段的旧版本只按名称把 Claude 模型识别为 `anthropic-messages`。客户端保存时，把与服务商 `api` 不同的推荐接口写入模型的 `api`。

同时支持当前版本的仪表盘登录（登录返回 Bearer 访问令牌，可选的 RSA 密码加密、`/api/user/login/verify` 两步验证）和旧版本的 Cookie 会话（`New-Api-User` 请求头、`/api/user/login/2fa`）。开启 Turnstile 或只能第三方登录的站点，改用「系统访问令牌」。

| 方法 | 参数 | 结果 |
|---|---|---|
| `newapi.login` | `{ baseUrl, username, password }` 或 `{ baseUrl, accessToken, userId? }` | `NewApiLoginResult`：`{ status: "ok", sessionId, account }` 或需要两步验证时 `{ status: "verify", sessionId, methods }`。`baseUrl` 可以带 `/v1`、`/console/...` 等路径，Host 会规范为站点根地址。`account = { site: { name, url, version?, logo? }, user: { id?, username, displayName?, group? }, tokens: NewApiToken[], groups: { name, description?, ratio? }[] }`，`NewApiToken = { id, name, maskedKey, status, group?, expiresAt?, unlimitedQuota, remainQuota?, modelLimits? }`（`status`：1 启用、2 禁用、3 过期、4 额度用尽） |
| `newapi.verify` | `{ sessionId, code }` | `NewApiLoginResult`；提交两步验证码（或备用码） |
| `newapi.createToken` | `{ sessionId, name, group? }` | `{ tokenId, tokens }`；新建无限额度、永不过期、不限模型的令牌 |
| `newapi.useToken` | `{ sessionId, tokenId }` | `{ keyRef, models: { id, api? }[], modelsError? }`；读取令牌密钥（`POST /api/token/:id/key`，旧版本从令牌列表读取），并用它请求 `GET /v1/models`。`api`（1.7）是推荐的调用接口，见下文「模型接口识别」 |
| `newapi.close` | `{ sessionId }` | `{ closed }`；丢弃登录，并退出 Host 用密码建立的仪表盘会话（不会吊销用户自己的访问令牌） |

#### 浏览器授权（1.4）

站点开启 NewAPI「应用授权」（`/api/status` 返回 `app_authorization_enabled: true`）时，可以不经过 Pier 输入任何凭据：用户在浏览器中用站点支持的任意方式登录（包括 GitHub、LinuxDO、Passkey 等），在站点的授权页面确认后，站点为 Pier 新建一个令牌。流程是面向原生应用的 OAuth 2.0 授权码流程（RFC 8252 回环重定向 + RFC 7636 PKCE S256）：

1. `newapi.authorizeStart` 让 Host 在 `127.0.0.1` 的随机端口监听 `/callback`，生成 `state` 与 `code_verifier`，返回站点的授权页面地址 `authorizeUrl`（`<site>/app-auth?client_name=Pier&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&key_name=…`）；
2. 客户端在系统浏览器中打开 `authorizeUrl`，并调用 `newapi.authorizeWait` 等待；
3. 用户同意后浏览器跳回回环地址，Host 校验 `state`，用授权码和 `code_verifier` 调用站点的 `POST /api/app-auth/token` 换取令牌密钥，再读取模型列表；`state` 不符的请求返回 400 且不影响流程，用户拒绝（`error=access_denied`）时流程结束。

因为浏览器会跳回 Host 所在电脑的回环地址，所以只适用于本地 UI；流程只属于发起的连接，10 分钟未完成、连接断开或调用 `newapi.authorizeCancel` 时结束并关闭端口。

| 方法 | 参数 | 结果 |
|---|---|---|
| `newapi.authorizeStart` | `{ baseUrl }` | `{ flowId, authorizeUrl, site, expiresAt }`；站点未开启应用授权时 `BAD_REQUEST` |
| `newapi.authorizeWait` | `{ flowId }` | `{ site, user, token: { id, name, group?, maskedKey }, keyRef, models, modelsError? }`；用户在浏览器中同意后返回，`keyRef` 与 `newapi.useToken` 的相同。拒绝、超时、取消或换取失败时返回错误 |
| `newapi.authorizeCancel` | `{ flowId }` | `{ cancelled }` |

### 个人中心（1.6）

桌面端「设置 → 个人中心」直连云链API（默认 `https://api.yunnet.top`，协议里的 `YUNLIAN_SITE_URL`；测试时可以用 `PierHostOptions.accountSite` / `accountLines` 或 `faux-host --account-site` 换成其他 NewAPI 站点）。与连接绑定的 `newapi.*` 不同，这里的登录属于 Host：所有连接共用，并保存在 Pier 目录的 `account.json`（仅当前用户可读），重启后仍然有效。密码登录只保存站点发放的刷新 Cookie（`new_api_refresh`，站点每次刷新都会轮换，登录 30 天后需要重新登录），不保存密码和 15 分钟有效的访问令牌；Host 在访问令牌过期前或被拒绝时用 `POST /api/user/auth/refresh` 自动换新。用系统访问令牌登录时保存该令牌。站点拒绝刷新（已退出、被吊销或账号安全信息改变）时，Host 删除保存的登录，之后的调用返回「请先登录」。1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放。

| 方法 | 参数 | 结果 |
|---|---|---|
| `account.status` | — | `{ site?, siteError?, user?, lines?, line? }`；`lines`（1.29）为可选的线路 `AccountLine = { id, name, url, description? }`，`line` 为当前线路的 `id`，`site` 来自当前线路；`site = AccountSite = { name, url, version?, logo?, registerEnabled, emailVerification, passwordLogin, browserLogin, turnstile, oauth: string[], quota: { perUnit, type, usdRate?, customSymbol?, customRate? } }`（来自站点的 `/api/status`，`type` 为 `USD`、`CNY`、`CUSTOM` 或 `TOKENS`）；`user` 为保存的登录，没有登录时省略 |
| `account.setLine` | `{ line }` | `AccountStatus`（1.29）；切换线路并保存，见下文「线路」。未知线路 `BAD_REQUEST` |
| `account.login` | `{ username, password }` 或 `{ accessToken, userId? }` | `AccountLoginResult`：`{ status: "ok", overview }` 或需要两步验证时 `{ status: "verify", methods }`。站点开启 Turnstile 时密码登录返回 `BAD_REQUEST` |
| `account.verify` | `{ code }` | `AccountLoginResult`；提交两步验证码（或备用码） |
| `account.authorizeStart` | `{ redirectUri? }`（`redirectUri` 1.28） | `{ flowId, authorizeUrl, expiresAt }`（1.16）；见下文「浏览器登录」。站点不支持或 `redirectUri` 不是 `http://127.0.0.1:<端口>/callback` 时 `BAD_REQUEST` |
| `account.authorizeWait` | `{ flowId }` | `AccountLoginResult`（1.16）；用户在浏览器中登录并同意后返回 `{ status: "ok", overview }` 并保存登录。拒绝、超时、取消或换取失败时返回错误 |
| `account.authorizeCallback` | `{ flowId, query }` | `{ status, title, detail }`（1.28）；转交客户端在自己电脑上接到的回调（`query` 为回调地址的查询串，如 `?code=…&state=…`），处理完后返回浏览器应显示的页面；只用于带 `redirectUri` 启动的流程，否则 `BAD_REQUEST` |
| `account.authorizeCancel` | `{ flowId }` | `{ cancelled }`（1.16） |
| `account.sendCode` | `{ email }` | `{ sent: true }`；发送注册邮箱验证码（`GET /api/verification`） |
| `account.register` | `{ username, password, email?, code?, affCode? }` | `AccountLoginResult`；注册（`POST /api/user/register`，用户名最多 20 个字符、密码 8–128 位，站点开启邮箱验证时必须提供 `email` 和 `code`，`affCode` 为邀请码）后立即登录。站点关闭注册或开启 Turnstile 时 `BAD_REQUEST` |
| `account.overview` | — | `{ site, user, tokens: NewApiToken[], groups }`；`user = { id?, username, displayName?, email?, group?, quota, usedQuota, requestCount }`，额度为站点单位，按 `site.quota` 换算显示 |
| `account.createToken` | `{ name, group? }` | `{ tokenId, tokens }`；在分组中新建无限额度、永不过期、不限模型的令牌 |
| `account.useToken` | `{ tokenId }` | `{ keyRef, models, modelsError? }`；与 `newapi.useToken` 相同，`keyRef` 属于调用的连接 |
| `account.logout` | — | `{ loggedOut }`；退出站点上的会话（不会吊销用户自己的访问令牌）并删除 `account.json` |

#### 线路（1.29）

同一个云链API站点有两个入口，用户可以选择网络更顺畅的一条（`@pier/protocol` 的 `YUNLIAN_LINES`）：

| `id` | 名称 | 地址 |
|---|---|---|
| `cn` | 国内线路（默认） | `https://api.yunnet.top` |
| `global` | 国际线路 | `https://api.syixn.com` |

两条线路是同一个站点、同一套账号，因此 `account.setLine` 只改变 Host 访问站点的地址：已保存的登录随之改用新线路（刷新 Cookie 与访问令牌照常可用），站点信息缓存失效；等待两步验证码的密码登录被丢弃。切换前发起、之后才完成的浏览器登录也保存到当前线路。所选线路与登录一起保存在 `account.json` 的 `line` 字段（默认线路不写），退出登录后保留；旧版本 Host 读到其他线路的登录时当作未登录。使用 `accountSite` 的 Host 只有一条线路 `custom`。

桌面端在个人中心顶部显示线路选择（Host 返回多条线路时），切换后把那台电脑上 Base URL 由云链API线路派生的服务商（`yunlian`、`yunlian-<分组>` 以及指向任一线路的自定义服务商）一并改为新线路的地址（密钥不变，手动改过 Base URL 的不动）；之后把分组配置到 pi、Claude Code 或 Codex 也使用当前线路。「模型与服务商」中的「云链API」浏览器授权使用本机个人中心的线路。

#### 浏览器登录（1.16）

`site.browserLogin` 为 `true`（站点的 `/api/status` 返回 `app_authorization_enabled: true`，且 `app_authorization_scopes` 包含 `account`）时，个人中心只在浏览器中登录，Pier 不接触密码：用户可以用站点支持的任意方式登录（账号密码、GitHub、LinuxDO、Passkey、人机验证等），在授权页面同意后，站点为 Pier 建立一个独立的登录会话（登录方式为「应用」，出现在网页「登录会话」中，可以随时注销）。流程与上文的 `newapi.authorize*` 相同（RFC 8252 回环重定向 + PKCE S256），区别是授权页面地址带 `scope=account`、不带 `key_name`，站点不会新建令牌，`POST /api/app-auth/token` 返回 `{ scope: "account", access_token, access_expires_at, refresh_token, session, user }`。Host 把 `refresh_token` 当作刷新 Cookie 使用，与密码登录一样只保存它，并自动续期。流程属于发起的连接。默认浏览器会跳回 Host 所在电脑的回环地址，只适用于本地 UI；设置其他电脑时见下文「为其他电脑登录」。Host 请求 NewAPI 站点时使用 `User-Agent: Pier/<版本> (<系统>)`。不支持的站点仍然使用 `account.login` / `account.register`。

#### 为其他电脑登录（1.28）

浏览器运行在用户面前的电脑上，只能跳回这台电脑的回环地址。桌面端设置已配对的电脑时，由本机 Host 代收回调，再转交给发起登录的那台电脑：

1. 在本机调用 `loopback.open`，得到 `{ relayId, redirectUri }`（`http://127.0.0.1:<随机端口>/callback`）；
2. 在那台电脑调用 `account.authorizeStart { redirectUri }`。它照常生成 `state` 与 `code_verifier`，但不监听端口，授权页面地址中的 `redirect_uri` 就是这个地址；
3. 在本机浏览器中打开 `authorizeUrl`，并在那台电脑调用 `account.authorizeWait`；同时循环调用本机的 `loopback.next`，把每个回调的 `query` 用 `account.authorizeCallback` 交给那台电脑，再把返回的页面用 `loopback.respond` 显示在浏览器中；
4. 那台电脑校验 `state`（不符时返回 400 页面且不影响流程），用自己保存的 `code_verifier` 换取登录并保存，`account.authorizeWait` 随之返回；完成后调用 `loopback.close`。

`code_verifier` 始终留在发起登录的电脑上，本机代收的授权码单独无法换取凭据。旧版本 Host 忽略 `redirectUri`，因此桌面端只对协议 1.28 及以上的电脑这样做。

| 方法 | 参数 | 结果 |
|---|---|---|
| `loopback.open` 🔒 | — | `{ relayId, redirectUri, expiresAt }`；在 `127.0.0.1` 的随机端口监听 `/callback`（11 分钟后、调用 `loopback.close` 或连接断开时关闭）。其他路径返回 404 |
| `loopback.next` 🔒 | `{ relayId }` | `{ requestId, query }`；等待下一个回调。浏览器一直等到 `loopback.respond`，最多 1 分钟后显示「请回到 Pier 查看登录结果」。中继关闭后 `NOT_FOUND` |
| `loopback.respond` 🔒 | `{ relayId, requestId, status, title, detail }` | `{ responded }`；在浏览器中显示页面；浏览器已断开或已经回复过时为 `false` |
| `loopback.close` 🔒 | `{ relayId }` | `{ closed }` |

桌面端把每个分组的令牌保存为自定义服务商 `yunlian-<分组>`（名称为「云链API · 分组」，Base URL 为 `<站点>/v1`）；「模型与服务商」中浏览器授权添加的是 `yunlian`。

### 扩展与扩展包（1.8）

管理 pi 的扩展包（`packages`：npm、git 或本地目录，可包含扩展、技能、提示词模板与主题）和资源目录中的独立资源，效果与 `pi install` / `pi remove` / `pi update --extensions` / `pi config` 相同：Host 直接使用 pi 的包管理器，读写 pi 的 settings 文件。全局（`scope: "user"`）对应 `<agentDir>/settings.json`，对所有工作区生效；项目（`scope: "project"`）对应 `<工作区>/.pi/settings.json`，需要带 `workspaceId`（Pier 中添加的工作区视为已信任）。扩展会在 Host 进程中以用户权限执行代码；1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放（配对即完全信任）。

不带 `workspaceId` 时只看全局设置；带上时同时包含该工作区的项目设置（与在该目录运行 pi 时看到的相同，项目中的同名包覆盖全局的）。

修改设置后，Host 对受影响的活跃会话（全局改动为所有会话，项目改动为该工作区的会话）执行 `session.reload` 的效果：空闲会话立即重新加载，运行中或有待回答对话框的会话保持不变，需要之后自行 `/reload`。结果中的 `reload = ExtensionReloadSummary = { reloaded, pending, failed }` 给出三类会话的数量，随后向所有连接广播 `extension.changed`。修改操作在 Host 内按顺序执行。

| 方法 | 参数 | 结果 |
|---|---|---|
| `extension.list` | `{ workspaceId? }` | `ExtensionListResult = { agentDir, workspaceId?, packages, resources }`。`packages: ExtensionPackageInfo[] = { source, scope, kind: "npm"\|"git"\|"local", filtered, installedPath?, name?, version?, description? }`：`source` 与 settings 中写的一致（本地路径相对 settings 文件所在目录），`installedPath` 缺失表示没有安装或路径不存在，`name` / `version` / `description` 来自包的 `package.json`。`resources: ExtensionResourceInfo[] = { type: "extensions"\|"skills"\|"prompts"\|"themes", path, name, enabled, scope, origin: "package"\|"top-level", source, deletable }`：已停用的资源也会列出；包内资源的 `source` 为包的 `source`，独立资源为 `auto`（`extensions/`、`skills/` 等资源目录，含 `~/.agents/skills`）或 `local`（settings 中列出的路径）。列出时不会安装缺失的包 |
| `extension.install` | `{ source, scope?("user"), workspaceId? }` | `{ package?, reload }`；安装并写入 settings（`pi install [-l]`）。`source` 为 `npm:<包名>[@版本]`、`git:<主机>/<路径>[@ref]`、Git 仓库 URL，或本地扩展文件 / 扩展包目录的**绝对**路径（支持 `~`；相对路径或不存在时 `BAD_REQUEST`）。npm / git 来源需要 Host 能执行 `npm` / `git`（npm 可用 settings 的 `npmCommand` 指定），找不到命令时 `BAD_REQUEST`。进度以 `extension.progress` 给出，可能耗时较长，客户端应放宽超时。已存在的来源会重新安装 |
| `extension.remove` | `{ source, scope, workspaceId? }` | `{ removed, reload }`；从 settings 移除并卸载 pi 安装的 npm / git 副本（`pi remove`），本地路径只从 settings 移除。`source` 使用 `extension.list` 返回的值；没有匹配的包时 `removed: false` |
| `extension.update` | `{ source?, workspaceId? }` | `{ reload }`；更新一个包，省略 `source` 时更新全部（`pi update --extensions`）。固定版本的 npm 包与固定 ref 的 git 包只会校准到配置的版本。没有匹配的包时 `NOT_FOUND` |
| `extension.checkUpdates` | `{ workspaceId? }` | `{ updates: { source, name, kind: "npm"\|"git", scope }[] }`；列出有新版本的未固定包（需要网络） |
| `extension.setEnabled` | `{ type, path, enabled, workspaceId? }` | `{ resource, reload }`；在资源所属范围的 settings 中启用 / 停用一个已列出的资源（与 `pi config` 相同）：独立资源在 `extensions` / `skills` / `prompts` / `themes` 数组中写入 `+路径` / `-路径`，包内资源写入该包条目的筛选。`path` 与 `type` 必须与 `extension.list` 的某一项一致，否则 `NOT_FOUND` |
| `extension.delete` | `{ type?, path, workspaceId? }` | `{ deleted: true, reload }`；删除一个独立资源（`deletable: true`）。`type`（1.30）为 `extensions`、`skills`、`prompts` 或 `themes`，省略时默认为 `extensions`，兼容旧客户端。自动发现的文件移到 Pier 回收站（`~/.pier/trash/extensions`）；带 `index.ts` 的扩展目录、带 `SKILL.md` 的技能目录整体移入，保留脚本和资源。支持 `~/.agents/skills`、项目及祖先目录的 `.agents/skills`。settings 中明确列出的资源文件或单个技能/扩展目录只从 settings 移除（文件保留）。包内资源、通过集合目录条目加载的资源、需穿过父级符号链接才能删除的资源返回 `BAD_REQUEST`（改为移除包或停用）；单个技能目录本身是符号链接时只移动链接，保留目标。删除全局共享技能会影响其他读取同一目录的工具 |
| `extension.search` | `{ query?, type?: "extension"\|"skill"\|"theme"\|"prompt", sort?: "downloads"\|"recent"\|"name"("downloads"), page?(1) }` | `ExtensionCatalogResult = { origin: "pi.dev"\|"npm", packages, total, page, pageSize, hasMore, notice? }`（1.20）；在 Host 所在电脑上搜索 pi 官方扩展仓库 [pi.dev/packages](https://pi.dev/packages)（发布到 npm、带 `pi-package` 关键词的包），每页 50 个。`packages: ExtensionCatalogPackage[] = { name, source, description?, version?, author?, types, monthlyDownloads?, publishedAt?, npmUrl, repositoryUrl?, galleryUrl? }`，`source`（`npm:<包名>`）可直接传给 `extension.install`；`types` 为空表示仓库没有标注类型。仓库无法访问时改用 npm registry 搜索（`keywords:pi-package`），此时 `origin: "npm"`、`notice` 说明原因，`type` 与 `sort` 不生效。结果在 Host 中缓存 5 分钟；只读，不写审计日志。两者都无法访问时返回 `INTERNAL` |

settings 文件无法解析时，修改类方法返回 `CONFLICT`，避免覆盖用户的文件。

### pi 设置（1.15）

直接读写 pi 的 settings 文件，供「设置 → Agent 配置 → pi」可视化编辑（终端里的 pi 读取同一份文件）。与 `extension.*` 相同，`scope: "user"` 为 `<agentDir>/settings.json`，`scope: "project"` 为 `<工作区>/.pi/settings.json`，需要带 `workspaceId`。Host 不校验各设置项的含义，只保证文件是 JSON 对象；写入时与 pi 使用同一把文件锁（`proper-lockfile`），不会与正在保存设置的 pi 进程交错。对已配对设备开放，远程调用写入审计日志（只记录修改的键名和字节数，不记录值）。

文件有实际变化时，Host 对受影响的空闲会话执行 `session.reload`（全局改动为所有会话，项目改动为该工作区的会话；运行中的会话计入 `pending`），然后广播 `settings.changed`、`extension.changed`（settings 中也有扩展包与资源），全局改动再广播 `provider.changed`（默认模型也在其中）。个别设置（如 `defaultTools`、`transport`）只在创建会话时读取，重新加载不会改变已打开会话的这些值。

| 方法 | 参数 | 结果 |
|---|---|---|
| `settings.get` | `{ workspaceId? }` | `PiSettingsResult = { agentDir, user, project? }`，`user` / `project` 为 `PiSettingsFile = { scope, path, exists, text, settings?, error?, modifiedAt? }`（`project` 另带 `workspaceId`）。按文件原样返回，不合并全局与项目设置，也不补默认值。文件不存在时 `exists: false, text: "", settings: {}`；内容不是 JSON 对象时省略 `settings` 并给出 `error`，`text` 仍为原文 |
| `settings.update` | `{ scope, workspaceId?, changes: { path: string[], value? }[], reload?(true) }` | `PiSettingsChangeResult = { file, changed, reload }`；在文件当前内容上逐项修改：`path` 为键路径（如 `["compaction", "enabled"]`，1–8 段，禁止 `__proto__` / `prototype` / `constructor`），带 `value` 时设置（沿途创建对象），省略时删除该键并移除因此变空的父对象。其他键（包括 Pier 不认识的）保持不变，按 pi 的格式（两个空格缩进）写回，保留原有的结尾换行。路径经过的值不是对象时 `BAD_REQUEST`；文件无法解析时 `CONFLICT`（改用 `settings.write` 修复）。内容没有变化时不写文件，`changed: false`。`reload: false` 跳过重新加载会话（只影响终端 pi 的设置），仍会广播事件 |
| `settings.write` | `{ scope, workspaceId?, text, expectedModifiedAt? }` | `PiSettingsChangeResult`；用 `text`（最多 1 MiB，必须是 JSON 对象）整体替换文件，原样写入。带 `expectedModifiedAt`（读取时的 `modifiedAt`）时，文件在此之后被修改（或已被删除）则 `CONFLICT`，不写入。`text` 不是 JSON 对象时 `BAD_REQUEST` |
| `host.packageManagers` | – | `PackageManagerDetection = { managers: PackageManagerInfo[] }`，`PackageManagerInfo = { name: "npm"\|"pnpm"\|"bun", path, onPath, default?, version?, error? }`：Host 所在电脑上的 npm / pnpm / bun，供设置 pi 的 `npmCommand`（1.17）。先按 Host `PATH` 的顺序，再查找常见安装目录（`~/.bun/bin`、pnpm 与 Volta 的目录、Homebrew、`/usr/local/bin` 等，Windows 为 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm` 等）；`onPath: false` 表示只在常见安装目录中找到，需要使用完整路径。`path` 经过所在目录的真实路径（不跟随文件本身的符号链接），同一个文件只列出一次；`default: true` 表示直接执行该名称时运行的就是这一个（`PATH` 中的第一个）。`version` 为在用户主目录中以 Host 的环境执行 `--version` 的输出（去掉开头的 `v`），失败或 5 秒内没有结束时省略并给出 `error`（例如 npm 找不到 `node`）。不修改任何设置 |

Host 由桌面端启动时（`--watch-stdin`，macOS / Linux），启动过程中会以交互式登录 Shell（`$SHELL -i -l -c`，环境变量 `PIER_RESOLVING_ENVIRONMENT=1`，最多 5 秒）读取一次 `PATH`，放在继承的 `PATH` 之前，使 pi（扩展安装、bash 工具等）能找到终端中可用的 npm / pnpm / bun / git（nvm、fnm、mise、Volta、Homebrew 等）。AppImage 注入的 `$APPDIR` 条目不会传给这个 Shell。`--no-login-shell-path` 关闭这一行为；Windows 不需要。

### Claude Code 与 Codex 配置（1.23）

直接读写 Claude Code 与 Codex 自己的配置文件，供「设置 → Agent 配置 → Claude Code / Codex」可视化编辑（终端中的 `claude` / `codex` 读取同一份文件）。`runtime` 为 `claude-code` 或 `codex`，`scope`：

| `runtime` | `user` | `project` | `local` |
|---|---|---|---|
| `claude-code`（JSON） | `<CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json` | `<工作区>/.claude/settings.json` | `<工作区>/.claude/settings.local.json` |
| `codex`（TOML） | `<CODEX_HOME 或 ~/.codex>/config.toml` | `<工作区>/.codex/config.toml` | –（`BAD_REQUEST`） |

`project` / `local` 需要 `workspaceId`。Host 不校验各设置项的含义，只保证 Claude Code 的文件是 JSON 对象、Codex 的文件是有效的 TOML。这两个 CLI 不使用文件锁，写入为直接替换。对已配对设备开放，远程调用写入审计日志（只记录修改的键名和字节数，不记录值——其中可能有 API Key）。

文件有实际变化时，Host 让该运行时丢弃从配置读取的缓存（模型列表；Codex 没有打开的会话时还会停止共用的 `codex app-server`，下次使用时按新配置启动），并广播 `agentConfig.changed`。已经打开的会话保持原来的配置，新建或重新打开后生效。Pier 按工作区审批策略设置的项（Claude Code 的 `permissions.defaultMode`、Codex 的 `approval_policy` / `sandbox_mode` / `sandbox_workspace_write`）只影响终端中的 CLI。

| 方法 | 参数 | 结果 |
|---|---|---|
| `agentConfig.get` | `{ runtime, workspaceId? }` | `AgentConfigResult = { runtime, format: "json"\|"toml", configDir, scopes, files, workspaceId?, available }`。`scopes` 是该运行时的全部范围（优先级从低到高），`files` 为 `user` 文件，带 `workspaceId` 时还有该工作区的文件，顺序同 `scopes`；每项 `AgentConfigFile = { scope, path, exists, text, settings?, error?, modifiedAt? }`，语义同 `PiSettingsFile`。TOML 的 `settings` 转换为 JSON：日期时间为 ISO 字符串，超出安全范围的整数为字符串。`available` 表示这台电脑上装了该 CLI（没装也可以编辑文件） |
| `agentConfig.update` | `{ runtime, scope, workspaceId?, changes: { path: string[], value?, apiKeyRef? }[] }` | `AgentConfigChangeResult = { file, changed }`；与 `settings.update` 相同地逐项设置或删除键，其他内容保持不变。JSON 以两个空格缩进写回；TOML 在原文上修改，保留注释、顺序与格式，在已有表中新增的子表（如另一个 `[model_providers.x]`）写成紧跟在同级表后的节，内联表保持内联；写入前重新解析校验，结果与预期不符时 `INTERNAL` 且不写入。TOML 不能存 `null`（`BAD_REQUEST`）。文件无法解析时 `CONFLICT`（改用 `agentConfig.write` 修复）。某项带 `apiKeyRef`（`account.useToken` / `newapi.useToken` 返回的密钥引用，只对取得它的连接有效）时写入该引用背后的令牌密钥，客户端不需要知道密钥（文件内容随结果返回，之后读取文件时也能看到它）；引用不存在或已过期时 `NOT_FOUND`，同一项同时带 `value` 与 `apiKeyRef` 时 `BAD_REQUEST`（1.25） |
| `agentConfig.write` | `{ runtime, scope, workspaceId?, text, expectedModifiedAt? }` | `AgentConfigChangeResult`；用 `text`（最多 1 MiB）整体替换文件，原样写入。Claude Code 的必须是 JSON 对象，Codex 的必须是有效的 TOML（可以为空），否则 `BAD_REQUEST`；`expectedModifiedAt` 同 `settings.write` |

### UI

| 方法 | 参数 | 结果 |
|---|---|---|
| `ui.respond` | `{ sessionId, requestId, response: UiResponse }` | `{ accepted }`；请求已被其他客户端回答 / 超时 / 取消时为 `false` |

### 其他电脑（1.9）

每台电脑的 Host 都可以作为“设备”与其他电脑配对（使用它自己的静态密钥，见 [`docs/security.md`](security.md) §4.4）。桌面界面通过本地 Gateway 的 `ws://127.0.0.1:<port>/peer/<peerId>` 连接已配对的电脑：第一帧必须是带本地 token 的 `host.hello`（与普通本地连接一样校验 Origin 与 token），Host 校验后**去掉 token**，经 Noise IK 加密通道把 hello 与之后的帧原样转发给那台电脑，并把它的帧原样转回。对那台电脑来说这是一条普通的远程连接：`host.hello` 结果带 `device`，不能调用 🔒 方法，也收不到仅限本地的事件。连不上时以 4502 关闭，那台电脑吊销了本机时以 4403 关闭（reason `UNKNOWN_DEVICE`）。

| 方法 | 参数 | 结果 |
|---|---|---|
| `peer.list` 🔒 | – | `{ peers: PeerInfo[] }`：`{ id（那台电脑的 hostId）, name, fingerprint, addresses, relays?, deviceId, pairedAt, lastConnectedAt?, platform?, version?, connected }`；`connected` 表示当前有桌面窗口经本机连着它；`relays` 为那台电脑注册的中继（1.26，来自配对链接） |
| `peer.pair` 🔒 | `{ uri }`（那台电脑显示的 `pier://pair?...` 链接） | `{ peer }`；在那台电脑的用户确认后返回。失败时 `data.reason` 为 `INVALID_LINK`（`BAD_REQUEST`）、`SELF`（本机自己的链接）、`UNREACHABLE`、`PAIRING_INVALID`、`PAIRING_REJECTED`、`PAIRING_TIMEOUT`、`BAD_HANDSHAKE` 等（`CONFLICT`）。可能耗时数分钟，客户端请放宽超时 |
| `peer.update` 🔒 | `{ peerId, addresses, relays? }`（`host:port` 列表，0–16 个，IPv6 加方括号；`relays` 为中继地址，0–4 个，省略时不变；两者至少一项非空） | `{ peer }`；修改连接那台电脑使用的地址（例如它的 IP 变了），去重后按顺序尝试，地址都连不上时再经中继；有变化时以 1012 断开经本机到它的连接以便用新地址重连。固定的公钥不变，新地址上若是另一台电脑会握手失败。未配对时 `NOT_FOUND`，地址无效时 `BAD_REQUEST`（1.24；`relays` 1.26） |
| `peer.remove` 🔒 | `{ peerId }` | `{ removed }`；只在本机忘记那台电脑，并断开经本机到它的连接（4404）；那台电脑的设备列表不变 |

Host 保存已配对的电脑于 `~/.pier/peers.json`（0600），每次经代理连接成功后更新名称、系统、版本、最近连接时间，并把成功的地址排到最前。

### 远程访问、配对与设备（1.1）

| 方法 | 参数 | 结果 |
|---|---|---|
| `remote.status` 🔒 | – | `RemoteAccessStatus`：`{ enabled, port, running, addresses, hostFingerprint, mdns, pairingActive, error?, relay?, p2p? }`；`relay`（1.26）为 `{ enabled, url?, hasToken, state: "off" \| "connecting" \| "online" \| "error", error?, mode?: "private" \| "open" }`（从不返回令牌本身），`p2p`（1.26）表示经中继的连接是否尝试切换到点对点路径 |
| `remote.configure` 🔒 | `{ enabled?, port?(1024–65535), relay?: { enabled?, url?, token?: string \| null }, p2p? }` | `RemoteAccessStatus`；写入 `config.json` 并立即启动 / 停止 / 换端口（换端口或关闭会断开局域网连接）。`relay`（1.26）：`url` 为 `wss://` / `ws://` / `https://` 地址或裸域名（规范化为 `ws(s)://`），`token` 为私有模式中继的访问令牌（`null` 删除），开启时没有地址为 `BAD_REQUEST`；修改或关闭中继会断开经中继与 P2P 的连接（4410）。局域网访问与中继相互独立 |
| `pairing.start` 🔒 | – | `{ uri, expiresAt, addresses, relays? }`；`uri` 即二维码内容。局域网访问未运行且中继不在线时 `CONFLICT`；只有中继在线时 `addresses` 为空。再次调用会让旧配对码失效 |
| `pairing.cancel` 🔒 | – | `{ cancelled }` |
| `pairing.respond` 🔒 | `{ requestId, accept }` | `{ accepted }`；请求已超时或设备已断开时为 `false` |
| `device.list` 🔒 | – | `{ devices: DeviceInfo[] }`：`{ id, name, platform?, model?, appVersion?, fingerprint, pairedAt, lastSeenAt?, connected, route? }`；`route`（1.26）为在线设备的连接方式：`lan`（直连监听端口）、`relay`（经中继）、`p2p`（经中继建立的点对点路径） |
| `device.rename` 🔒 | `{ deviceId, name }` | `{ device }` |
| `device.revoke` 🔒 | `{ deviceId }` | `{ revoked }`；该设备的连接立即以 4403 断开 |

### 定时任务（1.36）

`task.*` 由工作区所在 Host 执行，对本地和已配对客户端开放。`ScheduledTaskInput` 包含 `name`、`prompt`、`workspaceId`、`runtime`（默认 `pi`）、`schedule`、可选 `model: { provider, modelId }` 和 `thinkingLevel`。计划支持 `{ kind: "once", at: ISO UTC }`、`{ kind: "interval", minutes }`、`{ kind: "daily", time: "HH:mm", timeZone }`、`{ kind: "weekly", time, timeZone, days: number[] }`；时区为 IANA 名称，星期日为 0。单次时间必须在未来，间隔为 1–525600 分钟。

| 方法 | 参数 | 结果 |
|---|---|---|
| `task.list` | – | `{ tasks: ScheduledTask[] }` |
| `task.create` | `ScheduledTaskInput` | `{ task }` |
| `task.update` | `{ taskId, task: ScheduledTaskInput }` | `{ task }`；运行中拒绝编辑 |
| `task.setStatus` | `{ taskId, status: "active" \| "paused" }` | `{ task }`；恢复时重新计算下一次，暂停不终止当前运行 |
| `task.delete` | `{ taskId }` | `{ deleted }`；运行中拒绝删除；删除记录并保留会话 |
| `task.run` | `{ taskId }` | `{ run: ScheduledTaskRun }`；立即执行，不改变计划；同一任务运行中返回 `CONFLICT` |
| `task.stop` | `{ taskId }` | `{ stopped }`；仅停止本次运行，保留后续计划 |
| `task.runs` | `{ taskId? }?` | `{ runs: ScheduledTaskRun[] }`，最新在前 |
| `task.readRun` | `{ runId }` | `{ run }`；标记已读 |

`ScheduledTask` 在输入字段之外包含 `id`、`status: "active" | "paused" | "completed"`、`nextRunAt: string | null`、`createdAt`、`updatedAt`。`ScheduledTaskRun` 包含 `id`、`taskId`、`taskName`、`workspaceId`、`runtime`、`trigger: "schedule" | "manual"`、`status: "running" | "waiting" | "succeeded" | "failed" | "interrupted"`、`startedAt`、`read`，以及可选的 `finishedAt`、`sessionId`、`summary`（最多 4000 字符）、`error`。`sessionId` 可通过 `session.open` 打开完整会话。

Host 每秒检查计划。恢复后只补执行一个错过的周期；任务正在执行时跳过重复周期，最多同时运行 4 个任务。每次在原工作区目录创建独立会话，沿用工作区审批策略；UI 请求显示为 `waiting`，由正常 `ui.respond` 回答。未结束的运行在重启后标记为 `interrupted`，不会重放。移除工作区会暂停相关任务。最多 100 个任务，每个任务保留最近 50 次运行，持久化到权限 0600 的 `scheduled-tasks.json`。

任务、运行记录或已读状态变化时，Host 向所有客户端发送 `{ type: "task.changed" }`，客户端重新读取任务与记录；旧版 Host 不支持这些方法，客户端需检查协议 1.36。

## 4. 事件

### 4.1 pi 会话事件（透传）

与 pi 的 JSON/RPC 模式相同的线上形态：`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start|update|end`、`queue_update`、`compaction_start|end`、`auto_retry_start|end`、`session_info_changed`、`thinking_level_changed`、`summarization_retry_*`、`bash_execution_update`、`entry_appended`。

两处精简：

- `message_update` 去掉累积的 `partial` 消息，只保留 `{ type, usage, assistantMessageEvent }`；`toolcall_start` 额外带 `id` 与 `toolName`。客户端用 `message_start` + 增量重建流式消息，`message_end` 为权威结果。
- `entry_appended` 对消息条目只保留元数据 `{ type: "message", id, parentId, timestamp, role }`（完整内容已在 `message_end` 中）。

`agent_settled` 表示 pi 不会再自动继续，适合作为"任务完成"通知的触发点。

Claude Code 与 Codex 会话（1.22）发出同样形态的事件与 `AgentMessage`（`user` / `assistant` / `toolResult`，以及压缩后的 `compactionSummary`），只使用其中的一个子集：`agent_start`、`agent_end`、`agent_settled`、`message_start|update|end`、`tool_execution_start|update|end`、`queue_update`、`compaction_start|end`、`auto_retry_start|end`、`session_info_changed`、`thinking_level_changed`；没有 `turn_*`、`entry_appended` 与 `bash_execution_update`。assistant 消息的 `provider` 为运行时 ID。

### 4.2 Pier 会话事件

| 事件 | 字段 | 说明 |
|---|---|---|
| `session.snapshot` | `snapshot` | 仅在订阅 / 恢复时单独发给该连接，**不带 seq**，不写入日志 |
| `session.status` | `state: idle\|streaming\|compacting\|retrying` | 状态变化时发送 |
| `session.model` | `model?, thinkingLevel` | `model.set` 之后 |
| `session.replaced` | `previousSessionId, session` | 扩展命令（如 `/new`）替换了底层 pi 会话；帧的 `sessionId` 为旧 ID，随后会收到新会话的 `session.snapshot` |
| `session.closed` | `reason: idle\|closed\|deleted\|host_shutdown` | 会话离开活跃池；`deleted` 表示会话已被 `session.delete` 删除（1.6） |
| `ui.request` | `request: UiRequest` | 对话框或审批请求，见 §6 |
| `ui.resolved` | `requestId, resolution: answered\|timeout\|cancelled, response?, by?` | `by` 为回答者的 `connectionId` |
| `ui.notify` | `message, level` | 扩展通知 |
| `ui.status` / `ui.widget` / `ui.title` / `ui.editorText` | 见类型定义 | 扩展的 fire-and-forget UI 调用；当前状态也包含在快照中 |
| `extension.error` | `extensionPath, event, error` | 扩展处理器出错 |

### 4.3 Host 事件（无 sessionId / seq）

发给所有已认证连接：

| 事件 | 字段 | 说明 |
|---|---|---|
| `host.notice` | `level, message, sessionId?` | |
| `workspace.changed` | – | 工作区列表或策略变化 |
| `session.listChanged` | `workspaceId` | 会话列表变化（新建、分叉、关闭、重命名…） |
| `session.activity` | `workspaceId, sessionId, state, pendingUi` | 活跃会话的运行状态或待回答请求数变化（1.1）。列表页据此显示“运行中 / 待批准”，无需订阅每个会话 |
| `provider.changed` | – | 服务商、凭据、`models.json` 或默认模型变化（1.2）；重新调用 `provider.list` / `model.list` |
| `extension.changed` | `workspaceId?` | 扩展或扩展包设置变化（1.8）；只改了某个工作区的项目设置时带 `workspaceId`。重新调用 `extension.list`，会话的斜杠命令也可能变化 |
| `update.status` | `status: AppUpdateStatus` | 桌面端更新器的状态或下载进度变化（1.13），见「应用更新」 |
| `settings.changed` | `scope, workspaceId?` | 通过 `settings.update` / `settings.write` 修改了 pi 的 settings 文件（1.15）；`scope: "project"` 时带 `workspaceId`。重新调用 `settings.get`。在 Pier 之外修改文件（终端 pi、手动编辑）不会触发 |
| `agentConfig.changed` | `runtime, scope, workspaceId?` | 通过 `agentConfig.update` / `agentConfig.write` 修改了 Claude Code 或 Codex 的配置文件（1.23）；工作区文件带 `workspaceId`。重新调用 `agentConfig.get`。在 Pier 之外修改文件不会触发 |

终端事件（1.18），只发给打开该终端的连接，见「终端」：

| 事件 | 字段 | 说明 |
|---|---|---|
| `terminal.output` | `terminalId, data` | 终端输出，`data` 为原始字节的 base64 |
| `terminal.exit` | `terminalId, code, error?` | 终端结束；`error` 表示终端丢失（桌面端退出等） |

仅发给本地（桌面）连接（`LOCAL_ONLY_EVENTS`）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `remote.changed` | `status: RemoteAccessStatus` | 远程访问启停、端口变化、配对码生效 / 失效、中继状态变化 |
| `device.changed` | – | 设备登记、吊销、改名，或连接状态 / 连接方式变化；重新调用 `device.list` |
| `pairing.request` | `request: { id, device, fingerprint, address?, createdAt, expiresAt }` | 设备出示了正确的配对码，等待用户用 `pairing.respond` 确认 |
| `pairing.resolved` | `requestId, resolution: accepted\|rejected\|expired\|cancelled, deviceId?` | 配对请求结束（`cancelled`：设备在等待中断开） |
| `peer.changed` | – | 已配对的其他电脑增删、改名，或经本机的连接建立 / 断开（1.9）；重新调用 `peer.list` |

发给所有连接（1.9 及以前仅发给本地连接）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `extension.progress` | `action: install\|remove\|update\|clone\|pull, phase: start\|progress\|complete\|error, source, message?` | `extension.install` / `remove` / `update` 的进度（1.8） |

服务商登录进度（1.2），只发给调用 `provider.login` 的那个连接；连接断开时登录自动取消：

| 事件 | 字段 | 说明 |
|---|---|---|
| `auth.prompt` | `flowId, prompt: { id, type: text\|secret\|select\|manual_code, message, placeholder?, options? }` | 需要用户输入（API Key、授权码、选项等），用 `provider.loginRespond` 回答 |
| `auth.promptClosed` | `flowId, promptId` | 问题已不需要回答（例如浏览器回调先完成） |
| `auth.notice` | `flowId, notice` | `auth_url`（打开浏览器登录）、`device_code`（设备码）、`info`、`progress` |
| `auth.done` | `flowId, providerId, ok, cancelled?, error?, defaultModel?` | 登录结束 |

## 5. EventLog、订阅与断线恢复

- 每个活跃会话有一个 EventLog：单调递增的 `seq`（从 1 开始）与环形缓冲（默认 5000 条），以及随机的 `epoch`。Host 重启、会话被重新加载或被替换都会产生新的 epoch。
- `session.subscribe` 的语义：
  - 带 `sinceSeq` 且 `epoch` 与当前一致、缺口仍在缓冲内 → `mode: "replay"`，随后按序补发 `seq > sinceSeq` 的事件；
  - 否则 → `mode: "snapshot"`，随后发送一个 `session.snapshot`，再接实时事件。
  - **已有的转录前缀**（1.27）：客户端可在 `known` 中说明它已有转录的前 `count` 条消息，以及最后一条的指纹 `fingerprint`（`@pier/protocol` 的 `messageFingerprint`：消息按键排序的规范 JSON 的 64 位哈希，16 位十六进制）。需要发快照且 Host 转录的第 `count` 条消息指纹一致时，快照的 `messages` 只含其后的消息，并带 `messagesFrom: count`；客户端保留自己的前 `count` 条再接上。不一致（压缩、换分支或缓存过旧）时照常发完整快照。旧版 Host 忽略 `known`。手机端把看过的会话缓存在本地，下次打开时用 `sinceSeq/epoch` 只补发错过的事件；会话已被 Host 重新加载（新的 epoch）时，用 `known` 只下载新增的消息。
- **顺序保证**：订阅响应先于补发事件或快照到达；补发 / 快照之后才是订阅期间产生的实时事件。快照的 `seq` 表示它已包含到该 seq 为止的全部事件，之后的事件从 `seq + 1` 开始。
- 客户端应记录每个会话最后应用的 `seq` 与 `epoch`，并**丢弃 `seq <= lastSeq` 的事件**。`@pier/client` 自动完成这些：断线后指数退避重连，重新 `host.hello`，再用 `sinceSeq/epoch` 重新订阅；若会话已不在活跃池中（`NOT_FOUND`），会先 `session.open` 再从快照开始。
- **增量合并**：`host.hello` 指定 `coalesceMs > 0` 时，同一会话、同一内容块、相同类型（`text_delta` / `thinking_delta` / `toolcall_delta`）的连续增量在窗口内合并为一帧，合并帧携带最后一条的 `seq`。其他任何帧到来前都会先刷出待合并的帧，顺序不变。建议手机端使用约 50ms。
- **背压**：连接发送缓冲超过 16 MiB 时，Host 以关闭码 1013 断开，客户端重连后通过 `sinceSeq` 恢复。

### SessionSnapshot

```ts
{
  session: SessionSummary;     // 含 state
  seq: number; epoch: string;
  messages: AgentMessage[];    // 完整转录（含 system 消息，客户端可自行过滤）；带 messagesFrom 时只含从该下标起的消息
  messagesFrom?: number;       // 订阅时 known 前缀一致（1.27）：客户端保留自己的前 messagesFrom 条
  streamingMessage?: AgentMessage; // 正在流式输出的部分消息
  pendingToolCalls: string[];
  pendingUi: UiRequest[];      // 仍待回答的对话框 / 审批
  queue: { steering: string[]; followUp: string[] };
  model?: ModelInfo; thinkingLevel: string;
  statuses: Record<string, string>; widgets: Record<string, { lines: string[]; placement?: string }>;
  title?: string; errorMessage?: string;
  capabilities?: AgentRuntimeCapabilities; // 会话运行时的能力（1.22），见 §3 Agent 运行时
}
```

`SessionSummary.runtime`（1.22）是会话的 Agent 运行时；旧版 Host 不返回该字段，视为 `pi`。

`ModelInfo = { provider, id, name, reasoning, input: string[], contextWindow?, thinkingLevels? }`。`thinkingLevels`（1.19）是模型支持的思考等级，从低到高（`off`、`minimal`、`low`、`medium`、`high`，模型支持时还有 `xhigh`、`max`、`ultra`），不支持推理的模型为 `["off"]`；`thinking.set` 会把不支持的等级钳制到其中之一。`ultra` 自协议 1.34 起支持，只在运行时明确报告模型支持它时显示，并作为原生等级传给运行时。

## 6. UI 请求与审批

- 扩展调用 `ctx.ui.select/confirm/input/editor` 时，Host 生成 `UiRequest` 并以 `ui.request` 广播给该会话的所有订阅者。**先到先得**：第一个合法的 `ui.respond` 生效，其他客户端的回答返回 `accepted: false`；所有人都会收到 `ui.resolved`。
- 没有客户端在线时请求保持挂起（出现在之后的快照里），超时（默认 30 分钟，扩展可指定更短）后按默认答案解决：`confirm` → `false`，其余 → 取消。
- `UiResponse` 依请求类型校验：`confirm` 需 `confirmed`；`select` 需 `value` 且在 `options` 中；`input` / `editor` 需 `value`；任意类型都可用 `{ cancelled: true }` 取消。
- 终端专属能力（`custom`、`setFooter`、`setHeader`、编辑器组件、主题切换等）按 pi RPC 模式降级为 no-op；`ctx.ui.theme` 始终可用。

### 审批（`pier-approval` 内置扩展）

`kind: "approval"` 的请求带 `approval` 字段：

```ts
{ toolName, toolCallId, summary, input /* 长字段截断 */, reason, severity: "normal" | "high",
  sessionAllowable: boolean, sessionScope?: string }
```

回答为 `{ decision: "allow_once" | "allow_session" | "deny", reason? }`。拒绝时 `reason` 会作为工具结果返回给模型；超时或取消视为拒绝。

工作区策略：

| 策略 | 行为 |
|---|---|
| `ask` | `bash`、`write`、`edit` 每次都需审批 |
| `smart`（默认） | 只读命令白名单（`ls`、`cat`、`rg`、`git status/log/diff/show` 等，无输出重定向、命令替换）直接放行；工作区内的 `write`/`edit` 放行；其余 shell 命令与工作区外（含经符号链接逃逸）的写入需审批 |
| `auto` | 全部放行 |

在任何非 `auto` 策略下，危险模式（`rm -r`、`sudo`、`git push --force`、`git reset --hard`、`curl … \| sh` 等）一律以 `severity: "high"` 请求审批，且不提供"本会话内允许"。"本会话内允许"的范围：shell 命令按所用程序（如"运行 `npm` 的 bash 命令"）；写入按工作区或目标目录。只读工具（`read`、`grep`、`find`、`ls`）和扩展自定义工具不受策略约束。

## 7. 与 pi CLI 的并发

- Pier 使用与 pi 相同的会话文件（`~/.pi/agent/sessions`），可在终端 `pi --resume` 继续同一会话。
- Host 在 `~/.pier/locks` 中为打开的会话加锁，防止两个 Pier Host 同时写入同一文件（持锁进程已退出时自动接管）。
- 若会话空闲时文件被外部（例如 pi CLI）修改，后续写操作（`prompt`、`rename`、`model.set`、`compact` 等）返回 `CONFLICT`，需要关闭并重新打开会话。

## 8. 空闲回收

没有订阅者、非运行中、没有待处理 UI 请求，且 30 分钟无活动的会话会被自动 `dispose`（`session.closed { reason: "idle" }`），之后可通过 `session.open` 重新加载。

## 统一 Skills 与 MCP 管理（1.38）

以下方法向已认证的本地及配对客户端开放。`runtime` 为 `pi`、`claude-code` 或 `codex`；`workspaceId?` 为目标 Host 的已注册工作区，省略时只查看全局。`scope` 为 `user` / `project`，Claude MCP 另支持 `local`（存放在用户状态中的项目私有定义）。项目 / 本地操作必须提供工作区。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `skills.list` | `{ runtime, workspaceId? }` | `{ items: SkillInfo[], errors: string[] }`。技能包含 `scope, name, description, path, enabled, editable, deletable, shared`；路径必须来自列表才能读取或修改 |
| `skills.read` | `{ runtime, workspaceId?, path }` | `{ skill, text, revision }`；`revision` 为内容 SHA-256 |
| `skills.save` | `{ runtime, workspaceId?, scope, name, text, path?, expectedRevision? }` | `{ skill, text, revision }`；无 `path` 时创建独立技能，已存在的目录返回 `CONFLICT`。编辑需要列表路径与读取时的版本；冲突返回 `CONFLICT`，扩展包 / 系统 / 符号链接技能不可编辑 |
| `skills.import` | `{ runtime, workspaceId?, scope, sourcePath, name? }` | `{ skill, text, revision }`；从目标电脑上绝对路径的技能目录或 `SKILL.md` 复制技能、脚本和资源，不覆盖已有目录 |
| `skills.setEnabled` | `{ runtime, workspaceId?, path, enabled }` | `{ changed }`；pi 更新资源设置，Codex 更新 `skills.config`，Claude 更新技能 `permissions.deny` 规则，不删除技能文件 |
| `skills.delete` | `{ runtime, workspaceId?, path, expectedRevision? }` | `{ deleted }`；独立技能目录移入回收站，pi 的显式资源路径遵循 `extension.delete` 的移除语义 |
| `mcp.list` | `{ runtime, workspaceId? }` | `{ items: McpServerInfo[], errors: string[] }`；服务器包含 `scope, name, path, enabled, config, revision`。`config` 是原生配置，可能含凭据，仅通过认证连接返回 |
| `mcp.save` | `{ runtime, workspaceId?, scope, name, config, enabled?(true), expectedRevision?, create?(false) }` | `McpServerInfo`；新建时传 `create: true` 防止覆盖同名服务器，编辑时必须匹配旧版本；保留其他服务器、配置项及 Codex TOML 注释 |
| `mcp.setEnabled` | `{ runtime, workspaceId?, scope, name, enabled, expectedRevision }` | `McpServerInfo`；Claude 定义停用后归档在 Pier 状态目录，启用时恢复；pi / Codex 使用原生 `enabled`，支持 pi 的项目启用状态覆盖 |
| `mcp.delete` | `{ runtime, workspaceId?, scope, name, expectedRevision }` | `{ deleted }`；只移除指定定义，保留其他服务器与应用配置 |
| `mcp.test` | `{ runtime, workspaceId?, scope, name }` | `{ ok, tools: { name }[], message }`；显式建立 stdio / HTTP / Claude SSE 连接、发现工具并关闭连接；不调用业务工具、不启动 OAuth、不回传子进程日志或凭据。客户端建议 60 秒超时 |

变更广播 `resources.changed = { runtime, workspaceId? }`，并通知相关扩展 / Agent 配置页面。pi 空闲会话重新加载，忙碌会话保持原运行并在结束后 `/reload`；Claude / Codex 原生配置在会话新建 / 重新打开时读取。审计只记录 runtime、scope、资源名称与工作区，不记录技能正文、MCP 配置、环境变量、请求头或凭据。

## 主机端口与独立 TCP 映射（1.39）

端口面板独立于浏览器和工作区。本机 Host 创建回环 TCP 监听器，通过 `PeerManager` 为每条映射建立独立的配对加密连接，复用 `tunnel.*` 的流控和半关闭语义；支持现有直连 / Relay / P2P。目标转发 Host 需要 1.37，端口查询需要 1.39。

| 方法 | 参数 | 返回 |
|---|---|---|
| `host.ports` | — | `{ ports: HostPort[], truncated }`；查看这台主机正在监听的 TCP 和未连接 UDP 套接字，不扫描网络或防火墙 |
| `portForward.open` 🔒 | `{ peerId, remoteHost, remotePort, localPort? }` | `PortForward`；本地监听 `127.0.0.1`，`localPort` 省略或为 `0` 时自动分配 |
| `portForward.list` 🔒 | — | `{ forwards: PortForward[] }`；只返回调用连接创建的映射 |
| `portForward.close` 🔒 | `{ id }` | `{ closed }`；关闭指定映射及其所有 TCP 流，其他连接的映射返回 `false` |

`HostPort = { protocol:"tcp"|"udp", address, port, pid?, process? }`。Linux 优先使用 `ss`，缺少命令时读取 `/proc/net/{tcp,tcp6,udp,udp6}`；macOS 使用 `lsof`，Windows 使用 PowerShell 的 `Get-NetTCPConnection` / `Get-NetUDPEndpoint`。仅执行固定只读命令，不提升权限、不读取进程命令行；进程名称/PID 不可读时省略。Linux 仅显示 Host 所在网络命名空间的监听端口。样本缓存 1 秒并共享并发查询，最多返回 4096 条，超出时设置 `truncated:true`。

`PortForward = { id, peerId, remoteHost, remotePort, localHost:"127.0.0.1", localPort, lastError? }`。只允许已配对目标和不带 URL / 凭据的目标地址；所有端口限定在 1–65535（本地额外允许 0）。本地端口冲突返回 `CONFLICT`，权限不足返回 `FORBIDDEN`。创建映射只确认本地监听器启动；远程服务在本地程序连接时按需连接，失败会更新 `lastError`，下一次成功连接清除此字段。最多 32 条映射，不支持 UDP 转发。

映射属于创建它的本地协议连接；关闭 UI 面板不会关闭该连接。管理连接断开、目标配对连接断开、设备吊销、移除配对或 Host 退出均清理监听器与流。不持久化映射或自动恢复。只有本地认证客户端可以管理映射；远程已配对设备可以查询 `host.ports`，但不能在此主机创建监听器。TCP 流继续由 `tunnel.open` 审计目标/端口，不记录流量或进程列表。

## 本地渲染的浏览器（1.37）

本机 Host 负责本地浏览器进程和回环监听器，通过 `PeerManager` 为浏览器建立独立的配对加密连接（现有 Relay / P2P 可用）。远程 Host 仅连接目标 TCP 服务，运行独立 Host 的无桌面 Linux 同样可提供转发。配对仍表示完全信任；这里只对已认证连接开放。旧版目标 Host 在打开时提示更新。

| 方法 | 参数 | 返回 |
|---|---|---|
| `tunnel.open` | `{ host, port }` | `{ tunnelId }`；10 秒连接超时，仅允许域名 / IP，无 URL 和凭据 |
| `tunnel.read` | `{ tunnelId }` | `{ data, end }`；base64 原始字节，每次最多 64 KiB；最多等 25 秒，无数据时返回空串和 `end:false`；同一流只能有一个挂起读取 |
| `tunnel.write` | `{ tunnelId, data, end? }` | `{ written }`；单块最多 64 KiB，`end` 半关闭写方向 |
| `tunnel.close` | `{ tunnelId }` | `{ closed }`；释放 TCP 套接字和缓冲 |
| `browser.open` 🔒 | `{ workspaceId, peerId?, url, mode, controlled? }` | `LocalBrowserInfo`；`mode:service` 转发一个端口，返回本地 URL，由 UI 打开默认浏览器；`mode:network` 启动本地 Chromium 独立窗口和远程 HTTP / CONNECT 代理；`controlled:true` 也使用独立窗口并注册工作区控制器 |
| `browser.list` 🔒 | — | `{ browsers: LocalBrowserInfo[] }`；只列出调用连接创建的实例 |
| `browser.close` 🔒 | `{ browserId }` | `{ closed }`；关闭代理、转发和项目启动的独立浏览器 |
| `browser.attach` | `{ workspaceId, browserId }` | `{ attached:true }`；调用连接声明可在本地执行此工作区的浏览器命令 |
| `browser.detach` | `{ browserId }` | `{ detached }`；只有注册连接可以移除 |
| `browser.action` | `{ workspaceId, browserId?, command }` | `BrowserResult`；多个控制器时必须指定 ID；没有控制器时提示先在客户端打开并允许 Agent 操作 |
| `browser.result` | `{ requestId, result?, error? }` | `{ accepted }`；只有接收命令的注册连接能回复；命令超时或被取消后回复被忽略 |

`LocalBrowserInfo = { browserId, workspaceId, peerId?, url, localUrl, mode, controllable }`。
`BrowserCommand = { action, tabId?, url?, selector?, text?, key?, expression? }`；`action` 支持 `tabs` / `navigate` / `snapshot` / `click` / `fill` / `press` / `evaluate` / `screenshot`，选择器是 CSS。导航仅接受不带 userinfo 的 HTTP(S) 地址。`BrowserResult = { text?, image?: { data, mimeType:"image/png" } }`。

`browser.command` 事件 `{ browserId, requestId, command }` 只发给注册此控制器的连接，不广播、不写 EventLog。注册连接在本地私有 CDP 进程管道执行后调用 `browser.result`，远程等待上限 30 秒。断线、移除控制器或取消会话请求时结束等待。内置 pi 工具 `pier_browser` 使用相同路由和工作区审批策略；协议调用者按现有完全信任模型自行控制审批。

所有 TCP 流属于创建它的连接，其他连接访问时为 `NOT_FOUND`，关闭返回 `false`。每台 Host 最多 128 流，每条连接最多 64 流；每流读缓冲达到 512 KiB 后暂停套接字读取，低于 256 KiB 后继续。写入等待 Node 流回调后确认。客户端通过流背压按需读取，保持 HTTP(S)、WebSocket 和半关闭语义。连接断开 / Host 关闭时销毁所有所属套接字；目标连接断开或设备吊销时，本地回环监听器和独立浏览器也被清理。

浏览器仅由本地客户端显式启动，`controlled` 默认关闭；网络方式启动独立浏览器本身不授予 Agent 操作权限。独立浏览器配置按主机保存在本机 `browser-profiles`，配置目录由主机 ID 的 SHA-256 派生，浏览器控制不监听 TCP 调试端口。代理保持目标 origin，由远程 Host 解析域名与连接目标；关闭 QUIC 并限制 WebRTC 的非代理 UDP，覆盖 HTTP(S) / WebSocket 流量，不承诺系统级 VPN 语义。审计只记录连接目标 / 端口、工作区和动作名，不记录网页数据、输入、脚本或截图。
