import type {
	AgentRuntimeCapabilities,
	AgentRuntimeId,
	AgentRuntimeInfo,
	ModelInfo,
	ThinkingLevel,
	WorkspaceInfo,
} from "@pier/protocol";
import type { ManagedSession, ManagedSessionOptions } from "../managed-session.ts";

/** A session a runtime stored for a workspace, as shown in `session.list`. */
export interface StoredSession {
	id: string;
	/** Session file, when the runtime stores sessions in files. */
	path?: string;
	name?: string;
	cwd: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
}

/** One model request of a stored session, for `usage.stats` (1.68). Token counts follow pi's `Usage`. */
export interface UsageRecord {
	/** When the reply arrived (epoch milliseconds). */
	at: number;
	/** Model id; `""` when unknown. */
	model: string;
	provider?: string;
	/** Prompt tokens not read from or written to the cache. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Part of `cacheWrite` written with 1-hour retention (Anthropic), which costs more. */
	cacheWrite1h?: number;
	/** Served in fast mode, which costs more than the model's catalog prices. */
	fast?: boolean;
	/** Cost in US dollars, when the agent recorded it. */
	cost?: number;
	/** Model requests the record sums, for agents that keep totals only (default 1). */
	requests?: number;
	/**
	 * Identifies the request across the runtime's sessions, when a fork copies it into another
	 * session's file. Requests with a key seen in an older session are not counted again.
	 */
	key?: string;
}

export interface ForkResult {
	session: ManagedSession;
	selectedText?: string;
}

/**
 * An agent runtime (pi, Claude Code, Codex, ...). The session pool asks every runtime for its
 * sessions and routes session operations to the runtime that owns them. Each runtime's
 * {@link ManagedSession} subclass translates the runtime's events into Pier's wire events.
 */
export interface AgentRuntime {
	readonly id: AgentRuntimeId;
	readonly name: string;
	readonly capabilities: AgentRuntimeCapabilities;
	/** Availability, version and capabilities. May probe the CLI (cached). */
	info(refresh?: boolean): Promise<AgentRuntimeInfo>;
	/** Sessions stored for the workspace. Unavailable runtimes return none. */
	listSessions(workspace: WorkspaceInfo): Promise<StoredSession[]>;
	create(options: ManagedSessionOptions): Promise<ManagedSession>;
	/** Open a stored session returned by {@link listSessions}. */
	open(options: ManagedSessionOptions, stored: StoredSession): Promise<ManagedSession>;
	fork(
		source: ManagedSession,
		entryId: string,
		position: "before" | "at",
		options: ManagedSessionOptions,
	): Promise<ForkResult>;
	/**
	 * Remove a stored session that is not open. Runtimes without their own way return false and
	 * the pool moves the session file to Pier's trash.
	 */
	deleteStored?(workspace: WorkspaceInfo, stored: StoredSession): Promise<boolean>;
	/**
	 * Every model request of a stored session (1.68), including its subagents' where the runtime
	 * stores them. Runtimes that cannot read usage leave it out.
	 */
	usage?(workspace: WorkspaceInfo, stored: StoredSession): Promise<UsageRecord[]>;
	/** Models new sessions can use. */
	listModels(cwd?: string): Promise<ModelInfo[]>;
	/** The model and thinking level a new session in `cwd` starts with. */
	newSessionDefaults(cwd: string, models?: ModelInfo[]): Promise<{ model?: ModelInfo; thinkingLevel: ThinkingLevel }>;
	/** The runtime's own configuration files changed (1.23): drop what was read from them. */
	configChanged?(): void;
	/** A verified native CLI was installed (1.32): refresh cached version and catalogs. */
	installationChanged?(): void;
	dispose(): Promise<void>;
}
