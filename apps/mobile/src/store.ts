import { ChatController, type ChatView } from "@pier/chat-state";
import {
	CLOSE_DEVICE_REVOKED,
	type ClientState,
	type ConnectionRoute,
	createSecureSocketFactory,
	type PairingPhase,
	PierClient,
	pairWithHost,
} from "@pier/client";
import { ChannelError, fromBase64Url, type KeyPair, PairingUriError, parsePairingUri, toBase64Url } from "@pier/crypto";
import {
	type AgentRuntimeId,
	type AgentRuntimeInfo,
	type ApprovalPolicy,
	type EventFrame,
	type ExtensionListResult,
	type ExtensionResourceInfo,
	type ExtensionScope,
	type ExtensionUpdateInfo,
	type HostDirectoryListing,
	type HostInfo,
	type HostStats,
	type MethodParams,
	type MethodResult,
	parseProtocolVersion,
	type ResourceMethod,
	type SessionRunState,
	type SessionSummary,
	type WorkspaceFileContent,
	type WorkspaceFilesResult,
	type WorkspaceFileWriteResult,
	type WorkspaceInfo,
} from "@pier/protocol";
import { createContext, useContext, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";
import { ChatCache } from "./chat-cache.ts";
import { loadHosts, type PairedHost, removeHost, saveHost } from "./hosts.ts";
import {
	defaultDeviceName,
	deviceFingerprint,
	deviceModel,
	devicePlatform,
	loadDeviceKey,
	loadDeviceName,
	saveDeviceName,
} from "./identity.ts";
import { RemoteTerminal } from "./terminal.ts";
import { peerConnectionFactory } from "./webrtc.ts";

export const APP_VERSION = "0.2.37";

/** Live session subscriptions kept for quick back-and-forth navigation. */
const MAX_LIVE_CHATS = 4;
/** Largest piece of a file sent or fetched per request. */
const TRANSFER_CHUNK = 512 * 1024;

/** Reads `length` bytes of a local file, in order (an upload source). */
export interface UploadSource {
	size: number;
	read: (length: number) => Uint8Array;
}

/** Receives a downloaded file's bytes in order. */
export interface DownloadSink {
	write: (bytes: Uint8Array) => void;
}

/** A short summary of an open terminal, for lists. */
export interface TerminalSummary {
	id: number;
	title: string;
	cwd: string;
	status: RemoteTerminal["status"];
}

export interface HostView {
	resourcesVersion?: number;
	hostId?: string;
	connection: ClientState | "none";
	/** Last connection problem, shown while (re)connecting. */
	error?: string;
	/** The host no longer knows this device (revoked or reset); pairing again is required. */
	revoked: boolean;
	info?: HostInfo;
	workspaces?: WorkspaceInfo[];
	sessions: Record<string, SessionSummary[] | undefined>;
	/** Which address the secure channel is using (direct connections). */
	address?: string;
	/** How the secure channel reaches the computer: directly, through a relay, or peer-to-peer. */
	route?: ConnectionRoute;
	/** Terminals opened on this computer from the phone, newest first. */
	terminals: TerminalSummary[];
}

export interface Toast {
	id: number;
	level: "info" | "error";
	message: string;
}

export interface MobileState {
	ready: boolean;
	hosts: PairedHost[];
	deviceName: string;
	fingerprint: string;
	/** The computer on screen (the last one opened). */
	host: HostView;
	/**
	 * Every computer with a live connection, by host id (the one on screen included). Computers
	 * stay connected in the background, so switching between them needs no reconnect.
	 */
	connections: Record<string, HostView>;
	chatsVersion: number;
	toast?: Toast;
}

const EMPTY_HOST: HostView = { connection: "none", revoked: false, sessions: {}, terminals: [] };

/** A live connection to one paired computer, with the session and terminal state it owns. */
interface HostConnection {
	readonly hostId: string;
	client: PierClient | undefined;
	readonly chats: Map<string, ChatController>;
	recent: string[];
	retryTimer: ReturnType<typeof setTimeout> | undefined;
	retryAttempt: number;
	readonly refreshTimers: Map<string, ReturnType<typeof setTimeout>>;
	readonly terminals: Map<number, RemoteTerminal>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** User-facing text for pairing failures. */
export function pairingErrorText(error: unknown): string {
	if (error instanceof PairingUriError) return `二维码无效：${error.message}`;
	if (error instanceof ChannelError) {
		switch (error.code) {
			case "PAIRING_INVALID":
				return "配对码无效或已过期，请在电脑上重新生成二维码。";
			case "PAIRING_REJECTED":
				return "电脑上拒绝了这次配对。";
			case "PAIRING_TIMEOUT":
				return "电脑上没有及时确认，请重试。";
			case "BAD_HANDSHAKE":
				return `安全握手失败：${error.message}`;
			default:
				return error.message;
		}
	}
	return `无法连接到电脑：${errorText(error)}。请确认手机与电脑在同一网络（不在同一网络时电脑需开启中继），且电脑上已开启远程访问。`;
}

export class MobileStore {
	private state: MobileState = {
		ready: false,
		hosts: [],
		deviceName: "",
		fingerprint: "",
		host: EMPTY_HOST,
		connections: {},
		chatsVersion: 0,
	};
	private readonly listeners = new Set<() => void>();
	private keyPair: KeyPair | undefined;
	/** Live connections by host id; they stay open while other computers are on screen. */
	private readonly connections = new Map<string, HostConnection>();
	/** The computer on screen, which the screen-facing methods below act on. */
	private activeHostId: string | undefined;
	private nextToastId = 1;
	private readonly drafts = new Map<string, string>();
	/** Sessions seen before, to show at once and resume without downloading them again. */
	private readonly chatCache = new ChatCache();
	private nextTerminalId = 1;

	getState = (): MobileState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private set(patch: Partial<MobileState> | ((state: MobileState) => Partial<MobileState>)): void {
		const next = typeof patch === "function" ? patch(this.state) : patch;
		this.state = { ...this.state, ...next };
		for (const listener of [...this.listeners]) listener();
	}

	/** Update the view of a connected computer (and the on-screen view when it is that computer). */
	private setView(hostId: string, patch: Partial<HostView> | ((host: HostView) => Partial<HostView>)): void {
		if (!this.connections.has(hostId)) return;
		this.set((s) => {
			const current = s.connections[hostId] ?? { ...EMPTY_HOST, hostId };
			const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
			return {
				connections: { ...s.connections, [hostId]: next },
				...(this.activeHostId === hostId ? { host: next } : {}),
			};
		});
	}

	/** The connection of the computer on screen. */
	private get active(): HostConnection | undefined {
		return this.activeHostId ? this.connections.get(this.activeHostId) : undefined;
	}

	/** The client of the computer on screen. */
	private get client(): PierClient | undefined {
		return this.active?.client;
	}

	async init(): Promise<void> {
		if (this.state.ready) return;
		const [keyPair, deviceName, hosts] = await Promise.all([loadDeviceKey(), loadDeviceName(), loadHosts()]);
		this.keyPair = keyPair;
		this.set({ ready: true, hosts, deviceName, fingerprint: deviceFingerprint(keyPair) });
	}

	toast(level: Toast["level"], message: string): void {
		const id = this.nextToastId++;
		this.set({ toast: { id, level, message } });
		setTimeout(
			() => {
				if (this.state.toast?.id === id) this.set({ toast: undefined });
			},
			level === "error" ? 6000 : 3500,
		);
	}

	dismissToast(): void {
		this.set({ toast: undefined });
	}

	async setDeviceName(name: string): Promise<void> {
		const trimmed = name.trim() || defaultDeviceName();
		await saveDeviceName(trimmed);
		this.set({ deviceName: trimmed });
	}

	// ---- pairing -----------------------------------------------------------------------

	/** Pair from a scanned / pasted `pier://pair?...` link. Resolves to the host id. */
	async pair(uri: string, onPhase?: (phase: PairingPhase) => void): Promise<string> {
		const keyPair = this.keyPair;
		if (!keyPair) throw new Error("App is still starting");
		const info = parsePairingUri(uri);
		const model = deviceModel();
		const outcome = await pairWithHost({
			info,
			deviceKeyPair: keyPair,
			device: {
				name: this.state.deviceName || defaultDeviceName(),
				platform: devicePlatform(),
				...(model ? { model } : {}),
				appVersion: APP_VERSION,
			},
			...(onPhase ? { onPhase } : {}),
		});
		const host: PairedHost = {
			hostId: outcome.hostId,
			hostName: outcome.hostName,
			hostPublicKey: toBase64Url(outcome.hostPublicKey),
			addresses: outcome.addresses,
			...(outcome.relays.length ? { relays: outcome.relays } : {}),
			deviceId: outcome.deviceId,
			pairedAt: new Date().toISOString(),
		};
		const hosts = [host, ...this.state.hosts.filter((h) => h.hostId !== host.hostId)];
		await saveHost(host, hosts);
		this.set({ hosts });
		// A re-pair clears the revoked state (and may change addresses); connect afresh right away.
		this.closeConnection(host.hostId);
		this.openHost(host.hostId);
		return host.hostId;
	}

	async forgetHost(hostId: string): Promise<void> {
		this.closeConnection(hostId);
		this.chatCache.removeHost(hostId);
		const hosts = this.state.hosts.filter((h) => h.hostId !== hostId);
		await removeHost(hostId, hosts);
		this.set({ hosts });
	}

	/**
	 * Replace the addresses used to reach a paired computer (its IP changed) and, if it is
	 * connected, reconnect through them right away. The pinned host key is unchanged, so a
	 * different computer at the new address fails the handshake.
	 */
	async setHostAddresses(hostId: string, addresses: string[], relays?: string[]): Promise<void> {
		const current = this.state.hosts.find((h) => h.hostId === hostId);
		if (!current) throw new Error("这台电脑已不在列表中");
		const nextRelays = relays ?? current.relays ?? [];
		if (!addresses.length && !nextRelays.length) throw new Error("至少需要一个地址或中继服务器");
		const { relays: _old, ...rest } = current;
		const updated: PairedHost = {
			...rest,
			addresses: [...addresses],
			...(nextRelays.length ? { relays: [...nextRelays] } : {}),
		};
		const hosts = this.state.hosts.map((h) => (h.hostId === hostId ? updated : h));
		await saveHost(updated, hosts);
		this.set({ hosts });
		if (this.connections.has(hostId)) {
			const onScreen = this.activeHostId === hostId;
			this.closeConnection(hostId);
			if (onScreen) this.openHost(hostId);
			else this.startConnection(updated);
		}
	}

	private async updateHost(hostId: string, patch: Partial<PairedHost>): Promise<void> {
		const current = this.state.hosts.find((h) => h.hostId === hostId);
		if (!current) return;
		const updated = { ...current, ...patch };
		const hosts = this.state.hosts.map((h) => (h.hostId === hostId ? updated : h));
		this.set({ hosts });
		await saveHost(updated, hosts).catch(() => undefined);
	}

	// ---- connection --------------------------------------------------------------------

	get activeClient(): PierClient | undefined {
		return this.client;
	}

	/**
	 * Show a paired host: connect to it unless it already has a live connection. Other
	 * computers stay connected in the background, so switching back to them is instant.
	 */
	openHost(hostId: string): void {
		const host = this.state.hosts.find((h) => h.hostId === hostId);
		if (!host || !this.keyPair) return;
		const existing = this.connections.get(hostId);
		const view = this.state.connections[hostId];
		// A revoked or given-up connection starts over (a revoked one fails again until re-paired).
		if (existing && !view?.revoked && existing.client && existing.client.state === "closed" && !existing.retryTimer) {
			this.closeConnection(hostId);
		}
		this.activeHostId = hostId;
		if (!this.connections.has(hostId)) this.startConnection(host);
		this.set((s) => ({ host: s.connections[hostId] ?? { ...EMPTY_HOST, hostId } }));
	}

	/** Disconnect a computer and drop its live sessions and terminals. */
	disconnectHost(hostId: string): void {
		this.closeConnection(hostId);
	}

	private startConnection(host: PairedHost): void {
		const conn: HostConnection = {
			hostId: host.hostId,
			client: undefined,
			chats: new Map(),
			recent: [],
			retryTimer: undefined,
			retryAttempt: 0,
			refreshTimers: new Map(),
			terminals: new Map(),
		};
		this.connections.set(host.hostId, conn);
		this.set((s) => ({
			connections: {
				...s.connections,
				[host.hostId]: { ...EMPTY_HOST, hostId: host.hostId, connection: "connecting" },
			},
		}));
		this.connect(conn, host);
	}

	/** Whether `conn` is still the live connection for its computer. */
	private isLive(conn: HostConnection): boolean {
		return this.connections.get(conn.hostId) === conn;
	}

	private connect(conn: HostConnection, host: PairedHost): void {
		const keyPair = this.keyPair;
		if (!keyPair || !this.isLive(conn)) return;
		const p2p = peerConnectionFactory();
		const client = new PierClient({
			url: `pier://${host.hostId}`,
			client: { name: "pier-mobile", version: APP_VERSION, platform: Platform.OS },
			coalesceMs: 50,
			requestTimeoutMs: 60_000,
			heartbeatMs: 25_000,
			reconnect: { initialDelayMs: 500, maxDelayMs: 10_000 },
			createWebSocket: createSecureSocketFactory({
				addresses: host.addresses,
				...(host.relays?.length ? { relays: host.relays } : {}),
				...(p2p ? { p2p: { createPeerConnection: p2p } } : {}),
				hostPublicKey: fromBase64Url(host.hostPublicKey),
				deviceKeyPair: keyPair,
				onRoute: (route) => {
					if (current()) this.setView(conn.hostId, { route });
				},
				onConnected: (address) => {
					if (!current()) return;
					this.setView(conn.hostId, { address });
					if (host.addresses[0] !== address) {
						void this.updateHost(host.hostId, {
							addresses: [address, ...host.addresses.filter((a) => a !== address)],
						});
					}
				},
			}),
		});
		const current = () => conn.client === client && this.isLive(conn);
		conn.client = client;
		client.onState((state) => {
			if (!current()) return;
			this.setView(conn.hostId, state === "open" ? { connection: state, error: undefined } : { connection: state });
			if (state !== "open") this.loseTerminals(conn, `与 ${host.hostName} 的连接已断开，终端已关闭`);
			if (state === "open") {
				conn.retryAttempt = 0;
				void this.updateHost(host.hostId, { lastConnectedAt: new Date().toISOString() });
				void this.loadWorkspacesOf(conn);
			}
		});
		client.onEvent((frame) => {
			if (current() && !frame.sessionId) this.onHostEvent(conn, frame);
		});
		client.onError((error) => {
			if (!current()) return;
			if (client.terminalClose?.code === CLOSE_DEVICE_REVOKED) this.markRevoked(conn);
			else this.setView(conn.hostId, { error: errorText(error) });
		});
		client
			.connect()
			.then((hello) => {
				if (current()) this.setView(conn.hostId, { info: hello.host });
			})
			.catch((error: unknown) => {
				if (!current()) return;
				if (client.terminalClose?.code === CLOSE_DEVICE_REVOKED) {
					this.markRevoked(conn);
					return;
				}
				// The host may simply be offline or asleep: keep trying while it stays connected.
				this.setView(conn.hostId, { connection: "reconnecting", error: errorText(error) });
				const delay = Math.min(15_000, 1000 * 2 ** conn.retryAttempt);
				conn.retryAttempt += 1;
				conn.retryTimer = setTimeout(() => {
					conn.retryTimer = undefined;
					if (current()) this.connect(conn, this.state.hosts.find((h) => h.hostId === conn.hostId) ?? host);
				}, delay);
			});
	}

	private markRevoked(conn: HostConnection): void {
		conn.client?.close();
		this.setView(conn.hostId, {
			revoked: true,
			connection: "closed",
			error: "这台设备已被电脑移除（或电脑重置了 Pier）。",
		});
	}

	/** Called when the app returns to the foreground: reconnect every computer right away. */
	onForeground(): void {
		for (const conn of this.connections.values()) this.reconnectNow(conn);
	}

	/** Called when the app leaves the foreground: keep open sessions on the phone for next time. */
	onBackground(): void {
		for (const conn of this.connections.values()) {
			for (const chat of conn.chats.values()) this.chatCache.put(conn.hostId, chat.chat);
		}
		this.chatCache.flush();
	}

	/** Retry the computer on screen right away. */
	retryNow(): void {
		const conn = this.active;
		if (conn) this.reconnectNow(conn);
	}

	private reconnectNow(conn: HostConnection): void {
		const client = conn.client;
		if (!client) return;
		if (client.state === "reconnecting") client.reconnectNow();
		else if (conn.retryTimer) {
			clearTimeout(conn.retryTimer);
			conn.retryTimer = undefined;
			conn.retryAttempt = 0;
			const host = this.state.hosts.find((h) => h.hostId === conn.hostId);
			if (host) this.connect(conn, host);
		}
	}

	/** Close a computer's connection and drop everything it owns. */
	private closeConnection(hostId: string): void {
		const conn = this.connections.get(hostId);
		if (!conn) return;
		this.connections.delete(hostId);
		if (conn.retryTimer) clearTimeout(conn.retryTimer);
		conn.retryTimer = undefined;
		for (const timer of conn.refreshTimers.values()) clearTimeout(timer);
		conn.refreshTimers.clear();
		for (const chat of conn.chats.values()) {
			this.chatCache.put(hostId, chat.chat);
			chat.dispose();
		}
		conn.chats.clear();
		conn.recent = [];
		for (const terminal of conn.terminals.values()) terminal.dispose();
		conn.terminals.clear();
		conn.client?.close();
		conn.client = undefined;
		this.set((s) => {
			const { [hostId]: _closed, ...connections } = s.connections;
			return {
				connections,
				...(this.activeHostId === hostId ? { host: { ...EMPTY_HOST, hostId } } : {}),
				chatsVersion: s.chatsVersion + 1,
			};
		});
	}

	private onHostEvent(conn: HostConnection, frame: EventFrame): void {
		const event = frame.event;
		if (
			event.type === "resources.changed" ||
			event.type === "extension.changed" ||
			event.type === "agentConfig.changed"
		) {
			const view = this.state.connections[conn.hostId];
			this.setView(conn.hostId, { resourcesVersion: (view?.resourcesVersion ?? 0) + 1 });
		} else if (event.type === "workspace.changed") void this.loadWorkspacesOf(conn);
		else if (event.type === "session.listChanged") this.scheduleRefresh(conn, String(event.workspaceId));
		else if (event.type === "session.activity") {
			const workspaceId = String(event.workspaceId);
			const sessionId = String(event.sessionId);
			const list = this.state.connections[conn.hostId]?.sessions[workspaceId];
			if (!list?.some((s) => s.id === sessionId)) {
				this.scheduleRefresh(conn, workspaceId);
				return;
			}
			const state = event.state as SessionRunState;
			const pendingUi = Number(event.pendingUi) || 0;
			this.setView(conn.hostId, (h) => ({
				sessions: {
					...h.sessions,
					[workspaceId]: list.map((s) => (s.id === sessionId ? { ...s, state, pendingUi, active: true } : s)),
				},
			}));
		} else if (event.type === "host.notice") {
			const message = String(event.message ?? "");
			const prefix = this.activeHostId === conn.hostId ? "" : `${this.hostName(conn.hostId)}：`;
			this.toast(event.level === "error" ? "error" : "info", prefix + message);
		} else if (event.type === "terminal.output" || event.type === "terminal.exit") {
			this.onTerminalEvent(conn, event);
		}
	}

	private hostName(hostId: string): string {
		return this.state.hosts.find((h) => h.hostId === hostId)?.hostName ?? "电脑";
	}

	async loadWorkspaces(): Promise<void> {
		const conn = this.active;
		if (conn) await this.loadWorkspacesOf(conn);
	}

	private async loadWorkspacesOf(conn: HostConnection): Promise<void> {
		const client = conn.client;
		if (!client) return;
		try {
			const { workspaces } = await client.request("workspace.list");
			if (conn.client !== client) return;
			this.setView(conn.hostId, { workspaces });
			await Promise.all(workspaces.map((w) => this.refreshSessionsOf(conn, w.id)));
		} catch (error) {
			if (conn.client === client && this.isLive(conn)) {
				const prefix = this.activeHostId === conn.hostId ? "" : `${this.hostName(conn.hostId)}：`;
				this.toast("error", `${prefix}加载工作区失败：${errorText(error)}`);
			}
		}
	}

	/** Reload a workspace's session list shortly (coalesces bursts of changes). */
	scheduleSessionsRefresh(workspaceId: string): void {
		const conn = this.active;
		if (conn) this.scheduleRefresh(conn, workspaceId);
	}

	private scheduleRefresh(conn: HostConnection, workspaceId: string): void {
		clearTimeout(conn.refreshTimers.get(workspaceId));
		conn.refreshTimers.set(
			workspaceId,
			setTimeout(() => {
				conn.refreshTimers.delete(workspaceId);
				void this.refreshSessionsOf(conn, workspaceId);
			}, 200),
		);
	}

	async refreshSessions(workspaceId: string): Promise<void> {
		const conn = this.active;
		if (conn) await this.refreshSessionsOf(conn, workspaceId);
	}

	private async refreshSessionsOf(conn: HostConnection, workspaceId: string): Promise<void> {
		const client = conn.client;
		if (!client) return;
		try {
			const { sessions } = await client.request("session.list", { workspaceId });
			if (conn.client !== client) return;
			this.setView(conn.hostId, (h) => ({ sessions: { ...h.sessions, [workspaceId]: sessions } }));
		} catch {
			// Transient; refreshed again on the next event or reconnect.
		}
	}

	/** Whether the connected computer speaks protocol `1.<minor>` or later. */
	private hostSpeaks(minor: number): boolean {
		const version = this.state.host.info ? parseProtocolVersion(this.state.host.info.protocolVersion) : undefined;
		return version !== undefined && (version.major > 1 || (version.major === 1 && version.minor >= minor));
	}

	/**
	 * Whether the connected computer lets this phone add workspaces (`workspace.add` and
	 * `host.listDirectories` are open to paired devices since protocol 1.10).
	 */
	canAddWorkspace(): boolean {
		return this.hostSpeaks(10);
	}

	/** Subdirectories of a directory on the connected computer (its home directory by default). */
	async listDirectories(path?: string): Promise<HostDirectoryListing> {
		const client = this.client;
		if (!client) throw new Error("尚未连接到电脑");
		return client.request("host.listDirectories", path ? { path } : {});
	}

	/** Add a directory of the connected computer as a workspace. Resolves to it, or `undefined` on failure. */
	async addWorkspace(path: string): Promise<WorkspaceInfo | undefined> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return undefined;
		try {
			const { workspace } = await client.request("workspace.add", { path });
			if (conn.client !== client) return workspace;
			this.setView(conn.hostId, (h) => ({
				workspaces: [...(h.workspaces ?? []).filter((w) => w.id !== workspace.id), workspace],
			}));
			void this.refreshSessionsOf(conn, workspace.id);
			return workspace;
		} catch (error) {
			if (conn.client === client) this.toast("error", `添加工作区失败：${errorText(error)}`);
			return undefined;
		}
	}

	/**
	 * Whether the connected computer lets this phone change or remove workspaces
	 * (`workspace.setPolicy` and `workspace.remove` are open to paired devices since protocol 1.10).
	 */
	canManageWorkspaces(): boolean {
		return this.hostSpeaks(10);
	}

	/** Change a workspace's tool approval policy. Resolves to whether it worked. */
	async setWorkspacePolicy(workspaceId: string, policy: ApprovalPolicy): Promise<boolean> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return false;
		try {
			const { workspace } = await client.request("workspace.setPolicy", { workspaceId, policy });
			if (conn.client === client) {
				this.setView(conn.hostId, (h) => ({
					workspaces: (h.workspaces ?? []).map((w) => (w.id === workspace.id ? workspace : w)),
				}));
			}
			return true;
		} catch (error) {
			if (conn.client === client) this.toast("error", `修改审批策略失败：${errorText(error)}`);
			return false;
		}
	}

	/**
	 * Remove a workspace from the computer's Pier. Its running sessions are closed; no files or
	 * session histories are deleted. Resolves to whether it worked.
	 */
	async removeWorkspace(workspaceId: string): Promise<boolean> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return false;
		try {
			await client.request("workspace.remove", { workspaceId });
		} catch (error) {
			if (conn.client === client) this.toast("error", `移除工作区失败：${errorText(error)}`);
			return false;
		}
		if (conn.client !== client) return true;
		for (const [id, chat] of conn.chats) {
			if (chat.workspaceId !== workspaceId) continue;
			this.chatCache.put(conn.hostId, chat.chat);
			chat.dispose();
			conn.chats.delete(id);
			conn.recent = conn.recent.filter((r) => r !== id);
			this.drafts.delete(id);
		}
		clearTimeout(conn.refreshTimers.get(workspaceId));
		conn.refreshTimers.delete(workspaceId);
		this.setView(conn.hostId, (h) => {
			const { [workspaceId]: _removed, ...sessions } = h.sessions;
			return { workspaces: (h.workspaces ?? []).filter((w) => w.id !== workspaceId), sessions };
		});
		return true;
	}

	/** Agent runtimes of the connected computer that can run sessions (none before protocol 1.22). */
	async availableRuntimes(): Promise<AgentRuntimeInfo[]> {
		const client = this.client;
		if (!client || !this.hostSpeaks(22)) return [];
		try {
			return (await client.request("runtime.list", {})).runtimes.filter((r) => r.available);
		} catch {
			return [];
		}
	}

	/** Put a new session at the top of its workspace's list on `conn`'s computer. */
	private addSession(conn: HostConnection, session: SessionSummary): void {
		const workspaceId = session.workspaceId;
		this.setView(conn.hostId, (h) => ({
			sessions: { ...h.sessions, [workspaceId]: [session, ...(h.sessions[workspaceId] ?? [])] },
		}));
	}

	async createSession(workspaceId: string, runtime?: AgentRuntimeId): Promise<SessionSummary | undefined> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return undefined;
		try {
			const { session } = await client.request("session.create", {
				workspaceId,
				...(runtime && runtime !== "pi" ? { runtime } : {}),
			});
			this.addSession(conn, session);
			return session;
		} catch (error) {
			this.toast("error", `新建会话失败：${errorText(error)}`);
			return undefined;
		}
	}

	findSession(sessionId: string): SessionSummary | undefined {
		for (const list of Object.values(this.state.host.sessions)) {
			const found = list?.find((s) => s.id === sessionId);
			if (found) return found;
		}
		return this.active?.chats.get(sessionId)?.chat.session;
	}

	/** Live controller for a session of the computer on screen (subscribed on first use). */
	chat(session: SessionSummary): ChatController | undefined {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return undefined;
		let chat = conn.chats.get(session.id);
		if (!chat) {
			const cached = this.chatCache.get(conn.hostId, session.id);
			chat = new ChatController(
				client,
				session,
				{
					onReplaced: (previousId, next) => {
						const existing = conn.chats.get(previousId);
						if (existing) {
							conn.chats.delete(previousId);
							conn.chats.set(next.id, existing);
						}
						this.scheduleRefresh(conn, next.workspaceId);
					},
					onSettled: (c) => {
						this.scheduleRefresh(conn, c.workspaceId);
						this.chatCache.put(conn.hostId, c.chat);
					},
					onChange: () => this.set((s) => ({ chatsVersion: s.chatsVersion + 1 })),
					onError: (message) => this.toast("error", message),
				},
				cached,
			);
			conn.chats.set(session.id, chat);
			void chat.start();
		}
		conn.recent = [session.id, ...conn.recent.filter((id) => id !== session.id)];
		while (conn.recent.length > MAX_LIVE_CHATS) {
			const id = conn.recent.pop();
			if (!id) break;
			this.dropChat(conn, id);
		}
		return chat;
	}

	/** Stop following a session on `conn`'s computer, keeping its state for next time unless `forget`. */
	private dropChat(conn: HostConnection, sessionId: string, forget = false): void {
		const chat = conn.chats.get(sessionId);
		if (forget) this.chatCache.remove(conn.hostId, sessionId);
		else if (chat) this.chatCache.put(conn.hostId, chat.chat);
		chat?.dispose();
		conn.chats.delete(sessionId);
		conn.recent = conn.recent.filter((id) => id !== sessionId);
	}

	/** Fork into a new session; the forked message becomes its draft. */
	async forkSession(sessionId: string, entryId: string): Promise<SessionSummary | undefined> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return undefined;
		try {
			const { session, selectedText } = await client.request("session.fork", { sessionId, entryId });
			if (selectedText) this.saveDraft(session.id, selectedText);
			this.addSession(conn, session);
			return session;
		} catch (error) {
			this.toast("error", `分叉会话失败：${errorText(error)}`);
			return undefined;
		}
	}

	/** Whether the connected computer can archive sessions (`session.archive`, protocol 1.14). */
	canArchive(): boolean {
		return this.hostSpeaks(14);
	}

	/** Archive or unarchive a session. Resolves to whether it worked. */
	async archiveSession(session: SessionSummary, archived: boolean): Promise<boolean> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return false;
		try {
			await client.request("session.archive", { workspaceId: session.workspaceId, sessionId: session.id, archived });
		} catch (error) {
			this.toast("error", `${archived ? "归档" : "取消归档"}失败：${errorText(error)}`);
			return false;
		}
		const workspaceId = session.workspaceId;
		this.setView(conn.hostId, (h) => ({
			sessions: {
				...h.sessions,
				[workspaceId]: (h.sessions[workspaceId] ?? []).map((s) => {
					if (s.id !== session.id) return s;
					const { archived: _previous, ...rest } = s;
					return archived ? { ...rest, archived: true } : rest;
				}),
			},
		}));
		this.scheduleRefresh(conn, workspaceId);
		return true;
	}

	/** Delete a session (moved to the computer's Pier trash). `force` aborts a running agent first. */
	async deleteSession(session: SessionSummary, force = false): Promise<boolean> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return false;
		try {
			await client.request("session.delete", { workspaceId: session.workspaceId, sessionId: session.id, force });
		} catch (error) {
			this.toast("error", `删除会话失败：${errorText(error)}`);
			return false;
		}
		this.dropChat(conn, session.id, true);
		this.drafts.delete(session.id);
		const workspaceId = session.workspaceId;
		this.setView(conn.hostId, (h) => ({
			sessions: { ...h.sessions, [workspaceId]: (h.sessions[workspaceId] ?? []).filter((s) => s.id !== session.id) },
		}));
		this.scheduleRefresh(conn, workspaceId);
		return true;
	}

	draft(sessionId: string): string {
		return this.drafts.get(sessionId) ?? "";
	}

	saveDraft(sessionId: string, text: string): void {
		if (text) this.drafts.set(sessionId, text);
		else this.drafts.delete(sessionId);
	}

	private requireClient(): PierClient {
		const client = this.client;
		if (client?.state !== "open") throw new Error("尚未连接到电脑");
		return client;
	}

	/** Close a session on the computer (it stays in the list). `force` aborts a running agent first. */
	async closeSession(session: SessionSummary, force = false): Promise<boolean> {
		const conn = this.active;
		const client = conn?.client;
		if (!conn || !client) return false;
		try {
			await client.request("session.close", { sessionId: session.id, force });
		} catch (error) {
			this.toast("error", `关闭会话失败：${errorText(error)}`);
			return false;
		}
		this.dropChat(conn, session.id);
		this.scheduleRefresh(conn, session.workspaceId);
		return true;
	}

	// ---- host status -------------------------------------------------------------------

	/** Whether the connected computer reports its resource usage (`host.stats`, protocol 1.12). */
	canReadHostStats(): boolean {
		return this.hostSpeaks(12);
	}

	async hostStats(): Promise<HostStats> {
		return this.requireClient().request("host.stats", {});
	}

	// ---- workspace files ---------------------------------------------------------------

	/** Whether the connected computer lets this phone browse workspace files (open to paired devices since 1.10). */
	canBrowseFiles(): boolean {
		return this.hostSpeaks(10);
	}

	/** Whether the connected computer can upload and download workspace files in pieces (1.21). */
	canTransferFiles(): boolean {
		return this.hostSpeaks(21);
	}

	/** Whether the connected computer can save edited files (1.8) and delete paths (1.11). */
	canEditFiles(): boolean {
		return this.hostSpeaks(11);
	}

	async listFiles(workspaceId: string, path: string): Promise<WorkspaceFilesResult> {
		return this.requireClient().request("workspace.files", { workspaceId, ...(path ? { path } : {}) });
	}

	async readFile(workspaceId: string, path: string): Promise<WorkspaceFileContent> {
		return this.requireClient().request("workspace.readFile", { workspaceId, path });
	}

	async writeFile(
		workspaceId: string,
		path: string,
		text: string,
		expectedModifiedAt?: string,
	): Promise<WorkspaceFileWriteResult> {
		return this.requireClient().request("workspace.writeFile", {
			workspaceId,
			path,
			text,
			...(expectedModifiedAt ? { expectedModifiedAt } : {}),
		});
	}

	/** Permanently delete a workspace file or directory. Resolves to whether it worked. */
	async deletePath(workspaceId: string, path: string): Promise<boolean> {
		try {
			await this.requireClient().request("workspace.deletePath", { workspaceId, path });
			return true;
		} catch (error) {
			this.toast("error", `删除失败：${errorText(error)}`);
			return false;
		}
	}

	/**
	 * Upload a local file into a workspace in pieces. `onProgress` gets the bytes sent so far.
	 * A failed upload is cancelled so no partial file is left behind.
	 */
	async uploadFile(
		workspaceId: string,
		path: string,
		source: UploadSource,
		options: { overwrite?: boolean; onProgress?: (sent: number) => void } = {},
	): Promise<WorkspaceFileWriteResult> {
		const client = this.requireClient();
		const start = await client.request("workspace.uploadStart", {
			workspaceId,
			path,
			size: source.size,
			...(options.overwrite ? { overwrite: true } : {}),
		});
		const chunk = Math.max(1, Math.min(TRANSFER_CHUNK, start.chunkBytes));
		try {
			let offset = 0;
			while (offset < source.size) {
				const bytes = source.read(Math.min(chunk, source.size - offset));
				if (!bytes.length) throw new Error("文件在上传时变短了");
				await client.request("workspace.uploadChunk", { uploadId: start.uploadId, offset, data: bytesToBase64(bytes) });
				offset += bytes.length;
				options.onProgress?.(offset);
			}
			return await client.request("workspace.uploadFinish", { uploadId: start.uploadId });
		} catch (error) {
			void client.request("workspace.uploadCancel", { uploadId: start.uploadId }).catch(() => undefined);
			throw error;
		}
	}

	/** Upload text (or an empty file) to a new workspace path. */
	async createFile(workspaceId: string, path: string, text = ""): Promise<WorkspaceFileWriteResult> {
		const bytes = new TextEncoder().encode(text);
		let read = 0;
		return this.uploadFile(workspaceId, path, {
			size: bytes.length,
			read: (length) => {
				const part = bytes.subarray(read, read + length);
				read += part.length;
				return part;
			},
		});
	}

	/** Download a workspace file in pieces into `sink`. Resolves to its size. */
	async downloadFile(
		workspaceId: string,
		path: string,
		sink: DownloadSink,
		onProgress?: (received: number, size: number) => void,
	): Promise<number> {
		const client = this.requireClient();
		let offset = 0;
		for (;;) {
			const part = await client.request("workspace.readBytes", { workspaceId, path, offset, length: TRANSFER_CHUNK });
			const bytes = base64ToBytes(part.data);
			if (bytes.length) sink.write(bytes);
			offset += bytes.length;
			onProgress?.(offset, part.size);
			if (part.eof || !bytes.length) return offset;
		}
	}

	// ---- terminals ---------------------------------------------------------------------

	/** Whether the connected computer can run a shell for this phone (`terminal.*`, protocol 1.18). */
	canOpenTerminal(): boolean {
		return this.state.host.info?.terminals === true && this.hostSpeaks(18);
	}

	/** Open a shell on the connected computer, in `cwd` (its home directory by default). */
	openTerminal(options: { cwd?: string; cols: number; rows: number; title?: string }): RemoteTerminal {
		const client = this.requireClient();
		const conn = this.active;
		if (!conn) throw new Error("尚未连接到电脑");
		const id = this.nextTerminalId++;
		const terminal = new RemoteTerminal(id, client, {
			...(options.cwd ? { cwd: options.cwd } : {}),
			cols: options.cols,
			rows: options.rows,
			title: options.title ?? "终端",
		});
		conn.terminals.set(id, terminal);
		terminal.subscribe(() => this.publishTerminals(conn));
		this.publishTerminals(conn);
		void terminal.open();
		return terminal;
	}

	/** A terminal of the computer on screen. */
	terminal(id: number): RemoteTerminal | undefined {
		return this.active?.terminals.get(id);
	}

	/** Hang up a terminal (if it still runs) and forget it. */
	async removeTerminal(id: number): Promise<void> {
		const conn = [...this.connections.values()].find((c) => c.terminals.has(id));
		const terminal = conn?.terminals.get(id);
		if (!conn || !terminal) return;
		await terminal.close();
		conn.terminals.delete(id);
		terminal.dispose();
		this.publishTerminals(conn);
	}

	private publishTerminals(conn: HostConnection): void {
		if (!this.isLive(conn)) return;
		const list: TerminalSummary[] = [...conn.terminals.values()]
			.reverse()
			.map((t) => ({ id: t.id, title: t.title, cwd: t.cwd, status: t.status }));
		const previous = this.state.connections[conn.hostId]?.terminals ?? [];
		const same =
			previous.length === list.length &&
			previous.every((t, i) => {
				const next = list[i];
				return next && t.id === next.id && t.title === next.title && t.cwd === next.cwd && t.status === next.status;
			});
		if (!same) this.setView(conn.hostId, { terminals: list });
	}

	private onTerminalEvent(conn: HostConnection, event: EventFrame["event"]): void {
		const terminalId = String((event as { terminalId?: unknown }).terminalId ?? "");
		const terminal = [...conn.terminals.values()].find((t) => t.terminalId === terminalId);
		if (!terminal) return;
		if (event.type === "terminal.output") terminal.output(String(event.data ?? ""));
		else {
			const code = typeof event.code === "number" ? event.code : null;
			const error = typeof event.error === "string" ? `终端已丢失：${event.error}` : undefined;
			terminal.exited(code, error);
		}
	}

	private loseTerminals(conn: HostConnection, reason: string): void {
		for (const terminal of conn.terminals.values()) {
			if (terminal.status !== "exited") terminal.exited(null, reason);
		}
	}

	// ---- pi extensions -----------------------------------------------------------------

	/** Whether this phone may manage pi extensions on the connected computer (protocol 1.10). */
	canManageExtensions(): boolean {
		return this.hostSpeaks(10);
	}

	async listExtensions(workspaceId?: string): Promise<ExtensionListResult> {
		return this.requireClient().request("extension.list", workspaceId ? { workspaceId } : {});
	}

	async resourceRequest<M extends ResourceMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
		return this.requireClient().request(method, params, { timeoutMs: method === "mcp.test" ? 60_000 : 45_000 });
	}

	async setExtensionEnabled(resource: ExtensionResourceInfo, enabled: boolean, workspaceId?: string): Promise<void> {
		await this.requireClient().request("extension.setEnabled", {
			type: resource.type,
			path: resource.path,
			enabled,
			...(workspaceId && resource.scope === "project" ? { workspaceId } : {}),
		});
	}

	async installExtension(source: string, scope: ExtensionScope, workspaceId?: string): Promise<void> {
		await this.requireClient().request(
			"extension.install",
			{ source, scope, ...(scope === "project" && workspaceId ? { workspaceId } : {}) },
			{ timeoutMs: 10 * 60_000 },
		);
	}

	async removeExtension(source: string, scope: ExtensionScope, workspaceId?: string): Promise<void> {
		await this.requireClient().request(
			"extension.remove",
			{ source, scope, ...(scope === "project" && workspaceId ? { workspaceId } : {}) },
			{ timeoutMs: 5 * 60_000 },
		);
	}

	async checkExtensionUpdates(workspaceId?: string): Promise<ExtensionUpdateInfo[]> {
		const { updates } = await this.requireClient().request(
			"extension.checkUpdates",
			workspaceId ? { workspaceId } : {},
			{ timeoutMs: 5 * 60_000 },
		);
		return updates;
	}

	/** Update one package, or every unpinned one without `source`. */
	async updateExtensions(source?: string, workspaceId?: string): Promise<void> {
		await this.requireClient().request(
			"extension.update",
			{ ...(source ? { source } : {}), ...(workspaceId ? { workspaceId } : {}) },
			{ timeoutMs: 10 * 60_000 },
		);
	}

	async deleteExtension(resource: ExtensionResourceInfo, workspaceId?: string): Promise<void> {
		await this.requireClient().request("extension.delete", {
			type: resource.type,
			path: resource.path,
			...(workspaceId ? { workspaceId } : {}),
		});
	}
}

export const StoreContext = createContext<MobileStore | null>(null);

export function useStore(): MobileStore {
	const store = useContext(StoreContext);
	if (!store) throw new Error("MobileStore missing");
	return store;
}

export function useMobileState<T>(selector: (state: MobileState) => T): T {
	const store = useStore();
	return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useChatView(chat: ChatController | undefined): ChatView | undefined {
	return useSyncExternalStore(chat?.subscribe ?? noop, chat ? chat.getView : () => undefined);
}

function noop(): () => void {
	return () => {};
}
