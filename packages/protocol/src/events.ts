import type { BrowserCommand } from "./browser.ts";
import type {
	AgentConfigRuntime,
	AgentConfigScope,
	AgentRuntimeId,
	AppUpdateStatus,
	AuthNotice,
	AuthPromptInfo,
	DefaultModelRef,
	ModelInfo,
	PairingRequest,
	PairingResolution,
	RemoteAccessStatus,
	SessionRunState,
	SessionSnapshot,
	SessionSummary,
	UiRequest,
	UiResolution,
	UiResponse,
} from "./domain.ts";

/**
 * Pi session events forwarded verbatim (after pi's JSON wire transformation, which
 * strips cumulative `partial` snapshots from `message_update`).
 *
 * The protocol package intentionally does not depend on the pi SDK so it can be used
 * by the React Native client; these types document the fields clients rely on.
 */
export const PI_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"session_info_changed",
	"thinking_level_changed",
	"entry_appended",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"bash_execution_update",
] as const;

export type PiEventType = (typeof PI_EVENT_TYPES)[number];

export interface PiEvent {
	type: PiEventType;
	[key: string]: unknown;
}

/** Pier-specific session events. All of these carry a `seq` except `session.snapshot`. */
export type PierSessionEvent =
	| { type: "session.snapshot"; snapshot: SessionSnapshot }
	| { type: "session.status"; state: SessionRunState }
	| { type: "session.replaced"; previousSessionId: string; session: SessionSummary }
	| { type: "session.closed"; reason: "idle" | "closed" | "deleted" | "host_shutdown" }
	| { type: "session.model"; model?: ModelInfo; thinkingLevel: string }
	| { type: "ui.request"; request: UiRequest }
	| {
			type: "ui.resolved";
			requestId: string;
			resolution: UiResolution;
			response?: UiResponse;
			/** Connection id of the client that answered, when answered. */
			by?: string;
	  }
	| { type: "ui.notify"; message: string; level: "info" | "warning" | "error" }
	| { type: "ui.status"; key: string; text?: string }
	| { type: "ui.widget"; key: string; lines?: string[]; placement?: string }
	| { type: "ui.title"; title: string }
	| { type: "ui.editorText"; text: string }
	| { type: "extension.error"; extensionPath: string; event: string; error: string };

/** Host-scoped events (no `sessionId`, no `seq`). */
export type PierHostEvent =
	| { type: "browser.command"; browserId: string; requestId: string; command: BrowserCommand }
	| { type: "task.changed" }
	| { type: "host.notice"; level: "info" | "warning" | "error"; message: string; sessionId?: string }
	| { type: "workspace.changed" }
	| { type: "session.listChanged"; workspaceId: string }
	/** An active session's run state or number of pending UI requests changed (1.1). */
	| {
			type: "session.activity";
			workspaceId: string;
			sessionId: string;
			state: SessionRunState;
			pendingUi: number;
	  }
	// The following are only sent to local (desktop) connections.
	| { type: "remote.changed"; status: RemoteAccessStatus }
	| { type: "device.changed" }
	| { type: "pairing.request"; request: PairingRequest }
	| { type: "pairing.resolved"; requestId: string; resolution: PairingResolution; deviceId?: string }
	/** Paired peer computers were added, removed, renamed or (dis)connected (1.9). Local only. */
	| { type: "peer.changed" }
	/** Providers, credentials, models.json or the default model changed (1.2). Sent to every connection. */
	| { type: "provider.changed" }
	/**
	 * pi extension or package settings changed (1.8). `workspaceId` is set when only that
	 * workspace's project settings changed. Sent to every connection.
	 */
	| { type: "extension.changed"; workspaceId?: string }
	/**
	 * The desktop app's updater on the host's computer changed state or made progress (1.13).
	 * Sent to every connection.
	 */
	| { type: "update.status"; status: AppUpdateStatus }
	/**
	 * A pi settings file was changed through `settings.update` / `settings.write` (1.15).
	 * `workspaceId` is set for a workspace's project settings. Sent to every connection.
	 */
	| { type: "settings.changed"; scope: "user" | "project"; workspaceId?: string }
	/**
	 * A Claude Code or Codex configuration file was changed through `agentConfig.update` /
	 * `agentConfig.write` (1.23). `workspaceId` is set for a workspace's files. Sent to every connection.
	 */
	| { type: "agentConfig.changed"; runtime: AgentConfigRuntime; scope: AgentConfigScope; workspaceId?: string }
	/** A CLI was installed or updated (1.32); refresh runtime availability and models. */
	| { type: "runtime.changed"; runtime: AgentRuntimeId }
	// Terminals (1.18), sent only to the connection that opened the terminal.
	/** Output of a terminal: raw bytes, base64-encoded (UTF-8 sequences may be split across events). */
	| { type: "terminal.output"; terminalId: string; data: string }
	/**
	 * A terminal ended; no more events follow for it. `code` is the shell's exit code (null when
	 * unknown or killed by a signal). `error` is set when the host lost it (the desktop app went away).
	 */
	| { type: "terminal.exit"; terminalId: string; code: number | null; error?: string }
	/** Progress of `extension.install` / `remove` / `update` (1.8). Local connections only. */
	| {
			type: "extension.progress";
			action: "install" | "remove" | "update" | "clone" | "pull";
			phase: "start" | "progress" | "complete" | "error";
			source: string;
			message?: string;
	  }
	// Sign-in progress (1.2), sent only to the connection that called `provider.login`.
	| { type: "auth.prompt"; flowId: string; prompt: AuthPromptInfo }
	/** A prompt was answered elsewhere (e.g. the browser callback arrived first) and should be closed. */
	| { type: "auth.promptClosed"; flowId: string; promptId: string }
	| { type: "auth.notice"; flowId: string; notice: AuthNotice }
	| {
			type: "auth.done";
			flowId: string;
			providerId: string;
			ok: boolean;
			cancelled?: boolean;
			error?: string;
			/** Set when the host picked a default model because none was usable. */
			defaultModel?: DefaultModelRef;
	  };

/** Host events delivered only to local connections (who can reach this computer). */
export const LOCAL_ONLY_EVENTS: ReadonlySet<string> = new Set([
	"remote.changed",
	"device.changed",
	"pairing.request",
	"pairing.resolved",
	"peer.changed",
]);

export type PierEvent = PierSessionEvent | PierHostEvent;
export type PierEventType = PierEvent["type"];
