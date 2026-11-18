import { stripImageHints } from "@pier/chat-state";
import type { WireEvent } from "@pier/protocol";

/**
 * Pi-shaped transcript for runtimes that are not pi (Claude Code, Codex). Pier's clients render
 * pi `AgentMessage` values and pi session events, so these runtimes build the same messages and
 * emit the same events (`message_start` / `message_update` / `message_end`, `tool_execution_*`,
 * `agent_start` / `agent_end` / `agent_settled`) through this class.
 */

export interface TextPart {
	type: "text";
	text: string;
	/** Retained in snapshots so clients can detect gaps between streamed parts. */
	completed?: boolean;
}

export interface ThinkingPart {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
	completed?: boolean;
}

export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessage {
	role: "user";
	content: string | Array<TextPart | ImagePart>;
	timestamp: number;
	/** Runtime id of the message (Claude uuid, Codex turn id), for forking. Not sent to clients. */
	entryId?: string;
}

export interface AssistantMessage {
	role: "assistant";
	content: Array<TextPart | ThinkingPart | ToolCallPart>;
	api?: string;
	provider?: string;
	model?: string;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextPart | ImagePart>;
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type TranscriptMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolResultInput {
	text: string;
	isError?: boolean;
	details?: unknown;
	images?: ImagePart[];
}

export const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

export class LiveTranscript {
	readonly messages: TranscriptMessage[] = [];
	private draft: AssistantMessage | undefined;
	/** Tool calls that were generated but have no result yet. */
	private readonly pending = new Map<string, ToolCallPart>();
	private running = false;
	errorMessage: string | undefined;

	constructor(
		private readonly emit: (event: WireEvent) => void,
		/** Provider and model stamped on assistant messages. */
		private readonly meta: () => { provider: string; model?: string; api?: string },
	) {}

	get streaming(): AssistantMessage | undefined {
		return this.draft;
	}

	get pendingToolCalls(): string[] {
		return [...this.pending.keys()];
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Replace the transcript (after loading a stored session). */
	load(messages: TranscriptMessage[]): void {
		this.messages.splice(0, this.messages.length, ...messages);
		this.draft = undefined;
		this.pending.clear();
	}

	startRun(): void {
		if (this.running) return;
		this.running = true;
		delete this.errorMessage;
		this.emit({ type: "agent_start" });
	}

	addUser(content: UserMessage["content"], entryId?: string): UserMessage {
		const message: UserMessage = { role: "user", content, timestamp: Date.now(), ...(entryId ? { entryId } : {}) };
		const wire = publicMessage(message);
		this.emit({ type: "message_start", message: wire });
		this.messages.push(message);
		this.emit({ type: "message_end", message: wire });
		return message;
	}

	/** The transcript as clients see it. */
	publicMessages(): TranscriptMessage[] {
		return this.messages.map(publicMessage);
	}

	/** Start an assistant message unless one is being streamed. Returns it. */
	beginAssistant(): AssistantMessage {
		if (this.draft) return this.draft;
		const meta = this.meta();
		this.draft = {
			role: "assistant",
			content: [],
			...(meta.api ? { api: meta.api } : {}),
			provider: meta.provider,
			...(meta.model ? { model: meta.model } : {}),
			usage: { ...EMPTY_USAGE },
			timestamp: Date.now(),
		};
		this.emit({ type: "message_start", message: structuredClone(this.draft) });
		return this.draft;
	}

	private update(event: Record<string, unknown>): void {
		this.emit({ type: "message_update", usage: this.draft?.usage, assistantMessageEvent: event });
	}

	/** Index of a new content part at the end of the draft. */
	nextIndex(): number {
		return this.beginAssistant().content.length;
	}

	textStart(index = this.nextIndex()): number {
		const draft = this.beginAssistant();
		draft.content[index] = { type: "text", text: "", completed: false };
		this.update({ type: "text_start", contentIndex: index });
		return index;
	}

	textDelta(index: number, delta: string): void {
		const part = this.beginAssistant().content[index];
		if (part?.type !== "text") return;
		part.text += delta;
		part.completed = false;
		this.update({ type: "text_delta", contentIndex: index, delta });
	}

	textEnd(index: number, content?: string): void {
		const part = this.beginAssistant().content[index];
		if (part?.type !== "text") return;
		if (content !== undefined) part.text = content;
		part.completed = true;
		this.update({ type: "text_end", contentIndex: index, content: part.text });
	}

	/** A complete text part. */
	text(text: string): void {
		const index = this.textStart();
		this.textEnd(index, text);
	}

	thinkingStart(index = this.nextIndex(), redacted = false): number {
		const draft = this.beginAssistant();
		draft.content[index] = {
			type: "thinking",
			thinking: "",
			completed: false,
			...(redacted ? { redacted: true } : {}),
		};
		this.update({ type: "thinking_start", contentIndex: index });
		return index;
	}

	thinkingDelta(index: number, delta: string): void {
		const part = this.beginAssistant().content[index];
		if (part?.type !== "thinking") return;
		part.thinking += delta;
		part.completed = false;
		this.update({ type: "thinking_delta", contentIndex: index, delta });
	}

	thinkingEnd(index: number, content?: string): void {
		const part = this.beginAssistant().content[index];
		if (part?.type !== "thinking") return;
		if (content !== undefined) part.thinking = content;
		part.completed = true;
		this.update({ type: "thinking_end", contentIndex: index, content: part.thinking });
	}

	toolCallStart(id: string, name: string, index = this.nextIndex()): number {
		const draft = this.beginAssistant();
		draft.content[index] = { type: "toolCall", id, name, arguments: {} };
		this.update({ type: "toolcall_start", contentIndex: index, id, toolName: name });
		return index;
	}

	toolCallDelta(index: number, delta: string): void {
		this.update({ type: "toolcall_delta", contentIndex: index, delta });
	}

	toolCallEnd(index: number, call: ToolCallPart): void {
		const draft = this.beginAssistant();
		draft.content[index] = call;
		this.pending.set(call.id, call);
		this.update({ type: "toolcall_end", contentIndex: index, toolCall: call });
	}

	/** A complete tool call part. */
	toolCall(call: ToolCallPart): void {
		const index = this.toolCallStart(call.id, call.name);
		this.toolCallEnd(index, call);
	}

	/**
	 * Remove parts of the streamed message, for output the runtime takes back: a model response cut
	 * off by a dropped connection, which the runtime requests again. Tool calls among them are no
	 * longer pending. Content indices of the remaining parts change, so the caller must not keep any.
	 * Clients replace their copy of the streamed message from the `message_start` this repeats.
	 */
	discard(indices: Iterable<number>): void {
		const draft = this.draft;
		if (!draft) return;
		const drop = new Set(indices);
		if (!draft.content.some((part, index) => part && drop.has(index))) return;
		const content: AssistantMessage["content"] = [];
		for (const [index, part] of draft.content.entries()) {
			if (!part) continue;
			if (!drop.has(index)) content.push(part);
			else if (part.type === "toolCall") this.pending.delete(part.id);
		}
		draft.content = content;
		this.emit({ type: "message_start", message: structuredClone(draft) });
	}

	setUsage(usage: Usage): void {
		const draft = this.beginAssistant();
		draft.usage = usage;
	}

	/**
	 * Finish the streamed assistant message and start executing its tool calls (as pi does:
	 * `tool_execution_start` follows the assistant's `message_end`).
	 */
	endAssistant(extra: { stopReason?: string; errorMessage?: string; usage?: Usage; model?: string } = {}): void {
		const draft = this.draft;
		if (!draft) return;
		this.draft = undefined;
		// Parts can be sparse when a runtime skipped content indices.
		draft.content = draft.content.filter(Boolean);
		if (extra.usage) draft.usage = extra.usage;
		if (extra.model) draft.model = extra.model;
		const calls = draft.content.filter((p): p is ToolCallPart => p.type === "toolCall");
		draft.stopReason = extra.stopReason ?? (calls.length ? "toolUse" : "stop");
		if (extra.errorMessage) draft.errorMessage = extra.errorMessage;
		this.messages.push(draft);
		this.emit({ type: "message_end", message: draft });
		for (const call of calls) {
			if (!this.pending.has(call.id)) continue;
			this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
		}
	}

	toolUpdate(id: string, text: string, details?: unknown): void {
		const call = this.pending.get(id);
		if (!call) return;
		this.emit({
			type: "tool_execution_update",
			toolCallId: id,
			toolName: call.name,
			args: call.arguments,
			partialResult: { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) },
		});
	}

	toolResult(id: string, result: ToolResultInput, toolName?: string): void {
		const call = this.pending.get(id);
		this.pending.delete(id);
		const name = call?.name ?? toolName ?? "";
		const content: Array<TextPart | ImagePart> = [{ type: "text", text: result.text }, ...(result.images ?? [])];
		const isError = result.isError === true;
		this.emit({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: name,
			result: { content, ...(result.details === undefined ? {} : { details: result.details }) },
			isError,
		});
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content,
			...(result.details === undefined ? {} : { details: result.details }),
			isError,
			timestamp: Date.now(),
		};
		this.emit({ type: "message_start", message });
		this.messages.push(message);
		this.emit({ type: "message_end", message });
	}

	/** End the run: close the streamed message and report tool calls that never finished. */
	endRun(errorMessage?: string): void {
		if (this.draft) this.endAssistant(errorMessage ? { stopReason: "error", errorMessage } : {});
		else if (errorMessage) {
			// Show the error like pi does: an assistant message that stopped with an error.
			this.beginAssistant();
			this.endAssistant({ stopReason: "error", errorMessage });
		}
		for (const id of [...this.pending.keys()]) {
			this.toolResult(id, { text: errorMessage ?? "The tool call did not finish.", isError: true });
		}
		if (errorMessage) this.errorMessage = errorMessage;
		if (!this.running) return;
		this.running = false;
		this.emit({ type: "agent_end", messages: [] });
		this.emit({ type: "agent_settled" });
	}
}

export function usageFrom(input: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
}): Usage {
	const usage: Usage = {
		input: input.input ?? 0,
		output: input.output ?? 0,
		cacheRead: input.cacheRead ?? 0,
		cacheWrite: input.cacheWrite ?? 0,
		totalTokens: 0,
	};
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (input.costUsd !== undefined) {
		usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input.costUsd };
	}
	return usage;
}

/** Text of a user message's content. */
export function userContentText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p): p is TextPart => p.type === "text")
		.map((p) => p.text)
		.join(" ");
}

/** First user prompt of a transcript, for session lists. */
export function firstPromptOf(messages: TranscriptMessage[]): string {
	const first = messages.find((m): m is UserMessage => m.role === "user");
	return first ? stripImageHints(userContentText(first.content)).slice(0, 200) : "";
}

/** A message without host-only fields. */
export function publicMessage(message: TranscriptMessage): TranscriptMessage {
	if (message.role !== "user" || message.entryId === undefined) return message;
	const { entryId: _entryId, ...rest } = message;
	return rest;
}
