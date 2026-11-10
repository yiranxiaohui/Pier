import { z } from "zod";

/** Workspace approval policy for the built-in `pier-approval` extension. */
export const ApprovalPolicySchema = z.enum(["ask", "smart", "auto"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const StreamingBehaviorSchema = z.enum(["steer", "followUp"]);
export type StreamingBehavior = z.infer<typeof StreamingBehaviorSchema>;

export const ImageInputSchema = z.object({
	type: z.literal("image"),
	/** Base64 data without the `data:` prefix. */
	data: z.string().min(1),
	mimeType: z.string().regex(/^image\/[\w.+-]+$/),
});
export type ImageInput = z.infer<typeof ImageInputSchema>;

export interface WorkspaceInfo {
	id: string;
	name: string;
	/** Absolute directory used as the pi `cwd`. */
	path: string;
	policy: ApprovalPolicy;
	addedAt: string;
}

/** One subdirectory in a `host.listDirectories` result (1.10). */
export interface HostDirectoryEntry {
	name: string;
	/** Absolute path on the host. */
	path: string;
	symlink?: boolean;
}

/** Subdirectories of one host directory, used to pick a workspace on another computer (1.10). */
export interface HostDirectoryListing {
	/** The listed directory: absolute and normalized (symlinks are not resolved). */
	path: string;
	/** Its parent directory; omitted at a filesystem root. */
	parent?: string;
	/** The host user's home directory. */
	home: string;
	/** Path separator on the host (`/` or `\\`). */
	separator: string;
	/** Subdirectories (symlinks to directories included), sorted by name. */
	entries: HostDirectoryEntry[];
	truncated?: boolean;
	total?: number;
}

/**
 * State of the desktop app's updater (`update.*`, 1.13):
 * - `unsupported`: the host does not run inside a packaged desktop app (a development build,
 *   a standalone `pier-host`, or a desktop app too old to be driven by its host).
 * - `idle`: not checked yet. `upToDate` / `available`: result of the last check.
 * - `downloading` / `installing`: an update is being installed; the app restarts when done.
 * - `error`: the last check or install failed (`error`); with `version` the update is still
 *   pending and installing can be retried.
 */
export type AppUpdateState =
	| "unsupported"
	| "idle"
	| "checking"
	| "upToDate"
	| "available"
	| "downloading"
	| "installing"
	| "error";

/** The desktop app's updater on the host's computer (1.13). */
export interface AppUpdateStatus {
	state: AppUpdateState;
	/** Version of the desktop app (the host's version when there is no desktop app). */
	currentVersion: string;
	/** The app checks for updates on its own. */
	autoCheck: boolean;
	/** The available (or still pending, after a failed install) version. */
	version?: string;
	/** Release notes of `version` (Markdown). */
	notes?: string;
	/** Publication date of `version` (ISO 8601). */
	date?: string;
	/**
	 * Bytes downloaded so far while `downloading`; also in `available` / `error` when part of
	 * `version` is already downloaded (a paused or interrupted download, which installing
	 * continues). Older desktop apps report 0 there.
	 */
	downloaded: number;
	total?: number;
	/** Why the last check or install failed; while `downloading`, why the download is being retried. */
	error?: string;
	/** Unix time (ms) of the last successful check. */
	lastChecked?: number;
	/**
	 * Installing asks for an administrator password on that computer (Linux `.deb` / `.rpm`
	 * installs), so someone has to be there to finish it.
	 */
	installNeedsAuth?: boolean;
}

/** Resource usage of the computer a host runs on (`host.stats`, 1.12). Sizes are bytes. */
export interface HostStats {
	/** When the host took the sample (ISO 8601). */
	sampledAt: string;
	/** Host OS (`darwin`, `linux`, `win32`, …). */
	platform: string;
	/** Seconds since the computer booted. */
	uptime: number;
	cpu: {
		/** Busy share of all cores since the previous sample, 0–1. */
		usage: number;
		/** Logical cores. */
		cores: number;
		model?: string;
		/** 1, 5 and 15 minute load averages (omitted on Windows). */
		loadAverage?: [number, number, number];
	};
	memory: {
		total: number;
		/** In use by programs (excludes reclaimable caches where the OS reports them). */
		used: number;
	};
	/** The filesystem holding the user's home directory; omitted when it cannot be read. */
	disk?: {
		/** The directory that was measured (the home directory). */
		path: string;
		total: number;
		used: number;
		/** Free space available to the user. */
		available: number;
	};
	/**
	 * Traffic of the physical network interfaces (all non-loopback ones when none is physical),
	 * omitted when the OS does not report it. Rates are bytes per second since the previous sample.
	 */
	network?: {
		rxRate: number;
		txRate: number;
		/** Bytes received / sent since the counters started (usually boot). */
		rxTotal: number;
		txTotal: number;
	};
	/** Memory of the Pier Host process (resident set size). */
	hostRss: number;
}

/** An npm-compatible package manager pi can use for `npmCommand`. */
export type PackageManagerName = "npm" | "pnpm" | "bun";

/** One package manager executable found on the host (`host.packageManagers`, 1.17). */
export interface PackageManagerInfo {
	name: PackageManagerName;
	/** Absolute path of the executable as found (not resolved through symlinks). */
	path: string;
	/** Found in a directory on the host's `PATH`, not only in a well-known install directory. */
	onPath: boolean;
	/** A bare `name` runs this one (the first of its name on the host's `PATH`). */
	default?: true;
	/** `--version` output, without a leading `v`; omitted when it could not be run (see `error`). */
	version?: string;
	/** Why `--version` failed (e.g. `node` is not on the host's `PATH` for npm). */
	error?: string;
}

export interface PackageManagerDetection {
	/** `PATH` order first, then the well-known install directories; one entry per real file. */
	managers: PackageManagerInfo[];
}

/** One entry of a workspace directory listing (`workspace.files`, 1.5). */
export interface WorkspaceFileEntry {
	name: string;
	/** Path relative to the workspace root, joined with "/". */
	path: string;
	/**
	 * `directory` can be listed with `workspace.files`. Symlinks are followed; a link to a
	 * directory outside the workspace, a broken link, or a special file is `other`.
	 */
	kind: "file" | "directory" | "other";
	symlink?: boolean;
	/** Size in bytes (files only). */
	size?: number;
	modifiedAt?: string;
}

export interface WorkspaceFilesResult {
	/** The listed directory, normalized ("" for the workspace root). */
	path: string;
	/** Directories first, then files, by name. VCS internals (`.git`, `.hg`, `.svn`) are omitted. */
	entries: WorkspaceFileEntry[];
	/** Set when the directory had more entries than the host returns. */
	truncated?: boolean;
	/** Total number of entries when `truncated`. */
	total?: number;
}

/** A file read for preview (`workspace.readFile`, 1.7; `workspace.previewFile`, 1.31). */
export interface WorkspaceFileContent {
	/** Workspace-relative path, or the requested local path for `workspace.previewFile`. */
	path: string;
	/** Size in bytes of the file on disk. */
	size: number;
	modifiedAt: string;
	/**
	 * `text`: UTF-8 text in `text`. `image`: a common image format (by extension), base64 in
	 * `data` unless `tooLarge`. `binary`: anything else; no content is returned.
	 */
	kind: "text" | "image" | "binary";
	text?: string;
	/** Set when only the first part of a text file is returned in `text`. */
	truncated?: boolean;
	/** Base64 image data without the `data:` prefix. */
	data?: string;
	mimeType?: string;
	/** Set when an image is too large to return. */
	tooLarge?: boolean;
}

/** Result of `workspace.writeFile` (1.8): the file's metadata after writing. */
export interface WorkspaceFileWriteResult {
	/** Requested path; workspace downloads are relative, preview downloads may be absolute. */
	path: string;
	/** Size in bytes of the file on disk. */
	size: number;
	modifiedAt: string;
}

/** Result of `workspace.deletePath` (1.11): what was deleted. */
export interface WorkspacePathDeleteResult {
	/** Path relative to the workspace root, normalized and joined with "/". */
	path: string;
	/** `directory` was deleted with its contents; `other` covers symbolic links and special files. */
	kind: "file" | "directory" | "other";
}

/** Result of a native copy or move between workspaces on one Host (1.41). */
export interface WorkspacePathTransferResult {
	sourcePath: string;
	path: string;
	kind: "file" | "directory" | "other";
}

/** A byte range of a file (`workspace.readBytes`, 1.21), e.g. one download chunk. */
export interface WorkspaceFileBytes {
	/** Path relative to the workspace root, normalized and joined with "/". */
	path: string;
	/** Size in bytes of the whole file right now. */
	size: number;
	modifiedAt: string;
	/** Where `data` starts in the file. */
	offset: number;
	/** The bytes read, base64-encoded; empty at or past the end of the file. */
	data: string;
	/** Whether `data` reaches the end of the file. */
	eof: boolean;
}

/** Result of `workspace.uploadStart` (1.21). */
export interface WorkspaceUploadStart {
	/** Pass to `workspace.uploadChunk` / `uploadFinish` / `uploadCancel` on the same connection. */
	uploadId: string;
	/** Destination path relative to the workspace root, normalized and joined with "/". */
	path: string;
	/** Largest `data` (decoded bytes) accepted by one `workspace.uploadChunk`. */
	chunkBytes: number;
}

/**
 * One changed path of a Git repository (`git.status`, 1.28), from `git status --porcelain=v2`.
 * `index` and `worktree` are Git's status letters for the staged and unstaged side: `.`
 * unchanged, `M` modified, `T` type changed, `A` added, `D` deleted, `R` renamed, `C` copied,
 * `U` unmerged. Untracked paths are `?` on both sides; unmerged ones have `conflict` set.
 */
export interface GitFileStatus {
	/** Path relative to the repository root, joined with "/". */
	path: string;
	/** The path before a rename or copy. */
	origPath?: string;
	index: string;
	worktree: string;
	/** An unmerged path (a merge, rebase or cherry-pick conflict). */
	conflict?: true;
	/** A submodule. */
	submodule?: true;
}

/** A Git operation in progress that `git.status` reports (1.28). */
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface GitStatus {
	/** Whether the workspace is inside a Git work tree. The other fields are only set when it is. */
	repository: boolean;
	/** Git was not found on the host's computer. */
	gitMissing?: true;
	/** Absolute path of the repository root (the top of the work tree). */
	root?: string;
	/** The workspace relative to `root` ("" when the workspace is the root), joined with "/". */
	prefix?: string;
	/** Current branch; omitted when HEAD is detached. */
	branch?: string;
	/** Full hash of HEAD; omitted before the first commit. */
	head?: string;
	/** Upstream branch of `branch`, e.g. `origin/main`. */
	upstream?: string;
	/** Commits on `branch` not on `upstream`, and the other way round. */
	ahead?: number;
	behind?: number;
	/** Names of the configured remotes. */
	remotes?: string[];
	operation?: GitOperation;
	/** Changed paths, in Git's order. */
	files?: GitFileStatus[];
	/** Set when there were more changed paths than the host returns. */
	truncated?: true;
}

/** A diff of one path or commit (`git.diff` / `git.show`, 1.28). */
export interface GitDiffResult {
	/** Unified diff text as printed by `git diff` (may contain several files). */
	diff: string;
	/** Set when the diff was longer than the host returns. */
	truncated?: true;
}

/** One commit of `git.log` (1.28). */
export interface GitCommitInfo {
	hash: string;
	shortHash: string;
	subject: string;
	authorName: string;
	authorEmail: string;
	/** Author date, ISO 8601. */
	date: string;
	/** Ref names pointing at the commit, as `git log --format=%D` prints them. */
	refs?: string;
	parents: string[];
}

/** A local or remote-tracking branch (`git.branches`, 1.28). */
export interface GitBranchInfo {
	/** Short name, e.g. `main` or `origin/main`. */
	name: string;
	remote: boolean;
	current?: true;
	/** Upstream of a local branch. */
	upstream?: string;
	ahead?: number;
	behind?: number;
	/** The upstream branch no longer exists. */
	upstreamGone?: true;
	shortHash: string;
	subject: string;
	/** Committer date of the tip, ISO 8601. */
	date: string;
}

/** A work tree of a repository (`git.worktrees`, 1.51), as `git worktree list` reports it. */
export interface GitWorktreeInfo {
	/** Absolute path of the work tree. */
	path: string;
	/** Full hash of its HEAD; omitted before the first commit and for a bare repository. */
	head?: string;
	/** Short name of the checked-out branch; omitted when HEAD is detached. */
	branch?: string;
	detached?: true;
	/** The repository is bare: this entry has no files. */
	bare?: true;
	/** The main work tree (the first one); it cannot be removed. */
	main?: true;
	/** The work tree the workspace is in. */
	current?: true;
	locked?: true;
	lockReason?: string;
	/** Its directory is gone; `git.pruneWorktrees` drops it. */
	prunable?: true;
	prunableReason?: string;
	/** The workspace of this computer whose directory is this work tree. */
	workspaceId?: string;
}

/** Result of `git.addWorktree` (1.51). */
export interface GitWorktreeAddResult extends GitCommandResult {
	/** Absolute path of the new work tree. */
	path: string;
	/** Branch checked out in it; omitted when HEAD is detached. */
	branch?: string;
}

/** Result of a Git command that changes the repository (1.28). */
export interface GitCommandResult {
	/** What Git printed (stdout and stderr), trimmed and possibly shortened. */
	output: string;
}

/** Result of `git.commit` (1.28). */
export interface GitCommitResult extends GitCommandResult {
	/** Full hash of the new commit. */
	hash: string;
}

/** Runtime state of a session as seen by clients. */
export type SessionRunState = "inactive" | "idle" | "streaming" | "compacting" | "retrying";

/**
 * Agent runtime that runs a session (1.22). `pi` is built in; `claude-code` and `codex` drive
 * the Claude Code and Codex CLIs installed on the host. Other ids may be added later.
 */
export type AgentRuntimeId = "pi" | "claude-code" | "codex" | (string & {});

export const DEFAULT_AGENT_RUNTIME: AgentRuntimeId = "pi";

/** What a runtime supports, so clients can hide controls that would fail (1.22). */
export interface AgentRuntimeCapabilities {
	/** `session.steer` / `streamingBehavior: "steer"` while the agent works. */
	steer: boolean;
	/** `session.followUp` / `streamingBehavior: "followUp"`. */
	followUp: boolean;
	/** `session.compact`. */
	compact: boolean;
	/** `session.forkPoints` / `session.fork`. */
	fork: boolean;
	/** `session.rename`. */
	rename: boolean;
	/** `model.set`. */
	setModel: boolean;
	/** `thinking.set`. */
	thinking: boolean;
	/** `fast.set` (1.43). Absent from older hosts: unsupported. */
	fastMode?: boolean;
	/** `session.reload`. */
	reload: boolean;
	/** Image attachments in prompts. */
	images: boolean;
	/** pi extensions, packages and `settings.json` apply to this runtime. */
	piExtensions: boolean;
}

/** One agent runtime the host knows (1.22). */
export interface AgentRuntimeInfo {
	id: AgentRuntimeId;
	/** Display name, e.g. `Claude Code`. */
	name: string;
	/** Whether sessions can be created: the CLI is installed (credentials are checked on use). */
	available: boolean;
	/** Why the runtime is unavailable, e.g. the CLI was not found. */
	reason?: string;
	/** Version of the runtime (pi SDK or CLI), when known. */
	version?: string;
	/** Executable the host runs, for CLI runtimes. */
	executable?: string;
	capabilities: AgentRuntimeCapabilities;
}

export interface SessionSummary {
	id: string;
	workspaceId: string;
	/** Session JSONL path. Undefined for sessions that have not been persisted. */
	path?: string;
	name?: string;
	cwd: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
	/** Whether the host currently holds this session in its active pool. */
	active: boolean;
	state: SessionRunState;
	/** Dialogs / approvals waiting for an answer (active sessions only). Added in 1.1. */
	pendingUi?: number;
	/** Set when the session was archived with `session.archive` (1.14); absent otherwise. */
	archived?: boolean;
	/** Agent runtime of the session (1.22). Absent from older hosts, which only run `pi`. */
	runtime?: AgentRuntimeId;
}

/** Which sessions `session.cleanup` affects by archive state (1.14). */
export type SessionCleanupScope = "all" | "archived" | "unarchived";

/** A session `session.cleanup` left alone (1.14). */
export interface SessionCleanupSkip {
	sessionId: string;
	/** `running`: busy or waiting for an answer. `locked`: open in another Pier host. `error`: see `message`. */
	reason: "running" | "locked" | "error";
	message?: string;
}

export interface SessionCleanupResult {
	/** Sessions that were (or, with `dryRun`, would be) archived or deleted. */
	sessionIds: string[];
	skipped: SessionCleanupSkip[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow?: number;
	/** Thinking levels the model supports, lowest first (1.19). `["off"]` for non-reasoning models. */
	thinkingLevels?: ThinkingLevel[];
}

/** Context and automatic compaction limits for the active agent runtime. */
export interface SessionContextInfo {
	/** Model context window, when the runtime knows it. */
	contextWindow?: number;
	/** Whether the automatic compaction policy is configured here or by the runtime. */
	autoCompaction: "configured" | "disabled" | "runtime";
	/** Context size at which the configured automatic compaction starts. */
	compactionThreshold?: number;
	/** Tokens reserved for the next model response by the configured policy. */
	reserveTokens?: number;
	/** Recent tokens retained verbatim by the configured compaction policy. */
	keepRecentTokens?: number;
}

/** Where a slash command offered by the host comes from (1.5). */
export type SessionCommandSource = "extension" | "prompt" | "skill";

/**
 * A slash command the agent runtime handles when it arrives as a prompt (1.5): extension
 * commands, prompt templates, and `skill:<name>` commands. `name` excludes the leading `/`.
 */
export interface SessionCommandInfo {
	name: string;
	description?: string;
	/** Usage hint for the arguments, e.g. `<file>`. */
	argumentHint?: string;
	source: SessionCommandSource;
}

export interface QueueState {
	steering: string[];
	followUp: string[];
}

export type UiRequestKind = "select" | "confirm" | "input" | "editor" | "approval";

export type ApprovalSeverity = "normal" | "high";

export interface ApprovalDetails {
	toolName: string;
	toolCallId: string;
	/** One-line human readable description, e.g. the bash command or file path. */
	summary: string;
	/** Tool input, with long string fields truncated. */
	input: Record<string, unknown>;
	/** Why the policy asked for approval. */
	reason: string;
	severity: ApprovalSeverity;
	/** Whether "allow for this session" is offered for this call. */
	sessionAllowable: boolean;
	/** Human readable scope of an "allow for this session" answer. */
	sessionScope?: string;
}

export interface UiRequest {
	id: string;
	sessionId: string;
	kind: UiRequestKind;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	approval?: ApprovalDetails;
	createdAt: string;
	/** ISO timestamp after which the host resolves the request with its default answer. */
	expiresAt?: string;
}

export const ApprovalDecisionSchema = z.enum(["allow_once", "allow_session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Answer to a {@link UiRequest}. Which fields are meaningful depends on the request kind:
 * - `select`, `input`, `editor`: `value` or `cancelled`
 * - `confirm`: `confirmed`
 * - `approval`: `decision` and an optional `reason` shown to the model on deny
 */
export const UiResponseSchema = z.object({
	cancelled: z.boolean().optional(),
	value: z.string().optional(),
	confirmed: z.boolean().optional(),
	decision: ApprovalDecisionSchema.optional(),
	reason: z.string().max(2000).optional(),
});
export type UiResponse = z.infer<typeof UiResponseSchema>;

export type UiResolution = "answered" | "timeout" | "cancelled";

export interface HostInfo {
	hostId: string;
	hostName: string;
	version: string;
	protocolVersion: string;
	platform: string;
	piVersion: string;
	agentDir: string;
	/**
	 * The host can run shells for its clients (`terminal.*`, 1.18): it runs inside a desktop app
	 * that provides pseudo-terminals, or (since Pier 0.2.64) runs without one on Linux / macOS
	 * and starts them itself. Absent on older hosts and on headless ones on Windows.
	 */
	terminals?: boolean;
}

/** A shell `terminal.open` started on the host's computer (1.18). */
export interface TerminalInfo {
	terminalId: string;
	/** Shell program name, e.g. `zsh` or `powershell`. */
	shell: string;
	/** Directory the shell started in (the home directory when the requested one is missing). */
	cwd: string;
}

export interface ClientInfo {
	name: string;
	version: string;
	platform?: string;
}

/**
 * Everything a client needs to render a session from scratch.
 * Events with `seq > snapshot.seq` apply on top of it.
 */
export interface SessionSnapshot {
	session: SessionSummary;
	seq: number;
	epoch: string;
	/**
	 * Finalized transcript messages (pi `AgentMessage` values). With `messagesFrom` only the
	 * messages from that index on; the client keeps the first `messagesFrom` it already has.
	 */
	messages: unknown[];
	/**
	 * Set when the subscriber's `known` prefix matched (1.27): `messages` starts at this index
	 * of the transcript instead of at 0.
	 */
	messagesFrom?: number;
	/** Partial assistant message currently being streamed, if any. */
	streamingMessage?: unknown;
	pendingToolCalls: string[];
	pendingUi: UiRequest[];
	queue: QueueState;
	model?: ModelInfo;
	contextInfo?: SessionContextInfo;
	thinkingLevel: ThinkingLevel;
	/** Whether Codex Fast mode is enabled (1.43). Absent for other runtimes/older hosts. */
	fastMode?: boolean;
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement?: string }>;
	title?: string;
	errorMessage?: string;
	/** What the session's runtime supports (1.22). Absent from older hosts: everything (pi). */
	capabilities?: AgentRuntimeCapabilities;
	/** Subagents the session's agent started (1.54), oldest first. Absent when there are none. */
	subagents?: SubagentInfo[];
}

/** State of a subagent (1.54). `stopped`: interrupted, or ended without reporting a result. */
export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

/**
 * A subagent a session's agent delegated work to (1.54): a Claude Code `Agent` task, a Codex
 * sub-agent thread or a `pi-subagents` child run. Hosts send the whole object again
 * (`subagent.update`) whenever it changes.
 */
export interface SubagentInfo {
	/** Unique in the session. */
	id: string;
	/** Tool call of the parent transcript that started it (`Agent`, `spawn_agent`, `subagent`). */
	toolCallId?: string;
	/** Subagent that started it, for nested subagents. */
	parentId?: string;
	/** Display name: the agent type, role, nickname or task name. */
	name: string;
	/** Short description of the delegated task. */
	description?: string;
	/** The delegated task (prompt), truncated. */
	task?: string;
	model?: string;
	thinkingLevel?: string;
	status: SubagentStatus;
	/** Epoch milliseconds. */
	startedAt?: number;
	endedAt?: number;
	/** Run time when the start time is unknown (stored sessions). */
	durationMs?: number;
	/** Tool calls made so far. */
	steps: number;
	tokens?: number;
	/** What it is doing now, e.g. the running tool or a progress summary. */
	activity?: string;
	/** Final report, truncated. */
	result?: string;
	error?: string;
	/** `session.subagentStop` can stop it while it runs. */
	stoppable: boolean;
	/** `session.subagentTranscript` can return its conversation. */
	transcript: boolean;
	/** Increases whenever its conversation changes, so viewers know when to fetch it again. */
	revision: number;
}

/** A remote device paired with this host (see `docs/security.md`). */
export interface DeviceInfo {
	id: string;
	name: string;
	platform?: string;
	model?: string;
	appVersion?: string;
	/** Fingerprint of the device's static key, e.g. `K7QF-2M4A-XJ3D-9PLR`. */
	fingerprint: string;
	pairedAt: string;
	lastSeenAt?: string;
	/** Whether the device currently has an open connection. */
	connected: boolean;
	/** How the connected device reaches this computer (1.26). */
	route?: ConnectionRouteKind;
}

/**
 * How a remote connection reaches the host (1.26): `lan` straight to the listener (LAN,
 * VPN, forwarded port), `relay` through a Pier Relay, `p2p` a peer-to-peer WebRTC path set
 * up through the relay.
 */
export type ConnectionRouteKind = "lan" | "relay" | "p2p";

/**
 * Another computer's Pier Host that this host paired with as a device (1.9). The desktop UI
 * reaches it through the local gateway (`ws://127.0.0.1:<port>/peer/<id>`), which runs the
 * secure channel with this host's own key.
 */
export interface PeerInfo {
	/** The peer's host id. */
	id: string;
	/** The peer's host name (refreshed on every connection). */
	name: string;
	/** Fingerprint of the peer's host key, pinned at pairing. */
	fingerprint: string;
	/** Candidate `host:port` addresses, the last one that worked first. */
	addresses: string[];
	/** Pier Relays the peer is registered with, tried after the addresses (1.26). */
	relays?: string[];
	/** This computer's device id on the peer. */
	deviceId: string;
	pairedAt: string;
	lastConnectedAt?: string;
	/** The peer's OS (`darwin`, `linux`, `win32`) and Pier Host version, once connected. */
	platform?: string;
	version?: string;
	/** Whether a desktop window is connected to it right now. */
	connected: boolean;
}

/** Remote access (LAN / Tailscale) listener state. */
export interface RemoteAccessStatus {
	enabled: boolean;
	/** Configured port (the actual port while running). */
	port: number;
	running: boolean;
	/** `host:port` candidates put into pairing codes. */
	addresses: string[];
	/** Fingerprint of the host's static key, shown to compare with the phone. */
	hostFingerprint: string;
	/** Whether the host is advertised over mDNS (`_pier._tcp`). */
	mdns: boolean;
	/** Why the listener is not running although enabled (e.g. port in use). */
	error?: string;
	/** Whether a pairing code is currently valid. */
	pairingActive: boolean;
	/** Connection through a Pier Relay (1.26). */
	relay?: RelayStatus;
	/** Whether connections through the relay may move to a peer-to-peer path (1.26). */
	p2p?: boolean;
}

/**
 * The host's registration with a Pier Relay (1.26): devices that cannot reach the host
 * directly connect through the relay, which only forwards ciphertext.
 */
export interface RelayStatus {
	enabled: boolean;
	/** Relay URL (`ws://` / `wss://`). */
	url?: string;
	/** Whether an access token is saved (the token itself is never returned). */
	hasToken: boolean;
	state: "off" | "connecting" | "online" | "error";
	/** Why the relay is not online although enabled. */
	error?: string;
	/** The relay's mode once connected: `private` (token required) or `open`. */
	mode?: "private" | "open";
}

/** A device that presented a valid pairing code and waits for the desktop user's decision. */
export interface PairingRequest {
	id: string;
	device: { name: string; platform?: string; model?: string; appVersion?: string };
	fingerprint: string;
	/** Remote network address of the device, for display. */
	address?: string;
	createdAt: string;
	expiresAt: string;
}

export type PairingResolution = "accepted" | "rejected" | "expired" | "cancelled";

// ---- Model providers and credentials (1.2) ----------------------------------------------

export const AuthMethodSchema = z.enum(["api_key", "oauth"]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/** Wire APIs a custom (models.json) provider can speak. */
export const CUSTOM_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;
export const CustomProviderApiSchema = z.enum(CUSTOM_PROVIDER_APIS);
export type CustomProviderApi = z.infer<typeof CustomProviderApiSchema>;

export const ProviderIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9._-]*$/, "Use lowercase letters, digits, '.', '_' or '-'");

export const CustomModelSchema = z.object({
	id: z.string().trim().min(1).max(200),
	name: z.string().trim().max(200).optional(),
	reasoning: z.boolean().optional(),
	/** Whether the model accepts image input. */
	images: z.boolean().optional(),
	contextWindow: z.number().int().positive().max(100_000_000).optional(),
	maxTokens: z.number().int().positive().max(100_000_000).optional(),
	/**
	 * Wire API of this model when it differs from the provider's, e.g. Claude models of a relay
	 * that are called with Anthropic Messages. The host derives the model's Base URL from the
	 * provider's. Added in 1.7.
	 */
	api: CustomProviderApiSchema.optional(),
});
export type CustomModel = z.infer<typeof CustomModelSchema>;

/** A model a NewAPI token can use, with the wire API the site says it supports best. */
export interface NewApiModel {
	id: string;
	name?: string;
	/** Detected from the site's `supported_endpoint_types` (or the model family on older sites). */
	api?: CustomProviderApi;
}

/** An OpenAI-, Anthropic- or Google-compatible endpoint stored in pi's `models.json`. */
export const CustomProviderSchema = z.object({
	id: ProviderIdSchema,
	name: z.string().trim().max(100).optional(),
	api: CustomProviderApiSchema,
	baseUrl: z
		.string()
		.trim()
		.max(2000)
		.regex(/^https?:\/\/\S+$/i, "Base URL must start with http:// or https://"),
	models: z.array(CustomModelSchema).min(1).max(500),
});
export type CustomProvider = z.infer<typeof CustomProviderSchema>;

export interface ProviderAuthStatus {
	configured: boolean;
	/** Which credential is in use when configured. */
	type?: AuthMethod;
	/** `stored` (auth.json), `environment`, `models_json_key`, `models_json_command`, `runtime`, ... */
	source?: string;
	/** Human readable source, e.g. an environment variable name. */
	label?: string;
}

/** A model provider known to the host: built in, from models.json, or registered by an extension. */
export interface ProviderInfo {
	id: string;
	name: string;
	/** Whether pi ships this provider. */
	builtin: boolean;
	/** API-key authentication. `interactive: false` means ambient-only (environment variables, cloud credentials). */
	apiKey?: { name: string; interactive: boolean };
	/** OAuth / subscription sign-in. */
	oauth?: { name: string; loginLabel?: string; subscription: boolean };
	status: ProviderAuthStatus;
	/** A credential for this provider is saved in auth.json (so it can be removed). */
	stored: boolean;
	modelCount: number;
	availableCount: number;
	/** Present when models.json defines this provider as a custom endpoint. Never contains secrets. */
	custom?: CustomProvider & { hasConfiguredKey: boolean };
}

export interface DefaultModelRef {
	provider: string;
	modelId: string;
}

export interface ProviderListResult {
	providers: ProviderInfo[];
	/** Default model for new sessions (pi global settings). */
	defaultModel?: DefaultModelRef;
	/** Whether the default model is currently usable. */
	defaultAvailable: boolean;
	/** Number of models with usable credentials. */
	availableCount: number;
	agentDir: string;
	/** models.json / composition problems reported by pi. */
	error?: string;
}

// ---- NewAPI sign-in (1.3) --------------------------------------------------------------

/** An API token (令牌) of a NewAPI account. The key itself never leaves the host. */
export interface NewApiToken {
	id: number;
	name: string;
	/** Masked key for display, e.g. `sk-abcd**********wxyz`. */
	maskedKey: string;
	/** NewAPI token status: 1 enabled, 2 disabled, 3 expired, 4 exhausted. */
	status: number;
	/** Empty for the user's default group. */
	group?: string;
	/** Unix seconds; absent when the token never expires. */
	expiresAt?: number;
	unlimitedQuota: boolean;
	remainQuota?: number;
	/** Models the token is restricted to, when model limits are enabled. */
	modelLimits?: string[];
}

/** A group the NewAPI user may create tokens in. */
export interface NewApiGroup {
	name: string;
	description?: string;
	/** Effective price ratio, or a label such as “自动”. */
	ratio?: number | string;
}

export interface NewApiAccount {
	site: {
		/** The site's `system_name`. */
		name: string;
		/** Normalized site address, e.g. `https://api.example.com`. */
		url: string;
		version?: string;
		logo?: string;
	};
	user: { id?: number; username: string; displayName?: string; group?: string };
	tokens: NewApiToken[];
	groups: NewApiGroup[];
}

/** Result of `newapi.authorizeStart` (1.4): open `authorizeUrl` in the user's browser. */
export interface NewApiAuthorizeStart {
	flowId: string;
	/** The site's consent page. The browser returns to a loopback address on the host. */
	authorizeUrl: string;
	site: NewApiAccount["site"];
	/** ISO time after which the flow is abandoned. */
	expiresAt: string;
}

/** Result of `newapi.authorizeWait` (1.4): the API token the user approved in the browser. */
export interface NewApiAuthorizeResult {
	site: NewApiAccount["site"];
	user: NewApiAccount["user"];
	token: { id: number; name: string; group?: string; maskedKey: string };
	/** Host-side reference to the token key, as from `newapi.useToken`. */
	keyRef: string;
	models: NewApiModel[];
	modelsError?: string;
}

/** Result of `newapi.login` / `newapi.verify`. */
export type NewApiLoginResult =
	| { status: "ok"; sessionId: string; account: NewApiAccount }
	/** The account asks for a two-factor code; answer with `newapi.verify`. */
	| { status: "verify"; sessionId: string; methods: string[] };

// ---- 云链API account (1.6) ------------------------------------------------------------

/**
 * A line (1.29): one address of the 云链API site. Every line reaches the same site and accounts,
 * so a login keeps working when the user switches lines.
 */
export interface AccountLine {
	id: string;
	/** Shown name, e.g. `国内线路`. */
	name: string;
	/** The site's address on this line, e.g. `https://api.yunnet.top`. */
	url: string;
	/** Who the line suits, e.g. `适合中国大陆网络`. */
	description?: string;
}

/** The lines of 云链API (1.29). The first one is the default. */
export const YUNLIAN_LINES: readonly AccountLine[] = [
	{ id: "cn", name: "国内线路", url: "https://api.yunnet.top", description: "适合中国大陆网络" },
	{ id: "global", name: "国际线路", url: "https://api.syixn.com", description: "适合海外网络" },
];

/** The 云链API site the personal center connects to by default (the domestic line). */
export const YUNLIAN_SITE_URL = "https://api.yunnet.top";

/** How the site shows amounts of quota (NewAPI `quota_per_unit`, `quota_display_type` and friends). */
export interface AccountQuotaDisplay {
	/** Quota units per US dollar. */
	perUnit: number;
	/** `USD`, `CNY`, `CUSTOM` or `TOKENS` (raw quota). */
	type: string;
	/** CNY per US dollar, for `CNY`. */
	usdRate?: number;
	/** Symbol and rate per US dollar, for `CUSTOM`. */
	customSymbol?: string;
	customRate?: number;
}

export interface AccountSite {
	name: string;
	url: string;
	version?: string;
	logo?: string;
	/** Whether new accounts may be registered with a password. */
	registerEnabled: boolean;
	/** Registration needs an email verification code (`account.sendCode`). */
	emailVerification: boolean;
	passwordLogin: boolean;
	/**
	 * The site can sign Pier in through the browser (NewAPI app authorization with the `account`
	 * scope, 1.11): `account.authorizeStart`. Every sign-in method of the website works there.
	 */
	browserLogin: boolean;
	/** Password sign-in and registration need a Turnstile check, which only the website can do. */
	turnstile: boolean;
	/** Third-party sign-in methods the website offers, e.g. `GitHub`, `LinuxDO`. */
	oauth: string[];
	quota: AccountQuotaDisplay;
}

/** The signed-in user, with the balance from `/api/user/self`. */
export interface AccountUser {
	id?: number;
	username: string;
	displayName?: string;
	email?: string;
	/** The user's own group (tokens without a group use it). */
	group?: string;
	/** Remaining quota in site units (see `AccountQuotaDisplay`). */
	quota: number;
	usedQuota: number;
	requestCount: number;
}

/** Result of `account.status`. */
export interface AccountStatus {
	site?: AccountSite;
	/** Why the site information could not be read, when it could not. */
	siteError?: string;
	/** The saved login, if any. Details and balance come from `account.overview`. */
	user?: NewApiAccount["user"];
	/** The lines the host can connect through (1.29); switch with `account.setLine`. */
	lines?: AccountLine[];
	/** The id of the line in use (1.29). */
	line?: string;
}

export interface AccountOverview {
	site: AccountSite;
	user: AccountUser;
	tokens: NewApiToken[];
	groups: NewApiGroup[];
}

/** Result of `account.authorizeStart` (1.11): open `authorizeUrl` in the user's browser. */
export interface AccountAuthorizeStart {
	flowId: string;
	/**
	 * The site's sign-in consent page. The browser returns to a loopback address on the host, or
	 * to the `redirectUri` the client passed (1.28).
	 */
	authorizeUrl: string;
	/** ISO time after which the flow is abandoned. */
	expiresAt: string;
}

/**
 * A browser callback caught by a loopback relay on this computer (`loopback.next`, 1.28): the
 * query string of the redirect, e.g. `?code=…&state=…`, to forward to the host that started
 * the sign-in.
 */
export interface LoopbackRequest {
	requestId: string;
	query: string;
}

/** The page the browser shows after a callback (`account.authorizeCallback` / `loopback.respond`, 1.28). */
export interface LoopbackCallbackPage {
	/** HTTP status: 200 when the sign-in succeeded. */
	status: number;
	title: string;
	detail: string;
}

/** Result of `account.login`, `account.verify`, `account.register` and `account.authorizeWait`. */
export type AccountLoginResult =
	| { status: "ok"; overview: AccountOverview }
	/** The account asks for a two-factor code; answer with `account.verify`. */
	| { status: "verify"; methods: string[] };

/** A question asked during a provider sign-in. */
export interface AuthPromptInfo {
	id: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: Array<{ id: string; label: string; description?: string }>;
}

/** Progress information shown during a provider sign-in. */
export type AuthNotice =
	| { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

// ---- pi extensions and packages (1.8) ---------------------------------------------------

/** Resource kinds pi loads from packages and resource directories. */
export const ExtensionResourceTypeSchema = z.enum(["extensions", "skills", "prompts", "themes"]);
export type ExtensionResourceType = z.infer<typeof ExtensionResourceTypeSchema>;

/** `user`: `<agentDir>/settings.json` (every workspace). `project`: `<workspace>/.pi/settings.json`. */
export const ExtensionScopeSchema = z.enum(["user", "project"]);
export type ExtensionScope = z.infer<typeof ExtensionScopeSchema>;

/** A pi package declared in `packages` of a settings file. */
export interface ExtensionPackageInfo {
	/** The source exactly as written in settings (`npm:…`, `git:…`, a URL, or a path). */
	source: string;
	scope: ExtensionScope;
	kind: "npm" | "git" | "local";
	/** The settings entry narrows which resources load (object form with filters). */
	filtered: boolean;
	/** Where the package lives on disk; undefined when it is not installed (or the path is missing). */
	installedPath?: string;
	/** From the package's `package.json`, when it has one. */
	name?: string;
	version?: string;
	description?: string;
}

/** One extension, skill, prompt template, or theme that pi discovers. */
export interface ExtensionResourceInfo {
	type: ExtensionResourceType;
	/** Absolute path of the resource file (`SKILL.md` for skills, `index.ts` for directory extensions). */
	path: string;
	/** Short display name (file name, `dir/index.ts`, or the skill directory). */
	name: string;
	/** Whether pi loads it. Disabled resources are listed so they can be enabled again. */
	enabled: boolean;
	/** Settings file the resource belongs to. */
	scope: ExtensionScope;
	/** `package`: from a pi package. `top-level`: a resource directory or a settings path entry. */
	origin: "package" | "top-level";
	/** Package source for `package`; `auto` (resource directory) or `local` (settings entry) for `top-level`. */
	source: string;
	/** Can be removed with `extension.delete` (top-level resources; skills/prompts/themes since 1.30). */
	deletable: boolean;
}

export interface ExtensionListResult {
	/** The pi agent directory holding the user settings. */
	agentDir: string;
	/** The workspace whose project settings were included, if any. */
	workspaceId?: string;
	packages: ExtensionPackageInfo[];
	resources: ExtensionResourceInfo[];
}

export interface ExtensionUpdateInfo {
	source: string;
	name: string;
	kind: "npm" | "git";
	scope: ExtensionScope;
}

// ---- pi package catalog (1.20) ----------------------------------------------------------

/** Resource kinds the pi package gallery (https://pi.dev/packages) tags packages with. */
export const ExtensionCatalogTypeSchema = z.enum(["extension", "skill", "theme", "prompt"]);
export type ExtensionCatalogType = z.infer<typeof ExtensionCatalogTypeSchema>;

/** Catalog order: most monthly downloads, most recently published, or by name. */
export const ExtensionCatalogSortSchema = z.enum(["downloads", "recent", "name"]);
export type ExtensionCatalogSort = z.infer<typeof ExtensionCatalogSortSchema>;

/** A package published to npm for pi (keyword `pi-package`), as listed by the gallery. */
export interface ExtensionCatalogPackage {
	/** npm package name. */
	name: string;
	/** What to pass to `extension.install` (`npm:<name>`). */
	source: string;
	description?: string;
	/** Latest published version. */
	version?: string;
	/** Publisher / author name. */
	author?: string;
	/** Resource kinds the package ships; empty when the gallery does not know. */
	types: ExtensionCatalogType[];
	monthlyDownloads?: number;
	/** When the latest version was published (ISO 8601). */
	publishedAt?: string;
	npmUrl: string;
	repositoryUrl?: string;
	/** The package's page in the pi gallery. */
	galleryUrl?: string;
}

export interface ExtensionCatalogResult {
	/** `pi.dev`: the official gallery. `npm`: the npm registry search (when the gallery is unreachable). */
	origin: "pi.dev" | "npm";
	packages: ExtensionCatalogPackage[];
	/** Matching packages in total. */
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
	/** Why the gallery was not used (with `origin: "npm"`). */
	notice?: string;
}

/** How open sessions picked up an extension change (1.8). */
export interface ExtensionReloadSummary {
	/** Idle sessions that were reloaded. */
	reloaded: number;
	/** Busy sessions left alone; they need `/reload` (`session.reload`) once idle. */
	pending: number;
	/** Sessions whose reload failed (see the host log). */
	failed: number;
}

// ---- pi settings files (1.15) -------------------------------------------------------------

/** One pi settings file: `<agentDir>/settings.json` (`user`) or `<workspace>/.pi/settings.json` (`project`). */
export interface PiSettingsFile {
	scope: ExtensionScope;
	/** Absolute path of the file. */
	path: string;
	/** The file exists (a missing file means every setting is at its default). */
	exists: boolean;
	/** The file's text as stored (without a byte-order mark); `""` when it does not exist. */
	text: string;
	/** The parsed settings; undefined when the text is not a JSON object (see `error`). */
	settings?: Record<string, unknown>;
	/** Why the text could not be parsed as a JSON object. */
	error?: string;
	/** Last modification time (ISO 8601), for `settings.write`'s `expectedModifiedAt`. */
	modifiedAt?: string;
}

export interface PiSettingsResult {
	/** The pi agent directory holding the user settings. */
	agentDir: string;
	user: PiSettingsFile;
	/** The workspace's project settings, when `workspaceId` was given. */
	project?: PiSettingsFile & { workspaceId: string };
}

/** Result of changing a settings file. */
export interface PiSettingsChangeResult {
	file: PiSettingsFile;
	/** False when the change left the file as it was (nothing was written or reloaded). */
	changed: boolean;
	reload: ExtensionReloadSummary;
}

// ---- Claude Code and Codex configuration files (1.23) -------------------------------------

/** Agent runtimes whose own configuration files Pier edits (1.23). */
export const AgentConfigRuntimeSchema = z.enum(["claude-code", "codex"]);
export type AgentConfigRuntime = z.infer<typeof AgentConfigRuntimeSchema>;

/**
 * Download routes of the native CLI installer (1.50). `official` downloads from Anthropic or GitHub;
 * `npmmirror` fetches Claude Code's npm package and the others relay Codex's GitHub release. Every
 * route is verified against the official SHA-256.
 */
export const AgentInstallSourceSchema = z.enum(["official", "npmmirror", "ghfast", "gh-proxy", "ghproxy"]);
export type AgentInstallSource = z.infer<typeof AgentInstallSourceSchema>;

/** Routes each runtime accepts, the default first. */
export const AGENT_INSTALL_SOURCES: Record<AgentConfigRuntime, readonly AgentInstallSource[]> = {
	"claude-code": ["official", "npmmirror"],
	codex: ["official", "ghfast", "gh-proxy", "ghproxy"],
};

/** A native CLI installation on the Host computer (1.32). Jobs survive client disconnects. */
export interface AgentInstallationStatus {
	runtime: AgentConfigRuntime;
	state: "idle" | "checking" | "downloading" | "verifying" | "installing" | "ready" | "error";
	/** The route of the current or last job (1.50). */
	source?: AgentInstallSource;
	version?: string;
	downloadedBytes?: number;
	totalBytes?: number;
	error?: string;
}

export interface AgentInstallationResult {
	installation: AgentInstallationStatus;
	agent: AgentRuntimeInfo;
}

/**
 * A configuration file of an agent runtime. `user`: in the runtime's configuration directory
 * (`~/.claude/settings.json`, `~/.codex/config.toml`). `project`: shared settings of a workspace
 * (`.claude/settings.json`, `.codex/config.toml`). `local`: Claude Code's personal settings of a
 * workspace (`.claude/settings.local.json`, usually not committed).
 */
export const AgentConfigScopeSchema = z.enum(["user", "project", "local"]);
export type AgentConfigScope = z.infer<typeof AgentConfigScopeSchema>;

/** `json` (Claude Code) or `toml` (Codex). */
export type AgentConfigFormat = "json" | "toml";

export interface AgentConfigFile {
	scope: AgentConfigScope;
	/** Absolute path of the file. */
	path: string;
	/** The file exists (a missing file means every setting is at its default). */
	exists: boolean;
	/** The file's text as stored (without a byte-order mark); `""` when it does not exist. */
	text: string;
	/**
	 * The parsed settings, as JSON (TOML dates become ISO strings, integers beyond the safe
	 * range become strings); undefined when the text cannot be parsed (see `error`).
	 */
	settings?: Record<string, unknown>;
	/** Why the text could not be parsed. */
	error?: string;
	/** Last modification time (ISO 8601), for `agentConfig.write`'s `expectedModifiedAt`. */
	modifiedAt?: string;
}

export interface AgentConfigResult {
	runtime: AgentConfigRuntime;
	format: AgentConfigFormat;
	/** The runtime's configuration directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, or the default). */
	configDir: string;
	/** Scopes the runtime reads, lowest precedence first. */
	scopes: AgentConfigScope[];
	/** The user file, then (with `workspaceId`) the workspace's files; lowest precedence first. */
	files: AgentConfigFile[];
	/** The workspace whose files were included. */
	workspaceId?: string;
	/** The runtime's CLI is installed on the host (the files can be edited either way). */
	available: boolean;
}

/** Result of changing an agent configuration file. */
export interface AgentConfigChangeResult {
	file: AgentConfigFile;
	/** False when the change left the file as it was (nothing was written). */
	changed: boolean;
}
