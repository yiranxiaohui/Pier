/**
 * Terminals for clients (`terminal.*`, 1.18): shells in the desktop app's pseudo-terminals, or
 * in the host's own when it runs without the app (`pty-terminals.ts`), each owned by the
 * connection that opened it.
 *
 * A terminal's output and end go only to its connection, and it is hung up when that
 * connection closes. Output the shell produces before the `terminal.open` response is sent is
 * held back, so the client always learns the terminal id first.
 *
 * Output is flow-controlled: while too much is queued for the connection (a slow network),
 * the app stops reading the shell's output, so `cat` of a huge file slows down instead of
 * overflowing the connection.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { type EventFrame, type PierHostEvent, PierProtocolError, type TerminalInfo } from "@pier/protocol";
import type { Connection } from "./connection.ts";
import type { ShellTerminal, TerminalProvider } from "./shell.ts";

/** Open terminals one connection may have. */
export const MAX_TERMINALS_PER_CONNECTION = 16;
/** Open terminals on the host. */
export const MAX_TERMINALS = 64;
/** Pause a terminal's output while more than this is queued for its connection. */
export const PAUSE_BUFFERED_BYTES = 2 * 1024 * 1024;
/** Resume once the queue is below this. */
export const RESUME_BUFFERED_BYTES = 512 * 1024;

export interface HostTerminalsOptions {
	log?: (message: string) => void;
	pauseAt?: number;
	resumeAt?: number;
	/** How often a paused terminal checks whether its connection caught up. */
	pollMs?: number;
}

interface TerminalRecord {
	connection: Connection;
	terminal?: ShellTerminal;
	/** Events held back until the `terminal.open` response is out; undefined once live. */
	held: PierHostEvent[] | undefined;
	ended: boolean;
	/** Set while output is paused for flow control. */
	resumeTimer?: ReturnType<typeof setInterval>;
}

export interface OpenTerminalParams {
	cwd?: string | undefined;
	cols: number;
	rows: number;
}

export class HostTerminals {
	private readonly terminals = new Map<string, TerminalRecord>();
	private closed = false;
	private readonly log: (message: string) => void;
	private readonly pauseAt: number;
	private readonly resumeAt: number;
	private readonly pollMs: number;

	constructor(
		private readonly provider: TerminalProvider | undefined,
		options: HostTerminalsOptions = {},
	) {
		this.log = options.log ?? (() => {});
		this.pauseAt = options.pauseAt ?? PAUSE_BUFFERED_BYTES;
		this.resumeAt = options.resumeAt ?? RESUME_BUFFERED_BYTES;
		this.pollMs = options.pollMs ?? 50;
	}

	/** Whether clients can open terminals here. */
	get supported(): boolean {
		return !this.closed && this.provider?.terminals === true && this.provider.openTerminal !== undefined;
	}

	get count(): number {
		return this.terminals.size;
	}

	/**
	 * Start a shell for `connection`. Call the returned `start` after the response went out:
	 * it delivers what the shell printed meanwhile.
	 */
	async open(connection: Connection, params: OpenTerminalParams): Promise<{ info: TerminalInfo; start: () => void }> {
		const provider = this.provider;
		if (!this.supported || !provider?.openTerminal) {
			throw new PierProtocolError(
				"UNSUPPORTED",
				"This computer cannot open terminals: Pier runs there without its desktop app where it cannot start pseudo-terminals itself (Windows), or Pier is too old",
			);
		}
		if (params.cwd !== undefined && !isAbsolute(params.cwd)) {
			throw new PierProtocolError("BAD_REQUEST", "The terminal directory must be an absolute path");
		}
		if (this.terminals.size >= MAX_TERMINALS) {
			throw new PierProtocolError("CONFLICT", `Too many open terminals (at most ${MAX_TERMINALS})`);
		}
		let own = 0;
		for (const record of this.terminals.values()) if (record.connection === connection) own++;
		if (own >= MAX_TERMINALS_PER_CONNECTION) {
			throw new PierProtocolError(
				"CONFLICT",
				`Too many open terminals on this connection (at most ${MAX_TERMINALS_PER_CONNECTION})`,
			);
		}

		const terminalId = randomUUID();
		const record: TerminalRecord = { connection, held: [], ended: false };
		this.terminals.set(terminalId, record);
		let terminal: ShellTerminal;
		try {
			terminal = await provider.openTerminal(
				{ ...(params.cwd ? { cwd: params.cwd } : {}), cols: params.cols, rows: params.rows },
				{
					output: (data) => this.deliver(terminalId, record, { type: "terminal.output", terminalId, data }),
					exit: (code, error) => {
						if (record.ended) return;
						record.ended = true;
						this.stopFlowControl(record);
						this.terminals.delete(terminalId);
						this.deliver(terminalId, record, {
							type: "terminal.exit",
							terminalId,
							code,
							...(error ? { error } : {}),
						});
					},
				},
			);
		} catch (error) {
			this.terminals.delete(terminalId);
			record.ended = true;
			throw new PierProtocolError(
				"INTERNAL",
				`Could not start the terminal: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (connection.isClosed || this.closed) {
			// The client went away (or the host is stopping) while the shell started.
			terminal.kill();
			this.terminals.delete(terminalId);
			record.ended = true;
			throw new PierProtocolError("CONFLICT", "The connection closed");
		}
		record.terminal = terminal;
		const who = connection.device ? `device ${connection.device.name}` : "a local client";
		this.log(`terminal ${terminalId} opened for ${who} (${terminal.shell} in ${terminal.cwd})`);
		return {
			info: { terminalId, shell: terminal.shell, cwd: terminal.cwd },
			start: () => {
				const held = record.held ?? [];
				record.held = undefined;
				for (const event of held) this.send(connection, event);
				this.throttle(record);
			},
		};
	}

	private deliver(terminalId: string, record: TerminalRecord, event: PierHostEvent): void {
		if (record.held) {
			record.held.push(event);
			return;
		}
		this.send(record.connection, event);
		if (event.type === "terminal.exit") this.log(`terminal ${terminalId} ended (${event.code ?? "no code"})`);
		else this.throttle(record);
	}

	/** Pause the shell's output while its connection has too much queued; resume once it drained. */
	private throttle(record: TerminalRecord): void {
		const terminal = record.terminal;
		if (!terminal || record.ended || record.resumeTimer || record.connection.bufferedAmount <= this.pauseAt) return;
		terminal.pause(true);
		record.resumeTimer = setInterval(() => {
			if (record.ended || record.connection.isClosed) {
				this.stopFlowControl(record);
				return;
			}
			if (record.connection.bufferedAmount > this.resumeAt) return;
			this.stopFlowControl(record);
			terminal.pause(false);
		}, this.pollMs);
		record.resumeTimer.unref?.();
	}

	private stopFlowControl(record: TerminalRecord): void {
		clearInterval(record.resumeTimer);
		record.resumeTimer = undefined;
	}

	private send(connection: Connection, event: PierHostEvent): void {
		const frame: EventFrame = { type: "evt", event };
		connection.send(frame);
	}

	private require(connection: Connection, terminalId: string): ShellTerminal | undefined {
		const record = this.terminals.get(terminalId);
		if (!record || record.connection !== connection) {
			throw new PierProtocolError("NOT_FOUND", `Terminal ${terminalId} not found`);
		}
		return record.ended ? undefined : record.terminal;
	}

	write(connection: Connection, terminalId: string, data: string, binary: boolean): boolean {
		const terminal = this.require(connection, terminalId);
		terminal?.write(data, binary);
		return terminal !== undefined;
	}

	resize(connection: Connection, terminalId: string, cols: number, rows: number): boolean {
		const terminal = this.require(connection, terminalId);
		terminal?.resize(cols, rows);
		return terminal !== undefined;
	}

	close(connection: Connection, terminalId: string): boolean {
		const record = this.terminals.get(terminalId);
		if (!record || record.connection !== connection) return false;
		record.terminal?.kill();
		return true;
	}

	/** Hang up the terminals of a connection that closed. */
	connectionClosed(connection: Connection): void {
		for (const record of this.terminals.values()) {
			if (record.connection === connection) record.terminal?.kill();
		}
	}

	/** Hang up every terminal (host shutdown). */
	shutdown(): void {
		this.closed = true;
		for (const record of this.terminals.values()) {
			this.stopFlowControl(record);
			record.terminal?.kill();
		}
	}
}
