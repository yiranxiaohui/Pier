import { tmpdir } from "node:os";
import type {
	AssistantMessage,
	Event,
	OpencodeClient,
	PermissionRequest,
	PermissionRuleset,
	Session,
	SessionMessagesResponse2,
} from "@opencode-ai/sdk/v2/client";
import {
	type AgentRuntimeCapabilities,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type QueueState,
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
	replyText,
	type SessionContent,
	textOf,
} from "../managed-session.ts";
import { firstPromptOf, LiveTranscript, type TranscriptMessage } from "../runtimes/live-transcript.ts";
import { type ExcerptMessage, excerptPrompt } from "../runtimes/prompt-suggestion.ts";
import type { OpenCodeRuntime } from "./opencode-runtime.ts";
import { contextTokensOf, errorText, OpenCodeTranscript } from "./transcript.ts";

export const OPENCODE_CAPABILITIES: AgentRuntimeCapabilities = {
	steer: false,
	followUp: false,
	compact: true,
	fork: false,
	rename: true,
	setModel: true,
	thinking: false,
	reload: false,
	images: true,
	piExtensions: false,
	// OpenCode has no per-session setting for this: Pier compacts after a turn that went past it.
	contextLimit: { min: MIN_CONTEXT_LIMIT, enforcement: "turn" },
};
const strict = { throwOnError: true } as const;
const nativeAllowed = ["read", "grep", "glob", "list", "todowrite", "question"];
/** Title of the throwaway sessions that predict the next prompt. */
const PREDICTION_TITLE = "Pier prompt suggestion";
/** Longest a prompt prediction may take before it is given up. */
const PREDICTION_TIMEOUT_MS = 60_000;

/** A `provider/model` reference from OpenCode's config (`small_model`). */
function modelRef(value: string | undefined): { providerID: string; modelID: string } | undefined {
	const slash = value?.indexOf("/") ?? -1;
	if (!value || slash <= 0 || slash === value.length - 1) return undefined;
	return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

/** Narrow native allows in their original order. Later exceptions, including denies, still win. */
function turnPermissions(rules: PermissionRuleset): PermissionRuleset {
	return rules.flatMap((rule) => {
		if (rule.action !== "allow" || nativeAllowed.includes(rule.permission)) return [rule];
		const ask = { ...rule, action: "ask" as const };
		return rule.permission === "*" ? [ask, ...nativeAllowed.map((permission) => ({ ...rule, permission }))] : [ask];
	});
}

export class OpenCodeSession extends ManagedSession {
	readonly runtimeId = "opencode";
	readonly capabilities = OPENCODE_CAPABILITIES;
	readonly sessionFile = undefined;
	readonly id: string;
	private model?: ModelInfo;
	private readonly transcript = new LiveTranscript(
		(event) => this.emit(event),
		() => ({ provider: this.model?.provider ?? "opencode", model: this.model?.id }),
	);
	private turn?: AbortController;
	private done?: Promise<void>;
	/** Tokens in the context after the latest reply, as OpenCode counts them for its own compaction. */
	private contextTokens = 0;
	/** The model of the latest reply, which `session.summarize` needs when none was picked. */
	private lastModel?: { providerID: string; modelID: string };

	constructor(
		options: ManagedSessionOptions,
		private readonly runtime: OpenCodeRuntime,
		private readonly native: Session,
		history: SessionMessagesResponse2,
	) {
		super(options);
		this.id = native.id;
		const lastUser = history.findLast((m) => m.info.role === "user")?.info;
		const selected = lastUser?.role === "user" ? lastUser.model : undefined;
		const id = selected?.modelID ?? native.model?.id;
		const provider = selected?.providerID ?? native.model?.providerID;
		if (id && provider) this.model = { id, provider, name: id, reasoning: false, input: ["text"] };
		new OpenCodeTranscript(this.transcript).history(history);
		const last = history.findLast((m) => m.info.role === "assistant")?.info;
		if (last?.role === "assistant") this.noteReply(last);
		this.acquireLock(`opencode-session:${this.id}`);
	}

	/** Record the context size and model of a finished reply. */
	private noteReply(info: AssistantMessage): void {
		this.lastModel = { providerID: info.providerID, modelID: info.modelID };
		// A compaction's summary read the whole conversation, which it then replaced.
		if (info.summary) {
			this.contextTokens = 0;
			return;
		}
		const tokens = contextTokensOf(info.tokens);
		if (tokens > 0) this.contextTokens = tokens;
	}

	private contextInfo(): SessionContextInfo {
		const window = this.model?.contextWindow;
		const limit = this.contextLimit;
		return this.withContextLimit({
			autoCompaction: limit === undefined ? "runtime" : "configured",
			...(window ? { contextWindow: window } : {}),
			...(limit !== undefined ? { compactionThreshold: window ? Math.min(limit, window) : limit } : {}),
		});
	}

	private get params() {
		return { directory: this.workspacePath, sessionID: this.id };
	}

	protected describe() {
		return {
			name: this.native.title,
			cwd: this.workspacePath,
			createdAt: new Date(this.native.time.created).toISOString(),
			messageCount: this.transcript.messages.filter((m) => m.role !== "toolResult").length,
			firstMessage: firstPromptOf(this.transcript.messages),
		};
	}

	protected content(): SessionContent {
		const t = this.transcript;
		return {
			messages: t.publicMessages(),
			...(t.streaming ? { streamingMessage: structuredClone(t.streaming) } : {}),
			pendingToolCalls: t.pendingToolCalls,
			thinkingLevel: "off",
			...(this.model ? { model: this.model } : {}),
			contextInfo: this.contextInfo(),
			...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
		};
	}

	async prompt(text: string, images?: ImageInput[], _behavior?: StreamingBehavior): Promise<void> {
		if (this.turn || this.compacting) throw new PierProtocolError("CONFLICT", "OpenCode is busy");
		const turn = new AbortController();
		this.turn = turn;
		const endTurn = this.runtime.beginTurn();
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
				endTurn();
				turn.abort();
				this.bridge.cancelAll();
				this.transcript.endRun();
				this.turn = undefined;
				this.lastActivity = Date.now();
				this.setRunState("idle");
				// OpenCode cannot be told the limit, so compact once a turn ended past it.
				if (completed && this.overLimit()) void this.compactNow("threshold").catch(() => {});
				else if (completed && !this.transcript.errorMessage) {
					this.suggestNext((signal) => this.predictNextPrompt(signal));
				}
			});
	}

	/**
	 * Predict the user's next prompt (1.76). OpenCode records every request in a session, so this
	 * asks a throwaway session outside the workspace (Pier lists only the workspace's sessions) with
	 * every tool denied, from the end of the conversation, using OpenCode's `small_model` (or the
	 * session's model), and deletes it afterwards.
	 */
	private async predictNextPrompt(signal: AbortSignal): Promise<string | undefined> {
		const prompt = excerptPrompt(this.excerpt());
		if (!prompt) return undefined;
		const endTurn = this.runtime.beginTurn();
		const directory = tmpdir();
		const options = { ...strict, signal: AbortSignal.any([signal, AbortSignal.timeout(PREDICTION_TIMEOUT_MS)]) };
		let client: OpencodeClient | undefined;
		let scratch: string | undefined;
		try {
			client = await this.runtime.server.client();
			const { data: config } = await client.config.get({ directory: this.workspacePath }, options);
			const model =
				modelRef(config.small_model) ??
				(this.model ? { providerID: this.model.provider, modelID: this.model.id } : this.lastModel);
			if (!model) return undefined;
			const { data: session } = await client.session.create(
				{ directory, title: PREDICTION_TITLE, permission: [{ permission: "*", pattern: "*", action: "deny" }] },
				options,
			);
			scratch = session.id;
			const { data: reply } = await client.session.prompt(
				{ directory, sessionID: scratch, model, tools: { "*": false }, parts: [{ type: "text", text: prompt }] },
				options,
			);
			if (reply.info.error) return undefined;
			return reply.parts.map((part) => (part.type === "text" && !part.synthetic ? part.text : "")).join("");
		} catch {
			// A failed prediction only means no suggestion this time.
			return undefined;
		} finally {
			endTurn();
			if (client && scratch) {
				await client.session
					.delete({ directory, sessionID: scratch }, { ...strict, signal: AbortSignal.timeout(5000) })
					.catch(() => {});
			}
		}
	}

	/** The conversation's prompts and replies as text, for {@link excerptPrompt}. */
	private excerpt(): ExcerptMessage[] {
		const messages: ExcerptMessage[] = [];
		for (const message of this.transcript.messages as Array<{ role?: string; content?: unknown }>) {
			if (message.role === "user") messages.push({ role: "user", text: textOf(message.content) });
			else if (message.role === "assistant") messages.push({ role: "assistant", text: replyText(message.content) });
		}
		return messages;
	}

	private overLimit(): boolean {
		return this.contextLimit !== undefined && this.contextTokens >= this.contextLimit;
	}

	/** A limit below the current context compacts right away when OpenCode is idle. */
	protected override applyContextLimit(): void {
		if (!this.turn && !this.compaction && this.overLimit()) void this.compactNow("threshold").catch(() => {});
	}

	// ---------------------------------------------------------------- compaction

	private compacting?: AbortController;
	private compaction?: Promise<{ summary: string; tokensBefore: number }>;

	override compact(_instructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		if (this.turn)
			return Promise.reject(new PierProtocolError("CONFLICT", "Wait for the agent to finish before compacting"));
		return this.compactNow("manual");
	}

	/**
	 * Summarize the conversation with OpenCode's own compaction (`session.summarize`, without
	 * continuing the conversation afterwards). OpenCode keeps the recent turns next to the summary.
	 */
	private compactNow(reason: "manual" | "threshold"): Promise<{ summary: string; tokensBefore: number }> {
		if (this.compaction) return this.compaction;
		const model = this.model ? { providerID: this.model.provider, modelID: this.model.id } : this.lastModel;
		if (!model) return Promise.reject(new PierProtocolError("CONFLICT", "Nothing to compact yet"));
		const abort = new AbortController();
		this.compacting = abort;
		const endTurn = this.runtime.beginTurn();
		const tokensBefore = this.contextTokens;
		this.emit({ type: "compaction_start", reason });
		this.setRunState("compacting");
		const compaction = (async () => {
			let failure: string | undefined;
			try {
				const client = await this.runtime.server.client();
				await client.session.summarize({ ...this.params, ...model, auto: false }, { ...strict, signal: abort.signal });
				this.contextTokens = 0;
				this.transcript.messages.push({
					role: "compactionSummary",
					summary: "",
					tokensBefore,
					timestamp: Date.now(),
				} as unknown as TranscriptMessage);
				return { summary: "", tokensBefore };
			} catch (error) {
				failure = abort.signal.aborted ? undefined : errorMessage(error);
				throw abort.signal.aborted
					? new PierProtocolError("CONFLICT", "Compaction was cancelled")
					: new PierProtocolError("CONFLICT", failure ?? "Compaction failed");
			} finally {
				endTurn();
				this.compacting = undefined;
				this.compaction = undefined;
				this.lastActivity = Date.now();
				this.emit({
					type: "compaction_end",
					reason,
					...(failure || abort.signal.aborted ? {} : { result: { summary: "", tokensBefore } }),
					aborted: abort.signal.aborted,
					willRetry: false,
					...(failure ? { errorMessage: failure } : {}),
				} as WireEvent);
				this.setRunState("idle");
			}
		})();
		this.compaction = compaction;
		return compaction;
	}

	private async run(text: string, images: ImageInput[], turn: AbortController): Promise<void> {
		const client = await this.runtime.server.client();
		const { directory } = this.params;
		const options = { ...strict, signal: turn.signal };
		const subscription = new AbortController();
		const { stream } = await client.event.subscribe(
			{ directory },
			{ ...options, signal: AbortSignal.any([turn.signal, subscription.signal]), sseMaxRetryAttempts: 1 },
		);
		let submitted = false;
		let restore: PermissionRuleset | undefined;
		try {
			// OpenCode sends server.connected when this workspace's subscription is ready.
			const first = await stream.next();
			if (first.done) throw new Error("OpenCode event stream unavailable");
			const { data: session } = await client.session.get(this.params, options);
			let agent = session.agent;
			if (this.options.workspace().policy !== "auto") {
				const [{ data: agents }, { data: config }] = await Promise.all([
					client.app.agents({ directory }, options),
					client.config.get({ directory }, options),
				]);
				const selected = agents.find((a) => a.name === (agent ?? config.default_agent ?? "build"));
				if (!selected) throw new Error("OpenCode default agent is unavailable");
				agent = selected.name;
				const rules = turnPermissions([...selected.permission, ...(session.permission ?? [])]);
				await client.session.update({ ...this.params, permission: rules }, strict);
				restore = session.permission ?? [];
			}
			turn.signal.throwIfAborted();
			const parts = [
				{ type: "text" as const, text },
				...images.map((im) => ({
					type: "file" as const,
					mime: im.mimeType,
					url: `data:${im.mimeType};base64,${im.data}`,
				})),
			];
			await client.session.promptAsync(
				{
					...this.params,
					parts,
					agent,
					...(this.model ? { model: { providerID: this.model.provider, modelID: this.model.id } } : {}),
				},
				strict,
			);
			submitted = true;
			turn.signal.throwIfAborted();
			const reducer = new OpenCodeTranscript(this.transcript, (info) => this.noteReply(info));
			const children = new Set<string>();
			for await (const event of stream) {
				if (
					event.type === "session.created" &&
					event.properties.info.parentID &&
					(event.properties.info.parentID === this.id || children.has(event.properties.info.parentID))
				) {
					children.add(event.properties.info.id);
				}
				if (
					event.type === "session.updated" &&
					event.properties.info.id === this.id &&
					event.properties.info.title !== this.native.title
				) {
					this.native.title = event.properties.info.title;
					this.emit({ type: "session_info_changed", name: this.native.title });
				}
				const owner =
					event.type === "message.updated"
						? event.properties.info.sessionID
						: event.type === "message.part.updated"
							? event.properties.part.sessionID
							: "sessionID" in event.properties
								? event.properties.sessionID
								: undefined;
				if (typeof owner !== "string" || (owner !== this.id && !children.has(owner))) continue;
				if (event.type === "permission.asked")
					await this.permission(
						client,
						event.properties,
						turn.signal,
						reducer.toolInput(event.properties.tool?.callID),
					);
				if (event.type === "question.asked") await this.question(client, event, turn.signal);
				if (owner !== this.id) continue;
				if (event.type === "session.error") throw new Error(errorText(event.properties.error) ?? "OpenCode stopped");
				if (
					event.type === "session.idle" ||
					(event.type === "session.status" && event.properties.status.type === "idle")
				) {
					submitted = false;
					return;
				}
				reducer.event(event);
			}
			if (!turn.signal.aborted) throw new Error("OpenCode event stream disconnected");
		} finally {
			subscription.abort();
			if (submitted)
				await client.session.abort(this.params, { ...strict, signal: AbortSignal.timeout(5000) }).catch(() => {});
			if (restore)
				await client.session.update(
					{ ...this.params, permission: restore },
					{ ...strict, signal: AbortSignal.timeout(5000) },
				);
			await stream.return();
		}
	}

	private async permission(
		client: OpencodeClient,
		request: PermissionRequest,
		signal: AbortSignal,
		toolInput?: Record<string, unknown>,
	) {
		const input = {
			...request.metadata,
			...toolInput,
			patterns: request.patterns,
			...(request.permission === "edit" && request.patterns.length === 1 ? { path: request.patterns[0] } : {}),
		};
		// Patterns can omit shell redirects or cover multiple paths. Only classify a complete operation.
		const toolName =
			(request.permission === "bash" && typeof (toolInput?.command ?? request.metadata.command) !== "string") ||
			(request.permission === "edit" && request.patterns.length !== 1) ||
			nativeAllowed.includes(request.permission)
				? `opencode.${request.permission}`
				: request.permission;
		const decision = await this.approveToolCall(
			{
				toolName,
				toolCallId: request.tool?.callID ?? request.id,
				input,
				runtimeAsked: { reason: `OpenCode: ${request.patterns.join(", ")}` },
			},
			signal,
		);
		signal.throwIfAborted();
		await client.permission.reply(
			{ directory: this.workspacePath, requestID: request.id, reply: decision.allowed ? "once" : "reject" },
			{ ...strict, signal },
		);
	}

	private async question(
		client: OpencodeClient,
		event: Extract<Event, { type: "question.asked" }>,
		signal: AbortSignal,
	) {
		const { id: requestID, questions } = event.properties;
		const params = { directory: this.workspacePath, requestID };
		const answers: string[][] = [];
		for (const q of questions) {
			const labels = q.options.map((o) => o.label);
			const response = await this.bridge.request(
				labels.length && !q.multiple && q.custom === false
					? { kind: "select", title: q.header, message: q.question, options: labels }
					: { kind: "input", title: q.header, message: [q.question, ...labels].join("\n") },
				{ signal },
			);
			signal.throwIfAborted();
			if (!response?.value || response.cancelled) {
				await client.question.reject(params, { ...strict, signal });
				return;
			}
			answers.push(
				q.multiple
					? response.value
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean)
					: [response.value],
			);
		}
		await client.question.reply({ ...params, answers }, { ...strict, signal });
	}

	async abort(): Promise<void> {
		this.turn?.abort();
		this.bridge.cancelAll();
		const compacting = this.compacting;
		if (compacting) {
			compacting.abort();
			const client = await this.runtime.server.client().catch(() => undefined);
			await client?.session.abort(this.params, { ...strict, signal: AbortSignal.timeout(5000) }).catch(() => {});
			await this.compaction?.catch(() => {});
		}
		await this.done;
	}
	protected disposeRuntime() {
		return this.abort();
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
	async rename(name: string) {
		const client = await this.runtime.server.client();
		await client.session.update({ ...this.params, title: name }, strict);
		this.native.title = name;
		this.emit({ type: "session_info_changed", name });
		return this.summary();
	}
	async setModel(provider: string, id: string): Promise<ModelInfo> {
		const model = (await this.runtime.listModels(this.workspacePath)).find(
			(m) => m.provider === provider && m.id === id,
		);
		if (!model) throw new PierProtocolError("NOT_FOUND", `Unknown OpenCode model ${provider}/${id}`);
		this.model = model;
		this.emit({ type: "session.model", model, contextInfo: this.contextInfo(), thinkingLevel: "off" });
		return model;
	}
	setThinking(level: ThinkingLevel) {
		if (level !== "off") throw this.unsupported("thinking levels");
		return level;
	}
}
