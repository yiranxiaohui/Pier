import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { stripImageHints } from "@pier/chat-state";
import {
	type AgentRuntimeCapabilities,
	type ApprovalDetails,
	type BrowserCommand,
	type BrowserResult,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type QueueState,
	type SessionCommandInfo,
	type SessionRunState,
	type SessionSummary,
	type StreamingBehavior,
	type ThinkingLevel,
} from "@pier/protocol";
import {
	errorMessage,
	ManagedSession,
	type ManagedSessionOptions,
	type SessionContent,
	type SessionDescription,
	textOf,
} from "../managed-session.ts";
import { ExternalChangeGuard } from "../session-lock.ts";
import { createApprovalExtension } from "./approval-extension.ts";
import { createBrowserExtension } from "./browser-extension.ts";
import { type PiEnvironment, toModelInfo } from "./environment.ts";
import { toWireEvent } from "./events.ts";
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
};

export interface PiSessionOptions extends ManagedSessionOptions {
	env: PiEnvironment;
	browserAction?: (command: BrowserCommand, browserId?: string, signal?: AbortSignal) => Promise<BrowserResult>;
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
				extensions: () => [
					createApprovalExtension(managed.approvalGate()),
					...(options.browserAction ? [createBrowserExtension(options.browserAction)] : []),
				],
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
		this.boundSessionId = session.sessionId;
		this.guard.setPath(session.sessionFile);

		await session.bindExtensions({
			uiContext: createUiContext(this.bridge),
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
		if (WRITE_EVENTS.has(event.type)) this.guard.record();
		this.updateRunState();
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
		const model = session.model;
		return {
			messages: [...session.messages],
			...(state.streamingMessage ? { streamingMessage: state.streamingMessage } : {}),
			pendingToolCalls: [...state.pendingToolCalls],
			...(model ? { model: toModelInfo(model) } : {}),
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
		const info = toModelInfo(model);
		this.emit({ type: "session.model", model: info, thinkingLevel: this.runtime.session.thinkingLevel });
		return info;
	}

	/**
	 * Re-resolve the current model after models.json or a provider catalog changed, so edited
	 * capabilities (such as reasoning) apply without selecting the model again. A model that just
	 * became a reasoning model gets the configured default thinking level instead of `off`.
	 */
	override refreshModel(): void {
		const session = this.runtime.session;
		const current = session.model;
		if (!current) return;
		const refreshed = this.piOptions.env.modelRuntime.getModel(current.provider, current.id);
		if (!refreshed || refreshed === current) return;
		const before = JSON.stringify(toModelInfo(current));
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
		const info = toModelInfo(refreshed);
		if (JSON.stringify(info) === before && session.thinkingLevel === levelBefore) return;
		this.emit({ type: "session.model", model: info, thinkingLevel: session.thinkingLevel });
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
