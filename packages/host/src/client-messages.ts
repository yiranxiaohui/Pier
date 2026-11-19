import type { WireEvent } from "@pier/protocol";

/**
 * Provider data in message content that only matters when the conversation is sent back to
 * the model: signatures of reasoning, text and tool-call blocks (encrypted reasoning for
 * OpenAI and Anthropic, thought signatures for Gemini). Encrypted reasoning is a large share
 * of a long transcript (about a fifth of a typical pi session) and does not compress, while
 * clients never show it or send it back. The host leaves it out of the messages it sends;
 * the session files and the agent keep it.
 */
const OPAQUE_PART_FIELDS = ["thinkingSignature", "textSignature", "thoughtSignature"] as const;

function withoutOpaqueFields(part: unknown): unknown {
	if (!part || typeof part !== "object") return part;
	const record = part as Record<string, unknown>;
	if (!OPAQUE_PART_FIELDS.some((field) => field in record)) return part;
	const copy = { ...record };
	for (const field of OPAQUE_PART_FIELDS) delete copy[field];
	return copy;
}

/** A message as clients get it: the same object when it carries no opaque provider data. */
export function clientMessage(message: unknown): unknown {
	if (!message || typeof message !== "object") return message;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return message;
	let changed = false;
	const parts = content.map((part) => {
		const next = withoutOpaqueFields(part);
		if (next !== part) changed = true;
		return next;
	});
	return changed ? { ...(message as Record<string, unknown>), content: parts } : message;
}

/** {@link clientMessage} for a list; the same array when nothing changed. */
export function clientMessages(messages: readonly unknown[]): unknown[] {
	let changed = false;
	const out = messages.map((message) => {
		const next = clientMessage(message);
		if (next !== message) changed = true;
		return next;
	});
	return changed ? out : (messages as unknown[]);
}

/**
 * An event as clients get it: the messages it carries without opaque provider data, so a
 * transcript built from events matches the snapshot (`knownMessages` fingerprints).
 */
export function clientEvent(event: WireEvent): WireEvent {
	switch (event.type) {
		case "message_start":
		case "message_end": {
			const message = clientMessage(event.message);
			return message === event.message ? event : { ...event, message };
		}
		case "turn_end": {
			const message = clientMessage(event.message);
			const toolResults = Array.isArray(event.toolResults) ? clientMessages(event.toolResults) : event.toolResults;
			return message === event.message && toolResults === event.toolResults
				? event
				: { ...event, message, toolResults };
		}
		case "agent_end": {
			const messages = Array.isArray(event.messages) ? clientMessages(event.messages) : event.messages;
			return messages === event.messages ? event : { ...event, messages };
		}
		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (!inner || typeof inner !== "object") return event;
			const update = inner as Record<string, unknown>;
			let changed = false;
			const next: Record<string, unknown> = { ...update };
			for (const key of ["toolCall", "message", "error"] as const) {
				if (!(key in update)) continue;
				const value = key === "toolCall" ? withoutOpaqueFields(update[key]) : clientMessage(update[key]);
				if (value !== update[key]) {
					next[key] = value;
					changed = true;
				}
			}
			return changed ? { ...event, assistantMessageEvent: next } : event;
		}
		default:
			return event;
	}
}
