import type { SessionSummary } from "@pier/protocol";
import { stripTrailingImageHints } from "./messages.ts";

const TITLE_LENGTH = 32;

/** Compact display title shared by desktop and mobile; full text is available for tooltips. */
export function sessionTitle(
	session: Pick<SessionSummary, "name" | "firstMessage">,
	options: { full?: boolean } = {},
): string {
	// Older hosts send the first prompt with pi's image notes still attached.
	const raw = session.firstMessage.replace(/\s+/g, " ").trim();
	const title = session.name?.replace(/\s+/g, " ").trim() || stripTrailingImageHints(raw) || (raw ? "图片" : "新会话");
	if (options.full) return title;
	// Count Unicode code points so truncation never leaves half of a surrogate pair.
	const characters = Array.from(title);
	return characters.length > TITLE_LENGTH
		? `${characters
				.slice(0, TITLE_LENGTH - 1)
				.join("")
				.trimEnd()}…`
		: title;
}
