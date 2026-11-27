import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentRuntimeInfo,
	type ModelInfo,
	PierProtocolError,
	type ThinkingLevel,
	type WorkspaceInfo,
} from "@pier/protocol";
import type { ManagedSession, ManagedSessionOptions } from "../managed-session.ts";
import { findExecutable, probeVersion } from "../runtimes/executable.ts";
import { AgentInstaller } from "../runtimes/installation.ts";
import type { AgentRuntime, ForkResult, StoredSession, UsageRecord } from "../runtimes/types.ts";
import { CodexAppServer } from "./app-server.ts";
import { CODEX_CAPABILITIES, CodexSession, type CodexSessionHost, codexLimitConfig } from "./codex-session.ts";
import { codexPolicy, convertTurns, storedSubagents, toModelInfo } from "./convert.ts";
import { type CodexModelConfig, codexModelConfig, codexModelList, fetchProviderModels } from "./provider-models.ts";
import { CodexUsageReader } from "./usage.ts";

export interface CodexRuntimeOptions {
	installationHome?: string;
	managedDirectory?: string;
	/** `codex` executable. Defaults to `PIER_CODEX_PATH`, then `codex` on `PATH`. */
	executable?: string;
	/** Arguments that start the app server (tests use a fake server). Defaults to `["app-server"]`. */
	args?: string[];
	env?: NodeJS.ProcessEnv;
	/** Version reported by Pier to Codex. */
	clientVersion?: string;
	log?: (message: string) => void;
}

type Json = Record<string, unknown>;

/** Codex's home directory (`config.toml`, `auth.json`, sessions): `CODEX_HOME` or `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.CODEX_HOME || join(homedir(), ".codex");
}

const MODELS_TTL_MS = 10 * 60 * 1000;
/** A custom provider that did not list its models is asked again after this long. */
const MODELS_RETRY_MS = 30 * 1000;
/** How long a custom provider gets to list its models. */
const PROVIDER_MODELS_TIMEOUT_MS = 6000;
const LIST_LIMIT = 200;
/** The shared app server stops after this long without open Codex sessions. */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

interface CountCacheEntry {
	mtimeMs: number;
	size: number;
	count: number;
}

/** The models offered in one workspace (its project config may pick another provider or model). */
interface ModelsEntry {
	list: ModelInfo[];
	expires: number;
	/** The list is what the custom provider reported, not Codex's catalog. */
	fromProvider: boolean;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Codex, driven through `codex app-server` with the user's own Codex install and login. */
export class CodexRuntime implements AgentRuntime {
	readonly id = "codex";
	readonly name = "Codex";
	readonly capabilities = CODEX_CAPABILITIES;
	private appServer: CodexAppServer | undefined;
	private appServerFor: string | undefined;
	private readonly sessions = new Map<string, CodexSession>();
	/** Sessions that follow sub-agent threads, by sub-agent thread id. */
	private readonly adopted = new Map<string, CodexSession>();
	/** Models by workspace directory (`""` without one). */
	private readonly models = new Map<string, ModelsEntry>();
	private readonly modelsPending = new Map<string, Promise<ModelsEntry>>();
	/** Bumped when the configuration changes, so lists read before are not cached. */
	private modelsGeneration = 0;
	private versionPromise: Promise<string | undefined> | undefined;
	private versionFor: string | undefined;
	private readonly counts = new Map<string, CountCacheEntry>();
	private readonly usageReader = new CodexUsageReader();
	private readonly log: (message: string) => void;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: CodexRuntimeOptions = {}) {
		this.log = options.log ?? (() => {});
	}

	executable(): string | undefined {
		if (this.options.executable) return this.options.executable;
		return findExecutable(
			"codex",
			process.env.PIER_CODEX_PATH,
			this.options.managedDirectory
				? AgentInstaller.executable(this.options.managedDirectory, this.id, this.options.installationHome)
				: undefined,
		);
	}

	installationChanged(): void {
		this.versionFor = undefined;
		this.versionPromise = undefined;
		this.forgetModels();
		this.appServerFor = undefined;
	}

	/** The shared app server (started on first use, stopped when idle). */
	server(): CodexAppServer {
		const executable = this.executable();
		if (!executable) throw new PierProtocolError("CONFLICT", "Codex (`codex`) is not installed on this computer");
		this.scheduleIdleShutdown();
		// Open sessions keep their app-server process until they close, including across CLI updates.
		if (this.appServer && (this.appServerFor === executable || this.sessions.size > 0)) return this.appServer;
		void this.appServer?.close();
		const server = new CodexAppServer({
			executable,
			...(this.options.args ? { args: this.options.args } : {}),
			...(this.options.env ? { env: this.options.env } : {}),
			clientName: "pier",
			clientVersion: this.options.clientVersion ?? "0.0.0",
			log: this.log,
		});
		server.setRequestHandler(async (method, params) => {
			const threadId = String(params.threadId ?? params.conversationId ?? "");
			const session = this.sessions.get(threadId) ?? this.adopted.get(threadId);
			if (!session) throw new Error(`No open Pier session for ${method}`);
			return session.handleServerRequest(method, params);
		});
		this.appServer = server;
		this.appServerFor = executable;
		return server;
	}

	private scheduleIdleShutdown(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.sessions.size > 0) return this.scheduleIdleShutdown();
			const server = this.appServer;
			this.appServer = undefined;
			void server?.close();
		}, IDLE_SHUTDOWN_MS);
		this.idleTimer.unref?.();
	}

	async info(refresh = false): Promise<AgentRuntimeInfo> {
		const executable = this.executable();
		if (!executable) {
			return {
				id: this.id,
				name: this.name,
				available: false,
				reason: "未找到 Codex，请在「设置 → Agent 配置 → Codex」安装并登录，或设置 PIER_CODEX_PATH。",
				capabilities: this.capabilities,
			};
		}
		if (refresh || this.versionFor !== executable) {
			this.versionFor = executable;
			this.versionPromise = this.options.args ? Promise.resolve(undefined) : probeVersion(executable);
		}
		const version = await this.versionPromise;
		return {
			id: this.id,
			name: this.name,
			available: true,
			...(version ? { version } : {}),
			executable,
			capabilities: this.capabilities,
		};
	}

	private sessionHost(cwd: string): CodexSessionHost {
		return {
			server: () => this.server(),
			model: (id) => this.models.get(cwd)?.list.find((m) => m.id === id),
			defaultModel: () => this.models.get(cwd)?.list[0],
			register: (session) => {
				this.sessions.set(session.id, session);
				return () => {
					if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
				};
			},
			adopt: (threadId, session) => {
				this.adopted.set(threadId, session);
				return () => {
					if (this.adopted.get(threadId) === session) this.adopted.delete(threadId);
				};
			},
			turns: (threadId) => this.readTurns(threadId),
			version: async () => (await this.info()).version,
			log: this.log,
		};
	}

	/** Approximate number of prompts and replies in a rollout file (cached by size and mtime). */
	private messageCount(path: string | undefined): number {
		if (!path) return 0;
		try {
			const stat = statSync(path);
			const cached = this.counts.get(path);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.count;
			let count = 0;
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line.includes('"type":"item_completed"')) continue;
				if (/"item":\{"type":"(UserMessage|AgentMessage)"/.test(line)) count++;
			}
			this.counts.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, count });
			return count;
		} catch {
			return 0;
		}
	}

	async listSessions(workspace: WorkspaceInfo): Promise<StoredSession[]> {
		if (!this.executable()) return [];
		const server = this.server();
		const sessions: StoredSession[] = [];
		let cursor: string | null | undefined;
		do {
			const page = await server.request<{ data?: Json[]; nextCursor?: string | null }>("thread/list", {
				cwd: workspace.path,
				limit: LIST_LIMIT,
				sortKey: "updated_at",
				sortDirection: "desc",
				sourceKinds: ["cli", "vscode", "exec", "appServer"],
				...(cursor ? { cursor } : {}),
			});
			for (const thread of page.data ?? []) {
				if (thread.ephemeral === true) continue;
				const path = typeof thread.path === "string" ? thread.path : undefined;
				const name = typeof thread.name === "string" && thread.name ? thread.name : undefined;
				sessions.push({
					id: String(thread.id),
					...(path ? { path } : {}),
					...(name ? { name } : {}),
					cwd: typeof thread.cwd === "string" ? thread.cwd : workspace.path,
					created: new Date(Number(thread.createdAt ?? 0) * 1000),
					modified: new Date(Number(thread.updatedAt ?? thread.createdAt ?? 0) * 1000),
					messageCount: this.messageCount(path),
					firstMessage: String(thread.preview ?? "").slice(0, 200),
					...(typeof thread.forkedFromId === "string" ? { parentSessionPath: thread.forkedFromId } : {}),
				});
			}
			cursor = page.nextCursor;
		} while (cursor && sessions.length < 1000);
		return sessions;
	}

	/** The thread's requests and its sub-agents' (1.68), from the rollout files Codex writes. */
	usage(_workspace: WorkspaceInfo, stored: StoredSession): Promise<UsageRecord[]> {
		return stored.path ? this.usageReader.usage(stored.path) : Promise.resolve([]);
	}

	async create(options: ManagedSessionOptions): Promise<ManagedSession> {
		const workspace = options.workspace();
		await this.listModels(workspace.path).catch(() => []);
		const policy = codexPolicy(workspace.policy);
		const response = await this.server().request<Json>("thread/start", {
			cwd: workspace.path,
			approvalPolicy: policy.approvalPolicy,
			sandbox: policy.sandbox,
			...codexLimitConfig(options.contextLimit),
		});
		const model = this.threadModel(workspace.path, response.model);
		return CodexSession.start(options, this.sessionHost(workspace.path), {
			thread: (response.thread ?? {}) as Json,
			...(model ? { model } : {}),
			effort: (response.reasoningEffort as string | null | undefined) ?? null,
			serviceTier: response.serviceTier as string | null | undefined,
		});
	}

	/** Every turn of a thread, oldest first, with full items. */
	private async readTurns(threadId: string): Promise<Json[]> {
		const turns: Json[] = [];
		let cursor: string | null | undefined;
		do {
			const page = await this.server().request<{ data?: Json[]; nextCursor?: string | null }>("thread/turns/list", {
				threadId,
				itemsView: "full",
				sortDirection: "asc",
				limit: 100,
				...(cursor ? { cursor } : {}),
			});
			turns.push(...(page.data ?? []));
			cursor = page.nextCursor;
		} while (cursor && turns.length < 5000);
		return turns;
	}

	/**
	 * Keep the token usage Codex reports per thread until `stop()`. Codex replays a thread's latest
	 * usage right after answering `thread/resume` or `thread/fork`, before the Pier session that
	 * would listen for it exists.
	 */
	private captureTokenUsage(): { of: (threadId: string) => Json | undefined; stop: () => void } {
		const reports = new Map<string, Json>();
		const stop = this.server().onNotification((method, params) => {
			if (method !== "thread/tokenUsage/updated" || typeof params.threadId !== "string") return;
			const usage = params.tokenUsage;
			if (usage && typeof usage === "object") reports.set(params.threadId, usage as Json);
		});
		return { of: (threadId) => reports.get(threadId), stop };
	}

	async open(options: ManagedSessionOptions, stored: StoredSession): Promise<ManagedSession> {
		const workspace = options.workspace();
		await this.listModels(workspace.path).catch(() => []);
		const policy = codexPolicy(workspace.policy);
		const usage = this.captureTokenUsage();
		try {
			const response = await this.server().request<Json>("thread/resume", {
				threadId: stored.id,
				cwd: workspace.path,
				approvalPolicy: policy.approvalPolicy,
				sandbox: policy.sandbox,
				excludeTurns: true,
				...codexLimitConfig(options.contextLimit),
			});
			const thread = (response.thread ?? {}) as Json;
			const turns = await this.readTurns(stored.id);
			const tokenUsage = usage.of(stored.id);
			return CodexSession.start(options, this.sessionHost(workspace.path), {
				thread: { ...thread, name: thread.name ?? stored.name },
				...(typeof response.model === "string" ? { model: response.model } : {}),
				effort: (response.reasoningEffort as string | null | undefined) ?? null,
				serviceTier: response.serviceTier as string | null | undefined,
				messages: convertTurns(turns),
				subagents: storedSubagents(turns),
				...(tokenUsage ? { tokenUsage } : {}),
			});
		} finally {
			usage.stop();
		}
	}

	async fork(
		source: ManagedSession,
		entryId: string,
		position: "before" | "at",
		options: ManagedSessionOptions,
	): Promise<ForkResult> {
		if (!(source instanceof CodexSession)) throw new PierProtocolError("BAD_REQUEST", "Not a Codex session");
		if (source.busy) throw new PierProtocolError("CONFLICT", "Wait for the agent to finish before forking");
		const points = source.forkPoints();
		const index = points.findIndex((p) => p.entryId === entryId);
		const point = points[index];
		if (!point) throw new PierProtocolError("BAD_REQUEST", "Invalid entry ID for forking");
		const lastTurnId = position === "at" ? point.entryId : points[index - 1]?.entryId;
		if (!lastTurnId) {
			const session = await this.create(options);
			return position === "before" ? { session, selectedText: point.text } : { session };
		}
		const workspace = options.workspace();
		const policy = codexPolicy(workspace.policy);
		const usage = this.captureTokenUsage();
		let session: CodexSession;
		try {
			const response = await this.server().request<Json>("thread/fork", {
				threadId: source.id,
				lastTurnId,
				cwd: workspace.path,
				approvalPolicy: policy.approvalPolicy,
				sandbox: policy.sandbox,
				excludeTurns: true,
				...codexLimitConfig(options.contextLimit),
			});
			const thread = (response.thread ?? {}) as Json;
			const turns = await this.readTurns(String(thread.id));
			const tokenUsage = usage.of(String(thread.id));
			session = CodexSession.start(options, this.sessionHost(workspace.path), {
				thread,
				...(typeof response.model === "string" ? { model: response.model } : {}),
				effort: (response.reasoningEffort as string | null | undefined) ?? null,
				serviceTier: response.serviceTier as string | null | undefined,
				messages: convertTurns(turns),
				subagents: storedSubagents(turns),
				...(tokenUsage ? { tokenUsage } : {}),
			});
		} finally {
			usage.stop();
		}
		return position === "before" ? { session, selectedText: point.text } : { session };
	}

	/** Codex archives threads (it keeps them under `archived_sessions`) instead of Pier's trash. */
	async deleteStored(_workspace: WorkspaceInfo, stored: StoredSession): Promise<boolean> {
		await this.server().request("thread/archive", { threadId: stored.id });
		return true;
	}

	/**
	 * The models offered in `cwd`, the default first (see `codexModelList`): Codex's catalog, or what
	 * the configured custom provider lists, and the configured model.
	 */
	async listModels(cwd?: string): Promise<ModelInfo[]> {
		if (!this.executable()) return [];
		const key = cwd ?? "";
		const cached = this.models.get(key);
		if (cached && Date.now() < cached.expires) return cached.list;
		let pending = this.modelsPending.get(key);
		if (!pending) {
			const generation = this.modelsGeneration;
			pending = this.loadModels(cwd)
				.then((entry) => {
					if (generation === this.modelsGeneration) this.models.set(key, entry);
					return entry;
				})
				.finally(() => {
					if (this.modelsPending.get(key) === pending) this.modelsPending.delete(key);
				});
			this.modelsPending.set(key, pending);
		}
		return (await pending).list;
	}

	private async loadModels(cwd: string | undefined): Promise<ModelsEntry> {
		const [catalog, config] = await Promise.all([this.catalogModels(), this.modelConfig(cwd)]);
		let providerModels: string[] | undefined;
		let ttl = MODELS_TTL_MS;
		if (config.provider) {
			try {
				providerModels = await fetchProviderModels(config.provider, AbortSignal.timeout(PROVIDER_MODELS_TIMEOUT_MS));
			} catch (error) {
				ttl = MODELS_RETRY_MS;
				this.log(`Codex provider ${config.provider.id} did not list its models: ${errorText(error)}`);
			}
		}
		return {
			list: codexModelList(catalog, config, providerModels),
			expires: Date.now() + ttl,
			fromProvider: !!providerModels?.length,
		};
	}

	/** Codex's own catalog (`model/list`), its default first. */
	private async catalogModels(): Promise<ModelInfo[]> {
		const list: ModelInfo[] = [];
		let cursor: string | null | undefined;
		let defaultId: string | undefined;
		do {
			const page = await this.server().request<{ data?: Json[]; nextCursor?: string | null }>("model/list", {
				...(cursor ? { cursor } : {}),
			});
			for (const model of page.data ?? []) {
				if (model.hidden === true) continue;
				const info = toModelInfo(model);
				if (model.isDefault === true) defaultId = info.id;
				list.push(info);
			}
			cursor = page.nextCursor;
		} while (cursor);
		// The default model first: new threads use it unless one is picked.
		list.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
		return list;
	}

	/** The model settings Codex applies in `cwd` (none when this Codex cannot report them). */
	private async modelConfig(cwd: string | undefined): Promise<CodexModelConfig> {
		try {
			const response = await this.server().request<{ config?: Json }>("config/read", { ...(cwd ? { cwd } : {}) });
			return codexModelConfig(response.config, this.options.env ?? process.env);
		} catch (error) {
			this.log(`Codex config/read failed: ${errorText(error)}`);
			return {};
		}
	}

	/**
	 * The model a new thread in `cwd` runs: the one Codex started it with, unless the configured
	 * custom provider does not list it (no `model` is configured, so Codex picked its catalog
	 * default); then the provider's first model, which Pier shows as the default.
	 */
	private threadModel(cwd: string, reported: unknown): string | undefined {
		const model = typeof reported === "string" ? reported : undefined;
		const entry = this.models.get(cwd);
		if (!entry?.fromProvider || (model && entry.list.some((m) => m.id === model))) return model;
		return entry.list[0]?.id ?? model;
	}

	private forgetModels(): void {
		this.modelsGeneration++;
		this.models.clear();
		this.modelsPending.clear();
	}

	async newSessionDefaults(cwd: string): Promise<{ model?: ModelInfo; thinkingLevel: ThinkingLevel }> {
		const models = await this.listModels(cwd);
		const model = models[0];
		const levels = model?.thinkingLevels ?? ["off"];
		const thinkingLevel: ThinkingLevel = levels.includes("medium") ? "medium" : (levels.at(-1) ?? "off");
		return model ? { model, thinkingLevel } : { thinkingLevel };
	}

	/** Where Codex reads `config.toml`. */
	configDir(): string {
		return codexHome(this.options.env ?? process.env);
	}

	/**
	 * `config.toml` changed: forget the model list, and restart the shared app server once no
	 * Codex session uses it so providers and profiles are read again.
	 */
	configChanged(): void {
		this.forgetModels();
		if (this.sessions.size > 0 || !this.appServer) return;
		const server = this.appServer;
		this.appServer = undefined;
		void server.close();
	}

	async dispose(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		const server = this.appServer;
		this.appServer = undefined;
		await server?.close();
	}
}
