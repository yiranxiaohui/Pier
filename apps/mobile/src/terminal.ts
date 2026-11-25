/**
 * Shells the connected computer runs for the phone (`terminal.*`, protocol 1.18), emulated with
 * `@xterm/headless` and rendered as styled text lines.
 *
 * A remote terminal belongs to the connection that opened it: when the connection drops, the
 * computer hangs the shell up, so the terminal ends with an explanation.
 */

import type { PierClient } from "@pier/client";
// The package's `module` field names a missing file; use its CommonJS build (see xterm-headless.d.ts).
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.js";
import { base64ToBytes } from "./bytes.ts";
import { TERMINAL_COLORS } from "./terminal-colors.ts";

/** Keep each `terminal.write` well under the protocol's 1 MB limit. */
const WRITE_CHUNK = 64 * 1024;
/** Lines kept above the screen. */
const SCROLLBACK = 2000;
/** Lines rendered at most (the newest ones). */
const MAX_RENDERED_LINES = 600;

export interface TerminalSpan {
	text: string;
	fg?: string;
	bg?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dim?: boolean;
}

export interface TerminalLine {
	key: number;
	spans: TerminalSpan[];
}

export type TerminalStatus = "starting" | "running" | "exited";

/** The 16 ANSI colors, tuned for a dark background. */
const ANSI = [
	"#2e3436",
	"#ef6b6b",
	"#7fd87a",
	"#e8c35a",
	"#6ea8ff",
	"#d38cf0",
	"#4fd6c8",
	"#d3d7cf",
	"#6b7280",
	"#ff8f8f",
	"#a3ee9c",
	"#ffe08a",
	"#9cc3ff",
	"#e9b3ff",
	"#8ff0e5",
	"#ffffff",
];

function hex(n: number): string {
	return `#${n.toString(16).padStart(6, "0")}`;
}

/** Color of xterm's 256-color palette entry `index`. */
export function paletteColor(index: number): string {
	if (index < 16) return ANSI[index] as string;
	if (index < 232) {
		const n = index - 16;
		const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		const r = level(Math.floor(n / 36));
		const g = level(Math.floor(n / 6) % 6);
		const b = level(n % 6);
		return hex((r << 16) | (g << 8) | b);
	}
	const gray = 8 + (index - 232) * 10;
	return hex((gray << 16) | (gray << 8) | gray);
}

/** Split text into chunks of at most `size` UTF-16 units without breaking surrogate pairs. */
export function chunkText(text: string, size = WRITE_CHUNK): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + size, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}

/** Control character for Ctrl+`key` (`c` → ETX), or undefined when there is none. */
export function controlKey(key: string): string | undefined {
	if (key.length !== 1) return undefined;
	const upper = key.toUpperCase();
	const code = upper.charCodeAt(0);
	if (code >= 64 && code <= 95) return String.fromCharCode(code - 64); // @, A–Z, [, \, ], ^, _
	if (key === "?") return "\x7f";
	if (key === " ") return "\x00";
	return undefined;
}

function styleKey(span: TerminalSpan): string {
	return `${span.fg ?? ""}|${span.bg ?? ""}|${span.bold ? 1 : 0}${span.italic ? 1 : 0}${span.underline ? 1 : 0}${span.dim ? 1 : 0}`;
}

const PLAIN = styleKey({ text: " " });

export type SpecialKey = "up" | "down" | "left" | "right" | "home" | "end" | "pageUp" | "pageDown";

export class RemoteTerminal {
	readonly id: number;
	terminalId: string | undefined;
	shell = "";
	cwd: string;
	status: TerminalStatus = "starting";
	exitCode: number | null = null;
	/** Why the terminal ended unexpectedly (connection lost, start failed). */
	error: string | undefined;
	title: string;
	/** Bumped on every change, for renders. */
	version = 0;
	cols: number;
	rows: number;
	private readonly term: Terminal;
	private readonly listeners = new Set<() => void>();
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private lines: TerminalLine[] | undefined;

	constructor(
		id: number,
		private readonly client: Pick<PierClient, "request">,
		options: { cwd?: string; cols: number; rows: number; title: string },
	) {
		this.id = id;
		this.cwd = options.cwd ?? "";
		this.title = options.title;
		this.cols = options.cols;
		this.rows = options.rows;
		this.term = new Terminal({
			cols: this.cols,
			rows: this.rows,
			scrollback: SCROLLBACK,
			allowProposedApi: true,
			convertEol: false,
		});
		// Replies to the shell's terminal queries (cursor position, device attributes, …).
		this.term.onData((data) => void this.send(data));
		this.term.onTitleChange((title) => {
			if (title) {
				this.title = title;
				this.changed();
			}
		});
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	/** Coalesce redraws while output streams in. */
	private changed(immediate = false): void {
		this.lines = undefined;
		if (immediate) {
			clearTimeout(this.notifyTimer);
			this.notifyTimer = undefined;
			this.emit();
			return;
		}
		if (this.notifyTimer) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			this.emit();
		}, 40);
	}

	private emit(): void {
		this.version += 1;
		for (const listener of [...this.listeners]) listener();
	}

	/** Start the shell on the computer. */
	async open(): Promise<void> {
		try {
			const result = await this.client.request("terminal.open", {
				...(this.cwd ? { cwd: this.cwd } : {}),
				cols: this.cols,
				rows: this.rows,
			});
			this.terminalId = result.terminalId;
			this.shell = result.shell;
			this.cwd = result.cwd;
			if (this.status === "starting") this.status = "running";
		} catch (error) {
			this.status = "exited";
			this.error = `无法打开终端：${error instanceof Error ? error.message : String(error)}`;
		}
		this.changed(true);
	}

	/** Raw output bytes (base64) from the computer. */
	output(data: string): void {
		this.term.write(base64ToBytes(data), () => this.changed());
	}

	exited(code: number | null, error?: string): void {
		if (this.status === "exited") return;
		this.status = "exited";
		this.exitCode = code;
		if (error) this.error = error;
		this.changed(true);
	}

	/** Send input to the shell. */
	async send(data: string): Promise<void> {
		const terminalId = this.terminalId;
		if (!terminalId || this.status !== "running" || !data) return;
		try {
			for (const chunk of chunkText(data)) {
				await this.client.request("terminal.write", { terminalId, data: chunk });
			}
		} catch {
			// The exit event explains a dead terminal.
		}
	}

	/** The escape sequence for a navigation key, honoring the application cursor mode. */
	keySequence(key: SpecialKey): string {
		const app = this.term.modes.applicationCursorKeysMode;
		const arrows: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
		const letter = arrows[key];
		if (letter) return app ? `\x1bO${letter}` : `\x1b[${letter}`;
		return key === "pageUp" ? "\x1b[5~" : "\x1b[6~";
	}

	resize(cols: number, rows: number): void {
		const c = Math.min(1000, Math.max(20, Math.floor(cols)));
		const r = Math.min(1000, Math.max(5, Math.floor(rows)));
		if (c === this.cols && r === this.rows) return;
		this.cols = c;
		this.rows = r;
		this.term.resize(c, r);
		this.changed(true);
		const terminalId = this.terminalId;
		if (terminalId && this.status === "running") {
			void this.client.request("terminal.resize", { terminalId, cols: c, rows: r }).catch(() => undefined);
		}
	}

	/** Hang up the shell. */
	async close(): Promise<void> {
		const terminalId = this.terminalId;
		if (!terminalId || this.status !== "running") return;
		try {
			await this.client.request("terminal.close", { terminalId });
		} catch {
			this.exited(null);
		}
	}

	dispose(): void {
		clearTimeout(this.notifyTimer);
		this.listeners.clear();
		this.term.dispose();
	}

	/** The newest lines of the screen and scrollback, as styled spans, with the cursor. */
	render(): TerminalLine[] {
		if (this.lines) return this.lines;
		const buffer = this.term.buffer.active;
		const cell = buffer.getNullCell();
		const cursorLine = this.status === "running" ? buffer.baseY + buffer.cursorY : -1;
		// Drop empty lines below the cursor (an idle shell fills only the top of the screen).
		let end = buffer.length;
		while (end > cursorLine + 1 && end > 0 && !buffer.getLine(end - 1)?.translateToString(true)) end--;
		const start = Math.max(0, end - MAX_RENDERED_LINES);
		const lines: TerminalLine[] = [];
		for (let y = start; y < end; y++) {
			const line = buffer.getLine(y);
			const spans: TerminalSpan[] = [];
			if (line) {
				const text = line.translateToString(true);
				const width = y === cursorLine ? Math.max(text.length, buffer.cursorX + 1) : this.cols;
				let current: TerminalSpan | undefined;
				let currentKey = "";
				let blankRun = "";
				for (let x = 0; x < Math.min(width, this.cols); x++) {
					if (!line.getCell(x, cell)) break;
					if (cell.getWidth() === 0) continue;
					const chars = cell.getChars() || " ";
					let fg = cell.isFgDefault()
						? undefined
						: cell.isFgRGB()
							? hex(cell.getFgColor())
							: paletteColor(cell.getFgColor());
					let bg = cell.isBgDefault()
						? undefined
						: cell.isBgRGB()
							? hex(cell.getBgColor())
							: paletteColor(cell.getBgColor());
					if (cell.isInverse()) {
						[fg, bg] = [bg ?? TERMINAL_COLORS.background, fg ?? TERMINAL_COLORS.foreground];
					}
					if (x === buffer.cursorX && y === cursorLine) {
						fg = TERMINAL_COLORS.onCursor;
						bg = TERMINAL_COLORS.cursor;
					}
					const span: TerminalSpan = { text: chars };
					if (fg) span.fg = fg;
					if (bg) span.bg = bg;
					if (cell.isBold()) span.bold = true;
					if (cell.isItalic()) span.italic = true;
					if (cell.isUnderline()) span.underline = true;
					if (cell.isDim()) span.dim = true;
					const key = styleKey(span);
					// Trailing default blanks are trimmed: hold them until something follows.
					if (chars === " " && !bg && !span.underline) {
						blankRun += " ";
						continue;
					}
					if (blankRun) {
						if (current && currentKey === PLAIN) current.text += blankRun;
						else {
							current = { text: blankRun };
							currentKey = PLAIN;
							spans.push(current);
						}
						blankRun = "";
					}
					if (current && key === currentKey) current.text += chars;
					else {
						current = span;
						currentKey = key;
						spans.push(span);
					}
				}
			}
			lines.push({ key: y, spans });
		}
		this.lines = lines;
		return lines;
	}
}
