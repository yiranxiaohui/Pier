import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type AgentRuntimeInfo, type ModelInfo, PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import type { ManagedSessionOptions } from "../managed-session.ts";
import { findExecutable, probeVersion } from "../runtimes/executable.ts";
import type { AgentRuntime, StoredSession } from "../runtimes/types.ts";
import { AcpConnection, type Json } from "./acp.ts";
import { HERMES_CAPABILITIES, HermesSession } from "./hermes-session.ts";
import { type HermesModelState, modelKey, modelState } from "./models.ts";

export interface HermesRuntimeOptions {
	/** `hermes` executable. Defaults to `PIER_HERMES_PATH`, then `hermes` on `PATH`. */
	executable?: string;
	/** Arguments before Hermes' own (`acp`, `sessions delete`); tests run a fake agent script. */
	scriptArgs?: string[];
	env?: NodeJS.ProcessEnv;
	/** Version Pier reports to Hermes. */
	clientVersion?: string;
	log?: (message: string) => void;
	/** Timeout of ACP requests other than prompts. */
	requestTimeoutMs?: number;
	/** The ACP server stops after this long without open Hermes sessions. */
	idleShutdownMs?: number;
}

/** Model pickers are read again after this long. */
const MODELS_TTL_MS = 10 * 60 * 1000;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
/** Pages of `session/list` read for one workspace (Hermes sends 50 sessions a page). */
const LIST_PAGES = 20;

interface BufferedRequest {
	method: string;
	params: Json;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

/**
 * Hermes Agent (https://github.com/NousResearch/hermes-agent) through its ACP server,
 * `hermes acp`: one process serves every Hermes session of the host. Hermes keeps the
 * conversations (its `state.db`), its model and provider setup (`~/.hermes`), and asks for
 * approvals over ACP, which Pier answers with the workspace policy.
 */
export class HermesRuntime implements AgentRuntime {
	readonly id = "hermes";
	readonly name = "Hermes";
	readonly capabilities = HERMES_CAPABILITIES;
	private acp: { executable: string; connection: AcpConnection } | undefined;
	private probe: { executable: string; version: Promise<string | undefined> } | undefined;
	private catalog: { state: HermesModelState; expires: number } | undefined;
	private catalogLoading: Promise<HermesModelState> | undefined;
	/**
	 * The session `session/new` made to read the pickers. Hermes keeps an unused session in memory
	 * only; the next session created in its directory takes it over.
	 */
	private spare: { cwd: string; sessionId: string; result: Json; expires: number; generation: number } | undefined;
	private readonly sessions = new Set<HermesSession>();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: HermesRuntimeOptions = {}) {}

	executable(): string | undefined {
		return findExecutable("hermes", this.options.executable ?? process.env.PIER_HERMES_PATH);
	}

	log(message: string): void {
		this.options.log?.(message);
	}

	private connection(): AcpConnection | undefined {
		const executable = this.executable();
		if (!executable) return undefined;
		if (this.acp?.executable === executable) return this.acp.connection;
		void this.acp?.connection.stop(true);
		const connection = new AcpConnection({
			executable,
			args: [...(this.options.scriptArgs ?? []), "acp"],
			...(this.options.env ? { env: this.options.env } : {}),
			label: "Hermes",
			clientInfo: { name: "pier", title: "Pier", version: this.options.clientVersion ?? "0.0.0" },
			// Hermes uses its own file and terminal tools; questions come as forms.
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
				elicitation: { form: {} },
			},
			log: (message) => this.log(message),
			...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
		});
		connection.onExit((reason) => {
			this.spare = undefined;
			this.log(reason);
		});
		this.acp = { executable, connection };
		return connection;
	}

	/** The running ACP server (started when needed). */
	async connect(): Promise<AcpConnection> {
		const connection = this.connection();
		if (!connection)
			throw new PierProtocolError("CONFLICT", "Hermes is not installed on this computer (or set PIER_HERMES_PATH)");
		this.touch();
		await connection.start();
		return connection;
	}

	/** Stop the ACP server once no Hermes session has been open for a while. */
	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.sessions.size > 0 || this.catalogLoading) return this.touch();
			this.spare = undefined;
			void this.acp?.connection.stop();
		}, this.options.idleShutdownMs ?? IDLE_SHUTDOWN_MS);
		this.idleTimer.unref?.();
	}

	sessionClosed(session: HermesSession): void {
		this.sessions.delete(session);
		this.touch();
	}

	async info(refresh = false): Promise<AgentRuntimeInfo> {
		const executable = this.executable();
		const base = { id: this.id, name: this.name, capabilities: this.capabilities };
		if (!executable)
			return {
				...base,
				available: false,
				reason: "请在目标电脑安装 Hermes Agent，或设置 PIER_HERMES_PATH。",
			};
		if (refresh || this.probe?.executable !== executable)
			// `hermes --version` also checks for updates online; the ACP server's answers at once.
			this.probe = {
				executable,
				version: probeVersion(executable, 20_000, {
					args: [...(this.options.scriptArgs ?? []), "acp", "--version"],
					...(this.options.env ? { env: this.options.env } : {}),
				}),
			};
		const version = await this.probe.version;
		return { ...base, available: true, executable, ...(version ? { version } : {}) };
	}

	async listSessions(workspace: WorkspaceInfo): Promise<StoredSession[]> {
		if (!this.executable()) return [];
		const connection = await this.connect();
		const capabilities = (connection.agent?.agentCapabilities ?? {}) as Json;
		const sessionCapabilities = (capabilities.sessionCapabilities ?? {}) as Json;
		if (!sessionCapabilities.list) return [];
		const stored: StoredSession[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < LIST_PAGES; page++) {
			const result = await connection.request<Json>("session/list", {
				cwd: workspace.path,
				...(cursor ? { cursor } : {}),
			});
			for (const s of (Array.isArray(result?.sessions) ? result.sessions : []) as Json[]) {
				if (typeof s.sessionId !== "string" || typeof s.cwd !== "string") continue;
				const updated = typeof s.updatedAt === "string" ? new Date(s.updatedAt) : new Date(0);
				const when = Number.isNaN(updated.getTime()) ? new Date(0) : updated;
				stored.push({
					id: s.sessionId,
					cwd: s.cwd,
					...(typeof s.title === "string" && s.title.trim() ? { name: s.title.trim() } : {}),
					created: when,
					modified: when,
					messageCount: 0,
					firstMessage: "",
				});
			}
			cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
			if (!cursor) break;
		}
		return stored;
	}

	/** Hermes' pickers as a new session sees them (cached; read with a `session/new`). */
	private catalogState(cwd = homedir()): Promise<HermesModelState> {
		if (this.catalog && this.catalog.expires > Date.now()) return Promise.resolve(this.catalog.state);
		this.catalogLoading ??= (async () => {
			const connection = await this.connect();
			const result = await connection.request<Json>("session/new", { cwd, mcpServers: [] });
			if (typeof result?.sessionId === "string")
				this.spare = {
					cwd: resolve(cwd),
					sessionId: result.sessionId,
					result,
					expires: Date.now() + MODELS_TTL_MS,
					generation: connection.generation,
				};
			return this.remember(result);
		})().finally(() => {
			this.catalogLoading = undefined;
		});
		return this.catalogLoading;
	}

	/** Keep what a fresh session reports: the models, and the defaults new sessions start with. */
	private remember(result: Json): HermesModelState {
		const state = modelState(result);
		this.catalog = { state, expires: Date.now() + MODELS_TTL_MS };
		return state;
	}

	async listModels(cwd?: string): Promise<ModelInfo[]> {
		if (!this.executable()) return [];
		return (await this.catalogState(cwd)).models;
	}

	/** Hermes' choice (`provider:model`) of a model it listed. */
	choiceOf(model: ModelInfo): string | undefined {
		return this.catalog?.state.values.get(modelKey(model.provider, model.id));
	}

	async newSessionDefaults(cwd: string) {
		if (!this.executable()) return { thinkingLevel: "off" as const };
		const state = await this.catalogState(cwd);
		return { ...(state.current ? { model: state.current } : {}), thinkingLevel: state.thinking };
	}

	async create(options: ManagedSessionOptions): Promise<HermesSession> {
		const connection = await this.connect();
		const cwd = options.workspace().path;
		const spare = this.spare;
		let start: { sessionId: string; result: Json };
		if (
			spare &&
			spare.cwd === resolve(cwd) &&
			spare.expires > Date.now() &&
			spare.generation === connection.generation
		) {
			this.spare = undefined;
			start = spare;
		} else {
			const result = await connection.request<Json>("session/new", { cwd, mcpServers: [] });
			if (typeof result?.sessionId !== "string") throw new Error("Hermes did not create a session");
			this.remember(result);
			start = { sessionId: result.sessionId, result };
		}
		const session = new HermesSession(options, this, connection, { ...start, persisted: false });
		this.sessions.add(session);
		return session;
	}

	async open(options: ManagedSessionOptions, stored: StoredSession): Promise<HermesSession> {
		const connection = await this.connect();
		const workspace = options.workspace();
		// `session/load` replays the conversation (and re-asks pending approvals) before it answers.
		const history: Json[] = [];
		const requests: BufferedRequest[] = [];
		const stop = connection.listen(stored.id, {
			update: (update) => history.push(update),
			request: (method, params) => new Promise((resolve, reject) => requests.push({ method, params, resolve, reject })),
		});
		let result: Json;
		try {
			result = await connection.request<Json>("session/load", {
				sessionId: stored.id,
				cwd: workspace.path,
				mcpServers: [],
			});
		} catch (error) {
			for (const r of requests) r.resolve({ outcome: { outcome: "cancelled" } });
			throw error;
		} finally {
			stop();
		}
		const session = new HermesSession(
			options,
			this,
			connection,
			{
				sessionId: stored.id,
				result: result ?? {},
				...(stored.name ? { title: stored.name } : {}),
				createdAt: stored.created.toISOString(),
				persisted: true,
			},
			history,
		);
		this.sessions.add(session);
		for (const r of requests) session.answer(r.method, r.params).then(r.resolve, r.reject);
		return session;
	}

	async fork(): Promise<never> {
		throw new PierProtocolError("UNSUPPORTED", "Hermes sessions do not support forking in Pier");
	}

	/** `hermes sessions delete`: Hermes removes the conversation from its store. */
	async deleteStored(_workspace: WorkspaceInfo, stored: StoredSession): Promise<boolean> {
		const executable = this.executable();
		if (!executable) return false;
		await new Promise<void>((done, fail) => {
			execFile(
				executable,
				[...(this.options.scriptArgs ?? []), "sessions", "delete", stored.id, "--yes"],
				{
					timeout: 60_000,
					windowsHide: true,
					env: this.options.env ?? process.env,
					shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
				},
				(error, stdout, stderr) => {
					if (!error) return done();
					const output = `${stdout}\n${stderr}`
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean);
					fail(
						new Error(
							output.findLast((line) => /error|cannot|not found/i.test(line)) ?? output.at(-1) ?? error.message,
						),
					);
				},
			);
		});
		return true;
	}

	configChanged(): void {
		this.catalog = undefined;
		this.spare = undefined;
	}

	installationChanged(): void {
		this.probe = undefined;
		this.configChanged();
	}

	async dispose(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		await this.acp?.connection.stop(true);
	}
}
