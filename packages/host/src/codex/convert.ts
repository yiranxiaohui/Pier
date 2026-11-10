import type { ApprovalPolicy, ModelInfo, SubagentInfo, SubagentStatus, ThinkingLevel } from "@pier/protocol";
import { additionDiff, hunksToDiff, parseUnifiedDiff } from "../runtimes/diff.ts";
import type {
	AssistantMessage,
	ImagePart,
	TextPart,
	ThinkingPart,
	ToolCallPart,
	ToolResultInput,
	TranscriptMessage,
	UserMessage,
} from "../runtimes/live-transcript.ts";
import { clip } from "../runtimes/subagents.ts";

/** Conversions between the Codex app-server protocol (threads, turns, items) and pi messages. */

export const CODEX_PROVIDER = "codex";

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Codex approval and sandbox settings for a Pier approval policy. */
export function codexPolicy(policy: ApprovalPolicy): {
	approvalPolicy: "untrusted" | "on-request" | "never";
	sandbox: "workspace-write" | "danger-full-access";
	sandboxPolicy: Json;
} {
	switch (policy) {
		case "auto":
			return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
		case "ask":
			return { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: workspaceWrite() };
		default:
			return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: workspaceWrite() };
	}
}

function workspaceWrite(): Json {
	return {
		type: "workspaceWrite",
		writableRoots: [],
		networkAccess: false,
		excludeTmpdirEnvVar: false,
		excludeSlashTmp: false,
	};
}

const EFFORT_TO_LEVEL: Record<string, ThinkingLevel> = {
	none: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	ultra: "ultra",
};

export function effortToLevel(effort: unknown): ThinkingLevel | undefined {
	return typeof effort === "string" ? EFFORT_TO_LEVEL[effort] : undefined;
}

export function levelToEffort(level: ThinkingLevel): string {
	return level === "off" ? "none" : level;
}

export function toModelInfo(model: Json): ModelInfo {
	const efforts = Array.isArray(model.supportedReasoningEfforts)
		? (model.supportedReasoningEfforts as Json[])
				.map((e) => effortToLevel(e.reasoningEffort))
				.filter((l): l is ThinkingLevel => l !== undefined)
		: [];
	const order: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
	const levels = order.filter((l) => efforts.includes(l));
	const input = Array.isArray(model.inputModalities) ? (model.inputModalities as string[]) : ["text"];
	const contextWindow = Number(model.contextWindow ?? model.context_window);
	return {
		provider: CODEX_PROVIDER,
		id: str(model.model) ?? str(model.id) ?? "",
		name: str(model.displayName) ?? str(model.model) ?? "",
		reasoning: levels.length > 0,
		input: input.filter((i) => i === "text" || i === "image"),
		...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
		thinkingLevels: levels.length ? levels : ["off"],
	};
}

/** Text of a Codex `userMessage` item (and its images). */
export function userInputContent(content: unknown): UserMessage["content"] {
	if (!Array.isArray(content)) return "";
	const parts: Array<TextPart | ImagePart> = [];
	for (const input of content as Json[]) {
		if (input?.type === "text") parts.push({ type: "text", text: str(input.text) ?? "" });
		else if (input?.type === "image") {
			const match = /^data:([^;]+);base64,(.*)$/s.exec(str(input.url) ?? "");
			if (match?.[1] && match[2]) parts.push({ type: "image", data: match[2], mimeType: match[1] });
		} else if (input?.type === "skill" || input?.type === "mention") {
			parts.push({ type: "text", text: `$${str(input.name) ?? ""}` });
		}
	}
	if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
	return parts;
}

export function reasoningText(item: Json): string {
	const summary = Array.isArray(item.summary) ? (item.summary as string[]) : [];
	if (summary.some(Boolean)) return summary.filter(Boolean).join("\n\n");
	const content = Array.isArray(item.content) ? (item.content as string[]) : [];
	return content.filter(Boolean).join("\n\n");
}

/** The pi tool call for a Codex tool item, or undefined for items that are not tool calls. */
export function toolCallFor(item: Json): ToolCallPart | undefined {
	const id = str(item.id) ?? "";
	switch (item.type) {
		case "commandExecution":
			return {
				type: "toolCall",
				id,
				name: "bash",
				arguments: { command: str(item.command) ?? "", ...(str(item.cwd) ? { cwd: str(item.cwd) } : {}) },
			};
		case "fileChange": {
			const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
			const first = changes[0];
			const kind = (first?.kind as Json | undefined)?.type;
			const path = str(first?.path) ?? "";
			const paths = changes.map((c) => str(c.path) ?? "").filter(Boolean);
			const name = changes.length === 1 && kind === "add" ? "write" : "edit";
			return {
				type: "toolCall",
				id,
				name,
				arguments: { path, ...(paths.length > 1 ? { paths } : {}) },
			};
		}
		case "mcpToolCall":
			return {
				type: "toolCall",
				id,
				name: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`,
				arguments: (item.arguments && typeof item.arguments === "object" ? item.arguments : {}) as Json,
			};
		case "dynamicToolCall":
			return {
				type: "toolCall",
				id,
				name: str(item.tool) ?? "tool",
				arguments: (item.arguments && typeof item.arguments === "object" ? item.arguments : {}) as Json,
			};
		case "subAgentActivity": {
			if (item.kind !== "started") return undefined;
			const path = str(item.agentPath);
			return {
				type: "toolCall",
				id,
				name: "spawn_agent",
				arguments: {
					agent: agentName(path) ?? "Subagent",
					...(path ? { agentPath: path } : {}),
					...(str(item.model) ? { model: str(item.model) } : {}),
					...(str(item.reasoningEffort) ? { reasoningEffort: str(item.reasoningEffort) } : {}),
				},
			};
		}
		case "collabAgentToolCall": {
			const receivers = Array.isArray(item.receiverThreadIds) ? (item.receiverThreadIds as string[]) : [];
			return {
				type: "toolCall",
				id,
				name: COLLAB_TOOL_NAMES[str(item.tool) ?? ""] ?? str(item.tool) ?? "agent_tool",
				arguments: {
					...(str(item.prompt) ? { prompt: str(item.prompt) } : {}),
					...(receivers.length ? { receivers } : {}),
					...(str(item.model) ? { model: str(item.model) } : {}),
					...(str(item.reasoningEffort) ? { reasoningEffort: str(item.reasoningEffort) } : {}),
				},
			};
		}
		case "webSearch":
			return { type: "toolCall", id, name: "web_search", arguments: { query: str(item.query) ?? "" } };
		case "imageGeneration":
			return { type: "toolCall", id, name: "image_generation", arguments: {} };
		default:
			return undefined;
	}
}

/** Diff of a `fileChange` item's changes, in pi's `details.diff` format. */
export function fileChangeDiff(item: Json): string | undefined {
	const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
	const parts: string[] = [];
	for (const change of changes) {
		const diff = str(change.diff) ?? "";
		const kind = (change.kind as Json | undefined)?.type;
		const hunks = parseUnifiedDiff(diff);
		let text: string;
		if (hunks.length) text = hunksToDiff(hunks);
		else if (kind === "add") text = additionDiff(diff);
		else text = diff;
		if (changes.length > 1) parts.push(`  ${str(change.path) ?? ""}`);
		parts.push(text);
	}
	const joined = parts.join("\n");
	return joined || undefined;
}

function mcpResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as Json).content;
	if (!Array.isArray(content)) return "";
	return (content as Json[])
		.map((c) => (c?.type === "text" ? (str(c.text) ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

/** The pi tool result of a completed Codex tool item. */
export function toolResultFor(item: Json, streamedOutput?: string): ToolResultInput {
	switch (item.type) {
		case "commandExecution": {
			const status = str(item.status);
			const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
			const output = str(item.aggregatedOutput) ?? streamedOutput ?? "";
			const declined = status === "declined";
			const text = declined
				? output || "The command was declined."
				: exitCode !== undefined && exitCode !== 0
					? `${output}${output.endsWith("\n") || !output ? "" : "\n"}\nCommand exited with code ${exitCode}`
					: output;
			return { text, isError: declined || status === "failed" || (exitCode !== undefined && exitCode !== 0) };
		}
		case "fileChange": {
			const status = str(item.status);
			const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
			const diff = fileChangeDiff(item);
			const summary = changes
				.map((c) => {
					const kind = str((c.kind as Json | undefined)?.type) ?? "update";
					return `${kind === "add" ? "Added" : kind === "delete" ? "Deleted" : "Updated"} ${str(c.path) ?? ""}`;
				})
				.join("\n");
			const failed = status === "failed" || status === "declined";
			return {
				text: status === "declined" ? "The change was declined." : failed ? `Failed to apply:\n${summary}` : summary,
				isError: failed,
				...(diff ? { details: { diff } } : {}),
			};
		}
		case "mcpToolCall": {
			const error = (item.error as Json | null | undefined)?.message;
			return error ? { text: String(error), isError: true } : { text: mcpResultText(item.result) };
		}
		case "dynamicToolCall": {
			const items = Array.isArray(item.contentItems) ? (item.contentItems as Json[]) : [];
			const text = items.map((c) => str(c.text) ?? "").join("\n");
			return { text, isError: item.success === false };
		}
		case "subAgentActivity":
			return { text: `Started ${str(item.agentPath) ?? "a subagent"}` };
		case "collabAgentToolCall": {
			const states = (item.agentsStates ?? {}) as Record<string, Json | undefined>;
			const lines = Object.entries(states).map(([threadId, state]) => {
				const message = str(state?.message);
				return `${threadId}: ${str(state?.status) ?? "unknown"}${message ? `\n${message}` : ""}`;
			});
			return { text: lines.join("\n\n"), isError: item.status === "failed" };
		}
		default:
			return { text: "" };
	}
}

/** Convert the turns of a stored Codex thread to pi messages. */
export function convertTurns(turns: Json[], provider = CODEX_PROVIDER): TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];
	for (const turn of turns) {
		const timestamp = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : Date.now();
		let assistant: AssistantMessage | undefined;
		const close = () => {
			if (!assistant) return;
			const calls = assistant.content.some((p) => p.type === "toolCall");
			assistant.stopReason = calls ? "toolUse" : "stop";
			messages.push(assistant);
			assistant = undefined;
		};
		const open = (): AssistantMessage => {
			assistant ??= { role: "assistant", content: [], provider, timestamp };
			return assistant;
		};
		const items = Array.isArray(turn.items) ? (turn.items as Json[]) : [];
		for (const item of items) {
			switch (item.type) {
				case "userMessage":
					close();
					messages.push({
						role: "user",
						content: userInputContent(item.content),
						timestamp,
						entryId: str(turn.id) ?? "",
					});
					break;
				case "agentMessage":
					open().content.push({ type: "text", text: str(item.text) ?? "" });
					break;
				case "reasoning": {
					const text = reasoningText(item);
					if (text) open().content.push({ type: "thinking", thinking: text } as ThinkingPart);
					break;
				}
				default: {
					const call = toolCallFor(item);
					if (!call) break;
					open().content.push(call);
					close();
					const result = toolResultFor(item);
					messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: result.text }],
						...(result.details === undefined ? {} : { details: result.details }),
						isError: result.isError === true,
						timestamp,
					});
				}
			}
		}
		const error = (turn.error as Json | null | undefined)?.message;
		if (turn.status === "failed" && error) {
			open();
			if (assistant) {
				assistant.errorMessage = String(error);
				messages.push({ ...assistant, stopReason: "error" });
				assistant = undefined;
			}
		}
		close();
	}
	return messages;
}

/** Pier tool names of Codex collaboration (multi-agent) tools. */
const COLLAB_TOOL_NAMES: Record<string, string> = {
	spawnAgent: "spawn_agent",
	sendInput: "send_input",
	resumeAgent: "resume_agent",
	wait: "wait_agent",
	closeAgent: "close_agent",
	sendMessage: "send_message",
	followupTask: "followup_task",
	interruptAgent: "interrupt_agent",
	listAgents: "list_agents",
};

/** Task name of a Codex sub-agent from its path, e.g. `/root/read_files` → `read_files`. */
export function agentName(path: string | undefined): string | undefined {
	const name = path?.split("/").filter(Boolean).at(-1);
	return name && name !== "root" ? name : undefined;
}

/** Subagent status of a Codex `CollabAgentState`, or undefined while it runs. */
export function collabStatus(status: unknown): Exclude<SubagentStatus, "running"> | undefined {
	switch (status) {
		case "completed":
			return "completed";
		case "errored":
		case "notFound":
			return "failed";
		case "interrupted":
		case "shutdown":
			return "stopped";
		default:
			return undefined;
	}
}

/**
 * The sub-agents a stored Codex thread started, from its `subAgentActivity` and
 * `collabAgentToolCall` items. Their conversations are separate threads.
 */
export function storedSubagents(turns: Json[]): SubagentInfo[] {
	const agents = new Map<string, SubagentInfo>();
	const agent = (threadId: string, toolCallId: string, name: string | undefined): SubagentInfo => {
		let info = agents.get(threadId);
		if (!info) {
			info = {
				id: threadId,
				toolCallId,
				name: name ?? "Subagent",
				status: "stopped",
				steps: 0,
				stoppable: false,
				transcript: true,
				revision: 0,
			};
			agents.set(threadId, info);
		}
		return info;
	};
	for (const turn of turns) {
		const items = Array.isArray(turn.items) ? (turn.items as Json[]) : [];
		for (const item of items) {
			if (item.type === "subAgentActivity") {
				const threadId = str(item.agentThreadId);
				if (!threadId) continue;
				const info = agent(threadId, str(item.id) ?? "", agentName(str(item.agentPath)));
				if (item.kind === "started") {
					const model = str(item.model);
					const level = effortToLevel(item.reasoningEffort);
					if (model) info.model = model;
					if (level) info.thinkingLevel = level;
				} else if (item.kind === "completed") info.status = "completed";
				else if (item.kind === "interrupted") info.status = "stopped";
			} else if (item.type === "collabAgentToolCall") {
				const receivers = Array.isArray(item.receiverThreadIds) ? (item.receiverThreadIds as string[]) : [];
				const states = (item.agentsStates ?? {}) as Record<string, Json | undefined>;
				if (item.tool === "spawnAgent") {
					for (const threadId of receivers) {
						const info = agent(threadId, str(item.id) ?? "", undefined);
						const task = clip(str(item.prompt));
						const model = str(item.model);
						const level = effortToLevel(item.reasoningEffort);
						if (task) info.task = task;
						if (model) info.model = model;
						if (level) info.thinkingLevel = level;
					}
				}
				for (const [threadId, state] of Object.entries(states)) {
					const info = agents.get(threadId);
					const status = collabStatus(state?.status);
					if (!info || !status) continue;
					info.status = status;
					const message = clip(str(state?.message));
					if (message && status === "completed") info.result = message;
					else if (message && status === "failed") info.error = message;
				}
			}
		}
	}
	return [...agents.values()];
}
