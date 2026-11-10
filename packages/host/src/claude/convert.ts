import type { SubagentInfo } from "@pier/protocol";
import { additionDiff, type DiffHunk, hunksToDiff } from "../runtimes/diff.ts";
import {
	type AssistantMessage,
	type ImagePart,
	type TextPart,
	type ThinkingPart,
	type ToolCallPart,
	type ToolResultInput,
	type ToolResultMessage,
	type TranscriptMessage,
	type Usage,
	type UserMessage,
	usageFrom,
} from "../runtimes/live-transcript.ts";
import { clip } from "../runtimes/subagents.ts";

/**
 * Conversions between Claude Code (Anthropic Messages API content, Claude Code tools and
 * transcripts) and the pi-shaped messages Pier's clients render.
 */

export const CLAUDE_PROVIDER = "claude-code";

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Map a Claude Code tool call to pi's tool names and argument names, so clients show their
 * terminal, file and diff cards and the approval policy recognizes the tool. Other tools keep
 * their Claude Code names.
 */
export function normalizeTool(name: string, input: Json): { name: string; arguments: Json } {
	switch (name) {
		case "Bash": {
			const { command, ...rest } = input;
			return { name: "bash", arguments: { command: str(command) ?? "", ...rest } };
		}
		case "Read": {
			const { file_path, ...rest } = input;
			return { name: "read", arguments: { path: str(file_path) ?? "", ...rest } };
		}
		case "Write": {
			const { file_path, ...rest } = input;
			return { name: "write", arguments: { path: str(file_path) ?? "", ...rest } };
		}
		case "Edit": {
			const { file_path, old_string, new_string, ...rest } = input;
			return {
				name: "edit",
				arguments: {
					path: str(file_path) ?? "",
					edits: [{ oldText: str(old_string) ?? "", newText: str(new_string) ?? "" }],
					...rest,
				},
			};
		}
		case "MultiEdit": {
			const { file_path, edits, ...rest } = input;
			return {
				name: "edit",
				arguments: {
					path: str(file_path) ?? "",
					edits: Array.isArray(edits)
						? edits.map((e: Json) => ({ oldText: str(e?.old_string) ?? "", newText: str(e?.new_string) ?? "" }))
						: [],
					...rest,
				},
			};
		}
		case "Grep":
			return { name: "grep", arguments: input };
		case "Glob":
			return { name: "find", arguments: input };
		case "LS":
			return { name: "ls", arguments: input };
		default:
			return { name, arguments: input };
	}
}

/** Build a pi tool call part from a Claude `tool_use` block. */
export function toolCallPart(block: Json): ToolCallPart {
	const input = (block.input && typeof block.input === "object" ? block.input : {}) as Json;
	const normalized = normalizeTool(str(block.name) ?? "", input);
	return { type: "toolCall", id: str(block.id) ?? "", name: normalized.name, arguments: normalized.arguments };
}

function imagePart(block: Json): ImagePart | undefined {
	const source = block.source as Json | undefined;
	if (source?.type !== "base64") return undefined;
	const data = str(source.data);
	const mimeType = str(source.media_type);
	return data && mimeType ? { type: "image", data, mimeType } : undefined;
}

function resultContent(content: unknown): { text: string; images: ImagePart[] } {
	if (typeof content === "string") return { text: content, images: [] };
	const texts: string[] = [];
	const images: ImagePart[] = [];
	if (Array.isArray(content)) {
		for (const block of content as Json[]) {
			if (block?.type === "text") texts.push(str(block.text) ?? "");
			else if (block?.type === "image") {
				const image = imagePart(block);
				if (image) images.push(image);
			}
		}
	}
	return { text: texts.join("\n"), images };
}

/** The diff of a file tool's structured result (`Edit`, `MultiEdit`, `Write`), in pi's format. */
export function structuredDiff(toolUseResult: unknown): string | undefined {
	if (!toolUseResult || typeof toolUseResult !== "object") return undefined;
	const result = toolUseResult as Json;
	const patch = result.structuredPatch;
	if (Array.isArray(patch) && patch.length > 0) {
		const hunks: DiffHunk[] = patch.map((h: Json) => ({
			oldStart: Number(h.oldStart ?? 1),
			newStart: Number(h.newStart ?? 1),
			lines: Array.isArray(h.lines) ? h.lines.map(String) : [],
		}));
		return hunksToDiff(hunks);
	}
	if (result.type === "create" && typeof result.content === "string") return additionDiff(result.content);
	return undefined;
}

/** Convert a Claude `tool_result` block (and the structured result, when known) to a pi result. */
export function toolResultInput(block: Json, toolUseResult?: unknown): ToolResultInput {
	const { text, images } = resultContent(block.content);
	const diff = structuredDiff(toolUseResult);
	return {
		text,
		isError: block.is_error === true,
		...(images.length ? { images } : {}),
		...(diff ? { details: { diff } } : {}),
	};
}

export function stopReason(reason: unknown): string {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "refusal":
			return "error";
		default:
			return "stop";
	}
}

export function anthropicUsage(usage: unknown): Usage | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Json;
	return usageFrom({
		input: Number(u.input_tokens ?? 0),
		output: Number(u.output_tokens ?? 0),
		cacheRead: Number(u.cache_read_input_tokens ?? 0),
		cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
	});
}

/** Assistant content blocks (text, thinking, tool_use) as pi content parts. */
export function assistantParts(content: unknown): Array<TextPart | ThinkingPart | ToolCallPart> {
	const parts: Array<TextPart | ThinkingPart | ToolCallPart> = [];
	if (!Array.isArray(content)) return parts;
	for (const block of content as Json[]) {
		if (block?.type === "text") parts.push({ type: "text", text: str(block.text) ?? "" });
		else if (block?.type === "thinking") parts.push({ type: "thinking", thinking: str(block.thinking) ?? "" });
		else if (block?.type === "redacted_thinking") parts.push({ type: "thinking", thinking: "", redacted: true });
		else if (block?.type === "tool_use" || block?.type === "server_tool_use") parts.push(toolCallPart(block));
	}
	return parts;
}

const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * The text of a user prompt as the user typed it, or undefined for entries Claude Code adds
 * itself (local command output, caveats, hook and system reminders).
 */
export function promptText(text: string): string | undefined {
	const command = COMMAND_NAME.exec(text);
	if (command) {
		const name = command[1]?.trim() ?? "";
		const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
		return args ? `${name} ${args}` : name;
	}
	if (/^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)>/.test(text)) {
		return undefined;
	}
	if (text.startsWith("Caveat: The messages below were generated by the user while running local commands")) {
		return undefined;
	}
	return text;
}

function userParts(content: unknown): UserMessage["content"] | undefined {
	if (typeof content === "string") return promptText(content);
	if (!Array.isArray(content)) return undefined;
	const parts: Array<TextPart | ImagePart> = [];
	for (const block of content as Json[]) {
		if (block?.type === "text") {
			const text = promptText(str(block.text) ?? "");
			if (text !== undefined) parts.push({ type: "text", text });
		} else if (block?.type === "image") {
			const image = imagePart(block);
			if (image) parts.push(image);
		}
	}
	return parts.length ? parts : undefined;
}

/** One entry of `getSessionMessages()`. */
export interface ClaudeEntry {
	type: string;
	uuid: string;
	message: unknown;
	parent_tool_use_id?: string | null;
}

/**
 * Convert a stored Claude Code conversation to pi messages. Claude Code stores one entry per
 * assistant content block; consecutive entries of the same API message are merged.
 */
export function convertTranscript(entries: ClaudeEntry[]): TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];
	const toolNames = new Map<string, string>();
	let assistant: { id: string; message: AssistantMessage } | undefined;
	const now = Date.now();
	for (const entry of entries) {
		if (entry.parent_tool_use_id) continue;
		const message = (entry.message ?? {}) as Json;
		if (entry.type === "assistant") {
			const id = str(message.id) ?? entry.uuid;
			const parts = assistantParts(message.content);
			for (const part of parts) if (part.type === "toolCall") toolNames.set(part.id, part.name);
			if (assistant && assistant.id === id) {
				assistant.message.content.push(...parts);
				if (message.stop_reason) assistant.message.stopReason = stopReason(message.stop_reason);
				const usage = anthropicUsage(message.usage);
				if (usage) assistant.message.usage = usage;
				continue;
			}
			const usage = anthropicUsage(message.usage);
			const next: AssistantMessage = {
				role: "assistant",
				content: parts,
				api: "anthropic-messages",
				provider: CLAUDE_PROVIDER,
				...(str(message.model) ? { model: str(message.model) } : {}),
				...(usage ? { usage } : {}),
				stopReason: stopReason(message.stop_reason),
				timestamp: now,
			};
			assistant = { id, message: next };
			messages.push(next);
			continue;
		}
		if (entry.type !== "user") continue;
		assistant = undefined;
		const content = message.content;
		if (Array.isArray(content)) {
			for (const block of content as Json[]) {
				if (block?.type !== "tool_result") continue;
				const id = str(block.tool_use_id) ?? "";
				const result = toolResultInput(block);
				const toolResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: id,
					toolName: toolNames.get(id) ?? "",
					content: [{ type: "text", text: result.text }, ...(result.images ?? [])],
					isError: result.isError === true,
					timestamp: now,
				};
				messages.push(toolResult);
			}
		}
		const parts = userParts(content);
		if (parts !== undefined && (typeof parts !== "string" || parts.trim())) {
			messages.push({ role: "user", content: parts, timestamp: now, entryId: entry.uuid });
		}
	}
	return messages;
}

/** Claude Code tools that delegate to a subagent. */
export const CLAUDE_AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** Display fields of an `Agent` tool call's input. */
export function agentCallFields(input: Json): { name: string; description?: string; task?: string } {
	const name = str(input.subagent_type) ?? str(input.name) ?? "Agent";
	const description = str(input.description);
	const task = str(input.prompt);
	return { name, ...(description ? { description } : {}), ...(task ? { task } : {}) };
}

export interface AgentReport {
	/** The subagent's final report, without the frame Claude Code adds for the parent. */
	report?: string;
	agentId?: string;
	tokens?: number;
	toolUses?: number;
	durationMs?: number;
}

const REPORT_MARKER = "The report follows:\n";

/** Parse the result text of an `Agent` tool call: the framed report, agent id and usage. */
export function parseAgentResult(text: string): AgentReport {
	const result: AgentReport = {};
	const agentId = /^agentId: (\S+)/m.exec(text)?.[1];
	if (agentId) result.agentId = agentId;
	const usage = /<usage>([\s\S]*?)<\/usage>/.exec(text)?.[1] ?? "";
	const number = (key: string) => {
		const match = new RegExp(`${key}:\\s*(\\d+)`).exec(usage);
		return match ? Number(match[1]) : undefined;
	};
	const tokens = number("subagent_tokens") ?? number("total_tokens");
	const toolUses = number("tool_uses");
	const durationMs = number("duration_ms");
	if (tokens !== undefined) result.tokens = tokens;
	if (toolUses !== undefined) result.toolUses = toolUses;
	if (durationMs !== undefined) result.durationMs = durationMs;
	let body = text;
	const marker = body.indexOf(REPORT_MARKER);
	if (marker !== -1) {
		body = body
			.slice(marker + REPORT_MARKER.length)
			.split("\n")
			.map((line) => (line.startsWith("  ") ? line.slice(2) : line))
			.join("\n");
	}
	body = body
		.replace(/<usage>[\s\S]*?<\/usage>/g, "")
		.replace(/^agentId: .*$/m, "")
		.replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g, "")
		.trim();
	if (body) result.report = body;
	return result;
}

/** Messages of a stored subagent conversation (`getSubagentMessages`) as pi messages. */
export function convertSubagentTranscript(entries: ClaudeEntry[]): TranscriptMessage[] {
	return convertTranscript(entries.map((entry) => ({ ...entry, parent_tool_use_id: null })));
}

/** A subagent of a stored conversation and the Claude Code agent id of its transcript. */
export interface StoredAgent {
	info: SubagentInfo;
	agentId?: string;
}

/** The subagents of a stored Claude Code conversation: one per `Agent` tool call. */
export function storedSubagents(messages: TranscriptMessage[], transcript: boolean): StoredAgent[] {
	const results = new Map<string, ToolResultMessage>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const agents: StoredAgent[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || !CLAUDE_AGENT_TOOLS.has(part.name)) continue;
			const fields = agentCallFields(part.arguments);
			const result = results.get(part.id);
			const text = (result?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
			const report = parseAgentResult(text);
			const interrupted = /^\[Request interrupted by user/.test(text.trim());
			const status = !result || interrupted ? "stopped" : result.isError ? "failed" : "completed";
			const description = clip(fields.description, 500);
			const task = clip(fields.task);
			const output = status === "completed" ? clip(report.report) : undefined;
			const error = status === "failed" ? clip(text) : undefined;
			agents.push({
				info: {
					id: part.id,
					toolCallId: part.id,
					name: fields.name,
					...(description ? { description } : {}),
					...(task ? { task } : {}),
					status,
					steps: report.toolUses ?? 0,
					...(report.tokens !== undefined ? { tokens: report.tokens } : {}),
					...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
					...(output ? { result: output } : {}),
					...(error ? { error } : {}),
					stoppable: false,
					transcript,
					revision: 0,
				},
				...(report.agentId ? { agentId: report.agentId } : {}),
			});
		}
	}
	return agents;
}
