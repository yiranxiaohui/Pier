import type { ApprovalPolicy, WorkspaceInfo } from "@pier/protocol";
import { type ComponentType, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { POLICY_DESCRIPTION, POLICY_LABEL } from "../lib/format.ts";
import { pageFollowsHost, pageIsLocalOnly } from "../lib/settings-target.ts";
import {
	LOCAL_NODE,
	type SettingsSection,
	useAppState,
	useComputers,
	useSettingsTarget,
	useStore,
} from "../lib/store.tsx";
import { setThemePreference, type ThemePreference, useThemePreference } from "../lib/theme.ts";
import { AccountSettings } from "./AccountPanel.tsx";
import { ClaudeSettings, CodexSettings } from "./AgentConfigPanel.tsx";
import { IconClaudeCode, IconCodex, IconPi } from "./AgentIcons.tsx";
import { ExtensionsSettings } from "./ExtensionsPanel.tsx";
import { HostBanner, LogsSettings, useHostStatus } from "./HostPanels.tsx";
import {
	IconArrowLeft,
	IconBot,
	IconCheck,
	IconChevronDown,
	IconFolder,
	IconFolderPlus,
	IconInfo,
	IconLoader,
	IconLogs,
	IconMonitor,
	IconPlus,
	IconPower,
	IconPuzzle,
	IconRefresh,
	IconSearch,
	IconSettings,
	IconSmartphone,
	IconSparkles,
	IconUser,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { ModelsSettings } from "./ModelsPanel.tsx";
import { PiSettings } from "./PiSettingsPanel.tsx";
import { RemoteSettings } from "./RemotePanel.tsx";
import { ResourcesSettings } from "./ResourcesPanel.tsx";
import { Select } from "./Select.tsx";
import { useOutsideClick } from "./SessionControls.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";
import { addWorkspaceBlocker } from "./Sidebar.tsx";
import { UpdateSettings, updatePending } from "./UpdatePanel.tsx";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

interface SectionDef {
	id: SettingsSection;
	label: string;
	icon: IconComponent;
	/** Extra words matched by the search box. */
	keywords: string;
	/** Needs a live connection to the host. */
	online?: boolean;
	/** Pages shown as tabs under this navigation entry (the entry's own id is the first tab). */
	tabs?: SectionDef[];
}

/**
 * Agents whose own configuration files the “Agent 配置” page edits, one tab each. A new agent
 * runtime gets its settings page by adding a tab here.
 */
const AGENT_PAGES: SectionDef[] = [
	{
		id: "pi",
		label: "pi",
		icon: IconPi,
		keywords:
			"pi 配置 settings settings.json 配置文件 思考 压缩 重试 超时 代理 proxy shell 工具 tools 传输 缓存 主题 终端 json 编辑",
		online: true,
	},
	{
		id: "claude",
		label: "Claude Code",
		icon: IconClaudeCode,
		keywords:
			"claude code 配置 anthropic settings.json 配置文件 中转 base url api key token 令牌 模型 思考 权限 permissions 沙箱 mcp hooks 环境变量 env 代理 json 编辑",
		online: true,
	},
	{
		id: "codex",
		label: "Codex",
		icon: IconCodex,
		keywords:
			"codex 配置 openai config.toml toml 配置文件 服务商 model_providers 中转 base url api key 模型 思考 reasoning 审批 沙箱 sandbox 网页搜索 mcp profile 编辑",
		online: true,
	},
];

const GROUPS: Array<{ title: string; items: SectionDef[] }> = [
	{
		title: "账号",
		items: [
			{
				id: "account",
				label: "个人中心",
				icon: IconUser,
				keywords: "个人中心 账号 账户 云链 云链api 登录 注册 余额 充值 分组 令牌 key yunlian",
				online: true,
			},
		],
	},
	{
		title: "通用",
		items: [
			{
				id: "general",
				label: "常规",
				icon: IconSettings,
				keywords:
					"host 状态 连接 版本 配置目录 重启 退出 开机 自启 登录 启动 托盘 autostart pi 外观 主题 风格 深色 暗黑 浅色 dark light",
			},
			{
				id: "models",
				label: "模型与服务商",
				icon: IconSparkles,
				keywords: "模型 服务商 provider api key 登录 默认模型 自定义接口 中转 ollama",
				online: true,
			},
			{
				id: "workspaces",
				label: "工作区",
				icon: IconFolder,
				keywords: "工作区 目录 审批 策略 权限 逐项审批 智能 自动放行 移除",
				online: true,
			},
			{
				id: "extensions",
				label: "扩展",
				icon: IconPuzzle,
				keywords: "扩展 插件 extension package 扩展包 npm git 安装 卸载 更新 启用 停用 技能 skill 提示词 prompt 主题",
				online: true,
			},
			{
				id: "resources",
				label: "Skills 与 MCP",
				icon: IconPuzzle,
				keywords: "skills 技能 mcp 服务器 管理 claude codex pi 添加 导入 编辑 启用 停用 测试连接",
				online: true,
			},
			{
				id: "pi",
				label: "Agent 配置",
				icon: IconBot,
				keywords: "agent 智能体 配置 配置文件 编辑",
				online: true,
				tabs: AGENT_PAGES,
			},
		],
	},
	{
		title: "连接",
		items: [
			{
				id: "remote",
				label: "设备与远程",
				icon: IconSmartphone,
				keywords: "手机 电脑 其他电脑 节点 互联 切换 远程 配对 二维码 链接 设备 局域网 端口 指纹",
				online: true,
			},
		],
	},
	{
		title: "系统",
		items: [
			{ id: "logs", label: "日志", icon: IconLogs, keywords: "日志 log host 排查" },
			{ id: "about", label: "关于与更新", icon: IconInfo, keywords: "关于 版本 更新 升级 发布说明" },
		],
	},
];

/** Navigation entries, each standing for itself or for the pages of its tabs. */
const NAV_ITEMS = GROUPS.flatMap((group) => group.items);
/** Every page, tabs included. */
const SECTIONS = NAV_ITEMS.flatMap((item) => item.tabs ?? [item]);

/** The navigation entry a page belongs to. */
function navItemOf(page: SettingsSection): SectionDef | undefined {
	return NAV_ITEMS.find((item) => item.id === page || item.tabs?.some((tab) => tab.id === page));
}

function sectionMatches(item: SectionDef, q: string): boolean {
	return !q || `${item.label} ${item.keywords}`.toLowerCase().includes(q);
}
const GENERAL = SECTIONS.find((item) => item.id === "general") as SectionDef;

// ---- pages -----------------------------------------------------------------------------

function syncedText(at: number | undefined): string {
	if (!at) return "尚未同步";
	return `已同步 · ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

/** The “常规” page for a paired computer: its Pier, reached through this computer's host. */
function RemoteGeneralSettings() {
	const store = useStore();
	const target = useSettingsTarget();
	const syncing = useAppState((s) => s.settingsSyncing);
	const syncedAt = useAppState((s) => s.settingsSyncedAt);
	const info = target.hostInfo;
	const versions = [
		info?.version ? `Pier v${info.version}` : "",
		info?.piVersion ? `pi ${info.piVersion}` : "",
		info?.protocolVersion ? `协议 ${info.protocolVersion}` : "",
	].filter(Boolean);
	return (
		<SettingsGroup title={`${target.name} 上的 Pier`}>
			<SettingsCard>
				<SettingRow
					title="连接状态"
					description={
						<span className="settings-inline-status">
							<span className={`status-dot ${target.online ? "ok" : target.connectError ? "bad" : "wait"}`} />
							{target.online
								? `已通过加密通道连接 · ${syncedText(syncedAt)}`
								: target.revoked
									? "那台电脑已移除这台电脑，需要重新配对"
									: target.connectError
										? `无法连接：${target.connectError}`
										: "正在连接…"}
						</span>
					}
				>
					{target.online ? (
						<button type="button" disabled={syncing} onClick={() => void store.syncSettings()}>
							{syncing ? <IconLoader size={14} className="spin" /> : <IconRefresh size={14} />}
							同步设置
						</button>
					) : target.revoked ? (
						<button type="button" onClick={() => store.openAddPeer()}>
							重新配对
						</button>
					) : (
						<button type="button" onClick={() => store.retryNode(target.node)}>
							立即重试
						</button>
					)}
				</SettingRow>
				{versions.length ? (
					<SettingRow title="版本" description="那台电脑上的 Pier、内置 pi 与协议版本。">
						<span className="setting-value">{versions.join(" · ")}</span>
					</SettingRow>
				) : null}
				{info?.platform ? (
					<SettingRow title="系统" description="那台电脑的操作系统。">
						<span className="setting-value mono">{info.platform}</span>
					</SettingRow>
				) : null}
				{info?.agentDir ? (
					<SettingRow title="配置目录" description="那台电脑上 pi 的配置目录；这里的修改直接保存在那里。">
						<code className="setting-value mono" title={info.agentDir}>
							{info.agentDir}
						</code>
						<CopyButton text={info.agentDir} label="复制路径" iconOnly />
					</SettingRow>
				) : null}
				<SettingRow
					title="更新"
					description="在「关于与更新 → 其他电脑」中检查并安装那台电脑上的 Pier 更新。重启或退出 Pier 只能在那台电脑上进行。"
				>
					<button type="button" onClick={() => store.openSettings("about")}>
						<IconInfo size={14} />
						关于与更新
					</button>
				</SettingRow>
			</SettingsCard>
		</SettingsGroup>
	);
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
	{ value: "system", label: "跟随系统" },
	{ value: "light", label: "浅色" },
	{ value: "dark", label: "深色" },
];

/** Light/dark appearance of this device's window, whichever computer the settings manage. */
function AppearanceSettings() {
	const preference = useThemePreference();
	return (
		<SettingsGroup title="外观">
			<SettingsCard>
				<SettingRow title="主题" description="界面使用浅色或深色配色，只对这台设备生效。">
					<div className="segmented">
						{THEME_OPTIONS.map((option) => (
							<button
								type="button"
								key={option.value}
								aria-pressed={preference === option.value}
								className={preference === option.value ? "active" : undefined}
								onClick={() => setThemePreference(option.value)}
							>
								{option.label}
							</button>
						))}
					</div>
				</SettingRow>
			</SettingsCard>
		</SettingsGroup>
	);
}

function GeneralSettings() {
	const remote = useAppState((s) => s.settingsNode !== LOCAL_NODE);
	return (
		<>
			<AppearanceSettings />
			{remote ? <RemoteGeneralSettings /> : <LocalGeneralSettings />}
		</>
	);
}

function AutostartSetting() {
	const store = useStore();
	const [enabled, setEnabled] = useState<boolean>();
	const [pending, setPending] = useState(true);
	const [error, setError] = useState<string>();
	const request = useRef(0);
	const readStatus = useCallback(async () => {
		const id = ++request.current;
		setPending(true);
		setError(undefined);
		try {
			const value = await store.autostartStatus();
			if (id === request.current) setEnabled(value);
		} catch (reason) {
			if (id === request.current) {
				setEnabled(undefined);
				setError(`无法读取开机自启状态：${reason instanceof Error ? reason.message : String(reason)}`);
			}
		} finally {
			if (id === request.current) setPending(false);
		}
	}, [store]);
	useEffect(() => {
		void readStatus();
		return () => {
			request.current++;
		};
	}, [readStatus]);
	const change = async (value: boolean) => {
		const id = ++request.current;
		setPending(true);
		setError(undefined);
		try {
			const actual = await store.setAutostartEnabled(value);
			if (id === request.current) setEnabled(actual);
		} catch (reason) {
			if (id === request.current) {
				setError(`修改开机自启失败：${reason instanceof Error ? reason.message : String(reason)}`);
			}
		} finally {
			if (id === request.current) setPending(false);
		}
	};
	return (
		<SettingRow
			title="开机自启"
			description={
				<>
					登录这台电脑时自动启动 Pier 并在托盘运行；默认关闭。
					{error ? (
						<div className="error-text" role="alert">
							{error}
						</div>
					) : null}
				</>
			}
		>
			{pending ? <IconLoader size={14} className="spin" /> : null}
			{error ? (
				<button type="button" disabled={pending} onClick={() => void readStatus()}>
					<IconRefresh size={14} />
					重新读取
				</button>
			) : null}
			<Switch
				label="开机自启"
				checked={enabled ?? false}
				disabled={pending || enabled === undefined}
				onChange={(value) => void change(value)}
			/>
		</SettingRow>
	);
}

function LocalGeneralSettings() {
	const store = useStore();
	const host = useAppState((s) => s.host);
	const hostInfo = useAppState((s) => s.localHostInfo);
	const status = useHostStatus();
	const tauri = store.bridgeKind === "tauri";
	const [confirmQuit, setConfirmQuit] = useState(false);
	const versions = [
		`Pier v${useAppState((s) => s.update.currentVersion)}`,
		host.version ? `Host v${host.version}` : "",
		hostInfo ? `pi ${hostInfo.piVersion}` : "",
	].filter(Boolean);
	return (
		<>
			<SettingsGroup title="Pier Host">
				<SettingsCard>
					<SettingRow
						title="连接状态"
						description={
							<span className="settings-inline-status">
								<span className={`status-dot ${status.dot}`} />
								{status.text}
								{host.restarts ? ` · 已自动重启 ${host.restarts} 次` : ""}
							</span>
						}
					>
						{tauri ? (
							<button type="button" onClick={() => store.restartHost()}>
								重启 Host
							</button>
						) : null}
					</SettingRow>
					<SettingRow title="版本" description="桌面端、Pier Host 与内置 pi 的版本。">
						<span className="setting-value">{versions.join(" · ")}</span>
					</SettingRow>
					{hostInfo?.agentDir ? (
						<SettingRow title="配置目录" description="模型、凭据与会话复用 pi 的配置，与终端里的 pi 共用。">
							<code className="setting-value mono" title={hostInfo.agentDir}>
								{hostInfo.agentDir}
							</code>
							<CopyButton text={hostInfo.agentDir} label="复制路径" iconOnly />
						</SettingRow>
					) : null}
					{host.url ? (
						<SettingRow title="本地地址" description="桌面界面连接 Host 使用的地址，仅本机可访问。">
							<code className="setting-value mono">
								{host.url}
								{host.pid ? ` · pid ${host.pid}` : ""}
							</code>
						</SettingRow>
					) : null}
					<SettingRow title="运行日志" description="连接或启动出现问题时，可以在这里查看 Host 输出。">
						<button type="button" onClick={() => store.openSettings("logs")}>
							<IconLogs size={14} />
							查看日志
						</button>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>
			{tauri ? (
				<SettingsGroup title="应用">
					<SettingsCard>
						<AutostartSetting />
						<SettingRow
							title="退出 Pier"
							description="关闭窗口只会隐藏到托盘，Agent 继续运行；退出会停止 Pier Host 并中断正在运行的任务。"
						>
							<button
								type="button"
								className="danger"
								onBlur={() => setConfirmQuit(false)}
								onClick={() => {
									if (!confirmQuit) {
										setConfirmQuit(true);
										return;
									}
									store.quit();
								}}
							>
								<IconPower size={14} />
								{confirmQuit ? "确认退出" : "退出"}
							</button>
						</SettingRow>
					</SettingsCard>
				</SettingsGroup>
			) : null}
		</>
	);
}

function WorkspaceCard({ workspace, readOnly = false }: { workspace: WorkspaceInfo; readOnly?: boolean }) {
	const store = useStore();
	const [confirmRemove, setConfirmRemove] = useState(false);
	return (
		<SettingsCard>
			<SettingRow
				title={
					<span className="settings-workspace-name">
						<IconFolder size={15} />
						{workspace.name}
					</span>
				}
				description={<span className="mono">{workspace.path}</span>}
			>
				<button
					type="button"
					className={confirmRemove ? "danger" : "ghost"}
					disabled={readOnly}
					onBlur={() => setConfirmRemove(false)}
					onClick={() => {
						if (!confirmRemove) {
							setConfirmRemove(true);
							return;
						}
						void store.removeWorkspace(workspace.id);
					}}
					title="从 Pier 移除工作区（不会删除任何文件）"
				>
					{confirmRemove ? "确认移除" : "移除"}
				</button>
			</SettingRow>
			<SettingRow
				title="工具审批策略"
				description={
					<span className={workspace.policy === "auto" ? "warning-text" : undefined}>
						{POLICY_DESCRIPTION[workspace.policy]}
					</span>
				}
			>
				<Select
					className="setting-select compact"
					value={workspace.policy}
					disabled={readOnly}
					onChange={(policy) => void store.setPolicy(workspace.id, policy)}
					options={(["ask", "smart", "auto"] as ApprovalPolicy[]).map((policy) => ({
						value: policy,
						label: `${POLICY_LABEL[policy]}${policy === "smart" ? "（默认）" : ""}`,
					}))}
				/>
			</SettingRow>
		</SettingsCard>
	);
}

function WorkspacesSettings() {
	const store = useStore();
	const computers = useComputers();
	const hasPeers = computers.length > 1;
	return (
		<>
			<p className="settings-intro">
				{hasPeers
					? "这里管理本机和已配对电脑上的工作区，它们都列在左侧边栏中；新建会话时选择工作区，就决定了 Agent 在哪台电脑上运行。"
					: "这里管理本机的工作区。"}
				每个工作区可以单独设置 Agent 调用工具时的审批策略。危险命令（rm -r、sudo、git push --force
				等）在“逐项审批”和“智能”策略下总是需要批准。移除工作区不会删除任何文件。
			</p>
			{computers.map((computer) => {
				const { workspaces } = computer.state;
				const blocker = addWorkspaceBlocker(computer);
				const manageable = computer.online && computer.canManage;
				return (
					<SettingsGroup
						key={computer.id}
						title={
							hasPeers
								? `${computer.name}${computer.local ? "（本机）" : ""} · ${workspaces.length} 个工作区`
								: `工作区（${workspaces.length}）`
						}
						actions={
							<button
								type="button"
								disabled={blocker !== undefined}
								title={blocker}
								onClick={() => void store.pickAndAddWorkspace(computer.id)}
							>
								<IconPlus size={14} />
								添加工作区
							</button>
						}
					>
						{!computer.local && blocker ? <p className="muted small settings-note">{blocker}</p> : null}
						{workspaces.length ? (
							<div className="settings-stack">
								{workspaces.map((workspace) => (
									<WorkspaceCard key={workspace.id} workspace={workspace} readOnly={!manageable} />
								))}
							</div>
						) : blocker === undefined ? (
							<button type="button" className="add-first" onClick={() => void store.pickAndAddWorkspace(computer.id)}>
								<IconFolderPlus size={16} />
								添加第一个工作区
							</button>
						) : null}
					</SettingsGroup>
				);
			})}
		</>
	);
}

const PAGES: Record<SettingsSection, ComponentType> = {
	account: AccountSettings,
	general: GeneralSettings,
	models: ModelsSettings,
	workspaces: WorkspacesSettings,
	extensions: ExtensionsSettings,
	resources: ResourcesSettings,
	pi: PiSettings,
	claude: ClaudeSettings,
	codex: CodexSettings,
	remote: RemoteSettings,
	logs: LogsSettings,
	about: UpdateSettings,
};

// ---- screen ----------------------------------------------------------------------------

/**
 * Choose the computer whose Pier the settings screen manages, and sync its settings again.
 * Only shown once another computer is paired.
 */
function HostSwitcher() {
	const store = useStore();
	const computers = useComputers();
	const target = useSettingsTarget();
	const syncing = useAppState((s) => s.settingsSyncing);
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const ref = useOutsideClick(open, close);
	if (computers.length < 2) return null;
	const status = hostStatus(target.local, target.online, target.connectError, target.revoked);
	return (
		<div className="dropdown settings-host" ref={ref}>
			<button
				type="button"
				className={`settings-host-trigger${open ? " open" : ""}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`正在设置 ${target.name} 上的 Pier，点击切换电脑`}
				title={`正在设置 ${target.name} 上的 Pier`}
				onClick={() => setOpen(!open)}
			>
				<span className="settings-host-avatar">
					<IconMonitor size={16} />
					<span className={`status-dot ${status.tone}`} />
				</span>
				<span className="settings-host-text">
					<span className="settings-host-name">{target.name}</span>
					<span className="settings-host-detail">{status.text}</span>
				</span>
				{syncing ? (
					<IconLoader size={14} className="spin settings-host-chevron" />
				) : (
					<IconChevronDown size={14} className="settings-host-chevron" />
				)}
			</button>
			{open ? (
				<div className="dropdown-menu settings-host-menu" role="menu">
					<div className="dropdown-group-title no-caps">设置哪台电脑上的 Pier</div>
					{computers.map((computer) => {
						const item = hostStatus(
							computer.local,
							computer.online,
							computer.state.connectError,
							computer.state.revoked === true,
						);
						const selected = computer.id === target.node;
						return (
							<button
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								key={computer.id}
								className={`dropdown-item settings-host-item${selected ? " selected" : ""}`}
								title={computer.name}
								onClick={() => {
									close();
									if (!selected) store.setSettingsNode(computer.id);
								}}
							>
								<span className={`status-dot ${item.tone}`} />
								<span className="settings-host-text">
									<span className="settings-host-name">{computer.name}</span>
									<span className="settings-host-detail">{item.text}</span>
								</span>
								{selected ? <IconCheck size={14} className="settings-host-check" /> : null}
							</button>
						);
					})}
					<div className="dropdown-separator" />
					<button
						type="button"
						role="menuitem"
						className="dropdown-item"
						disabled={syncing || !target.online}
						onClick={() => {
							close();
							void store.syncSettings();
						}}
					>
						<span className="menu-label">
							<IconRefresh size={14} />从{target.local ? "本机" : ` ${target.name} `}重新同步设置
						</span>
					</button>
					<button
						type="button"
						role="menuitem"
						className="dropdown-item"
						onClick={() => {
							close();
							store.openAddPeer();
						}}
					>
						<span className="menu-label">
							<IconPlus size={14} />
							添加电脑…
						</span>
					</button>
				</div>
			) : null}
		</div>
	);
}

/** The status dot tone and one-line description of a computer in the host switcher. */
function hostStatus(
	local: boolean,
	online: boolean,
	connectError: string | undefined,
	revoked: boolean,
): { tone: "ok" | "bad" | "wait"; text: string } {
	const where = local ? "本机" : "远程";
	if (online) return { tone: "ok", text: `${where} · 已连接` };
	if (revoked) return { tone: "bad", text: `${where} · 需要重新配对` };
	if (connectError) return { tone: "bad", text: `${where} · 无法连接` };
	return { tone: "wait", text: `${where} · 正在连接…` };
}

/** Above the pages that manage a paired computer: which computer the changes go to. */
function RemoteTargetBanner() {
	const store = useStore();
	const target = useSettingsTarget();
	const syncing = useAppState((s) => s.settingsSyncing);
	const syncedAt = useAppState((s) => s.settingsSyncedAt);
	return (
		<div className="banner info inline settings-target-banner">
			<IconMonitor size={15} />
			<span>
				正在设置 <strong>{target.name}</strong> 上的 Pier，修改会直接保存到那台电脑。
				{target.online ? <span className="muted"> {syncedText(syncedAt)}</span> : null}
			</span>
			<span className="banner-actions">
				<button type="button" disabled={syncing || !target.online} onClick={() => void store.syncSettings()}>
					{syncing ? <IconLoader size={13} className="spin" /> : <IconRefresh size={13} />}
					同步
				</button>
				<button type="button" className="ghost" onClick={() => store.setSettingsNode(LOCAL_NODE)}>
					切换到本机
				</button>
			</span>
		</div>
	);
}

/** A page that manages a paired computer which cannot be reached (or is too old) right now. */
function RemoteUnavailable({ blocker }: { blocker?: string | undefined }) {
	const store = useStore();
	const target = useSettingsTarget();
	if (blocker) {
		return (
			<SettingsCard>
				<SettingRow title="无法远程修改" description={blocker}>
					<button type="button" onClick={() => store.openSettings("about")}>
						关于与更新
					</button>
				</SettingRow>
			</SettingsCard>
		);
	}
	const text = target.revoked
		? `${target.name} 已移除这台电脑（或重置了 Pier），需要重新配对后才能修改它的设置。`
		: target.connectError
			? `无法连接到 ${target.name}：${target.connectError}。连接后会自动同步它的设置。`
			: `正在连接 ${target.name}，连接后会自动同步它的设置…`;
	return (
		<SettingsCard>
			<SettingRow title={`${target.name} 未连接`} description={text}>
				{target.revoked ? (
					<button type="button" onClick={() => store.openAddPeer()}>
						重新配对
					</button>
				) : (
					<button type="button" onClick={() => store.retryNode(target.node)}>
						立即重试
					</button>
				)}
				<button type="button" className="ghost" onClick={() => store.setSettingsNode(LOCAL_NODE)}>
					切换到本机
				</button>
			</SettingRow>
		</SettingsCard>
	);
}

function NavBadge({ id }: { id: SettingsSection }): ReactNode {
	const noModels = useAppState((s) => s.providers?.availableCount === 0);
	const remote = useAppState((s) => s.remote);
	const connected = useAppState((s) => s.devices.filter((d) => d.connected).length);
	const update = useAppState((s) => s.update);
	const managingOther = useAppState((s) => s.settingsNode !== LOCAL_NODE);
	if (id === "models" && noModels) return <span className="nav-dot warn" title="还没有可用模型" />;
	if (managingOther && pageIsLocalOnly(id)) {
		return (
			<span className="nav-tag" title="这一页只针对本机">
				本机
			</span>
		);
	}
	if (id === "remote" && (remote?.running || remote?.relay?.state === "online") && connected > 0) {
		return (
			<span className="nav-count" title={`${connected} 台设备在线`}>
				{connected}
			</span>
		);
	}
	if (id === "about" && updatePending(update)) return <span className="nav-dot accent" title="有可用更新" />;
	return null;
}

export function SettingsPage({ section }: { section: SettingsSection }) {
	const store = useStore();
	const [query, setQuery] = useState("");
	const { online } = useHostStatus();
	const target = useSettingsTarget();
	const sync = useAppState((s) => s.settingsSync);
	// Re-render when the managed computer's info (protocol version) changes.
	useAppState((s) => s.nodes[s.settingsNode]?.hostInfo);

	// Esc leaves the settings screen unless a dialog on top of it handles the key.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || document.querySelector(".modal-backdrop")) return;
			const target = e.target as HTMLElement | null;
			if (target?.tagName === "INPUT" && (target as HTMLInputElement).value) return;
			store.closeSettings();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [store]);

	const q = query.trim().toLowerCase();
	const groups = GROUPS.map((group) => ({
		...group,
		items: group.items.filter((item) => sectionMatches(item, q) || item.tabs?.some((tab) => sectionMatches(tab, q))),
	})).filter((group) => group.items.length);
	const current = SECTIONS.find((item) => item.id === section) ?? GENERAL;
	const nav = navItemOf(current.id) ?? GENERAL;
	// The tab last shown under each entry with tabs, so coming back to it returns there.
	const lastTab = useRef<Partial<Record<SettingsSection, SettingsSection>>>({});
	if (nav.tabs) lastTab.current[nav.id] = current.id;
	const openNav = (item: SectionDef) => {
		if (!item.tabs) {
			store.openSettings(item.id);
			return;
		}
		const matching = q ? item.tabs.find((tab) => sectionMatches(tab, q)) : undefined;
		if (!matching && item.id === nav.id) return;
		store.openSettings(matching?.id ?? lastTab.current[item.id] ?? item.id);
	};
	const Page = PAGES[current.id];
	const followsHost = pageFollowsHost(current.id);
	const remoteTarget = followsHost && !target.local;
	const blocker = remoteTarget ? store.settingsBlocker(current.id) : undefined;
	let body: ReactNode;
	if (current.online && !online) {
		body = (
			<SettingsCard>
				<div className="settings-empty">Pier Host 未连接，连接后才能修改这些设置。</div>
			</SettingsCard>
		);
	} else if (remoteTarget && current.id !== "general" && (!target.online || blocker)) {
		body = <RemoteUnavailable blocker={target.online ? blocker : undefined} />;
	} else {
		// Switching computers or syncing again remounts the page, which reads everything afresh.
		body = <Page key={followsHost ? `${target.node}:${sync}:${current.id}` : current.id} />;
	}

	return (
		<div className="app settings-screen">
			<aside className="sidebar settings-nav">
				<div className="settings-nav-top">
					<button type="button" className="ghost settings-back" onClick={() => store.closeSettings()}>
						<IconArrowLeft size={15} />
						返回应用
					</button>
				</div>
				<h1 className="settings-nav-title">设置</h1>
				<HostSwitcher />
				<div className="settings-search">
					<IconSearch size={14} />
					<input placeholder="搜索设置" value={query} onChange={(e) => setQuery(e.target.value)} />
					{query ? (
						<button type="button" className="ghost icon" title="清除" onClick={() => setQuery("")}>
							<IconX size={13} />
						</button>
					) : null}
				</div>
				<nav className="settings-nav-list">
					{groups.map((group) => (
						<div key={group.title} className="settings-nav-group">
							<div className="settings-nav-group-title">{group.title}</div>
							{group.items.map((item) => (
								<button
									type="button"
									key={item.id}
									className={`settings-nav-item${item.id === nav.id ? " selected" : ""}`}
									onClick={() => openNav(item)}
								>
									<item.icon size={15} />
									<span className="settings-nav-label">{item.label}</span>
									<NavBadge id={item.id} />
								</button>
							))}
						</div>
					))}
					{!groups.length ? <div className="settings-nav-empty">没有匹配的设置</div> : null}
				</nav>
			</aside>
			<main className="main settings-main">
				<HostBanner onShowLogs={() => store.openSettings("logs")} />
				<div className="settings-scroll">
					<div className="settings-content">
						<h1 className="settings-title">{nav.label}</h1>
						{nav.tabs ? (
							<div className="settings-tabs" role="tablist" aria-label={nav.label}>
								{nav.tabs.map((tab) => (
									<button
										type="button"
										role="tab"
										key={tab.id}
										aria-selected={tab.id === current.id}
										className={`settings-tab${tab.id === current.id ? " active" : ""}`}
										onClick={() => store.openSettings(tab.id)}
									>
										<tab.icon size={14} />
										{tab.label}
									</button>
								))}
							</div>
						) : null}
						{remoteTarget && current.id !== "general" ? <RemoteTargetBanner /> : null}
						{!target.local && pageIsLocalOnly(current.id) ? (
							<p className="muted small settings-note">
								这一页只针对本机（{store.nodeName(LOCAL_NODE)}），不受上方所选电脑影响。
							</p>
						) : null}
						{body}
					</div>
				</div>
			</main>
		</div>
	);
}
