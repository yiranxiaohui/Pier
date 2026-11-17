/**
 * Thinking written as text. Some models (or the relays in front of them) put their reasoning
 * summaries into the reply itself, wrapped in literal `<thinking>…</thinking>` or
 * `<think>…</think>` tags that are not always closed. Rendered as Markdown the tags show up
 * verbatim, so text parts are split into text and thinking segments for display.
 */

export type TextSegment = { kind: "text"; text: string } | { kind: "thinking"; text: string; closed: boolean };

/** An opening tag at the start of a line. */
const OPEN_TAG = /^[ \t]*<(thinking|think)>/;
/** A Markdown code fence opener; tags inside code blocks stay text. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TAGS = ["<thinking>", "<think>"];

/** Whether `line` is the start of an opening tag still being streamed, e.g. `<thin`. */
function partialTag(line: string): boolean {
	const rest = line.trimStart();
	return rest.length > 0 && TAGS.some((tag) => tag.length > rest.length && tag.startsWith(rest));
}

/** Text without its leading blank lines and trailing whitespace. */
function trimText(text: string): string {
	return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/**
 * Split `text` into text and thinking segments. Tags only count at the start of a line and
 * outside code blocks; an unclosed tag runs to the end of the text. With `streaming`, the
 * start of a tag at the end of the text (`<thi`) is held back until it is complete.
 */
export function splitThinkingTags(text: string, streaming = false): TextSegment[] {
	if (!text.includes("<think") && !(streaming && text.includes("<"))) return text ? [{ kind: "text", text }] : [];
	const segments: TextSegment[] = [];
	const pushText = (chunk: string) => {
		const trimmed = trimText(chunk);
		if (trimmed) segments.push({ kind: "text", text: trimmed });
	};
	let fence: string | undefined;
	let textStart = 0;
	let lineStart = 0;
	while (lineStart < text.length) {
		const newline = text.indexOf("\n", lineStart);
		const line = text.slice(lineStart, newline < 0 ? text.length : newline);
		if (fence) {
			if (line.trimStart().startsWith(fence)) fence = undefined;
		} else {
			const opener = FENCE.exec(line);
			const tag = opener ? null : OPEN_TAG.exec(line);
			if (opener?.[1]) fence = opener[1];
			else if (tag) {
				pushText(text.slice(textStart, lineStart));
				const bodyStart = lineStart + tag[0].length;
				const closeTag = `</${tag[1]}>`;
				const close = text.indexOf(closeTag, bodyStart);
				segments.push({
					kind: "thinking",
					text: text.slice(bodyStart, close < 0 ? text.length : close).trim(),
					closed: close >= 0,
				});
				if (close < 0) return segments;
				textStart = lineStart = close + closeTag.length;
				continue;
			} else if (streaming && newline < 0 && partialTag(line)) {
				pushText(text.slice(textStart, lineStart));
				return segments;
			}
		}
		if (newline < 0) break;
		lineStart = newline + 1;
	}
	pushText(text.slice(textStart));
	return segments;
}

/** Whether `text` has anything to show as text once its thinking tags are taken out. */
export function hasVisibleText(text: string, streaming = false): boolean {
	return splitThinkingTags(text, streaming).some((s) => s.kind === "text" && s.text.trim());
}

/**
 * Thinking text for display: reasoning summaries often arrive as titles run together
 * (`**Planning****Checking tests**`, or `…done.**Next step**`), which are put on lines of
 * their own. With `plain`, the bold markers of those title lines are removed too.
 */
export function formatThinking(text: string, { plain = false }: { plain?: boolean } = {}): string {
	const out = text
		.replace(/(\*\*[^*\n]+\*\*)(?=\*\*[^*\n]+\*\*)/g, "$1\n\n")
		.replace(/([^\s*])(\*\*[^*\n]+\*\*)(?=\n|$)/g, "$1\n\n$2");
	return plain ? out.replace(/^\*\*([^*\n]+)\*\*[ \t]*$/gm, "$1") : out;
}

/** Longest one-line thinking text used as its own headline. */
const HEADLINE_MAX = 160;

/**
 * The latest title of a reasoning summary (its last `**…**` line), or the whole text when it
 * is a single short line; shown next to a collapsed thinking block.
 */
export function thinkingHeadline(text: string): string | undefined {
	const formatted = formatThinking(text.trim());
	let headline: string | undefined;
	for (const match of formatted.matchAll(/^\*\*([^*\n]+)\*\*/gm)) headline = match[1];
	headline = headline?.trim();
	if (headline) return headline;
	const line = formatted.trim();
	return line && !line.includes("\n") && line.length <= HEADLINE_MAX ? line : undefined;
}
