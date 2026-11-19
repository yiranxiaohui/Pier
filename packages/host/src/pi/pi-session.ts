import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { stripImageHints } from "@pier/chat-state";
import {
	type AgentRuntimeCapabilities,
	type ApprovalDetails,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type QueueState,
	type SessionCommandInfo,
	type SessionContextInfo,
	type SessionRunState,
	type SessionSummary,
	type StreamingBehavior,
	type ThinkingLevel,
} from "@pier/protocol";
import {
	errorMessage,
	ManagedSession,
	type ManagedSessionOptions,
	MIN_CONTEXT_LIMIT,
	type SessionContent,
	type SessionDescription,
	textOf,
} from "../managed-session.ts";
import type { TranscriptMessage } from "../runtimes/live-transcript.ts";
import type { SubagentRuntimeHooks } from "../runtimes/subagents.ts";
import { ExternalChangeGuard } from "../session-lock.ts";
import { createApprovalExtension } from "./approval-extension.ts";
import type { PiEnvironment } from "./environment.ts";
import { toWireEvent } from "./events.ts";
import { PI_SUBAGENT_TOOL, piSubagentUpdates, storedPiSubagents } from "./subagents.ts";
import { createUiContext } from "./ui-context.ts";

/** pi's thinking level when neither the model nor the settings name one. */
const DEFAULT_THINKING_LEVEL = "medium";

export const PI_CAPABILITIES: AgentRuntimeCapabilities = {
	steer: true,
	followUp: true,
	compact: true,
	fork: true,
	rename: true,
	setModel: true,
	thinking: true,
	reload: true,
	images: true,
	piExtensions: true,
	contextLimit: { min: MIN_CONTEXT_LIMIT, enforcement: "request" },
};

/** pi's API id of virtual models, which route each request to another (physical) model. */
const VIRTUAL_MODEL_API = "pi-virtual";

/**
 * `model` as the session uses it under a context limit: with the limit as its context window, so
 * pi compacts (before each request and after each turn), detects overflow and sizes replies
 * against it. Virtual models are left alone: pi checks the physical model of each request.
 */
function limitWindow(model: Model<Api> | undefined, limit: number | undefined): Model<Api> | undefined {
	if (!model || limit === undefined || model.api === VIRTUAL_MODEL_API) return model;
	const window = model.contextWindow;
	if (typeof window === "number" && window > 0 && window <= limit) return model;
	return { ...model, contextWindow: limit };
}

export interface PiSessionOptions extends ManagedSessionOptions {
	env: PiEnvironment;
}

/** pi events that indicate the session file may have been written by this host. */
const WRITE_EVENTS = new Set([
	"entry_appended",
	"message_end",
	"agent_settled",
	"compaction_end",
	"session_info_changed",
	"thinking_level_changed",
]);

function toImages(images: ImageInput[] | undefined) {
	return images?.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

/** A pi session: owns the pi runtime and forwards its events verbatim. */
export class PiManagedSession extends ManagedSession {
	readonly runtimeId = "pi";
	readonly capabilities = PI_CAPABILITIES;
	private runtime!: AgentSessionRuntime;
	private unsubscribePi: (() => void) | undefined;
	private guard = new ExternalChangeGuard(undefined);
	private boundSessionId: string | undefined;
	/** pi session file of each `pi-subagents` child, for its conversation. */
	private readonly subagentFiles = new Map<string, string>();
	/** The session's model as pi resolved it, before the context limit (see {@link limitModel}). */
	private rawModel: (() => Model<Api> | undefined) | undefined;
	/** The raw model of each agent state that follows the limit. */
	private readonly limitedStates = new WeakMap<object, () => Model<Api> | undefined>();

	private constructor(private readonly piOptions: PiSessionOptions) {
		super(piOptions);
	}

	static async start(
		options: PiSessionOptions,
		sessionManager: ReturnType<PiEnvironment["newSessionManager"]>,
	): Promise<PiManagedSession> {
		const managed = new PiManagedSession(options);
		const file = sessionManager.getSessionFile();
		if (file) managed.acquireLock(file);
		try {
			managed.runtime = await options.env.createRuntime({
				cwd: options.workspace().path,
				sessionManager,
				extensions: () => [createApprovalExtension(managed.approvalGate())],
			});
			managed.runtime.setRebindSession(async () => managed.bind());
			await managed.bind();
		} catch (error) {
			managed.releaseLock();
			throw error;
		}
		return managed;
	}

	private approvalGate() {
		return {
			policy: () => this.options.workspace().policy,
			workspacePath: () => this.options.workspace().path,
			allowances: this.allowances,
			requestApproval: async (details: ApprovalDetails, signal: AbortSignal | undefined) =>
				this.bridge.request(
					{ kind: "approval", title: `Allow ${details.toolName}?`, message: details.reason, approval: details },
					signal ? { signal } : {},
				),
		};
	}

	/** The session's model without the context limit. */
	private realModel(): Model<Api> | undefined {
		return this.rawModel ? this.rawModel() : this.runtime.session.model;
	}

	private contextInfo(model = this.realModel()): SessionContextInfo {
		const settings = this.runtime.session.settingsManager.getCompactionSettings(model);
		const contextWindow =
			typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
		const limited = limitWindow(model, this.contextLimit)?.contextWindow;
		const window = typeof limited === "number" && limited > 0 ? limited : undefined;
		return this.withContextLimit({
			autoCompaction: settings.enabled ? "configured" : "disabled",
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(settings.enabled && window !== undefined
				? { compactionThreshold: Math.max(0, window - settings.reserveTokens) }
				: {}),
			reserveTokens: settings.reserveTokens,
			keepRecentTokens: settings.keepRecentTokens,
		});
	}

	/**
	 * Make the session's model follow the context limit, however it is chosen (Pier, pi's own model
	 * refresh, extensions): pi reads `agent.state.model` for every compaction check and request, so
	 * reading it yields the model with the limit as its window, while writing it records the model
	 * pi picked. The limit is read on each access, so changing it applies to the next request.
	 */
	private limitModel(session: AgentSession): void {
		const state = session.agent.state as { model: Model<Api> | undefined };
		// Bound again (pi rebinding the same session): the state already follows the limit.
		const known = this.limitedStates.get(state);
		if (known) {
			this.rawModel = known;
			return;
		}
		let raw = state.model;
		let last: { raw: Model<Api> | undefined; limit: number | undefined; model: Model<Api> | undefined } | undefined;
		try {
			Object.defineProperty(state, "model", {
				configurable: true,
				enumerable: true,
				get: () => {
					const limit = this.contextLimit;
					// The same object while nothing changed: pi's model refresh compares models by identity.
					if (!last || last.raw !== raw || last.limit !== limit) last = { raw, limit, model: limitWindow(raw, limit) };
					return last.model;
				},
				set: (model: Model<Api> | undefined) => {
					raw = model;
				},
			});
			this.rawModel = () => raw;
			this.limitedStates.set(state, this.rawModel);
		} catch (error) {
			this.rawModel = undefined;
			this.bridge.notify(
				`Pier could not apply the context limit to this pi session: ${errorMessage(error)}`,
				"warning",
			);
		}
	}

	get session(): AgentSession {
		return this.runtime.session;
	}

	get id(): string {
		return this.runtime.session.sessionId;
	}

	get sessionFile(): string | undefined {
		return this.runtime.session.sessionFile;
	}

	/** (Re)bind extensions and event subscriptions to the runtime's current AgentSession. */
	private async bind(): Promise<void> {
		const session = this.runtime.session;
		const previousId = this.boundSessionId;
		const replaced = previousId !== undefined && previousId !== session.sessionId;
		this.unsubscribePi?.();

		if (replaced) {
			this.bridge.cancelAll();
			this.allowances.clear();
			this.emit({ type: "session.replaced", previousSessionId: previousId, session: this.summary() }, previousId);
			this.releaseLock();
			this.acquireLock(session.sessionFile);
			this.resetLog();
		}
		if (replaced || previousId === undefined) this.loadSubagents(session);
		this.boundSessionId = session.sessionId;
		this.limitModel(session);
		this.guard.setPath(session.sessionFile);

		await session.bindExtensions({
			uiContext: createUiContext(this.bridge, this.piOptions.env.sdk().agent.initTheme),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (opts) => this.runtime.newSession(opts),
				fork: async (entryId, opts) => ({ cancelled: (await this.runtime.fork(entryId, opts)).cancelled }),
				navigateTree: async (targetId, opts) => ({
					cancelled: (await session.navigateTree(targetId, opts ?? {})).cancelled,
				}),
				switchSession: (path, opts) => this.runtime.switchSession(path, opts),
				reload: () => session.reload(),
			},
			shutdownHandler: () => {
				this.bridge.notify("An extension requested shutdown; Pier keeps the host running.", "warning");
			},
			onError: (error) => {
				this.emit({
					type: "extension.error",
					extensionPath: error.extensionPath,
					event: error.event,
					error: error.error,
				});
			},
		});
		this.unsubscribePi = session.subscribe((event) => this.handlePiEvent(event));
		this.updateRunState();

		if (replaced && previousId !== undefined) {
			this.options.onReplaced?.(this, previousId);
			this.sendSnapshotToAll();
		}
	}

	private handlePiEvent(event: AgentSessionEvent): void {
		this.lastActivity = Date.now();
		const wire = toWireEvent(event);
		if (wire) this.emit(wire);
		if (event.type === "tool_execution_update" || event.type === "tool_execution_end") this.trackSubagents(event);
		if (WRITE_EVENTS.has(event.type)) this.guard.record();
		this.updateRunState();
	}

	/** Subagents recorded in the session's stored `subagent` tool results. */
	private loadSubagents(session: AgentSession): void {
		this.subagentFiles.clear();
		const stored = storedPiSubagents(session.messages);
		this.subagents.load(stored.map((s) => s.info));
		for (const { info, sessionFile } of stored) if (sessionFile) this.subagentFiles.set(info.id, sessionFile);
	}

	/** Follow the children of a `pi-subagents` `subagent` tool call through its results. */
	private trackSubagents(event: Extract<AgentSessionEvent, { type: "tool_execution_update" | "tool_execution_end" }>) {
		if (event.toolName !== PI_SUBAGENT_TOOL) return;
		const final = event.type === "tool_execution_end";
		const result = (final ? event.result : event.partialResult) as { details?: unknown } | undefined;
		const updates = piSubagentUpdates(event.toolCallId, result?.details, final);
		for (const { id, patch, sessionFile } of updates) {
			if (sessionFile) this.subagentFiles.set(id, sessionFile);
			const known = this.subagents.get(id);
			const startedAt = known?.startedAt ?? Date.now() - (patch.durationMs ?? 0);
			const { durationMs: _duration, ...rest } = patch;
			const changed = !known || known.steps !== rest.steps || known.status !== rest.status;
			this.subagents.update(id, { ...rest, startedAt }, { changed });
		}
		if (final) {
			for (const subagent of this.subagents.forToolCall(event.toolCallId)) {
				if (subagent.status === "running") this.subagents.finish(subagent.id, event.isError ? "failed" : "stopped");
			}
		}
	}

	protected override subagentHooks(): SubagentRuntimeHooks {
		return {
			load: async (subagent) => {
				const file = this.subagentFiles.get(subagent.id);
				if (!file) return undefined;
				const manager = this.piOptions.env.readSessionFile(file);
				return manager.buildSessionContext().messages as unknown as TranscriptMessage[];
			},
		};
	}

	private computeRunState(): SessionRunState {
		const session = this.runtime.session;
		if (session.isCompacting) return "compacting";
		if (session.isRetrying) return "retrying";
		if (!session.isIdle) return "streaming";
		return "idle";
	}

	private updateRunState(): void {
		this.setRunState(this.computeRunState());
	}

	protected describe(): SessionDescription {
		const session = this.runtime.session;
		const manager = session.sessionManager;
		const header = manager.getHeader();
		const messages = session.messages.filter((m) => m.role === "user" || m.role === "assistant");
		const firstUser = session.messages.find((m) => m.role === "user") as { content?: unknown } | undefined;
		return {
			...(session.sessionFile ? { path: session.sessionFile } : {}),
			...(session.sessionName ? { name: session.sessionName } : {}),
			cwd: manager.getCwd(),
			createdAt: header?.timestamp ?? new Date().toISOString(),
			messageCount: messages.length,
			firstMessage: firstUser ? stripImageHints(textOf(firstUser.content)).slice(0, 200) : "",
			...(header?.parentSession ? { parentSessionPath: header.parentSession } : {}),
		};
	}

	protected content(): SessionContent {
		const session = this.runtime.session;
		const state = session.state;
		const model = this.realModel();
		return {
			messages: [...session.messages],
			...(state.streamingMessage ? { streamingMessage: state.streamingMessage } : {}),
			pendingToolCalls: [...state.pendingToolCalls],
			...(model ? { model: this.piOptions.env.modelInfo(model) } : {}),
			contextInfo: this.contextInfo(model),
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
		};
	}

	queue(): QueueState {
		const session = this.runtime.session;
		return { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] };
	}

	private assertWritable(): void {
		if (this.runtime.session.isIdle && this.guard.changedExternally()) {
			throw new PierProtocolError(
				"CONFLICT",
				"The session file was modified outside Pier (for example by the pi CLI). Close and reopen the session to continue.",
			);
		}
	}

	prompt(text: string, images?: ImageInput[], streamingBehavior?: StreamingBehavior): Promise<void> {
		this.assertWritable();
		this.lastActivity = Date.now();
		const session = this.runtime.session;
		if (!session.isIdle && !streamingBehavior) {
			return Promise.reject(
				new PierProtocolError("CONFLICT", "Session is busy; pass streamingBehavior `steer` or `followUp`"),
			);
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			// Extension commands may wait for UI answers from any client, so accept them right away
			// instead of holding the request until the handler returns.
			if (this.isExtensionCommand(text)) {
				settled = true;
				resolve();
			}
			session
				.prompt(text, {
					...(images ? { images: toImages(images) } : {}),
					...(streamingBehavior ? { streamingBehavior } : {}),
					source: "rpc",
					preflightResult: (ok) => {
						if (ok && !settled) {
							settled = true;
							resolve();
						}
					},
				})
				.then(() => {
					// Extension commands and queued prompts may finish without a preflight callback.
					if (!settled) {
						settled = true;
						resolve();
					}
				})
				.catch((error: unknown) => {
					if (!settled) {
						settled = true;
						reject(new PierProtocolError("CONFLICT", errorMessage(error)));
					} else {
						this.emit({ type: "ui.notify", level: "error", message: `Prompt failed: ${errorMessage(error)}` });
					}
				});
		});
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(1) : text.slice(1, space);
		return name.length > 0 && this.runtime.session.extensionRunner.getCommand(name) !== undefined;
	}

	async steer(text: string, images?: ImageInput[]): Promise<QueueState> {
		this.lastActivity = Date.now();
		await this.runtime.session.steer(text, toImages(images), { source: "rpc" });
		return this.queue();
	}

	async followUp(text: string, images?: ImageInput[]): Promise<QueueState> {
		this.lastActivity = Date.now();
		await this.runtime.session.followUp(text, toImages(images), { source: "rpc" });
		return this.queue();
	}

	async abort(): Promise<void> {
		this.lastActivity = Date.now();
		await this.runtime.session.abort();
	}

	override async compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		this.assertWritable();
		this.lastActivity = Date.now();
		const result = await this.runtime.session.compact(instructions);
		this.guard.record();
		return { summary: result.summary, tokensBefore: result.tokensBefore };
	}

	rename(name: string): SessionSummary {
		this.assertWritable();
		this.runtime.session.setSessionName(name);
		this.guard.record();
		return this.summary();
	}

	async setModel(provider: string, modelId: string, persist: boolean): Promise<ModelInfo> {
		const model = this.piOptions.env.modelRuntime.getModel(provider, modelId);
		if (!model) throw new PierProtocolError("NOT_FOUND", `Unknown model ${provider}/${modelId}`);
		this.assertWritable();
		await this.runtime.session.setModel(model, { persist });
		this.guard.record();
		const info = this.piOptions.env.modelInfo(model);
		this.emit({
			type: "session.model",
			model: info,
			contextInfo: this.contextInfo(),
			thinkingLevel: this.runtime.session.thinkingLevel,
		});
		return info;
	}

	/**
	 * Re-resolve the current model after models.json or a provider catalog changed, so edited
	 * capabilities (such as reasoning) apply without selecting the model again. A model that just
	 * became a reasoning model gets the configured default thinking level instead of `off`.
	 */
	override refreshModel(): void {
		const session = this.runtime.session;
		const current = this.realModel();
		if (!current) return;
		const refreshed = this.piOptions.env.modelRuntime.getModel(current.provider, current.id);
		if (!refreshed || refreshed === current) return;
		const before = JSON.stringify(this.piOptions.env.modelInfo(current));
		const levelBefore = session.thinkingLevel;
		session.agent.state.model = refreshed;
		if (
			!current.reasoning &&
			refreshed.reasoning &&
			session.thinkingLevel === "off" &&
			session.isIdle &&
			!this.guard.changedExternally()
		) {
			const settings = session.settingsManager;
			const level =
				settings.getModelThinkingLevel(refreshed.provider, refreshed.id) ??
				settings.getDefaultThinkingLevel() ??
				DEFAULT_THINKING_LEVEL;
			if (level !== "off") {
				session.setThinkingLevel(level);
				this.guard.record();
			}
		}
		const info = this.piOptions.env.modelInfo(refreshed);
		if (JSON.stringify(info) === before && session.thinkingLevel === levelBefore) return;
		this.emit({
			type: "session.model",
			model: info,
			contextInfo: this.contextInfo(),
			thinkingLevel: session.thinkingLevel,
		});
	}

	setThinking(level: ThinkingLevel, persist: boolean): string {
		this.assertWritable();
		// pi has no Ultra mode; its SDK clamps the highest supported effort to the model.
		this.runtime.session.setThinkingLevel(level === "ultra" ? "max" : level, { persist });
		this.guard.record();
		return this.runtime.session.thinkingLevel;
	}

	/** Slash commands pi handles in `prompt()`: extension commands, prompt templates, and skills. */
	override commands(): SessionCommandInfo[] {
		const session = this.runtime.session;
		const commands: SessionCommandInfo[] = [];
		for (const command of session.extensionRunner.getRegisteredCommands()) {
			commands.push({
				name: command.invocationName,
				...(command.description ? { description: command.description } : {}),
				source: "extension",
			});
		}
		for (const template of session.promptTemplates) {
			commands.push({
				name: template.name,
				...(template.description ? { description: template.description } : {}),
				...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
				source: "prompt",
			});
		}
		// Like pi's interactive mode, `enableSkillCommands: false` hides skills from discovery;
		// a typed `/skill:name` still works.
		if (session.settingsManager.getEnableSkillCommands()) {
			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					...(skill.description ? { description: skill.description } : {}),
					source: "skill",
				});
			}
		}
		return commands;
	}

	/** Reload settings, extensions, skills, prompt templates, themes, and context files. */
	override async reload(): Promise<void> {
		this.lastActivity = Date.now();
		if (this.busy) throw new PierProtocolError("CONFLICT", "Wait for the agent to finish before reloading");
		await this.runtime.session.reload();
	}

	override forkPoints(): Array<{ entryId: string; text: string }> {
		return this.runtime.session.getUserMessagesForForking();
	}

	protected async disposeRuntime(): Promise<void> {
		this.unsubscribePi?.();
		await this.runtime.dispose();
	}
}
