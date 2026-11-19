/**
 * Minimal edits of a JSON-with-comments document (OpenCode's `opencode.json(c)`): a changed value
 * replaces only its own text, a new key goes after its last sibling in that object's style (one
 * per line, or inline), and a removed key takes its line with it. Comments, key order, indentation,
 * trailing commas and inline objects elsewhere stay as they are. jsonc-parser's own `modify`
 * reformats whole lines around each edit, which would expand inline objects next to it.
 */

import {
	applyEdits,
	createScanner,
	type Edit,
	type FormattingOptions,
	findNodeAtLocation,
	modify,
	type Node,
	parseTree,
} from "jsonc-parser";

// jsonc-parser's `SyntaxKind` is an ambient const enum.
const COMMA = 5;
const LINE_COMMENT = 12;
const BLOCK_COMMENT = 13;
const LINE_BREAK = 14;
const TRIVIA = 15;

interface Style {
	eol: string;
	/** One level of indentation. */
	unit: string;
	formatting: FormattingOptions;
}

/** Indentation and line endings of an existing document, for the lines an edit adds. */
function styleOf(text: string): Style {
	const indent = /\n([ \t]+)\S/.exec(text)?.[1];
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const tabs = indent?.startsWith("\t") ?? false;
	const size = tabs ? 1 : indent ? indent.length : 2;
	return {
		eol,
		unit: tabs ? "\t" : " ".repeat(size),
		formatting: { insertSpaces: !tabs, tabSize: size, eol },
	};
}

function lineStart(text: string, offset: number): number {
	return text.lastIndexOf("\n", offset - 1) + 1;
}

function indentAt(text: string, offset: number): string {
	return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))?.[0] ?? "";
}

/** Nothing but indentation precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
	return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset));
}

function spansLines(text: string, node: Node): boolean {
	return text.slice(node.offset, node.offset + node.length).includes("\n");
}

function end(node: Node): number {
	return node.offset + node.length;
}

/**
 * What follows a property on its line: its comma, then a comment. `end` is after the last of
 * them; `lineEnd` is after the line break, when nothing else follows on the line.
 */
function tailOf(text: string, offset: number): { comma?: number; end: number; lineEnd?: number } {
	const scanner = createScanner(text, false);
	scanner.setPosition(offset);
	let comma: number | undefined;
	let last = offset;
	for (;;) {
		const kind = scanner.scan() as number;
		const start = scanner.getTokenOffset();
		const stop = start + scanner.getTokenLength();
		if (kind === TRIVIA) continue;
		if (kind === COMMA && comma === undefined) {
			comma = start;
			last = stop;
		} else if (kind === LINE_COMMENT || (kind === BLOCK_COMMENT && !text.slice(start, stop).includes("\n"))) {
			last = stop;
		} else {
			return {
				...(comma === undefined ? {} : { comma }),
				end: last,
				...(kind === LINE_BREAK ? { lineEnd: stop } : {}),
			};
		}
	}
}

/** A value on one line: `{ "a": 1, "b": [1, 2] }`. */
function inline(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value);
		return entries.length ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")} }` : "{}";
	}
	return JSON.stringify(value);
}

/** A value whose own lines are indented under a property indented with `indent`. */
function block(value: unknown, indent: string, style: Style): string {
	if (typeof value !== "object" || value === null || !Object.keys(value).length) return inline(value);
	return JSON.stringify(value, null, style.unit).split("\n").join(`${style.eol}${indent}`);
}

function replaceValue(text: string, root: Node, path: string[], value: unknown, style: Style): Edit[] | undefined {
	const node = findNodeAtLocation(root, path);
	const property = node?.parent;
	if (!node || property?.type !== "property" || !property.parent) return undefined;
	const ownLine = spansLines(text, property.parent) && startsLine(text, property.offset);
	const content = ownLine ? block(value, indentAt(text, property.offset), style) : inline(value);
	return [{ offset: node.offset, length: node.length, content }];
}

function insertProperty(text: string, root: Node, path: string[], value: unknown, style: Style): Edit[] | undefined {
	const object = findNodeAtLocation(root, path.slice(0, -1));
	if (object?.type !== "object") return undefined;
	const key = JSON.stringify(path.at(-1));
	const last = object.children?.at(-1);
	if (last) {
		const tail = tailOf(text, end(last));
		if (spansLines(text, object) && startsLine(text, last.offset)) {
			const indent = indentAt(text, last.offset);
			const line = `${style.eol}${indent}${key}: ${block(value, indent, style)}${tail.comma === undefined ? "" : ","}`;
			if (tail.comma !== undefined) return [{ offset: tail.end, length: 0, content: line }];
			// The last property gets a comma; the new one goes after a comment on its line.
			return tail.end === end(last)
				? [{ offset: tail.end, length: 0, content: `,${line}` }]
				: [
						{ offset: end(last), length: 0, content: "," },
						{ offset: tail.end, length: 0, content: line },
					];
		}
		return tail.comma === undefined
			? [{ offset: end(last), length: 0, content: `, ${key}: ${inline(value)}` }]
			: [{ offset: tail.comma + 1, length: 0, content: ` ${key}: ${inline(value)},` }];
	}
	const inner = { offset: object.offset + 1, length: object.length - 2 };
	const empty = !text.slice(inner.offset, inner.offset + inner.length).trim();
	const base = indentAt(text, object.offset);
	const indent = base + style.unit;
	const property = `${key}: ${block(value, indent, style)}`;
	if (spansLines(text, object) || !empty) {
		return [{ offset: inner.offset, length: 0, content: `${style.eol}${indent}${property}` }];
	}
	// `{}`: the top-level object and objects receiving an object open up, others stay inline.
	const opens = object === root || block(value, indent, style).includes("\n");
	return [
		{
			...inner,
			content: opens ? `${style.eol}${indent}${property}${style.eol}${base}` : ` ${key}: ${inline(value)} `,
		},
	];
}

function removeProperty(text: string, root: Node, path: string[]): Edit[] | undefined {
	const property = findNodeAtLocation(root, path)?.parent;
	const object = property?.parent;
	const siblings = object?.children;
	if (property?.type !== "property" || object?.type !== "object" || !siblings) return undefined;
	const index = siblings.indexOf(property);
	const previous = siblings[index - 1];
	const next = siblings[index + 1];
	const tail = tailOf(text, end(property));
	if (spansLines(text, object) && startsLine(text, property.offset)) {
		const start = lineStart(text, property.offset);
		const stop = tail.lineEnd ?? (next ? next.offset : tail.end);
		const edits: Edit[] = [{ offset: start, length: stop - start, content: "" }];
		// The new last property keeps a comma only if the removed one had one (trailing commas).
		if (!next && previous && tail.comma === undefined) {
			const comma = tailOf(text, end(previous)).comma;
			if (comma !== undefined) edits.push({ offset: comma, length: 1, content: "" });
		}
		return edits;
	}
	if (previous) return [{ offset: end(previous), length: end(property) - end(previous), content: "" }];
	if (next) return [{ offset: property.offset, length: next.offset - property.offset, content: "" }];
	const stop = tail.comma === undefined ? end(property) : tail.comma + 1;
	return [{ offset: object.offset + 1, length: stop - object.offset - 1, content: "" }];
}

/**
 * Apply one change to a JSONC document whose root is an object: set `value` at `path` (the
 * parent object must exist), or remove the key when `value` is undefined.
 */
export function patchJsonc(text: string, path: string[], value: unknown): string {
	const style = styleOf(text);
	const root = parseTree(text, [], { allowTrailingComma: true });
	const exists = root ? findNodeAtLocation(root, path) !== undefined : false;
	const edits = !root
		? undefined
		: value === undefined
			? exists
				? removeProperty(text, root, path)
				: []
			: exists
				? replaceValue(text, root, path, value, style)
				: insertProperty(text, root, path, value, style);
	// Anything the edits above do not cover falls back to jsonc-parser's own (reformatting) edit.
	return applyEdits(text, edits ?? modify(text, path, value, { formattingOptions: style.formatting }));
}
