/**
 * The desktop shell the host runs in (the Tauri app), reached over the sidecar's stdio.
 *
 * The shell owns the app's updater; the host relays it to its clients (`update.*`, 1.13) so a
 * paired computer or phone can update Pier on this computer. It also provides pseudo-terminals,
 * which the host offers to its clients (`terminal.*`, 1.18). One JSON object per line:
 *
 * - shell → host (stdin): `{"type":"pier.shell.updateStatus","status":{…}}` whenever the
 *   updater's state changes (and once when the host is ready),
 *   `{"type":"pier.shell.capabilities","terminals":true}` once when the host is ready (an app
 *   that runs terminals also starts the host with `--shell-terminals`, so the capability is
 *   already in the `HostInfo` of clients that connect before this line arrives),
 *   `{"type":"pier.shell.response","id":"…","ok":true,"result":{…}}` /
 *   `{"type":"pier.shell.response","id":"…","ok":false,"error":"…"}`, and for terminals
 *   `{"type":"pier.shell.terminalOutput","key":"…","data":"<base64>"}` /
 *   `{"type":"pier.shell.terminalExit","key":"…","code":0|null}`.
 * - host → shell (stdout, after the `pier.ready` line):
 *   `{"type":"pier.shell.request","id":"…","method":"update.check"}`,
 *   `{"type":"pier.shell.request","id":"…","method":"terminal.spawn","params":{"key","cwd"?,"cols","rows"}}`
 *   (answered with `{"id":<number>,"shell","cwd"}`), and
 *   `{"type":"pier.shell.terminal","op":"write"|"resize"|"pause"|"resume"|"kill","id":<number>,…}`.
 *
 * The host picks each terminal's `key`, so output that arrives before the spawn response is
 * still attributed; the shell's numeric `id` addresses input. A shell that never reports an
 * updater status (an older app, or no app at all) has no updater the host can drive, and one
 * that never reports `terminals` has no terminals.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AppUpdateState, AppUpdateStatus } from "@pier/protocol";

export const SHELL_UPDATE_STATUS = "pier.shell.updateStatus";
export const SHELL_CAPABILITIES = "pier.shell.capabilities";
export const SHELL_REQUEST = "pier.shell.request";
export const SHELL_RESPONSE = "pier.shell.response";
export const SHELL_TERMINAL = "pier.shell.terminal";
export const SHELL_TERMINAL_OUTPUT = "pier.shell.terminalOutput";
export const SHELL_TERMINAL_EXIT = "pier.shell.terminalExit";

export type ShellMethod = "update.check" | "update.install";

export interface ShellTerminalOptions {
	cwd?: string;
	cols: number;
	rows: number;
}

export interface ShellTerminalHandlers {
	/** Raw output bytes, base64-encoded. */
	output(data: string): void;
	/** Called exactly once. `error` is set when the shell went away rather than the program ending. */
	exit(code: number | null, error?: string): void;
}

/** A shell running in one of the desktop app's pseudo-terminals. */
export interface ShellTerminal {
	readonly shell: string;
	readonly cwd: string;
	/** `binary` input carries one byte per character. */
	write(data: string, binary: boolean): void;
	resize(cols: number, rows: number): void;
	/** Stop or resume reading the shell's output (flow control); a paused shell blocks. */
	pause(paused: boolean): void;
	/** Hang up; `exit` follows. */
	kill(): void;
}

/** An updater owned by the desktop shell or the installed standalone service. */
export interface AppUpdater {
	/** The updater's latest status; undefined while the shell has not reported one. */
	readonly updateStatus: AppUpdateStatus | undefined;
	onUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void;
	/** Check or begin installation; resolves with the current status. */
	request(method: ShellMethod): Promise<AppUpdateStatus>;
	close(): void;
}

/** The desktop app around the host, as far as the host can drive it. */
export interface AppShell extends AppUpdater {
	/** Whether the shell provides pseudo-terminals. */
	readonly terminals?: boolean;
	/** Start the user's shell in a pseudo-terminal. Output may arrive before this resolves. */
	openTerminal?(options: ShellTerminalOptions, handlers: ShellTerminalHandlers): Promise<ShellTerminal>;
}

const STATES: ReadonlySet<AppUpdateState> = new Set([
	"unsupported",
	"idle",
	"checking",
	"upToDate",
	"available",
	"downloading",
	"installing",
	"error",
]);

/** A check can take the updater's 30 s timeout; an install checks first when needed. */
export const SHELL_REQUEST_TIMEOUT_MS = 90_000;
/** Starting a shell is quick; do not keep a client waiting on a stuck app. */
export const SHELL_TERMINAL_TIMEOUT_MS = 15_000;

const MAX_TEXT = 200_000;
const GONE = "The desktop app is not reachable";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function text(value: unknown, max = 1000): string | undefined {
	return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Validate an updater status from the shell (the Rust `UpdateStatus`, where missing fields
 * are `null`) and drop empty fields.
 */
export function parseUpdateStatus(raw: unknown): AppUpdateStatus | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	const state = value.state;
	if (typeof state !== "string" || !STATES.has(state as AppUpdateState)) return undefined;
	const currentVersion = text(value.currentVersion, 100);
	if (!currentVersion) return undefined;
	const status: AppUpdateStatus = {
		state: state as AppUpdateState,
		currentVersion,
		autoCheck: value.autoCheck === true,
		downloaded: count(value.downloaded) ?? 0,
	};
	const version = text(value.version, 100);
	if (version) status.version = version;
	const notes = text(value.notes, MAX_TEXT);
	if (notes) status.notes = notes;
	const date = text(value.date, 100);
	if (date) status.date = date;
	const total = count(value.total);
	if (total !== undefined) status.total = total;
	const error = text(value.error, 4000);
	if (error) status.error = error;
	const lastChecked = count(value.lastChecked);
	if (lastChecked !== undefined) status.lastChecked = lastChecked;
	if (value.installNeedsAuth === true) status.installNeedsAuth = true;
	return status;
}

interface Pending {
	resolve(result: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export interface StdioShellOptions {
	timeoutMs?: number;
	/** How long the app may take to start a terminal. */
	terminalTimeoutMs?: number;
	/**
	 * The app declared terminals when it started the host (`--shell-terminals`). Paired
	 * computers reconnecting right after a restart see them in their `host.hello` then, instead
	 * of only after the `pier.shell.capabilities` line that follows `pier.ready`.
	 */
	terminals?: boolean;
	log?: (message: string) => void;
}

/** The shell on the other end of the sidecar's stdin / stdout. */
export class StdioShell implements AppShell {
	private status: AppUpdateStatus | undefined;
	private terminalSupport = false;
	private readonly listeners = new Set<(status: AppUpdateStatus) => void>();
	private readonly pending = new Map<string, Pending>();
	/** Open terminals by the key the host gave them. */
	private readonly terminalHandlers = new Map<string, ShellTerminalHandlers>();
	private nextId = 1;
	private nextTerminalKey = 1;
	private closed = false;
	private readonly lines;
	private readonly timeoutMs: number;
	private readonly terminalTimeoutMs: number;
	private readonly log: (message: string) => void;

	constructor(
		input: Readable,
		private readonly output: Writable,
		options: StdioShellOptions = {},
	) {
		this.timeoutMs = options.timeoutMs ?? SHELL_REQUEST_TIMEOUT_MS;
		this.terminalTimeoutMs = options.terminalTimeoutMs ?? SHELL_TERMINAL_TIMEOUT_MS;
		this.terminalSupport = options.terminals === true;
		this.log = options.log ?? (() => {});
		this.lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		this.lines.on("line", (line) => this.receive(line));
		this.lines.on("close", () => this.close());
	}

	get updateStatus(): AppUpdateStatus | undefined {
		return this.status;
	}

	get terminals(): boolean {
		return this.terminalSupport && !this.closed;
	}

	onUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async request(method: ShellMethod): Promise<AppUpdateStatus> {
		const status = parseUpdateStatus(await this.call(method, undefined, this.timeoutMs));
		if (!status) throw new Error("The desktop app sent an invalid update status");
		return status;
	}

	async openTerminal(options: ShellTerminalOptions, handlers: ShellTerminalHandlers): Promise<ShellTerminal> {
		if (!this.terminals) throw new Error("The desktop app cannot run terminals");
		const key = String(this.nextTerminalKey++);
		let ended = false;
		const end = () => {
			ended = true;
			this.terminalHandlers.delete(key);
		};
		this.terminalHandlers.set(key, {
			output: (data) => {
				if (!ended) handlers.output(data);
			},
			exit: (code, error) => {
				if (ended) return;
				end();
				handlers.exit(code, error);
			},
		});
		let result: unknown;
		try {
			result = await this.call(
				"terminal.spawn",
				{ key, ...(options.cwd ? { cwd: options.cwd } : {}), cols: options.cols, rows: options.rows },
				this.terminalTimeoutMs,
			);
		} catch (error) {
			end();
			throw error;
		}
		const value = (result ?? {}) as Record<string, unknown>;
		const id = value.id;
		if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
			end();
			throw new Error("The desktop app sent an invalid terminal");
		}
		const send = (message: Record<string, unknown>) => {
			if (!ended) this.send({ type: SHELL_TERMINAL, id, ...message });
		};
		return {
			shell: text(value.shell, 200) ?? "shell",
			cwd: text(value.cwd, 4096) ?? options.cwd ?? "",
			write: (data, binary) => send({ op: "write", data, ...(binary ? { binary: true } : {}) }),
			resize: (cols, rows) => send({ op: "resize", cols, rows }),
			pause: (paused) => send({ op: paused ? "pause" : "resume" }),
			kill: () => send({ op: "kill" }),
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.lines.close();
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(GONE));
			this.pending.delete(id);
		}
		for (const handlers of [...this.terminalHandlers.values()]) handlers.exit(null, GONE);
		this.terminalHandlers.clear();
	}

	private send(message: Record<string, unknown>): void {
		if (this.closed) return;
		try {
			this.output.write(`${JSON.stringify(message)}\n`);
		} catch {
			// The app went away; `close` follows once stdin ends.
		}
	}

	private call(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error(GONE));
		const id = String(this.nextId++);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("The desktop app did not answer in time"));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			this.send({ type: SHELL_REQUEST, id, method, ...(params ? { params } : {}) });
		});
	}

	private terminal(message: Record<string, unknown>): ShellTerminalHandlers | undefined {
		return typeof message.key === "string" ? this.terminalHandlers.get(message.key) : undefined;
	}

	private receive(line: string): void {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) return;
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			return;
		}
		switch (message.type) {
			case SHELL_TERMINAL_OUTPUT: {
				const data = message.data;
				if (typeof data === "string" && BASE64.test(data)) this.terminal(message)?.output(data);
				return;
			}
			case SHELL_TERMINAL_EXIT: {
				const code = message.code;
				this.terminal(message)?.exit(typeof code === "number" && Number.isInteger(code) ? code : null);
				return;
			}
			case SHELL_CAPABILITIES:
				this.terminalSupport = message.terminals === true;
				return;
			case SHELL_UPDATE_STATUS: {
				const status = parseUpdateStatus(message.status);
				if (!status) {
					this.log("ignored an invalid update status from the desktop app");
					return;
				}
				this.status = status;
				for (const listener of [...this.listeners]) listener(status);
				return;
			}
			case SHELL_RESPONSE: {
				if (typeof message.id !== "string") return;
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.ok === true) pending.resolve(message.result);
				else pending.reject(new Error(text(message.error, 4000) ?? "The desktop app could not do that"));
				return;
			}
		}
	}
}
