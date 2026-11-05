import { afterEach, describe, expect, it } from "vitest";
import {
	c,
	charWidth,
	detectColorLevel,
	displayWidth,
	fitStyled,
	padWidth,
	readlineRows,
	sanitize,
	setColorLevel,
	stripAnsi,
} from "../src/cli-style.ts";

afterEach(() => setColorLevel(0));

describe("detectColorLevel", () => {
	it("follows NO_COLOR, FORCE_COLOR, COLORTERM and TERM", () => {
		expect(detectColorLevel({ TERM: "xterm-256color" }, true)).toBe(2);
		expect(detectColorLevel({ TERM: "xterm", COLORTERM: "truecolor" }, true)).toBe(3);
		expect(detectColorLevel({ TERM: "xterm" }, true)).toBe(1);
		expect(detectColorLevel({ TERM: "xterm-256color", NO_COLOR: "1" }, true)).toBe(0);
		expect(detectColorLevel({ TERM: "dumb" }, true)).toBe(0);
		expect(detectColorLevel({ TERM: "xterm-256color" }, false)).toBe(0);
		expect(detectColorLevel({ FORCE_COLOR: "1" }, false)).toBe(1);
		expect(detectColorLevel({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true)).toBe(0);
	});

	it("styles text only when colors are on", () => {
		expect(c.accent("pier")).toBe("pier");
		setColorLevel(3);
		expect(c.accent("pier")).toBe("\x1b[38;2;43;188;172mpier\x1b[39m");
		setColorLevel(2);
		expect(c.accent("pier")).toBe("\x1b[38;5;37mpier\x1b[39m");
		setColorLevel(1);
		expect(c.bold(c.red("x"))).toBe("\x1b[1m\x1b[31mx\x1b[39m\x1b[22m");
		expect(c.red("")).toBe("");
	});
});

describe("text from the host", () => {
	it("loses escape sequences and control characters", () => {
		expect(sanitize("a\x1b[2J\x1b]0;title\x07b\x07c\x00d")).toBe("abcd");
		expect(sanitize("tab\there\r\nnext")).toBe("tab    here\nnext");
		expect(sanitize("50%\r100%\ndone", true)).toBe("100%\ndone");
		expect(sanitize("keep\r", true)).toBe("keep");
		expect(stripAnsi("\x1b[1mbold\x1b[22m")).toBe("bold");
	});
});

describe("widths", () => {
	it("counts terminal columns", () => {
		expect(displayWidth("abc")).toBe(3);
		expect(displayWidth("中文")).toBe(4);
		expect(displayWidth("✅ ok")).toBe(5);
		expect(displayWidth("é")).toBe(1);
		expect(displayWidth("\x1b[31mred\x1b[39m")).toBe(3);
		expect(charWidth("😀".codePointAt(0) as number)).toBe(2);
		expect(charWidth("●".codePointAt(0) as number)).toBe(1);
	});

	it("cuts styled text without breaking its escape sequences", () => {
		setColorLevel(1);
		const cut = fitStyled(c.red("abcdef"), 4);
		expect(stripAnsi(cut)).toBe("abc…");
		expect(cut.startsWith("\x1b[31m")).toBe(true);
		expect(cut.endsWith("\x1b[0m")).toBe(true);
		expect(fitStyled("short", 10)).toBe("short");
		expect(padWidth("中", 4)).toBe("中  ");
	});

	it("counts the rows readline's cursor moves down, like readline does", () => {
		expect(readlineRows("❯ hello", 80)).toBe(0);
		expect(readlineRows("x".repeat(80), 80)).toBe(1);
		expect(readlineRows("x".repeat(79), 80)).toBe(0);
		expect(readlineRows("x".repeat(170), 80)).toBe(2);
		// A wide character that would straddle the edge starts the next row.
		expect(readlineRows(`${"x".repeat(9)}中`, 10)).toBe(1);
		expect(readlineRows("a\nb", 80)).toBe(1);
	});
});
