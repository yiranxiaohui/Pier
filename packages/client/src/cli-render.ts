/**
 * Rendering for pier-cli: word wrapping with hanging indents, Markdown, tool calls and their
 * results, boxes, aligned lists and the status line. Pure functions that return the rows to
 * print, so they can be tested without a terminal or a running host.
 */
import { c, charWidth, displayWidth, fitStyled, fitWidth, padWidth, sanitize } from "./cli-style.ts";

/** A run of text in one style. */
export interface Span {
	text: string;
	style?: (text: string) => string;
}

export const span = (text: string, style?: (text: string) => string): Span => (style ? { text, style } : { text });

export function renderSpans(spans: readonly Span[]): string {
	return spans.map((s) => (s.style ? s.style(s.text) : s.text)).join("");
}

export function spansWidth(spans: readonly Span[]): number {
	return spans.reduce((width, s) => width + displayWidth(s.text), 0);
}

/** A unit of wrapping: a run of spaces, a word (which may change style inside), or one wide character. */
interface Token {
	parts: Span[];
	width: number;
	kind: "space" | "word" | "wide";
}

/** Closing punctuation that stays at the end of the row before it rather than starting a row. */
const NO_BREAK_BEFORE = new Set([..."，。、；：！？）」』》〉】〕…—"]);

/** Spaces, words and single wide characters (CJK text may break between any two of them). */
function tokens(spans: readonly Span[]): Token[] {
	const out: Token[] = [];
	let current: Token | undefined;
	for (const s of spans) {
		for (const char of s.text) {
			const width = charWidth(char.codePointAt(0) ?? 0);
			const kind = char === " " ? "space" : width === 2 ? "wide" : "word";
			const joins =
				current &&
				((kind !== "wide" && kind === current.kind) ||
					(NO_BREAK_BEFORE.has(char) && current.kind !== "space") ||
					(kind === "word" && current.kind === "wide" && /^[,.;:!?)\]]$/.test(char)));
			if (!current || !joins) {
				current = { parts: [], width: 0, kind };
				out.push(current);
			}
			const last = current.parts[current.parts.length - 1];
			if (last && last.style === s.style) last.text += char;
			else current.parts.push(span(char, s.style));
			current.width += width;
		}
	}
	return out;
}

function trimRow(row: Span[]): void {
	while (row.length) {
		const last = row[row.length - 1] as Span;
		const text = last.text.replace(/ +$/, "");
		if (text) {
			last.text = text;
			return;
		}
		row.pop();
	}
}

/**
 * Word-wrap `spans` into rows of at most `width` columns (`restWidth` for the rows after the
 * first). Words longer than a row are broken; spaces at a break are dropped.
 */
export function wrapSpans(spans: readonly Span[], width: number, restWidth = width): Span[][] {
	const rows: Span[][] = [[]];
	let used = 0;
	const limit = () => Math.max(1, rows.length === 1 ? width : restWidth);
	const append = (text: string, style: Span["style"]) => {
		const row = rows[rows.length - 1] as Span[];
		const last = row[row.length - 1];
		if (last && last.style === style) last.text += text;
		else row.push(span(text, style));
		used += displayWidth(text);
	};
	const newRow = () => {
		trimRow(rows[rows.length - 1] as Span[]);
		rows.push([]);
		used = 0;
	};
	for (const token of tokens(spans)) {
		if (token.kind === "space") {
			if (used === 0 && rows.length > 1) continue;
			if (used + token.width > limit()) newRow();
			else for (const part of token.parts) append(part.text, part.style);
			continue;
		}
		if (used + token.width > limit() && token.width <= limit() && used > 0) newRow();
		if (used + token.width <= limit()) {
			for (const part of token.parts) append(part.text, part.style);
			continue;
		}
		for (const part of token.parts)
			for (const char of part.text) {
				if (used + charWidth(char.codePointAt(0) ?? 0) > limit() && used > 0) newRow();
				append(char, part.style);
			}
	}
	trimRow(rows[rows.length - 1] as Span[]);
	return rows;
}

/** Wrap `content` under a first-row prefix (`marker`) and a continuation prefix (`hang`). */
export function formatBlock(
	content: readonly Span[],
	width: number,
	marker: readonly Span[] = [],
	hang: readonly Span[] = [span(" ".repeat(spansWidth(marker)))],
): string[] {
	const rows = wrapSpans(content, width - spansWidth(marker), width - spansWidth(hang));
	return rows.map((row, i) => renderSpans([...(i === 0 ? marker : hang), ...row]).replace(/ +$/, ""));
}

/** `text` on one line, cut to `width` columns. */
export function flatLine(text: string, width: number): string {
	return fitWidth(sanitize(text).replace(/\s+/g, " ").trim(), width);
}

// ── Markdown ────────────────────────────────────────────────────────────────

export interface MarkdownState {
	/** The fence (``` or ~~~) of the open code block, and its language. */
	fence?: { marker: string; lang: string };
}

export interface MarkdownLine {
	/** Shown before the first row: bullets, quote bars, list numbers. */
	lead: Span[];
	/** Shown before the rows it wraps onto. */
	hang: Span[];
	content: Span[];
	/** A thematic break, drawn across the width. */
	rule?: boolean;
}

const compose =
	(outer: (s: string) => string, inner?: (s: string) => string) =>
	(text: string): string =>
		outer(inner ? inner(text) : text);

const INLINE =
	/(`+)(.+?)\1(?!`)|\*\*(?=\S)(.+?)\*\*(?!\*)|__(?=\S)(.+?)__(?!\w)|(?<![\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Inline Markdown: `code`, **bold**, *italic* and [links](url). */
export function inlineMarkdown(text: string, style?: (s: string) => string): Span[] {
	const out: Span[] = [];
	let last = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > last) out.push(span(text.slice(last, index), style));
		const [, ticks, code, bold, bold2, italic, label, url] = match;
		if (ticks && code !== undefined) out.push(span(code, compose(c.code, style)));
		else if (bold !== undefined || bold2 !== undefined)
			out.push(...inlineMarkdown((bold ?? bold2) as string, compose(c.bold, style)));
		else if (italic !== undefined) out.push(...inlineMarkdown(italic, compose(c.italic, style)));
		else if (label !== undefined && url !== undefined) {
			out.push(span(label, compose(c.underline, compose(c.link, style))));
			if (url !== label) out.push(span(` (${url})`, c.gray));
		}
		last = index + match[0].length;
	}
	if (last < text.length) out.push(span(text.slice(last), style));
	return out;
}

function diffStyle(line: string): ((s: string) => string) | undefined {
	if (line.startsWith("+++") || line.startsWith("---")) return c.bold;
	if (line.startsWith("+")) return c.green;
	if (line.startsWith("-")) return c.red;
	if (line.startsWith("@@")) return c.accent;
	return undefined;
}

/** One complete line of Markdown. `state` carries open code blocks from line to line. */
export function markdownLine(line: string, state: MarkdownState): MarkdownLine {
	const plain = (content: Span[], lead: Span[] = [], hang: Span[] = []): MarkdownLine => ({ lead, hang, content });
	const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
	if (state.fence) {
		const open = state.fence;
		if (fence?.[1]?.startsWith(open.marker) && !fence[2]) {
			state.fence = undefined;
			return plain([span(line.trim(), c.gray)]);
		}
		if (/^(diff|patch)$/i.test(open.lang)) return plain([span(line, diffStyle(line))]);
		return plain([span(line, c.code)]);
	}
	if (fence) {
		state.fence = { marker: fence[1] as string, lang: fence[2] ?? "" };
		return plain([span(line.trim(), c.gray)]);
	}
	if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) return { lead: [], hang: [], content: [], rule: true };
	const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
	if (heading) {
		const style = (heading[1] as string).length <= 2 ? compose(c.bold, c.accent) : c.bold;
		return plain(inlineMarkdown(heading[2] as string, style));
	}
	const quote = /^\s*>\s?(.*)$/.exec(line);
	if (quote) return plain(inlineMarkdown(quote[1] as string, c.italic), [span("│ ", c.gray)], [span("│ ", c.gray)]);
	const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
	if (bullet) {
		const indent = (bullet[1] as string).replace(/\t/g, "    ");
		return plain(inlineMarkdown(bullet[2] as string), [span(`${indent}• `)], [span(`${indent}  `)]);
	}
	const numbered = /^(\s*)(\d{1,9}[.)])\s+(.*)$/.exec(line);
	if (numbered) {
		const lead = `${numbered[1]}${numbered[2]} `;
		return plain(inlineMarkdown(numbered[3] as string), [span(lead)], [span(" ".repeat(displayWidth(lead)))]);
	}
	return plain(inlineMarkdown(line));
}

export interface MarkdownOptions {
	width: number;
	/** Prefix of the first row, e.g. the `● ` of an assistant message. */
	marker?: Span[];
	/** Prefix of every other row; defaults to spaces as wide as `marker`. */
	indent?: Span[];
	/** Base style of all text, e.g. gray italic for thinking. */
	style?: (s: string) => string;
}

/** Rows of one Markdown line inside a block. */
export function formatMarkdownLine(line: string, state: MarkdownState, options: MarkdownOptions): string[] {
	const marker = options.marker ?? [];
	const indent = options.indent ?? [span(" ".repeat(spansWidth(marker)))];
	const md = markdownLine(line, state);
	if (md.rule) {
		const room = Math.max(1, Math.min(40, options.width - spansWidth(marker)));
		return [renderSpans([...marker, span("─".repeat(room), c.gray)])];
	}
	const content = options.style
		? md.content.map((s) =>
				span(s.text, s.style ? compose(options.style as (t: string) => string, s.style) : options.style),
			)
		: md.content;
	if (!content.length && !md.lead.length) return [renderSpans(marker).replace(/ +$/, "")];
	return formatBlock(content, options.width, [...marker, ...md.lead], [...indent, ...md.hang]);
}

// ── Streaming assistant messages ────────────────────────────────────────────

export type StreamKind = "text" | "thinking";

const MARKERS: Record<StreamKind, () => Span> = {
	text: () => span("● "),
	thinking: () => span("✻ ", c.gray),
};

/**
 * Turns streamed text and thinking deltas into finished rows (each complete line, wrapped and
 * styled) and live rows (the line still being written). Each block starts with a blank row
 * and its marker; blank lines are collapsed.
 */
export class MessageStream {
	private kind: StreamKind | undefined;
	private partial = "";
	private started = false;
	private blank = false;
	private markdown: MarkdownState = {};
	/** Rows of a Markdown table, drawn once it ends. */
	private table: string[] = [];

	constructor(private readonly options: { width: () => number; markdown: boolean }) {}

	get active(): StreamKind | undefined {
		return this.kind;
	}

	/** Add a delta; returns the rows it completed. */
	push(kind: StreamKind, delta: string): string[] {
		const rows = this.kind && this.kind !== kind ? this.finish() : [];
		this.kind = kind;
		this.partial += sanitize(delta);
		for (let nl = this.partial.indexOf("\n"); nl >= 0; nl = this.partial.indexOf("\n")) {
			rows.push(...this.renderLine(this.partial.slice(0, nl)));
			this.partial = this.partial.slice(nl + 1);
		}
		return rows;
	}

	/** What is still being written (a table, the current line), as at most `maxRows` rows (its end). */
	live(maxRows: number): string[] {
		if (!this.kind) return [];
		const tableRow = this.isTableRow(this.partial);
		const rows = this.tableRows(tableRow ? [...this.table, this.partial] : this.table, true);
		if (!tableRow && this.partial.trim())
			rows.push(...this.renderText(this.partial, true, !this.started && !rows.length));
		return rows.slice(-Math.max(1, maxRows));
	}

	/** End the block; returns its remaining rows. */
	finish(): string[] {
		const rows = this.kind && this.partial ? this.renderLine(this.partial) : [];
		if (this.kind) rows.push(...this.flushTable());
		this.kind = undefined;
		this.partial = "";
		this.table = [];
		this.started = false;
		this.blank = false;
		this.markdown = {};
		return rows;
	}

	private isTableRow(line: string): boolean {
		return this.options.markdown && !this.markdown.fence && isTableRow(line);
	}

	/** A complete line: table rows wait for the rest of their table. */
	private renderLine(line: string): string[] {
		if (this.isTableRow(line)) {
			this.table.push(line);
			return [];
		}
		return [...this.flushTable(), ...this.renderText(line, false)];
	}

	private flushTable(): string[] {
		const rows = this.tableRows(this.table, false);
		this.table = [];
		return rows;
	}

	private tableRows(lines: readonly string[], preview: boolean): string[] {
		if (!lines.length) return [];
		const first = !this.started;
		const table = markdownTable(lines, this.options.width() - 2);
		if (!table) {
			// Not a table after all (or too wide): its lines as text.
			const rows: string[] = [];
			for (const line of lines) rows.push(...this.renderText(line, preview, first && !rows.length));
			return rows;
		}
		if (!preview) {
			this.started = true;
			this.blank = false;
		}
		const kind = this.kind as StreamKind;
		const rows = table.map((row, i) => `${i === 0 && first ? renderSpans([MARKERS[kind]()]) : "  "}${row}`);
		return first ? ["", ...rows] : rows;
	}

	private renderText(line: string, preview: boolean, first = !this.started): string[] {
		const kind = this.kind as StreamKind;
		if (!line.trim()) {
			if (!this.started || this.blank || preview) return [];
			this.blank = true;
			return [""];
		}
		if (!preview) {
			this.started = true;
			this.blank = false;
		}
		const state = preview ? { ...this.markdown } : this.markdown;
		const width = this.options.width();
		const style = kind === "thinking" ? compose(c.gray, c.italic) : undefined;
		const options = {
			width,
			marker: [first ? MARKERS[kind]() : span("  ")],
			indent: [span("  ")],
			...(style ? { style } : {}),
		};
		const rows = this.options.markdown
			? formatMarkdownLine(line, state, options)
			: formatBlock([span(line, style)], width, options.marker, options.indent);
		return first ? ["", ...rows] : rows;
	}
}

// ── Tables ──────────────────────────────────────────────────────────────────

const TABLE_ROW = /^\s*\|.*\|\s*$/;

export function isTableRow(line: string): boolean {
	return TABLE_ROW.test(line);
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * A Markdown table drawn with box characters and aligned columns, or `undefined` when the
 * lines are not a table (no `|---|` row) or it would be wider than `width`.
 */
export function markdownTable(lines: readonly string[], width: number): string[] | undefined {
	const parsed = lines.map(tableCells);
	const separator = parsed[1];
	if (!separator?.every((cell) => /^:?-+:?$/.test(cell))) return undefined;
	const align = separator.map((cell) => (cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left"));
	const body = [parsed[0] as string[], ...parsed.slice(2)].map((cells, row) =>
		cells.map((cell) => inlineMarkdown(cell, row === 0 ? c.bold : undefined)),
	);
	const columns = Math.max(...body.map((cells) => cells.length));
	const widths = Array.from({ length: columns }, (_, i) =>
		Math.max(1, ...body.map((cells) => spansWidth(cells[i] ?? []))),
	);
	if (widths.reduce((sum, w) => sum + w + 3, 1) > width) return undefined;
	const border = (left: string, middle: string, right: string) =>
		c.gray(`${left}${widths.map((w) => "─".repeat(w + 2)).join(middle)}${right}`);
	const cell = (spans: readonly Span[], i: number) => {
		const pad = (widths[i] as number) - spansWidth(spans);
		const left = align[i] === "right" ? pad : align[i] === "center" ? Math.floor(pad / 2) : 0;
		return `${" ".repeat(left)}${renderSpans(spans)}${" ".repeat(pad - left)}`;
	};
	const rows = [border("┌", "┬", "┐")];
	for (const [index, cells] of body.entries()) {
		const bar = c.gray("│");
		rows.push(`${bar}${widths.map((_, i) => ` ${cell(cells[i] ?? [], i)} `).join(bar)}${bar}`);
		if (index === 0) rows.push(border("├", "┼", "┤"));
	}
	rows.push(border("└", "┴", "┘"));
	return rows;
}

// ── Tool calls ──────────────────────────────────────────────────────────────

const ARG_KEYS = [
	"command",
	"cmd",
	"pattern",
	"query",
	"url",
	"file_path",
	"filePath",
	"path",
	"description",
	"prompt",
	"name",
];

/** The argument that says most about a tool call: its command, path, pattern or URL. */
export function toolSummary(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object") return flatLine(String(args), 400);
	const record = args as Record<string, unknown>;
	for (const key of ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			const where = key === "pattern" && typeof record.path === "string" ? ` in ${record.path}` : "";
			return flatLine(value + where, 400);
		}
	}
	const json = JSON.stringify(args);
	return json === "{}" ? "" : flatLine(json, 400);
}

export type ToolStatus = "running" | "ok" | "error";

/** `● bash(ls -la)`: the tool's name and main argument, in up to `maxRows` rows. */
export function toolHeader(
	name: string,
	args: unknown,
	status: ToolStatus,
	width: number,
	options: { frame?: string; maxRows?: number } = {},
): string[] {
	const dot =
		status === "running"
			? span(`${options.frame ?? "●"} `, c.accent)
			: status === "ok"
				? span("● ", c.green)
				: span("● ", c.red);
	const summary = toolSummary(args);
	const content = [span(sanitize(name) || "tool", c.bold), ...(summary ? [span(`(${summary})`)] : [])];
	const rows = formatBlock(content, width, [dot], [span("  ")]);
	const max = options.maxRows ?? 3;
	if (rows.length <= max) return rows;
	const kept = rows.slice(0, max);
	kept[max - 1] = fitStyled(`${kept[max - 1]} …`, width);
	return kept;
}

interface ToolResultLike {
	content?: unknown;
	details?: unknown;
}

/** The text parts of a tool result, and how many images it has. */
export function toolResultText(result: unknown): { text: string; images: number } {
	const content = (result as ToolResultLike | undefined)?.content;
	if (typeof content === "string") return { text: content, images: 0 };
	if (!Array.isArray(content)) return { text: typeof result === "string" ? result : "", images: 0 };
	let images = 0;
	const text = content
		.map((part: { type?: string; text?: string }) => {
			if (part?.type === "image") images++;
			return part?.type === "text" ? (part.text ?? "") : "";
		})
		.join("\n");
	return { text, images };
}

const RESULT_FIRST = span("  ⎿  ", c.gray);
const RESULT_REST = span("     ");

/** Rows under a result's `⎿`: each line cut to the width, styled by `styleOf`. */
function resultRows(
	lines: readonly string[],
	width: number,
	styleOf: (line: string) => (s: string) => string,
): string[] {
	return lines.map((line, i) => {
		const prefix = i === 0 ? RESULT_FIRST : RESULT_REST;
		const text = fitWidth(line, Math.max(1, width - spansWidth([prefix])));
		return renderSpans([prefix, span(text, styleOf(line))]).replace(/ +$/, "");
	});
}

/** A line under a tool call or command: `  ⎿  text`, wrapped under itself. */
export function resultLine(content: string | readonly Span[], width: number, style?: (s: string) => string): string[] {
	const spans = typeof content === "string" ? [span(content, style)] : content;
	return formatBlock(spans, width, [RESULT_FIRST], [RESULT_REST]);
}

/**
 * A preview of a tool's result under its call: the first lines of its output with a count of
 * the rest, a colored diff for edits, or the error in red.
 */
export function toolResult(name: string, result: unknown, isError: boolean, width: number, maxLines = 4): string[] {
	const { text, images } = toolResultText(result);
	const lines = sanitize(text, true)
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));
	while (lines.length && !lines[lines.length - 1]) lines.pop();
	while (lines.length && !lines[0]) lines.shift();
	const diff = (result as ToolResultLike | undefined)?.details as { diff?: unknown } | undefined;
	if (!isError && typeof diff?.diff === "string" && diff.diff.trim()) {
		const changed = sanitize(diff.diff)
			.split("\n")
			.filter((line) => /^[+-]/.test(line));
		const added = changed.filter((line) => line.startsWith("+")).length;
		const summary = `${added} line${added === 1 ? "" : "s"} added, ${changed.length - added} removed`;
		const shown = changed.slice(0, maxLines * 2);
		const rows = resultRows([summary, ...shown], width, (line) =>
			line === summary ? c.gray : line.startsWith("+") ? c.green : c.red,
		);
		if (changed.length > shown.length)
			rows.push(renderSpans([RESULT_REST, span(`… +${changed.length - shown.length} lines`, c.gray)]));
		return rows;
	}
	if (!isError && /^read$/i.test(name) && lines.length > 1)
		return resultRows([`Read ${lines.length} lines`], width, () => c.gray);
	if (images) lines.push(`[${images} image${images > 1 ? "s" : ""}]`);
	if (!lines.length) return resultRows([isError ? "failed" : "(no output)"], width, () => (isError ? c.red : c.gray));
	const shown = lines.slice(0, maxLines);
	const rows = resultRows(shown, width, () => (isError ? c.red : c.gray));
	if (lines.length > shown.length)
		rows.push(renderSpans([RESULT_REST, span(`… +${lines.length - shown.length} lines`, c.gray)]));
	return rows;
}

// ── Boxes, lists and rules ──────────────────────────────────────────────────

/**
 * A rounded box around `rows` (styled strings), `width` columns wide overall, with an
 * optional title in the top border.
 */
export function box(
	rows: readonly string[],
	width: number,
	options: { border?: (s: string) => string; title?: string } = {},
): string[] {
	const border = options.border ?? c.gray;
	const inner = Math.max(4, width - 4);
	const title = options.title ? ` ${fitWidth(options.title, inner - 2)} ` : "";
	const top = `${border("╭─")}${title ? c.bold(title) : ""}${border(`${"─".repeat(Math.max(0, inner + 1 - displayWidth(title)))}╮`)}`;
	const body = rows.map((row) => `${border("│")} ${padWidth(fitStyled(row, inner), inner)} ${border("│")}`);
	return [top, ...body, border(`╰${"─".repeat(inner + 2)}╯`)];
}

/** Wrap styled spans to fit inside a box `width` columns wide. */
export function boxRows(content: readonly Span[], width: number, hang: readonly Span[] = []): string[] {
	return formatBlock(content, Math.max(4, width - 4), [], hang);
}

/**
 * A horizontal rule with an optional label at each end: `── left ─────── right ─`. When both
 * do not fit, the left label is cut first (down to a few columns), then the right one.
 */
export function rule(width: number, left = "", right = ""): string {
	const room = Math.max(0, width - 5);
	let l = left ? ` ${left} ` : "";
	let r = right ? ` ${right} ` : "";
	const over = () => displayWidth(l) + displayWidth(r) - room;
	if (over() > 0 && l) l = fitStyled(l, Math.max(Math.min(displayWidth(l), 14), displayWidth(l) - over()));
	if (over() > 0 && r) r = fitStyled(r, Math.max(0, displayWidth(r) - over()));
	if (over() > 0) l = fitStyled(l, Math.max(0, displayWidth(l) - over()));
	const fill = Math.max(2, width - 3 - displayWidth(l) - displayWidth(r));
	return `${c.gray("──")}${l}${c.gray("─".repeat(fill))}${r}${c.gray("─")}`;
}

export interface ListRow {
	/** Cells shown in aligned columns; the last one takes the remaining width. */
	cells: string[];
	current?: boolean;
	muted?: boolean;
}

/**
 * Numbered rows in aligned columns: `  1  ● label  detail`. The current row is marked and
 * highlighted; columns are cut so no row is wider than `width`.
 */
export function list(rows: readonly ListRow[], width: number, options: { numbered?: boolean } = {}): string[] {
	const numbered = options.numbered ?? true;
	const numberWidth = String(rows.length).length;
	const columns = Math.max(0, ...rows.map((r) => r.cells.length));
	const widths = Array.from({ length: columns }, (_, i) =>
		Math.min(48, Math.max(0, ...rows.map((r) => displayWidth(r.cells[i] ?? "")))),
	);
	return rows.map((row, index) => {
		const number = numbered ? c.gray(`${String(index + 1).padStart(numberWidth)}  `) : "";
		const mark = row.current ? c.accent("● ") : "  ";
		let out = `  ${number}${mark}`;
		for (const [i, cell] of row.cells.entries()) {
			const last = i === row.cells.length - 1;
			const room = width - displayWidth(out);
			if (room <= 1) break;
			const fitted = fitStyled(cell, last ? room : Math.min(widths[i] as number, room));
			const styled =
				i === 0 ? (row.current ? c.accent(c.bold(fitted)) : row.muted ? c.gray(fitted) : fitted) : c.gray(fitted);
			out += last ? styled : `${padWidth(styled, widths[i] as number)}  `;
		}
		return out.replace(/ +$/, "");
	});
}

/** `  key    value` rows with the keys aligned. */
export function keyValues(pairs: ReadonlyArray<readonly [string, string]>, width: number, indent = "  "): string[] {
	const keyWidth = Math.max(0, ...pairs.map(([key]) => displayWidth(key)));
	return pairs.map(([key, value]) => {
		const head = `${indent}${padWidth(key, keyWidth)}  `;
		return `${c.gray(head)}${fitStyled(value, Math.max(1, width - displayWidth(head)))}`;
	});
}

// ── Times ───────────────────────────────────────────────────────────────────

/** `<1s`, `42s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return "<1s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`, or the date for older times. */
export function relativeTime(iso: string, now = Date.now()): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return iso;
	const seconds = Math.round((now - at) / 1000);
	if (seconds < 45) return "just now";
	if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
	if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
	return new Date(at).toISOString().slice(0, 10);
}

/** A spinner frame for the time `now`. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinnerFrame(now = Date.now()): string {
	return SPINNER[Math.floor(now / 80) % SPINNER.length] as string;
}

/**
 * A message the user sent, as `❯ text` with wrapped lines indented under it; at most
 * `maxRows` rows, the rest counted.
 */
export function userMessage(
	text: string,
	width: number,
	options: { command?: boolean; maxRows?: number } = {},
): string[] {
	const style = options.command ? c.gray : undefined;
	const rows: string[] = [""];
	for (const [i, line] of sanitize(text).replace(/\s+$/, "").split("\n").entries())
		rows.push(...formatBlock([span(line, style)], width, [i === 0 ? span("❯ ", c.accent) : span("  ")], [span("  ")]));
	const max = options.maxRows ?? Number.POSITIVE_INFINITY;
	if (rows.length - 1 <= max) return rows;
	return [...rows.slice(0, max + 1), c.gray(`  … +${rows.length - 1 - max} lines`)];
}

export interface HelpSection {
	title: string;
	commands: ReadonlyArray<readonly [usage: string, description: string]>;
}

/** Help sections as rows: a bold title, then each usage with its description wrapped beside it. */
export function helpRows(sections: readonly HelpSection[], notes: readonly string[], width: number): string[] {
	const usageWidth = Math.max(...sections.flatMap((s) => s.commands.map(([usage]) => displayWidth(usage))));
	const narrow = width < usageWidth + 30;
	const rows: string[] = [];
	for (const section of sections) {
		rows.push("", `  ${c.bold(section.title)}`);
		for (const [usage, description] of section.commands) {
			if (narrow) {
				rows.push(`    ${c.accent(usage)}`);
				rows.push(...formatBlock([span(description, c.gray)], width, [span("      ")]));
			} else {
				const lead = [span("    "), span(padWidth(usage, usageWidth), c.accent), span("  ")];
				rows.push(...formatBlock([span(description, c.gray)], width, lead));
			}
		}
	}
	rows.push("");
	for (const note of notes) rows.push(...formatBlock(inlineMarkdown(note, c.gray), width, [span("  ")]));
	return rows;
}

/** Usages of the commands whose name starts with what is typed (or, once arguments follow, is it). */
export function commandSuggestions(sections: readonly HelpSection[], line: string): Array<readonly [string, string]> {
	const match = /^(\/\S*)(\s?)/.exec(line);
	if (!match) return [];
	const [, typed, space] = match as unknown as [string, string, string];
	return sections.flatMap((s) =>
		s.commands.filter(([usage]) =>
			usage
				.split(/[\s,]+/)
				.filter((word) => word.startsWith("/"))
				.some((name) => (space ? name === typed : name.startsWith(typed))),
		),
	);
}

/** The longest start all of `items` share. */
export function commonPrefix(items: readonly string[]): string {
	if (!items.length) return "";
	let prefix = items[0] as string;
	for (const item of items) while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
	return prefix;
}

/** Completion candidates in as many aligned columns as fit, at most `maxRows` rows. */
export function completionGrid(items: readonly string[], width: number, maxRows = 8): string[] {
	const cells = items.map((item) => sanitize(item));
	const room = Math.max(4, width - 2);
	const cellWidth = Math.min(room, Math.max(...cells.map((cell) => displayWidth(cell))) + 2);
	const perRow = Math.max(1, Math.floor((room + 2) / cellWidth));
	const rows: string[] = [];
	for (let i = 0; i < cells.length; i += perRow) {
		const row = cells.slice(i, i + perRow).map((cell) => padWidth(fitWidth(cell, cellWidth - 2), cellWidth));
		rows.push(`  ${row.join("").trimEnd()}`);
	}
	if (rows.length <= maxRows) return rows;
	const hidden = cells.length - (maxRows - 1) * perRow;
	return [...rows.slice(0, maxRows - 1), c.gray(`  … ${hidden} more; type more to narrow them down`)];
}
