/**
 * Terminal styling for pier-cli: colors that follow the terminal's capabilities and NO_COLOR,
 * and measuring text by terminal columns. Pure, so it can be tested without a terminal.
 */

/** 0: no color, 1: the 16 ANSI colors, 2: 256 colors, 3: 24-bit color. */
export type ColorLevel = 0 | 1 | 2 | 3;

/** How many colors to use, following NO_COLOR / FORCE_COLOR, COLORTERM and TERM. */
export function detectColorLevel(env: Record<string, string | undefined>, isTTY: boolean): ColorLevel {
	if (env.NO_COLOR) return 0;
	const force = env.FORCE_COLOR;
	if (force === "0" || force === "false") return 0;
	if (force === undefined && (!isTTY || env.TERM === "dumb")) return 0;
	if (force === "3" || /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return 3;
	if (force === "2" || /256/.test(env.TERM ?? "")) return 2;
	return 1;
}

let level: ColorLevel = 0;

/** Colors are off until the CLI decides what the terminal supports. */
export function setColorLevel(next: ColorLevel): void {
	level = next;
}

export function colorLevel(): ColorLevel {
	return level;
}

type Style = (text: string) => string;

const sgr =
	(open: string, close: string): Style =>
	(text) =>
		level === 0 || !text ? text : `\x1b[${open}m${text}\x1b[${close}m`;

interface Hue {
	rgb: [number, number, number];
	ansi256: number;
	ansi16: number;
}

const fg =
	(hue: Hue): Style =>
	(text) => {
		if (level === 0 || !text) return text;
		const open = level === 3 ? `38;2;${hue.rgb.join(";")}` : level === 2 ? `38;5;${hue.ansi256}` : String(hue.ansi16);
		return `\x1b[${open}m${text}\x1b[39m`;
	};

/** Pier's palette: the brand teal of the icon, plus colors that read on dark and light backgrounds. */
export const c = {
	bold: sgr("1", "22"),
	dim: sgr("2", "22"),
	italic: sgr("3", "23"),
	underline: sgr("4", "24"),
	accent: fg({ rgb: [43, 188, 172], ansi256: 37, ansi16: 36 }),
	green: fg({ rgb: [80, 190, 110], ansi256: 71, ansi16: 32 }),
	red: fg({ rgb: [240, 96, 96], ansi256: 203, ansi16: 31 }),
	yellow: fg({ rgb: [218, 170, 60], ansi256: 178, ansi16: 33 }),
	gray: fg({ rgb: [138, 145, 158], ansi256: 245, ansi16: 90 }),
	code: fg({ rgb: [180, 150, 235], ansi256: 141, ansi16: 35 }),
	link: fg({ rgb: [100, 160, 250], ansi256: 75, ansi16: 34 }),
} satisfies Record<string, Style>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it matches
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/**
 * Text from the host (model output, tool output, names) with terminal escape sequences and
 * control characters removed, so it cannot move the cursor or restyle the terminal. Tabs
 * become spaces; with `overwrite`, a carriage return keeps only what was written after it
 * (progress bars in tool output).
 */
export function sanitize(text: string, overwrite = false): string {
	let out = stripAnsi(text).replace(/\r\n/g, "\n");
	if (overwrite) out = out.replace(/[^\n]*\r(?=[^\n])/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
	return out.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Emoji below U+1F300 that terminals draw two columns wide (East Asian Width "W"). */
const WIDE_SYMBOLS: ReadonlyArray<readonly [number, number]> = [
	[0x231a, 0x231b],
	[0x2329, 0x232a],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f2ff],
];

/** Terminal columns a code point takes: 0 for controls and combining marks, 2 for East Asian wide and emoji. */
export function charWidth(codePoint: number): 0 | 1 | 2 {
	if (
		codePoint < 0x20 ||
		(codePoint >= 0x7f && codePoint < 0xa0) ||
		(codePoint >= 0x300 && codePoint <= 0x36f) ||
		(codePoint >= 0x200b && codePoint <= 0x200f) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
		(codePoint >= 0xe0100 && codePoint <= 0xe01ef)
	)
		return 0;
	const wide =
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd) ||
		(codePoint >= 0x231a &&
			codePoint <= 0x2b55 &&
			WIDE_SYMBOLS.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)) ||
		(codePoint >= 0x1f004 &&
			codePoint < 0x1f300 &&
			WIDE_SYMBOLS.some(([lo, hi]) => codePoint >= lo && codePoint <= hi));
	return wide ? 2 : 1;
}

/** Terminal columns `text` takes; escape sequences take none. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) width += charWidth(char.codePointAt(0) ?? 0);
	return width;
}

/** Cut plain `text` to at most `width` terminal columns, ending with `…` when shortened. */
export function fitWidth(text: string, width: number): string {
	if (displayWidth(text) <= width) return text;
	if (width <= 0) return "";
	let used = 0;
	let out = "";
	for (const char of text) {
		const w = charWidth(char.codePointAt(0) ?? 0);
		if (used + w > width - 1) break;
		used += w;
		out += char;
	}
	return `${out}…`;
}

/**
 * Cut styled `text` to at most `width` columns, keeping its escape sequences, so a row of the
 * live area never wraps (which would throw off how many rows the screen moves up).
 */
export function fitStyled(text: string, width: number): string {
	if (displayWidth(text) <= width) return text;
	if (width <= 0) return "";
	let used = 0;
	let out = "";
	let index = 0;
	const sequence = new RegExp(ANSI.source, "y");
	while (index < text.length) {
		sequence.lastIndex = index;
		const match = sequence.exec(text);
		if (match) {
			out += match[0];
			index += match[0].length;
			continue;
		}
		const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
		const w = charWidth(char.codePointAt(0) ?? 0);
		if (used + w > width - 1) break;
		used += w;
		out += char;
		index += char.length;
	}
	return `${out}…${level === 0 ? "" : "\x1b[0m"}`;
}

/** `text` padded with spaces to `width` columns. */
export function padWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * How many rows below its first one readline's cursor ends after writing `text` on a terminal
 * `columns` wide (readline's own `getDisplayPos`), e.g. the prompt plus the typed line.
 */
export function readlineRows(text: string, columns: number): number {
	const cols = Math.max(1, columns);
	let offset = 0;
	let rows = 0;
	for (const char of stripAnsi(text)) {
		if (char === "\n") {
			rows += Math.ceil(offset / cols) || 1;
			offset = 0;
			continue;
		}
		if (char === "\t") {
			offset += 8 - (offset % 8);
			continue;
		}
		const width = charWidth(char.codePointAt(0) ?? 0);
		if (width === 2 && (offset + 1) % cols === 0) offset++;
		offset += width;
	}
	return rows + Math.floor(offset / cols);
}
