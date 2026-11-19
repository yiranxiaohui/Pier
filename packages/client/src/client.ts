import {
	type ClientInfo,
	type EventFrame,
	type HelloResult,
	type HostInfo,
	type KnownMessages,
	type MethodName,
	type MethodParams,
	type MethodResult,
	PierProtocolError,
	PROTOCOL_VERSION,
	parseHostFrame,
	parseProtocolVersion,
	type SessionSnapshot,
	type SessionSummary,
	type SubscribeResult,
} from "@pier/protocol";

/** The subset of the WHATWG WebSocket API the client uses (browser, React Native, Node 22+). */
export interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ClientState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface ReconnectOptions {
	enabled?: boolean;
	initialDelayMs?: number;
	maxDelayMs?: number;
}

export interface PierClientOptions {
	url: string;
	token?: string;
	client: ClientInfo;
	/** Ask the host to merge streaming deltas within this window (useful on mobile). */
	coalesceMs?: number;
	createWebSocket?: WebSocketFactory;
	requestTimeoutMs?: number;
	reconnect?: ReconnectOptions;
	/**
	 * Send `host.info` this often while open and drop the connection if it does not
	 * answer within `heartbeatTimeoutMs`. Detects dead connections the OS has not
	 * noticed (useful on mobile networks). Off by default.
	 */
	heartbeatMs?: number;
	heartbeatTimeoutMs?: number;
	/** WebSocket close codes after which the client stops reconnecting (default: 4403, device revoked). */
	terminalCloseCodes?: number[];
}

/** Close code the host uses when a device is unknown or has been revoked. */
export const CLOSE_DEVICE_REVOKED = 4403;

export type SessionEventHandler = (frame: EventFrame) => void;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface SubscriptionState {
	sessionId: string;
	workspaceId?: string;
	lastSeq: number;
	epoch?: string;
	/** The transcript prefix the subscriber already has, asked on every (re)subscribe. */
	known?: () => KnownMessages | undefined;
	handlers: Set<SessionEventHandler>;
}

/** Options of `PierClient.subscribe`. */
export interface SubscribeOptions {
	/**
	 * Workspace of the session, to reopen it when the host evicted it. Hosts that support it
	 * ({@link PierClient.subscribeOpensSessions}) also open a session that is not open yet.
	 */
	workspaceId?: string;
	/**
	 * Where the caller's cached state of the session stands. When the host still has the events
	 * after `seq` in the same `epoch`, only those are sent instead of a snapshot.
	 */
	resume?: { seq: number; epoch: string };
	/**
	 * The transcript prefix the caller already has (1.27). When a snapshot is needed and the
	 * host's transcript starts with it, the snapshot leaves it out (`messagesFrom`).
	 */
	known?: () => KnownMessages | undefined;
}

export interface Subscription {
	readonly sessionId: string;
	/** Last applied seq; used to resume after reconnect. */
	readonly lastSeq: number;
	/**
	 * Subscribe again, for when the session's events stopped although the connection did not drop
	 * (e.g. a request answers that the session is not open). The host sends what was missed since
	 * `lastSeq`, or a snapshot, and reopens a session it closed; events already applied are not
	 * applied twice. Resolves to false when this subscription has ended (the host closed the
	 * session, or it was unsubscribed).
	 */
	resubscribe(): Promise<boolean>;
	unsubscribe(): Promise<void>;
}

type Listener<T> = (value: T) => void;

class Emitter<T> {
	private readonly listeners = new Set<Listener<T>>();
	on(listener: Listener<T>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(value: T): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(value);
			} catch {
				// Listener errors must not break the client.
			}
		}
	}
}

const OPEN = 1;

function defaultFactory(): WebSocketFactory {
	const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
	if (!Ctor) throw new Error("No global WebSocket; pass createWebSocket");
	return (url) => new Ctor(url);
}

/**
 * Pier protocol client: handshake, request/response correlation, typed methods,
 * automatic reconnect, and per-session resume from the last applied seq.
 */
export class PierClient {
	private readonly options: PierClientOptions;
	private readonly factory: WebSocketFactory;
	private socket: WebSocketLike | undefined;
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	private readonly subscriptions = new Map<string, SubscriptionState>();
	private stateValue: ClientState = "idle";
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private openWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
	private hello: HelloResult | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private closeInfo: { code?: number; reason?: string } | undefined;

	private readonly stateEmitter = new Emitter<ClientState>();
	private readonly eventEmitter = new Emitter<EventFrame>();
	private readonly errorEmitter = new Emitter<Error>();

	constructor(options: PierClientOptions) {
		this.options = options;
		this.factory = options.createWebSocket ?? defaultFactory();
	}

	get state(): ClientState {
		return this.stateValue;
	}

	get host(): HostInfo | undefined {
		return this.hello?.host;
	}

	get connectionId(): string | undefined {
		return this.hello?.connectionId;
	}

	/** Result of the last successful `host.hello`. */
	get helloResult(): HelloResult | undefined {
		return this.hello;
	}

	/**
	 * Whether the host opens a session that is not open when it is subscribed to with its
	 * workspace (protocol 1.63), so callers need no `session.open` (and its round trip) first.
	 */
	get subscribeOpensSessions(): boolean {
		const version = parseProtocolVersion(this.hello?.host?.protocolVersion ?? this.hello?.protocolVersion ?? "");
		return version?.major === 1 && version.minor >= 63;
	}

	/** Close code and reason when the client stopped because of a terminal close (e.g. revoked). */
	get terminalClose(): { code?: number; reason?: string } | undefined {
		return this.closeInfo;
	}

	onState(listener: Listener<ClientState>): () => void {
		return this.stateEmitter.on(listener);
	}

	/** Every event frame (host-scoped and session-scoped), after seq de-duplication. */
	onEvent(listener: Listener<EventFrame>): () => void {
		return this.eventEmitter.on(listener);
	}

	onError(listener: Listener<Error>): () => void {
		return this.errorEmitter.on(listener);
	}

	private setState(state: ClientState): void {
		if (this.stateValue === state) return;
		this.stateValue = state;
		this.stateEmitter.emit(state);
	}

	/** Connect and complete `host.hello`. */
	async connect(): Promise<HelloResult> {
		if (this.stateValue === "closed") throw new Error("Client is closed");
		this.setState("connecting");
		return this.open();
	}

	private open(): Promise<HelloResult> {
		return new Promise<HelloResult>((resolve, reject) => {
			let socket: WebSocketLike;
			try {
				socket = this.factory(this.options.url);
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			this.socket = socket;
			let opened = false;
			socket.onopen = () => {
				opened = true;
				this.sendRequest<"host.hello">(
					"host.hello",
					{
						protocolVersion: PROTOCOL_VERSION,
						client: this.options.client,
						...(this.options.token ? { token: this.options.token } : {}),
						...(this.options.coalesceMs ? { coalesceMs: this.options.coalesceMs } : {}),
					},
					this.options.requestTimeoutMs ?? 30_000,
				)
					.then(async (hello) => {
						this.hello = hello;
						this.reconnectAttempt = 0;
						this.setState("open");
						this.startHeartbeat(socket);
						for (const waiter of this.openWaiters.splice(0)) waiter.resolve();
						await this.resubscribeAll();
						resolve(hello);
					})
					.catch((error: Error) => {
						if (error instanceof PierProtocolError && error.code !== "TIMEOUT") {
							// The host refused (authentication, version): not retried.
							this.close();
						} else if (this.socket === socket) {
							// No answer: drop this socket. Its close handler reconnects if the client was
							// open before (a proxy may accept the socket and then lose its upstream).
							try {
								socket.close(4000, "host.hello failed");
							} catch {
								// Ignore.
							}
						}
						reject(error);
					});
			};
			socket.onmessage = (event) => this.handleMessage(event.data);
			// A `close` event always follows `error`; the close handler rejects with the close code.
			socket.onerror = () => {};
			socket.onclose = (event) => {
				if (this.socket !== socket) return;
				this.socket = undefined;
				this.stopHeartbeat();
				this.failPending(new Error(`Connection closed${event.reason ? `: ${event.reason}` : ""}`));
				const terminal =
					event.code !== undefined && (this.options.terminalCloseCodes ?? [CLOSE_DEVICE_REVOKED]).includes(event.code);
				if (!opened || terminal) {
					reject(
						terminal
							? new PierProtocolError("UNAUTHENTICATED", event.reason || "Connection refused by the host")
							: new Error(`Could not connect to ${this.options.url}${event.reason ? `: ${event.reason}` : ""}`),
					);
				}
				if (terminal) {
					this.closeInfo = {
						...(event.code !== undefined ? { code: event.code } : {}),
						...(event.reason ? { reason: event.reason } : {}),
					};
					this.errorEmitter.emit(
						new PierProtocolError("UNAUTHENTICATED", event.reason || "Connection refused by the host"),
					);
					this.close();
					return;
				}
				this.scheduleReconnect();
			};
		});
	}

	private startHeartbeat(socket: WebSocketLike): void {
		this.stopHeartbeat();
		const interval = this.options.heartbeatMs;
		if (!interval) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.socket !== socket || this.stateValue !== "open") return;
			this.sendRequest("host.info", undefined, this.options.heartbeatTimeoutMs ?? 10_000).catch(() => {
				// No answer: assume the connection is dead and reconnect.
				if (this.socket === socket) this.dropConnection();
			});
		}, interval);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	/**
	 * Reconnect immediately instead of waiting for the backoff timer (e.g. when a mobile
	 * app returns to the foreground). No-op unless the client is reconnecting.
	 */
	reconnectNow(): void {
		if (this.stateValue !== "reconnecting" || !this.reconnectTimer) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.reconnectAttempt = 0;
		this.open().catch((error: Error) => this.errorEmitter.emit(error));
	}

	private scheduleReconnect(): void {
		if (this.stateValue === "closed") return;
		const reconnect = this.options.reconnect ?? {};
		if (reconnect.enabled === false || this.hello === undefined) {
			this.setState("closed");
			for (const waiter of this.openWaiters.splice(0)) waiter.reject(new Error("Disconnected"));
			return;
		}
		this.setState("reconnecting");
		const initial = reconnect.initialDelayMs ?? 500;
		const max = reconnect.maxDelayMs ?? 15_000;
		const delay = Math.min(max, initial * 2 ** this.reconnectAttempt) * (0.8 + Math.random() * 0.4);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (this.stateValue === "closed") return;
			this.open().catch((error: Error) => this.errorEmitter.emit(error));
		}, delay);
	}

	private handleMessage(data: unknown): void {
		const frame = typeof data === "string" ? parseHostFrame(data) : undefined;
		if (!frame) {
			this.errorEmitter.emit(new Error("Received an invalid frame from the host"));
			return;
		}
		if (frame.type === "res") {
			const pending = this.pending.get(frame.id);
			if (!pending) return;
			this.pending.delete(frame.id);
			clearTimeout(pending.timer);
			if (frame.ok) pending.resolve(frame.result);
			else pending.reject(new PierProtocolError(frame.error.code, frame.error.message, frame.error.data));
			return;
		}
		this.handleEvent(frame);
	}

	private handleEvent(frame: EventFrame): void {
		const sessionId = frame.sessionId;
		const sub = sessionId ? this.subscriptions.get(sessionId) : undefined;
		if (sub) {
			if (frame.event.type === "session.snapshot") {
				const snapshot = frame.event.snapshot as SessionSnapshot;
				sub.lastSeq = snapshot.seq;
				sub.epoch = snapshot.epoch;
			} else if (frame.seq !== undefined) {
				if (frame.seq <= sub.lastSeq) return; // Already applied.
				sub.lastSeq = frame.seq;
			}
			if (frame.event.type === "session.replaced") {
				const next = frame.event.session as SessionSummary;
				this.subscriptions.delete(sub.sessionId);
				sub.sessionId = next.id;
				sub.lastSeq = 0;
				sub.epoch = undefined;
				this.subscriptions.set(next.id, sub);
			}
			if (frame.event.type === "session.closed") this.subscriptions.delete(sub.sessionId);
			for (const handler of [...sub.handlers]) {
				try {
					handler(frame);
				} catch {
					// Ignore handler errors.
				}
			}
		}
		this.eventEmitter.emit(frame);
	}

	private failPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	private sendRequest<M extends MethodName>(method: M, params: unknown, timeoutMs: number): Promise<MethodResult<M>> {
		const socket = this.socket;
		if (!socket || socket.readyState !== OPEN) return Promise.reject(new Error("Not connected"));
		const id = `r${this.nextId++}`;
		return new Promise<MethodResult<M>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new PierProtocolError("TIMEOUT", `${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			try {
				socket.send(JSON.stringify({ type: "req", id, method, ...(params === undefined ? {} : { params }) }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private waitForOpen(timeoutMs: number): Promise<void> {
		if (this.stateValue === "open") return Promise.resolve();
		if (this.stateValue === "closed" || this.stateValue === "idle") return Promise.reject(new Error("Not connected"));
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error: Error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			const timer = setTimeout(() => {
				this.openWaiters = this.openWaiters.filter((w) => w !== waiter);
				reject(new PierProtocolError("TIMEOUT", "Timed out waiting for the connection"));
			}, timeoutMs);
			this.openWaiters.push(waiter);
		});
	}

	/** Call a protocol method. Waits for a pending reconnect instead of failing immediately. */
	async request<M extends MethodName>(
		method: M,
		...args: undefined extends MethodParams<M>
			? [params?: MethodParams<M>, options?: { timeoutMs?: number }]
			: [params: MethodParams<M>, options?: { timeoutMs?: number }]
	): Promise<MethodResult<M>> {
		const [params, options] = args;
		const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
		await this.waitForOpen(timeoutMs);
		return this.sendRequest(method, params, timeoutMs);
	}

	/**
	 * Subscribe to a session's events. The first event is either a `session.snapshot`
	 * or the replay of missed events; after reconnects the client resumes automatically.
	 */
	async subscribe(
		sessionId: string,
		handler: SessionEventHandler,
		options: SubscribeOptions = {},
	): Promise<Subscription> {
		let sub = this.subscriptions.get(sessionId);
		if (!sub) {
			sub = {
				sessionId,
				lastSeq: options.resume?.seq ?? 0,
				...(options.resume ? { epoch: options.resume.epoch } : {}),
				handlers: new Set(),
				...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
				...(options.known ? { known: options.known } : {}),
			};
			this.subscriptions.set(sessionId, sub);
		}
		sub.handlers.add(handler);
		const state = sub;
		const first = state.handlers.size === 1;
		if (first) {
			try {
				await this.requestSubscribe(state);
			} catch (error) {
				state.handlers.delete(handler);
				if (!state.handlers.size) this.forget(state);
				throw error;
			}
		}
		return {
			get sessionId() {
				return state.sessionId;
			},
			get lastSeq() {
				return state.lastSeq;
			},
			resubscribe: async () => {
				if (!state.handlers.has(handler) || this.subscriptions.get(state.sessionId) !== state) return false;
				await this.restore(state);
				return true;
			},
			unsubscribe: async () => {
				state.handlers.delete(handler);
				if (state.handlers.size > 0) return;
				// A subscription the host already ended (`session.closed`) must not end a newer one.
				if (!this.forget(state)) return;
				if (this.stateValue === "open") {
					await this.request("session.unsubscribe", { sessionId: state.sessionId }).catch(() => undefined);
				}
			},
		};
	}

	private async requestSubscribe(sub: SubscriptionState): Promise<SubscribeResult> {
		const known = sub.known?.();
		const params = {
			sessionId: sub.sessionId,
			// The host opens the session when it does not have it (1.63; older hosts answer NOT_FOUND).
			...(sub.workspaceId && this.subscribeOpensSessions ? { workspaceId: sub.workspaceId } : {}),
			...(sub.epoch !== undefined ? { sinceSeq: sub.lastSeq, epoch: sub.epoch } : {}),
			...(known ? { known } : {}),
		};
		const result = await this.request("session.subscribe", params);
		if (result.mode === "replay") sub.epoch = result.epoch;
		return result;
	}

	/** Drop a subscription from the map, unless another one took its place. */
	private forget(sub: SubscriptionState): boolean {
		if (this.subscriptions.get(sub.sessionId) !== sub) return false;
		this.subscriptions.delete(sub.sessionId);
		return true;
	}

	/** Subscribe again on the current connection, reopening the session when the host no longer has it. */
	private async restore(sub: SubscriptionState): Promise<void> {
		try {
			await this.requestSubscribe(sub);
		} catch (error) {
			if (!(error instanceof PierProtocolError && error.code === "NOT_FOUND" && sub.workspaceId)) throw error;
			// The host restarted or evicted the session: reopen it, then start from a snapshot.
			await this.request("session.open", { workspaceId: sub.workspaceId, sessionId: sub.sessionId });
			sub.epoch = undefined;
			sub.lastSeq = 0;
			await this.requestSubscribe(sub);
		}
	}

	private async resubscribeAll(): Promise<void> {
		for (const sub of [...this.subscriptions.values()]) {
			try {
				await this.restore(sub);
			} catch (error) {
				this.errorEmitter.emit(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	/** Drop the transport without closing the client (tests / simulated network loss). */
	dropConnection(): void {
		this.socket?.close(4000, "Dropped by client");
	}

	close(): void {
		if (this.stateValue === "closed") return;
		this.setState("closed");
		this.stopHeartbeat();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		for (const waiter of this.openWaiters.splice(0)) waiter.reject(new Error("Client closed"));
		const socket = this.socket;
		this.socket = undefined;
		this.failPending(new Error("Client closed"));
		try {
			socket?.close(1000, "Client closed");
		} catch {
			// Ignore.
		}
	}
}
