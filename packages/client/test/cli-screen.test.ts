import { describe, expect, it } from "vitest";
import { PlainScreen, type ScreenPrompt, TerminalScreen } from "../src/cli-screen.ts";

/** Just enough of a terminal for the screen: text, CR, LF, cursor up and erase below. */
class FakeTerminal {
	readonly columns = 80;
	private lines: string[] = [""];
	row = 0;
	private col = 0;

	write(text: string): boolean {
		for (let i = 0; i < text.length; i++) {
			const csi = text.startsWith("\x1b[", i) ? /^\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i + 1)) : null;
			if (csi) {
				const [all, params, final] = csi as unknown as [string, string, string];
				if (final === "A") this.row = Math.max(0, this.row - (Number(params) || 1));
				if (final === "J") {
					this.lines[this.row] = (this.lines[this.row] ?? "").slice(0, this.col);
					this.lines.length = this.row + 1;
				}
				i += all.length;
				continue;
			}
			const char = text[i] as string;
			if (char === "\n") {
				this.row++;
				this.col = 0;
				while (this.lines.length <= this.row) this.lines.push("");
			} else if (char === "\r") this.col = 0;
			else {
				const line = (this.lines[this.row] ?? "").padEnd(this.col);
				this.lines[this.row] = line.slice(0, this.col) + char + line.slice(this.col + 1);
				this.col++;
			}
		}
		return true;
	}

	get screen(): string[] {
		const lines = this.lines.map((line) => line.trimEnd());
		while (lines.length > 1 && lines[lines.length - 1] === "" && lines.length - 1 > this.row) lines.pop();
		return lines;
	}
}

/** readline's prompt; like the real one, it offers what it writes to the screen first. */
class FakePrompt implements ScreenPrompt {
	line = "";
	screen: TerminalScreen | undefined;
	constructor(private readonly term: FakeTerminal) {}
	private write(text: string): void {
		if (!this.screen?.readlineWrite(text)) this.term.write(text);
	}
	getPrompt(): string {
		return "❯ ";
	}
	getCursorPos(): { rows: number; cols: number } {
		return { rows: 0, cols: 2 + this.line.length };
	}
	prompt(): void {
		this.write(`\r\x1b[J❯ ${this.line}`);
	}
	type(text: string): void {
		this.line += text;
		this.write(text);
	}
	/** Enter: readline moves to the next row, then emits "line". */
	enter(): string {
		const line = this.line;
		this.write("\r\n");
		this.line = "";
		return line;
	}
	list(text: string): void {
		this.write(text);
		this.prompt();
	}
}

function setup() {
	const term = new FakeTerminal();
	const rl = new FakePrompt(term);
	const screen = new TerminalScreen(term, rl);
	rl.screen = screen;
	return { term, rl, screen };
}

describe("TerminalScreen", () => {
	it("keeps the live area and the prompt below everything printed", () => {
		const { term, rl, screen } = setup();
		screen.setLive(["── rule ─"]);
		screen.showPrompt();
		expect(term.screen).toEqual(["── rule ─", "❯"]);
		rl.type("hel");
		screen.commit(["first", "second"]);
		expect(term.screen).toEqual(["first", "second", "── rule ─", "❯ hel"]);
		screen.setLive(["⠋ Working…", "── rule ─"]);
		expect(term.screen).toEqual(["first", "second", "⠋ Working…", "── rule ─", "❯ hel"]);
		screen.setLive(["── rule ─"]);
		expect(term.screen).toEqual(["first", "second", "── rule ─", "❯ hel"]);
	});

	it("replaces readline's echo of an entered line, and the live area above it, with the echo given", () => {
		const { term, rl, screen } = setup();
		screen.setLive(["── rule ─"]);
		screen.showPrompt();
		rl.type("hello");
		screen.acceptLine(rl.enter(), ["", "❯ hello"]);
		// A blank row at the very top is dropped.
		expect(term.screen).toEqual(["❯ hello", "── rule ─", "❯"]);
		screen.commit(["  ⎿  done"]);
		expect(term.screen).toEqual(["❯ hello", "  ⎿  done", "── rule ─", "❯"]);
	});

	it("collapses blank rows between commits", () => {
		const { term, screen } = setup();
		screen.commit(["a", ""]);
		screen.commit(["", "", "b"]);
		expect(term.screen.slice(0, 3)).toEqual(["a", "", "b"]);
	});

	it("draws a live area set without drawing with the next commit", () => {
		const { term, screen } = setup();
		screen.showPrompt();
		screen.setLive(["live"], false);
		expect(term.screen).toEqual(["❯"]);
		screen.commit([]);
		expect(term.screen).toEqual(["live", "❯"]);
	});

	it("holds output while a picker has the terminal", async () => {
		const { term, screen } = setup();
		screen.setLive(["── rule ─"]);
		screen.showPrompt();
		let release: () => void = () => {};
		const held = screen.hold(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		expect(term.screen).toEqual([""]);
		screen.commit(["arrived meanwhile"]);
		expect(term.screen).toEqual([""]);
		release();
		await held;
		expect(term.screen).toEqual(["arrived meanwhile", "── rule ─", "❯"]);
	});

	it("leaves a list readline printed below the prompt alone", () => {
		const { term, rl, screen } = setup();
		screen.setLive(["── rule ─"]);
		screen.showPrompt();
		rl.list("\r\n/models  /model\r\n");
		screen.commit(["next"]);
		expect(term.screen).toEqual(["── rule ─", "❯", "/models  /model", "next", "── rule ─", "❯"]);
	});

	it("writes each redraw, readline's part included, at once", () => {
		const term = new FakeTerminal();
		const writes: string[] = [];
		const out = { columns: 80, write: (text: string) => writes.push(text) && term.write(text) };
		const rl = new FakePrompt(term);
		const screen = new TerminalScreen(out, rl);
		rl.screen = screen;
		screen.setLive(["── rule ─"]);
		screen.showPrompt();
		writes.length = 0;
		screen.commit(["one"]);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.startsWith("\x1b[?2026h")).toBe(true);
		expect(writes[0]?.endsWith("❯ \x1b[?2026l")).toBe(true);
		expect(writes[0]).toContain("one\n── rule ─\n");
		expect(term.screen).toEqual(["one", "── rule ─", "❯"]);
	});

	it("removes the live area and the prompt on close", () => {
		const { term, screen } = setup();
		screen.commit(["kept"]);
		screen.setLive(["── rule ─"]);
		screen.showPrompt();
		screen.close();
		expect(term.screen).toEqual(["kept", ""]);
	});
});

describe("PlainScreen", () => {
	it("prints finished rows only", () => {
		let out = "";
		const screen = new PlainScreen({ write: (text: string) => (out += text) });
		screen.setLive(["live"]);
		screen.showPrompt();
		screen.commit(["", "a"]);
		screen.commit(["", "", "b"]);
		expect(out).toBe("a\n\nb\n");
		expect(screen.width).toBe(Number.POSITIVE_INFINITY);
	});
});
