import { fileRefLabel, fileRefMarkdown } from "@pier/chat-state";

/**
 * Composer drafts are plain strings in which a workspace file reference (shown as a chip in
 * the composer) is encoded as `FILE_OPEN + path + FILE_CLOSE`. The markers are private-use
 * characters, so typed or pasted text never contains them. A directory path ends with "/".
 */
export const FILE_OPEN = "\uE000";
export const FILE_CLOSE = "\uE001";

const TOKEN = /\uE000([^\uE000\uE001]*)\uE001/g;
const MARKERS = /[\uE000\uE001]/g;

export type DraftPart = { type: "text"; text: string } | { type: "file"; path: string };

/** Encode a file reference. Directories get a trailing "/". */
export function fileToken(path: string, directory = false): string {
	const clean = path.replace(MARKERS, "").replace(/\/+$/, "");
	return `${FILE_OPEN}${directory ? `${clean}/` : clean}${FILE_CLOSE}`;
}

/** Remove chip markers from typed or pasted text. */
export function stripMarkers(text: string): string {
	return text.replace(MARKERS, "");
}

/** Split a draft into text runs and file references (empty text runs are omitted). */
export function splitDraft(draft: string): DraftPart[] {
	const parts: DraftPart[] = [];
	let last = 0;
	for (const match of draft.matchAll(TOKEN)) {
		const index = match.index ?? 0;
		if (index > last) parts.push({ type: "text", text: stripMarkers(draft.slice(last, index)) });
		if (match[1]) parts.push({ type: "file", path: match[1] });
		last = index + match[0].length;
	}
	if (last < draft.length) parts.push({ type: "text", text: stripMarkers(draft.slice(last)) });
	return parts.filter((p) => p.type === "file" || p.text);
}

/**
 * The draft's plain text: each file reference becomes its workspace-relative path. Slash commands
 * are read (and sent) from this; copying a selection yields it.
 */
export function draftToPrompt(draft: string): string {
	return splitDraft(draft)
		.map((p) => (p.type === "file" ? p.path : p.text))
		.join("");
}

/**
 * The message sent to the agent: each file reference becomes its path as Markdown inline code, which
 * the transcript shows as a chip again (see `@pier/chat-state`'s `file-refs.ts`).
 */
export function draftToMessage(draft: string): string {
	return splitDraft(draft)
		.map((p) => (p.type === "file" ? fileRefMarkdown(p.path) : p.text))
		.join("");
}

/** Label shown on a chip: the last path segment (with "/" for directories). */
export const fileChipLabel = fileRefLabel;
