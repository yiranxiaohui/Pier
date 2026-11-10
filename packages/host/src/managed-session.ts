import {
	type AgentRuntimeCapabilities,
	type AgentRuntimeId,
	type EventFrame,
	type ImageInput,
	type KnownMessages,
	knownPrefix,
	type ModelInfo,
	PierProtocolError,
	type PierSessionEvent,
	type QueueState,
	type SessionCommandInfo,
	type SessionContextInfo,
	type SessionRunState,
	type SessionSnapshot,
	type SessionSummary,
	type StreamingBehavior,
	type SubscribeResult,
	type ThinkingLevel,
	type UiResponse,
	type WireEvent,
	type WorkspaceInfo,
} from "@pier/protocol";
import { evaluateToolCall } from "./approval/policy.ts";
import { DEFAULT_EVENT_LOG_CAPACITY, EventLog } from "./event-log.ts";
import { truncateInput } from "./pi/approval-extension.ts";
import { type SubagentRuntimeHooks, SubagentTracker, type SubagentTranscript } from "./runtimes/subagents.ts";
import { SessionLock } from "./session-lock.ts";
import { UiBridge } from "./ui-bridge.ts";

export interface SessionSubscriber {
	readonly connectionId: string;
	send(frame: EventFrame): void;
}

interface SubscriberEntry {
	subscriber: SessionSubscriber;
	/** Until `start()` runs, live frames are buffered so they follow the replay/snapshot. */
	ready: boolean;
	buffer: EventFrame[];
}

export interface PendingSubscription {
	result: SubscribeResult;
	/** Send the replay (or snapshot) followed by buffered live events. Call after the response is sent. */
	start(): void;
}

/** Options every runtime's sessions share (see {@link ManagedSession}). */
export interface ManagedSessionOptions {
	workspace: () => WorkspaceInfo;
	locksDir: string;
	uiTimeoutMs?: number;
	eventLogCapacity?: number;
	/** Called after the runtime replaced the underlying session (pi extension commands: new/fork/switch). */
	onReplaced?: (session: ManagedSession, previousId: string) => void;
	/** Called when the run state or the number of pending UI requests changes. */
	onActivity?: (session: ManagedSession) => void;
	/** Whether a session id is archived (`session.archive`). */
	isArchived?: (sessionId: string) => boolean;
}

/** Summary fields a runtime reports about its session; the base class adds the live state. */
export interface SessionDescription {
	path?: string;
	name?: string;
	cwd: string;
	createdAt: string;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
}

/** Transcript and model state for a snapshot; the base class adds UI and log state. */
export interface SessionContent {
	messages: unknown[];
	streamingMessage?: unknown;
	pendingToolCalls: string[];
	model?: ModelInfo;
	contextInfo?: SessionContextInfo;
	thinkingLevel: ThinkingLevel;
	fastMode?: boolean;
	errorMessage?: string;
}

export interface ToolApprovalRequest {
	/** pi tool name (`bash`, `edit`, ...) or the runtime's own name for other tools. */
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	/**
	 * Set when the runtime itself decided to ask (Codex approvals, Claude Code permission
	 * prompts for tools Pier's policy does not govern): Pier then asks unless the policy is
	 * `auto` or the user allowed such calls for the session.
	 */
	runtimeAsked?: { reason: string; summary?: string; severity?: "normal" | "high" };
}

export type ToolApproval =
	| {
			allowed: true /** `session`: the user allowed such calls for the rest of the session. */;
			scope: "policy" | "once" | "session";
	  }
	| { allowed: false; reason: string };

/**
 * One active session held by the host, independent of the agent runtime that runs it: owns
 * the event log, the UI bridge, per-session approval allowances, the session lock and the
 * subscriber set. Runtimes subclass it and translate their events into the pi-shaped wire
 * events clients render (see `docs/protocol.md`).
 */
export abstract class ManagedSession {
	abstract readonly runtimeId: AgentRuntimeId;
	abstract readonly capabilities: AgentRuntimeCapabilities;
	readonly bridge: UiBridge;
	readonly allowances = new Set<string>();
	protected log: EventLog<WireEvent>;
	private readonly subscribers = new Map<string, SubscriberEntry>();
	protected lock: SessionLock | undefined;
	private runState: SessionRunState = "idle";
	protected disposed = false;
	/** Subagents the session's agent started (1.54). */
	protected readonly subagents: SubagentTracker;
	lastActivity = Date.now();

	protected constructor(protected readonly options: ManagedSessionOptions) {
		this.log = new EventLog(options.eventLogCapacity ?? DEFAULT_EVENT_LOG_CAPACITY);
		this.subagents = new SubagentTracker(
			(event) => this.emit(event),
			() => this.subagentHooks(),
		);
		this.bridge = new UiBridge({
			sessionId: () => this.id,
			emit: (event) => {
				this.emit(event);
				if (event.type === "ui.request" || event.type === "ui.resolved") this.options.onActivity?.(this);
			},
			...(options.uiTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.uiTimeoutMs }),
		});
	}

	abstract get id(): string;

	/** File the session is stored in, if any (used for locking and to match session list entries). */
	abstract get sessionFile(): string | undefined;

	get workspaceId(): string {
		return this.options.workspace().id;
	}

	get workspacePath(): string {
		return this.options.workspace().path;
	}

	get epoch(): string {
		return this.log.epoch;
	}

	get currentSeq(): number {
		return this.log.currentSeq;
	}

	get state(): SessionRunState {
		return this.runState;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	/** Whether the session must stay loaded (running work or waiting for a UI answer). */
	get busy(): boolean {
		return this.runState !== "idle" || this.bridge.pendingRequests.length > 0;
	}

	protected acquireLock(file: string | undefined): void {
		this.lock?.release();
		this.lock = file ? SessionLock.acquire(this.options.locksDir, file) : undefined;
	}

	protected releaseLock(): void {
		this.lock?.release();
		this.lock = undefined;
	}

	/** Start a fresh event log (after the runtime replaced the session). */
	protected resetLog(): void {
		this.log = new EventLog(this.options.eventLogCapacity ?? DEFAULT_EVENT_LOG_CAPACITY);
	}

	/** Send a fresh snapshot to every subscriber (after the runtime replaced the session). */
	protected sendSnapshotToAll(): void {
		const snapshot = this.snapshot();
		for (const entry of this.subscribers.values()) {
			this.deliver(entry, { type: "evt", sessionId: this.id, event: { type: "session.snapshot", snapshot } });
		}
	}

	protected setRunState(next: SessionRunState): void {
		if (next === this.runState) return;
		this.runState = next;
		this.emit({ type: "session.status", state: next });
		this.options.onActivity?.(this);
	}

	/** Append an event to the log and fan it out to subscribers. */
	protected emit(event: WireEvent | PierSessionEvent, sessionId: string = this.id): void {
		if (this.disposed) return;
		const entry = this.log.append(event as WireEvent);
		const frame: EventFrame = { type: "evt", sessionId, seq: entry.seq, event: entry.event };
		for (const subscriber of this.subscribers.values()) this.deliver(subscriber, frame);
	}

	private deliver(entry: SubscriberEntry, frame: EventFrame): void {
		if (entry.ready) entry.subscriber.send(frame);
		else entry.buffer.push(frame);
	}

	/**
	 * Subscribe a connection: replay what it missed when `sinceSeq` / `epoch` allow it, otherwise
	 * send a snapshot (without the transcript prefix it already has, when `known` matches).
	 */
	subscribe(
		subscriber: SessionSubscriber,
		sinceSeq?: number,
		epoch?: string,
		known?: KnownMessages,
	): PendingSubscription {
		this.lastActivity = Date.now();
		const entry: SubscriberEntry = { subscriber, ready: false, buffer: [] };
		this.subscribers.set(subscriber.connectionId, entry);
		const replay = sinceSeq !== undefined && epoch === this.log.epoch ? this.log.since(sinceSeq) : undefined;
		const replayEpoch = this.log.epoch;
		const result: SubscribeResult = {
			mode: replay ? "replay" : "snapshot",
			currentSeq: this.log.currentSeq,
			epoch: this.log.epoch,
		};
		const start = () => {
			if (this.subscribers.get(subscriber.connectionId) !== entry || entry.ready) return;
			let buffered = entry.buffer;
			if (replay && replayEpoch === this.log.epoch) {
				for (const logged of replay) {
					subscriber.send({ type: "evt", sessionId: this.id, seq: logged.seq, event: logged.event });
				}
			} else {
				// The snapshot already reflects every logged event up to its seq.
				const snapshot = this.snapshot(known);
				subscriber.send({ type: "evt", sessionId: this.id, event: { type: "session.snapshot", snapshot } });
				buffered = buffered.filter((f) => f.seq === undefined || f.seq > snapshot.seq || f.sessionId !== this.id);
			}
			entry.ready = true;
			entry.buffer = [];
			for (const frame of buffered) subscriber.send(frame);
		};
		return { result, start };
	}

	unsubscribe(connectionId: string): boolean {
		this.lastActivity = Date.now();
		return this.subscribers.delete(connectionId);
	}

	protected abstract describe(): SessionDescription;

	protected abstract content(): SessionContent;

	summary(): SessionSummary {
		const d = this.describe();
		return {
			id: this.id,
			workspaceId: this.workspaceId,
			...(d.path ? { path: d.path } : {}),
			...(d.name ? { name: d.name } : {}),
			cwd: d.cwd,
			createdAt: d.createdAt,
			modifiedAt: new Date(this.lastActivity).toISOString(),
			messageCount: d.messageCount,
			firstMessage: d.firstMessage,
			...(d.parentSessionPath ? { parentSessionPath: d.parentSessionPath } : {}),
			active: true,
			state: this.runState,
			pendingUi: this.bridge.pendingRequests.length,
			...(this.options.isArchived?.(this.id) ? { archived: true } : {}),
			runtime: this.runtimeId,
		};
	}

	/** Everything needed to render the session; without the first messages when `known` matches them. */
	snapshot(known?: KnownMessages): SessionSnapshot {
		const c = this.content();
		const from = knownPrefix(c.messages, known);
		return {
			session: this.summary(),
			seq: this.log.currentSeq,
			epoch: this.log.epoch,
			messages: from ? c.messages.slice(from) : c.messages,
			...(from ? { messagesFrom: from } : {}),
			...(c.streamingMessage ? { streamingMessage: c.streamingMessage } : {}),
			pendingToolCalls: c.pendingToolCalls,
			pendingUi: this.bridge.pendingRequests,
			queue: this.queue(),
			...(c.model ? { model: c.model } : {}),
			...(c.contextInfo ? { contextInfo: c.contextInfo } : {}),
			thinkingLevel: c.thinkingLevel,
			...(c.fastMode !== undefined ? { fastMode: c.fastMode } : {}),
			statuses: Object.fromEntries(this.bridge.statuses),
			widgets: Object.fromEntries(this.bridge.widgets),
			...(this.bridge.title ? { title: this.bridge.title } : {}),
			...(c.errorMessage ? { errorMessage: c.errorMessage } : {}),
			capabilities: this.capabilities,
			...(this.subagents.size ? { subagents: this.subagents.list() } : {}),
		};
	}

	/** The current model and thinking level (`model.list` with a session). */
	modelState(): { model?: ModelInfo; thinkingLevel: ThinkingLevel } {
		const c = this.content();
		return c.model ? { model: c.model, thinkingLevel: c.thinkingLevel } : { thinkingLevel: c.thinkingLevel };
	}

	protected unsupported(what: string): PierProtocolError {
		return new PierProtocolError("UNSUPPORTED", `${runtimeName(this.runtimeId)} sessions do not support ${what}`);
	}

	/**
	 * Decide a tool call with the workspace's approval policy, asking the user through the UI
	 * bridge when needed (runtimes other than pi; pi uses the `pier-approval` extension).
	 */
	protected async approveToolCall(call: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApproval> {
		const workspace = this.options.workspace();
		const verdict = evaluateToolCall(
			{ toolName: call.toolName, input: call.input },
			{ policy: workspace.policy, workspacePath: workspace.path, allowances: this.allowances },
		);
		let ask: Exclude<typeof verdict, { action: "allow" }>;
		if (verdict.action === "allow") {
			// Tools the policy governs follow it; others the runtime asked about need an answer.
			const governed = verdict.reason !== "tool not governed by policy";
			if (!call.runtimeAsked || governed || workspace.policy === "auto") return { allowed: true, scope: "policy" };
			const sessionKey = `${call.toolName}:runtime`;
			if (this.allowances.has(sessionKey)) return { allowed: true, scope: "policy" };
			ask = {
				action: "ask",
				reason: call.runtimeAsked.reason,
				severity: call.runtimeAsked.severity ?? "normal",
				summary: call.runtimeAsked.summary ?? call.toolName,
				sessionKey,
				sessionScope: `${call.toolName} calls`,
			};
		} else {
			ask = call.runtimeAsked ? { ...verdict, reason: `${call.runtimeAsked.reason} (${verdict.reason})` } : verdict;
		}
		const response = await this.bridge.request(
			{
				kind: "approval",
				title: `Allow ${call.toolName}?`,
				message: ask.reason,
				approval: {
					toolName: call.toolName,
					toolCallId: call.toolCallId,
					summary: ask.summary,
					input: truncateInput(call.input),
					reason: ask.reason,
					severity: ask.severity,
					sessionAllowable: ask.sessionKey !== undefined,
					...(ask.sessionScope ? { sessionScope: ask.sessionScope } : {}),
				},
			},
			signal ? { signal } : {},
		);
		if (!response)
			return { allowed: false, reason: "The user did not approve this tool call (no answer or timed out)." };
		if (response.decision === "allow_once") return { allowed: true, scope: "once" };
		if (response.decision === "allow_session" && ask.sessionKey) {
			this.allowances.add(ask.sessionKey);
			return { allowed: true, scope: "session" };
		}
		const reason = response.reason?.trim();
		return { allowed: false, reason: reason ? `Denied by the user: ${reason}` : "Denied by the user." };
	}

	abstract queue(): QueueState;

	/** Start a prompt. Resolves once the runtime accepted it (the run continues in the background). */
	abstract prompt(text: string, images?: ImageInput[], streamingBehavior?: StreamingBehavior): Promise<void>;

	abstract steer(text: string, images?: ImageInput[]): Promise<QueueState>;

	abstract followUp(text: string, images?: ImageInput[]): Promise<QueueState>;

	abstract abort(): Promise<void>;

	compact(_instructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		return Promise.reject(this.unsupported("compaction"));
	}

	abstract rename(name: string): SessionSummary | Promise<SessionSummary>;

	abstract setModel(provider: string, modelId: string, persist: boolean): Promise<ModelInfo>;

	/** Re-resolve the current model after the model catalog changed. */
	refreshModel(): void {}

	abstract setThinking(level: ThinkingLevel, persist: boolean): string | Promise<string>;

	setFast(_enabled?: boolean): Promise<boolean> {
		return Promise.reject(this.unsupported("Fast mode"));
	}

	/** Slash commands the runtime handles when they arrive as a prompt. */
	commands(): SessionCommandInfo[] | Promise<SessionCommandInfo[]> {
		return [];
	}

	reload(): Promise<void> {
		return Promise.reject(this.unsupported("reloading"));
	}

	forkPoints(): Array<{ entryId: string; text: string }> | Promise<Array<{ entryId: string; text: string }>> {
		throw this.unsupported("forking");
	}

	respondUi(requestId: string, response: UiResponse, by: string): boolean {
		this.lastActivity = Date.now();
		return this.bridge.respond(requestId, response, by);
	}

	/** How the runtime loads and stops its subagents. */
	protected subagentHooks(): SubagentRuntimeHooks {
		return {};
	}

	/** A subagent's conversation from message `from` on (`session.subagentTranscript`, 1.54). */
	subagentTranscript(id: string, from = 0): Promise<SubagentTranscript> {
		this.lastActivity = Date.now();
		return this.subagents.transcript(id, from);
	}

	/** Stop one running subagent, or all of them (`session.subagentStop`, 1.54). */
	stopSubagents(id?: string): Promise<number> {
		this.lastActivity = Date.now();
		return this.subagents.stop(id);
	}

	/** Release the runtime's resources (processes, SDK sessions). */
	protected abstract disposeRuntime(): Promise<void>;

	async dispose(reason: "idle" | "closed" | "deleted" | "host_shutdown"): Promise<void> {
		if (this.disposed) return;
		this.bridge.cancelAll();
		this.emit({ type: "session.closed", reason });
		this.disposed = true;
		this.subagents.dispose();
		this.subscribers.clear();
		try {
			await this.disposeRuntime();
		} finally {
			this.releaseLock();
		}
	}
}

export function runtimeName(id: AgentRuntimeId): string {
	switch (id) {
		case "pi":
			return "pi";
		case "claude-code":
			return "Claude Code";
		case "codex":
			return "Codex";
		default:
			return id;
	}
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && part.type === "text" ? String(part.text ?? "") : ""))
			.join(" ");
	}
	return "";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
