import {
	type AgentRuntimeCapabilities,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type QueueState,
	type SessionCommandInfo,
	type SessionContextInfo,
	type StreamingBehavior,
	type ThinkingLevel,
	type WireEvent,
} from "@pier/protocol";
import {
	errorMessage,
	ManagedSession,
	type ManagedSessionOptions,
	MIN_CONTEXT_LIMIT,
	type SessionContent,
} from "../managed-session.ts";
import {
	firstPromptOf,
	LiveTranscript,
	type TranscriptMessage,
	type Usage,
	usageFrom,
} from "../runtimes/live-transcript.ts";
import { type AcpConnection, AcpError, acpText, type Json } from "./acp.ts";
import type { HermesRuntime } from "./hermes-runtime.ts";
import {
	type HermesModelState,
	MODEL_CONFIG_ID,
	modelKey,
	modelState,
	REASONING_CONFIG_ID,
	reasoningValue,
} from "./models.ts";
import { HermesTranscript, textDiff } from "./transcript.ts";

export const HERMES_CAPABILITIES: AgentRuntimeCapabilities = {
	steer: false,
	followUp: false,
	compact: true,
	fork: false,
	rename: true,
	setModel: true,
	thinking: true,
	reload: false,
	images: true,
	piExtensions: false,
	// Hermes' compression threshold is global (`compression.threshold`): Pier compacts with
	// `/compress` after a turn that went past the limit.
	contextLimit: { min: MIN_CONTEXT_LIMIT, enforcement: "turn" },
};

/** How long an aborted turn may take to end before Pier stops waiting for it. */
const CANCEL_GRACE_MS = 15_000;

const TRANSCRIPT_UPDATES = new Set([
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
]);

/** What a `session/new` or `session/load` returned, plus what is known about the session. */
export interface HermesSessionStart {
	sessionId: string;
	result: Json;
	title?: string;
	createdAt?: string;
	/** The session already holds a conversation (it was opened, not created). */
	persisted: boolean;
}

/** Session counters Hermes reports with every turn (`PromptResponse.usage`). */
interface Counters {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function counters(usage: unknown): Counters | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Json;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	return {
		input: n(u.inputTokens),
		output: n(u.outputTokens),
		cacheRead: n(u.cachedReadTokens),
		cacheWrite: n(u.cachedWriteTokens),
	};
}

/** A one-line title, as Hermes' `/title` takes it. */
function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export class HermesSession extends ManagedSession {
	readonly runtimeId = "hermes";
	readonly capabilities = HERMES_CAPABILITIES;
	readonly sessionFile = undefined;
	readonly id: string;
	private title: string | undefined;
	private readonly createdAt: string;
	private pickers: HermesModelState;
	private contextWindow: number | undefined;
	private contextTokens: number | undefined;
	private agentCommands: SessionCommandInfo[] = [];
	private readonly transcript = new LiveTranscript(
		(event) => this.emit(event),
		() => ({ provider: this.pickers.current?.provider ?? "hermes", model: this.pickers.current?.id }),
	);
	private readonly reducer = new HermesTranscript(this.transcript);
	/** The process generation the session is attached to; another one needs `session/resume`. */
	private attached: number;
	private readonly detach: () => void;
	private turn: AbortController | undefined;
	private done: Promise<void> | undefined;
	/** Updates to drop: a re-attach's history replay, the answer of a `/title` Pier sent. */
	private muted = 0;
	private persisted: boolean;
	private pendingTitle: string | undefined;
	private named = false;
	private baseline: Counters | undefined;
	/** The running `/compress`, and the text Hermes answers it with. */
	private compaction: { done: Promise<{ summary: string; tokensBefore: number }>; reply: string[] } | undefined;

	constructor(
		options: ManagedSessionOptions,
		private readonly runtime: HermesRuntime,
		connection: AcpConnection,
		start: HermesSessionStart,
		/** Replay of the stored conversation, collected before the session existed. */
		history: Json[] = [],
	) {
		super(options);
		this.id = start.sessionId;
		this.title = start.title;
		this.createdAt = start.createdAt ?? new Date().toISOString();
		this.persisted = start.persisted;
		if (!start.persisted) this.baseline = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.pickers = modelState(start.result);
		for (const update of history) this.handleUpdate(update, true);
		this.reducer.finish();
		// Tool calls the stored conversation left open did not finish.
		this.transcript.endRun();
		this.attached = connection.generation;
		this.detach = connection.listen(this.id, {
			update: (update) => this.handleUpdate(update, false),
			request: (method, params) => this.answer(method, params),
		});
		this.acquireLock(`hermes-session:${this.id}`);
	}

	protected describe() {
		return {
			...(this.title ? { name: this.title } : {}),
			cwd: this.workspacePath,
			createdAt: this.createdAt,
			messageCount: this.transcript.messages.filter((m) => m.role !== "toolResult").length,
			firstMessage: firstPromptOf(this.transcript.messages),
		};
	}

	private contextInfo(): SessionContextInfo {
		const window = this.contextWindow;
		const limit = this.contextLimit;
		return this.withContextLimit({
			autoCompaction: limit === undefined ? "runtime" : "configured",
			...(window ? { contextWindow: window } : {}),
			...(this.contextTokens ? { contextTokens: this.contextTokens } : {}),
			...(limit !== undefined ? { compactionThreshold: window ? Math.min(limit, window) : limit } : {}),
		});
	}

	private currentModel(): ModelInfo | undefined {
		const model = this.pickers.current;
		return model && this.contextWindow && !model.contextWindow
			? { ...model, contextWindow: this.contextWindow }
			: model;
	}

	protected content(): SessionContent {
		const t = this.transcript;
		const model = this.currentModel();
		return {
			messages: t.publicMessages(),
			...(t.streaming ? { streamingMessage: structuredClone(t.streaming) } : {}),
			pendingToolCalls: t.pendingToolCalls,
			thinkingLevel: this.pickers.thinking,
			contextInfo: this.contextInfo(),
			...(model ? { model } : {}),
			...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
		};
	}

	private emitModel(): void {
		const model = this.currentModel();
		this.emit({
			type: "session.model",
			...(model ? { model } : {}),
			contextInfo: this.contextInfo(),
			thinkingLevel: this.pickers.thinking,
		});
	}

	// ---------------------------------------------------------------- ACP updates and requests

	/** `replaying`: the stored conversation `session/load` sent before the session existed. */
	private handleUpdate(update: Json, replaying: boolean): void {
		this.lastActivity = Date.now();
		if (this.compaction && !replaying && update.sessionUpdate === "agent_message_chunk") {
			this.compaction.reply.push(acpText(update.content));
		}
		if (TRANSCRIPT_UPDATES.has(String(update.sessionUpdate))) {
			// Outside Pier's own turns (a re-attach's replay, the answer to `/title`, another
			// client's turn) Hermes' messages are not this transcript's.
			if (replaying || (this.turn && this.muted === 0)) this.reducer.update(update, replaying);
			return;
		}
		switch (update.sessionUpdate) {
			case "usage_update": {
				const size = Number(update.size);
				const used = Number(update.used);
				const window = Number.isSafeInteger(size) && size > 0 ? size : this.contextWindow;
				const tokens = Number.isSafeInteger(used) && used >= 0 ? used : this.contextTokens;
				if (window === this.contextWindow && tokens === this.contextTokens) return;
				this.contextWindow = window;
				this.contextTokens = tokens;
				if (!replaying) this.emitModel();
				return;
			}
			case "session_info_update": {
				const title = typeof update.title === "string" ? update.title.trim() : "";
				// A name given in Pier wins over the titles Hermes generates.
				if (!title || title === this.title || this.named) return;
				this.title = title;
				if (!replaying) this.emit({ type: "session_info_changed", name: title });
				return;
			}
			case "available_commands_update": {
				const list = Array.isArray(update.availableCommands) ? (update.availableCommands as Json[]) : [];
				this.agentCommands = list
					.filter((c) => typeof c?.name === "string" && c.name)
					.map((c) => {
						const hint = c.input && typeof c.input === "object" ? (c.input as Json).hint : undefined;
						return {
							name: String(c.name),
							...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
							...(typeof hint === "string" && hint ? { argumentHint: `<${hint}>` } : {}),
							source: "prompt" as const,
						};
					});
				return;
			}
			case "config_option_update": {
				const before = this.pickers;
				this.pickers = modelState({ configOptions: update.configOptions }, this.pickers);
				if (
					!replaying &&
					(before.current?.id !== this.pickers.current?.id ||
						before.current?.provider !== this.pickers.current?.provider ||
						before.thinking !== this.pickers.thinking)
				)
					this.emitModel();
				return;
			}
		}
	}

	/** Answer a request of Hermes for this session. */
	async answer(method: string, params: Json): Promise<unknown> {
		this.lastActivity = Date.now();
		const signal = this.turn?.signal ?? AbortSignal.timeout(30 * 60 * 1000);
		switch (method) {
			case "session/request_permission":
				return this.permission(params, signal);
			case "elicitation/create":
				return this.elicitation(params, signal);
			default:
				throw new AcpError(`Method not found: ${method}`, -32601);
		}
	}

	/** Answer `session/request_permission`: an approval through Pier's policy, or a question's choices. */
	private async permission(params: Json, signal: AbortSignal): Promise<Json> {
		const call = (params.toolCall ?? {}) as Json;
		const options = (Array.isArray(params.options) ? params.options : []) as Json[];
		const id = typeof call.toolCallId === "string" ? call.toolCallId : "";
		const title = typeof call.title === "string" ? call.title : "";
		const cancelled = { outcome: { outcome: "cancelled" } };
		const pick = (optionId: unknown) =>
			typeof optionId === "string" ? { outcome: { outcome: "selected", optionId } } : cancelled;
		const allows = options.filter((o) => typeof o.kind === "string" && o.kind.startsWith("allow"));
		const rejects = options.filter((o) => typeof o.kind === "string" && o.kind.startsWith("reject"));
		// A question (Hermes' clarify): one option per answer.
		if (id.startsWith("clarify-") || allows.filter((o) => o.kind === "allow_once").length > 1) {
			const labels = options.map((o) => String(o.name ?? o.optionId));
			const response = await this.bridge.request(
				{ kind: "select", title: title || "Hermes 的问题", message: acpText(call.content) || title, options: labels },
				{ signal },
			);
			if (!response?.value || response.cancelled) return pick(rejects[0]?.optionId);
			return pick(options[labels.indexOf(response.value)]?.optionId);
		}
		const raw = (call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}) as Json;
		const content = (Array.isArray(call.content) ? call.content : []) as Json[];
		const diff = content.find((b) => b?.type === "diff" && typeof b.path === "string");
		let toolName: string;
		let input: Record<string, unknown>;
		if (call.kind === "execute" && typeof raw.command === "string") {
			toolName = "bash";
			input = { command: raw.command, ...(raw.description ? { description: raw.description } : {}) };
		} else if (diff) {
			const path = String(diff.path);
			toolName = typeof diff.oldText === "string" ? "edit" : "write";
			const shown = textDiff(typeof diff.oldText === "string" ? diff.oldText : undefined, String(diff.newText ?? ""));
			this.reducer.rememberDiff(path, shown);
			input = { path, ...(shown ? { diff: shown } : {}) };
		} else {
			toolName = `hermes.${typeof call.kind === "string" ? call.kind : "other"}`;
			input = Object.keys(raw).length ? raw : { title };
		}
		const decision = await this.approveToolCall(
			{
				toolName,
				toolCallId: id || `hermes-${Date.now()}`,
				input,
				runtimeAsked: { reason: `Hermes: ${title || toolName}`, summary: title || toolName },
			},
			signal,
		);
		if (decision.allowed) {
			const once = allows.find((o) => o.kind === "allow_once") ?? allows[0];
			return pick(once?.optionId);
		}
		return pick((rejects.find((o) => o.kind === "reject_once") ?? rejects[0])?.optionId);
	}

	/** Answer an `elicitation/create` form (Hermes asks its clarify questions this way). */
	private async elicitation(params: Json, signal: AbortSignal): Promise<Json> {
		const schema = (params.requestedSchema ?? {}) as Json;
		const properties = (schema.properties ?? {}) as Record<string, Json>;
		const message = typeof params.message === "string" ? params.message : "";
		const content: Record<string, unknown> = {};
		for (const [key, property] of Object.entries(properties)) {
			const title = typeof property.title === "string" ? property.title : message || key;
			const items = (property.items ?? {}) as Json;
			const options = (Array.isArray(property.enum) ? property.enum : Array.isArray(items.enum) ? items.enum : []).map(
				String,
			);
			if (property.type === "boolean") {
				const response = await this.bridge.request({ kind: "confirm", title, message }, { signal });
				if (!response || response.cancelled) return { action: "cancel" };
				content[key] = response.confirmed === true;
			} else if (property.type === "string" && options.length) {
				const response = await this.bridge.request({ kind: "select", title, message, options }, { signal });
				if (!response?.value || response.cancelled) return { action: "decline" };
				content[key] = response.value;
			} else {
				const multiple = property.type === "array";
				const response = await this.bridge.request(
					{
						kind: "input",
						title,
						message: [
							message,
							...(options.length ? [`可选：${options.join(" / ")}`] : []),
							...(multiple ? ["多个答案每行一个。"] : []),
						]
							.filter(Boolean)
							.join("\n"),
					},
					{ signal },
				);
				if (response?.value === undefined || response.cancelled) return { action: "decline" };
				const value = response.value.trim();
				content[key] = multiple
					? value
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean)
					: property.type === "number" || property.type === "integer"
						? Number(value)
						: value;
			}
		}
		return { action: "accept", content };
	}

	// ---------------------------------------------------------------- turns

	/** The connection, with this session attached to it (`session/resume` after a restart). */
	private async connection(): Promise<AcpConnection> {
		const connection = await this.runtime.connect();
		if (this.attached === connection.generation) return connection;
		this.muted++;
		try {
			const result = await connection.request<Json>("session/resume", {
				sessionId: this.id,
				cwd: this.workspacePath,
				mcpServers: [],
			});
			this.pickers = modelState(result, this.pickers);
		} finally {
			this.muted--;
		}
		this.attached = connection.generation;
		return connection;
	}

	async prompt(text: string, images?: ImageInput[], _behavior?: StreamingBehavior): Promise<void> {
		if (this.turn || this.compaction) throw new PierProtocolError("CONFLICT", "Hermes is busy");
		const turn = new AbortController();
		this.turn = turn;
		this.setRunState("streaming");
		this.transcript.startRun();
		this.transcript.addUser(images?.length ? [{ type: "text", text }, ...images] : text);
		let completed = false;
		this.done = this.run(text, images ?? [], turn)
			.then(() => {
				completed = !turn.signal.aborted;
			})
			.catch((error) => {
				if (!turn.signal.aborted) this.transcript.endRun(errorMessage(error));
			})
			.finally(() => {
				turn.abort();
				this.bridge.cancelAll();
				this.reducer.finish();
				this.transcript.endRun();
				this.turn = undefined;
				this.lastActivity = Date.now();
				this.setRunState("idle");
				void this.afterTurn(completed);
			});
	}

	/** Rename, then compact when the turn left the context past the limit (Hermes reports it after each turn). */
	private async afterTurn(completed: boolean): Promise<void> {
		await this.flushTitle();
		const limit = this.contextLimit;
		if (!completed || limit === undefined || !this.contextTokens || this.contextTokens < limit) return;
		if (this.turn || this.disposed) return;
		await this.compactNow("threshold").catch(() => {});
	}

	/** A limit below the current context compacts right away when Hermes is idle. */
	protected override applyContextLimit(): void {
		const limit = this.contextLimit;
		if (limit === undefined || this.turn || this.compaction || !this.contextTokens || this.contextTokens < limit)
			return;
		void this.compactNow("threshold").catch(() => {});
	}

	override compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		if (this.turn)
			return Promise.reject(new PierProtocolError("CONFLICT", "Wait for the agent to finish before compacting"));
		return this.compactNow("manual", instructions);
	}

	/**
	 * Compress the conversation with Hermes' `/compress` (a summary of the older turns, without a
	 * model turn of its own); `focus` tells the summary what to keep. Hermes answers in text.
	 */
	private compactNow(
		reason: "manual" | "threshold",
		focus?: string,
	): Promise<{ summary: string; tokensBefore: number }> {
		if (this.compaction) return this.compaction.done;
		if (!this.persisted) return Promise.reject(new PierProtocolError("CONFLICT", "Nothing to compact yet"));
		const tokensBefore = this.contextTokens ?? 0;
		const reply: string[] = [];
		this.emit({ type: "compaction_start", reason });
		this.setRunState("compacting");
		const done = (async () => {
			let failure: string | undefined;
			this.muted++;
			try {
				const connection = await this.connection();
				const command = focus?.trim() ? `/compress ${singleLine(focus)}` : "/compress";
				await connection.request(
					"session/prompt",
					{
						sessionId: this.id,
						prompt: [{ type: "text", text: command }],
					},
					{ timeoutMs: 0 },
				);
				const answer = reply.join("").trim();
				// "Context compressed: 40 -> 12 messages ..."; anything else says why it did not.
				if (!/^context compressed/i.test(answer)) {
					failure = answer || "Hermes did not compress the conversation";
					throw new PierProtocolError("CONFLICT", failure);
				}
				this.transcript.messages.push({
					role: "compactionSummary",
					summary: "",
					tokensBefore,
					timestamp: Date.now(),
				} as unknown as TranscriptMessage);
				return { summary: "", tokensBefore };
			} catch (error) {
				failure ??= errorMessage(error);
				throw error instanceof PierProtocolError ? error : new PierProtocolError("CONFLICT", failure);
			} finally {
				this.muted--;
				this.compaction = undefined;
				this.lastActivity = Date.now();
				this.emit({
					type: "compaction_end",
					reason,
					...(failure ? { errorMessage: failure } : { result: { summary: "", tokensBefore } }),
					aborted: false,
					willRetry: false,
				} as WireEvent);
				this.setRunState("idle");
				void this.flushTitle();
			}
		})();
		this.compaction = { done, reply };
		return done;
	}

	private async run(text: string, images: ImageInput[], turn: AbortController): Promise<void> {
		const connection = await this.connection();
		turn.signal.throwIfAborted();
		const prompt = [
			...(text ? [{ type: "text", text }] : []),
			...images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data })),
		];
		const cancel = () => connection.notify("session/cancel", { sessionId: this.id });
		turn.signal.addEventListener("abort", cancel, { once: true });
		let result: Json;
		try {
			const request = connection.request<Json>("session/prompt", { sessionId: this.id, prompt }, { timeoutMs: 0 });
			// An abort waits for Hermes to end the turn, but not forever.
			const aborted = new Promise<never>((_, reject) =>
				turn.signal.addEventListener(
					"abort",
					() => setTimeout(() => reject(new Error("Hermes did not stop in time")), CANCEL_GRACE_MS).unref?.(),
					{ once: true },
				),
			);
			aborted.catch(() => {});
			result = (await Promise.race([request, aborted])) ?? {};
		} finally {
			turn.signal.removeEventListener("abort", cancel);
		}
		this.persisted = true;
		const usage = this.usage(result.usage);
		const stop = result.stopReason;
		const failure =
			stop === "max_tokens"
				? "The model stopped: maximum tokens reached."
				: stop === "max_turn_requests"
					? "Hermes stopped: maximum model requests for one turn reached."
					: stop === "refusal"
						? "The model refused to continue."
						: undefined;
		const end = failure
			? { stopReason: "error", errorMessage: failure }
			: stop === "cancelled" || turn.signal.aborted
				? { stopReason: "aborted" }
				: {};
		this.reducer.finish({ ...(usage ? { usage } : {}), ...end });
		if (failure) this.transcript.endRun(failure);
	}

	/** This turn's token usage, from the session counters before and after it. */
	private usage(reported: unknown): Usage | undefined {
		const now = counters(reported);
		if (!now) return undefined;
		const before = this.baseline;
		this.baseline = now;
		if (!before) return undefined;
		const delta = (key: keyof Counters) => (now[key] >= before[key] ? now[key] - before[key] : now[key]);
		// Hermes' input tokens leave out the cached ones, as pi's do.
		const usage = usageFrom({
			input: delta("input"),
			output: delta("output"),
			cacheRead: delta("cacheRead"),
			cacheWrite: delta("cacheWrite"),
		});
		return usage.totalTokens > 0 ? usage : undefined;
	}

	async abort(): Promise<void> {
		this.turn?.abort();
		this.bridge.cancelAll();
		await this.done;
		// Hermes cannot stop a `/compress` once it runs; wait a while for it.
		const compaction = this.compaction?.done.catch(() => {});
		if (compaction) {
			await Promise.race([compaction, new Promise((resolve) => setTimeout(resolve, CANCEL_GRACE_MS).unref?.())]);
		}
	}

	queue(): QueueState {
		return { steering: [], followUp: [] };
	}

	async steer(): Promise<never> {
		throw this.unsupported("steering");
	}

	async followUp(): Promise<never> {
		throw this.unsupported("follow-up queues");
	}

	override commands(): SessionCommandInfo[] {
		return this.agentCommands;
	}

	/**
	 * Rename through Hermes' `/title`, which it answers without a model turn. Sent when the
	 * session is idle and has a conversation; until then only Pier shows the new name.
	 */
	async rename(name: string) {
		const title = singleLine(name);
		if (!title) throw new PierProtocolError("BAD_REQUEST", "The name is empty");
		this.title = title;
		this.named = true;
		this.pendingTitle = title;
		this.emit({ type: "session_info_changed", name: title });
		await this.flushTitle();
		return this.summary();
	}

	private async flushTitle(): Promise<void> {
		const title = this.pendingTitle;
		if (!title || this.turn || this.compaction || !this.persisted || this.disposed) return;
		this.pendingTitle = undefined;
		this.muted++;
		try {
			const connection = await this.connection();
			await connection.request("session/prompt", {
				sessionId: this.id,
				prompt: [{ type: "text", text: `/title ${title}` }],
			});
		} catch (error) {
			this.runtime.log(`renaming Hermes session ${this.id} failed: ${errorMessage(error)}`);
		} finally {
			this.muted--;
		}
	}

	/** Set a session option (`model`, `reasoning_effort`) and take Hermes' resulting pickers. */
	private async setOption(configId: string, value: string): Promise<void> {
		const connection = await this.connection();
		const result = await connection.request<Json>("session/set_config_option", {
			sessionId: this.id,
			configId,
			value,
		});
		this.pickers = modelState(result ?? {}, this.pickers);
	}

	async setModel(provider: string, id: string): Promise<ModelInfo> {
		let value = this.pickers.values.get(modelKey(provider, id));
		if (!value) {
			const models = await this.runtime.listModels(this.workspacePath);
			const known = models.find((m) => m.provider === provider && m.id === id);
			value = known ? this.runtime.choiceOf(known) : undefined;
		}
		if (!value) throw new PierProtocolError("NOT_FOUND", `Unknown Hermes model ${provider}/${id}`);
		await this.setOption(MODEL_CONFIG_ID, value);
		const model = this.currentModel() ?? this.pickers.models.find((m) => m.provider === provider && m.id === id);
		if (!model) throw new PierProtocolError("NOT_FOUND", `Unknown Hermes model ${provider}/${id}`);
		this.emitModel();
		return model;
	}

	async setThinking(level: ThinkingLevel): Promise<string> {
		if (!this.pickers.hasReasoning) {
			if (level !== "off") throw this.unsupported("thinking levels");
			return level;
		}
		if (!this.pickers.levels.includes(level))
			throw new PierProtocolError("BAD_REQUEST", `Hermes does not offer ${level}`);
		await this.setOption(REASONING_CONFIG_ID, reasoningValue(level));
		this.emitModel();
		return this.pickers.thinking;
	}

	protected async disposeRuntime(): Promise<void> {
		await this.abort();
		this.detach();
		this.runtime.sessionClosed(this);
	}
}
