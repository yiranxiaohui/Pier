import type { ApprovalPolicy, WorkspaceInfo } from "@pier/protocol";
import { type ComponentType, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { POLICY_DESCRIPTION, POLICY_LABEL } from "../lib/format.ts";
import { pageDescribesHost, pageFollowsHost, pageIsReadOnly } from "../lib/settings-target.ts";
import {
	type FilePreviewMode,
	LOCAL_NODE,
	type SettingsSection,
	useAppState,
	useComputers,
	useHasPeers,
	useSettingsTarget,
	useStore,
} from "../lib/store.tsx";
import { setThemePreference, type ThemePreference, useThemePreference } from "../lib/theme.ts";
import { AccountSettings } from "./AccountPanel.tsx";
import { ClaudeSettings, CodexSettings, OpenCodeSettings } from "./AgentConfigPanel.tsx";
import { IconClaudeCode, IconCodex, IconOpenCode, IconPi } from "./AgentIcons.tsx";
import { ExtensionsSettings } from "./ExtensionsPanel.tsx";
import { HostBanner, LogsSettings, useHostStatus } from "./HostPanels.tsx";
import {
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
	IconSliders,
	IconSparkles,
	IconUser,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { ModelsSettings } from "./ModelsPanel.tsx";
import { PiSettings } from "./PiSettingsPanel.tsx";
import { ResourcesSettings } from "./ResourcesPanel.tsx";
import { Select } from "./Select.tsx";
import { useOutsideClick } from "./SessionControls.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";
import { addWorkspaceBlocker } from "./Sidebar.tsx";
import { SpeechSettings } from "./SpeechSettings.tsx";
import { computerUpdateStatus, UpdateSettings, updatePending } from "./UpdatePanel.tsx";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

interface SectionDef {
	id: SettingsSection;
	label: string;
	icon: IconComponent;
	/** Extra words matched by the search box. */
	keywords: string;
	/** Needs a live connection to the host. */
	online?: boolean;
	/**
	 * Pages shown as tabs under this navigation entry, or as secondary tabs under this tab (the
	 * entry's own id is the first tab).
	 */
	tabs?: SectionDef[];
}

/** The pages a navigation entry or tab stands for: itself, or the pages of its tabs. */
function pagesOf(item: SectionDef): SectionDef[] {
	return item.tabs ? item.tabs.flatMap(pagesOf) : [item];
}

/**
 * pi's own pages under its “Agent 配置” tab: its settings.json, its model providers and default
 * model (models.json and auth.json, which only pi reads), and its extension packages, which only pi
 * loads (Skills and MCP shared by every agent stay on their own page).
 */
const PI_PAGES: SectionDef[] = [
	{
		id: "pi",
		label: "设置",
		icon: IconSliders,
		keywords:
			"pi 配置 安装 更新 版本 install update settings settings.json 配置文件 思考 压缩 重试 超时 代理 proxy shell 工具 tools 传输 缓存 主题 终端 json 编辑",
		online: true,
	},
	{
		id: "models",
		label: "模型与服务商",
		icon: IconSparkles,
		keywords:
			"pi 模型 服务商 provider models.json auth.json api key 密钥 登录 默认模型 自定义接口 中转 base url ollama lm studio vllm 云链",
		online: true,
	},
	{
		id: "extensions",
		label: "扩展",
		icon: IconPuzzle,
		keywords:
			"pi 扩展 插件 extension package 扩展包 扩展市场 npm git 安装 卸载 更新 启用 停用 技能 skill 提示词 prompt 主题",
		online: true,
	},
];

/**
 * Agents whose own configuration files the “Agent 配置” page edits, one tab each. A new agent
 * runtime gets its settings page by adding a tab here.
 */
const AGENT_PAGES: SectionDef[] = [
	{
		id: "pi",
		label: "pi",
		icon: IconPi,
		keywords: "pi",
		online: true,
		tabs: PI_PAGES,
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
	{
		id: "opencode",
		label: "OpenCode",
		icon: IconOpenCode,
		keywords:
			"opencode 配置 opencode.json opencode.jsonc json 配置文件 服务商 provider 中转 base url api key 模型 small_model agent 权限 permission 指令 instructions mcp 登录 安装 编辑",
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
					"host 状态 连接 版本 配置目录 重启 退出 开机 自启 登录 启动 托盘 autostart pi 外观 主题 风格 深色 暗黑 浅色 dark light 文件预览 预览 弹窗 全屏 右侧面板 标签页 会话列表 会话 工作区 侧边栏 排序 自动排序 最近活动 置顶 最前 创建时间",
			},
			{
				id: "workspaces",
				label: "工作区",
				icon: IconFolder,
				keywords: "工作区 目录 审批 策略 权限 逐项审批 智能 自动放行 移除",
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
const SECTIONS = NAV_ITEMS.flatMap(pagesOf);

/** The navigation entry a page belongs to. */
function navItemOf(page: SettingsSection): SectionDef | undefined {
	return NAV_ITEMS.find((item) => pagesOf(item).some((p) => p.id === page));
}

/** The tab of a navigation entry (or the secondary tab of a tab) that a page belongs to. */
function tabOf(item: SectionDef | undefined, page: SettingsSection): SectionDef | undefined {
	return item?.tabs?.find((tab) => pagesOf(tab).some((p) => p.id === page));
}

function sectionMatches(item: SectionDef, q: string): boolean {
	return !q || `${item.label} ${item.keywords}`.toLowerCase().includes(q);
}

/** Whether an entry, one of its tabs or one of their pages matches the search. */
function itemMatches(item: SectionDef, q: string): boolean {
	return sectionMatches(item, q) || (item.tabs?.some((tab) => itemMatches(tab, q)) ?? false);
}

/** The first page under an entry's tabs that matches the search, by itself or through its tab. */
function matchingPage(item: SectionDef, q: string): SectionDef | undefined {
	for (const tab of item.tabs ?? []) {
		const page = sectionMatches(tab, q) ? pagesOf(tab)[0] : matchingPage(tab, q);
		if (page) return page;
	}
	return undefined;
}
const PAGE_DESCRIPTIONS: Record<SettingsSection, string> = {
	account: "管理云链API 账号、额度与令牌，连接你的 Agent。",
	general: "让 Pier 更合你的习惯，调整外观、文件预览、侧边栏排序、语音与启动方式。",
	models: "为 pi 连接模型服务商，选择 pi 新会话的默认模型。",
	workspaces: "管理项目目录，为每个工作区选择合适的工具审批策略。",
	extensions: "发现与管理 pi 的扩展包，为 pi 的工作流程添加更多能力。",
	resources: "统一管理 Agent 的技能与 MCP 服务器。",
	pi: "安装或更新 pi，调整它的模型、工具与运行偏好。",
	claude: "管理 Claude Code 的模型、权限与运行偏好。",
	codex: "管理 Codex 的服务商、审批与运行偏好。",
	opencode: "管理 OpenCode 的模型、服务商与权限。",
	logs: "查看 Host 的运行记录，定位连接与启动问题。",
	about: "了解 Pier，获取最新版本与更新信息。",
};

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
					<SettingRow title="版本" description="那台电脑上的 Pier、pi 与协议版本。">
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
					description="在「关于与更新」中检查并安装那台电脑上的 Pier 更新。重启或退出 Pier 只能在那台电脑上进行。"
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
		<SettingsGroup title="外观" description="选择舒适的界面主题，仅对这台设备生效。">
			<div className="settings-theme-options" role="radiogroup" aria-label="界面主题">
				{THEME_OPTIONS.map((option) => (
					<label
						key={option.value}
						className={`settings-theme-option${preference === option.value ? " selected" : ""}`}
					>
						<input
							type="radio"
							name="appearance-theme"
							value={option.value}
							checked={preference === option.value}
							onChange={() => setThemePreference(option.value)}
							className="settings-theme-input"
						/>
						<span className={`settings-theme-preview ${option.value}`} aria-hidden="true">
							<span className="settings-theme-sidebar">
								<i />
								<i />
								<i />
							</span>
							<span className="settings-theme-window">
								<i />
								<i />
								<span>
									<i />
									<i />
								</span>
							</span>
						</span>
						<span className="settings-theme-label">
							{option.label}
							<span className="settings-theme-check" aria-hidden="true">
								{preference === option.value ? <IconCheck size={12} /> : null}
							</span>
						</span>
					</label>
				))}
			</div>
		</SettingsGroup>
	);
}

const FILE_PREVIEW_OPTIONS: Array<{ value: FilePreviewMode; label: string }> = [
	{ value: "panel", label: "右侧面板（默认）" },
	{ value: "modal", label: "全屏弹窗" },
];

/** Where opened files show on this device, whichever computer the settings manage. */
function FilePreviewSettings() {
	const store = useStore();
	const mode = useAppState((s) => s.filePreviewMode);
	return (
		<SettingsGroup title="文件预览" description="选择打开文件时的显示方式，仅对这台设备生效。">
			<SettingsCard>
				<SettingRow
					title="显示方式"
					description={
						mode === "panel"
							? "文件在右侧面板中打开，每个文件一个标签页，与「文件」「源代码管理」共用这一栏，可边看边聊；拖动面板左边缘调整宽度。"
							: "文件在铺满整个窗口的弹窗中打开，多个文件同样以标签页切换；关闭弹窗后回到对话。"
					}
				>
					<Select
						className="setting-select compact"
						ariaLabel="文件预览显示方式"
						value={mode}
						onChange={(value) => store.setFilePreviewMode(value)}
						options={FILE_PREVIEW_OPTIONS}
					/>
				</SettingRow>
			</SettingsCard>
		</SettingsGroup>
	);
}

function SidebarSortSettings() {
	const store = useStore();
	const byActivity = useAppState((s) => s.sortSessionsByActivity);
	return (
		<SettingsGroup title="侧边栏排序" description="选择侧边栏中工作区和会话的排列方式，仅对这台设备生效。">
			<SettingsCard>
				<SettingRow
					title="按最近活动自动排序"
					description={
						byActivity
							? "会话一开始运行就移到所在工作区列表的最前，所在工作区也移到最上面；会话旁显示最近活动的时间。此时不能拖动调整工作区顺序，关闭后恢复你拖好的顺序。"
							: "默认关闭：工作区保持你拖动调整的顺序；会话按创建时间排列，新建的会话在最前，之后不会因为运行而改变位置；会话旁显示创建时间。"
					}
				>
					<Switch
						label="按最近活动自动排序"
						checked={byActivity}
						onChange={(value) => store.setSortSessionsByActivity(value)}
					/>
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
			<FilePreviewSettings />
			<SidebarSortSettings />
			<SettingsGroup title="语音输入" description="在本机设置识别方式，让想法更快变成文字。">
				<SettingsCard>
					<SettingRow title="语音识别服务" stack>
						<SpeechSettings />
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>
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
		hostInfo?.piVersion ? `pi ${hostInfo.piVersion}` : "",
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
					<SettingRow title="版本" description="桌面端、Pier Host 与 pi 的版本（pi 是这台电脑上你自己安装的版本）。">
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
	const target = useSettingsTarget();
	const computers = useComputers().filter((computer) => computer.id === target.node);
	return (
		<>
			<p className="settings-intro">
				这里管理 {target.name} 上的工作区。切换右上角的电脑可以管理其他主机的工作区。 每个工作区可以单独设置 Agent
				调用工具时的审批策略。危险命令（rm -r、sudo、git push --force
				等）在“逐项审批”和“智能”策略下总是需要批准。移除工作区不会删除任何文件。
			</p>
			{computers.map((computer) => {
				const { workspaces } = computer.state;
				const blocker = addWorkspaceBlocker(computer);
				const manageable = computer.online && computer.canManage;
				return (
					<SettingsGroup
						key={computer.id}
						title={`${computer.name}${computer.local ? "（本机）" : ""} · ${workspaces.length} 个工作区`}
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
	opencode: OpenCodeSettings,
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
	const update = useAppState((s) => s.update);
	const peerUpdates = useAppState((s) => s.peerUpdates);
	const nodes = useAppState((s) => s.nodes);
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
				aria-label={`正在设置 ${target.name} 上的 Pier，${status.text}，点击切换电脑`}
				title={`正在设置 ${target.name} 上的 Pier · ${status.text}`}
				onClick={() => setOpen(!open)}
			>
				<span className="settings-host-avatar">
					<IconMonitor size={14} />
					<span className={`status-dot ${status.tone}`} />
				</span>
				<span className="settings-host-label">
					{target.local ? "本机" : "远程"} · {target.name}
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
						const status = computerUpdateStatus(computer.id, { update, peerUpdates, nodes });
						const pending = status && updatePending(status) && status.version ? status.version : undefined;
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
									<span className="settings-host-detail">
										{item.text}
										{pending ? <span className="settings-host-update"> · 可更新到 v{pending}</span> : null}
									</span>
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
function RemoteTargetBanner({ readOnly = false }: { readOnly?: boolean }) {
	const store = useStore();
	const target = useSettingsTarget();
	const syncing = useAppState((s) => s.settingsSyncing);
	const syncedAt = useAppState((s) => s.settingsSyncedAt);
	return (
		<div className="banner info inline settings-target-banner">
			<IconMonitor size={15} />
			<span>
				{readOnly ? "正在查看" : "正在设置"} <strong>{target.name}</strong> 上的 Pier，
				{readOnly ? "此页只读，不会修改本机或远程主机。" : "修改会直接保存到那台电脑。"}
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
				<SettingRow title="此主机暂不支持此页" description={blocker}>
					<button type="button" onClick={() => store.openSettings("about")}>
						关于与更新
					</button>
				</SettingRow>
			</SettingsCard>
		);
	}
	const text = target.revoked
		? `${target.name} 已移除这台电脑（或重置了 Pier），需要重新配对后才能查看它的设置。`
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

/** The DOM id of a tab, or of a secondary tab (pi's tab and its settings page share the id `pi`). */
function tabElementId(tab: SectionDef, secondary = false): string {
	return `settings-${secondary ? "subtab" : "tab"}-${tab.id}`;
}

const TAB_KEYS: Record<string, (index: number, count: number) => number> = {
	ArrowRight: (index, count) => (index + 1) % count,
	ArrowLeft: (index, count) => (index - 1 + count) % count,
	Home: () => 0,
	End: (_, count) => count - 1,
};

/**
 * The tabs under a page title (the agents in “Agent 配置”), or the secondary tabs under one of
 * them (pi's settings, models and extensions). Arrow keys, Home and End move between them.
 */
function SettingsTabs({
	tabs,
	active,
	label,
	onOpen,
	secondary = false,
}: {
	tabs: SectionDef[];
	active: SectionDef;
	label: string;
	onOpen: (tab: SectionDef) => void;
	secondary?: boolean;
}) {
	const kind = secondary ? "settings-subtab" : "settings-tab";
	return (
		<div className={`${kind}s`} role="tablist" aria-label={label}>
			{tabs.map((tab, index) => (
				<button
					type="button"
					role="tab"
					key={tab.id}
					aria-selected={tab === active}
					id={tabElementId(tab, secondary)}
					aria-controls="settings-page-body"
					tabIndex={tab === active ? 0 : -1}
					onKeyDown={(event) => {
						const next = tabs[TAB_KEYS[event.key]?.(index, tabs.length) ?? -1];
						if (!next) return;
						event.preventDefault();
						onOpen(next);
						document.getElementById(tabElementId(next, secondary))?.focus();
					}}
					className={`${kind}${tab === active ? " active" : ""}`}
					onClick={() => onOpen(tab)}
				>
					<tab.icon size={secondary ? 13 : 14} />
					{tab.label}
					<NavBadge item={tab} />
				</button>
			))}
		</div>
	);
}

/**
 * A dot on a navigation entry or tab whose pages need attention: pi has no usable model (on
 * “Agent 配置”, its pi tab and the models tab), or an update is available.
 */
function NavBadge({ item }: { item: SectionDef }): ReactNode {
	const noModels = useAppState((s) => s.providers?.availableCount === 0);
	const update = useAppState((s) => computerUpdateStatus(s.settingsNode, s));
	if (noModels && pagesOf(item).some((page) => page.id === "models")) {
		return <span className="nav-dot warn" title="pi 还没有可用模型" />;
	}
	if (item.id === "about" && update && updatePending(update)) {
		return <span className="nav-dot accent" title="有可用更新" />;
	}
	return null;
}

export function SettingsPage({ section, footer }: { section: SettingsSection; footer?: ReactNode }) {
	const store = useStore();
	const hasPeers = useHasPeers();
	const [query, setQuery] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const { online } = useHostStatus();
	const target = useSettingsTarget();
	const sync = useAppState((s) => s.settingsSync);
	// Re-render when the managed computer's info (protocol version) changes.
	useAppState((s) => s.nodes[s.settingsNode]?.hostInfo);

	// biome-ignore lint/correctness/useExhaustiveDependencies: each page and managed host starts at the top
	useEffect(() => {
		scrollRef.current?.scrollTo(0, 0);
	}, [section, target.node]);

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
		items: group.items.filter((item) => itemMatches(item, q)),
	})).filter((group) => group.items.length);
	const current = SECTIONS.find((item) => item.id === section) ?? GENERAL;
	const nav = navItemOf(current.id) ?? GENERAL;
	const tab = tabOf(nav, current.id);
	const subtab = tabOf(tab, current.id);
	// The page last shown under each entry with tabs, so coming back to it returns there.
	const lastTab = useRef<Partial<Record<SettingsSection, SettingsSection>>>({});
	if (nav.tabs) lastTab.current[nav.id] = current.id;
	// Likewise under each tab with secondary tabs (pi's settings, models or extensions).
	const lastSubtab = useRef<Partial<Record<SettingsSection, SettingsSection>>>({});
	if (tab?.tabs) lastSubtab.current[tab.id] = current.id;
	const openNav = (item: SectionDef) => {
		if (!item.tabs) {
			store.openSettings(item.id);
			return;
		}
		const matching = q ? matchingPage(item, q) : undefined;
		if (!matching && item.id === nav.id) return;
		store.openSettings(matching?.id ?? lastTab.current[item.id] ?? item.id);
	};
	const openTab = (item: SectionDef) =>
		store.openSettings(item.tabs ? (lastSubtab.current[item.id] ?? item.id) : item.id);
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
	} else if (remoteTarget && !pageDescribesHost(current.id) && (!target.online || blocker)) {
		body = <RemoteUnavailable blocker={target.online ? blocker : undefined} />;
	} else {
		// Switching computers or syncing again remounts the page, which reads everything afresh.
		body = <Page key={followsHost ? `${target.node}:${sync}:${current.id}` : current.id} />;
	}

	return (
		<div className="app settings-screen">
			<aside className="sidebar settings-nav">
				<div className="settings-nav-heading">
					<span className="settings-nav-eyebrow">PIER / PREFERENCES</span>
					<h1 className="settings-nav-title">设置</h1>
				</div>
				<div className="settings-search">
					<IconSearch size={14} />
					<input
						aria-label="搜索设置"
						placeholder="搜索设置…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query) {
								event.stopPropagation();
								setQuery("");
							}
						}}
					/>
					{query ? (
						<button type="button" className="ghost icon" title="清除" onClick={() => setQuery("")}>
							<IconX size={13} />
						</button>
					) : null}
				</div>
				<nav className="settings-nav-list" aria-label="设置分类">
					{groups.map((group) => (
						<div key={group.title} className="settings-nav-group">
							<div className="settings-nav-group-title">{group.title}</div>
							{group.items.map((item) => (
								<button
									type="button"
									key={item.id}
									className={`settings-nav-item${item.id === nav.id ? " selected" : ""}`}
									aria-current={item.id === nav.id ? "page" : undefined}
									onClick={() => openNav(item)}
								>
									<item.icon size={15} />
									<span className="settings-nav-label">{item.label}</span>
									<NavBadge item={item} />
								</button>
							))}
						</div>
					))}
					{!groups.length ? (
						<div className="settings-nav-empty" role="status">
							没有匹配的设置，试试“模型”或“主题”。
						</div>
					) : null}
				</nav>
			</aside>
			<main className="main settings-main">
				<div className="settings-topbar">
					<div className="settings-breadcrumb">
						<IconSettings size={15} />
						<span>设置</span>
						<span aria-hidden="true">/</span>
						<strong>{nav.label}</strong>
					</div>
					<div className="settings-topbar-actions">
						{!hasPeers ? (
							<span className="settings-scope" title={target.name}>
								<IconMonitor size={13} />
								<span>{`${target.local ? "本机" : "远程"} · ${target.name}`}</span>
							</span>
						) : null}
						<HostSwitcher />
					</div>
				</div>
				<HostBanner onShowLogs={() => store.openSettings("logs", LOCAL_NODE)} />
				<div className="settings-scroll" ref={scrollRef}>
					<div className="settings-content">
						<header className="settings-page-heading">
							<div className="settings-page-icon">
								<nav.icon size={24} />
							</div>
							<div>
								<h1 className="settings-title" id="settings-page-title">
									{nav.label}
								</h1>
								<p className="settings-subtitle">{PAGE_DESCRIPTIONS[current.id]}</p>
							</div>
						</header>
						{nav.tabs && tab ? <SettingsTabs tabs={nav.tabs} active={tab} label={nav.label} onOpen={openTab} /> : null}
						{tab?.tabs && subtab ? (
							<SettingsTabs
								tabs={tab.tabs}
								active={subtab}
								label={`${tab.label} ${nav.label}`}
								onOpen={openTab}
								secondary
							/>
						) : null}
						{remoteTarget && !pageDescribesHost(current.id) ? (
							<RemoteTargetBanner readOnly={pageIsReadOnly(current.id)} />
						) : null}
						{tab ? (
							<div
								id="settings-page-body"
								className="settings-page-body"
								role="tabpanel"
								aria-labelledby={subtab ? `${tabElementId(tab)} ${tabElementId(subtab, true)}` : tabElementId(tab)}
							>
								{body}
							</div>
						) : (
							<section id="settings-page-body" className="settings-page-body" aria-labelledby="settings-page-title">
								{body}
							</section>
						)}
					</div>
				</div>
			</main>
			{footer}
		</div>
	);
}
