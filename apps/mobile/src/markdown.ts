import { remarkGfmCjk } from "@pier/chat-state/markdown";
import type { Root, Table } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Markdown parsing for the mobile transcript. It uses the same parser as the desktop app
 * (remark-parse + remark-gfm, with URLs ending at full-width punctuation), so tables, task
 * lists, strikethrough, autolinks and footnotes are understood the same way; only the
 * rendering differs (native views).
 */

const processor = unified().use(remarkParse).use(remarkGfmCjk).freeze();

export function parseMarkdown(text: string): Root {
	return processor.parse(text);
}

/** Only web and mail links are opened from chat text; anything else stays inert. */
export function safeUrl(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	const trimmed = url.trim();
	return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}

const WIDE =
	/[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/** Rough rendered width of a text run at the table font size: CJK glyphs are about twice as wide. */
export function textWidth(text: string, charWidth = 7.5): number {
	let units = 0;
	for (const char of text) units += WIDE.test(char) ? 2 : 1;
	return units * charWidth;
}

/**
 * Column widths for a native table. React Native has no table layout, so every row is a
 * flex row of fixed-width cells; the width of each column follows its longest cell, clamped
 * so short columns stay readable and long ones wrap instead of growing without bound.
 */
export function tableColumnWidths(
	table: Table,
	{ min = 56, max = 260, padding = 28 }: { min?: number; max?: number; padding?: number } = {},
): number[] {
	const columns = Math.max(table.align?.length ?? 0, ...table.children.map((row) => row.children.length), 0);
	const widths: number[] = [];
	for (let column = 0; column < columns; column++) {
		let widest = 0;
		for (const row of table.children) {
			const cell = row.children[column];
			if (cell) widest = Math.max(widest, textWidth(mdastToString(cell)));
		}
		widths.push(Math.round(Math.min(max, Math.max(min, widest + padding))));
	}
	return widths;
}
