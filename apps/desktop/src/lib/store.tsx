import { ChatController, type ChatView } from "@pier/chat-state";
import { CLOSE_DEVICE_REVOKED, type ClientState, PierClient } from "@pier/client";
import type {
	AgentConfigChangeResult,
	AgentConfigResult,
	AgentConfigRuntime,
	AgentConfigScope,
	AgentRuntimeId,
	AgentRuntimeInfo,
	ApprovalPolicy,
	AppUpdateStatus,
	AuthMethod,
	AuthNotice,
	AuthPromptInfo,
	CustomModel,
	CustomProvider,
	CustomProviderApi,
	DefaultModelRef,
	DeviceInfo,
	EventFrame,
	ExtensionCatalogResult,
	ExtensionCatalogSort,
	ExtensionCatalogType,
	ExtensionListResult,
	ExtensionPackageInfo,
	ExtensionReloadSummary,
	ExtensionResourceInfo,
	ExtensionResourceType,
	ExtensionScope,
	ExtensionUpdateInfo,
	HostDirectoryListing,
	HostInfo,
	HostStats,
	MethodName,
	MethodParams,
	MethodResult,
	ModelInfo,
	PackageManagerInfo,
	PairingRequest,
	PairingResolution,
	PeerInfo,
	PiSettingsChangeResult,
	PiSettingsResult,
	ProviderInfo,
	ProviderListResult,
	RemoteAccessStatus,
	ScheduledTask,
	ScheduledTaskRun,
	SessionCleanupResult,
	SessionRunState,
	SessionSummary,
	ThinkingLevel,
	WorkspaceFileContent,
	WorkspaceFilesResult,
	WorkspaceFileWriteResult,
	WorkspaceInfo,
	WorkspacePathDeleteResult,
} from "@pier/protocol";
import { PierProtocolError, parseProtocolVersion } from "@pier/protocol";
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { Bridge, HostStatus, LocalFileSink, UpdateStatus } from "./bridge.ts";
import { fileToken } from "./composer-text.ts";
import { newSessionDefaultsFromSettings } from "./new-session-defaults.ts";
import { remotePageBlocker } from "./settings-target.ts";
import { isYunlianProvider, movedToLine, YUNLIAN_SITE, yunlianGroupOf, yunlianProvider } from "./yunlian.ts";

export const APP_VERSION = "0.2.34";

/** Node id of this computer; any other node is a paired computer's host id. */
export const LOCAL_NODE = "local";

/** One computer (node) whose workspaces and sessions the sidebar lists. */
export interface NodeState {
	/** Connection to that computer's Pier Host (through this computer's host for paired ones). */
	connection: ClientState | "none";
	hostInfo?: HostInfo;
	connectError?: string;
	/** The computer no longer accepts this one (removed there); pairing again is needed. */
	revoked?: boolean;
	/** Its workspaces; the last known list while a paired computer is offline. */
	workspaces: WorkspaceInfo[];
	/** `workspaces` came from the host in this run (not only from the offline cache). */
	workspacesLoaded: boolean;
}

const EMPTY_NODE: NodeState = { connection: "none", workspaces: [], workspacesLoaded: false };

/** A computer as shown in workspace pickers. */
export interface ComputerInfo {
	id: string;
	name: string;
	local: boolean;
	online: boolean;
	/** Workspaces can be added, removed and configured there from this computer. */
	canManage: boolean;
	state: NodeState;
}

/**
 * Whether a host lets paired devices manage it (workspaces, policies, file edits): hosts
 * speaking protocol 1.10 or later trust paired devices fully.
 */
export function hostAllowsRemoteManagement(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 10);
}

/** Whether a host speaks protocol `1.<minor>` or a later version. */
function hostSpeaks(info: HostInfo | undefined, minor: number): boolean {
	const version = info ? parseProtocolVersion(info.protocolVersion) : undefined;
	return version !== undefined && (version.major > 1 || (version.major === 1 && version.minor >= minor));
}

/** Whether the shown host can delete workspace files and directories (`workspace.deletePath`, 1.11). */
export function hostCanDeleteFiles(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 11);
}

/** Whether a host can upload and download workspace files in chunks (`workspace.readBytes` / `upload*`, 1.21). */
export function hostTransfersFiles(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 21);
}

/** Whether a host offers Git source control for workspaces (`git.*`, 1.28). */
export function hostSupportsGit(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 28);
}

export function hostSupportsScheduledTasks(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 36);
}

/** Whether a host supports one-time preview authorization locally (1.33) or remotely (1.35). */
export function hostAuthorizesFilePreviews(info: HostInfo | undefined, remote = false): boolean {
	return hostSpeaks(info, remote ? 35 : 33);
}

/** Whether a host runs agents other than pi (`runtime.list`, `session.create` with `runtime`, 1.22). */
export function hostRunsAgents(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 22);
}

/** Whether a host reports its resource usage (`host.stats`, 1.12). */
export function hostReportsStats(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 12);
}

/** Whether Pier on a computer can be updated from here (`update.*`, 1.13). */
export function hostUpdatesRemotely(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 13);
}

/** Whether a computer can run terminals for this one (`terminal.*`, 1.18, inside its desktop app). */
export function hostRunsTerminals(info: HostInfo | undefined): boolean {
	return info?.terminals === true && hostSpeaks(info, 18);
}

/** Pier's updater on a paired computer, driven through its host. */
export interface PeerUpdateEntry {
	/** The updater's last known status there. */
	status?: AppUpdateStatus;
	/** That computer's Pier is too old to be updated from here. */
	tooOld?: boolean;
	/** A request from this computer is in flight. */
	busy?: "check" | "install";
	/** An install this computer started, announced once the computer is back. */
	installing?: { from: string; to?: string };
}

/** Whether a host can archive and bulk-clean sessions (`session.archive` / `session.cleanup`, 1.14). */
export function hostCanArchiveSessions(info: HostInfo | undefined): boolean {
	return hostSpeaks(info, 14);
}

/** Parameters of `session.cleanup` the desktop chooses. */
export interface SessionCleanupRequest {
	action: "archive" | "delete";
	modifiedBefore?: string;
	scope?: "all" | "archived" | "unarchived";
}

/** How often the status bar samples host usage while the window is visible. */
const HOST_STATS_INTERVAL_MS = 2000;

/** Resource usage of one computer, for the status bar's host status. */
export interface HostStatsEntry {
	/**
	 * `loading` until the first sample; `offline` while the computer cannot be reached;
	 * `unsupported` when its Pier is too old to report usage.
	 */
	state: "loading" | "ok" | "offline" | "unsupported" | "error";
	stats?: HostStats;
	error?: string;
}

/** Subscriptions kept alive for recently viewed sessions (so approvals elsewhere stay visible). */
const MAX_LIVE_CHATS = 8;

export interface Toast {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
}

export interface Draft {
	text: string;
	images: Array<{ data: string; mimeType: string; name: string }>;
}

/** A model / thinking level picked for new chats (see `AppState.newChatModel`). */
export interface NewChatModelChoice {
	model?: ModelInfo | undefined;
	thinkingLevel?: ThinkingLevel | undefined;
}

/** An interactive provider sign-in shown in the login dialog. */
export interface AuthFlowState {
	/** Undefined until `provider.login` answered. */
	flowId?: string;
	providerId: string;
	providerName: string;
	method: AuthMethod;
	notices: AuthNotice[];
	prompt?: AuthPromptInfo;
	/** Set when the sign-in failed. */
	error?: string;
}

/** The 云链API browser sign-in shown in its dialog. */
export interface YunlianLoginState {
	/** The authorization page opened in the browser (undefined while starting). */
	authorizeUrl?: string;
	/** Approved in the browser; saving the provider. */
	saving?: boolean;
	/** Set when the sign-in failed. */
	error?: string;
}

/** Pages of the settings screen. */
export type SettingsSection =
	| "account"
	| "general"
	| "models"
	| "workspaces"
	| "extensions"
	| "pi"
	| "claude"
	| "codex"
	| "remote"
	| "logs"
	| "about";

/** Progress of the running extension install / remove / update, as reported by the host. */
export interface ExtensionProgressState {
	action: string;
	phase: "start" | "progress" | "complete" | "error";
	source: string;
	message?: string;
}

export interface AppState {
	scheduledTasksOpen: boolean;
	taskData: Record<string, { tasks: ScheduledTask[]; runs: ScheduledTaskRun[]; error?: string }>;
	host: HostStatus;
	/**
	 * Every computer whose workspaces the sidebar lists: this one (`LOCAL_NODE`) and each paired
	 * computer, all connected at the same time. Workspaces and sessions are not tied to a shown
	 * computer: each one is driven through its own computer's connection.
	 */
	nodes: Record<string, NodeState>;
	/**
	 * The computer of the workspace on screen (derived from the selection). `connection`,
	 * `hostInfo`, `connectError` and `nodeRevoked` mirror it; the settings screen (models,
	 * extensions, pairing, remote access) always manages this computer.
	 */
	node: string;
	/** Connection to the computer of the workspace on screen (mirrors `nodes[node]`). */
	connection: ClientState | "none";
	hostInfo?: HostInfo;
	connectError?: string;
	nodeRevoked?: boolean;
	/** Connection to this computer's own Pier Host (mirrors `nodes[LOCAL_NODE]`). */
	localConnection: ClientState | "none";
	localHostInfo?: HostInfo;
	/** This computer's workspaces (mirrors `nodes[LOCAL_NODE]`). */
	localWorkspaces: WorkspaceInfo[];
	/** Other computers this one paired with. */
	peers: PeerInfo[];
	/** The "add a computer" (pair with a link) dialog is open. */
	addPeerOpen: boolean;
	/** Workspaces of every computer: this one's first, then each paired computer's. */
	workspaces: WorkspaceInfo[];
	/** The computer each workspace in `workspaces` belongs to. */
	workspaceNodes: Record<string, string>;
	/** This computer's workspaces were loaded (the main area can decide what to show). */
	workspacesLoaded: boolean;
	sessions: Record<string, SessionSummary[] | undefined>;
	expanded: Record<string, boolean>;
	selectedWorkspaceId?: string;
	selectedSessionId?: string;
	/**
	 * The blank "new chat" screen is open. No session exists yet: sending the first message
	 * creates one in `workspaceId` and switches to it.
	 */
	newChat?: { workspaceId?: string };
	/**
	 * The model and thinking level picked on the new-chat screen, per computer (`LOCAL_NODE` or a
	 * paired computer's id). Unset fields use what the host would pick for a new session. Kept
	 * for later new chats until the app restarts.
	 */
	newChatModel: Record<string, NewChatModelChoice | undefined>;
	/** The agent runtime picked on the new-chat screen, per computer (unset: pi). */
	newChatRuntime: Record<string, AgentRuntimeId | undefined>;
	toasts: Toast[];
	/** Bumped whenever a live chat changes, so the sidebar can show running / approval badges. */
	chatsVersion: number;
	remote?: RemoteAccessStatus;
	devices: DeviceInfo[];
	/** Devices waiting for the user to allow pairing. */
	pairingRequests: PairingRequest[];
	/** The pairing code currently shown, if any. */
	pairing?: { uri: string; expiresAt: string; addresses: string[]; relays?: string[] };
	/**
	 * The computer the settings screen manages (`LOCAL_NODE` or a paired computer's id): the
	 * models, account, extensions and pi settings pages read and write that computer's Pier.
	 */
	settingsNode: string;
	/** Bumped when the settings are synced again: the pages of `settingsNode` reload everything. */
	settingsSync: number;
	/** A sync of `settingsNode`'s settings is in flight. */
	settingsSyncing: boolean;
	/** When `settingsNode`'s settings were last read (ms since the epoch). */
	settingsSyncedAt?: number | undefined;
	/** Model providers and credentials of `settingsNode` (undefined until loaded). */
	providers?: ProviderListResult | undefined;
	/** This computer's model providers (the "no models" hints of the main window). */
	localProviders?: ProviderListResult | undefined;
	auth?: AuthFlowState;
	yunlian?: YunlianLoginState;
	update: UpdateStatus;
	/** The settings screen is open on this page (undefined while closed). */
	settings?: SettingsSection;
	/** The left-hand sidebar (workspaces and sessions) is shown. */
	sidebar: boolean;
	/** Width of the left-hand sidebar in pixels. */
	sidebarWidth: number;
	/** The right-hand workspace file panel is shown. */
	filesPanel: boolean;
	/** Width of the file panel in pixels. */
	filesPanelWidth: number;
	/** What the right-hand panel shows: workspace files or Git source control. */
	rightPanelTab: RightPanelTab;
	/** Bumped per workspace when its files may have changed (an agent run finished). */
	filesVersion: Record<string, number>;
	/**
	 * The workspace file shown in the preview dialog. `composerKey` is the composer that the
	 * dialog's "insert" button targets, when there is one.
	 */
	filePreview?: { workspaceId: string; path: string; composerKey?: string; fromMarkdown?: boolean } | undefined;
	/** Bumped when pi extension or package settings changed, so the extensions page reloads. */
	extensionsVersion: number;
	/** Bumped when a pi settings file may have changed, so the pi settings page reloads. */
	piSettingsVersion: number;
	/** Bumped when a Claude Code or Codex configuration file changed, so their pages reload. */
	agentConfigVersion: number;
	extensionProgress?: ExtensionProgressState | undefined;
	/** The directory picker for a paired computer is open. */
	directoryPicker?: { title: string; node: string } | undefined;
	/** Resource usage per computer (`LOCAL_NODE` or a paired computer's id), while sampled. */
	hostStats: Record<string, HostStatsEntry>;
	/** Pier's updater on each paired computer. */
	peerUpdates: Record<string, PeerUpdateEntry>;
}

/** Recompute the lists that combine every computer (after `nodes` or `peers` changed). */
function deriveWorkspaces(state: AppState): Partial<AppState> {
	const workspaces: WorkspaceInfo[] = [];
	const workspaceNodes: Record<string, string> = {};
	for (const node of [LOCAL_NODE, ...state.peers.map((p) => p.id)]) {
		for (const workspace of state.nodes[node]?.workspaces ?? []) {
			if (workspace.id in workspaceNodes) continue;
			workspaceNodes[workspace.id] = node;
			workspaces.push(workspace);
		}
	}
	const local = state.nodes[LOCAL_NODE] ?? EMPTY_NODE;
	return {
		workspaces,
		workspaceNodes,
		workspacesLoaded: local.workspacesLoaded,
		localWorkspaces: local.workspaces,
		localConnection: local.connection,
		localHostInfo: local.hostInfo,
	};
}

/** Mirror the computer of the workspace on screen into the top-level connection fields. */
function deriveShown(state: AppState): Partial<AppState> {
	const shown = state.nodes[state.node] ?? EMPTY_NODE;
	return {
		connection: shown.connection,
		hostInfo: shown.hostInfo,
		connectError: shown.connectError,
		nodeRevoked: shown.revoked,
	};
}

const PAIRING_RESULT_TEXT: Record<PairingResolution, string> = {
	accepted: "已配对",
	rejected: "已拒绝配对",
	expired: "配对请求已超时",
	cancelled: "设备取消了配对",
};

const SELECTION_KEY = "pier.selection";
/** Draft key of the new-chat composer (session ids are UUIDs, so no clash). */
export const NEW_CHAT_DRAFT = "#new-chat";
const FILES_PANEL_KEY = "pier.filesPanel";
/** The views of the right-hand panel. */
export type RightPanelTab = "files" | "git";
const SIDEBAR_KEY = "pier.sidebar";
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 228;
export const FILES_PANEL_MIN_WIDTH = 220;
export const FILES_PANEL_MAX_WIDTH = 560;
export const FILES_PANEL_DEFAULT_WIDTH = 280;

function clampSidebarWidth(width: number): number {
	if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function clampPanelWidth(width: number): number {
	if (!Number.isFinite(width)) return FILES_PANEL_DEFAULT_WIDTH;
	return Math.round(Math.min(FILES_PANEL_MAX_WIDTH, Math.max(FILES_PANEL_MIN_WIDTH, width)));
}
/** Refresh-timer keys for the device and provider lists (workspace ids are UUIDs, so no clash). */
const DEVICES_KEY = "#devices";
/** Followed by the computer's node id. */
const PROVIDERS_KEY = "#providers:";
const PEERS_KEY = "#peers";
/** Last known workspaces of paired computers, listed while they are offline. */
const NODE_WORKSPACES_KEY = "pier.nodeWorkspaces";

/** Selection remembered per computer (before workspaces of all computers were listed together). */
interface NodeSelection {
	workspaceId?: string;
	sessionId?: string;
}

/** `localStorage[SELECTION_KEY]`: the selection, and the computer of its workspace. */
interface SavedSelection extends NodeSelection {
	expanded?: Record<string, boolean>;
	node?: string;
	/** Written by 0.2.7: the selection of each computer shown then. */
	nodes?: Record<string, NodeSelection>;
}

/** User-facing text for a failed `peer.pair`. */
export function peerPairingErrorText(error: unknown): string {
	const reason =
		error instanceof PierProtocolError ? (error.data as { reason?: string } | undefined)?.reason : undefined;
	const message = errorText(error);
	switch (reason) {
		case "INVALID_LINK":
			return `配对链接无效：${message.replace(/^Invalid pairing link: /, "")}`;
		case "SELF":
			return "这是本机自己的配对链接。请在另一台电脑的「设置 → 设备与远程」中生成配对链接。";
		case "UNREACHABLE":
			return `无法连接到那台电脑（${message}）。请确认两台电脑在同一局域网或 Tailscale 网络中，且那台电脑已开启局域网访问。`;
		case "PAIRING_INVALID":
			return "配对码无效或已过期，请在那台电脑上重新生成配对链接。";
		case "PAIRING_REJECTED":
			return "那台电脑上拒绝了这次配对。";
		case "PAIRING_TIMEOUT":
			return "那台电脑上没有及时确认，请重试。";
		case "BAD_HANDSHAKE":
			return `安全握手失败：${message}`;
		default:
			return message;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class PierStore {
	private state: AppState;
	private readonly listeners = new Set<() => void>();
	/** One client per computer: this one's Pier Host, and each paired computer through it. */
	private readonly clients = new Map<string, PierClient>();
	private directoryPickerResolve: ((path: string | null) => void) | undefined;
	private clientKey: string | undefined;
	private localUrl: string | undefined;
	private localToken: string | undefined;
	/** Pending reconnects to offline paired computers, and their attempt counts. */
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly retryAttempts = new Map<string, number>();
	private readonly chats = new Map<string, ChatController>();
	/** The computer each live chat runs on. */
	private readonly chatNodes = new WeakMap<ChatController, string>();
	private recent: string[] = [];
	private readonly drafts = new Map<string, Draft>();
	/** Sessions created from the new-chat screen whose draft is sent as soon as they load. */
	private readonly autoSend = new Set<string>();
	private nextToastId = 1;
	private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly taskLoadSeq = new Map<string, number>();
	/** Sign-in events that arrived before `provider.login` answered with their flow id. */
	private authBacklog: EventFrame[] = [];
	private openedAuthUrls = new Set<string>();
	private authSeq = 0;
	/** The computer whose host runs the sign-in in `state.auth`. */
	private authNode = LOCAL_NODE;
	private yunlianSeq = 0;
	/** The pending 云链API authorization on the host, if any. */
	private yunlianFlow: string | undefined;
	/** The update version already announced with a toast. */
	private announcedUpdate: string | undefined;
	private updateRequest = 0;
	/** Mounted composers, by session, that accept text inserted from elsewhere (the file panel). */
	private readonly composerInserts = new Map<string, (path: string, directory: boolean) => void>();
	/** Mounted views sampling the shown computer (`summary`) or every computer (`detail`). */
	private readonly statsWatchers = { summary: 0, detail: 0 };
	private statsTimer: ReturnType<typeof setInterval> | undefined;
	/** Computers with a `host.stats` request in flight. */
	private readonly statsBusy = new Set<string>();

	constructor(private readonly bridge: Bridge) {
		const saved = (() => {
			try {
				return JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}") as SavedSelection;
			} catch {
				return {};
			}
		})();
		const node = typeof saved.node === "string" && saved.node ? saved.node : LOCAL_NODE;
		// 0.2.7 kept a selection per shown computer, with this computer's at the top level.
		const selection: NodeSelection = node !== LOCAL_NODE && saved.nodes?.[node] ? saved.nodes[node] : saved;
		const cached = (() => {
			try {
				return JSON.parse(localStorage.getItem(NODE_WORKSPACES_KEY) ?? "{}") as Record<string, WorkspaceInfo[]>;
			} catch {
				return {};
			}
		})();
		const nodes: Record<string, NodeState> = { [LOCAL_NODE]: EMPTY_NODE };
		for (const [id, workspaces] of Object.entries(cached)) {
			if (id !== LOCAL_NODE && Array.isArray(workspaces)) nodes[id] = { ...EMPTY_NODE, workspaces };
		}
		const panel = (() => {
			try {
				return JSON.parse(localStorage.getItem(FILES_PANEL_KEY) ?? "{}") as {
					open?: boolean;
					width?: number;
					tab?: string;
				};
			} catch {
				return {};
			}
		})();
		const sidebar = (() => {
			try {
				return JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? "{}") as { open?: boolean; width?: number };
			} catch {
				return {};
			}
		})();
		const state: AppState = {
			scheduledTasksOpen: false,
			taskData: {},
			host: { state: "starting", restarts: 0, generation: 0 },
			nodes,
			node,
			connection: "none",
			localConnection: "none",
			localWorkspaces: [],
			peers: [],
			addPeerOpen: false,
			workspaces: [],
			workspaceNodes: {},
			workspacesLoaded: false,
			sessions: {},
			expanded: saved.expanded ?? {},
			...(selection.workspaceId ? { selectedWorkspaceId: selection.workspaceId } : {}),
			...(selection.sessionId ? { selectedSessionId: selection.sessionId } : {}),
			toasts: [],
			chatsVersion: 0,
			devices: [],
			pairingRequests: [],
			settingsNode: LOCAL_NODE,
			settingsSync: 0,
			settingsSyncing: false,
			update: { state: "idle", currentVersion: APP_VERSION, autoCheck: true, downloaded: 0 },
			sidebar: sidebar.open !== false,
			sidebarWidth: clampSidebarWidth(sidebar.width ?? SIDEBAR_DEFAULT_WIDTH),
			filesPanel: panel.open === true,
			filesPanelWidth: clampPanelWidth(panel.width ?? FILES_PANEL_DEFAULT_WIDTH),
			rightPanelTab: panel.tab === "git" ? "git" : "files",
			filesVersion: {},
			extensionsVersion: 0,
			piSettingsVersion: 0,
			agentConfigVersion: 0,
			hostStats: {},
			peerUpdates: {},
			newChatModel: {},
			newChatRuntime: {},
		};
		this.state = { ...state, ...deriveWorkspaces(state), ...deriveShown(state) };
	}

	// ---- external store plumbing -------------------------------------------------------

	getState = (): AppState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private set(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
		const next = typeof patch === "function" ? patch(this.state) : patch;
		const previousNode = this.state.node;
		let state: AppState = { ...this.state, ...next };
		if ("nodes" in next || "peers" in next) state = { ...state, ...deriveWorkspaces(state) };
		// The computer on screen follows the workspace on screen.
		const screen = state.newChat ? state.newChat.workspaceId : state.selectedWorkspaceId;
		const owner = screen ? state.workspaceNodes[screen] : undefined;
		if (owner) state.node = owner;
		const nodeChanged = state.node !== previousNode;
		if (nodeChanged || "nodes" in next) state = { ...state, ...deriveShown(state) };
		this.state = state;
		if (
			nodeChanged ||
			"selectedWorkspaceId" in next ||
			"selectedSessionId" in next ||
			"expanded" in next ||
			"newChat" in next
		) {
			localStorage.setItem(
				SELECTION_KEY,
				JSON.stringify({
					...(state.selectedWorkspaceId ? { workspaceId: state.selectedWorkspaceId } : {}),
					...(state.selectedSessionId ? { sessionId: state.selectedSessionId } : {}),
					expanded: state.expanded,
					node: state.node,
				} satisfies SavedSelection),
			);
		}
		if ("sidebar" in next || "sidebarWidth" in next) {
			localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ open: this.state.sidebar, width: this.state.sidebarWidth }));
		}
		if ("filesPanel" in next || "filesPanelWidth" in next || "rightPanelTab" in next) {
			localStorage.setItem(
				FILES_PANEL_KEY,
				JSON.stringify({
					open: this.state.filesPanel,
					width: this.state.filesPanelWidth,
					tab: this.state.rightPanelTab,
				}),
			);
		}
		if (nodeChanged) {
			// Opening a workspace of an offline computer tries to reach it right away.
			const node = this.state.node;
			if (node !== LOCAL_NODE && this.state.nodes[node]?.connection !== "open") {
				queueMicrotask(() => this.retryNode(node));
			}
		}
		for (const listener of [...this.listeners]) listener();
	}

	/** Update one computer's state. */
	private patchNode(node: string, patch: Partial<NodeState>): void {
		this.set((s) => ({ nodes: { ...s.nodes, [node]: { ...(s.nodes[node] ?? EMPTY_NODE), ...patch } } }));
	}

	get bridgeKind(): Bridge["kind"] {
		return this.bridge.kind;
	}

	start(): () => void {
		const off = this.bridge.onStatus((status) => this.onHostStatus(status));
		void this.bridge.status().then((status) => this.onHostStatus(status));
		const offUpdate = this.bridge.updates.onStatus((status) => this.onUpdateStatus(status));
		const offOpen = this.bridge.updates.onOpen(() => this.openSettings("about"));
		void this.bridge.updates.status().then((status) => this.onUpdateStatus(status));
		return () => {
			off();
			offUpdate();
			offOpen();
			if (this.statsTimer) clearInterval(this.statsTimer);
			this.statsTimer = undefined;
			this.teardownAll();
		};
	}

	// ---- host / connections ------------------------------------------------------------

	/** The client of the computer of the workspace on screen. */
	get client(): PierClient | undefined {
		return this.clients.get(this.state.node);
	}

	/** This computer's Pier Host (pairing, remote access, and the proxy to other computers). */
	private get localClient(): PierClient | undefined {
		return this.clients.get(LOCAL_NODE);
	}

	/**
	 * The open connection to the computer the settings screen manages (models, account,
	 * extensions, pi settings), or undefined while it cannot be reached.
	 */
	private get settingsClient(): PierClient | undefined {
		return this.openClient(this.state.settingsNode);
	}

	/** A computer's client, when this computer's host or the paired computer is connected. */
	private openClient(node: string): PierClient | undefined {
		const client = this.clients.get(node);
		if (!client) return undefined;
		return node === LOCAL_NODE || this.state.nodes[node]?.connection === "open" ? client : undefined;
	}

	/** The error for a call to the settings computer while it cannot be reached. */
	private settingsOffline(): Error {
		const node = this.state.settingsNode;
		return new Error(
			node === LOCAL_NODE ? "尚未连接到本机的 Pier Host" : `尚未连接到 ${this.nodeName(node)} 上的 Pier Host`,
		);
	}

	/** Whether the workspace on screen is on this computer (not a paired one). */
	get isLocalNode(): boolean {
		return this.state.node === LOCAL_NODE;
	}

	/** The computer a workspace belongs to (the one on screen when unknown). */
	nodeOf(workspaceId: string | undefined): string {
		return (workspaceId && this.state.workspaceNodes[workspaceId]) || this.state.node;
	}

	/** The client of the computer a workspace belongs to. */
	private clientFor(workspaceId: string): PierClient | undefined {
		return this.clients.get(this.nodeOf(workspaceId));
	}

	/** The client of a computer (`LOCAL_NODE` or a paired computer's id), e.g. for its terminals. */
	nodeClient(node: string): PierClient | undefined {
		return this.clients.get(node);
	}

	/** Display name of a computer (the one on screen by default). */
	nodeName(node = this.state.node): string {
		if (node === LOCAL_NODE) return this.state.localHostInfo?.hostName ?? "本机";
		const peer = this.state.peers.find((p) => p.id === node);
		if (peer) return peer.name;
		return this.state.nodes[node]?.hostInfo?.hostName ?? "另一台电脑";
	}

	/** Whether this computer may manage a computer's workspaces, policies and files. */
	canManage(node: string): boolean {
		return node === LOCAL_NODE || hostAllowsRemoteManagement(this.state.nodes[node]?.hostInfo);
	}

	/** This computer and every paired computer, for workspace pickers. */
	computers(): ComputerInfo[] {
		const { nodes, peers } = this.state;
		return [LOCAL_NODE, ...peers.map((p) => p.id)].map((id) => {
			const state = nodes[id] ?? EMPTY_NODE;
			return {
				id,
				name: this.nodeName(id),
				local: id === LOCAL_NODE,
				online: state.connection === "open" && this.state.host.state === "ready",
				canManage: this.canManage(id),
				state,
			};
		});
	}

	private onHostStatus(status: HostStatus): void {
		this.set({ host: status });
		const key = status.state === "ready" && status.url ? `${status.generation}|${status.url}` : undefined;
		if (key === this.clientKey) return;
		// Keep the lists on screen while the host restarts; they reload once it is back.
		this.teardownAll();
		if (key && status.url) {
			this.localUrl = status.url;
			this.localToken = status.token ?? undefined;
			this.clientKey = key;
			void this.connectLocal(status.url, status.token ?? undefined);
		}
	}

	/** Close every connection (the host stopped or restarted), keeping the lists on screen. */
	private teardownAll(): void {
		for (const node of [...this.clients.keys(), ...this.retryTimers.keys()]) this.closeNode(node);
		this.clientKey = undefined;
		this.localUrl = undefined;
		this.localToken = undefined;
		this.set({
			pairingRequests: [],
			pairing: undefined,
			auth: undefined,
			yunlian: undefined,
			settingsSyncing: false,
		});
		this.yunlianSeq++;
		this.yunlianFlow = undefined;
	}

	/** Dispose the live chats running on a computer. */
	private dropNodeChats(node: string): void {
		let dropped = false;
		for (const [id, chat] of this.chats) {
			if (this.chatNodes.get(chat) !== node) continue;
			this.dropChat(id);
			dropped = true;
		}
		if (dropped) this.set((s) => ({ chatsVersion: s.chatsVersion + 1 }));
	}

	/** Drop a computer's connection and live chats; its workspace list stays (last known). */
	private closeNode(node: string): void {
		clearTimeout(this.retryTimers.get(node));
		this.retryTimers.delete(node);
		this.retryAttempts.delete(node);
		this.dropNodeChats(node);
		const client = this.clients.get(node);
		this.clients.delete(node);
		client?.close();
		if (this.state.directoryPicker?.node === node) this.resolveDirectoryPicker(null);
		// A sign-in belongs to the connection that started it.
		if (this.state.auth && this.authNode === node) {
			this.authSeq++;
			this.set({ auth: undefined });
		}
		if (this.state.nodes[node]) this.patchNode(node, { connection: "none" });
	}

	/** Forget a computer that is no longer paired: its connection, workspaces and selection. */
	private forgetNode(node: string): void {
		this.closeNode(node);
		const workspaceIds = new Set((this.state.nodes[node]?.workspaces ?? []).map((w) => w.id));
		this.set((s) => {
			const { [node]: _gone, ...nodes } = s.nodes;
			const selected = s.selectedWorkspaceId !== undefined && workspaceIds.has(s.selectedWorkspaceId);
			const target = s.newChat?.workspaceId !== undefined && workspaceIds.has(s.newChat.workspaceId);
			return {
				nodes,
				...(selected ? { selectedWorkspaceId: undefined, selectedSessionId: undefined } : {}),
				...(target ? { newChat: {} } : {}),
				...(s.node === node ? { node: LOCAL_NODE } : {}),
				...(s.settingsNode === node
					? {
							settingsNode: LOCAL_NODE,
							settingsSync: s.settingsSync + 1,
							providers: s.localProviders,
							settingsSyncedAt: undefined,
							extensionProgress: undefined,
						}
					: {}),
				peerUpdates: Object.fromEntries(Object.entries(s.peerUpdates).filter(([id]) => id !== node)),
				taskData: Object.fromEntries(Object.entries(s.taskData).filter(([id]) => id !== node)),
			};
		});
		this.saveNodeCache();
		this.fixSelection();
	}

	private async connectLocal(url: string, token: string | undefined): Promise<void> {
		const client = new PierClient({
			url,
			...(token ? { token } : {}),
			client: { name: "pier-desktop", version: APP_VERSION, platform: navigator.platform || "desktop" },
			requestTimeoutMs: 60_000,
		});
		this.clients.set(LOCAL_NODE, client);
		const current = () => this.localClient === client;
		let wasOpen = false;
		client.onState((state) => {
			if (!current()) return;
			// A reconnect re-runs `host.hello`: keep the host's info (version, name) current.
			this.patchNode(
				LOCAL_NODE,
				state === "open" && client.host ? { connection: state, hostInfo: client.host } : { connection: state },
			);
			if (state === "open") {
				if (wasOpen) {
					void this.reloadLocal();
					void this.loadWorkspaces(LOCAL_NODE);
				}
				wasOpen = true;
			}
		});
		client.onEvent((frame) => {
			if (current() && !frame.sessionId) this.onLocalEvent(frame);
		});
		try {
			const hello = await client.connect();
			if (!current()) return;
			this.patchNode(LOCAL_NODE, { hostInfo: hello.host, connectError: undefined });
			void this.reloadLocal();
			await this.loadWorkspaces(LOCAL_NODE);
		} catch (error) {
			if (current()) this.patchNode(LOCAL_NODE, { connectError: errorText(error) });
		}
	}

	/** Connect to every paired computer, and forget the ones no longer paired. */
	private syncPeers(): void {
		if (!this.localUrl || !this.localClient) return;
		const ids = new Set(this.state.peers.map((p) => p.id));
		for (const node of Object.keys(this.state.nodes)) {
			if (node !== LOCAL_NODE && !ids.has(node)) this.forgetNode(node);
		}
		for (const id of ids) {
			if (!this.clients.has(id) && !this.retryTimers.has(id) && !this.state.nodes[id]?.revoked) {
				void this.connectPeer(id);
			}
		}
	}

	/**
	 * Connect to a paired computer through this computer's host (`/peer/<id>` on the local
	 * gateway), which runs the encrypted channel. Retries while the computer is offline.
	 */
	private async connectPeer(node: string): Promise<void> {
		const url = this.localUrl;
		if (!url) return;
		// Chats on an earlier (failed) connection cannot recover: they reopen on the new one.
		this.dropNodeChats(node);
		this.clients.get(node)?.close();
		const client = new PierClient({
			url: `${url.replace(/\/+$/, "")}/peer/${encodeURIComponent(node)}`,
			...(this.localToken ? { token: this.localToken } : {}),
			client: { name: "pier-desktop", version: APP_VERSION, platform: navigator.platform || "desktop" },
			requestTimeoutMs: 60_000,
			heartbeatMs: 25_000,
			reconnect: { initialDelayMs: 500, maxDelayMs: 10_000 },
		});
		this.clients.set(node, client);
		const current = () => this.clients.get(node) === client;
		let wasOpen = false;
		this.patchNode(node, { connection: "connecting" });
		client.onState((state) => {
			if (!current()) return;
			// A reconnect re-runs `host.hello`: the computer may have been upgraded meanwhile, so
			// refresh its info (protocol version, name) instead of keeping the first answer.
			this.patchNode(
				node,
				state === "open"
					? { connection: state, connectError: undefined, ...(client.host ? { hostInfo: client.host } : {}) }
					: { connection: state },
			);
			if (state === "open") {
				this.retryAttempts.delete(node);
				if (wasOpen) {
					void this.loadWorkspaces(node);
					void this.loadPeerUpdate(node);
					if (node === this.state.settingsNode) void this.loadProviders(node);
				}
				wasOpen = true;
			}
		});
		client.onEvent((frame) => {
			if (current() && !frame.sessionId) this.onNodeEvent(node, frame);
		});
		client.onError(() => {
			if (current() && client.terminalClose?.code === CLOSE_DEVICE_REVOKED) this.markNodeRevoked(node);
		});
		try {
			const hello = await client.connect();
			if (!current()) return;
			this.patchNode(node, { hostInfo: hello.host, revoked: false, connectError: undefined });
			void this.loadPeerUpdate(node);
			if (node === this.state.settingsNode) void this.loadProviders(node);
			await this.loadWorkspaces(node);
		} catch (error) {
			if (!current()) return;
			if (client.terminalClose?.code === CLOSE_DEVICE_REVOKED) {
				this.markNodeRevoked(node);
				return;
			}
			if (error instanceof PierProtocolError && error.code === "NOT_FOUND") {
				// No longer paired on this computer: reloading the list forgets it.
				this.patchNode(node, { connection: "closed", connectError: errorText(error) });
				void this.loadPeers();
				return;
			}
			// The computer may be asleep or offline: keep trying, more often while it is on screen.
			this.patchNode(node, { connection: "reconnecting", connectError: errorText(error) });
			const attempt = this.retryAttempts.get(node) ?? 0;
			const cap = node === this.state.node ? 15_000 : 60_000;
			this.retryAttempts.set(node, attempt + 1);
			this.retryTimers.set(
				node,
				setTimeout(
					() => {
						this.retryTimers.delete(node);
						if (current()) void this.connectPeer(node);
					},
					Math.min(cap, 1000 * 2 ** attempt),
				),
			);
		}
	}

	private markNodeRevoked(node: string): void {
		clearTimeout(this.retryTimers.get(node));
		this.retryTimers.delete(node);
		this.clients.get(node)?.close();
		this.patchNode(node, {
			revoked: true,
			connection: "closed",
			connectError: `${this.nodeName(node)} 已移除这台电脑（或重置了 Pier），需要重新配对。`,
		});
	}

	/** Reconnect to a paired computer right away (the one on screen by default). */
	retryNode(node = this.state.node): void {
		if (node === LOCAL_NODE || !this.localClient || !this.state.peers.some((p) => p.id === node)) return;
		const state = this.state.nodes[node];
		if (state?.connection === "open" || state?.connection === "connecting") return;
		const client = this.clients.get(node);
		if (client && client.state === "reconnecting" && !this.retryTimers.has(node)) {
			client.reconnectNow();
			return;
		}
		clearTimeout(this.retryTimers.get(node));
		this.retryTimers.delete(node);
		this.retryAttempts.delete(node);
		void this.connectPeer(node);
	}

	/** Events of this computer's host. */
	private onLocalEvent(frame: EventFrame): void {
		const event = frame.event;
		this.onNodeEvent(LOCAL_NODE, frame);
		if (event.type === "remote.changed") {
			const remote = event.status as RemoteAccessStatus;
			this.set(remote.pairingActive ? { remote } : { remote, pairing: undefined });
		} else if (event.type === "device.changed") {
			this.scheduleRefresh(DEVICES_KEY);
		} else if (event.type === "peer.changed") {
			this.scheduleRefresh(PEERS_KEY);
		} else if (event.type === "pairing.request") {
			const request = event.request as PairingRequest;
			this.set((s) => ({
				pairingRequests: [...s.pairingRequests.filter((r) => r.id !== request.id), request],
				pairing: undefined,
			}));
		} else if (event.type === "pairing.resolved") {
			const requestId = String(event.requestId);
			const known = this.state.pairingRequests.find((r) => r.id === requestId);
			this.set((s) => ({ pairingRequests: s.pairingRequests.filter((r) => r.id !== requestId) }));
			const resolution = event.resolution as PairingResolution;
			if (known) {
				this.toast(
					resolution === "accepted" ? "info" : "warning",
					`${known.device.name}：${PAIRING_RESULT_TEXT[resolution] ?? resolution}`,
				);
			}
		}
	}

	/** Events of any computer's host that concern its workspaces and sessions. */
	private onNodeEvent(node: string, frame: EventFrame): void {
		const event = frame.event;
		if (event.type === "workspace.changed") this.scheduleRefresh(`#workspaces:${node}`);
		else if (event.type === "task.changed") this.scheduleRefresh(`#tasks:${node}`);
		else if (event.type === "session.listChanged") this.scheduleRefresh(String(event.workspaceId));
		else if (event.type === "session.activity") {
			const workspaceId = String(event.workspaceId);
			const sessionId = String(event.sessionId);
			const state = event.state as SessionRunState;
			const pendingUi = Number(event.pendingUi) || 0;
			if (this.state.sessions[workspaceId]?.some((session) => session.id === sessionId)) {
				this.set((s) => ({
					sessions: {
						...s.sessions,
						[workspaceId]: s.sessions[workspaceId]?.map((session) =>
							session.id === sessionId ? { ...session, state, pendingUi, active: true } : session,
						),
					},
				}));
			} else {
				this.scheduleRefresh(workspaceId);
			}
			// A run that ends (or pauses for an answer) has likely written files.
			if (state === "idle" || pendingUi > 0) this.bumpFiles(workspaceId);
		} else if (event.type === "update.status") {
			if (node !== LOCAL_NODE) this.onPeerUpdateStatus(node, event.status as AppUpdateStatus);
		} else if (event.type === "host.notice") {
			const message = String(event.message ?? "");
			this.toast(
				(event.level as Toast["level"]) ?? "info",
				node === LOCAL_NODE ? message : `${this.nodeName(node)}：${message}`,
			);
		} else if (event.type.startsWith("auth.")) {
			if (node === this.authNode) this.onAuthEvent(frame);
		} else {
			this.onSettingsEvent(node, frame);
		}
	}

	/** Events about pi's configuration, from this computer or the computer the settings screen manages. */
	private onSettingsEvent(node: string, frame: EventFrame): void {
		const event = frame.event;
		const managed = node === this.state.settingsNode;
		if (event.type === "provider.changed") {
			// This computer's providers also drive the main window's "no models" hints.
			if (managed || node === LOCAL_NODE) this.scheduleRefresh(`${PROVIDERS_KEY}${node}`);
			// Setting the default model writes the user settings.
			if (managed) this.set((s) => ({ piSettingsVersion: s.piSettingsVersion + 1 }));
		} else if (event.type === "runtime.changed") {
			// New-chat pickers may target a different computer than the settings page.
			this.set((s) => ({ agentConfigVersion: s.agentConfigVersion + 1 }));
		} else if (!managed) {
			return;
		} else if (event.type === "extension.changed") {
			this.set((s) => ({
				extensionsVersion: s.extensionsVersion + 1,
				piSettingsVersion: s.piSettingsVersion + 1,
			}));
		} else if (event.type === "settings.changed") {
			this.set((s) => ({ piSettingsVersion: s.piSettingsVersion + 1 }));
		} else if (event.type === "agentConfig.changed") {
			this.set((s) => ({ agentConfigVersion: s.agentConfigVersion + 1 }));
		} else if (event.type === "extension.progress") {
			const { type: _type, ...progress } = event as unknown as ExtensionProgressState & { type: string };
			this.set({ extensionProgress: progress });
		}
	}

	/** This computer's settings: remote access, devices, peers, providers. */
	private async reloadLocal(): Promise<void> {
		void this.loadRemote();
		void this.loadProviders(LOCAL_NODE);
		void this.loadPeers();
	}

	/** Remember paired computers' workspaces, to list them while those computers are offline. */
	private saveNodeCache(): void {
		const cache: Record<string, WorkspaceInfo[]> = {};
		for (const [node, state] of Object.entries(this.state.nodes)) {
			if (node !== LOCAL_NODE && state.workspaces.length) cache[node] = state.workspaces;
		}
		localStorage.setItem(NODE_WORKSPACES_KEY, JSON.stringify(cache));
	}

	/**
	 * Keep the selection and the new-chat target on existing workspaces. A workspace whose
	 * computer has not answered yet (offline, still connecting) stays selected.
	 */
	private fixSelection(): void {
		const { workspaces, workspaceNodes, nodes, selectedWorkspaceId, newChat } = this.state;
		const gone = (id: string | undefined) => {
			if (!id) return true;
			if (id in workspaceNodes) return false;
			// Unknown: gone once every computer that could have it has answered.
			return Object.values(nodes).every((n) => n.workspacesLoaded || n.connection === "closed");
		};
		const patch: Partial<AppState> = {};
		const fallback = workspaces[0]?.id;
		if (selectedWorkspaceId && gone(selectedWorkspaceId)) {
			patch.selectedWorkspaceId = fallback;
			patch.selectedSessionId = undefined;
		} else if (!selectedWorkspaceId && fallback) patch.selectedWorkspaceId = fallback;
		if (newChat?.workspaceId && gone(newChat.workspaceId)) {
			const selected = patch.selectedWorkspaceId ?? selectedWorkspaceId;
			const target = selected && selected in workspaceNodes ? selected : fallback;
			patch.newChat = target ? { workspaceId: target } : {};
		}
		const selected = patch.selectedWorkspaceId;
		if (selected && this.state.expanded[selected] === undefined) {
			patch.expanded = { ...this.state.expanded, [selected]: true };
		}
		if (Object.keys(patch).length) this.set(patch);
	}

	/** Load a computer's workspaces and sessions, including collapsed groups' running agents. */
	async loadWorkspaces(node = this.state.node): Promise<void> {
		const client = this.clients.get(node);
		if (!client) return;
		try {
			const { workspaces } = await client.request("workspace.list");
			if (this.clients.get(node) !== client) return;
			this.patchNode(node, { workspaces, workspacesLoaded: true });
			if (node !== LOCAL_NODE) this.saveNodeCache();
			this.fixSelection();
			void this.loadTasks(node);
			await Promise.all(workspaces.map((w) => this.refreshSessions(w.id)));
			if (this.clients.get(node) !== client) return;
			const { selectedSessionId, selectedWorkspaceId, sessions } = this.state;
			if (selectedSessionId && selectedWorkspaceId && workspaces.some((w) => w.id === selectedWorkspaceId)) {
				const list = sessions[selectedWorkspaceId];
				if (list && !list.some((s) => s.id === selectedSessionId)) this.set({ selectedSessionId: undefined });
			}
		} catch (error) {
			if (this.clients.get(node) !== client) return;
			const where = node === LOCAL_NODE ? "" : `${this.nodeName(node)} 的`;
			this.toast("error", `加载${where}工作区失败：${errorText(error)}`);
		}
	}

	private scheduleRefresh(key: string): void {
		clearTimeout(this.refreshTimers.get(key));
		this.refreshTimers.set(
			key,
			setTimeout(() => {
				this.refreshTimers.delete(key);
				if (key === DEVICES_KEY) void this.loadDevices();
				else if (key.startsWith(PROVIDERS_KEY)) void this.loadProviders(key.slice(PROVIDERS_KEY.length));
				else if (key === PEERS_KEY) void this.loadPeers();
				else if (key.startsWith("#workspaces:")) void this.loadWorkspaces(key.slice("#workspaces:".length));
				else if (key.startsWith("#tasks:")) void this.loadTasks(key.slice("#tasks:".length));
				else void this.refreshSessions(key);
			}, 150),
		);
	}

	// ---- remote access and devices (this computer) -------------------------------------

	async loadRemote(): Promise<void> {
		const client = this.localClient;
		if (!client) return;
		try {
			const [remote, { devices }] = await Promise.all([client.request("remote.status"), client.request("device.list")]);
			if (this.localClient === client) this.set({ remote, devices });
		} catch (error) {
			this.toast("error", `读取远程访问状态失败：${errorText(error)}`);
		}
	}

	private async loadDevices(): Promise<void> {
		const client = this.localClient;
		if (!client) return;
		try {
			const { devices } = await client.request("device.list");
			if (this.localClient === client) this.set({ devices });
		} catch {
			// Transient; the next device.changed or reconnect refreshes it.
		}
	}

	async configureRemote(
		patch: MethodParams<"remote.configure">,
		options: { rethrow?: boolean } = {},
	): Promise<RemoteAccessStatus | undefined> {
		if (options.rethrow) {
			const client = this.localClient;
			if (!client) throw new Error("尚未连接到本机的 Pier Host");
			const remote = await client.request("remote.configure", patch);
			this.set({ remote });
			return remote;
		}
		const remote = await this.callLocal("修改远程访问设置", (c) => c.request("remote.configure", patch));
		if (remote) this.set({ remote });
		return remote;
	}

	async startPairing(): Promise<void> {
		const pairing = await this.callLocal("生成配对码", (c) => c.request("pairing.start"));
		if (pairing) this.set({ pairing });
	}

	async cancelPairing(): Promise<void> {
		this.set({ pairing: undefined });
		await this.callLocal("取消配对", (c) => c.request("pairing.cancel"));
	}

	async respondPairing(requestId: string, accept: boolean): Promise<void> {
		this.set((s) => ({ pairingRequests: s.pairingRequests.filter((r) => r.id !== requestId) }));
		const result = await this.callLocal("回复配对请求", (c) => c.request("pairing.respond", { requestId, accept }));
		if (result && !result.accepted) this.toast("warning", "配对请求已失效（设备已断开或超时）");
	}

	async revokeDevice(deviceId: string): Promise<void> {
		const result = await this.callLocal("移除设备", (c) => c.request("device.revoke", { deviceId }));
		if (result) this.set((s) => ({ devices: s.devices.filter((d) => d.id !== deviceId) }));
	}

	async renameDevice(deviceId: string, name: string): Promise<void> {
		const result = await this.callLocal("重命名设备", (c) => c.request("device.rename", { deviceId, name }));
		if (result) this.set((s) => ({ devices: s.devices.map((d) => (d.id === deviceId ? result.device : d)) }));
	}

	// ---- other computers ---------------------------------------------------------------

	async loadPeers(): Promise<void> {
		const client = this.localClient;
		if (!client) return;
		try {
			const { peers } = await client.request("peer.list");
			if (this.localClient !== client) return;
			this.set({ peers });
			this.syncPeers();
		} catch {
			// Transient; the next peer.changed or reconnect refreshes it.
		}
	}

	/**
	 * Pair with another computer from the link its Pier shows; its workspaces then appear in the
	 * sidebar. Resolves once the other computer's user allowed it; rejects with a user-facing
	 * message otherwise.
	 */
	async pairPeer(uri: string): Promise<PeerInfo> {
		const client = this.localClient;
		if (!client) throw new Error("尚未连接到本机的 Pier Host");
		let peer: PeerInfo;
		try {
			peer = (await client.request("peer.pair", { uri: uri.trim() }, { timeoutMs: 4 * 60_000 })).peer;
		} catch (error) {
			throw new Error(peerPairingErrorText(error));
		}
		this.set((s) => ({ peers: [...s.peers.filter((p) => p.id !== peer.id), peer] }));
		this.toast("info", `已与 ${peer.name} 配对，它的工作区会出现在左侧列表中`);
		// Paired again after being removed there: connect afresh.
		this.closeNode(peer.id);
		this.patchNode(peer.id, { revoked: false, connectError: undefined });
		void this.connectPeer(peer.id);
		void this.loadPeers();
		return peer;
	}

	openAddPeer(): void {
		this.set({ addPeerOpen: true });
	}

	closeAddPeer(): void {
		if (this.state.addPeerOpen) this.set({ addPeerOpen: false });
	}

	/**
	 * Change the addresses used to reach a paired computer (e.g. its IP changed) and reconnect
	 * to it right away. Rejects with a user-facing message.
	 */
	async updatePeerAddresses(peerId: string, addresses: string[], relays?: string[]): Promise<PeerInfo> {
		const client = this.localClient;
		if (!client) throw new Error("尚未连接到本机的 Pier Host");
		let peer: PeerInfo;
		try {
			peer = (await client.request("peer.update", { peerId, addresses, ...(relays ? { relays } : {}) })).peer;
		} catch (error) {
			throw new Error(`保存失败：${errorText(error)}`);
		}
		this.set((s) => ({ peers: s.peers.map((p) => (p.id === peer.id ? peer : p)) }));
		if (!this.state.nodes[peer.id]?.revoked) {
			this.closeNode(peer.id);
			this.patchNode(peer.id, { connectError: undefined });
			void this.connectPeer(peer.id);
		}
		return peer;
	}

	/** Forget a paired computer here (it keeps this computer in its device list until removed there). */
	async removePeer(peerId: string): Promise<void> {
		const result = await this.callLocal("移除电脑", (c) => c.request("peer.remove", { peerId }));
		if (!result) return;
		this.set((s) => ({ peers: s.peers.filter((p) => p.id !== peerId) }));
		this.forgetNode(peerId);
	}

	// ---- host usage (status bar) -------------------------------------------------------

	/**
	 * Sample host usage every few seconds until the returned stop function is called: the
	 * usage of the computer of the workspace on screen, and with `detail` also this computer's
	 * and every paired computer's (through the connections the sidebar keeps open anyway).
	 */
	watchHostStats(detail = false): () => void {
		const kind = detail ? "detail" : "summary";
		this.statsWatchers[kind] += 1;
		this.updateStatsTimer();
		void this.pollHostStats();
		let stopped = false;
		return () => {
			if (stopped) return;
			stopped = true;
			this.statsWatchers[kind] -= 1;
			this.updateStatsTimer();
		};
	}

	private updateStatsTimer(): void {
		const active = this.statsWatchers.summary + this.statsWatchers.detail > 0;
		if (active && !this.statsTimer) {
			this.statsTimer = setInterval(() => void this.pollHostStats(), HOST_STATS_INTERVAL_MS);
		} else if (!active && this.statsTimer) {
			clearInterval(this.statsTimer);
			this.statsTimer = undefined;
		}
	}

	private async pollHostStats(): Promise<void> {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
		const nodes = new Set([this.state.node]);
		if (this.statsWatchers.detail > 0) {
			nodes.add(LOCAL_NODE);
			for (const peer of this.state.peers) nodes.add(peer.id);
		}
		await Promise.all([...nodes].map((node) => this.sampleHost(node)));
	}

	private setHostStats(node: string, entry: HostStatsEntry): void {
		const current = this.state.hostStats[node];
		if (current && current.state === entry.state && current.stats === entry.stats && current.error === entry.error) {
			return;
		}
		this.set((s) => ({ hostStats: { ...s.hostStats, [node]: entry } }));
	}

	private async sampleHost(node: string): Promise<void> {
		const client = this.clients.get(node);
		if (client?.state !== "open" || !client.host) {
			const state = this.state.nodes[node];
			const connecting = (!state || state.connection === "connecting") && !state?.connectError;
			this.setHostStats(
				node,
				connecting
					? { state: "loading" }
					: { state: "offline", ...(state?.connectError ? { error: state.connectError } : {}) },
			);
			return;
		}
		if (!hostReportsStats(client.host)) {
			this.setHostStats(node, { state: "unsupported" });
			return;
		}
		if (this.statsBusy.has(node)) return;
		this.statsBusy.add(node);
		try {
			const stats = await client.request("host.stats", {}, { timeoutMs: 10_000 });
			if (this.clients.get(node) === client) this.setHostStats(node, { state: "ok", stats });
		} catch (error) {
			if (this.clients.get(node) === client) this.setHostStats(node, { state: "error", error: errorText(error) });
		} finally {
			this.statsBusy.delete(node);
		}
	}

	// ---- models and providers (the computer the settings screen manages) ----------------

	/**
	 * Read a computer's providers: this computer's feed the main window's hints, the managed
	 * computer's (`settingsNode`, the default) the settings screen. Resolves to whether it worked.
	 */
	async loadProviders(node = this.state.settingsNode, report = false): Promise<boolean> {
		const client = this.openClient(node);
		if (!client) return false;
		try {
			const providers = await client.request("provider.list");
			if (this.clients.get(node) !== client) return false;
			this.set((s) => ({
				...(node === LOCAL_NODE ? { localProviders: providers } : {}),
				...(node === s.settingsNode ? { providers, settingsSyncedAt: Date.now() } : {}),
			}));
			return true;
		} catch (error) {
			if (report || (node === this.state.settingsNode && this.state.settings === "models")) {
				const where = node === LOCAL_NODE ? "" : `${this.nodeName(node)} 的`;
				this.toast("error", `读取${where}模型配置失败：${errorText(error)}`);
			}
			return false;
		}
	}

	/** Open the models page for a computer (the one the settings screen manages by default). */
	openModels(node?: string): void {
		this.openSettings("models", node);
	}

	/** Models with usable credentials on the computer the settings screen manages. */
	async availableModels(): Promise<ModelInfo[]> {
		const client = this.settingsClient;
		if (!client) return [];
		return (await client.request("model.list")).models;
	}

	async setDefaultModel(provider: string, modelId: string): Promise<void> {
		const node = this.state.settingsNode;
		const result = await this.callSettings("设置默认模型", (c) => c.request("model.setDefault", { provider, modelId }));
		if (result) void this.loadProviders(node);
	}

	async startLogin(provider: ProviderInfo, method: AuthMethod): Promise<void> {
		const node = this.state.settingsNode;
		const client = this.settingsClient;
		if (!client) {
			this.toast("error", `登录失败：${this.settingsOffline().message}`);
			return;
		}
		if (this.state.auth?.flowId) void this.cancelLogin();
		const seq = ++this.authSeq;
		this.authNode = node;
		this.authBacklog = [];
		this.set({ auth: { providerId: provider.id, providerName: provider.name, method, notices: [] } });
		try {
			const { flowId } = await client.request("provider.login", { providerId: provider.id, method });
			if (seq !== this.authSeq || !this.state.auth || this.state.auth.flowId) {
				// Closed (or replaced) while starting: stop the orphaned sign-in.
				await client.request("provider.loginCancel", { flowId }).catch(() => undefined);
				return;
			}
			this.set((s) => (s.auth ? { auth: { ...s.auth, flowId } } : {}));
			const backlog = this.authBacklog.filter((f) => f.event.flowId === flowId);
			this.authBacklog = [];
			for (const frame of backlog) this.onAuthEvent(frame);
		} catch (error) {
			if (seq === this.authSeq) this.set((s) => (s.auth ? { auth: { ...s.auth, error: errorText(error) } } : {}));
		}
	}

	private onAuthEvent(frame: EventFrame): void {
		const event = frame.event;
		const auth = this.state.auth;
		if (!auth) return;
		if (!auth.flowId) {
			this.authBacklog.push(frame);
			return;
		}
		if (event.flowId !== auth.flowId) return;
		if (event.type === "auth.prompt") {
			this.set({ auth: { ...auth, prompt: event.prompt as AuthPromptInfo } });
		} else if (event.type === "auth.promptClosed") {
			if (auth.prompt?.id === event.promptId) {
				const { prompt: _p, ...rest } = auth;
				this.set({ auth: rest });
			}
		} else if (event.type === "auth.notice") {
			const notice = event.notice as AuthNotice;
			if (notice.type === "auth_url" && !this.openedAuthUrls.has(notice.url)) {
				this.openedAuthUrls.add(notice.url);
				this.openExternal(notice.url);
			}
			this.set({ auth: { ...auth, notices: [...auth.notices, notice].slice(-20) } });
		} else if (event.type === "auth.done") {
			if (event.ok) {
				const defaultModel = event.defaultModel as DefaultModelRef | undefined;
				this.set({ auth: undefined });
				this.toast(
					"info",
					`${auth.method === "oauth" ? "已登录" : "已保存 API Key："}${auth.providerName}${
						defaultModel ? `，默认模型设为 ${defaultModel.modelId}` : ""
					}`,
				);
			} else if (event.cancelled) {
				this.set({ auth: undefined });
			} else {
				const { prompt: _p, ...rest } = auth;
				this.set({ auth: { ...rest, error: String(event.error ?? "登录失败") } });
			}
			void this.loadProviders(this.authNode);
		}
	}

	async answerAuthPrompt(value: string): Promise<void> {
		const auth = this.state.auth;
		if (!auth?.flowId || !auth.prompt) return;
		const promptId = auth.prompt.id;
		const { prompt: _p, ...rest } = auth;
		this.set({ auth: rest });
		await this.callWith(this.clients.get(this.authNode), "提交", (c) =>
			c.request("provider.loginRespond", { flowId: auth.flowId as string, promptId, value }),
		);
	}

	async cancelLogin(): Promise<void> {
		const auth = this.state.auth;
		this.authSeq++;
		this.set({ auth: undefined });
		if (auth?.flowId && !auth.error) {
			const client = this.clients.get(this.authNode);
			await client?.request("provider.loginCancel", { flowId: auth.flowId }).catch(() => undefined);
		}
	}

	async logoutProvider(provider: ProviderInfo): Promise<void> {
		const node = this.state.settingsNode;
		const result = await this.callSettings("移除凭据", (c) =>
			c.request("provider.logout", { providerId: provider.id }),
		);
		if (result) {
			this.toast("info", result.removed ? `已移除 ${provider.name} 的凭据` : `${provider.name} 没有可移除的凭据`);
			void this.loadProviders(node);
		}
	}

	/**
	 * Save a custom endpoint on a computer (the one the settings screen manages by default).
	 * Throws so the form can show the error next to the fields.
	 */
	async saveCustomProvider(
		provider: CustomProvider,
		key: { apiKey?: string | undefined; apiKeyRef?: string | undefined },
		create: boolean,
		node = this.state.settingsNode,
	): Promise<void> {
		const client = this.openClient(node);
		if (!client) {
			throw new Error(
				node === LOCAL_NODE ? "尚未连接到本机的 Pier Host" : `尚未连接到 ${this.nodeName(node)} 上的 Pier Host`,
			);
		}
		const result = await client.request("provider.saveCustom", {
			provider,
			...(key.apiKeyRef ? { apiKeyRef: key.apiKeyRef } : key.apiKey ? { apiKey: key.apiKey } : {}),
			create,
		});
		this.toast(
			"info",
			`已保存 ${result.provider.name}${result.defaultModel ? `，默认模型设为 ${result.defaultModel.modelId}` : ""}`,
		);
		await this.loadProviders(node);
	}

	async removeCustomProvider(provider: ProviderInfo): Promise<void> {
		const node = this.state.settingsNode;
		const result = await this.callSettings("删除服务商", (c) =>
			c.request("provider.removeCustom", { providerId: provider.id }),
		);
		if (result?.removed) {
			this.toast("info", `已删除 ${provider.name}`);
			void this.loadProviders(node);
		}
	}

	/** Models offered by an endpoint. Throws with the host's message. */
	async probeModels(params: {
		api: CustomProviderApi;
		baseUrl: string;
		apiKey?: string;
		apiKeyRef?: string;
		providerId?: string;
	}): Promise<CustomModel[]> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return (await client.request("provider.probeModels", params, { timeoutMs: 30_000 })).models;
	}

	// ---- 云链API sign-in (NewAPI app authorization in the browser) ------------------------

	/**
	 * Sign in to 云链API: open its authorization page in the browser and, once the user approves,
	 * save (or refresh) the provider with the new token and every model it can use. Always on
	 * this computer: the browser returns to a loopback address on the host's own computer.
	 */
	async loginYunlian(): Promise<void> {
		const client = this.localClient;
		if (!client) {
			this.toast("error", "尚未连接到本机的 Pier Host");
			return;
		}
		this.cancelYunlian();
		const seq = ++this.yunlianSeq;
		const current = () => seq === this.yunlianSeq;
		this.set({ yunlian: {} });
		try {
			// The line this computer's personal center uses (protocol 1.29), else the default one.
			const account = await client.request("account.status", {}).catch(() => undefined);
			const siteUrl = account?.lines?.find((line) => line.id === account.line)?.url ?? YUNLIAN_SITE;
			const started = await client.request("newapi.authorizeStart", { baseUrl: siteUrl }, { timeoutMs: 45_000 });
			if (!current()) {
				// Closed while starting: stop the orphaned authorization.
				void client.request("newapi.authorizeCancel", { flowId: started.flowId }).catch(() => undefined);
				return;
			}
			this.yunlianFlow = started.flowId;
			this.set({ yunlian: { authorizeUrl: started.authorizeUrl } });
			this.openExternal(started.authorizeUrl);
			const result = await client.request(
				"newapi.authorizeWait",
				{ flowId: started.flowId },
				{ timeoutMs: 11 * 60_000 },
			);
			if (!current()) return;
			this.yunlianFlow = undefined;
			this.set({ yunlian: { authorizeUrl: started.authorizeUrl, saving: true } });
			const existing = this.state.localProviders?.providers.find(
				(p) => p.custom && isYunlianProvider(p) && yunlianGroupOf(p) === undefined,
			)?.custom;
			const provider = yunlianProvider(result.models, existing, result.modelsError, siteUrl);
			await this.saveCustomProvider(provider, { apiKeyRef: result.keyRef }, !existing, LOCAL_NODE);
			if (current()) this.set({ yunlian: undefined });
		} catch (error) {
			if (current()) {
				this.yunlianFlow = undefined;
				this.set({ yunlian: { error: errorText(error) } });
			}
		}
	}

	/**
	 * Call a loopback relay method (`loopback.*`, 1.28) on this computer's host, which catches a
	 * browser sign-in's redirect for another computer. Throws with the host's message.
	 */
	loopback<M extends Extract<MethodName, `loopback.${string}`>>(
		method: M,
		params: MethodParams<M>,
		timeoutMs = 45_000,
	): Promise<MethodResult<M>> {
		const client = this.localClient;
		if (!client) return Promise.reject(new Error("尚未连接到本机的 Pier Host"));
		return (client.request as (m: M, p: MethodParams<M>, o: { timeoutMs: number }) => Promise<MethodResult<M>>)(
			method,
			params,
			{ timeoutMs },
		);
	}

	/**
	 * Call a personal-center method (`account.*`) on the computer the settings screen manages.
	 * Throws with the host's message.
	 */
	account<M extends Extract<MethodName, `account.${string}`>>(
		method: M,
		params: MethodParams<M>,
		timeoutMs = 45_000,
	): Promise<MethodResult<M>> {
		const client = this.settingsClient;
		if (!client) return Promise.reject(this.settingsOffline());
		return (client.request as (m: M, p: MethodParams<M>, o: { timeoutMs: number }) => Promise<MethodResult<M>>)(
			method,
			params,
			{ timeoutMs },
		);
	}

	/**
	 * Move the 云链API providers of the computer the settings screen manages to the line at
	 * `siteUrl` (their keys stay). Providers whose Base URL was changed by hand are left alone.
	 * Resolves to the number of providers moved.
	 */
	async moveYunlianProviders(siteUrl: string): Promise<number> {
		const node = this.state.settingsNode;
		const client = this.openClient(node);
		if (!client) return 0;
		const { providers } = await client.request("provider.list");
		const moved = movedToLine(providers, siteUrl);
		for (const provider of moved) await client.request("provider.saveCustom", { provider, create: false });
		if (moved.length) await this.loadProviders(node);
		return moved.length;
	}

	/** Close the 云链API sign-in, abandoning a pending authorization. */
	cancelYunlian(): void {
		this.yunlianSeq++;
		const flowId = this.yunlianFlow;
		this.yunlianFlow = undefined;
		if (flowId) void this.localClient?.request("newapi.authorizeCancel", { flowId }).catch(() => undefined);
		if (this.state.yunlian) this.set({ yunlian: undefined });
	}

	async refreshSessions(workspaceId: string): Promise<void> {
		const node = this.nodeOf(workspaceId);
		const client = this.clients.get(node);
		// An offline computer's lists load once it is connected again.
		if (!client || this.state.nodes[node]?.connection !== "open") return;
		// A removed workspace can still get a late refresh (closing its sessions announces list
		// changes); its list is gone, so there is nothing to load or report.
		const known = () => workspaceId in this.state.workspaceNodes;
		if (!known()) return;
		const current = () => this.clients.get(node) === client && known();
		try {
			const { sessions } = await client.request("session.list", { workspaceId });
			if (!current()) return;
			this.set((s) => ({ sessions: { ...s.sessions, [workspaceId]: sessions } }));
		} catch (error) {
			if (current()) this.toast("error", `加载会话列表失败：${errorText(error)}`);
		}
	}

	restartHost(): void {
		void this.bridge.restartHost();
	}

	/** Always controls this computer's shell, regardless of the selected host. */
	autostartStatus(): Promise<boolean> {
		return this.bridge.autostart?.status() ?? Promise.reject(new Error("开机自启仅在桌面应用中可用"));
	}

	setAutostartEnabled(enabled: boolean): Promise<boolean> {
		return this.bridge.autostart?.setEnabled(enabled) ?? Promise.reject(new Error("开机自启仅在桌面应用中可用"));
	}

	// ---- toasts ------------------------------------------------------------------------

	toast(level: Toast["level"], message: string): void {
		const id = this.nextToastId++;
		this.set((s) => ({ toasts: [...s.toasts, { id, level, message }].slice(-5) }));
		setTimeout(() => this.dismissToast(id), level === "error" ? 10_000 : 5_000);
	}

	dismissToast(id: number): void {
		this.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
	}

	/** Call this computer's host (pairing, remote access), reporting failures as a toast. */
	private callLocal<T>(action: string, fn: (client: PierClient) => Promise<T>): Promise<T | undefined> {
		return this.callWith(this.localClient, action, fn);
	}

	/** Call the host of the computer the settings screen manages, reporting failures as a toast. */
	private async callSettings<T>(action: string, fn: (client: PierClient) => Promise<T>): Promise<T | undefined> {
		const client = this.settingsClient;
		if (!client) {
			this.toast("error", `${action}失败：${this.settingsOffline().message}`);
			return undefined;
		}
		return this.callWith(client, action, fn);
	}

	private async callWith<T>(
		client: PierClient | undefined,
		action: string,
		fn: (client: PierClient) => Promise<T>,
	): Promise<T | undefined> {
		if (!client) {
			this.toast("error", `${action}失败：尚未连接到 Pier Host`);
			return undefined;
		}
		try {
			return await fn(client);
		} catch (error) {
			this.toast("error", `${action}失败：${errorText(error)}`);
			return undefined;
		}
	}

	// ---- pi settings files ---------------------------------------------------------------

	/** Read the user settings, plus a workspace's project settings; rejects with the host's error. */
	async getPiSettings(workspaceId?: string): Promise<PiSettingsResult> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("settings.get", workspaceId ? { workspaceId } : {});
	}

	/** npm, pnpm and bun found on the managed computer, for pi's `npmCommand`; rejects with the host's error. */
	async detectPackageManagers(): Promise<PackageManagerInfo[]> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		const result = await client.request("host.packageManagers", {}, { timeoutMs: 20_000 });
		return result.managers;
	}

	/** Set (or, without `value`, remove) settings in one file. Failures are reported as a toast. */
	async updatePiSettings(
		scope: ExtensionScope,
		workspaceId: string | undefined,
		changes: Array<{ path: string[]; value?: unknown }>,
		reload = true,
	): Promise<PiSettingsChangeResult | undefined> {
		const result = await this.callSettings("保存设置", (c) =>
			c.request("settings.update", {
				scope,
				...(scope === "project" && workspaceId ? { workspaceId } : {}),
				changes,
				reload,
			}),
		);
		if (result) this.reportSettingsReload(result.reload);
		return result;
	}

	/** Replace a settings file with `text`; rejects with the host's error (e.g. `CONFLICT`). */
	async writePiSettings(
		scope: ExtensionScope,
		workspaceId: string | undefined,
		text: string,
		expectedModifiedAt?: string,
	): Promise<PiSettingsChangeResult> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		const result = await client.request("settings.write", {
			scope,
			...(scope === "project" && workspaceId ? { workspaceId } : {}),
			text,
			...(expectedModifiedAt ? { expectedModifiedAt } : {}),
		});
		this.reportSettingsReload(result.reload);
		return result;
	}

	// ---- Claude Code and Codex configuration files ----------------------------------------

	async getAgentInstallation(
		runtime: AgentConfigRuntime,
		refresh = false,
	): Promise<MethodResult<"runtime.installStatus">> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("runtime.installStatus", { runtime, ...(refresh ? { refresh } : {}) });
	}

	async installAgent(runtime: AgentConfigRuntime): Promise<MethodResult<"runtime.install">> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("runtime.install", { runtime });
	}

	/** Models offered by an agent on the computer the settings screen manages. */
	async listAgentModels(runtime: AgentConfigRuntime): Promise<MethodResult<"model.list">> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("model.list", { runtime });
	}

	/** Read a runtime's user file, plus a workspace's files; rejects with the host's error. */
	async getAgentConfig(runtime: AgentConfigRuntime, workspaceId?: string): Promise<AgentConfigResult> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("agentConfig.get", { runtime, ...(workspaceId ? { workspaceId } : {}) });
	}

	/** Set (or, without `value`, remove) settings in one file. Failures are reported as a toast. */
	async updateAgentConfig(
		runtime: AgentConfigRuntime,
		scope: AgentConfigScope,
		workspaceId: string | undefined,
		changes: Array<{ path: string[]; value?: unknown }>,
	): Promise<AgentConfigChangeResult | undefined> {
		return this.callSettings("保存设置", (c) =>
			c.request("agentConfig.update", {
				runtime,
				scope,
				...(scope !== "user" && workspaceId ? { workspaceId } : {}),
				changes,
			}),
		);
	}

	/**
	 * Change a runtime's user file with edits that may carry token key references (protocol
	 * 1.25), e.g. to point it at a personal-center group. Throws with the host's message.
	 */
	async updateAgentUserConfig(
		runtime: AgentConfigRuntime,
		changes: Array<{ path: string[]; value?: unknown; apiKeyRef?: string }>,
	): Promise<AgentConfigChangeResult> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("agentConfig.update", { runtime, scope: "user", changes });
	}

	/** Replace one file with `text`; rejects with the host's error (e.g. `CONFLICT`). */
	async writeAgentConfig(
		runtime: AgentConfigRuntime,
		scope: AgentConfigScope,
		workspaceId: string | undefined,
		text: string,
		expectedModifiedAt?: string,
	): Promise<AgentConfigChangeResult> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("agentConfig.write", {
			runtime,
			scope,
			...(scope !== "user" && workspaceId ? { workspaceId } : {}),
			text,
			...(expectedModifiedAt ? { expectedModifiedAt } : {}),
		});
	}

	/** Mention sessions that did not pick up a settings change (reloaded ones need no toast). */
	private reportSettingsReload(reload: ExtensionReloadSummary): void {
		const parts: string[] = [];
		if (reload.pending) parts.push(`${reload.pending} 个会话正在运行，完成后在会话中执行 /reload 生效`);
		if (reload.failed) parts.push(`${reload.failed} 个会话重新加载失败（详见日志）`);
		if (parts.length) this.toast(reload.failed ? "warning" : "info", `设置已保存；${parts.join("；")}`);
	}

	// ---- pi extensions and packages -----------------------------------------------------

	/** List extensions and packages (user settings, plus a workspace's project settings); rejects with the host's error. */
	async listExtensions(workspaceId?: string): Promise<ExtensionListResult> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("extension.list", workspaceId ? { workspaceId } : {});
	}

	/** Tell the user about sessions that still run the old extensions. */
	private reportReload(done: string, reload: ExtensionReloadSummary): void {
		const parts = [done];
		if (reload.reloaded) parts.push(`已重新加载 ${reload.reloaded} 个打开的会话`);
		if (reload.pending) parts.push(`${reload.pending} 个会话正在运行，完成后在会话中执行 /reload 生效`);
		if (reload.failed) parts.push(`${reload.failed} 个会话重新加载失败（详见日志）`);
		this.toast(reload.failed ? "warning" : "info", parts.join("；"));
	}

	private async extensionOperation<T extends { reload: ExtensionReloadSummary }>(
		action: string,
		done: string,
		fn: (client: PierClient) => Promise<T>,
	): Promise<T | undefined> {
		this.set({ extensionProgress: undefined });
		const result = await this.callSettings(action, fn);
		this.set({ extensionProgress: undefined });
		if (result) this.reportReload(done, result.reload);
		return result;
	}

	async installExtension(
		source: string,
		scope: ExtensionScope,
		workspaceId?: string,
	): Promise<ExtensionPackageInfo | undefined | false> {
		const result = await this.extensionOperation("安装", `已安装 ${source}`, (c) =>
			c.request(
				"extension.install",
				{ source, scope, ...(workspaceId ? { workspaceId } : {}) },
				{ timeoutMs: 15 * 60_000 },
			),
		);
		return result ? result.package : false;
	}

	async removeExtensionPackage(pkg: ExtensionPackageInfo, workspaceId?: string): Promise<boolean> {
		const result = await this.extensionOperation("移除", `已移除 ${pkg.name ?? pkg.source}`, (c) =>
			c.request(
				"extension.remove",
				{ source: pkg.source, scope: pkg.scope, ...(workspaceId ? { workspaceId } : {}) },
				{ timeoutMs: 5 * 60_000 },
			),
		);
		return result?.removed ?? false;
	}

	async updateExtensions(source?: string, workspaceId?: string): Promise<boolean> {
		const result = await this.extensionOperation("更新", source ? `已更新 ${source}` : "已更新所有扩展包", (c) =>
			c.request(
				"extension.update",
				{ ...(source ? { source } : {}), ...(workspaceId ? { workspaceId } : {}) },
				{ timeoutMs: 15 * 60_000 },
			),
		);
		return result !== undefined;
	}

	async checkExtensionUpdates(workspaceId?: string): Promise<ExtensionUpdateInfo[] | undefined> {
		const result = await this.callSettings("检查更新", (c) =>
			c.request("extension.checkUpdates", workspaceId ? { workspaceId } : {}, { timeoutMs: 5 * 60_000 }),
		);
		return result?.updates;
	}

	async setExtensionEnabled(
		resource: ExtensionResourceInfo,
		enabled: boolean,
		workspaceId?: string,
	): Promise<ExtensionResourceInfo | undefined> {
		const result = await this.extensionOperation(
			enabled ? "启用" : "停用",
			`已${enabled ? "启用" : "停用"} ${resource.name}`,
			(c) =>
				c.request("extension.setEnabled", {
					type: resource.type as ExtensionResourceType,
					path: resource.path,
					enabled,
					...(workspaceId ? { workspaceId } : {}),
				}),
		);
		return result?.resource;
	}

	async deleteExtension(resource: ExtensionResourceInfo, workspaceId?: string): Promise<boolean> {
		const result = await this.extensionOperation(
			"删除",
			resource.source === "auto" ? `已删除 ${resource.name}（已移到 Pier 回收站）` : `已从配置中移除 ${resource.name}`,
			(c) =>
				c.request("extension.delete", {
					type: resource.type,
					path: resource.path,
					...(workspaceId ? { workspaceId } : {}),
				}),
		);
		return result?.deleted ?? false;
	}

	/**
	 * Search the pi package gallery (pi.dev/packages) from the computer the settings screen
	 * manages; rejects with the host's error.
	 */
	async searchExtensionCatalog(params: {
		query?: string;
		type?: ExtensionCatalogType;
		sort?: ExtensionCatalogSort;
		page?: number;
	}): Promise<ExtensionCatalogResult> {
		const client = this.settingsClient;
		if (!client) throw this.settingsOffline();
		return client.request("extension.search", params, { timeoutMs: 45_000 });
	}

	// ---- workspaces --------------------------------------------------------------------

	toggleSidebar(open = !this.state.sidebar): void {
		if (open !== this.state.sidebar) this.set({ sidebar: open });
	}

	setSidebarWidth(width: number): void {
		const sidebarWidth = clampSidebarWidth(width);
		if (sidebarWidth !== this.state.sidebarWidth) this.set({ sidebarWidth });
	}

	toggleFilesPanel(open = !this.state.filesPanel): void {
		if (open !== this.state.filesPanel) this.set({ filesPanel: open });
	}

	/** Show the right-hand panel on `tab` (files or source control). */
	showRightPanel(tab: RightPanelTab): void {
		if (tab !== this.state.rightPanelTab || !this.state.filesPanel) {
			this.set({ rightPanelTab: tab, filesPanel: true });
		}
	}

	/**
	 * Call a Git method (`git.*`, 1.28) on the computer of a workspace. Throws with the host's
	 * error; methods that change the repository refresh the file panel.
	 */
	async git<M extends Extract<MethodName, `git.${string}`>>(
		method: M,
		params: MethodParams<M>,
		timeoutMs = 60_000,
	): Promise<MethodResult<M>> {
		const workspaceId = (params as { workspaceId: string }).workspaceId;
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		if (!hostSupportsGit(this.state.nodes[this.nodeOf(workspaceId)]?.hostInfo)) {
			throw new Error("那台电脑的 Pier 版本过旧，不支持 Git，请先更新它");
		}
		const result = await (
			client.request as (m: M, p: MethodParams<M>, o: { timeoutMs: number }) => Promise<MethodResult<M>>
		)(method, params, { timeoutMs });
		const readOnly = ["git.status", "git.diff", "git.log", "git.show", "git.branches"];
		if (!readOnly.includes(method)) this.bumpFiles(workspaceId);
		return result;
	}

	setFilesPanelWidth(width: number): void {
		const filesPanelWidth = clampPanelWidth(width);
		if (filesPanelWidth !== this.state.filesPanelWidth) this.set({ filesPanelWidth });
	}

	/** List one directory of a workspace; rejects with the host's error. */
	async listFiles(workspaceId: string, path: string): Promise<WorkspaceFilesResult> {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("workspace.files", path ? { workspaceId, path } : { workspaceId });
	}

	/** Read one workspace file for preview; rejects with the host's error. */
	async readFile(workspaceId: string, path: string): Promise<WorkspaceFileContent> {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("workspace.readFile", { workspaceId, path });
	}

	/** Read a Markdown reference on the computer that owns the conversation. */
	async previewFile(workspaceId: string, path: string): Promise<WorkspaceFileContent> {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("workspace.previewFile", { workspaceId, path });
	}

	/** Read just the file the user confirmed, on its owning computer, without saving an allowance. */
	async authorizeFilePreview(
		workspaceId: string,
		path: string,
		expectedRealPath: string,
	): Promise<WorkspaceFileContent> {
		const node = this.nodeOf(workspaceId);
		if (!hostAuthorizesFilePreviews(this.state.nodes[node]?.hostInfo, node !== LOCAL_NODE)) {
			throw new Error("文件所在电脑的 Pier 不支持本次预览授权，请更新它的 Pier");
		}
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("workspace.authorizeFilePreview", { workspaceId, path, expectedRealPath });
	}

	/**
	 * Overwrite a workspace file with text; rejects with the host's error (`CONFLICT` when the
	 * file changed since `expectedModifiedAt`). Refreshes the file panel on success.
	 */
	async writeFile(
		workspaceId: string,
		path: string,
		text: string,
		expectedModifiedAt?: string,
	): Promise<WorkspaceFileWriteResult> {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		if (!this.canManage(this.nodeOf(workspaceId))) throw new Error("那台电脑的 Pier 版本过旧，不支持远程编辑文件");
		const result = await client.request("workspace.writeFile", {
			workspaceId,
			path,
			text,
			...(expectedModifiedAt ? { expectedModifiedAt } : {}),
		});
		this.bumpFiles(workspaceId);
		return result;
	}

	/**
	 * Permanently delete a workspace file or directory (with its contents); rejects with the
	 * host's error. Closes a preview of the deleted path and refreshes the file panel.
	 */
	async deletePath(workspaceId: string, path: string): Promise<WorkspacePathDeleteResult> {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		if (!hostCanDeleteFiles(this.state.nodes[this.nodeOf(workspaceId)]?.hostInfo)) {
			throw new Error("这台电脑的 Pier 版本过旧，不支持删除文件");
		}
		const result = await client.request("workspace.deletePath", { workspaceId, path });
		const preview = this.state.filePreview;
		if (
			preview?.workspaceId === workspaceId &&
			(preview.path === result.path || preview.path.startsWith(`${result.path}/`))
		) {
			this.closeFilePreview();
		}
		this.bumpFiles(workspaceId);
		return result;
	}

	/**
	 * The client for uploading to or downloading from a workspace's computer; throws when it is
	 * not connected or its Pier is too old.
	 */
	fileTransferClient(workspaceId: string): PierClient {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("尚未连接到 Pier Host");
		if (!hostTransfersFiles(this.state.nodes[this.nodeOf(workspaceId)]?.hostInfo)) {
			throw new Error("那台电脑的 Pier 版本过旧，不支持上传和下载文件，请先更新它");
		}
		return client;
	}

	bumpFiles(workspaceId: string): void {
		this.set((s) => ({ filesVersion: { ...s.filesVersion, [workspaceId]: (s.filesVersion[workspaceId] ?? 0) + 1 } }));
	}

	openFilePreview(workspaceId: string, path: string, composerKey?: string): void {
		this.set({ filePreview: { workspaceId, path, ...(composerKey ? { composerKey } : {}) } });
	}

	openMarkdownFilePreview(workspaceId: string, path: string): void {
		this.set({ filePreview: { workspaceId, path, fromMarkdown: true } });
	}

	closeFilePreview(): void {
		if (this.state.filePreview) this.set({ filePreview: undefined });
	}

	/** Called by a mounted composer; returns the unregister function. */
	registerComposer(sessionId: string, insert: (path: string, directory: boolean) => void): () => void {
		this.composerInserts.set(sessionId, insert);
		return () => {
			if (this.composerInserts.get(sessionId) === insert) this.composerInserts.delete(sessionId);
		};
	}

	/**
	 * Insert a workspace file (or directory) chip at the cursor of the session's composer, or
	 * append it to the saved draft when that composer is not on screen.
	 */
	insertFileIntoComposer(sessionId: string, path: string, directory = false): void {
		const insert = this.composerInserts.get(sessionId);
		if (insert) {
			insert(path, directory);
			return;
		}
		const draft = this.draft(sessionId);
		const sep = draft.text && !/\s$/.test(draft.text) ? " " : "";
		this.saveDraft(sessionId, { ...draft, text: `${draft.text}${sep}${fileToken(path, directory)} ` });
	}

	/**
	 * Add a workspace on a computer (this one by default). Paired computers accept this from
	 * hosts speaking protocol 1.10. The new workspace is selected.
	 */
	async addWorkspace(path: string, policy?: ApprovalPolicy, node = LOCAL_NODE): Promise<WorkspaceInfo | undefined> {
		const client = this.clients.get(node);
		const where = node === LOCAL_NODE ? "" : `（${this.nodeName(node)}）`;
		const result = await this.callWith(client, `添加工作区${where}`, (c) =>
			c.request("workspace.add", { path, ...(policy ? { policy } : {}) }),
		);
		if (!result || !client) return undefined;
		await this.loadWorkspaces(node);
		const id = result.workspace.id;
		if (!(id in this.state.workspaceNodes)) return result.workspace;
		this.set((s) => ({
			selectedWorkspaceId: id,
			selectedSessionId: undefined,
			expanded: { ...s.expanded, [id]: true },
			...(s.newChat ? { newChat: { workspaceId: id } } : {}),
		}));
		await this.refreshSessions(id);
		return result.workspace;
	}

	/** Remove a workspace from its computer's Pier (no files are deleted). */
	async removeWorkspace(workspaceId: string): Promise<void> {
		const node = this.nodeOf(workspaceId);
		const client = this.clients.get(node);
		const result = await this.callWith(client, "移除工作区", (c) => c.request("workspace.remove", { workspaceId }));
		if (!result || !client) return;
		for (const [id, chat] of this.chats) {
			if (chat.workspaceId === workspaceId) this.dropChat(id);
		}
		if (this.state.selectedWorkspaceId === workspaceId) {
			this.set({ selectedWorkspaceId: undefined, selectedSessionId: undefined });
		}
		this.forgetWorkspace(node, workspaceId);
		await this.loadWorkspaces(node);
	}

	/** Drop a removed workspace and its session list right away, cancelling any pending refresh. */
	private forgetWorkspace(node: string, workspaceId: string): void {
		clearTimeout(this.refreshTimers.get(workspaceId));
		this.refreshTimers.delete(workspaceId);
		const workspaces = this.state.nodes[node]?.workspaces ?? [];
		if (workspaces.some((w) => w.id === workspaceId)) {
			this.patchNode(node, { workspaces: workspaces.filter((w) => w.id !== workspaceId) });
			if (node !== LOCAL_NODE) this.saveNodeCache();
		}
		if (workspaceId in this.state.sessions) {
			this.set((s) => {
				const { [workspaceId]: _removed, ...sessions } = s.sessions;
				return { sessions };
			});
		}
	}

	async setPolicy(workspaceId: string, policy: ApprovalPolicy): Promise<void> {
		const node = this.nodeOf(workspaceId);
		const result = await this.callWith(this.clients.get(node), "修改审批策略", (c) =>
			c.request("workspace.setPolicy", { workspaceId, policy }),
		);
		if (!result) return;
		const workspaces = (this.state.nodes[node]?.workspaces ?? []).map((w) =>
			w.id === workspaceId ? result.workspace : w,
		);
		this.patchNode(node, { workspaces });
		if (node !== LOCAL_NODE) this.saveNodeCache();
	}

	/** Whether the computer of the workspace on screen lets this one manage it. */
	get canManageNode(): boolean {
		return this.canManage(this.state.node);
	}

	/** Subdirectories of a directory on a computer (its home directory by default). */
	async listDirectories(
		path?: string,
		node = this.state.directoryPicker?.node ?? LOCAL_NODE,
	): Promise<HostDirectoryListing> {
		const client = this.clients.get(node);
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("host.listDirectories", path ? { path } : {});
	}

	/**
	 * Pick a directory on a computer: the system dialog for this computer, or Pier's directory
	 * browser for a paired one. Resolves to `null` when cancelled.
	 */
	pickNodeDirectory(node = LOCAL_NODE, title = "选择工作区目录"): Promise<string | null> {
		if (node === LOCAL_NODE) return this.pickDirectory();
		this.directoryPickerResolve?.(null);
		return new Promise((resolve) => {
			this.directoryPickerResolve = resolve;
			this.set({ directoryPicker: { title, node } });
		});
	}

	/** Pick a directory on a computer and add it as a workspace there. */
	async pickAndAddWorkspace(node = LOCAL_NODE): Promise<void> {
		const path = await this.pickNodeDirectory(node);
		if (path) await this.addWorkspace(path, undefined, node);
	}

	/** Close the paired computer's directory picker with a path, or `null` when cancelled. */
	resolveDirectoryPicker(path: string | null): void {
		const resolve = this.directoryPickerResolve;
		this.directoryPickerResolve = undefined;
		if (this.state.directoryPicker) this.set({ directoryPicker: undefined });
		resolve?.(path);
	}

	toggleExpanded(workspaceId: string): void {
		const open = !this.state.expanded[workspaceId];
		this.set((s) => ({ expanded: { ...s.expanded, [workspaceId]: open } }));
		if (open) void this.refreshSessions(workspaceId);
	}

	selectWorkspace(workspaceId: string): void {
		this.set((s) => ({
			selectedWorkspaceId: workspaceId,
			selectedSessionId: undefined,
			newChat: undefined,
			expanded: { ...s.expanded, [workspaceId]: true },
		}));
		if (!this.state.sessions[workspaceId]) void this.refreshSessions(workspaceId);
	}

	// ---- new chat ----------------------------------------------------------------------

	/**
	 * Open the blank new-chat screen. The session is only created when the first message is
	 * sent, so opening it and walking away leaves no empty session behind.
	 */
	startNewChat(workspaceId?: string): void {
		const { workspaces, selectedWorkspaceId } = this.state;
		const target =
			workspaces.find((w) => w.id === workspaceId) ??
			workspaces.find((w) => w.id === selectedWorkspaceId) ??
			workspaces[0];
		this.set({ newChat: target ? { workspaceId: target.id } : {}, selectedSessionId: undefined });
	}

	setNewChatWorkspace(workspaceId: string): void {
		if (this.state.newChat) this.set({ newChat: { workspaceId } });
	}

	/** Remember the model / thinking level for new chats on the computer of `workspaceId`. */
	setNewChatModel(workspaceId: string, choice: NewChatModelChoice): void {
		const node = this.nodeOf(workspaceId);
		this.set((s) => ({ newChatModel: { ...s.newChatModel, [node]: { ...s.newChatModel[node], ...choice } } }));
	}

	/** The agent runtime new chats in `workspaceId` use. */
	newChatRuntime(workspaceId: string): AgentRuntimeId {
		return this.state.newChatRuntime[this.nodeOf(workspaceId)] ?? "pi";
	}

	/** Pick the agent runtime for new chats on the computer of `workspaceId` (resets the model). */
	setNewChatRuntime(workspaceId: string, runtime: AgentRuntimeId): void {
		const node = this.nodeOf(workspaceId);
		if ((this.state.newChatRuntime[node] ?? "pi") === runtime) return;
		this.set((s) => ({
			newChatRuntime: { ...s.newChatRuntime, [node]: runtime },
			newChatModel: { ...s.newChatModel, [node]: undefined },
		}));
	}

	/** The agent runtimes of a workspace's computer (only pi on hosts older than 1.22). */
	async listRuntimes(workspaceId: string): Promise<AgentRuntimeInfo[]> {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("未连接到工作区所在的电脑");
		if (!hostRunsAgents(this.state.nodes[this.nodeOf(workspaceId)]?.hostInfo)) return [];
		return (await client.request("runtime.list", {})).runtimes;
	}

	/**
	 * The models a workspace's computer offers for `runtime` (default pi), with the model and
	 * thinking level a new session there starts with (`current` / `thinkingLevel`, 1.19+).
	 */
	async listModels(workspaceId: string, runtime: AgentRuntimeId = "pi"): Promise<MethodResult<"model.list">> {
		const client = this.clientFor(workspaceId);
		if (!client) throw new Error("未连接到工作区所在的电脑");
		const result = await client.request("model.list", { workspaceId, ...(runtime !== "pi" ? { runtime } : {}) });
		if (runtime !== "pi" || result.current || !result.models.length || hostSpeaks(client.host, 19)) return result;
		// Hosts before 1.19 do not say which model a new session starts with: work it out from
		// the workspace's pi settings (1.15), so the chip shows the default model.
		if (!hostSpeaks(client.host, 15)) return result;
		const settings = await client.request("settings.get", { workspaceId }).catch(() => undefined);
		if (!settings) return result;
		return { ...result, ...newSessionDefaultsFromSettings(result.models, settings) };
	}

	/**
	 * Send the new-chat draft: create a session in the chosen workspace, open it, and let its
	 * composer send the draft once the session has loaded (so slash commands and failures behave
	 * exactly as in any other session). Resolves to whether the session was created.
	 */
	async sendNewChat(draft: Draft): Promise<boolean> {
		const workspaceId = this.state.newChat?.workspaceId;
		if (!workspaceId) {
			this.toast("warning", "请先选择一个工作区");
			return false;
		}
		const client = this.clientFor(workspaceId);
		const runtime = this.newChatRuntime(workspaceId);
		const result = await this.callWith(client, "新建会话", (c) =>
			c.request("session.create", { workspaceId, ...(runtime !== "pi" ? { runtime } : {}) }),
		);
		if (!result) return false;
		const session = result.session;
		const choice = this.state.newChatModel[this.nodeOf(workspaceId)];
		if (client && choice && (choice.model || choice.thinkingLevel)) {
			// Apply the model picked on the new-chat screen before the first message is sent.
			const sessionId = session.id;
			const applied = await this.callWith(client, "设置模型", async (c) => {
				if (choice.model) {
					await c.request("model.set", { sessionId, provider: choice.model.provider, modelId: choice.model.id });
				}
				if (choice.thinkingLevel) await c.request("thinking.set", { sessionId, level: choice.thinkingLevel });
				return true;
			});
			// The session exists either way; open it but keep the draft unsent so nothing runs
			// with a model the user did not pick.
			if (!applied) {
				this.drafts.delete(NEW_CHAT_DRAFT);
				this.saveDraft(session.id, draft);
				this.upsertSession(session);
				this.selectSession(session);
				return true;
			}
		}
		this.drafts.delete(NEW_CHAT_DRAFT);
		this.saveDraft(session.id, draft);
		this.autoSend.add(session.id);
		this.upsertSession(session);
		this.selectSession(session);
		return true;
	}

	/** Whether the session's draft should be sent right away (asked once, by its composer). */
	takeAutoSend(sessionId: string): boolean {
		return this.autoSend.delete(sessionId);
	}

	// ---- sessions ----------------------------------------------------------------------

	private upsertSession(session: SessionSummary): void {
		this.set((s) => {
			const list = s.sessions[session.workspaceId] ?? [];
			const rest = list.filter((x) => x.id !== session.id);
			return { sessions: { ...s.sessions, [session.workspaceId]: [session, ...rest] } };
		});
	}

	selectSession(session: SessionSummary): void {
		this.set((s) => ({
			scheduledTasksOpen: false,
			selectedWorkspaceId: session.workspaceId,
			selectedSessionId: session.id,
			newChat: undefined,
			expanded: { ...s.expanded, [session.workspaceId]: true },
		}));
	}

	findSession(sessionId: string | undefined): SessionSummary | undefined {
		if (!sessionId) return undefined;
		for (const list of Object.values(this.state.sessions)) {
			const found = list?.find((s) => s.id === sessionId);
			if (found) return found;
		}
		return this.chats.get(sessionId)?.chat.session;
	}

	/** Live controller for a session (created and subscribed on first use). */
	chat(session: SessionSummary): ChatController | undefined {
		let chat = this.chats.get(session.id);
		if (!chat) {
			const node = this.nodeOf(session.workspaceId);
			const client = this.clients.get(node);
			if (!client || this.state.nodes[node]?.connection !== "open") return undefined;
			chat = new ChatController(client, session, {
				onReplaced: (previousId, next) => this.onReplaced(previousId, next),
				onSettled: (c) => this.scheduleRefresh(c.workspaceId),
				onChange: () => this.set((s) => ({ chatsVersion: s.chatsVersion + 1 })),
				onError: (m) => this.toast("error", m),
			});
			this.chats.set(session.id, chat);
			this.chatNodes.set(chat, node);
			void chat.start();
		}
		this.touch(session.id);
		return chat;
	}

	/** Live chat state for sidebar badges, when the session is subscribed. */
	liveChat(sessionId: string): ChatController | undefined {
		return this.chats.get(sessionId);
	}

	private touch(sessionId: string): void {
		this.recent = [sessionId, ...this.recent.filter((id) => id !== sessionId)];
		if (this.recent.length <= MAX_LIVE_CHATS) return;
		for (const id of [...this.recent].reverse()) {
			if (this.recent.length <= MAX_LIVE_CHATS) break;
			const chat = this.chats.get(id);
			if (id === this.state.selectedSessionId || chat?.busy) continue;
			this.dropChat(id);
		}
	}

	private dropChat(sessionId: string): void {
		this.chats.get(sessionId)?.dispose();
		this.chats.delete(sessionId);
		this.recent = this.recent.filter((id) => id !== sessionId);
	}

	private onReplaced(previousId: string, session: SessionSummary): void {
		const chat = this.chats.get(previousId);
		if (chat) {
			this.chats.delete(previousId);
			this.chats.set(session.id, chat);
			this.recent = this.recent.map((id) => (id === previousId ? session.id : id));
		}
		this.upsertSession(session);
		if (this.state.selectedSessionId === previousId) this.set({ selectedSessionId: session.id });
		this.scheduleRefresh(session.workspaceId);
	}

	async closeSession(session: SessionSummary, force = false): Promise<void> {
		const result = await this.callWith(this.clientFor(session.workspaceId), "关闭会话", (c) =>
			c.request("session.close", { sessionId: session.id, force }),
		);
		if (!result) return;
		this.dropChat(session.id);
		if (this.state.selectedSessionId === session.id) this.set({ selectedSessionId: undefined });
		await this.refreshSessions(session.workspaceId);
	}

	/**
	 * Delete a session (the host moves its file to `~/.pier/trash/sessions`). `force` aborts a
	 * running agent first. Resolves to whether it was deleted.
	 */
	async deleteSession(session: SessionSummary, force = false): Promise<boolean> {
		const result = await this.callWith(this.clientFor(session.workspaceId), "删除会话", (c) =>
			c.request("session.delete", { workspaceId: session.workspaceId, sessionId: session.id, force }),
		);
		if (!result) return false;
		this.dropChat(session.id);
		this.drafts.delete(session.id);
		this.autoSend.delete(session.id);
		this.set((s) => ({
			sessions: {
				...s.sessions,
				[session.workspaceId]: (s.sessions[session.workspaceId] ?? []).filter((x) => x.id !== session.id),
			},
			...(s.selectedSessionId === session.id ? { selectedSessionId: undefined } : {}),
		}));
		await this.refreshSessions(session.workspaceId);
		return true;
	}

	async renameSession(session: SessionSummary, name: string): Promise<void> {
		const result = await this.callWith(this.clientFor(session.workspaceId), "重命名", (c) =>
			c.request("session.rename", { sessionId: session.id, name }),
		);
		if (result) this.upsertSession(result.session);
	}

	/** Whether the computer of a workspace can archive and bulk-clean sessions (protocol 1.14). */
	canArchiveSessions(workspaceId: string): boolean {
		return hostCanArchiveSessions(this.state.nodes[this.nodeOf(workspaceId)]?.hostInfo);
	}

	/** Archive or unarchive a session; archiving the open session returns home. Resolves to whether it worked. */
	async archiveSession(session: SessionSummary, archived: boolean): Promise<boolean> {
		const result = await this.callWith(this.clientFor(session.workspaceId), archived ? "归档会话" : "取消归档", (c) =>
			c.request("session.archive", { workspaceId: session.workspaceId, sessionId: session.id, archived }),
		);
		if (!result) return false;
		this.set((s) => {
			const list = s.sessions[session.workspaceId];
			const next = list?.map((x) => {
				if (x.id !== session.id) return x;
				const { archived: _previous, ...rest } = x;
				return archived ? { ...rest, archived: true } : rest;
			});
			return {
				...(next ? { sessions: { ...s.sessions, [session.workspaceId]: next } } : {}),
				...(archived && s.selectedSessionId === session.id ? { selectedSessionId: undefined } : {}),
			};
		});
		return true;
	}

	/**
	 * Archive or delete many sessions of a workspace (`session.cleanup`). With `dryRun` only
	 * reports what would happen and rejects with the host's error; otherwise errors are toasted
	 * and resolve to undefined.
	 */
	async cleanupSessions(
		workspaceId: string,
		request: SessionCleanupRequest,
		dryRun = false,
	): Promise<SessionCleanupResult | undefined> {
		const client = this.clientFor(workspaceId);
		const params = { workspaceId, ...request, ...(dryRun ? { dryRun: true } : {}) };
		if (dryRun) {
			if (!client) throw new Error("尚未连接到 Pier Host");
			return client.request("session.cleanup", params);
		}
		const label = request.action === "archive" ? "归档会话" : "删除会话";
		const result = await this.callWith(client, label, (c) => c.request("session.cleanup", params));
		if (!result) return undefined;
		if (request.action === "delete") {
			const deleted = new Set(result.sessionIds);
			for (const id of deleted) {
				this.dropChat(id);
				this.drafts.delete(id);
				this.autoSend.delete(id);
			}
			this.set((s) => ({
				sessions: {
					...s.sessions,
					[workspaceId]: (s.sessions[workspaceId] ?? []).filter((x) => !deleted.has(x.id)),
				},
				...(s.selectedSessionId && deleted.has(s.selectedSessionId) ? { selectedSessionId: undefined } : {}),
			}));
		}
		await this.refreshSessions(workspaceId);
		const verb = request.action === "archive" ? "归档" : "删除";
		const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 个运行中或被占用的会话` : "";
		this.toast("info", `已${verb} ${result.sessionIds.length} 个会话${skipped}`);
		return result;
	}

	/** Fork into a new session and open it. Resolves to whether it succeeded. */
	async forkSession(session: SessionSummary, entryId: string): Promise<boolean> {
		const result = await this.callWith(this.clientFor(session.workspaceId), "分叉会话", (c) =>
			c.request("session.fork", { sessionId: session.id, entryId }),
		);
		if (!result) return false;
		if (result.selectedText) this.saveDraft(result.session.id, { text: result.selectedText, images: [] });
		this.upsertSession(result.session);
		this.selectSession(result.session);
		return true;
	}

	// ---- drafts ------------------------------------------------------------------------

	draft(sessionId: string): Draft {
		return this.drafts.get(sessionId) ?? { text: "", images: [] };
	}

	saveDraft(sessionId: string, draft: Draft): void {
		if (!draft.text && !draft.images.length) this.drafts.delete(sessionId);
		else this.drafts.set(sessionId, draft);
	}

	// ---- updates -----------------------------------------------------------------------

	private onUpdateStatus(status: UpdateStatus): void {
		const announce =
			status.state === "available" &&
			status.version &&
			status.version !== this.announcedUpdate &&
			this.state.settings !== "about";
		this.set({ update: status });
		if (announce && status.version) {
			this.announcedUpdate = status.version;
			this.toast("info", `Pier v${status.version} 已发布，可在左下角的更新入口或“设置 → 关于与更新”中安装`);
		}
	}

	// ---- settings screen ---------------------------------------------------------------

	openSettings(section: SettingsSection = "general", node?: string): void {
		if (section === "about" && this.state.update.version) this.announcedUpdate = this.state.update.version;
		if (node !== undefined) this.setSettingsNode(node);
		this.set({ settings: section, scheduledTasksOpen: false });
		if (section === "models" || section === "account") void this.loadProviders();
	}

	closeSettings(): void {
		this.set({ settings: undefined, scheduledTasksOpen: false });
	}

	openScheduledTasks(): void {
		this.set({ settings: undefined, scheduledTasksOpen: true, filePreview: undefined });
		for (const node of this.clients.keys()) void this.loadTasks(node);
	}

	async loadTasks(node: string): Promise<void> {
		const client = this.openClient(node);
		if (!client || !hostSupportsScheduledTasks(client.host)) return;
		const seq = (this.taskLoadSeq.get(node) ?? 0) + 1;
		this.taskLoadSeq.set(node, seq);
		try {
			const [{ tasks }, { runs }] = await Promise.all([client.request("task.list"), client.request("task.runs")]);
			if (this.clients.get(node) === client && this.taskLoadSeq.get(node) === seq)
				this.set((s) => ({ taskData: { ...s.taskData, [node]: { tasks, runs } } }));
		} catch (error) {
			if (this.clients.get(node) === client && this.taskLoadSeq.get(node) === seq)
				this.set((s) => ({
					taskData: {
						...s.taskData,
						[node]: {
							tasks: s.taskData[node]?.tasks ?? [],
							runs: s.taskData[node]?.runs ?? [],
							error: errorText(error),
						},
					},
				}));
		}
	}

	async requestTask<M extends Extract<MethodName, `task.${string}`>>(
		node: string,
		method: M,
		params: MethodParams<M>,
	): Promise<MethodResult<M>> {
		const client = this.openClient(node);
		if (!client || this.state.nodes[node]?.connection !== "open") throw new Error(`${this.nodeName(node)} 未连接`);
		if (!hostSupportsScheduledTasks(client.host)) throw new Error("请先更新这台电脑上的 Pier，以使用定时任务");
		const result = await client.request(method, params);
		await this.loadTasks(node);
		return result;
	}

	async openTaskRun(node: string, run: ScheduledTaskRun): Promise<void> {
		if (!run.sessionId) throw new Error("本次运行尚未创建会话");
		const client = this.openClient(node);
		if (!client || this.state.nodes[node]?.connection !== "open") throw new Error(`${this.nodeName(node)} 未连接`);
		const { session } = await client.request("session.open", {
			workspaceId: run.workspaceId,
			sessionId: run.sessionId,
		});
		await this.requestTask(node, "task.readRun", { runId: run.id });
		this.upsertSession(session);
		this.selectSession(session);
	}

	/**
	 * Choose the computer whose Pier the settings screen manages. Its settings are read afresh
	 * ("synced"); a sign-in running on the previous computer is cancelled.
	 */
	setSettingsNode(node: string): void {
		const target = node === LOCAL_NODE || this.state.peers.some((p) => p.id === node) ? node : LOCAL_NODE;
		if (target === this.state.settingsNode) return;
		if (this.state.auth) void this.cancelLogin();
		this.set((s) => ({
			settingsNode: target,
			settingsSync: s.settingsSync + 1,
			settingsSyncing: false,
			settingsSyncedAt: undefined,
			providers: target === LOCAL_NODE ? s.localProviders : undefined,
			extensionProgress: undefined,
		}));
		if (target !== LOCAL_NODE && this.state.nodes[target]?.connection !== "open") this.retryNode(target);
		else void this.loadProviders(target);
	}

	/** Whether the settings screen can manage a page on the chosen computer; the reason when not. */
	settingsBlocker(page: SettingsSection): string | undefined {
		const node = this.state.settingsNode;
		if (node === LOCAL_NODE) return undefined;
		return remotePageBlocker(page, this.nodeName(node), this.state.nodes[node]?.hostInfo);
	}

	/**
	 * Read the managed computer's settings again: its Pier's info (versions, configuration
	 * directory), providers and workspaces; the pages on screen reload everything else. A paired
	 * computer that is offline is reconnected first (the pages load once it is back).
	 */
	async syncSettings(): Promise<void> {
		const node = this.state.settingsNode;
		const name = node === LOCAL_NODE ? "本机" : this.nodeName(node);
		const client = this.openClient(node);
		if (!client) {
			if (node !== LOCAL_NODE) {
				this.retryNode(node);
				this.toast("warning", `${name} 暂时无法连接，正在重试；连接后会自动同步设置`);
			} else {
				this.toast("error", `同步失败：${this.settingsOffline().message}`);
			}
			return;
		}
		if (this.state.settingsSyncing) return;
		this.set((s) => ({ settingsSyncing: true, settingsSync: s.settingsSync + 1 }));
		const current = () => this.state.settingsNode === node && this.clients.get(node) === client;
		try {
			const [info, providers] = await Promise.all([
				client.request("host.info"),
				this.loadProviders(node, true),
				this.loadWorkspaces(node),
			]);
			if (!current()) return;
			this.patchNode(node, { hostInfo: info });
			if (providers) this.toast("info", `已同步 ${name} 的 Pier 设置`);
		} catch (error) {
			if (current()) this.toast("error", `同步 ${name} 的设置失败：${errorText(error)}`);
		} finally {
			if (this.state.settingsNode === node) this.set({ settingsSyncing: false });
		}
	}

	async checkForUpdates(): Promise<UpdateStatus> {
		const request = ++this.updateRequest;
		try {
			const status = await this.bridge.updates.check();
			if (request === this.updateRequest) this.set({ update: status });
			return this.state.update;
		} catch (error) {
			this.toast("error", `检查更新失败：${errorText(error)}`);
			return this.state.update;
		}
	}

	async cancelUpdateCheck(): Promise<void> {
		const request = ++this.updateRequest;
		try {
			const status = await this.bridge.updates.cancelCheck();
			if (request === this.updateRequest) this.set({ update: status });
		} catch (error) {
			this.toast("error", `取消检查失败：${errorText(error)}`);
		}
	}

	/** Download, install, and relaunch. The updater reports failures through its status. */
	async installUpdate(): Promise<void> {
		try {
			await this.bridge.updates.install();
		} catch (error) {
			if (this.state.update.state !== "error") this.toast("error", errorText(error));
		}
	}

	async setUpdateAutoCheck(enabled: boolean): Promise<void> {
		const request = ++this.updateRequest;
		try {
			const status = await this.bridge.updates.setAutoCheck(enabled);
			if (request === this.updateRequest) this.set({ update: status });
		} catch (error) {
			this.toast("error", `保存更新设置失败：${errorText(error)}`);
		}
	}

	async setUpdateMirror(prefix: string): Promise<boolean> {
		const request = ++this.updateRequest;
		try {
			const status = await this.bridge.updates.setMirror(prefix);
			if (request !== this.updateRequest) return true;
			this.set({ update: status });
			void this.checkForUpdates();
			return true;
		} catch (error) {
			this.toast("error", `保存更新线路失败：${errorText(error)}`);
			return false;
		}
	}

	/**
	 * Sessions on a computer (this one by default) that are working or waiting for an answer;
	 * installing an update there stops them.
	 */
	async busySessionCount(node = LOCAL_NODE): Promise<number> {
		const client = this.clients.get(node);
		if (!client) return 0;
		const lists = await Promise.all(
			(this.state.nodes[node]?.workspaces ?? []).map((w) =>
				client.request("session.list", { workspaceId: w.id }).then(
					(r) => r.sessions,
					() => this.state.sessions[w.id] ?? [],
				),
			),
		);
		return lists
			.flat()
			.filter((s) => s.state === "streaming" || s.state === "retrying" || s.state === "compacting" || s.pendingUi)
			.length;
	}

	// ---- updates on paired computers ---------------------------------------------------

	private patchPeerUpdate(node: string, patch: Partial<PeerUpdateEntry>): void {
		this.set((s) => {
			const entry: PeerUpdateEntry = { ...s.peerUpdates[node], ...patch };
			for (const key of Object.keys(patch) as Array<keyof PeerUpdateEntry>) {
				if (patch[key] === undefined) delete entry[key];
			}
			return { peerUpdates: { ...s.peerUpdates, [node]: entry } };
		});
	}

	private onPeerUpdateStatus(node: string, status: AppUpdateStatus): void {
		// A download or verification failure there leaves Pier running: report it right away.
		const failed = status.state === "error" && this.state.peerUpdates[node]?.installing;
		this.patchPeerUpdate(node, { status, ...(failed ? { installing: undefined } : {}) });
		if (failed) this.toast("error", `${this.nodeName(node)}：${status.error ?? "更新失败"}`);
	}

	/** The open connection to a paired computer, or undefined while it is offline. */
	private openPeerClient(node: string): PierClient | undefined {
		const client = this.clients.get(node);
		return node !== LOCAL_NODE && client && this.state.nodes[node]?.connection === "open" ? client : undefined;
	}

	/**
	 * Read Pier's updater state on a paired computer (after every (re)connect), and announce the
	 * result of an install this computer started there.
	 */
	async loadPeerUpdate(node: string): Promise<void> {
		const client = this.openPeerClient(node);
		if (!client) return;
		const info = this.state.nodes[node]?.hostInfo;
		const installing = this.state.peerUpdates[node]?.installing;
		if (installing && info && info.version !== installing.from) {
			this.patchPeerUpdate(node, { installing: undefined });
			this.toast("info", `${this.nodeName(node)} 已更新到 Pier v${info.version}`);
		}
		if (!hostUpdatesRemotely(info)) {
			this.patchPeerUpdate(node, { tooOld: true, status: undefined });
			return;
		}
		try {
			const status = await client.request("update.status");
			if (this.clients.get(node) !== client) return;
			this.patchPeerUpdate(node, { status, tooOld: undefined });
			// Back on the old version without installing: the install failed there.
			if (installing && info?.version === installing.from && status.state === "error") {
				this.patchPeerUpdate(node, { installing: undefined });
				this.toast("error", `${this.nodeName(node)}：${status.error ?? "更新失败"}`);
			}
		} catch {
			// Transient; the next reconnect reads it again.
		}
	}

	/** Check for a new Pier release on a paired computer. */
	async checkPeerUpdate(node: string): Promise<void> {
		const client = this.openPeerClient(node);
		if (!client || this.state.peerUpdates[node]?.busy) return;
		this.patchPeerUpdate(node, { busy: "check" });
		try {
			const status = await client.request("update.check", {}, { timeoutMs: 120_000 });
			this.patchPeerUpdate(node, { status });
			if (status.state === "error") this.toast("error", `${this.nodeName(node)}：${status.error ?? "检查更新失败"}`);
		} catch (error) {
			this.toast("error", `${this.nodeName(node)} 检查更新失败：${errorText(error)}`);
		} finally {
			this.patchPeerUpdate(node, { busy: undefined });
		}
	}

	/**
	 * Install the newest Pier release on a paired computer; Pier restarts there, and this
	 * computer reconnects once it is back.
	 */
	async installPeerUpdate(node: string): Promise<void> {
		const client = this.openPeerClient(node);
		if (!client || this.state.peerUpdates[node]?.busy) return;
		const from = this.state.nodes[node]?.hostInfo?.version ?? "";
		const name = this.nodeName(node);
		this.patchPeerUpdate(node, { busy: "install" });
		try {
			const status = await client.request("update.install", {}, { timeoutMs: 120_000 });
			const started = status.state === "downloading" || status.state === "installing";
			this.patchPeerUpdate(node, {
				status,
				...(started ? { installing: { from, ...(status.version ? { to: status.version } : {}) } } : {}),
			});
			if (started) {
				this.toast(
					"info",
					`正在更新 ${name}${status.version ? ` 到 Pier v${status.version}` : ""}，完成后会自动重新连接`,
				);
			} else if (status.state === "upToDate") {
				this.toast("info", `${name} 的 Pier v${status.currentVersion} 已是最新版本`);
			} else if (status.state === "error") {
				this.toast("error", `${name}：${status.error ?? "更新失败"}`);
			}
		} catch (error) {
			this.toast("error", `${name} 更新失败：${errorText(error)}`);
		} finally {
			this.patchPeerUpdate(node, { busy: undefined });
		}
	}

	// ---- misc --------------------------------------------------------------------------

	logs(): Promise<string[]> {
		return this.bridge.logs();
	}

	onLog(listener: (line: string) => void): () => void {
		return this.bridge.onLog(listener);
	}

	pickDirectory(): Promise<string | null> {
		return this.bridge.pickDirectory();
	}

	/** Ask where to save a download named `name` on this computer; null when cancelled. */
	saveLocalFile(name: string): Promise<LocalFileSink | null> {
		return this.bridge.saveFile(name);
	}

	openExternal(url: string): void {
		void this.bridge.openExternal(url);
	}

	/** Whether local paths can be shown in the system file manager (desktop app only). */
	get canRevealPaths(): boolean {
		return Boolean(this.bridge.revealPath) && this.isLocalNode;
	}

	revealPath(path: string): void {
		const reveal = this.bridge.revealPath;
		if (!reveal) return;
		reveal(path).catch((error: unknown) =>
			this.toast("error", `无法在文件管理器中显示：${error instanceof Error ? error.message : String(error)}`),
		);
	}

	quit(): void {
		void this.bridge.quit();
	}
}

export const StoreContext = createContext<PierStore | null>(null);

export function useStore(): PierStore {
	const store = useContext(StoreContext);
	if (!store) throw new Error("PierStore missing");
	return store;
}

export function useAppState<T>(selector: (state: AppState) => T): T {
	const store = useStore();
	return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

/**
 * Whether the main window may manage the shown computer: add and remove workspaces, change
 * approval policies, and edit files. Always true for this computer; for a paired computer,
 * when its host trusts paired devices (protocol 1.10 or later).
 */
export function useCanManageNode(): boolean {
	return useAppState((s) => s.node === LOCAL_NODE || hostAllowsRemoteManagement(s.hostInfo));
}

/** Whether this computer may manage the computer a workspace belongs to. */
export function useCanManageWorkspace(workspaceId: string | undefined): boolean {
	return useAppState((s) => {
		const node = (workspaceId && s.workspaceNodes[workspaceId]) || s.node;
		return node === LOCAL_NODE || hostAllowsRemoteManagement(s.nodes[node]?.hostInfo);
	});
}

/** Whether the computer of a workspace can archive and bulk-clean sessions (protocol 1.14). */
export function useCanArchiveSessions(workspaceId: string | undefined): boolean {
	return useAppState((s) => {
		const node = (workspaceId && s.workspaceNodes[workspaceId]) || s.node;
		return hostCanArchiveSessions(s.nodes[node]?.hostInfo);
	});
}

/** This computer and every paired computer, with their connection and workspaces. */
export function useComputers(): ComputerInfo[] {
	const store = useStore();
	const nodes = useAppState((s) => s.nodes);
	const peers = useAppState((s) => s.peers);
	const localName = useAppState((s) => s.localHostInfo?.hostName);
	const hostReady = useAppState((s) => s.host.state === "ready");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list is derived from these.
	return useMemo(() => store.computers(), [store, nodes, peers, localName, hostReady]);
}

/** Whether any computer other than this one is paired (workspaces then show their computer). */
export function useHasPeers(): boolean {
	return useAppState((s) => s.peers.length > 0);
}

/** Workspaces of the computer the settings screen manages (for project-scoped settings). */
export function useSettingsWorkspaces(): WorkspaceInfo[] {
	return useAppState((s) => (s.nodes[s.settingsNode] ?? EMPTY_NODE).workspaces);
}

/** The computer the settings screen manages, and whether it can be reached. */
export interface SettingsTarget {
	node: string;
	name: string;
	local: boolean;
	/** Its Pier Host can be called right now. */
	online: boolean;
	connection: ClientState | "none";
	hostInfo?: HostInfo | undefined;
	connectError?: string | undefined;
	revoked: boolean;
}

export function useSettingsTarget(): SettingsTarget {
	const store = useStore();
	const node = useAppState((s) => s.settingsNode);
	const state = useAppState((s) => s.nodes[s.settingsNode] ?? EMPTY_NODE);
	const hostReady = useAppState((s) => s.host.state === "ready");
	const localConnection = useAppState((s) => s.localConnection);
	const peers = useAppState((s) => s.peers);
	const localName = useAppState((s) => s.localHostInfo?.hostName);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the name is derived from these.
	return useMemo(() => {
		const local = node === LOCAL_NODE;
		return {
			node,
			name: store.nodeName(node),
			local,
			online: hostReady && localConnection === "open" && (local || state.connection === "open"),
			connection: state.connection,
			hostInfo: state.hostInfo,
			connectError: state.connectError,
			revoked: state.revoked === true,
		};
	}, [store, node, state, hostReady, localConnection, peers, localName]);
}

const EMPTY_VIEW: ChatView | undefined = undefined;

export function useChatView(chat: ChatController | undefined): ChatView | undefined {
	return useSyncExternalStore(chat?.subscribe ?? noopSubscribe, chat ? chat.getView : () => EMPTY_VIEW);
}

function noopSubscribe(): () => void {
	return () => {};
}
