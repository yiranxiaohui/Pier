import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Client side of the Agent Client Protocol (https://agentclientprotocol.com, protocol version 1):
 * newline-delimited JSON-RPC 2.0 over an agent process's stdio. One process serves every session
 * of the host; `session/update` notifications and the agent's requests (permissions, forms) are
 * routed to the listener registered for their `sessionId`.
 */

export type Json = Record<string, unknown>;

export const ACP_PROTOCOL_VERSION = 1;

export class AcpError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly data?: unknown,
	) {
		super(message);
	}
}

/** A JSON-RPC error with its details: agents put the actual reason into `data` ("Internal error"). */
function rpcError(error: Json, label: string): AcpError {
	const code = Number(error.code ?? 0) || undefined;
	const message = typeof error.message === "string" && error.message ? error.message : `${label} request failed`;
	const data = error.data;
	const details =
		data && typeof data === "object"
			? ((data as Json).details ?? (data as Json).message ?? (data as Json).error)
			: typeof data === "string"
				? data
				: undefined;
	const text = typeof details === "string" && details.trim() ? details.trim() : undefined;
	return new AcpError(text && text !== message ? text : message, code, data);
}

export interface AcpSessionListener {
	/** A `session/update` notification's `update`. */
	update(update: Json): void;
	/** A request of the agent for this session (`session/request_permission`, `elicitation/create`). */
	request(method: string, params: Json): Promise<unknown>;
}

export interface AcpConnectionOptions {
	executable: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	/** Name used in errors and logs, e.g. `Hermes`. */
	label: string;
	clientInfo: { name: string; title: string; version: string };
	clientCapabilities: Json;
	log?: (message: string) => void;
	/** Timeout of one request; `session/prompt` requests are sent without one. */
	requestTimeoutMs?: number;
}

interface Pending {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** How long updates for a session without a listener are kept. */
const UNCLAIMED_TTL_MS = 30_000;
const UNCLAIMED_UPDATES = new Set([
	"available_commands_update",
	"usage_update",
	"session_info_update",
	"config_option_update",
	"current_mode_update",
]);

export class AcpConnection {
	private child: ChildProcessWithoutNullStreams | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, AcpSessionListener>();
	/**
	 * State updates (commands, usage, title, options) for sessions nobody listens to yet: Hermes
	 * sends them right after `session/new` answers, before the session is set up.
	 */
	private readonly unclaimed = new Map<string, { at: number; updates: Json[] }>();
	private readonly exitHandlers = new Set<(reason: string) => void>();
	private starting: Promise<Json> | undefined;
	private initialized: Json | undefined;
	private stderrTail: string[] = [];
	private closed = false;
	/** Incremented for every process started: sessions attach to one process. */
	generation = 0;

	constructor(private readonly options: AcpConnectionOptions) {}

	get running(): boolean {
		return this.child !== undefined && this.starting === undefined;
	}

	/** The agent's `initialize` result (capabilities, agent info) once started. */
	get agent(): Json | undefined {
		return this.initialized;
	}

	onExit(handler: (reason: string) => void): () => void {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	/** Route a session's updates and requests to `listener` (replacing an earlier one). */
	listen(sessionId: string, listener: AcpSessionListener): () => void {
		this.listeners.set(sessionId, listener);
		const early = this.unclaimed.get(sessionId);
		this.unclaimed.delete(sessionId);
		if (early && Date.now() - early.at < UNCLAIMED_TTL_MS)
			for (const update of early.updates) this.deliver(listener, update);
		return () => {
			if (this.listeners.get(sessionId) === listener) this.listeners.delete(sessionId);
		};
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	/** Start the process and complete `initialize` (once; restarts after an exit). */
	start(): Promise<Json> {
		if (this.closed) return Promise.reject(new AcpError(`${this.options.label} was closed`));
		if (this.child && !this.starting && this.initialized) return Promise.resolve(this.initialized);
		this.starting ??= this.spawnAndInitialize().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async spawnAndInitialize(): Promise<Json> {
		const { executable, args, label } = this.options;
		const child = spawn(executable, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: this.options.env ?? process.env,
			windowsHide: true,
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
		});
		this.child = child;
		this.generation++;
		this.initialized = undefined;
		this.stderrTail = [];
		child.stdin.on("error", () => {});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				this.stderrTail.push(line);
				if (this.stderrTail.length > 20) this.stderrTail.shift();
				// Hermes logs every start at INFO level; Pier's log keeps its warnings and errors.
				if (!/\[(INFO|DEBUG)\]/.test(line)) this.options.log?.(`${label.toLowerCase()} acp: ${line.slice(0, 500)}`);
			}
		});
		const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", (line) => this.onLine(line));
		const exited = new Promise<never>((_, reject) => {
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				const tail = this.stderrTail.filter((l) => !/^\s*(Traceback|File "|\^)/.test(l)).slice(-3);
				const reason = `${label} exited (${signal ?? `code ${code}`})${tail.length ? `: ${tail.join(" | ")}` : ""}`;
				if (this.child === child) {
					this.child = undefined;
					this.initialized = undefined;
					this.unclaimed.clear();
				}
				for (const [id, pending] of this.pending) {
					if (pending.timer) clearTimeout(pending.timer);
					pending.reject(new AcpError(reason));
					this.pending.delete(id);
				}
				for (const handler of this.exitHandlers) handler(reason);
				reject(new AcpError(reason));
			};
			child.once("exit", onExit);
			child.once("error", (error) => {
				if (this.child === child) this.child = undefined;
				reject(new AcpError(`Could not start ${label}: ${error.message}`));
			});
		});
		exited.catch(() => {});
		const initialize = this.send("initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: this.options.clientCapabilities,
			clientInfo: this.options.clientInfo,
		}) as Promise<Json>;
		const result = await Promise.race([initialize, exited]);
		this.initialized = result;
		return result;
	}

	private write(message: Json): void {
		const child = this.child;
		if (!child) throw new AcpError(`${this.options.label} is not running`);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	private send(
		method: string,
		params: unknown,
		timeoutMs = this.options.requestTimeoutMs ?? 120_000,
	): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new AcpError(`${this.options.label} did not answer ${method} in time`));
						}, timeoutMs)
					: undefined;
			this.pending.set(id, { method, resolve, reject, timer });
			try {
				this.write({ id, method, params });
			} catch (error) {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
				reject(error as Error);
			}
		});
	}

	/** Send a request; `timeoutMs: 0` waits as long as the agent takes (`session/prompt`). */
	async request<T = Json>(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
		await this.start();
		return (await this.send(method, params, options.timeoutMs)) as T;
	}

	/** Send a notification (`session/cancel`). Dropped when the agent is not running. */
	notify(method: string, params: unknown): void {
		try {
			this.write({ method, params });
		} catch {
			// Nothing to notify.
		}
	}

	private onLine(line: string): void {
		if (!line.trim()) return;
		let message: Json;
		try {
			message = JSON.parse(line) as Json;
		} catch {
			this.options.log?.(`${this.options.label} sent invalid JSON: ${line.slice(0, 200)}`);
			return;
		}
		const id = message.id;
		const method = typeof message.method === "string" ? message.method : undefined;
		const params = (message.params && typeof message.params === "object" ? message.params : {}) as Json;
		if (method && id !== undefined && id !== null) {
			void this.answer(id, method, params);
			return;
		}
		if (method) {
			if (method !== "session/update") return;
			const sessionId = String(params.sessionId);
			const listener = this.listeners.get(sessionId);
			const update = params.update;
			if (!update || typeof update !== "object") return;
			if (listener) this.deliver(listener, update as Json);
			else this.keep(sessionId, update as Json);
			return;
		}
		if (typeof id === "number") {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			const error = message.error as Json | undefined;
			if (error && typeof error === "object") pending.reject(rpcError(error, this.options.label));
			else pending.resolve(message.result ?? null);
		}
	}

	private deliver(listener: AcpSessionListener, update: Json): void {
		try {
			listener.update(update);
		} catch (error) {
			this.options.log?.(
				`${this.options.label} update ${String(update.sessionUpdate)} failed: ${
					error instanceof Error ? error.message : error
				}`,
			);
		}
	}

	private keep(sessionId: string, update: Json): void {
		// Transcript updates only matter to a listener (a replay or a turn).
		if (!UNCLAIMED_UPDATES.has(String(update.sessionUpdate))) return;
		const now = Date.now();
		for (const [id, entry] of this.unclaimed) if (now - entry.at >= UNCLAIMED_TTL_MS) this.unclaimed.delete(id);
		const entry = this.unclaimed.get(sessionId) ?? { at: now, updates: [] };
		if (entry.updates.length >= 50 || (!this.unclaimed.has(sessionId) && this.unclaimed.size >= 50)) return;
		entry.updates.push(update);
		this.unclaimed.set(sessionId, entry);
	}

	private async answer(id: unknown, method: string, params: Json): Promise<void> {
		try {
			const listener = this.listeners.get(String(params.sessionId));
			if (!listener) throw new AcpError(`Unsupported request ${method}`, -32601);
			const result = await listener.request(method, params);
			this.write({ id, result: result ?? null });
		} catch (error) {
			try {
				this.write({
					id,
					error: {
						code: error instanceof AcpError && error.code ? error.code : -32603,
						message: error instanceof Error ? error.message : String(error),
					},
				});
			} catch {
				// The agent went away.
			}
		}
	}

	/** Stop the process (it is started again by the next request unless `final`). */
	async stop(final = false): Promise<void> {
		if (final) this.closed = true;
		const child = this.child;
		this.child = undefined;
		this.initialized = undefined;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		child.stdin.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 3000);
			timer.unref?.();
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			// Closing stdin ends an ACP agent; signal it too in case it waits on something else.
			setTimeout(() => child.kill("SIGTERM"), 500).unref?.();
		});
	}
}

/** Text of ACP content blocks (`text` blocks, and the text of `resource` blocks). */
export function acpText(content: unknown): string {
	const blocks = Array.isArray(content) ? content : content ? [content] : [];
	const parts: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const b = block as Json;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "content") parts.push(acpText(b.content));
		else if (b.type === "resource" && b.resource && typeof (b.resource as Json).text === "string")
			parts.push((b.resource as Json).text as string);
	}
	return parts.join("\n");
}
