/**
 * Pseudo-terminals the host runs itself when no desktop app is around it (a server's
 * `pier run` / systemd service, or the host the `pier` CLI starts), so paired computers and
 * phones can open shells there too (`terminal.*`, 1.18). The desktop app runs its own
 * terminals instead (`shell.ts`).
 *
 * They use Bun's pseudo-terminals (`Bun.spawn` with `terminal`), which the Pier executable has
 * on Linux and macOS; under Node (development) and on Windows there are none. Like the
 * desktop app, a terminal runs the user's login shell in the requested directory (else the
 * home directory) with `TERM=xterm-256color`, and reports the shell's exit once the output it
 * printed last has arrived.
 *
 * Bun reads a terminal's output as it comes and cannot stop, so pausing (flow control for a
 * slow connection) uses the terminal's own: while the line discipline handles XON / XOFF
 * (`IXON`, on unless a full-screen program turned it off), pausing types XOFF and the programs
 * writing to the terminal block until XON. A program that turned `IXON` off is not slowed down,
 * and does not get XOFF / XON as input either.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import type { ShellTerminal, ShellTerminalHandlers, ShellTerminalOptions, TerminalProvider } from "./shell.ts";

/** After the shell exits, how long to wait for its last output (as the desktop app does). */
export const DRAIN_GRACE_MS = 500;
/** How long a hung-up shell may take to end before it is killed. */
export const KILL_GRACE_MS = 5_000;

const XOFF = "\x13";
const XON = "\x11";
/** termios `c_iflag` bit that enables XON / XOFF output control. */
export const IXON = process.platform === "darwin" || process.platform.endsWith("bsd") ? 0x200 : 0o2000;

/** Variables of the host process that are not meant for the user's shell. */
const HOST_ONLY_ENV = new Set(["PIER_LOCAL_TOKEN", "PIER_RELAY_TOKEN", "PI_PACKAGE_DIR"]);

export interface PtySpawnOptions {
	/** Absolute path of the program. */
	file: string;
	/** `argv[0]`; a leading `-` starts a login shell. */
	argv0: string;
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
	data(bytes: Uint8Array): void;
	/** The terminal reached its end: every program holding it ended (or reading it failed). */
	end(): void;
}

/** A program running in a pseudo-terminal. */
export interface PtyChild {
	/** Resolves with the exit code once the program ended; null when a signal ended it. */
	readonly exited: Promise<number | null>;
	/** The terminal's termios `c_iflag`; 0 once it is closed. */
	readonly inputFlags: number;
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	signal(signal: NodeJS.Signals): void;
	/** Close the controlling side, which hangs up everything still attached to the terminal. */
	close(): void;
}

export type SpawnPty = (options: PtySpawnOptions) => PtyChild;

export interface PtyTerminalsOptions {
	spawn: SpawnPty;
	/** Pier's version, for `TERM_PROGRAM_VERSION`. */
	version: string;
	/** The host's environment (default: `process.env`, read for every terminal). */
	env?: NodeJS.ProcessEnv;
	drainGraceMs?: number;
	killGraceMs?: number;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function account(): { username?: string; shell?: string } {
	try {
		const info = userInfo();
		return { username: info.username, ...(info.shell ? { shell: info.shell } : {}) };
	} catch {
		// No passwd entry for this user (some containers).
		return {};
	}
}

function size(value: number): number {
	return Math.max(2, Math.floor(value));
}

/** Shells in the host's own pseudo-terminals. */
export class PtyTerminals implements TerminalProvider {
	readonly terminals = true;
	private readonly drainGraceMs: number;
	private readonly killGraceMs: number;

	constructor(private readonly options: PtyTerminalsOptions) {
		this.drainGraceMs = options.drainGraceMs ?? DRAIN_GRACE_MS;
		this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
	}

	private get env(): NodeJS.ProcessEnv {
		return this.options.env ?? process.env;
	}

	/** The user's shell: `$SHELL`, else the account's, else `/bin/sh`. */
	private shellPath(): string {
		for (const candidate of [this.env.SHELL, account().shell]) {
			if (candidate && isAbsolute(candidate) && isExecutable(candidate)) return candidate;
		}
		return "/bin/sh";
	}

	private home(): string | undefined {
		const home = this.env.HOME || homedir();
		return home && isDirectory(home) ? home : undefined;
	}

	private environment(shell: string): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(this.env)) {
			if (value !== undefined && !HOST_ONLY_ENV.has(key)) env[key] = value;
		}
		// A system service may start without the variables a login sets.
		const home = this.home();
		if (!env.HOME && home) env.HOME = home;
		env.SHELL = shell;
		if (!env.USER || !env.LOGNAME) {
			const { username } = account();
			if (username) {
				env.USER ||= username;
				env.LOGNAME ||= username;
			}
		}
		env.TERM = "xterm-256color";
		env.COLORTERM = "truecolor";
		env.TERM_PROGRAM = "Pier";
		env.TERM_PROGRAM_VERSION = this.options.version;
		return env;
	}

	async openTerminal(options: ShellTerminalOptions, handlers: ShellTerminalHandlers): Promise<ShellTerminal> {
		const shell = this.shellPath();
		const name = basename(shell);
		const cwd = (options.cwd && isDirectory(options.cwd) ? options.cwd : undefined) ?? this.home() ?? "/";
		let ended = false;
		let reachedEnd = false;
		let hungUp = false;
		let stopped = false;
		let onEnd: (() => void) | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const child = this.options.spawn({
			file: shell,
			argv0: `-${name}`,
			cwd,
			env: this.environment(shell),
			cols: size(options.cols),
			rows: size(options.rows),
			data: (bytes) => {
				if (!ended) handlers.output(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"));
			},
			end: () => {
				reachedEnd = true;
				onEnd?.();
			},
		});

		const finish = (code: number | null) => {
			if (ended) return;
			ended = true;
			clearTimeout(killTimer);
			child.close();
			handlers.exit(code);
		};
		void child.exited.then(
			async (code) => {
				// Let the last output arrive; a program left in the background may keep the terminal open.
				if (!reachedEnd && !hungUp) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, this.drainGraceMs);
						onEnd = () => {
							clearTimeout(timer);
							resolve();
						};
					});
				}
				finish(code);
			},
			() => finish(null),
		);

		const ixon = () => (child.inputFlags & IXON) !== 0;
		return {
			shell: name,
			cwd,
			write: (data, binary) => {
				if (!ended) child.write(binary ? Buffer.from(data, "latin1") : data);
			},
			resize: (cols, rows) => {
				if (!ended) child.resize(size(cols), size(rows));
			},
			pause: (paused) => {
				if (ended || hungUp) return;
				if (paused) {
					if (stopped || !ixon()) return;
					stopped = true;
					child.write(XOFF);
				} else if (stopped) {
					stopped = false;
					// A program that turned IXON off meanwhile restarted the output, and would read XON as input.
					if (ixon()) child.write(XON);
				}
			},
			kill: () => {
				if (ended || hungUp) return;
				hungUp = true;
				child.signal("SIGHUP");
				child.close();
				killTimer = setTimeout(() => child.signal("SIGKILL"), this.killGraceMs);
				killTimer.unref?.();
			},
		};
	}
}

interface BunTerminal {
	readonly closed: boolean;
	readonly inputFlags: number;
	write(data: string | Uint8Array): number;
	resize(cols: number, rows: number): void;
	close(): void;
}

interface BunSubprocess {
	readonly terminal?: BunTerminal;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	kill(signal?: string): void;
}

interface BunRuntime {
	readonly Terminal?: unknown;
	spawn(command: string[], options: Record<string, unknown>): BunSubprocess;
}

function bunRuntime(): BunRuntime | undefined {
	const bun = (globalThis as { Bun?: BunRuntime }).Bun;
	return bun && typeof bun.Terminal === "function" && typeof bun.spawn === "function" ? bun : undefined;
}

/** Programs in Bun's pseudo-terminals. */
export function bunSpawnPty(bun: BunRuntime): SpawnPty {
	return (options) => {
		const child = bun.spawn([options.file], {
			argv0: options.argv0,
			cwd: options.cwd,
			env: options.env,
			terminal: {
				cols: options.cols,
				rows: options.rows,
				data: (_terminal: BunTerminal, data: Uint8Array) => options.data(data),
				exit: () => options.end(),
			},
		});
		const terminal = child.terminal;
		if (!terminal) {
			child.kill("SIGKILL");
			throw new Error("The shell started without a terminal");
		}
		return {
			exited: child.exited.then(() => child.exitCode),
			get inputFlags() {
				return terminal.closed ? 0 : terminal.inputFlags;
			},
			write: (data) => {
				if (!terminal.closed) terminal.write(data);
			},
			resize: (cols, rows) => {
				if (!terminal.closed) terminal.resize(cols, rows);
			},
			signal: (signal) => {
				try {
					child.kill(signal);
				} catch {
					// Already gone.
				}
			},
			close: () => {
				if (!terminal.closed) terminal.close();
			},
		};
	};
}

/**
 * The host's own terminals, when this runtime can start them (the Pier executable on Linux
 * and macOS); undefined otherwise.
 */
export function createPtyTerminals(version: string): PtyTerminals | undefined {
	if (process.platform === "win32") return undefined;
	const bun = bunRuntime();
	return bun ? new PtyTerminals({ spawn: bunSpawnPty(bun), version }) : undefined;
}
