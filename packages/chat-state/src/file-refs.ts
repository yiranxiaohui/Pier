/**
 * A workspace file picked into a message (a chip in the desktop composer) is sent as Markdown inline
 * code holding its path, e.g. `docs/plan.md`: the agent reads a plain path, and a transcript can show
 * the chip again. Inline code reads as a file when it is path-shaped (see `codeSpanPath`); a picked
 * relative path that would not is sent with a leading "./" (`./README.md`, `./docs/my notes.md`), so
 * every picked file reads back as one.
 */

export type FileRefPart = { type: "text"; text: string } | { type: "file"; path: string };

const EXPLICIT = /^\.\.?\/./;
const URL_SCHEME = /^[a-zA-Z][\w+.-]*:\/\//;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const EXTENSION = /\.[a-zA-Z][\w-]*$/;

/**
 * The path in an inline code span when it reads as a file or directory: anything after "./" or
 * "../", or a path without spaces that has a "/" and ends in a file extension or "/". Code such as
 * `console.log`, `/api/status` or `origin/main` stays code. A leading "./" is dropped.
 */
export function codeSpanPath(code: string): string | undefined {
	if (!code || code.length > 4096 || /[\r\n\t]/.test(code) || code !== code.trim()) return undefined;
	if (EXPLICIT.test(code)) return code.startsWith("./") ? code.slice(2) : code;
	if (/\s/.test(code) || URL_SCHEME.test(code) || code.startsWith("//")) return undefined;
	const separator = WINDOWS_ABSOLUTE.test(code) ? /[\\/]/ : /\//;
	const segments = code.split(separator);
	if (segments.length < 2) return undefined;
	const directory = segments.at(-1) === "";
	const name = segments.filter(Boolean).at(-1) ?? "";
	if (!name || name === "." || name === ".." || name === "~" || /^[a-zA-Z]:$/.test(name)) return undefined;
	return directory || EXTENSION.test(name) ? code : undefined;
}

/** Markdown inline code for `text`, fenced with more backticks than any run inside it. */
function inlineCode(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * How a picked file (directories end with "/") is written in a message. An absolute path the rules
 * cannot read as one (`/etc/hosts`) is still sent as it is: "./" would change it.
 */
export function fileRefMarkdown(path: string): string {
	const absolute = /^(?:\/|~\/)/.test(path) || WINDOWS_ABSOLUTE.test(path);
	return inlineCode(absolute || codeSpanPath(path) !== undefined ? path : `./${path}`);
}

/** Split a message into its text and the file paths written as inline code in it. */
export function splitFileRefs(text: string): FileRefPart[] {
	const parts: FileRefPart[] = [];
	let last = 0;
	let at = 0;
	while (at < text.length) {
		const open = text.indexOf("`", at);
		if (open < 0) break;
		const start = runEnd(text, open);
		const size = start - open;
		// A code span ends at the next run of exactly as many backticks (CommonMark); without one the
		// opening run is literal text.
		let close = -1;
		for (let i = text.indexOf("`", start); i >= 0; ) {
			const end = runEnd(text, i);
			if (end - i === size) {
				close = i;
				break;
			}
			i = text.indexOf("`", end);
		}
		if (close < 0) {
			at = start;
			continue;
		}
		let code = text.slice(start, close);
		if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
		const path = codeSpanPath(code);
		if (path !== undefined) {
			if (open > last) parts.push({ type: "text", text: text.slice(last, open) });
			parts.push({ type: "file", path });
			last = close + size;
		}
		at = close + size;
	}
	if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
	return parts;
}

function runEnd(text: string, start: number): number {
	let end = start;
	while (text[end] === "`") end++;
	return end;
}

/** A message with its file references written as bare paths, as a person would read it. */
export function unwrapFileRefs(text: string): string {
	return splitFileRefs(text)
		.map((part) => (part.type === "file" ? part.path : part.text))
		.join("");
}

/** The label of a file reference: its last path segment ("/" kept for directories). */
export function fileRefLabel(path: string): string {
	const directory = /[\\/]$/.test(path);
	const trimmed = path.replace(/[\\/]+$/, "");
	const name = trimmed.split(/[\\/]/).pop() || trimmed;
	return directory ? `${name}/` : name;
}
