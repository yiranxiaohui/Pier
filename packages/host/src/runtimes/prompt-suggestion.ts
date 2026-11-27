/**
 * Predicting the user's next prompt (1.76, `session.suggestion`): the instruction the runtimes
 * that ask a model themselves send (Claude Code predicts on its own), and what Pier keeps of the
 * answer.
 */

/** Longest suggestion shown: a longer answer is not a prompt the user would type next. */
export const MAX_SUGGESTION_LENGTH = 500;

/** The answer that means there is no clear next message. */
const NO_SUGGESTION = "NONE";

/** Appended to the conversation as the last user message (Codex, pi). */
export const SUGGESTION_INSTRUCTION = [
	"[Pier prompt suggestion: this message comes from Pier, not from the user.]",
	"Predict the next message the user is most likely to send you in this conversation, written the way the user writes, in the user's language.",
	"Reply with only that message: one short line, no quotes, no explanation. Do not call any tools and do not do the task.",
	`If there is no clear next message, reply with exactly ${NO_SUGGESTION}.`,
].join("\n");

/** One message of a conversation excerpt (see {@link excerptPrompt}). */
export interface ExcerptMessage {
	role: "user" | "assistant";
	text: string;
}

/** Longest excerpt of a conversation sent with {@link excerptPrompt}. */
const MAX_EXCERPT_CHARS = 12_000;
/** Longest part of one message in an excerpt. */
const MAX_EXCERPT_MESSAGE_CHARS = 3_000;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * A request to predict the next prompt from the end of a conversation, for a model that does not
 * see the conversation itself (OpenCode): the latest messages, newest kept first, up to a budget.
 * Undefined when there is no user message to go by.
 */
export function excerptPrompt(messages: readonly ExcerptMessage[]): string | undefined {
	const lines: string[] = [];
	let size = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const text = message?.text.trim();
		if (!message || !text) continue;
		const line = `${message.role === "user" ? "User" : "Assistant"}: ${clip(text, MAX_EXCERPT_MESSAGE_CHARS)}`;
		if (lines.length > 0 && size + line.length > MAX_EXCERPT_CHARS) break;
		lines.unshift(line);
		size += line.length;
	}
	if (!lines.some((line) => line.startsWith("User: "))) return undefined;
	return [
		"Below is the end of a conversation between a user and a coding agent.",
		"",
		"<conversation>",
		lines.join("\n\n"),
		"</conversation>",
		"",
		"Predict the next message the user is most likely to send the agent, written the way the user writes, in the user's language.",
		"Reply with only that message: one short line, no quotes, no explanation. Do not call any tools.",
		`If there is no clear next message, reply with exactly ${NO_SUGGESTION}.`,
	].join("\n");
}

const QUOTES: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
];

/** The suggestion to show for a model's answer, or undefined when there is none worth showing. */
export function cleanSuggestion(text: string | undefined): string | undefined {
	let suggestion = text?.trim() ?? "";
	for (const [open, close] of QUOTES) {
		if (suggestion.length > open.length + close.length && suggestion.startsWith(open) && suggestion.endsWith(close)) {
			suggestion = suggestion.slice(open.length, -close.length).trim();
			break;
		}
	}
	if (!suggestion || suggestion.length > MAX_SUGGESTION_LENGTH) return undefined;
	if (suggestion.replace(/[.。!！]+$/, "").toUpperCase() === NO_SUGGESTION) return undefined;
	return suggestion;
}
