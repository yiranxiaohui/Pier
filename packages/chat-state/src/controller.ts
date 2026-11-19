import type { PierClient, Subscription } from "@pier/client";
import type {
	EventFrame,
	ImageInput,
	SessionCommandInfo,
	SessionContextInfo,
	SessionSummary,
	ThinkingLevel,
	UiResponse,
} from "@pier/protocol";
import { knownMessages } from "@pier/protocol";
import { applySnapshot, type ChatState, clearResync, dismissNotice, initialChatState, reduceChat } from "./reducer.ts";
import { mergeCommands, type SlashCommand } from "./slash.ts";

/** Slash commands of a session, and whether the host could list its own (older hosts cannot). */
export interface CommandList {
	commands: SlashCommand[];
	known: boolean;
}

export interface ChatView {
	chat: ChatState;
	/** Failure to open or subscribe to the session. */
	error?: string;
}

export interface ChatHooks {
	onReplaced(previousId: string, session: SessionSummary): void;
	onSettled(controller: ChatController): void;
	onChange(controller: ChatController): void;
	onError(message: string): void;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The host's answer for a session it does not have open (closed, evicted, or the host restarted). */
function sessionNotOpen(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as { code?: unknown }).code === "NOT_FOUND" &&
		/^Session \S+ is not open$/.test(error.message)
	);
}

/** One subscribed session: its reduced state plus the actions the UI can take on it. */
export class ChatController {
	private view: ChatView;
	private readonly listeners = new Set<() => void>();
	private sub: Subscription | undefined;
	private disposed = false;
	private hostCommands: SessionCommandInfo[] = [];
	private commandsKnown = false;
	private commandsLoading: Promise<CommandList> | undefined;
	private starting: Promise<void> | undefined;
	private recovering: Promise<boolean> | undefined;
	readonly workspaceId: string;

	constructor(
		private readonly client: PierClient,
		session: SessionSummary,
		private readonly hooks: ChatHooks,
		/** State kept from an earlier visit (`cacheableChatState`): shown at once and resumed from. */
		cached?: ChatState,
	) {
		this.workspaceId = session.workspaceId;
		this.view = {
			chat: cached?.sessionId === session.id && cached.loaded ? cached : initialChatState(session.id, session),
		};
	}

	get sessionId(): string {
		return this.view.chat.sessionId;
	}

	get chat(): ChatState {
		return this.view.chat;
	}

	getView = (): ChatView => this.view;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private update(view: ChatView): void {
		if (this.disposed) return;
		this.view = view;
		for (const listener of [...this.listeners]) listener();
		this.hooks.onChange(this);
	}

	/** Open the session on the host and follow its events (once; again only after it failed). */
	start(): Promise<void> {
		if (!this.starting) {
			const starting = this.follow().finally(() => {
				if (!this.sub && this.starting === starting) this.starting = undefined;
			});
			this.starting = starting;
		}
		return this.starting;
	}

	private async follow(): Promise<void> {
		try {
			// Load the session into the host's active pool (no-op when it is already there). Newer hosts
			// do that when subscribing with the workspace, which saves a round trip.
			if (!this.client.subscribeOpensSessions) {
				await this.client.request("session.open", { workspaceId: this.workspaceId, sessionId: this.sessionId });
			}
			const chat = this.view.chat;
			const sub = await this.client.subscribe(this.sessionId, (frame) => this.onFrame(frame), {
				workspaceId: this.workspaceId,
				// Only the events since the cached state when the host still has them, otherwise a
				// snapshot without the transcript prefix this device already has.
				...(chat.loaded && chat.epoch ? { resume: { seq: chat.seq, epoch: chat.epoch } } : {}),
				known: () => (this.view.chat.loaded ? knownMessages(this.view.chat.messages) : undefined),
			});
			if (this.disposed) await sub.unsubscribe();
			else this.sub = sub;
		} catch (error) {
			this.update({ ...this.view, error: message(error) });
		}
	}

	private onFrame(frame: EventFrame): void {
		const previousId = this.view.chat.sessionId;
		let chat = reduceChat(this.view.chat, frame);
		if (chat === this.view.chat) return;
		if (frame.event.type === "session.replaced") {
			this.hostCommands = [];
			this.commandsKnown = false;
			this.commandsLoading = undefined;
			this.hooks.onReplaced(previousId, frame.event.session as SessionSummary);
		}
		if (chat.needsResync) {
			chat = clearResync(chat);
			void this.resync();
		}
		const { error: _e, ...rest } = this.view;
		this.update({ ...rest, chat });
		if (frame.event.type === "agent_settled") this.hooks.onSettled(this);
	}

	private async resync(): Promise<void> {
		try {
			const snapshot = await this.client.request("session.snapshot", { sessionId: this.sessionId });
			this.update({ ...this.view, chat: applySnapshot(this.view.chat, snapshot) });
		} catch (error) {
			if (sessionNotOpen(error)) void this.recover();
			else this.hooks.onError(`刷新会话失败：${message(error)}`);
		}
	}

	/**
	 * Follow the session again, for when its events stopped although the connection stayed up:
	 * the view may then still show a run that already ended, which the host may even have closed
	 * since. The host resends what this view missed (or a snapshot) and reopens a session it
	 * closed. Resolves to whether that worked; never rejects.
	 */
	recover(): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (!this.recovering) {
			this.recovering = this.refollow().finally(() => {
				this.recovering = undefined;
			});
		}
		return this.recovering;
	}

	private async refollow(): Promise<boolean> {
		try {
			const sub = this.sub;
			if (sub && (await sub.resubscribe())) return true;
			if (this.disposed) return false;
			// Not following the session (yet, or no longer since the host closed it): start over.
			if (sub && this.sub === sub) {
				this.sub = undefined;
				this.starting = undefined;
				void sub.unsubscribe();
			}
			await this.start();
			return this.sub !== undefined;
		} catch (error) {
			this.update({ ...this.view, error: message(error) });
			return false;
		}
	}

	/**
	 * Run an action on the session and report a failure. When the host answers that the session is
	 * not open, this view missed the end of it: follow it again and `retry` once (the host reopened
	 * the session, so it is idle now).
	 */
	private async run<T>(
		action: string,
		fn: () => Promise<T>,
		retry: (() => Promise<T>) | null = fn,
	): Promise<T | undefined> {
		try {
			return await fn();
		} catch (error) {
			let failure = error;
			if (sessionNotOpen(error) && (await this.recover()) && retry) {
				try {
					return await retry();
				} catch (retryError) {
					failure = retryError;
				}
			}
			this.hooks.onError(`${action}失败：${message(failure)}`);
			return undefined;
		}
	}

	/** Send a message; while the agent runs it steers (or queues a follow-up). */
	send(text: string, images: ImageInput[], mode: "auto" | "steer" | "followUp" = "auto"): Promise<unknown> {
		const sessionId = this.sessionId;
		const idle = this.chat.runState === "idle" || this.chat.runState === "inactive";
		const imageParam = images.length ? { images } : {};
		// A session the host had closed reopens idle, so a retried message starts a run.
		const prompt = () => this.client.request("session.prompt", { sessionId, text, ...imageParam });
		if (mode === "auto" && idle) return this.run("发送", prompt);
		if (mode === "followUp") {
			return this.run<unknown>(
				"排队",
				() => this.client.request("session.followUp", { sessionId, text, ...imageParam }),
				prompt,
			);
		}
		return this.run<unknown>(
			"引导",
			() => this.client.request("session.steer", { sessionId, text, ...imageParam }),
			prompt,
		);
	}

	/**
	 * Send a slash command the agent runtime handles (extension command, prompt template, skill).
	 * Unlike `send`, it goes through `session.prompt` while the agent runs too, because pi only
	 * runs extension commands from a prompt.
	 */
	sendCommand(text: string, images: ImageInput[], mode: "auto" | "steer" | "followUp" = "auto"): Promise<unknown> {
		const sessionId = this.sessionId;
		const idle = this.chat.runState === "idle" || this.chat.runState === "inactive";
		const streamingBehavior =
			idle && mode === "auto" ? {} : ({ streamingBehavior: mode === "followUp" ? "followUp" : "steer" } as const);
		const prompt = (behavior: { streamingBehavior?: "steer" | "followUp" }) => () =>
			this.client.request("session.prompt", {
				sessionId,
				text,
				...(images.length ? { images } : {}),
				...behavior,
			});
		// A session the host had closed reopens idle: retry without a streaming behavior.
		return this.run("发送命令", prompt(streamingBehavior), prompt({}));
	}

	/** Last known slash commands (built-ins until `loadCommands` finished). */
	get commands(): CommandList {
		return {
			commands: mergeCommands(this.hostCommands, this.chat.capabilities, this.chat.session?.runtime),
			known: this.commandsKnown,
		};
	}

	/** Fetch the host's slash commands for this session. Never rejects. */
	loadCommands(): Promise<CommandList> {
		if (this.commandsLoading) return this.commandsLoading;
		const sessionId = this.sessionId;
		const loading = this.client
			.request("session.commands", { sessionId })
			.then((result) => {
				if (this.sessionId !== sessionId) return;
				this.hostCommands = result.commands;
				this.commandsKnown = true;
			})
			.catch(() => {
				if (this.sessionId !== sessionId) return;
				this.hostCommands = [];
				this.commandsKnown = false;
			})
			.then(() => this.commands)
			.finally(() => {
				if (this.commandsLoading === loading) this.commandsLoading = undefined;
			});
		this.commandsLoading = loading;
		return loading;
	}

	rename(name: string): Promise<unknown> {
		return this.run("重命名", () => this.client.request("session.rename", { sessionId: this.sessionId, name }));
	}

	reload(): Promise<unknown> {
		return this.run("重新加载", async () => {
			const result = await this.client.request("session.reload", { sessionId: this.sessionId });
			this.commandsLoading = undefined;
			await this.loadCommands();
			return result;
		});
	}

	/** Stop the run. A session the host had already closed is reopened (idle), so nothing is left running. */
	abort(): Promise<unknown> {
		return this.run("中止", () => this.client.request("session.abort", { sessionId: this.sessionId }));
	}

	compact(instructions?: string): Promise<unknown> {
		return this.run("压缩上下文", () =>
			this.client.request(
				"session.compact",
				{ sessionId: this.sessionId, ...(instructions ? { instructions } : {}) },
				{ timeoutMs: 15 * 60_000 },
			),
		);
	}

	respond(requestId: string, response: UiResponse): Promise<unknown> {
		// A reopened session no longer has the request: nothing to retry.
		return this.run(
			"回复",
			() => this.client.request("ui.respond", { sessionId: this.sessionId, requestId, response }),
			null,
		);
	}

	listModels() {
		return this.client.request("model.list", { sessionId: this.sessionId });
	}

	setModel(provider: string, modelId: string, persist = false): Promise<unknown> {
		return this.run("切换模型", () =>
			this.client.request("model.set", { sessionId: this.sessionId, provider, modelId, persist }),
		);
	}

	setThinking(level: ThinkingLevel, persist = false): Promise<unknown> {
		return this.run("设置思考等级", async () => {
			const result = await this.client.request("thinking.set", { sessionId: this.sessionId, level, persist });
			this.update({ ...this.view, chat: { ...this.view.chat, thinkingLevel: result.level } });
			return result;
		});
	}

	setFast(enabled?: boolean): Promise<{ enabled: boolean } | undefined> {
		const sessionId = this.sessionId;
		return this.run("设置 Fast 模式", async () => {
			const result = await this.client.request("fast.set", {
				sessionId,
				...(enabled !== undefined ? { enabled } : {}),
			});
			if (this.sessionId === sessionId) {
				this.update({ ...this.view, chat: { ...this.view.chat, fastMode: result.enabled } });
			}
			return result;
		});
	}

	forkPoints() {
		return this.client.request("session.forkPoints", { sessionId: this.sessionId });
	}

	/**
	 * Limit the session's context (1.64): the agent compacts before the context grows past `limit`
	 * tokens; `null` follows the model's window. `asDefault` also applies it to new sessions of the
	 * same agent. Resolves to the host's answer, or undefined after reporting a failure.
	 */
	setContextLimit(
		limit: number | null,
		asDefault = false,
	): Promise<{ contextInfo: SessionContextInfo; defaultLimit?: number } | undefined> {
		const sessionId = this.sessionId;
		return this.run("设置上下文上限", async () => {
			const result = await this.client.request("contextLimit.set", {
				sessionId,
				limit,
				...(asDefault ? { asDefault } : {}),
			});
			if (this.sessionId === sessionId) {
				this.update({ ...this.view, chat: { ...this.view.chat, contextInfo: result.contextInfo } });
			}
			return result;
		});
	}

	/** A subagent's conversation from message `from` on (1.54). */
	subagentTranscript(subagentId: string, from = 0) {
		return this.client.request("session.subagentTranscript", { sessionId: this.sessionId, subagentId, from });
	}

	/** Stop one running subagent, or all of them without `subagentId` (1.54). */
	stopSubagent(subagentId?: string): Promise<unknown> {
		// A reopened session runs no subagents: nothing to retry.
		return this.run(
			"停止 Subagent",
			() =>
				this.client.request("session.subagentStop", {
					sessionId: this.sessionId,
					...(subagentId !== undefined ? { subagentId } : {}),
				}),
			null,
		);
	}

	dismissNotice(id: number): void {
		this.update({ ...this.view, chat: dismissNotice(this.view.chat, id) });
	}

	get busy(): boolean {
		const state = this.chat.runState;
		return state === "streaming" || state === "compacting" || state === "retrying" || this.chat.pendingUi.length > 0;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		void this.sub?.unsubscribe();
	}
}
