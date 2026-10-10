import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
	type AccountLine,
	type AgentConfigRuntime,
	type AgentConfigScope,
	type AppUpdateStatus,
	type EventFrame,
	type ExtensionReloadSummary,
	type ExtensionScope,
	type HostInfo,
	isMethodName,
	isProtocolCompatible,
	type KnownMessages,
	LOCAL_ONLY_EVENTS,
	LOCAL_ONLY_METHODS,
	type MethodName,
	MethodParamsSchemas,
	type MethodResult,
	type ParsedMethodParams,
	type PierHostEvent,
	PierProtocolError,
	PROTOCOL_VERSION,
	parseClientFrame,
	type ResourceRuntime,
	type ResponseFrame,
	type WorkspaceInfo,
	YUNLIAN_LINES,
} from "@pier/protocol";
import { type BrowserOptions, LocalBrowsers } from "./browser/browsers.ts";
import { BrowserControllers } from "./browser/controllers.ts";
import { HostTunnels } from "./browser/tunnels.ts";
import { ClaudeCodeRuntime, type ClaudeCodeRuntimeOptions, claudeConfigDir } from "./claude/claude-runtime.ts";
import { CodexRuntime, type CodexRuntimeOptions, codexHome } from "./codex/codex-runtime.ts";
import { ConfigStore } from "./config.ts";
import {
	badFrameResponse,
	Connection,
	type ConnectionKind,
	type RemoteDevice,
	type RequestHandler,
	type Transport,
} from "./connection.ts";
import { GitService } from "./git.ts";
import { listHostDirectories } from "./host-directories.ts";
import { HostStatsSampler } from "./host-stats.ts";
import type { ManagedSession } from "./managed-session.ts";
import { LoopbackRelays } from "./oauth-loopback.ts";
import { detectPackageManagers } from "./package-managers.ts";
import {
	accountPath,
	archivedSessionsPath,
	configPath,
	defaultPierDir,
	extensionTrashDir,
	locksDir,
	peersPath,
	sessionTrashDir,
} from "./paths.ts";
import { PeerManager, type PeerManagerOptions } from "./peers/peers.ts";
import { AccountManager } from "./pi/account.ts";
import { PI_VERSION, PiEnvironment, type PiEnvironmentOptions } from "./pi/environment.ts";
import { ExtensionManager, type ExtensionTarget } from "./pi/extensions.ts";
import { NewApiManager } from "./pi/newapi.ts";
import { PackageCatalog, type PackageCatalogOptions } from "./pi/package-catalog.ts";
import { PiRuntime } from "./pi/pi-runtime.ts";
import { ProviderManager } from "./pi/providers.ts";
import { PiSettingsFiles } from "./pi/settings-files.ts";
import { RemoteAccess, type RemoteAccessOptions } from "./remote/remote-access.ts";
import { AgentConfigFiles } from "./runtimes/agent-config.ts";
import { AgentInstaller, type AgentInstallerOptions } from "./runtimes/installation.ts";
import { McpManager } from "./runtimes/mcp.ts";
import { testMcp } from "./runtimes/mcp-client.ts";
import { SkillManager } from "./runtimes/skills.ts";
import { ScheduledTasks } from "./scheduled-tasks.ts";
import { SessionArchiveStore } from "./session-archive.ts";
import { SessionPool } from "./session-pool.ts";
import type { AppShell, ShellMethod } from "./shell.ts";
import { HostTerminals } from "./terminals.ts";
import {
	authorizeWorkspaceFilePreview,
	deleteWorkspacePath,
	listWorkspaceDirectory,
	previewWorkspaceFile,
	readWorkspaceBytes,
	readWorkspaceFile,
	writeWorkspaceFile,
} from "./workspace-files.ts";
import { WorkspaceUploads } from "./workspace-uploads.ts";

export const PIER_HOST_VERSION = "0.2.36";

/** How Pier introduces itself to NewAPI sites (their login sessions list shows the system). */
function pierUserAgent(): string {
	const system = { win32: "Windows", darwin: "Mac OS", linux: "Linux" }[process.platform as string];
	return `Pier/${PIER_HOST_VERSION}${system ? ` (${system})` : ""}`;
}

/** Unauthenticated connections are closed after this long without a successful `host.hello`. */
export const HELLO_TIMEOUT_MS = 10_000;

export interface PierHostOptions {
	pierDir?: string;
	/** A ready environment, or options to create one. */
	env?: PiEnvironment | PiEnvironmentOptions;
	/** Token local clients must present in `host.hello`. Required for local connections. */
	localToken: string;
	uiTimeoutMs?: number;
	idleTimeoutMs?: number;
	eventLogCapacity?: number;
	sweepIntervalMs?: number;
	/** Remote access overrides (tests, CLI flags). Saved settings live in config.json. */
	remote?: RemoteAccessOptions;
	/** Outgoing connections to paired computers (tests). */
	peers?: PeerManagerOptions;
	/** Diagnostic log sink (stderr in the sidecar). */
	log?: (message: string) => void;
	/** Site of the personal center (tests). Defaults to 云链API and its lines. */
	accountSite?: string;
	/** Lines of the personal center's site (tests); win over `accountSite`. */
	accountLines?: AccountLine[];
	/** Where `extension.search` looks (tests). Defaults to pi.dev with the npm registry as fallback. */
	packageCatalog?: PackageCatalogOptions;
	/** The desktop app the host runs in (its updater and terminals), when there is one. */
	shell?: AppShell;
	/**
	 * Agent runtimes besides pi (1.22). Each is on by default and available when its CLI is
	 * installed; `false` turns one off.
	 */
	agents?: {
		claudeCode?: ClaudeCodeRuntimeOptions | false;
		codex?: CodexRuntimeOptions | false;
	};
	/**
	 * Configuration directories of Claude Code and Codex for `agentConfig.*` (tests). Default to
	 * the runtimes' own (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, else `~/.claude` / `~/.codex`).
	 */
	agentConfigDirs?: Partial<Record<AgentConfigRuntime, string>>;
	/** Shared skill home (tests); defaults to the current user's home. */
	resourceHome?: string;
	/** Installer dependencies for tests; production always downloads official native releases. */
	agentInstaller?: Pick<AgentInstallerOptions, "fetch" | "probe" | "homeDirectory" | "configurePath">;
	browser?: BrowserOptions;
}

/** Remote methods recorded in the audit log. */
const AUDITED_METHODS = new Set<MethodName>([
	"skills.save",
	"skills.import",
	"skills.setEnabled",
	"skills.delete",
	"mcp.save",
	"mcp.setEnabled",
	"mcp.delete",
	"mcp.test",
	"tunnel.open",
	"browser.attach",
	"browser.action",
	"task.create",
	"task.update",
	"task.setStatus",
	"task.delete",
	"task.run",
	"task.stop",
	"task.readRun",
	"session.create",
	"session.open",
	"session.close",
	"session.delete",
	"session.archive",
	"session.cleanup",
	"session.fork",
	"session.rename",
	"session.prompt",
	"session.steer",
	"session.followUp",
	"session.abort",
	"session.compact",
	"session.reload",
	"model.set",
	"thinking.set",
	"ui.respond",
	// Managing the computer (open to paired devices since 1.10).
	"workspace.add",
	"workspace.remove",
	"workspace.setPolicy",
	"workspace.authorizeFilePreview",
	"workspace.writeFile",
	"workspace.deletePath",
	"workspace.uploadStart",
	"workspace.uploadFinish",
	"model.setDefault",
	"provider.login",
	"provider.logout",
	"provider.saveCustom",
	"provider.removeCustom",
	"newapi.useToken",
	"newapi.authorizeStart",
	"account.setLine",
	"account.authorizeStart",
	"account.login",
	"account.register",
	"account.useToken",
	"account.logout",
	"extension.install",
	"extension.remove",
	"extension.update",
	"extension.setEnabled",
	"extension.delete",
	"update.install",
	"runtime.install",
	"settings.update",
	"settings.write",
	"agentConfig.update",
	"agentConfig.write",
	// Git source control (1.28).
	"git.stage",
	"git.unstage",
	"git.discard",
	"git.commit",
	"git.checkout",
	"git.deleteBranch",
	"git.fetch",
	"git.pull",
	"git.push",
	"git.stash",
	"git.init",
	// Opening a shell on this computer (1.18); what is typed into it is not recorded.
	"terminal.open",
]);

function auditDetail(method: MethodName, params: Record<string, unknown>): Record<string, unknown> | undefined {
	switch (method) {
		case "skills.save":
		case "skills.import":
		case "skills.setEnabled":
		case "skills.delete":
		case "mcp.save":
		case "mcp.setEnabled":
		case "mcp.delete":
		case "mcp.test":
			return { runtime: params.runtime, scope: params.scope, name: params.name, workspaceId: params.workspaceId };
		case "tunnel.open":
			return { host: params.host, port: params.port };
		case "browser.attach":
			return { workspaceId: params.workspaceId, browserId: params.browserId };
		case "browser.action":
			return { workspaceId: params.workspaceId, action: (params.command as { action?: string })?.action };
		case "task.create":
			return { workspaceId: params.workspaceId, runtime: params.runtime };
		case "task.update":
		case "task.setStatus":
		case "task.delete":
		case "task.run":
		case "task.stop":
			return { taskId: params.taskId };
		case "task.readRun":
			return { runId: params.runId };
		case "runtime.install":
			return { runtime: params.runtime };
		case "session.prompt":
		case "session.steer":
		case "session.followUp":
			return {
				textLength: typeof params.text === "string" ? params.text.length : 0,
				images: Array.isArray(params.images) ? params.images.length : 0,
			};
		case "ui.respond": {
			const response = (params.response ?? {}) as Record<string, unknown>;
			return {
				requestId: params.requestId,
				...(response.decision ? { decision: response.decision } : {}),
				...(response.confirmed !== undefined ? { confirmed: response.confirmed } : {}),
				...(response.cancelled ? { cancelled: true } : {}),
			};
		}
		case "model.set":
			return { provider: params.provider, modelId: params.modelId };
		case "thinking.set":
			return { level: params.level };
		case "workspace.add":
			return { path: params.path, ...(params.policy ? { policy: params.policy } : {}) };
		case "workspace.remove":
			return { workspaceId: params.workspaceId };
		case "session.archive":
			return { workspaceId: params.workspaceId, archived: params.archived };
		case "session.cleanup":
			return {
				workspaceId: params.workspaceId,
				action: params.action,
				...(params.modifiedBefore ? { modifiedBefore: params.modifiedBefore } : {}),
				...(params.scope ? { scope: params.scope } : {}),
				...(params.dryRun ? { dryRun: true } : {}),
			};
		case "workspace.setPolicy":
			return { workspaceId: params.workspaceId, policy: params.policy };
		case "workspace.writeFile":
			return {
				workspaceId: params.workspaceId,
				path: params.path,
				bytes: typeof params.text === "string" ? Buffer.byteLength(params.text) : 0,
			};
		case "workspace.deletePath":
			return { workspaceId: params.workspaceId, path: params.path };
		case "workspace.authorizeFilePreview":
			return { workspaceId: params.workspaceId, path: params.path, expectedRealPath: params.expectedRealPath };
		case "workspace.uploadStart":
			return {
				workspaceId: params.workspaceId,
				path: params.path,
				bytes: params.size,
				...(params.overwrite ? { overwrite: true } : {}),
			};
		case "workspace.uploadFinish":
			return { uploadId: params.uploadId };
		case "model.setDefault":
			return { provider: params.provider, modelId: params.modelId };
		case "provider.login":
			return { providerId: params.providerId, method: params.method };
		case "provider.logout":
		case "provider.removeCustom":
			return { providerId: params.providerId };
		case "provider.saveCustom": {
			const provider = (params.provider ?? {}) as Record<string, unknown>;
			return { providerId: provider.id };
		}
		case "extension.install":
		case "extension.remove":
			return { source: params.source, ...(params.scope ? { scope: params.scope } : {}) };
		case "extension.update":
			return params.source ? { source: params.source } : undefined;
		case "extension.setEnabled":
			return { type: params.type, path: params.path, enabled: params.enabled };
		case "extension.delete":
			return { type: params.type ?? "extensions", path: params.path };
		case "settings.update":
			return {
				scope: params.scope,
				...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
				keys: Array.isArray(params.changes)
					? params.changes.map((c) => ((c as { path?: string[] }).path ?? []).join("."))
					: [],
			};
		case "settings.write":
			return {
				scope: params.scope,
				...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
				bytes: typeof params.text === "string" ? Buffer.byteLength(params.text) : 0,
			};
		case "git.stage":
		case "git.unstage":
		case "git.discard":
			return {
				workspaceId: params.workspaceId,
				paths: Array.isArray(params.paths) ? params.paths.length : "all",
			};
		case "git.commit":
			return {
				workspaceId: params.workspaceId,
				...(params.amend ? { amend: true } : {}),
				...(params.all ? { all: true } : {}),
			};
		case "git.checkout":
		case "git.deleteBranch":
			return { workspaceId: params.workspaceId, branch: params.branch, ...(params.create ? { create: true } : {}) };
		case "git.fetch":
		case "git.pull":
		case "git.push":
		case "git.stash":
		case "git.init":
			return { workspaceId: params.workspaceId, ...(params.action ? { action: params.action } : {}) };
		case "terminal.open":
			return params.cwd ? { cwd: params.cwd } : undefined;
		case "agentConfig.update":
			// Key names only: values may be API keys.
			return {
				runtime: params.runtime,
				scope: params.scope,
				...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
				keys: Array.isArray(params.changes)
					? params.changes.map((c) => ((c as { path?: string[] }).path ?? []).join("."))
					: [],
			};
		case "agentConfig.write":
			return {
				runtime: params.runtime,
				scope: params.scope,
				...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
				bytes: typeof params.text === "string" ? Buffer.byteLength(params.text) : 0,
			};
		default:
			return undefined;
	}
}

interface HandlerContext {
	connection: Connection;
	after(fn: () => void): void;
}

type Handlers = {
	[M in MethodName]: (ctx: HandlerContext, params: ParsedMethodParams<M>) => Promise<MethodResult<M>> | MethodResult<M>;
};

function tokensEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function toProtocolError(error: unknown): PierProtocolError {
	if (error instanceof PierProtocolError) return error;
	return new PierProtocolError("INTERNAL", error instanceof Error ? error.message : String(error));
}

/**
 * Pier Host: owns workspaces and the session pool and serves the Pier protocol
 * to any number of connections, independent of the transport.
 */
export class PierHost implements RequestHandler {
	readonly pierDir: string;
	readonly config: ConfigStore;
	readonly env: PiEnvironment;
	readonly pool: SessionPool;
	readonly tasks: ScheduledTasks;
	readonly remote: RemoteAccess;
	readonly providers: ProviderManager;
	readonly newapi: NewApiManager;
	readonly account: AccountManager;
	readonly loopback = new LoopbackRelays();
	readonly browserControllers = new BrowserControllers();
	readonly tunnels = new HostTunnels();
	readonly browsers: LocalBrowsers;
	readonly extensions: ExtensionManager;
	readonly packageCatalog: PackageCatalog;
	readonly settings: PiSettingsFiles;
	readonly agentConfig: AgentConfigFiles;
	readonly skills: SkillManager;
	readonly mcp: McpManager;
	readonly agentInstaller: AgentInstaller;
	readonly peers: PeerManager;
	private readonly log: (message: string) => void;
	private readonly connections = new Set<Connection>();
	private readonly localToken: string;
	private readonly handlers: Handlers;
	private readonly stats = new HostStatsSampler();
	private readonly shell: AppShell | undefined;
	private readonly terminals: HostTerminals;
	private readonly uploads: WorkspaceUploads;
	private readonly git = new GitService();
	private readonly offShellStatus: (() => void) | undefined;
	private shuttingDown = false;

	private constructor(options: PierHostOptions, env: PiEnvironment) {
		if (!options.localToken || options.localToken.length < 16) {
			throw new Error("PierHost requires a local token of at least 16 characters");
		}
		this.pierDir = options.pierDir ?? defaultPierDir();
		mkdirSync(this.pierDir, { recursive: true, mode: 0o700 });
		this.config = new ConfigStore(configPath(this.pierDir));
		this.env = env;
		this.localToken = options.localToken;
		const log = options.log ?? (() => {});
		this.log = log;
		const agents = options.agents ?? {};
		const managedDirectory = join(this.pierDir, "agents");
		const installationHome = options.agentInstaller?.homeDirectory;
		this.pool = new SessionPool({
			runtimes: [
				new PiRuntime(env, (workspaceId, command, browserId, signal) =>
					this.browserControllers.action(workspaceId, command, browserId, signal),
				),
				...(agents.claudeCode === false
					? []
					: [new ClaudeCodeRuntime({ log, managedDirectory, installationHome, ...agents.claudeCode })]),
				...(agents.codex === false
					? []
					: [new CodexRuntime({ log, managedDirectory, installationHome, ...agents.codex })]),
			],
			log,
			config: this.config,
			locksDir: locksDir(this.pierDir),
			trashDir: sessionTrashDir(this.pierDir),
			archive: new SessionArchiveStore(archivedSessionsPath(this.pierDir), options.log),
			...(options.uiTimeoutMs === undefined ? {} : { uiTimeoutMs: options.uiTimeoutMs }),
			...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
			...(options.eventLogCapacity === undefined ? {} : { eventLogCapacity: options.eventLogCapacity }),
			...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
			onSessionReplaced: (session) => this.broadcast({ type: "session.listChanged", workspaceId: session.workspaceId }),
			onSessionActivity: (session) => {
				this.tasks?.activity(session);
				const summary = session.summary();
				this.broadcast({
					type: "session.activity",
					workspaceId: summary.workspaceId,
					sessionId: summary.id,
					state: summary.state,
					pendingUi: summary.pendingUi ?? 0,
				});
			},
			onSessionClosed: (session) => {
				this.tasks?.sessionClosed(session);
				for (const connection of this.connections) connection.subscriptions.delete(session);
				this.broadcast({ type: "session.listChanged", workspaceId: session.workspaceId });
			},
		});
		this.tasks = new ScheduledTasks({
			file: join(this.pierDir, "scheduled-tasks.json"),
			pool: this.pool,
			workspace: (id) => this.requireWorkspace(id),
			log,
			onChanged: () => this.broadcast({ type: "task.changed" }),
			onSessionCreated: (workspaceId) => this.broadcast({ type: "session.listChanged", workspaceId }),
		});
		this.extensions = new ExtensionManager({
			agentDir: env.agentDir,
			trashDir: extensionTrashDir(this.pierDir),
			onProgress: (progress) => this.broadcast({ type: "extension.progress", ...progress }),
			log,
		});
		this.agentInstaller = new AgentInstaller(managedDirectory, {
			...options.agentInstaller,
			onInstalled: (runtime) => {
				this.pool.runtime(runtime).installationChanged?.();
				this.broadcast({ type: "runtime.changed", runtime });
			},
		});
		this.packageCatalog = new PackageCatalog({ userAgent: pierUserAgent(), log, ...options.packageCatalog });
		this.settings = new PiSettingsFiles(env.agentDir);
		this.agentConfig = new AgentConfigFiles({
			"claude-code": () =>
				options.agentConfigDirs?.["claude-code"] ??
				claudeConfigDir(agents.claudeCode ? agents.claudeCode.configDir : undefined),
			codex: () => options.agentConfigDirs?.codex ?? codexHome(agents.codex ? agents.codex.env : undefined),
		});
		this.skills = new SkillManager({
			home: options.resourceHome ?? homedir(),
			agentDir: env.agentDir,
			trashDir: join(this.pierDir, "trash", "skills"),
			extensions: this.extensions,
			configs: this.agentConfig,
		});
		this.mcp = new McpManager({
			home: options.resourceHome,
			agentDir: env.agentDir,
			pierDir: this.pierDir,
			configs: this.agentConfig,
		});
		env.setMcpConfig((cwd) => this.mcp.piConfig(cwd));
		this.providers = new ProviderManager(env, {
			onChanged: () => {
				// Open sessions keep the model object they resolved; pick up edited capabilities.
				for (const session of this.pool.all()) session.refreshModel();
				this.broadcast({ type: "provider.changed" });
			},
			log,
		});
		this.newapi = new NewApiManager({ log, userAgent: pierUserAgent() });
		this.account = new AccountManager(this.newapi, {
			lines:
				options.accountLines ??
				(options.accountSite ? [{ id: "custom", name: "自定义站点", url: options.accountSite }] : YUNLIAN_LINES),
			file: accountPath(this.pierDir),
			log,
		});
		this.remote = new RemoteAccess(
			this.pierDir,
			this.config,
			{
				hostId: () => this.config.hostId,
				hostName: () => this.config.hostName,
				connect: (transport, device) => this.connect(transport, "remote", device),
				broadcastLocal: (event) => this.broadcast(event),
				remoteConnections: () => [...this.connections].filter((c) => c.kind === "remote"),
				log,
			},
			options.remote,
		);
		this.peers = new PeerManager(
			peersPath(this.pierDir),
			{
				hostId: () => this.config.hostId,
				hostName: () => this.config.hostName,
				hostVersion: () => PIER_HOST_VERSION,
				identity: () => this.remote.identity,
				verifyLocalToken: (token) => this.verifyLocalToken(token),
				broadcastLocal: (event) => this.broadcast(event),
				log,
				p2pEnabled: () => this.remote.p2pEnabled,
			},
			options.peers,
		);
		this.shell = options.shell;
		this.browsers = new LocalBrowsers(
			this.pierDir,
			(peerId) => this.peers.openClient(peerId),
			this.browserControllers,
			options.browser,
		);
		this.terminals = new HostTerminals(this.shell, { log });
		this.uploads = new WorkspaceUploads({ log });
		this.offShellStatus = this.shell?.onUpdateStatus((status) => this.broadcast({ type: "update.status", status }));
		this.handlers = this.createHandlers();
	}

	static async create(options: PierHostOptions): Promise<PierHost> {
		const env = options.env instanceof PiEnvironment ? options.env : await PiEnvironment.create(options.env ?? {});
		const host = new PierHost(options, env);
		await host.providers.fillCapabilities().catch(() => 0);
		host.pool.startSweeper();
		await host.remote.apply();
		host.tasks.start();
		return host;
	}

	info(): HostInfo {
		return {
			hostId: this.config.hostId,
			hostName: this.config.hostName,
			version: PIER_HOST_VERSION,
			protocolVersion: PROTOCOL_VERSION,
			platform: platform(),
			piVersion: PI_VERSION,
			agentDir: this.env.agentDir,
			...(this.terminals.supported ? { terminals: true } : {}),
		};
	}

	/** The desktop app's updater status; `unsupported` without a desktop app that reports one. */
	updateStatus(): AppUpdateStatus {
		return (
			this.shell?.updateStatus ?? {
				state: "unsupported",
				currentVersion: PIER_HOST_VERSION,
				autoCheck: false,
				downloaded: 0,
			}
		);
	}

	private async updateRequest(method: ShellMethod): Promise<AppUpdateStatus> {
		const shell = this.shell;
		if (!shell?.updateStatus || shell.updateStatus.state === "unsupported") {
			throw new PierProtocolError(
				"UNSUPPORTED",
				"Pier on this computer cannot update itself: it is not an installed release of the desktop app",
			);
		}
		try {
			return await shell.request(method);
		} catch (error) {
			throw new PierProtocolError("INTERNAL", error instanceof Error ? error.message : String(error));
		}
	}

	/** Send a host-scoped event to local connections only. */
	private broadcastLocal(event: PierHostEvent): void {
		const frame: EventFrame = { type: "evt", event };
		for (const connection of this.connections) {
			if (connection.authenticated && connection.kind === "local") connection.send(frame);
		}
	}

	/** Whether `token` is this host's local token (the desktop UI and local tools). */
	verifyLocalToken(token: unknown): boolean {
		return typeof token === "string" && tokensEqual(token, this.localToken);
	}

	get connectionCount(): number {
		return this.connections.size;
	}

	/** Attach a new transport. Feed incoming text frames to `connection.receive()`. */
	connect(transport: Transport, kind: ConnectionKind, device?: RemoteDevice): Connection {
		const connection = new Connection(kind, transport, this, device);
		this.connections.add(connection);
		const timer = setTimeout(() => {
			if (!connection.authenticated) connection.close(4401, "host.hello timeout");
		}, HELLO_TIMEOUT_MS);
		timer.unref?.();
		return connection;
	}

	disconnected(connection: Connection): void {
		this.browsers.connectionClosed(connection);
		this.browserControllers.connectionClosed(connection);
		this.tunnels.connectionClosed(connection);
		this.connections.delete(connection);
		this.providers.connectionClosed(connection.connectionId);
		this.newapi.connectionClosed(connection.connectionId);
		this.loopback.connectionClosed(connection.connectionId);
		this.terminals.connectionClosed(connection);
		this.uploads.connectionClosed(connection.connectionId);
		for (const session of connection.subscriptions) session.unsubscribe(connection.connectionId);
		connection.subscriptions.clear();
	}

	/** Send a host-scoped event to every authenticated connection (local-only events only to local ones). */
	broadcast(event: PierHostEvent): void {
		const frame: EventFrame = { type: "evt", event };
		const localOnly = LOCAL_ONLY_EVENTS.has(event.type);
		for (const connection of this.connections) {
			if (!connection.authenticated) continue;
			if (localOnly && connection.kind !== "local") continue;
			connection.send(frame);
		}
	}

	async handle(connection: Connection, raw: string): Promise<{ response: ResponseFrame; after: Array<() => void> }> {
		const after: Array<() => void> = [];
		const frame = parseClientFrame(raw);
		if (!frame) return { response: badFrameResponse(raw), after };
		const fail = (error: unknown): { response: ResponseFrame; after: Array<() => void> } => ({
			response: { type: "res", id: frame.id, ok: false, error: toProtocolError(error).toJSON() },
			after: [],
		});

		try {
			if (!isMethodName(frame.method)) {
				throw new PierProtocolError("BAD_REQUEST", `Unknown method ${frame.method}`);
			}
			const method = frame.method;
			if (!connection.authenticated && method !== "host.hello") {
				throw new PierProtocolError("UNAUTHENTICATED", "Call host.hello first");
			}
			if (connection.kind !== "local" && LOCAL_ONLY_METHODS.has(method)) {
				throw new PierProtocolError("FORBIDDEN", `${method} is only available on this computer`);
			}
			if (this.shuttingDown) throw new PierProtocolError("CONFLICT", "Host is shutting down");
			const schema = MethodParamsSchemas[method];
			const parsed = schema.safeParse(frame.params);
			if (!parsed.success) {
				throw new PierProtocolError("BAD_REQUEST", `Invalid params for ${method}`, parsed.error.issues);
			}
			if (connection.device && AUDITED_METHODS.has(method)) {
				const params = (parsed.data ?? {}) as Record<string, unknown>;
				const detail = auditDetail(method, params);
				this.remote.record({
					event: method,
					deviceId: connection.device.id,
					deviceName: connection.device.name,
					...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
					...(detail ? { detail } : {}),
				});
			}
			const handler = this.handlers[method] as (ctx: HandlerContext, params: unknown) => unknown;
			const result = await handler({ connection, after: (fn) => after.push(fn) }, parsed.data);
			return { response: { type: "res", id: frame.id, ok: true, result: result ?? {} }, after };
		} catch (error) {
			const response = fail(error);
			if (frame.method === "host.hello" && !connection.authenticated) {
				response.after.push(() => connection.close(4401, "Authentication failed"));
			}
			return response;
		}
	}

	private requireWorkspace(workspaceId: string): WorkspaceInfo {
		const workspace = this.config.getWorkspace(workspaceId);
		if (!workspace) throw new PierProtocolError("NOT_FOUND", `Workspace ${workspaceId} not found`);
		return workspace;
	}

	private extensionTarget(workspaceId: string | undefined): ExtensionTarget | undefined {
		if (!workspaceId) return undefined;
		const workspace = this.requireWorkspace(workspaceId);
		return { id: workspace.id, path: workspace.path };
	}

	/**
	 * Apply an extension change to open sessions: idle ones reload right away (like `/reload`),
	 * busy ones are left for the user to reload. `workspaceId` limits it to one workspace
	 * (project settings changed).
	 */
	private async applyExtensionChange(workspaceId?: string): Promise<ExtensionReloadSummary> {
		const summary = await this.reloadSessions(workspaceId, "extension change");
		this.broadcast({ type: "extension.changed", ...(workspaceId ? { workspaceId } : {}) });
		return summary;
	}

	/** Reload idle open sessions (of one workspace, when given) so they pick up changed settings. */
	private async reloadSessions(workspaceId: string | undefined, reason: string): Promise<ExtensionReloadSummary> {
		const summary: ExtensionReloadSummary = { reloaded: 0, pending: 0, failed: 0 };
		for (const session of this.pool.all()) {
			if (workspaceId && session.workspaceId !== workspaceId) continue;
			// pi settings and extensions only apply to pi sessions.
			if (!session.capabilities.reload) continue;
			if (session.busy) {
				summary.pending++;
				continue;
			}
			try {
				await session.reload();
				summary.reloaded++;
			} catch (error) {
				summary.failed++;
				this.log(`reload after ${reason} failed for ${session.id}: ${error instanceof Error ? error.message : error}`);
			}
		}
		return summary;
	}

	/**
	 * Apply a settings file change: reload the affected idle sessions (unless `reload` is false)
	 * and tell every connection. Settings also hold packages and the default model, so the
	 * extension and provider views refresh too.
	 */
	private async applySettingsChange(
		scope: ExtensionScope,
		workspaceId: string | undefined,
		reload: boolean,
	): Promise<ExtensionReloadSummary> {
		const target = scope === "project" ? workspaceId : undefined;
		const summary = reload
			? await this.reloadSessions(target, "settings change")
			: { reloaded: 0, pending: 0, failed: 0 };
		this.broadcast({ type: "settings.changed", scope, ...(target ? { workspaceId: target } : {}) });
		this.broadcast({ type: "extension.changed", ...(target ? { workspaceId: target } : {}) });
		if (scope === "user") this.broadcast({ type: "provider.changed" });
		return summary;
	}

	private settingsWorkspace(scope: ExtensionScope, workspaceId: string | undefined): string | undefined {
		if (scope === "project" && !workspaceId)
			throw new PierProtocolError("BAD_REQUEST", "Project scope needs a workspaceId");
		return scope === "project" && workspaceId ? this.requireWorkspace(workspaceId).path : undefined;
	}

	/** The workspace directory an agent configuration file of `scope` lives in (none for `user`). */
	private agentConfigWorkspace(scope: AgentConfigScope, workspaceId: string | undefined): string | undefined {
		if (scope === "user") return undefined;
		if (!workspaceId) throw new PierProtocolError("BAD_REQUEST", `The ${scope} scope needs a workspaceId`);
		return this.requireWorkspace(workspaceId).path;
	}

	/**
	 * A Claude Code or Codex configuration file changed: the runtime forgets what it read from
	 * it (models), and every connection is told. Open sessions keep their settings until reopened.
	 */
	private applyAgentConfigChange(
		runtime: AgentConfigRuntime,
		scope: AgentConfigScope,
		workspaceId: string | undefined,
	): void {
		this.pool.runtimes.find((r) => r.id === runtime)?.configChanged?.();
		this.broadcast({
			type: "agentConfig.changed",
			runtime,
			scope,
			...(scope !== "user" && workspaceId ? { workspaceId } : {}),
		});
	}

	private subscribeConnection(
		ctx: HandlerContext,
		session: ManagedSession,
		sinceSeq?: number,
		epoch?: string,
		known?: KnownMessages,
	) {
		const pending = session.subscribe(ctx.connection, sinceSeq, epoch, known);
		ctx.connection.subscriptions.add(session);
		ctx.after(pending.start);
		return pending.result;
	}

	private async applyResourceChange(runtime: ResourceRuntime, workspaceId?: string): Promise<void> {
		if (runtime === "pi") await this.applyExtensionChange(workspaceId);
		else this.applyAgentConfigChange(runtime, "user", workspaceId);
		this.broadcast({ type: "resources.changed", runtime, ...(workspaceId ? { workspaceId } : {}) });
	}

	private createHandlers(): Handlers {
		return {
			"skills.list": (_ctx, p) => this.skills.list(p.runtime, this.extensionTarget(p.workspaceId)),
			"skills.read": (_ctx, p) => this.skills.read(p.runtime, p.path, this.extensionTarget(p.workspaceId)),
			"skills.save": async (_ctx, p) => {
				const result = await this.skills.save(
					p.runtime,
					p.scope,
					p.name,
					p.text,
					this.extensionTarget(p.workspaceId),
					p.path,
					p.expectedRevision,
				);
				await this.applyResourceChange(p.runtime, p.workspaceId);
				return result;
			},
			"skills.import": async (_ctx, p) => {
				const result = await this.skills.import(
					p.runtime,
					p.scope,
					p.sourcePath,
					p.name,
					this.extensionTarget(p.workspaceId),
				);
				await this.applyResourceChange(p.runtime, p.workspaceId);
				return result;
			},
			"skills.setEnabled": async (_ctx, p) => {
				const result = await this.skills.setEnabled(p.runtime, p.path, p.enabled, this.extensionTarget(p.workspaceId));
				await this.applyResourceChange(p.runtime, p.workspaceId);
				return result;
			},
			"skills.delete": async (_ctx, p) => {
				const result = await this.skills.delete(
					p.runtime,
					p.path,
					this.extensionTarget(p.workspaceId),
					p.expectedRevision,
				);
				await this.applyResourceChange(p.runtime, p.workspaceId);
				return result;
			},
			"mcp.list": (_ctx, p) => this.mcp.list(p.runtime, this.extensionTarget(p.workspaceId)),
			"mcp.save": async (_ctx, p) => {
				const result = this.mcp.save(
					p.runtime,
					p.scope,
					p.name,
					p.config,
					p.enabled,
					this.extensionTarget(p.workspaceId),
					p.expectedRevision,
					p.create,
				);
				await this.applyResourceChange(p.runtime, p.workspaceId);
				return result;
			},
			"mcp.setEnabled": async (_ctx, p) => {
				const result = this.mcp.setEnabled(
					p.runtime,
					p.scope,
					p.name,
					p.enabled,
					p.expectedRevision,
					this.extensionTarget(p.workspaceId),
				);
				await this.applyResourceChange(p.runtime, p.workspaceId);
				return result;
			},
			"mcp.delete": async (_ctx, p) => {
				const result = this.mcp.delete(
					p.runtime,
					p.scope,
					p.name,
					p.expectedRevision,
					this.extensionTarget(p.workspaceId),
				);
				await this.applyResourceChange(p.runtime, p.workspaceId);
				return result;
			},
			"mcp.test": (_ctx, p) =>
				testMcp(
					this.mcp.connectionServer(p.runtime, p.scope, p.name, this.extensionTarget(p.workspaceId)),
					p.workspaceId ? this.requireWorkspace(p.workspaceId).path : undefined,
				),
			"tunnel.open": (ctx, params) => this.tunnels.open(ctx.connection, params.host, params.port),
			"tunnel.read": (ctx, params) => this.tunnels.read(ctx.connection, params.tunnelId),
			"tunnel.write": (ctx, params) => this.tunnels.write(ctx.connection, params.tunnelId, params.data, params.end),
			"tunnel.close": (ctx, params) => ({ closed: this.tunnels.close(ctx.connection, params.tunnelId) }),
			"browser.open": (ctx, params) => {
				if (!params.peerId) this.requireWorkspace(params.workspaceId);
				return this.browsers.open(ctx.connection, params);
			},
			"browser.list": (ctx) => ({ browsers: this.browsers.list(ctx.connection) }),
			"browser.close": async (ctx, params) => ({ closed: await this.browsers.close(ctx.connection, params.browserId) }),
			"browser.attach": (ctx, params) => {
				this.requireWorkspace(params.workspaceId);
				this.browserControllers.attach(ctx.connection, params.workspaceId, params.browserId);
				return { attached: true };
			},
			"browser.detach": (ctx, params) => ({
				detached: this.browserControllers.detach(params.browserId, ctx.connection),
			}),
			"browser.action": (_ctx, params) => {
				this.requireWorkspace(params.workspaceId);
				return this.browserControllers.action(params.workspaceId, params.command, params.browserId);
			},
			"browser.result": (ctx, params) => ({
				accepted: this.browserControllers.respond(ctx.connection, params.requestId, params.result, params.error),
			}),
			"task.list": () => ({ tasks: this.tasks.list() }),
			"task.create": (_ctx, params) => ({ task: this.tasks.create(params) }),
			"task.update": (_ctx, params) => ({ task: this.tasks.update(params.taskId, params.task) }),
			"task.setStatus": (_ctx, params) => ({ task: this.tasks.setStatus(params.taskId, params.status) }),
			"task.delete": (_ctx, params) => ({ deleted: this.tasks.delete(params.taskId) }),
			"task.run": (_ctx, params) => ({ run: this.tasks.run(params.taskId) }),
			"task.stop": async (_ctx, params) => ({ stopped: await this.tasks.stop(params.taskId) }),
			"task.runs": (_ctx, params) => ({ runs: this.tasks.runs(params?.taskId) }),
			"task.readRun": (_ctx, params) => ({ run: this.tasks.readRun(params.runId) }),
			"host.hello": (ctx, params) => {
				if (!isProtocolCompatible(params.protocolVersion)) {
					throw new PierProtocolError(
						"PROTOCOL_MISMATCH",
						`Host speaks protocol ${PROTOCOL_VERSION}; client speaks ${params.protocolVersion}. Please upgrade.`,
						{ hostVersion: PROTOCOL_VERSION },
					);
				}
				const device = ctx.connection.device;
				if (ctx.connection.kind === "local") {
					if (!this.verifyLocalToken(params.token)) {
						throw new PierProtocolError("UNAUTHENTICATED", "Invalid local token");
					}
				} else if (!device || !this.remote.isRegistered(device.id)) {
					// The secure channel authenticated the device; it may have been revoked since.
					throw new PierProtocolError("UNAUTHENTICATED", "This device is no longer paired");
				}
				ctx.connection.authenticated = true;
				ctx.connection.client = params.client;
				ctx.connection.setCoalesceWindow(params.coalesceMs ?? 0);
				return {
					protocolVersion: PROTOCOL_VERSION,
					host: this.info(),
					connectionId: ctx.connection.connectionId,
					...(device ? { device: { id: device.id, name: device.name } } : {}),
				};
			},
			"host.info": () => this.info(),
			"host.listDirectories": (_ctx, params) => listHostDirectories(params?.path),
			"host.stats": () => this.stats.sample(),
			"host.packageManagers": async () => ({ managers: await detectPackageManagers() }),

			"update.status": () => this.updateStatus(),
			"update.check": () => this.updateRequest("update.check"),
			"update.install": async (ctx) => {
				const status = await this.updateRequest("update.install");
				const device = ctx.connection.device;
				if (device && (status.state === "downloading" || status.state === "installing")) {
					// Tell whoever sits at this computer why Pier is about to restart.
					this.broadcastLocal({
						type: "host.notice",
						level: "info",
						message: `${device.name} 正在远程更新 Pier${status.version ? ` 到 v${status.version}` : ""}，完成后 Pier 会自动重启`,
					});
				}
				return status;
			},

			"workspace.list": () => ({ workspaces: this.config.listWorkspaces() }),
			"workspace.add": (_ctx, params) => {
				if (!isAbsolute(params.path)) throw new PierProtocolError("BAD_REQUEST", "Workspace path must be absolute");
				const path = resolve(params.path);
				if (!existsSync(path) || !statSync(path).isDirectory()) {
					throw new PierProtocolError("BAD_REQUEST", `Not a directory: ${path}`);
				}
				const real = realpathSync(path);
				const workspace = this.config.addWorkspace({
					path: real,
					name: params.name ?? (basename(real) || real),
					...(params.policy ? { policy: params.policy } : {}),
				});
				this.broadcast({ type: "workspace.changed" });
				return { workspace };
			},
			"workspace.remove": async (_ctx, params) => {
				this.tasks.removeWorkspace(params.workspaceId);
				for (const session of this.pool.all()) {
					if (session.workspaceId === params.workspaceId) await this.pool.close(session.id, true);
				}
				const removed = this.config.removeWorkspace(params.workspaceId);
				if (removed) this.broadcast({ type: "workspace.changed" });
				return { removed };
			},
			"workspace.setPolicy": (_ctx, params) => {
				const workspace = this.config.setWorkspacePolicy(params.workspaceId, params.policy);
				if (!workspace) throw new PierProtocolError("NOT_FOUND", `Workspace ${params.workspaceId} not found`);
				this.broadcast({ type: "workspace.changed" });
				return { workspace };
			},

			"workspace.files": (_ctx, params) =>
				listWorkspaceDirectory(this.requireWorkspace(params.workspaceId).path, params.path),
			"workspace.readFile": (_ctx, params) =>
				readWorkspaceFile(this.requireWorkspace(params.workspaceId).path, params.path),
			"workspace.previewFile": (_ctx, params) =>
				previewWorkspaceFile(this.requireWorkspace(params.workspaceId).path, params.path),
			"workspace.authorizeFilePreview": (_ctx, params) =>
				authorizeWorkspaceFilePreview(
					this.requireWorkspace(params.workspaceId).path,
					params.path,
					params.expectedRealPath,
				),
			"workspace.writeFile": (_ctx, params) =>
				writeWorkspaceFile(
					this.requireWorkspace(params.workspaceId).path,
					params.path,
					params.text,
					params.expectedModifiedAt,
				),
			"workspace.deletePath": (_ctx, params) =>
				deleteWorkspacePath(this.requireWorkspace(params.workspaceId).path, params.path),
			"workspace.readBytes": (_ctx, params) =>
				readWorkspaceBytes(this.requireWorkspace(params.workspaceId).path, params.path, params.offset, params.length),
			"workspace.uploadStart": (ctx, params) =>
				this.uploads.start(
					ctx.connection.connectionId,
					this.requireWorkspace(params.workspaceId).path,
					params.path,
					params.size,
					params.overwrite ?? false,
				),
			"workspace.uploadChunk": (ctx, params) =>
				this.uploads.chunk(ctx.connection.connectionId, params.uploadId, params.offset, params.data),
			"workspace.uploadFinish": (ctx, params) => this.uploads.finish(ctx.connection.connectionId, params.uploadId),
			"workspace.uploadCancel": (ctx, params) => this.uploads.cancel(ctx.connection.connectionId, params.uploadId),

			"git.status": (_ctx, params) => this.git.status(this.requireWorkspace(params.workspaceId).path),
			"git.diff": (_ctx, params) =>
				this.git.diff(
					this.requireWorkspace(params.workspaceId).path,
					params.path,
					params.staged ?? false,
					params.origPath,
				),
			"git.log": (_ctx, params) =>
				this.git.log(this.requireWorkspace(params.workspaceId).path, params.limit, params.skip),
			"git.show": (_ctx, params) => this.git.show(this.requireWorkspace(params.workspaceId).path, params.commit),
			"git.branches": (_ctx, params) => this.git.branches(this.requireWorkspace(params.workspaceId).path),
			"git.stage": (_ctx, params) => this.git.stage(this.requireWorkspace(params.workspaceId).path, params.paths),
			"git.unstage": (_ctx, params) => this.git.unstage(this.requireWorkspace(params.workspaceId).path, params.paths),
			"git.discard": (_ctx, params) => this.git.discard(this.requireWorkspace(params.workspaceId).path, params.paths),
			"git.commit": (_ctx, params) =>
				this.git.commit(
					this.requireWorkspace(params.workspaceId).path,
					params.message,
					params.amend ?? false,
					params.all ?? false,
				),
			"git.checkout": (_ctx, params) =>
				this.git.checkout(
					this.requireWorkspace(params.workspaceId).path,
					params.branch,
					params.create ?? false,
					params.startPoint,
				),
			"git.deleteBranch": (_ctx, params) =>
				this.git.deleteBranch(this.requireWorkspace(params.workspaceId).path, params.branch, params.force ?? false),
			"git.fetch": (_ctx, params) => this.git.fetch(this.requireWorkspace(params.workspaceId).path),
			"git.pull": (_ctx, params) =>
				this.git.pull(this.requireWorkspace(params.workspaceId).path, params.rebase ?? false),
			"git.push": (_ctx, params) =>
				this.git.push(this.requireWorkspace(params.workspaceId).path, params.force ?? false),
			"git.stash": (_ctx, params) =>
				this.git.stash(this.requireWorkspace(params.workspaceId).path, params.action, params.message),
			"git.init": (_ctx, params) => this.git.init(this.requireWorkspace(params.workspaceId).path),

			"session.list": async (_ctx, params) => ({
				sessions: await this.pool.list(this.requireWorkspace(params.workspaceId)),
			}),
			"runtime.list": async () => ({ runtimes: await this.pool.runtimeInfos() }),
			"runtime.installStatus": async (_ctx, params) => ({
				installation: this.agentInstaller.status(params.runtime),
				agent: await this.pool.runtime(params.runtime).info(params.refresh),
			}),
			"runtime.install": async (ctx, params) => {
				const agent = this.pool.runtime(params.runtime);
				const override = params.runtime === "codex" ? "PIER_CODEX_PATH" : "PIER_CLAUDE_PATH";
				if (process.env[override])
					throw new PierProtocolError(
						"CONFLICT",
						`当前使用 ${override} 指定的程序，请先移除此环境变量再使用 Pier 安装`,
					);
				// Publication retains the old command if Windows prevents replacing an executable in use.
				const installation = this.agentInstaller.start(params.runtime);
				const device = ctx.connection.device;
				if (device)
					this.broadcastLocal({
						type: "host.notice",
						level: "info",
						message: `${device.name} 正在远程安装或更新 ${agent.name}`,
					});
				return { installation, agent: await agent.info() };
			},
			"session.create": async (_ctx, params) => {
				const session = await this.pool.create(this.requireWorkspace(params.workspaceId), params.name, params.runtime);
				this.broadcast({ type: "session.listChanged", workspaceId: params.workspaceId });
				return { session: session.summary() };
			},
			"session.open": async (_ctx, params) => {
				const workspace = this.requireWorkspace(params.workspaceId);
				const target = "sessionId" in params ? { sessionId: params.sessionId } : { path: params.path };
				const session = await this.pool.open(workspace, target);
				return { session: session.summary() };
			},
			"session.close": async (_ctx, params) => ({ closed: await this.pool.close(params.sessionId, params.force) }),
			"session.delete": async (_ctx, params) => {
				const workspace = this.requireWorkspace(params.workspaceId);
				const deleted = await this.pool.delete(workspace, params.sessionId, params.force);
				if (deleted) this.broadcast({ type: "session.listChanged", workspaceId: workspace.id });
				return { deleted };
			},
			"session.archive": async (_ctx, params) => {
				const workspace = this.requireWorkspace(params.workspaceId);
				const session = await this.pool.setArchived(workspace, params.sessionId, params.archived);
				this.broadcast({ type: "session.listChanged", workspaceId: workspace.id });
				return { session };
			},
			"session.cleanup": async (_ctx, params) => {
				const workspace = this.requireWorkspace(params.workspaceId);
				const result = await this.pool.cleanup(workspace, {
					action: params.action,
					...(params.modifiedBefore ? { modifiedBefore: new Date(params.modifiedBefore) } : {}),
					...(params.scope ? { scope: params.scope } : {}),
					...(params.dryRun ? { dryRun: true } : {}),
				});
				if (!params.dryRun && result.sessionIds.length) {
					this.broadcast({ type: "session.listChanged", workspaceId: workspace.id });
				}
				return result;
			},
			"session.forkPoints": async (_ctx, params) => ({
				points: await this.pool.require(params.sessionId).forkPoints(),
			}),
			"session.fork": async (_ctx, params) => {
				const source = this.pool.require(params.sessionId);
				const { session, selectedText } = await this.pool.fork(source, params.entryId, params.position ?? "before");
				this.broadcast({ type: "session.listChanged", workspaceId: session.workspaceId });
				return selectedText === undefined
					? { session: session.summary() }
					: { session: session.summary(), selectedText };
			},
			"session.rename": async (_ctx, params) => {
				const summary = await this.pool.require(params.sessionId).rename(params.name);
				this.broadcast({ type: "session.listChanged", workspaceId: summary.workspaceId });
				return { session: summary };
			},
			"session.subscribe": (ctx, params) =>
				this.subscribeConnection(ctx, this.pool.require(params.sessionId), params.sinceSeq, params.epoch, params.known),
			"session.unsubscribe": (ctx, params) => {
				const session = this.pool.get(params.sessionId);
				if (!session) return { unsubscribed: false };
				ctx.connection.subscriptions.delete(session);
				return { unsubscribed: session.unsubscribe(ctx.connection.connectionId) };
			},
			"session.snapshot": (_ctx, params) => this.pool.require(params.sessionId).snapshot(),
			"session.commands": async (_ctx, params) => ({
				commands: await this.pool.require(params.sessionId).commands(),
			}),
			"session.reload": async (_ctx, params) => {
				await this.pool.require(params.sessionId).reload();
				return { reloaded: true as const };
			},

			"session.prompt": async (_ctx, params) => {
				await this.pool.require(params.sessionId).prompt(params.text, params.images, params.streamingBehavior);
				return { accepted: true as const };
			},
			"session.steer": async (_ctx, params) => ({
				queue: await this.pool.require(params.sessionId).steer(params.text, params.images),
			}),
			"session.followUp": async (_ctx, params) => ({
				queue: await this.pool.require(params.sessionId).followUp(params.text, params.images),
			}),
			"session.abort": async (_ctx, params) => {
				const session = this.pool.require(params.sessionId);
				this.tasks.sessionAborting(session);
				await session.abort();
				return { aborted: true as const };
			},
			"session.compact": (_ctx, params) => this.pool.require(params.sessionId).compact(params.instructions),

			"model.list": async (_ctx, params) => {
				if (params?.sessionId) {
					const session = this.pool.require(params.sessionId);
					const models = await this.pool.runtime(session.runtimeId).listModels();
					const { model: current, thinkingLevel } = session.modelState();
					return current ? { models, current, thinkingLevel } : { models, thinkingLevel };
				}
				const runtime = this.pool.runtime(params?.runtime);
				const models = await runtime.listModels();
				if (params?.workspaceId) {
					const { model, thinkingLevel } = await runtime.newSessionDefaults(
						this.requireWorkspace(params.workspaceId).path,
					);
					return model ? { models, current: model, thinkingLevel } : { models, thinkingLevel };
				}
				return { models };
			},
			"model.set": async (_ctx, params) => ({
				model: await this.pool
					.require(params.sessionId)
					.setModel(params.provider, params.modelId, params.persist ?? false),
			}),
			"thinking.set": async (_ctx, params) => ({
				level: await this.pool.require(params.sessionId).setThinking(params.level, params.persist ?? false),
			}),
			"model.setDefault": async (_ctx, params) => ({
				defaultModel: await this.providers.setDefault(params.provider, params.modelId),
			}),

			"provider.list": () => this.providers.list(),
			"provider.login": (ctx, params) => {
				const { flowId, start } = this.providers.login(ctx.connection, params.providerId, params.method);
				ctx.after(start);
				return { flowId };
			},
			"provider.loginRespond": (ctx, params) => ({
				accepted: this.providers.respond(
					ctx.connection.connectionId,
					params.flowId,
					params.promptId,
					params.value,
					params.cancelled,
				),
			}),
			"provider.loginCancel": (ctx, params) => ({
				cancelled: this.providers.cancel(ctx.connection.connectionId, params.flowId),
			}),
			"provider.logout": async (_ctx, params) => ({ removed: await this.providers.logout(params.providerId) }),
			"provider.saveCustom": (ctx, params) =>
				this.providers.saveCustom(
					params.provider,
					params.apiKeyRef ? this.newapi.resolveKey(ctx.connection.connectionId, params.apiKeyRef) : params.apiKey,
					params.create ?? false,
				),
			"provider.removeCustom": async (_ctx, params) => ({
				removed: await this.providers.removeCustom(params.providerId),
			}),
			"provider.probeModels": async (ctx, { apiKeyRef, ...params }) => ({
				models: await this.providers.probeModels(
					apiKeyRef ? { ...params, apiKey: this.newapi.resolveKey(ctx.connection.connectionId, apiKeyRef) } : params,
				),
			}),

			"newapi.login": (ctx, params) => this.newapi.login(ctx.connection.connectionId, params),
			"newapi.verify": (ctx, params) => this.newapi.verify(ctx.connection.connectionId, params.sessionId, params.code),
			"newapi.createToken": (ctx, params) =>
				this.newapi.createToken(ctx.connection.connectionId, params.sessionId, params.name, params.group),
			"newapi.useToken": (ctx, params) =>
				this.newapi.useToken(ctx.connection.connectionId, params.sessionId, params.tokenId),
			"newapi.close": async (ctx, params) => ({
				closed: await this.newapi.close(ctx.connection.connectionId, params.sessionId),
			}),
			"newapi.authorizeStart": (ctx, params) => this.newapi.authorizeStart(ctx.connection.connectionId, params.baseUrl),
			"newapi.authorizeWait": (ctx, params) => this.newapi.authorizeWait(ctx.connection.connectionId, params.flowId),
			"account.status": () => this.account.getStatus(),
			"account.setLine": (_ctx, params) => this.account.setLine(params.line),
			"account.login": (_ctx, params) => this.account.login(params),
			"account.verify": (_ctx, params) => this.account.verify(params.code),
			"account.authorizeStart": (ctx, params) =>
				this.account.authorizeStart(ctx.connection.connectionId, params?.redirectUri),
			"account.authorizeWait": (ctx, params) => this.account.authorizeWait(ctx.connection.connectionId, params.flowId),
			"account.authorizeCallback": (ctx, params) =>
				this.account.authorizeCallback(ctx.connection.connectionId, params.flowId, params.query),
			"account.authorizeCancel": (ctx, params) => ({
				cancelled: this.account.authorizeCancel(ctx.connection.connectionId, params.flowId),
			}),
			"account.sendCode": (_ctx, params) => this.account.sendCode(params.email),
			"account.register": (_ctx, params) => this.account.register(params),
			"account.overview": () => this.account.overview(),
			"account.createToken": (_ctx, params) => this.account.createToken(params.name, params.group),
			"account.useToken": (ctx, params) => this.account.useToken(ctx.connection.connectionId, params.tokenId),
			"account.logout": () => this.account.logout(),
			"newapi.authorizeCancel": (ctx, params) => ({
				cancelled: this.newapi.authorizeCancel(ctx.connection.connectionId, params.flowId),
			}),
			"loopback.open": (ctx) => this.loopback.open(ctx.connection.connectionId),
			"loopback.next": (ctx, params) => this.loopback.next(ctx.connection.connectionId, params.relayId),
			"loopback.respond": (ctx, { relayId, requestId, ...page }) => ({
				responded: this.loopback.respond(ctx.connection.connectionId, relayId, requestId, page),
			}),
			"loopback.close": (ctx, params) => ({ closed: this.loopback.close(ctx.connection.connectionId, params.relayId) }),

			"extension.list": (_ctx, params) => this.extensions.list(this.extensionTarget(params?.workspaceId)),
			"extension.install": async (_ctx, params) => {
				const scope = params.scope ?? "user";
				const target = this.extensionTarget(params.workspaceId);
				const pkg = await this.extensions.install(params.source, scope, target);
				const reload = await this.applyExtensionChange(scope === "project" ? target?.id : undefined);
				return pkg ? { package: pkg, reload } : { reload };
			},
			"extension.remove": async (_ctx, params) => {
				const target = this.extensionTarget(params.workspaceId);
				const removed = await this.extensions.remove(params.source, params.scope, target);
				const reload = removed
					? await this.applyExtensionChange(params.scope === "project" ? target?.id : undefined)
					: { reloaded: 0, pending: 0, failed: 0 };
				return { removed, reload };
			},
			"extension.update": async (_ctx, params) => {
				const target = this.extensionTarget(params?.workspaceId);
				await this.extensions.update(params?.source, target);
				return { reload: await this.applyExtensionChange() };
			},
			"extension.checkUpdates": async (_ctx, params) => ({
				updates: await this.extensions.checkUpdates(this.extensionTarget(params?.workspaceId)),
			}),
			"extension.setEnabled": async (_ctx, params) => {
				const target = this.extensionTarget(params.workspaceId);
				const resource = await this.extensions.setEnabled(params.type, params.path, params.enabled, target);
				const reload = await this.applyExtensionChange(resource.scope === "project" ? target?.id : undefined);
				return { resource, reload };
			},
			"extension.delete": async (_ctx, params) => {
				const target = this.extensionTarget(params.workspaceId);
				const scope = await this.extensions.delete(params.path, target, params.type);
				return {
					deleted: true,
					reload: await this.applyExtensionChange(scope === "project" ? target?.id : undefined),
				};
			},

			"extension.search": (_ctx, params) => this.packageCatalog.search(params ?? {}),

			"settings.get": (_ctx, params) => {
				const workspace = params?.workspaceId ? this.requireWorkspace(params.workspaceId) : undefined;
				return {
					agentDir: this.env.agentDir,
					user: this.settings.read("user"),
					...(workspace
						? { project: { ...this.settings.read("project", workspace.path), workspaceId: workspace.id } }
						: {}),
				};
			},
			"settings.update": async (_ctx, params) => {
				const path = this.settingsWorkspace(params.scope, params.workspaceId);
				const changes = params.changes.map((c) => (c.value === undefined ? { path: c.path } : c));
				const { file, changed } = this.settings.update(params.scope, path, changes);
				const reload = changed
					? await this.applySettingsChange(params.scope, params.workspaceId, params.reload ?? true)
					: { reloaded: 0, pending: 0, failed: 0 };
				return { file, changed, reload };
			},
			"settings.write": async (_ctx, params) => {
				const path = this.settingsWorkspace(params.scope, params.workspaceId);
				const { file, changed } = this.settings.write(params.scope, path, params.text, params.expectedModifiedAt);
				const reload = changed
					? await this.applySettingsChange(params.scope, params.workspaceId, true)
					: { reloaded: 0, pending: 0, failed: 0 };
				return { file, changed, reload };
			},

			"agentConfig.get": async (_ctx, params) => {
				const workspace = params.workspaceId ? this.requireWorkspace(params.workspaceId) : undefined;
				const scopes = this.agentConfig.scopes(params.runtime);
				const files = scopes
					.filter((scope) => scope === "user" || workspace)
					.map((scope) => this.agentConfig.read(params.runtime, scope, workspace?.path));
				const runtime = this.pool.runtimes.find((r) => r.id === params.runtime);
				const available = runtime ? (await runtime.info()).available : false;
				return {
					runtime: params.runtime,
					format: this.agentConfig.format(params.runtime),
					configDir: this.agentConfig.configDir(params.runtime),
					scopes,
					files,
					...(workspace ? { workspaceId: workspace.id } : {}),
					available,
				};
			},
			"agentConfig.update": (ctx, params) => {
				const path = this.agentConfigWorkspace(params.scope, params.workspaceId);
				const changes = params.changes.map(({ path, value, apiKeyRef }) =>
					apiKeyRef !== undefined
						? { path, value: this.newapi.resolveKey(ctx.connection.connectionId, apiKeyRef) }
						: value === undefined
							? { path }
							: { path, value },
				);
				const result = this.agentConfig.update(params.runtime, params.scope, path, changes);
				if (result.changed) this.applyAgentConfigChange(params.runtime, params.scope, params.workspaceId);
				return result;
			},
			"agentConfig.write": (_ctx, params) => {
				const path = this.agentConfigWorkspace(params.scope, params.workspaceId);
				const result = this.agentConfig.write(
					params.runtime,
					params.scope,
					path,
					params.text,
					params.expectedModifiedAt,
				);
				if (result.changed) this.applyAgentConfigChange(params.runtime, params.scope, params.workspaceId);
				return result;
			},

			"ui.respond": (ctx, params) => ({
				accepted: this.pool
					.require(params.sessionId)
					.respondUi(params.requestId, params.response, ctx.connection.connectionId),
			}),

			"terminal.open": async (ctx, params) => {
				const { info, start } = await this.terminals.open(ctx.connection, params);
				ctx.after(start);
				return info;
			},
			"terminal.write": (ctx, params) => ({
				written: this.terminals.write(ctx.connection, params.terminalId, params.data, params.binary ?? false),
			}),
			"terminal.resize": (ctx, params) => ({
				resized: this.terminals.resize(ctx.connection, params.terminalId, params.cols, params.rows),
			}),
			"terminal.close": (ctx, params) => ({ closed: this.terminals.close(ctx.connection, params.terminalId) }),

			"device.list": () => ({ devices: this.remote.listDevices() }),
			"device.revoke": (_ctx, params) => ({ revoked: this.remote.revoke(params.deviceId) }),
			"device.rename": (_ctx, params) => ({ device: this.remote.rename(params.deviceId, params.name) }),
			"pairing.start": () => this.remote.startPairing(),
			"pairing.cancel": () => ({ cancelled: this.remote.cancelPairing() }),
			"pairing.respond": (_ctx, params) => ({ accepted: this.remote.respondPairing(params.requestId, params.accept) }),

			"remote.status": () => this.remote.status(),
			"remote.configure": (_ctx, params) => this.remote.configure(params),

			"peer.list": () => ({ peers: this.peers.list() }),
			"peer.pair": async (_ctx, params) => ({ peer: await this.peers.pair(params.uri) }),
			"peer.update": (_ctx, params) => ({ peer: this.peers.update(params.peerId, params.addresses, params.relays) }),
			"peer.remove": (_ctx, params) => ({ removed: this.peers.remove(params.peerId) }),
		};
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		await this.browsers.shutdown();
		this.browserControllers.shutdown();
		this.tunnels.shutdown();
		this.offShellStatus?.();
		await this.tasks.shutdown();
		this.broadcast({ type: "host.notice", level: "warning", message: "Pier host is shutting down" });
		this.providers.shutdown();
		this.account.shutdown();
		this.newapi.shutdown();
		this.loopback.closeAll();
		this.peers.shutdown();
		this.terminals.shutdown();
		await this.agentInstaller.shutdown();
		await this.uploads.shutdown();
		await this.remote.shutdown();
		await this.pool.disposeAll();
		for (const connection of [...this.connections]) connection.close(1001, "Host shutting down");
	}
}
