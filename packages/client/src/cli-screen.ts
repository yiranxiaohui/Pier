/**
 * The interactive screen of pier-cli: finished output scrolls up as usual, while a live area
 * (the line being streamed, running tools, the status line and the input rule) stays just
 * above readline's prompt and is redrawn in place.
 *
 * readline keeps drawing the prompt and the typed line itself; the screen erases them with the
 * live area before printing, then has readline redraw the prompt below.
 */
import { displayWidth, fitStyled, readlineRows } from "./cli-style.ts";

export interface ScreenOutput {
	write(text: string): unknown;
	readonly columns?: number;
}

/** The part of readline's `Interface` the screen uses. */
export interface ScreenPrompt {
	readonly line: string;
	getPrompt(): string;
	getCursorPos(): { rows: number; cols: number };
	prompt(preserveCursor?: boolean): void;
}

export interface CliScreen {
	/** Columns available to a row without wrapping. */
	readonly width: number;
	/** Whether rows are redrawn in place (a terminal) or just printed. */
	readonly interactive: boolean;
	/** Print finished rows above the live area. */
	commit(rows: readonly string[]): void;
	/** Replace the live area; with `draw` false it shows with the next commit or redraw. */
	setLive(rows: readonly string[], draw?: boolean): void;
	/** Show readline's prompt below the live area from now on. */
	showPrompt(): void;
	/** readline printed the prompt and `input`, then a newline: replace them with `echo`. */
	acceptLine(input: string, echo: readonly string[]): void;
	/** Hand the terminal to `run` (an arrow-key picker), holding other output until it is done. */
	hold<T>(run: () => Promise<T>): Promise<T>;
	/**
	 * readline is writing `text` itself (its prompt, or a completion list). True when the screen
	 * took it into the frame it is drawing, which it writes in one piece; false to write it now.
	 */
	readlineWrite(text: string): boolean;
	/** The terminal was cleared (Ctrl+L): nothing of the live area is left on it. */
	cleared(): void;
	/** Remove the live area and the prompt, before exiting. */
	close(): void;
}

/** Blank rows collapsed: none at the start when `afterBlank`, never two in a row. */
function collapseBlank(rows: readonly string[], afterBlank: boolean): string[] {
	const out: string[] = [];
	let blank = afterBlank;
	for (const row of rows) {
		const isBlank = row === "";
		if (isBlank && blank) continue;
		out.push(row);
		blank = isBlank;
	}
	return out;
}

// Synchronized output (DEC mode 2026): terminals that support it show each redraw at once.
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

export class TerminalScreen implements CliScreen {
	readonly interactive = true;
	private live: string[] = [];
	/** Rows of the live area currently on the terminal, just above the prompt. */
	private drawnLive = 0;
	private promptShown = false;
	private promptWanted = false;
	/**
	 * How many rows above its cursor readline thinks its prompt starts (its `prevRows`). It moves
	 * up that far before redrawing, so the screen leaves that many rows of room first.
	 */
	private readlineAbove = 0;
	/** Newlines readline wrote since the last redraw; a completion list pushes the live area up. */
	private readlineNewlines = 0;
	private held: Array<() => void> | undefined;
	private lastBlank = true;
	/** The live area changed but was not drawn yet. */
	private dirty = false;
	/** Output of the redraw in progress, written at once so no terminal shows half a frame. */
	private frame: string[] | undefined;

	constructor(
		private readonly out: ScreenOutput,
		private readonly rl: ScreenPrompt,
	) {}

	get columns(): number {
		return Math.max(20, this.out.columns ?? 80);
	}

	get width(): number {
		return this.columns - 1;
	}

	commit(rows: readonly string[]): void {
		if (this.held) {
			this.held.push(() => this.commit(rows));
			return;
		}
		const kept = collapseBlank(rows, this.lastBlank);
		if (!kept.length) {
			if (this.dirty) this.redraw("");
			return;
		}
		this.lastBlank = kept[kept.length - 1] === "";
		this.redraw(kept.map((row) => `${row}\n`).join(""));
	}

	setLive(rows: readonly string[], draw = true): void {
		const same = rows.length === this.live.length && rows.every((row, i) => row === this.live[i]);
		if (same) return;
		this.live = [...rows];
		if (draw && !this.held) this.redraw("");
		else this.dirty = true;
	}

	showPrompt(): void {
		this.promptWanted = true;
		if (!this.held && !this.promptShown) this.redraw("");
	}

	acceptLine(input: string, echo: readonly string[]): void {
		// readline wrote the prompt and the line, then "\r\n" (one newline of its own).
		const echoed = readlineRows(this.rl.getPrompt() + input, this.columns) + 1;
		const above = this.readlineNewlines > 1 ? 0 : this.drawnLive;
		this.batch(() => {
			this.moveUpAndClear(echoed + above);
			this.drawnLive = 0;
			this.promptShown = false;
			this.readlineAbove = 0;
			this.readlineNewlines = 0;
			const kept = collapseBlank(echo, this.lastBlank);
			if (kept.length) this.lastBlank = kept[kept.length - 1] === "";
			this.write(kept.map((row) => `${row}\n`).join(""));
			if (!this.held) this.draw();
		});
	}

	async hold<T>(run: () => Promise<T>): Promise<T> {
		if (this.held) return run();
		this.batch(() => this.erase());
		this.held = [];
		try {
			return await run();
		} finally {
			const held = this.held;
			this.held = undefined;
			for (const flush of held) flush();
			this.redraw("");
		}
	}

	readlineWrite(text: string): boolean {
		if (text.includes("\n")) this.readlineNewlines++;
		if (!this.frame) return false;
		this.frame.push(text);
		return true;
	}

	cleared(): void {
		this.drawnLive = 0;
		this.readlineNewlines = 0;
		this.lastBlank = true;
		if (this.promptShown) this.redraw("");
	}

	close(): void {
		this.promptWanted = false;
		this.live = [];
		if (!this.held) this.redraw("");
	}

	private write(text: string): void {
		if (this.frame) this.frame.push(text);
		else this.out.write(text);
	}

	/** Run `draw`, collecting everything it (and readline) writes into one write. */
	private batch(draw: () => void): void {
		if (this.frame) {
			draw();
			return;
		}
		this.frame = [SYNC_START];
		try {
			draw();
		} finally {
			const text = [...this.frame, SYNC_END].join("");
			this.frame = undefined;
			this.out.write(text);
		}
	}

	private moveUpAndClear(rows: number): void {
		this.write(`${rows > 0 ? `\x1b[${rows}A` : ""}\r\x1b[J`);
	}

	/** Remove the live area and the prompt, leaving the cursor where the live area began. */
	private erase(): void {
		// After a completion list the old live area is above the list: leave it there.
		let up = this.readlineNewlines > 0 ? 0 : this.drawnLive;
		if (this.promptShown) {
			this.readlineAbove = this.rl.getCursorPos().rows;
			up += this.readlineAbove;
		}
		this.moveUpAndClear(up);
		this.drawnLive = 0;
		this.promptShown = false;
		this.readlineNewlines = 0;
	}

	private draw(): void {
		this.dirty = false;
		const rows = collapseBlank(this.live, this.lastBlank).map((row) =>
			displayWidth(row) > this.width ? fitStyled(row, this.width) : row,
		);
		this.write(rows.map((row) => `${row}\n`).join(""));
		this.drawnLive = rows.length;
		if (this.promptWanted) {
			this.write("\n".repeat(this.readlineAbove));
			this.rl.prompt(true);
			this.promptShown = true;
			this.readlineNewlines = 0;
		}
	}

	private redraw(text: string): void {
		this.batch(() => {
			this.erase();
			this.write(text);
			this.draw();
		});
	}
}

/** Output to a pipe or file: rows are printed as they finish, with no live area or prompt. */
export class PlainScreen implements CliScreen {
	readonly interactive = false;
	readonly width = Number.POSITIVE_INFINITY;
	private lastBlank = true;

	constructor(private readonly out: ScreenOutput) {}

	commit(rows: readonly string[]): void {
		const kept = collapseBlank(rows, this.lastBlank);
		if (!kept.length) return;
		this.lastBlank = kept[kept.length - 1] === "";
		this.out.write(kept.map((row) => `${row}\n`).join(""));
	}

	setLive(_rows: readonly string[], _draw?: boolean): void {}

	showPrompt(): void {}

	acceptLine(_input: string, _echo: readonly string[]): void {}

	hold<T>(run: () => Promise<T>): Promise<T> {
		return run();
	}

	readlineWrite(_text: string): boolean {
		return false;
	}

	cleared(): void {}

	close(): void {}
}
