import type { SubagentInfo } from "@pier/protocol";
import {
	type AnyMessage,
	type AssistantMessage,
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	contentImages,
	contentText,
	type ImagePart,
	type ToolCallPart,
	type ToolResultMessage,
	userText,
} from "./messages.ts";
import { type ChatState, subagentsOf, type ToolExecution } from "./reducer.ts";

/**
 * Tool call lifecycle as displayed:
 * - `generating`: the model is still streaming the call's arguments;
 * - `pending`: generated, not started yet (e.g. waiting for approval);
 * - `running` / `done` / `error`: executing / finished;
 * - `interrupted`: the run ended without a result (aborted).
 */
export type ToolStatus = "generating" | "pending" | "running" | "done" | "error" | "interrupted";

export interface ToolBlock {
	kind: "tool";
	call: ToolCallPart;
	status: ToolStatus;
	execution?: ToolExecution;
	result?: ToolResultMessage;
	/** Subagents this call started (1.54). */
	subagents?: SubagentInfo[];
}

export type AssistantBlock =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; redacted: boolean; live: boolean }
	| ToolBlock;

export type TranscriptItem =
	| { kind: "user"; key: string; text: string; images: ImagePart[]; timestamp: number }
	| {
			kind: "assistant";
			key: string;
			message: AssistantMessage;
			blocks: AssistantBlock[];
			streaming: boolean;
	  }
	| { kind: "bash"; key: string; message: BashExecutionMessage }
	| { kind: "custom"; key: string; message: CustomMessage; text: string }
	| { kind: "compaction"; key: string; message: CompactionSummaryMessage }
	| { kind: "branchSummary"; key: string; message: BranchSummaryMessage }
	| { kind: "toolResult"; key: string; message: ToolResultMessage }
	| { kind: "unknown"; key: string; message: AnyMessage };

function assistantBlocks(
	message: AssistantMessage,
	streaming: boolean,
	results: Map<string, ToolResultMessage>,
	state: ChatState,
): AssistantBlock[] {
	const blocks: AssistantBlock[] = [];
	const content = message.content ?? [];
	for (const [index, part] of content.entries()) {
		if (!part) continue;
		if (part.type === "text") {
			if (part.text) blocks.push({ kind: "text", text: part.text });
		} else if (part.type === "thinking") {
			// Keep the in-progress thinking part even before (or without) any text: some
			// providers stream only an empty/encrypted thinking block for a long time,
			// and dropping it would leave the reply blank while the model is working.
			const live = streaming && part.completed !== true && index === content.length - 1;
			if (part.thinking || part.redacted || live) {
				blocks.push({ kind: "thinking", text: part.thinking, redacted: !!part.redacted, live });
			}
		} else if (part.type === "toolCall") {
			const result = results.get(part.id);
			const execution = state.tools[part.id];
			let status: ToolStatus;
			if (result) status = result.isError ? "error" : "done";
			else if (execution) status = execution.status;
			else if (streaming && part.partialJson !== undefined && index === content.length - 1) status = "generating";
			else if (state.runState === "idle" || state.runState === "inactive") status = "interrupted";
			else status = "pending";
			const subagents = part.id ? subagentsOf(state, part.id) : [];
			blocks.push({
				kind: "tool",
				call: part,
				status,
				...(execution ? { execution } : {}),
				...(result ? { result } : {}),
				...(subagents.length || isSubagentTool(part.name) ? { subagents } : {}),
			});
		}
	}
	return blocks;
}

/** Build the display transcript: tool results are attached to their tool calls. */
export function buildTranscript(state: ChatState): TranscriptItem[] {
	const results = new Map<string, ToolResultMessage>();
	const calls = new Set<string>();
	const all = state.streaming ? [...state.messages, state.streaming] : state.messages;
	for (const message of all) {
		if (message.role === "toolResult") {
			const result = message as ToolResultMessage;
			results.set(result.toolCallId, result);
		} else if (message.role === "assistant") {
			for (const part of (message as AssistantMessage).content ?? []) {
				if (part?.type === "toolCall") calls.add(part.id);
			}
		}
	}

	const items: TranscriptItem[] = [];
	for (const [i, message] of state.messages.entries()) {
		const key = `m${i}`;
		switch (message.role) {
			case "user":
				items.push({
					kind: "user",
					key,
					text: userText((message as { content: unknown }).content),
					images: contentImages((message as { content: unknown }).content),
					timestamp: Number(message.timestamp ?? 0),
				});
				break;
			case "assistant": {
				const assistant = message as AssistantMessage;
				items.push({
					kind: "assistant",
					key,
					message: assistant,
					blocks: assistantBlocks(assistant, false, results, state),
					streaming: false,
				});
				break;
			}
			case "toolResult": {
				const result = message as ToolResultMessage;
				if (!calls.has(result.toolCallId)) items.push({ kind: "toolResult", key, message: result });
				break;
			}
			case "bashExecution":
				items.push({ kind: "bash", key, message: message as BashExecutionMessage });
				break;
			case "custom": {
				const custom = message as CustomMessage;
				if (custom.display) items.push({ kind: "custom", key, message: custom, text: contentText(custom.content) });
				break;
			}
			case "compactionSummary":
				items.push({ kind: "compaction", key, message: message as CompactionSummaryMessage });
				break;
			case "branchSummary":
				items.push({ kind: "branchSummary", key, message: message as BranchSummaryMessage });
				break;
			case "system":
				break;
			default:
				items.push({ kind: "unknown", key, message });
		}
	}
	if (state.streaming) {
		items.push({
			kind: "assistant",
			key: `m${state.messages.length}`,
			message: state.streaming,
			blocks: assistantBlocks(state.streaming, true, results, state),
			streaming: true,
		});
	}
	return items;
}

/** Show activity during gaps between parts, even when the current message already has text. */
export function isWaitingForModel(state: ChatState, items: TranscriptItem[]): boolean {
	if (!state.loaded || state.pendingUi.length || state.runState === "idle" || state.runState === "inactive")
		return false;
	if (state.runState === "compacting" || state.runState === "retrying") return true;
	const lastItem = items.at(-1);
	for (const item of items) {
		if (item.kind !== "assistant") continue;
		if (
			item.blocks.some(
				(block) =>
					(block.kind === "thinking" && block.live) ||
					(block.kind === "tool" &&
						(block.status === "generating" ||
							block.status === "running" ||
							(block.status === "pending" && (item.streaming || item === lastItem)))),
			)
		)
			return false;
	}
	const part = state.streaming?.content.at(-1);
	return !(part?.type === "text" && part.completed !== true && part.text.trim());
}

export function waitingForModelLabel(state: ChatState): string {
	if (state.runState === "compacting") return "正在压缩上下文…";
	if (state.runState === "retrying") return "正在重试…";
	return state.model?.reasoning && state.thinkingLevel !== "off" ? "思考中…" : "Agent 工作中…";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** One-line description of a tool call, e.g. the bash command or the file path. */
export function summarizeToolCall(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	switch (name) {
		case "bash":
		case "powershell":
			return str(a.command) ?? "";
		case "read":
		case "write":
		case "edit":
		case "ls":
			return str(a.path) ?? str(a.file_path) ?? (name === "ls" ? "." : "");
		case "grep":
		case "find":
			return [str(a.pattern), str(a.path)].filter(Boolean).join("  ·  ");
		default: {
			const first = Object.values(a).find((v) => typeof v === "string");
			return typeof first === "string" ? first : "";
		}
	}
}

/** Text output of a tool result (or of a streamed partial result). */
export function toolOutputText(result: unknown): string {
	if (!result || typeof result !== "object") return typeof result === "string" ? result : "";
	return contentText((result as { content?: unknown }).content);
}

/** Display diff attached to an `edit` tool result, if any. */
export function editDiff(result: unknown): string | undefined {
	const details = result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
	if (details && typeof details === "object") {
		const diff = (details as { diff?: unknown }).diff;
		if (typeof diff === "string" && diff) return diff;
	}
	return undefined;
}

/** Replacements requested by an `edit` tool call (supports the legacy single-edit form). */
export function editReplacements(args: unknown): Array<{ oldText: string; newText: string }> {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const edits = Array.isArray(a.edits)
		? a.edits.filter(
				(e): e is { oldText: string; newText: string } =>
					!!e && typeof e.oldText === "string" && typeof e.newText === "string",
			)
		: [];
	if (typeof a.oldText === "string" && typeof a.newText === "string") {
		edits.push({ oldText: a.oldText, newText: a.newText });
	}
	return edits;
}

export interface SessionUsage {
	/** Total prompt tokens, including cache reads and writes. */
	input: number;
	output: number;
	/** Prompt tokens served from the provider's prompt cache. */
	cacheRead: number;
	/** Prompt tokens written to the provider's prompt cache. */
	cacheWrite: number;
	/** cacheRead / input, or undefined when no prompt tokens were recorded. */
	cacheHitRate: number | undefined;
	cost: number;
	lastContext: number;
}

/** Aggregate token usage and cost of the assistant messages in the transcript. */
export function sessionUsage(state: ChatState): SessionUsage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let lastContext = 0;
	for (const message of state.messages) {
		if (message.role !== "assistant") continue;
		const usage = (message as AssistantMessage).usage;
		if (!usage) continue;
		const read = usage.cacheRead ?? 0;
		const write = usage.cacheWrite ?? 0;
		input += (usage.input ?? 0) + read + write;
		cacheRead += read;
		cacheWrite += write;
		output += usage.output ?? 0;
		cost += usage.cost?.total ?? 0;
		if (usage.totalTokens) lastContext = usage.totalTokens;
	}
	const cacheHitRate = input > 0 ? cacheRead / input : undefined;
	return { input, output, cacheRead, cacheWrite, cacheHitRate, cost, lastContext };
}

/** Tools that delegate work to subagents: Claude Code `Agent` / `Task`, Codex `spawn_agent`, pi-subagents. */
export function isSubagentTool(name: string): boolean {
	return name === "Agent" || name === "Task" || name === "spawn_agent" || name === "subagent";
}

/** Subagents nested under another subagent, in start order. */
export function childSubagents(state: ChatState, parentId: string): SubagentInfo[] {
	return Object.values(state.subagents ?? {}).filter((s) => s.parentId === parentId);
}
