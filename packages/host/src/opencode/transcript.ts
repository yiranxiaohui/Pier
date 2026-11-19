import type { AssistantMessage, Event, Part, SessionMessagesResponse2 } from "@opencode-ai/sdk/v2/client";
import {
	type ImagePart,
	type LiveTranscript,
	type TextPart,
	type TranscriptMessage,
	usageFrom,
} from "../runtimes/live-transcript.ts";

/** Tokens in the context after a reply, counted as OpenCode counts them for its own compaction. */
export function contextTokensOf(tokens: AssistantMessage["tokens"]): number {
	return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
}

export function errorText(error: AssistantMessage["error"]): string | undefined {
	if (!error || error.name === "MessageAbortedError") return;
	return typeof error.data.message === "string" ? error.data.message : error.name;
}

/** The same reducer consumes native history and live parts. Full part updates can repeat after deltas. */
export class OpenCodeTranscript {
	private assistantId?: string;
	private readonly parts = new Map<string, number>();
	private readonly tools = new Set<string>();
	private readonly inputs = new Map<string, Record<string, unknown>>();
	private readonly users = new Set<string>();

	constructor(
		readonly transcript: LiveTranscript,
		/** Called with each reply that finished. */
		private readonly onReply?: (info: AssistantMessage) => void,
	) {}

	toolInput(callID?: string): Record<string, unknown> | undefined {
		return callID ? this.inputs.get(callID) : undefined;
	}

	history(messages: SessionMessagesResponse2): void {
		for (const { info, parts } of messages) {
			// A compaction is a user message with a `compaction` part, answered by the summary.
			if (info.role === "user" && parts.some((part) => part.type === "compaction")) continue;
			if (info.role === "assistant" && info.summary) {
				this.transcript.endAssistant();
				this.transcript.messages.push({
					role: "compactionSummary",
					summary: parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
					tokensBefore: 0,
					timestamp: info.time.created,
				} as unknown as TranscriptMessage);
				continue;
			}
			if (info.role === "user") {
				const content: Array<TextPart | ImagePart> = [];
				for (const part of parts) {
					if (part.type === "text" && !part.synthetic && !part.ignored) content.push({ type: "text", text: part.text });
					if (
						part.type === "file" &&
						part.mime.startsWith("image/") &&
						part.url.startsWith(`data:${part.mime};base64,`)
					) {
						content.push({ type: "image", mimeType: part.mime, data: part.url.slice(part.url.indexOf(",") + 1) });
					}
				}
				this.transcript.addUser(content, info.id).timestamp = info.time.created;
				continue;
			}
			for (const part of parts) this.part(part);
			this.end(info);
		}
	}

	event(event: Event): void {
		switch (event.type) {
			case "message.updated": {
				const info = event.properties.info;
				if (info.role === "user") this.users.add(info.id);
				else if (info.time.completed && this.assistantId === info.id) this.end(info);
				break;
			}
			case "message.part.updated":
				this.part(event.properties.part);
				break;
			case "message.part.delta": {
				const { partID, field, delta } = event.properties;
				const index = this.parts.get(partID);
				if (field !== "text" || index === undefined) break;
				if (this.transcript.streaming?.content[index]?.type === "thinking") this.transcript.thinkingDelta(index, delta);
				else this.transcript.textDelta(index, delta);
				break;
			}
		}
	}

	private part(part: Part): void {
		if (this.users.has(part.messageID)) return;
		if (this.assistantId !== part.messageID) {
			this.transcript.endAssistant();
			this.parts.clear();
			this.assistantId = part.messageID;
		}
		if (part.type === "text" || part.type === "reasoning") {
			const t = this.transcript;
			let index = this.parts.get(part.id);
			if (index === undefined) {
				index = part.type === "text" ? t.textStart() : t.thinkingStart();
				this.parts.set(part.id, index);
			}
			if (part.time?.end !== undefined) {
				if (part.type === "text") t.textEnd(index, part.text);
				else t.thinkingEnd(index, part.text);
			} else {
				const draft = t.streaming?.content[index];
				const previous = draft?.type === "text" ? draft.text : draft?.type === "thinking" ? draft.thinking : "";
				if (part.text.startsWith(previous) && previous.length < part.text.length) {
					const delta = part.text.slice(previous.length);
					if (part.type === "text") t.textDelta(index, delta);
					else t.thinkingDelta(index, delta);
				}
			}
		} else if (part.type === "tool" && part.state.status !== "pending") {
			this.inputs.set(part.callID, part.state.input);
			if (!this.tools.has(part.id)) {
				this.tools.add(part.id);
				this.transcript.toolCall({ type: "toolCall", id: part.callID, name: part.tool, arguments: part.state.input });
				this.transcript.endAssistant();
				this.parts.clear();
			}
			if (
				(part.state.status === "completed" || part.state.status === "error") &&
				this.transcript.pendingToolCalls.includes(part.callID)
			) {
				const result =
					part.state.status === "error" ? { text: part.state.error, isError: true } : { text: part.state.output };
				this.transcript.toolResult(part.callID, result);
				this.inputs.delete(part.callID);
			}
		}
	}

	private end(info: AssistantMessage): void {
		this.onReply?.(info);
		const t = this.transcript;
		if (t.streaming) {
			t.streaming.timestamp = info.time.created;
			const errorMessage = errorText(info.error);
			t.endAssistant({
				model: info.modelID,
				usage: usageFrom({
					input: info.tokens.input,
					output: info.tokens.output,
					cacheRead: info.tokens.cache.read,
					cacheWrite: info.tokens.cache.write,
					costUsd: info.cost,
				}),
				...(errorMessage ? { stopReason: "error", errorMessage } : {}),
			});
		} else if (info.error && errorText(info.error)) {
			t.endRun(errorText(info.error));
		}
		this.parts.clear();
		this.assistantId = undefined;
	}
}
