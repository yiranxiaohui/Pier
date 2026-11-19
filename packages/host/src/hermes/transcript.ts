import type { LiveTranscript } from "../runtimes/live-transcript.ts";
import { acpText, type Json } from "./acp.ts";

/**
 * Hermes Agent's ACP session updates as a pi-shaped transcript. The same reducer reads the
 * history `session/load` replays and the updates of a live turn: text and thought chunks grouped
 * by `messageId`, tool calls started by `tool_call` and finished by a terminal `tool_call_update`.
 */

/** A Hermes tool call as Pier's clients render it (pi tool names where one fits). */
export interface MappedTool {
	/** Hermes' own tool name (`terminal`, `patch`, ...). */
	hermesName: string;
	name: string;
	arguments: Record<string, unknown>;
	path?: string;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

const TOOL_NAME = /^([A-Za-z_][\w.-]*)(?::\s+([\s\S]*))?$/;

/** Tool name and arguments from a `tool_call`: Hermes titles calls `<tool>: <preview>`. */
export function mapHermesTool(update: Json): MappedTool {
	const title = str(update.title) ?? "";
	const match = TOOL_NAME.exec(title.trim());
	const hermesName = match?.[1] ?? str(update.name) ?? str(update.kind) ?? "tool";
	const preview = match ? (match[2] ?? "").trim() : title.trim();
	const locations = Array.isArray(update.locations) ? (update.locations as Json[]) : [];
	const path = str(locations[0]?.path);
	const text = acpText(update.content).trim();
	const raw = update.rawInput && typeof update.rawInput === "object" ? (update.rawInput as Json) : undefined;
	switch (hermesName) {
		case "terminal": {
			const command = text.startsWith("$ ") ? text.slice(2) : (str(raw?.command) ?? preview);
			return { hermesName, name: "bash", arguments: { command }, ...(path ? { path } : {}) };
		}
		case "read_file":
			return { hermesName, name: "read", arguments: { path: path ?? preview }, ...(path ? { path } : {}) };
		case "write_file":
		case "patch": {
			const target = path ?? str(raw?.path) ?? preview;
			return { hermesName, name: "edit", arguments: { path: target }, path: target };
		}
		case "search_files": {
			const search = /^Searching for '([\s\S]*)' \((\w+)\)(?: in (.+))?$/.exec(text);
			if (search)
				return {
					hermesName,
					name: "grep",
					arguments: { pattern: search[1], ...(search[3] ? { path: search[3] } : {}) },
				};
			return { hermesName, name: "grep", arguments: { pattern: preview } };
		}
		default: {
			if (raw) return { hermesName, name: hermesName, arguments: raw };
			try {
				const parsed: unknown = text.startsWith("{") ? JSON.parse(text) : undefined;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
					return { hermesName, name: hermesName, arguments: parsed as Record<string, unknown> };
			} catch {
				// Truncated or not JSON: show it as text.
			}
			const args: Record<string, unknown> = {};
			if (preview) args.summary = preview;
			if (text && text !== preview) args.details = text;
			return { hermesName, name: hermesName, arguments: args };
		}
	}
}

/** A display diff (pi's `details.diff` format) of a whole-file change, trimmed to the changed lines. */
export function textDiff(oldText: string | undefined, newText: string, context = 3): string {
	const split = (text: string) => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));
	const a = split(oldText ?? "");
	const b = split(newText);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	if (start === endA && start === endB) return "";
	const from = Math.max(0, start - context);
	const tail = Math.min(context, a.length - endA);
	const width = String(Math.max(endA + tail, endB, 1)).length;
	const line = (mark: string, n: number, text: string) => `${mark}${String(n).padStart(width, " ")} ${text}`;
	const out: string[] = [];
	if (from > 0) out.push(` ${"".padStart(width, " ")} ...`);
	for (let i = from; i < start; i++) out.push(line(" ", i + 1, a[i] ?? ""));
	for (let i = start; i < endA; i++) out.push(line("-", i + 1, a[i] ?? ""));
	for (let i = start; i < endB; i++) out.push(line("+", i + 1, b[i] ?? ""));
	for (let i = 0; i < tail; i++) out.push(line(" ", endA + i + 1, a[endA + i] ?? ""));
	if (endA + tail < a.length) out.push(` ${"".padStart(width, " ")} ...`);
	return out.join("\n");
}

/** Diff of the `diff` blocks of an ACP tool call content, if any. */
function contentDiff(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const diffs = (content as Json[])
		.filter((block) => block?.type === "diff" && typeof block.newText === "string")
		.map((block) => textDiff(str(block.oldText), block.newText as string))
		.filter(Boolean);
	return diffs.length ? diffs.join(`\n ...\n`) : undefined;
}

export class HermesTranscript {
	private messageId: string | undefined;
	/** The streamed part chunks are appended to. */
	private open: { kind: "text" | "thinking"; index: number } | undefined;
	private userId: string | undefined;
	private lastUser = false;
	/** Tool calls by id: Hermes' name and the edited file. */
	private readonly tools = new Map<string, MappedTool>();
	/** Diffs shown in edit approvals, by file, for the edit tool call that is waiting for them. */
	private readonly diffs = new Map<string, string>();

	constructor(readonly transcript: LiveTranscript) {}

	/** Apply one transcript update; returns false for updates that are not about the transcript. */
	update(update: Json, replaying: boolean): boolean {
		switch (update.sessionUpdate) {
			case "user_message_chunk":
				if (replaying) this.userChunk(update);
				return true;
			case "agent_message_chunk":
				this.chunk("text", update);
				return true;
			case "agent_thought_chunk":
				this.chunk("thinking", update);
				return true;
			case "tool_call":
				this.toolCall(update);
				return true;
			case "tool_call_update":
				this.toolUpdate(update);
				return true;
			default:
				return false;
		}
	}

	/** An edit approval showed this diff: attach it to the edit's result. */
	rememberDiff(path: string, diff: string): void {
		if (diff) this.diffs.set(path, diff);
	}

	/** The turn ended: close the streamed message (with the turn's usage, when known). */
	finish(extra: Parameters<LiveTranscript["endAssistant"]>[0] = {}): void {
		this.closePart();
		this.transcript.endAssistant(extra);
		this.messageId = undefined;
		this.lastUser = false;
		this.diffs.clear();
	}

	private closePart(): void {
		const open = this.open;
		this.open = undefined;
		if (!open) return;
		if (open.kind === "text") this.transcript.textEnd(open.index);
		else this.transcript.thinkingEnd(open.index);
	}

	private closeAssistant(): void {
		this.closePart();
		this.transcript.endAssistant();
		this.messageId = undefined;
	}

	private userChunk(update: Json): void {
		const content = update.content as Json | undefined;
		const id = str(update.messageId);
		const text = content?.type === "text" ? str(content.text) : undefined;
		const image =
			content?.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string"
				? { type: "image" as const, data: content.data, mimeType: content.mimeType }
				: undefined;
		if (!text && !image) return;
		const last = this.transcript.messages.at(-1);
		if (this.lastUser && id && id === this.userId && last?.role === "user") {
			// More of the same user message.
			const parts = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
			last.content = [...parts, ...(text ? [{ type: "text" as const, text }] : []), ...(image ? [image] : [])];
			return;
		}
		this.closeAssistant();
		this.transcript.addUser(image ? [...(text ? [{ type: "text" as const, text }] : []), image] : (text ?? ""));
		this.userId = id;
		this.lastUser = true;
	}

	private chunk(kind: "text" | "thinking", update: Json): void {
		const content = update.content as Json | undefined;
		let text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
		if (!text) return;
		this.lastUser = false;
		const id = str(update.messageId);
		if (id && this.messageId && id !== this.messageId) this.closeAssistant();
		if (id) this.messageId = id;
		const t = this.transcript;
		if (this.open?.kind !== kind) {
			// Hermes often starts the reply after its tool calls with blank lines.
			text = text.replace(/^\s+/, "");
			if (!text) return;
			this.closePart();
			this.open = { kind, index: kind === "text" ? t.textStart() : t.thinkingStart() };
		}
		if (kind === "text") t.textDelta(this.open.index, text);
		else t.thinkingDelta(this.open.index, text);
	}

	private toolCall(update: Json): void {
		const id = str(update.toolCallId);
		if (!id) return;
		this.lastUser = false;
		if (this.tools.has(id) || this.transcript.pendingToolCalls.includes(id)) {
			this.toolUpdate(update);
			return;
		}
		const tool = mapHermesTool(update);
		this.tools.set(id, tool);
		this.closePart();
		this.transcript.toolCall({ type: "toolCall", id, name: tool.name, arguments: tool.arguments });
		// As pi does: the assistant message ends with its tool calls, then they run.
		this.transcript.endAssistant();
		this.messageId = undefined;
		this.toolUpdate(update);
	}

	private toolUpdate(update: Json): void {
		const id = str(update.toolCallId);
		// Permission cards and the like are tool calls of their own that never started here.
		if (!id || !this.transcript.pendingToolCalls.includes(id)) return;
		const status = update.status;
		const text = acpText(update.content);
		if (status === "completed" || status === "failed") {
			const tool = this.tools.get(id);
			const raw = typeof update.rawOutput === "string" ? update.rawOutput : undefined;
			const diff =
				contentDiff(update.content) ??
				(tool?.path && tool.name === "edit" && status === "completed" ? this.diffs.get(tool.path) : undefined);
			if (tool?.path) this.diffs.delete(tool.path);
			this.transcript.toolResult(id, {
				text: text || raw || (status === "failed" ? "Failed" : ""),
				isError: status === "failed",
				...(diff ? { details: { diff } } : {}),
			});
			this.tools.delete(id);
		} else if (text && update.sessionUpdate === "tool_call_update") {
			this.transcript.toolUpdate(id, text);
		}
	}
}
