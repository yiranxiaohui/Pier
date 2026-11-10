import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
	CanUseTool,
	Options,
	PermissionResult,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	type AgentRuntimeCapabilities,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type QueueState,
	type SessionCommandInfo,
	type SessionContextInfo,
	type SessionSummary,
	type StreamingBehavior,
	type ThinkingLevel,
	type WireEvent,
} from "@pier/protocol";
import {
	errorMessage,
	ManagedSession,
	type ManagedSessionOptions,
	type SessionContent,
	type SessionDescription,
} from "../managed-session.ts";
import { InputQueue } from "../runtimes/input-queue.ts";
import {
	firstPromptOf,
	type ImagePart,
	LiveTranscript,
	type TextPart,
	type ToolCallPart,
	type TranscriptMessage,
	type Usage,
	type UserMessage,
	userContentText,
} from "../runtimes/live-transcript.ts";
import { clip, type SubagentPatch, type SubagentRuntimeHooks } from "../runtimes/subagents.ts";
import {
	agentCallFields,
	anthropicUsage,
	assistantParts,
	CLAUDE_AGENT_TOOLS,
	CLAUDE_PROVIDER,
	convertSubagentTranscript,
	convertTranscript,
	normalizeTool,
	parseAgentResult,
	promptText,
	stopReason,
	storedSubagents,
	toolCallPart,
	toolResultInput,
} from "./convert.ts";

export const CLAUDE_CAPABILITIES: AgentRuntimeCapabilities = {
	steer: true,
	followUp: true,
	compact: true,
	fork: true,
	rename: true,
	setModel: true,
	thinking: true,
	reload: false,
	images: true,
	piExtensions: false,
};

/** An idle session stops its Claude Code process after this long (it resumes on the next prompt). */
const PROCESS_IDLE_MS = 10 * 60 * 1000;

/** Effort levels Claude Code accepts, plus `off` (thinking disabled). */
export const CLAUDE_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

export type ClaudeSdk = Pick<
	typeof import("@anthropic-ai/claude-agent-sdk"),
	"query" | "listSessions" | "getSessionMessages" | "forkSession" | "renameSession"
> &
	Partial<Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "listSubagents" | "getSubagentMessages">>;

/** What a Claude Code session needs from its runtime. */
export interface ClaudeSessionHost {
	sdk(): Promise<ClaudeSdk>;
	executable(): string | undefined;
	/** Where Claude Code stores the session (it may not exist yet). */
	sessionFile(cwd: string, sessionId: string): string;
	model(id: string): ModelInfo | undefined;
	commands(): SessionCommandInfo[];
	defaultThinkingLevel(): ThinkingLevel;
	log(message: string): void;
}

export interface ClaudeSessionStart {
	sessionId: string;
	/** Whether the session exists on disk (resume it) or is new. */
	existing: boolean;
	name?: string;
	createdAt?: string;
	messages?: TranscriptMessage[];
}

type Json = Record<string, unknown>;

interface StreamState {
	/** Claude content block index → pi content index. */
	index: Map<number, number>;
	kind: Map<number, string>;
	json: Map<number, string>;
	tool: Map<number, { id: string; name: string }>;
	usage?: Usage;
	stopReason?: string;
	model?: string;
}

interface QueuedPrompt {
	uuid: string;
	text: string;
	content: UserMessage["content"];
	steer: boolean;
}

function imageBlocks(images: ImageInput[] | undefined): Json[] {
	return (images ?? []).map((image) => ({
		type: "image",
		source: { type: "base64", media_type: image.mimeType, data: image.data },
	}));
}

function userContent(text: string, images: ImageInput[] | undefined): UserMessage["content"] {
	if (!images?.length) return text;
	const parts: Array<TextPart | ImagePart> = [{ type: "text", text }];
	for (const image of images) parts.push({ type: "image", data: image.data, mimeType: image.mimeType });
	return parts;
}

function sdkUserMessage(text: string, images: ImageInput[] | undefined, uuid: string, priority?: "now" | "later") {
	const content = images?.length ? [{ type: "text", text }, ...imageBlocks(images)] : text;
	return {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
		uuid,
		...(priority ? { priority } : {}),
	} as unknown as SDKUserMessage;
}

/** A Claude Code session driven through the Claude Agent SDK (which runs the `claude` CLI). */
export class ClaudeCodeSession extends ManagedSession {
	readonly runtimeId = "claude-code";
	readonly capabilities = CLAUDE_CAPABILITIES;
	private readonly sessionId: string;
	private readonly transcript: LiveTranscript;
	private query: Query | undefined;
	private input: InputQueue<SDKUserMessage> | undefined;
	private stream: StreamState | undefined;
	/** API message ids delivered as stream events (their SDK `assistant` messages are ignored). */
	private readonly streamed = new Set<string>();
	/** API message id of the assistant message built from SDK `assistant` messages (no stream events). */
	private fallbackId: string | undefined;
	private queued: QueuedPrompt[] = [];
	private name: string | undefined;
	private pendingName: string | undefined;
	private readonly createdAt: string;
	private modelId: string | undefined;
	private resolvedModel: string | undefined;
	private thinkingLevel: ThinkingLevel;
	/** Whether the user picked the thinking level (otherwise Claude Code's default applies). */
	private thinkingChosen = false;
	private retrying = false;
	private compacting = false;
	private runWaiters: Array<() => void> = [];
	private lastCompactTokens = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Claude Code task id of each subagent (keyed by its `Agent` tool call id), for `stopTask`. */
	private readonly agentTasks = new Map<string, string>();
	/** Subagent (`Agent` tool call id) of each Claude Code task id. */
	private readonly taskAgents = new Map<string, string>();
	/** Claude Code agent id of each subagent, for loading its stored transcript. */
	private readonly agentIds = new Map<string, string>();
	/** API message id of the assistant message each subagent is building. */
	private readonly childMessages = new Map<string, string>();

	private constructor(
		options: ManagedSessionOptions,
		private readonly host: ClaudeSessionHost,
		start: ClaudeSessionStart,
	) {
		super(options);
		this.sessionId = start.sessionId;
		this.name = start.name;
		this.createdAt = start.createdAt ?? new Date().toISOString();
		this.thinkingLevel = host.defaultThinkingLevel();
		this.transcript = new LiveTranscript(
			(event) => this.emit(event),
			() => ({
				provider: CLAUDE_PROVIDER,
				api: "anthropic-messages",
				...(this.resolvedModel || this.modelId ? { model: this.resolvedModel ?? this.modelId } : {}),
			}),
		);
		this.subagents.provider = CLAUDE_PROVIDER;
		if (start.messages) {
			this.transcript.load(start.messages);
			const agents = storedSubagents(start.messages, true);
			this.subagents.load(agents.map((a) => a.info));
			for (const agent of agents) if (agent.agentId) this.agentIds.set(agent.info.id, agent.agentId);
		}
	}

	static start(options: ManagedSessionOptions, host: ClaudeSessionHost, start: ClaudeSessionStart): ClaudeCodeSession {
		const session = new ClaudeCodeSession(options, host, start);
		session.acquireLock(host.sessionFile(options.workspace().path, start.sessionId));
		return session;
	}

	get id(): string {
		return this.sessionId;
	}

	get sessionFile(): string | undefined {
		const file = this.host.sessionFile(this.workspacePath, this.sessionId);
		return existsSync(file) ? file : undefined;
	}

	private get persisted(): boolean {
		return this.sessionFile !== undefined;
	}

	private get running(): boolean {
		return this.transcript.isRunning;
	}

	// ---------------------------------------------------------------- Claude Code process

	private async ensureQuery(): Promise<{ query: Query; input: InputQueue<SDKUserMessage> }> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this.query && this.input) return { query: this.query, input: this.input };
		const executable = this.host.executable();
		if (!executable)
			throw new PierProtocolError("CONFLICT", "Claude Code (`claude`) is not installed on this computer");
		const sdk = await this.host.sdk();
		const input = new InputQueue<SDKUserMessage>();
		const options: Options = {
			cwd: this.workspacePath,
			pathToClaudeCodeExecutable: executable,
			...(this.persisted ? { resume: this.sessionId } : { sessionId: this.sessionId }),
			includePartialMessages: true,
			systemPrompt: { type: "preset", preset: "claude_code" },
			settingSources: ["user", "project", "local"],
			permissionMode: "default",
			canUseTool: ((toolName, toolInput, opts) => this.canUseTool(toolName, toolInput, opts)) as CanUseTool,
			...(this.modelId && this.modelId !== "default" ? { model: this.modelId } : {}),
			...(this.thinkingLevel === "off"
				? { thinking: { type: "disabled" } }
				: this.thinkingChosen
					? { effort: this.thinkingLevel as Options["effort"] }
					: {}),
			env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "pier" },
			stderr: (data: string) => {
				const line = data.trim();
				if (line) this.host.log(`claude ${this.sessionId.slice(0, 8)}: ${line.slice(0, 500)}`);
			},
		};
		const query = sdk.query({ prompt: input, options });
		this.query = query;
		this.input = input;
		void this.consume(query);
		return { query, input };
	}

	private async consume(query: Query): Promise<void> {
		let failure: string | undefined;
		try {
			for await (const message of query) {
				if (this.disposed) break;
				this.handle(message);
			}
		} catch (error) {
			failure = errorMessage(error);
		} finally {
			if (this.query === query) {
				this.query = undefined;
				this.input?.close();
				this.input = undefined;
			}
			if (!this.disposed && this.running) {
				this.finishRun(failure ?? "Claude Code exited before the reply finished.");
			}
			this.stopAllSubagents();
			for (const prompt of this.queued) this.host.log(`dropped queued prompt ${prompt.uuid} (Claude Code exited)`);
			this.queued = [];
		}
	}

	private handle(message: SDKMessage): void {
		this.lastActivity = Date.now();
		const m = message as unknown as Json;
		switch (m.type) {
			case "stream_event":
				if (m.parent_tool_use_id) return;
				this.consumeQueued(m);
				this.ensureRunning();
				this.onStreamEvent(m.event as Json);
				return;
			case "assistant":
				if (m.parent_tool_use_id) {
					this.onChildAssistant(String(m.parent_tool_use_id), m);
					return;
				}
				this.consumeQueued(m);
				this.ensureRunning();
				this.onAssistant(m);
				return;
			case "user":
				if (m.parent_tool_use_id) {
					this.onChildUser(String(m.parent_tool_use_id), m);
					return;
				}
				this.onUser(m);
				return;
			case "result":
				this.onResult(m);
				return;
			case "system":
				this.onSystem(m);
				return;
			case "command_lifecycle":
				if (m.state === "started" && typeof m.command_uuid === "string") this.startQueued(m.command_uuid);
				return;
			default:
				return;
		}
	}

	private ensureRunning(): void {
		if (this.retrying) {
			this.retrying = false;
			this.emit({ type: "auto_retry_end", success: true });
		}
		if (!this.running) this.transcript.startRun();
		if (this.state !== "compacting") this.setRunState("streaming");
	}

	/** Show queued prompts the current turn consumed (`user_message_uuids`) as user messages. */
	private consumeQueued(m: Json): void {
		if (this.queued.length === 0) return;
		const uuids = Array.isArray(m.user_message_uuids)
			? (m.user_message_uuids as string[])
			: typeof m.user_message_uuid === "string"
				? [m.user_message_uuid]
				: [];
		for (const uuid of uuids) this.startQueued(uuid);
	}

	private startQueued(uuid: string): void {
		const index = this.queued.findIndex((q) => q.uuid === uuid);
		if (index === -1) return;
		const [prompt] = this.queued.splice(index, 1);
		if (!prompt) return;
		this.endFallback();
		if (this.stream === undefined) this.transcript.endAssistant();
		if (!this.running) {
			this.transcript.startRun();
			this.setRunState("streaming");
		}
		this.transcript.addUser(prompt.content, prompt.uuid);
		this.emitQueue();
	}

	private onStreamEvent(event: Json): void {
		const t = this.transcript;
		switch (event.type) {
			case "message_start": {
				this.endFallback();
				const message = (event.message ?? {}) as Json;
				if (typeof message.id === "string") this.streamed.add(message.id);
				const usage = anthropicUsage(message.usage);
				this.stream = {
					index: new Map(),
					kind: new Map(),
					json: new Map(),
					tool: new Map(),
					...(usage ? { usage } : {}),
					...(typeof message.model === "string" ? { model: message.model } : {}),
				};
				if (typeof message.model === "string") this.resolvedModel = message.model;
				return;
			}
			case "content_block_start": {
				const stream = this.stream;
				if (!stream) return;
				const index = Number(event.index);
				const block = (event.content_block ?? {}) as Json;
				const kind = String(block.type);
				stream.kind.set(index, kind);
				if (kind === "text") stream.index.set(index, t.textStart());
				else if (kind === "thinking") stream.index.set(index, t.thinkingStart());
				else if (kind === "redacted_thinking") {
					const at = t.thinkingStart(undefined, true);
					stream.index.set(index, at);
					t.thinkingEnd(at);
				} else if (kind === "tool_use" || kind === "server_tool_use") {
					const id = String(block.id ?? "");
					const name = normalizeTool(String(block.name ?? ""), {}).name;
					stream.tool.set(index, { id, name: String(block.name ?? "") });
					stream.json.set(index, "");
					stream.index.set(index, t.toolCallStart(id, name));
				}
				return;
			}
			case "content_block_delta": {
				const stream = this.stream;
				if (!stream) return;
				const index = Number(event.index);
				const at = stream.index.get(index);
				if (at === undefined) return;
				const delta = (event.delta ?? {}) as Json;
				if (delta.type === "text_delta") t.textDelta(at, String(delta.text ?? ""));
				else if (delta.type === "thinking_delta") t.thinkingDelta(at, String(delta.thinking ?? ""));
				else if (delta.type === "input_json_delta") {
					const partial = String(delta.partial_json ?? "");
					stream.json.set(index, (stream.json.get(index) ?? "") + partial);
					t.toolCallDelta(at, partial);
				}
				return;
			}
			case "content_block_stop": {
				const stream = this.stream;
				if (!stream) return;
				const index = Number(event.index);
				const at = stream.index.get(index);
				if (at === undefined) return;
				const kind = stream.kind.get(index);
				if (kind === "text") t.textEnd(at);
				else if (kind === "thinking") t.thinkingEnd(at);
				else if (kind === "tool_use" || kind === "server_tool_use") {
					const tool = stream.tool.get(index);
					let input: Json = {};
					try {
						const raw = stream.json.get(index) ?? "";
						input = raw ? (JSON.parse(raw) as Json) : {};
					} catch {
						input = {};
					}
					t.toolCallEnd(at, toolCallPart({ id: tool?.id, name: tool?.name, input }));
				}
				return;
			}
			case "message_delta": {
				const stream = this.stream;
				if (!stream) return;
				const delta = (event.delta ?? {}) as Json;
				if (delta.stop_reason) stream.stopReason = stopReason(delta.stop_reason);
				const usage = event.usage as Json | undefined;
				if (usage) {
					const merged = anthropicUsage({
						input_tokens: usage.input_tokens ?? stream.usage?.input,
						output_tokens: usage.output_tokens ?? stream.usage?.output,
						cache_read_input_tokens: usage.cache_read_input_tokens ?? stream.usage?.cacheRead,
						cache_creation_input_tokens: usage.cache_creation_input_tokens ?? stream.usage?.cacheWrite,
					});
					if (merged) stream.usage = merged;
				}
				return;
			}
			case "message_stop": {
				const stream = this.stream;
				this.stream = undefined;
				if (!stream || !t.streaming) return;
				t.endAssistant({
					...(stream.stopReason ? { stopReason: stream.stopReason } : {}),
					...(stream.usage ? { usage: stream.usage } : {}),
					...(stream.model ? { model: stream.model } : {}),
				});
				return;
			}
			default:
				return;
		}
	}

	/** SDK `assistant` messages: complete content blocks, used when no stream events arrived. */
	private onAssistant(m: Json): void {
		const message = (m.message ?? {}) as Json;
		const id = typeof message.id === "string" ? message.id : undefined;
		if (id && this.streamed.has(id)) return;
		const t = this.transcript;
		if (this.fallbackId !== id) {
			this.endFallback();
			this.fallbackId = id;
		}
		if (typeof message.model === "string") this.resolvedModel = message.model;
		for (const part of assistantParts(message.content)) {
			if (part.type === "text") t.text(part.text);
			else if (part.type === "thinking")
				t.thinkingEnd(t.thinkingStart(undefined, part.redacted === true), part.thinking);
			else t.toolCall(part);
		}
		const usage = anthropicUsage(message.usage);
		if (usage && t.streaming) t.setUsage(usage);
		if (message.stop_reason) this.endFallback(stopReason(message.stop_reason));
	}

	private endFallback(reason?: string): void {
		if (this.fallbackId === undefined) return;
		this.fallbackId = undefined;
		if (this.stream === undefined && this.transcript.streaming) {
			this.transcript.endAssistant(reason ? { stopReason: reason } : {});
		}
	}

	private onUser(m: Json): void {
		const message = (m.message ?? {}) as Json;
		const content = message.content;
		if (!Array.isArray(content)) return;
		const results = (content as Json[]).filter((b) => b?.type === "tool_result");
		if (results.length === 0) return;
		this.endFallback();
		if (this.stream === undefined && this.transcript.streaming) this.transcript.endAssistant();
		for (const block of results) {
			const id = String(block.tool_use_id ?? "");
			const toolUseResult = results.length === 1 ? m.tool_use_result : undefined;
			const call = this.findToolCall(id);
			this.transcript.toolResult(id, toolResultInput(block, toolUseResult));
			if (call && CLAUDE_AGENT_TOOLS.has(call.name)) this.onAgentResult(id, block, toolUseResult);
		}
	}

	private onResult(m: Json): void {
		this.endFallback();
		let failure: string | undefined;
		if (m.subtype !== "success") {
			const errors = Array.isArray(m.errors) ? (m.errors as string[]).filter(Boolean) : [];
			failure = errors.join("\n") || `Claude Code stopped (${String(m.subtype)})`;
		} else if (m.is_error === true) {
			failure = typeof m.result === "string" && m.result ? m.result : "Claude Code reported an error";
		}
		// An interrupted run is not an error for the user.
		if (failure && this.aborting) failure = undefined;
		this.finishRun(failure);
		if (this.pendingName) {
			const name = this.pendingName;
			this.pendingName = undefined;
			void this.applyName(name);
		}
	}

	private aborting = false;

	private finishRun(failure?: string): void {
		this.stream = undefined;
		this.fallbackId = undefined;
		if (this.retrying) {
			this.retrying = false;
			this.emit({ type: "auto_retry_end", success: failure === undefined });
		}
		if (this.compacting) this.endCompaction(failure);
		this.transcript.endRun(failure);
		this.aborting = false;
		this.setRunState("idle");
		const waiters = this.runWaiters;
		this.runWaiters = [];
		for (const resolve of waiters) resolve();
		this.scheduleProcessStop();
	}

	/** Stop the idle Claude Code process to free memory; the next prompt resumes the session. */
	private scheduleProcessStop(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.running || this.queued.length > 0 || this.bridge.pendingRequests.length > 0) return;
			this.stopProcess();
		}, PROCESS_IDLE_MS);
		this.idleTimer.unref?.();
	}

	private stopProcess(): void {
		const query = this.query;
		this.query = undefined;
		this.input?.close();
		this.input = undefined;
		if (query) {
			try {
				query.close();
			} catch {
				// Already closed.
			}
		}
	}

	private onSystem(m: Json): void {
		switch (m.subtype) {
			case "init":
				if (typeof m.model === "string") this.resolvedModel = m.model;
				return;
			case "status":
				if (m.status === "compacting") {
					if (!this.compacting) {
						this.compacting = true;
						this.emit({ type: "compaction_start", reason: "manual" });
					}
					this.setRunState("compacting");
				} else if (this.compacting && m.compact_result) {
					this.endCompaction(
						m.compact_result === "failed" ? String(m.compact_error ?? "Compaction failed") : undefined,
					);
				}
				return;
			case "compact_boundary": {
				const metadata = (m.compact_metadata ?? {}) as Json;
				this.lastCompactTokens = Number(metadata.pre_tokens ?? 0);
				this.transcript.messages.push({
					role: "compactionSummary",
					summary: "",
					tokensBefore: this.lastCompactTokens,
					timestamp: Date.now(),
				} as unknown as TranscriptMessage);
				if (!this.compacting) {
					this.compacting = true;
					this.emit({ type: "compaction_start", reason: metadata.trigger === "auto" ? "threshold" : "manual" });
				}
				this.endCompaction();
				return;
			}
			case "task_started":
				this.onTaskStarted(m);
				return;
			case "task_progress":
				this.onTaskProgress(m);
				return;
			case "task_updated":
				this.onTaskUpdated(m);
				return;
			case "task_notification":
				this.onTaskNotification(m);
				return;
			case "api_retry": {
				this.retrying = true;
				const error = (m.error ?? {}) as Json;
				this.emit({
					type: "auto_retry_start",
					attempt: Number(m.attempt ?? 1),
					maxAttempts: Number(m.max_retries ?? 0),
					delayMs: Number(m.retry_delay_ms ?? 0),
					errorMessage: String(error.message ?? m.error_status ?? "API error"),
				});
				this.setRunState("retrying");
				return;
			}
			default:
				return;
		}
	}

	// ---------------------------------------------------------------- subagents

	/** A tool call of the transcript or of a subagent's conversation, with its owner. */
	private findToolCall(id: string): (ToolCallPart & { owner?: string }) | undefined {
		const search = (messages: Array<{ role: string; content?: unknown }>) => {
			for (let i = messages.length - 1; i >= 0; i--) {
				const message = messages[i];
				if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
				for (const part of message.content as ToolCallPart[]) {
					if (part?.type === "toolCall" && part.id === id) return part;
				}
			}
			return undefined;
		};
		const t = this.transcript;
		const own = search(t.streaming ? [...t.messages, t.streaming] : t.messages);
		if (own) return own;
		for (const subagent of this.subagents.list()) {
			if (!subagent.transcript || subagent.status !== "running") continue;
			const conversation = this.subagents.conversation(subagent.id);
			const messages = conversation.streaming
				? [...conversation.messages, conversation.streaming]
				: conversation.messages;
			const call = search(messages);
			if (call) return { ...call, owner: subagent.id };
		}
		return undefined;
	}

	/** The subagent of an `Agent` tool call, created when first seen. */
	private agentFor(toolUseId: string): string {
		if (!this.subagents.has(toolUseId)) {
			const call = this.findToolCall(toolUseId);
			const fields = call ? agentCallFields(call.arguments) : { name: "Agent" };
			const description = clip(fields.description, 500);
			const task = clip(fields.task);
			this.subagents.update(toolUseId, {
				toolCallId: toolUseId,
				...(call?.owner ? { parentId: call.owner } : {}),
				name: fields.name,
				...(description ? { description } : {}),
				...(task ? { task } : {}),
				status: "running",
				startedAt: Date.now(),
			});
		}
		return toolUseId;
	}

	private agentOfTask(m: Json): string | undefined {
		const taskId = typeof m.task_id === "string" ? m.task_id : undefined;
		const byTask = taskId ? this.taskAgents.get(taskId) : undefined;
		if (byTask) return byTask;
		const toolUseId = typeof m.tool_use_id === "string" ? m.tool_use_id : undefined;
		return toolUseId && this.subagents.has(toolUseId) ? toolUseId : undefined;
	}

	private onTaskStarted(m: Json): void {
		const toolUseId = typeof m.tool_use_id === "string" ? m.tool_use_id : undefined;
		const taskId = typeof m.task_id === "string" ? m.task_id : undefined;
		const isAgent = m.task_type === "local_agent" || (m.task_type === undefined && m.subagent_type !== undefined);
		if (!toolUseId || !isAgent || m.skip_transcript === true) return;
		const id = this.agentFor(toolUseId);
		const description = clip(typeof m.description === "string" ? m.description : undefined, 500);
		const task = clip(typeof m.prompt === "string" ? m.prompt : undefined);
		if (taskId) {
			this.agentTasks.set(id, taskId);
			this.taskAgents.set(taskId, id);
		}
		this.subagents.update(
			id,
			{
				...(typeof m.subagent_type === "string" && m.subagent_type ? { name: m.subagent_type } : {}),
				...(description ? { description } : {}),
				...(task ? { task } : {}),
				status: "running",
				stoppable: taskId !== undefined,
			},
			{ immediate: true },
		);
	}

	private onTaskProgress(m: Json): void {
		const id = this.agentOfTask(m);
		const info = id ? this.subagents.get(id) : undefined;
		if (!id || !info) return;
		const usage = (m.usage ?? {}) as Json;
		const steps = Number(usage.tool_uses);
		const tokens = Number(usage.total_tokens);
		const activity = [m.summary, m.description, m.last_tool_name].find(
			(v): v is string => typeof v === "string" && v.trim() !== "",
		);
		this.subagents.update(id, {
			...(Number.isFinite(steps) ? { steps: Math.max(info.steps, steps) } : {}),
			...(Number.isFinite(tokens) ? { tokens } : {}),
			...(activity ? { activity: clip(activity, 200) } : {}),
		});
	}

	private onTaskUpdated(m: Json): void {
		const id = this.agentOfTask(m);
		const patch = (m.patch ?? {}) as Json;
		if (!id) return;
		const error = typeof patch.error === "string" ? clip(patch.error) : undefined;
		if (patch.status === "failed") this.finishAgent(id, "failed", error ? { error } : {});
		else if (patch.status === "killed") this.finishAgent(id, "stopped");
		else if (patch.status === "completed") this.finishAgent(id, "completed");
	}

	private onTaskNotification(m: Json): void {
		const id = this.agentOfTask(m);
		if (!id) return;
		const info = this.subagents.get(id);
		const usage = (m.usage ?? {}) as Json;
		const summary = typeof m.summary === "string" ? m.summary : undefined;
		const steps = Number(usage.tool_uses);
		const tokens = Number(usage.total_tokens);
		const patch = {
			...(Number.isFinite(steps) ? { steps: Math.max(info?.steps ?? 0, steps) } : {}),
			...(Number.isFinite(tokens) ? { tokens } : {}),
		};
		if (m.status === "completed")
			this.finishAgent(id, "completed", { ...patch, ...this.reportPatch(summary) }, summary);
		else if (m.status === "failed") {
			const error = clip(summary);
			this.finishAgent(id, "failed", { ...patch, ...(error ? { error } : {}) });
		} else this.finishAgent(id, "stopped", patch);
	}

	private reportPatch(report: string | undefined): { result?: string } {
		const result = clip(report);
		return result ? { result } : {};
	}

	private finishAgent(
		id: string,
		status: "completed" | "failed" | "stopped",
		patch: SubagentPatch = {},
		report?: string,
	): void {
		this.endChildMessage(id);
		if (report && this.subagents.get(id)?.status === "running") this.appendReport(id, report);
		const taskId = this.agentTasks.get(id);
		if (taskId) this.taskAgents.delete(taskId);
		this.agentTasks.delete(id);
		this.subagents.finish(id, status, { ...patch, stoppable: false });
	}

	/** The parent's result of an `Agent` tool call: final for foreground subagents. */
	private onAgentResult(id: string, block: Json, toolUseResult: unknown): void {
		const agent = this.agentFor(id);
		const r = (toolUseResult && typeof toolUseResult === "object" ? toolUseResult : {}) as Json;
		const text = toolResultInput(block).text;
		const report = parseAgentResult(text);
		if (typeof r.agentId === "string") this.agentIds.set(agent, r.agentId);
		else if (report.agentId) this.agentIds.set(agent, report.agentId);
		const info = this.subagents.get(agent);
		const steps = Number(r.totalToolUseCount ?? report.toolUses);
		const tokens = Number(r.totalTokens ?? report.tokens);
		const patch = {
			...(typeof r.resolvedModel === "string" ? { model: r.resolvedModel } : {}),
			...(Number.isFinite(steps) ? { steps: Math.max(info?.steps ?? 0, steps) } : {}),
			...(Number.isFinite(tokens) ? { tokens } : {}),
		};
		if (info && info.status !== "running") {
			// Its task notification already ended it.
			const result = info.status === "completed" && !info.result ? this.reportPatch(report.report) : {};
			this.subagents.update(agent, { ...patch, ...result });
		} else if (block.is_error === true) {
			const error = clip(text);
			this.finishAgent(agent, "failed", { ...patch, ...(error ? { error } : {}) });
		} else if (r.status === "completed" || !this.agentTasks.has(agent)) {
			this.finishAgent(
				agent,
				"completed",
				{ ...patch, ...(info?.result ? {} : this.reportPatch(report.report)) },
				report.report,
			);
		} else {
			// Running in the background: its task notification ends it.
			this.subagents.update(agent, patch);
		}
	}

	/**
	 * Claude Code does not stream a subagent's final reply, only its summary: add it to the live
	 * conversation unless the conversation already ends with a reply.
	 */
	private appendReport(id: string, report: string): void {
		if (!this.subagents.get(id)?.transcript) return;
		const conversation = this.subagents.conversation(id);
		const last = conversation.messages.at(-1);
		if (last?.role === "assistant" && last.content.some((p) => p.type === "text" && p.text.trim())) return;
		conversation.text(report);
		conversation.endAssistant();
	}

	private endChildMessage(id: string): void {
		this.childMessages.delete(id);
		if (this.subagents.get(id)?.transcript) this.subagents.conversation(id).endAssistant();
	}

	/** A message of a subagent's conversation from Claude Code (prompt or tool results). */
	private onChildUser(parentToolUseId: string, m: Json): void {
		const id = this.agentFor(parentToolUseId);
		const conversation = this.subagents.conversation(id);
		const content = ((m.message ?? {}) as Json).content;
		if (typeof content === "string") {
			this.endChildMessage(id);
			const text = promptText(content);
			if (text?.trim()) conversation.addUser(text);
			return;
		}
		if (!Array.isArray(content)) return;
		const blocks = content as Json[];
		const results = blocks.filter((b) => b?.type === "tool_result");
		if (results.length) {
			this.endChildMessage(id);
			for (const block of results) {
				conversation.toolResult(
					String(block.tool_use_id ?? ""),
					toolResultInput(block, results.length === 1 ? m.tool_use_result : undefined),
				);
			}
			return;
		}
		const text = blocks
			.filter((b) => b?.type === "text")
			.map((b) => promptText(String(b.text ?? "")) ?? "")
			.filter((t) => t.trim())
			.join("\n\n");
		if (text) {
			this.endChildMessage(id);
			conversation.addUser(text);
		}
	}

	/** An assistant message (complete content blocks) of a subagent's conversation. */
	private onChildAssistant(parentToolUseId: string, m: Json): void {
		const id = this.agentFor(parentToolUseId);
		const conversation = this.subagents.conversation(id);
		const message = (m.message ?? {}) as Json;
		const messageId = typeof message.id === "string" ? message.id : undefined;
		if (this.childMessages.get(id) !== messageId) {
			this.endChildMessage(id);
			if (messageId) this.childMessages.set(id, messageId);
		}
		if (typeof message.model === "string" && message.model) this.subagents.update(id, { model: message.model });
		for (const part of assistantParts(message.content)) {
			if (part.type === "text") {
				if (part.text) conversation.text(part.text);
			} else if (part.type === "thinking") {
				if (part.thinking || part.redacted) {
					conversation.thinkingEnd(conversation.thinkingStart(undefined, part.redacted === true), part.thinking);
				}
			} else conversation.toolCall(part);
		}
		const usage = anthropicUsage(message.usage);
		if (usage && conversation.streaming) conversation.setUsage(usage);
		if (message.stop_reason) this.endChildMessage(id);
	}

	/** Subagents cannot outlive the Claude Code process. */
	private stopAllSubagents(): void {
		for (const subagent of this.subagents.running()) this.finishAgent(subagent.id, "stopped");
	}

	protected override subagentHooks(): SubagentRuntimeHooks {
		return {
			stop: async (subagent) => {
				const taskId = this.agentTasks.get(subagent.id);
				if (!taskId || !this.query) throw new PierProtocolError("CONFLICT", "The subagent is no longer running");
				await this.query.stopTask(taskId);
			},
			load: (subagent) => this.loadAgentTranscript(subagent.id),
		};
	}

	/** The stored conversation of a subagent (Claude Code keeps one file per subagent). */
	private async loadAgentTranscript(id: string): Promise<TranscriptMessage[] | undefined> {
		if (!this.persisted) return undefined;
		const sdk = await this.host.sdk();
		if (!sdk.getSubagentMessages) return undefined;
		const dir = this.workspacePath;
		if (!this.agentIds.has(id) && sdk.listSubagents) {
			const known = new Set(this.agentIds.values());
			for (const agentId of await sdk.listSubagents(this.sessionId, { dir })) {
				if (known.has(agentId)) continue;
				const [first] = await sdk.getSubagentMessages(this.sessionId, agentId, { dir, limit: 1 });
				if (first?.parent_tool_use_id) this.agentIds.set(first.parent_tool_use_id, agentId);
			}
		}
		const agentId = this.agentIds.get(id);
		if (!agentId) return undefined;
		return convertSubagentTranscript(await sdk.getSubagentMessages(this.sessionId, agentId, { dir }));
	}

	private endCompaction(failure?: string): void {
		if (!this.compacting) return;
		this.compacting = false;
		this.emit({
			type: "compaction_end",
			reason: "manual",
			...(failure ? {} : { result: { summary: "", tokensBefore: this.lastCompactTokens } }),
			aborted: false,
			willRetry: false,
			...(failure ? { errorMessage: failure } : {}),
		} as WireEvent);
		if (this.running) this.setRunState("streaming");
	}

	private async canUseTool(
		toolName: string,
		input: Record<string, unknown>,
		opts: { signal: AbortSignal; toolUseID?: string; title?: string; decisionReason?: string },
	): Promise<PermissionResult> {
		if (toolName === "AskUserQuestion") return this.askQuestions(input, opts.signal);
		const normalized = normalizeTool(toolName, input);
		const result = await this.approveToolCall(
			{
				toolName: normalized.name,
				toolCallId: opts.toolUseID ?? randomUUID(),
				input: normalized.arguments,
				runtimeAsked: {
					reason: opts.decisionReason ?? opts.title ?? `Claude Code asks to use ${toolName}`,
					...(opts.title ? { summary: opts.title } : {}),
				},
			},
			opts.signal,
		);
		return result.allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: result.reason };
	}

	/** Claude Code's `AskUserQuestion` tool: ask each question with a select dialog. */
	private async askQuestions(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
		const questions = Array.isArray(input.questions) ? (input.questions as Json[]) : [];
		const answers: Record<string, string> = {};
		for (const question of questions) {
			const text = String(question.question ?? "");
			const options = Array.isArray(question.options)
				? (question.options as Json[]).map((o) => String(o.label ?? "")).filter(Boolean)
				: [];
			const response = options.length
				? await this.bridge.request(
						{ kind: "select", title: String(question.header ?? text), message: text, options },
						{ signal },
					)
				: await this.bridge.request(
						{ kind: "input", title: String(question.header ?? text), message: text },
						{ signal },
					);
			if (!response || response.cancelled || response.value === undefined) {
				return { behavior: "deny", message: "The user declined to answer." };
			}
			answers[text] = response.value;
		}
		return { behavior: "allow", updatedInput: { ...input, answers } };
	}

	// ---------------------------------------------------------------- ManagedSession

	protected describe(): SessionDescription {
		const messages = this.transcript.messages.filter((m) => m.role === "user" || m.role === "assistant");
		const path = this.sessionFile;
		return {
			...(path ? { path } : {}),
			...(this.name ? { name: this.name } : {}),
			cwd: this.workspacePath,
			createdAt: this.createdAt,
			messageCount: messages.length,
			firstMessage: firstPromptOf(this.transcript.messages),
		};
	}

	private modelInfo(): ModelInfo {
		const id = this.modelId ?? "default";
		return (
			this.host.model(id) ?? {
				provider: CLAUDE_PROVIDER,
				id,
				name: id,
				reasoning: true,
				input: ["text", "image"],
				thinkingLevels: CLAUDE_THINKING_LEVELS,
			}
		);
	}

	private contextInfo(model = this.modelInfo()): SessionContextInfo {
		return {
			autoCompaction: "runtime",
			...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
		};
	}

	protected content(): SessionContent {
		const t = this.transcript;
		return {
			messages: t.publicMessages(),
			...(t.streaming ? { streamingMessage: structuredClone(t.streaming) } : {}),
			pendingToolCalls: t.pendingToolCalls,
			model: this.modelInfo(),
			contextInfo: this.contextInfo(),
			thinkingLevel: this.thinkingLevel,
			...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
		};
	}

	queue(): QueueState {
		return {
			steering: this.queued.filter((q) => q.steer).map((q) => q.text),
			followUp: this.queued.filter((q) => !q.steer).map((q) => q.text),
		};
	}

	private emitQueue(): void {
		const queue = this.queue();
		this.emit({ type: "queue_update", steering: queue.steering, followUp: queue.followUp });
	}

	async prompt(text: string, images?: ImageInput[], streamingBehavior?: StreamingBehavior): Promise<void> {
		this.lastActivity = Date.now();
		if (this.running) {
			if (!streamingBehavior) {
				throw new PierProtocolError("CONFLICT", "Session is busy; pass streamingBehavior `steer` or `followUp`");
			}
			await (streamingBehavior === "steer" ? this.steer(text, images) : this.followUp(text, images));
			return;
		}
		const { input } = await this.ensureQuery();
		const uuid = randomUUID();
		this.transcript.startRun();
		this.setRunState("streaming");
		this.transcript.addUser(userContent(text, images), uuid);
		input.push(sdkUserMessage(text, images, uuid));
	}

	private async enqueue(text: string, images: ImageInput[] | undefined, steer: boolean): Promise<QueueState> {
		this.lastActivity = Date.now();
		if (!this.running) {
			await this.prompt(text, images);
			return this.queue();
		}
		const { input } = await this.ensureQuery();
		const uuid = randomUUID();
		this.queued.push({ uuid, text, content: userContent(text, images), steer });
		this.emitQueue();
		input.push(sdkUserMessage(text, images, uuid, steer ? "now" : "later"));
		return this.queue();
	}

	steer(text: string, images?: ImageInput[]): Promise<QueueState> {
		return this.enqueue(text, images, true);
	}

	followUp(text: string, images?: ImageInput[]): Promise<QueueState> {
		return this.enqueue(text, images, false);
	}

	async abort(): Promise<void> {
		this.lastActivity = Date.now();
		if (!this.query || !this.running) return;
		this.aborting = true;
		this.bridge.cancelAll();
		try {
			await this.query.interrupt();
		} catch (error) {
			this.host.log(`interrupting Claude Code failed: ${errorMessage(error)}`);
		}
	}

	override async compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		if (this.running) throw new PierProtocolError("CONFLICT", "Wait for the agent to finish before compacting");
		if (!this.persisted) throw new PierProtocolError("CONFLICT", "Nothing to compact yet");
		const { input } = await this.ensureQuery();
		const done = new Promise<void>((resolve) => this.runWaiters.push(resolve));
		this.transcript.startRun();
		this.compacting = true;
		this.lastCompactTokens = 0;
		this.emit({ type: "compaction_start", reason: "manual" });
		this.setRunState("compacting");
		const text = instructions?.trim() ? `/compact ${instructions.trim()}` : "/compact";
		input.push(sdkUserMessage(text, undefined, randomUUID()));
		await done;
		return { summary: "", tokensBefore: this.lastCompactTokens };
	}

	private async applyName(name: string): Promise<void> {
		try {
			const sdk = await this.host.sdk();
			await sdk.renameSession(this.sessionId, name, { dir: this.workspacePath });
		} catch (error) {
			this.host.log(`renaming Claude Code session failed: ${errorMessage(error)}`);
		}
	}

	async rename(name: string): Promise<SessionSummary> {
		this.name = name;
		if (this.persisted && !this.running) await this.applyName(name);
		else this.pendingName = name;
		this.emit({ type: "session_info_changed", name });
		return this.summary();
	}

	async setModel(provider: string, modelId: string, _persist: boolean): Promise<ModelInfo> {
		if (provider !== CLAUDE_PROVIDER) {
			throw new PierProtocolError("BAD_REQUEST", "Claude Code sessions can only use Claude Code models");
		}
		const info = this.host.model(modelId);
		if (!info) throw new PierProtocolError("NOT_FOUND", `Unknown model ${provider}/${modelId}`);
		this.modelId = modelId;
		this.resolvedModel = undefined;
		if (this.query) await this.query.setModel(modelId === "default" ? undefined : modelId);
		if (info.thinkingLevels && !info.thinkingLevels.includes(this.thinkingLevel)) {
			this.thinkingLevel = info.thinkingLevels.includes("high") ? "high" : (info.thinkingLevels.at(-1) ?? "off");
		}
		this.emit({
			type: "session.model",
			model: info,
			contextInfo: this.contextInfo(info),
			thinkingLevel: this.thinkingLevel,
		});
		return info;
	}

	async setThinking(level: ThinkingLevel, _persist: boolean): Promise<string> {
		const supported = this.modelInfo().thinkingLevels ?? CLAUDE_THINKING_LEVELS;
		let next: ThinkingLevel = level === "minimal" ? "low" : level;
		if (!supported.includes(next)) next = supported.includes("high") ? "high" : (supported.at(-1) ?? "off");
		const previous = this.thinkingLevel;
		this.thinkingLevel = next;
		this.thinkingChosen = true;
		if (this.query) {
			if (next === "off") await this.query.setMaxThinkingTokens(0);
			else {
				if (previous === "off") await this.query.setMaxThinkingTokens(null);
				await this.query.applyFlagSettings({ effortLevel: next as never });
			}
		}
		this.emit({ type: "thinking_level_changed", level: next });
		return next;
	}

	override async commands(): Promise<SessionCommandInfo[]> {
		if (this.query) {
			try {
				const commands = await this.query.supportedCommands();
				return commands.map((c) => ({
					name: c.name,
					...(c.description ? { description: c.description } : {}),
					...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
					source: "prompt" as const,
				}));
			} catch {
				// Fall back to the runtime's list.
			}
		}
		return this.host.commands();
	}

	override async forkPoints(): Promise<Array<{ entryId: string; text: string }>> {
		if (!this.persisted) return [];
		const sdk = await this.host.sdk();
		const entries = await sdk.getSessionMessages(this.sessionId, { dir: this.workspacePath });
		return convertTranscript(entries)
			.filter((m): m is UserMessage => m.role === "user" && m.entryId !== undefined)
			.map((m) => ({ entryId: m.entryId as string, text: userContentText(m.content) }));
	}

	protected async disposeRuntime(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.stopProcess();
		const waiters = this.runWaiters;
		this.runWaiters = [];
		for (const resolve of waiters) resolve();
	}
}
