import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { type AgentRuntimeInfo, type ModelInfo, PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import type { ManagedSessionOptions } from "../managed-session.ts";
import { findExecutable, probeVersion } from "../runtimes/executable.ts";
import type { AgentRuntime, StoredSession } from "../runtimes/types.ts";
import { opencodePaths } from "./installer.ts";
import { OPENCODE_CAPABILITIES, OpenCodeSession } from "./opencode-session.ts";
import { OpenCodeServer } from "./server.ts";

export interface OpenCodeRuntimeOptions {
	executable?: string;
	env?: NodeJS.ProcessEnv;
	/** Home of the OpenCode that Pier installs (`~/.opencode/bin`); tests use a temporary one. */
	installationHome?: string;
}

/**
 * Where OpenCode reads its global `opencode.json(c)`: `$XDG_CONFIG_HOME/opencode`, else
 * `~/.config/opencode` (on every platform, as OpenCode resolves it).
 */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

export class OpenCodeRuntime implements AgentRuntime {
	readonly id = "opencode";
	readonly name = "OpenCode";
	readonly capabilities = OPENCODE_CAPABILITIES;
	readonly server: OpenCodeServer;
	private probe?: { executable: string; version: Promise<string | undefined> };
	/** Turns running on the shared server; a configuration change waits for them to end. */
	private turns = 0;
	private reloadPending = false;

	constructor(private readonly options: OpenCodeRuntimeOptions = {}) {
		this.server = new OpenCodeServer(() => this.executable(), options.env);
	}

	/** `PIER_OPENCODE_PATH`, else `~/.opencode/bin` (where Pier and OpenCode's installer put it), else `PATH`. */
	executable(): string | undefined {
		return findExecutable(
			"opencode",
			this.options.executable ?? process.env.PIER_OPENCODE_PATH,
			opencodePaths(this.options.installationHome).executable,
		);
	}

	async info(refresh = false): Promise<AgentRuntimeInfo> {
		const executable = this.executable();
		const base = { id: this.id, name: this.name, capabilities: this.capabilities };
		if (!executable)
			return {
				...base,
				available: false,
				reason:
					"在「设置 → Agent 配置 → OpenCode」中安装，或在目标电脑的终端安装 OpenCode；也可以设置 PIER_OPENCODE_PATH。",
			};
		if (refresh || this.probe?.executable !== executable)
			this.probe = { executable, version: probeVersion(executable) };
		const version = await this.probe.version;
		return { ...base, available: true, executable, ...(version ? { version } : {}) };
	}

	async listSessions(workspace: WorkspaceInfo): Promise<StoredSession[]> {
		if (!this.executable()) return [];
		const client = await this.server.client();
		const { data } = await client.session.list(
			{ directory: workspace.path, scope: "project", roots: true, limit: 1000 },
			{ throwOnError: true },
		);
		return data
			.filter((s) => !s.parentID && !s.time.archived && resolve(s.directory) === resolve(workspace.path))
			.map((s) => ({
				id: s.id,
				cwd: s.directory,
				name: s.title,
				created: new Date(s.time.created),
				modified: new Date(s.time.updated),
				messageCount: 0,
				firstMessage: "",
			}));
	}

	async listModels(directory = homedir()): Promise<ModelInfo[]> {
		if (!this.executable()) return [];
		const client = await this.server.client();
		const { data } = await client.config.providers({ directory }, { throwOnError: true });
		return data.providers.flatMap((provider) =>
			Object.entries(provider.models).map(([id, m]) => ({
				provider: provider.id,
				...(provider.name && provider.name !== provider.id ? { providerName: provider.name } : {}),
				id,
				name: m.name,
				reasoning: m.capabilities.reasoning,
				input: m.capabilities.input.image ? ["text", "image"] : ["text"],
				contextWindow: m.limit.context,
				thinkingLevels: ["off" as const],
			})),
		);
	}

	async newSessionDefaults(directory: string, models?: ModelInfo[]) {
		if (!this.executable()) return { thinkingLevel: "off" as const };
		const client = await this.server.client();
		const [catalog, { data: config }] = await Promise.all([
			models ?? this.listModels(directory),
			client.config.get({ directory }, { throwOnError: true }),
		]);
		const model = catalog.find((m) => `${m.provider}/${m.id}` === config.model);
		return { ...(model ? { model } : {}), thinkingLevel: "off" as const };
	}

	async create(options: ManagedSessionOptions): Promise<OpenCodeSession> {
		const client = await this.server.client();
		const directory = options.workspace().path;
		const { data } = await client.session.create({ directory }, { throwOnError: true });
		return new OpenCodeSession(options, this, data, []);
	}

	async open(options: ManagedSessionOptions, stored: StoredSession): Promise<OpenCodeSession> {
		const client = await this.server.client();
		const params = { directory: options.workspace().path, sessionID: stored.id };
		const { data } = await client.session.get(params, { throwOnError: true });
		this.checkDirectory(data, params.directory);
		const { data: messages } = await client.session.messages(params, { throwOnError: true });
		return new OpenCodeSession(options, this, data, messages);
	}

	private checkDirectory(session: Session, directory: string): void {
		if (session.parentID || session.time.archived || resolve(session.directory) !== resolve(directory))
			throw new PierProtocolError("NOT_FOUND", "OpenCode session not in workspace");
	}

	async deleteStored(workspace: WorkspaceInfo, stored: StoredSession): Promise<boolean> {
		const client = await this.server.client();
		const params = { directory: workspace.path, sessionID: stored.id };
		this.checkDirectory((await client.session.get(params, { throwOnError: true })).data, workspace.path);
		await client.session.update({ ...params, time: { archived: Date.now() } }, { throwOnError: true });
		return true;
	}

	async fork(): Promise<never> {
		throw new PierProtocolError("UNSUPPORTED", "OpenCode sessions do not support forking in Pier");
	}

	/** Where OpenCode reads its global configuration. */
	configDir(): string {
		return opencodeConfigDir({ ...process.env, ...this.options.env });
	}

	/**
	 * `opencode.json` changed: the shared server keeps the configuration it read, so restart it
	 * (the next request starts a fresh one) once no turn is running on it.
	 */
	configChanged(): void {
		if (this.turns > 0) {
			this.reloadPending = true;
			return;
		}
		this.reloadPending = false;
		void this.server.restart();
	}

	/** Pier installed or updated OpenCode (1.65): probe the version again and restart the server once idle. */
	installationChanged(): void {
		this.probe = undefined;
		this.configChanged();
	}

	/** A session starts a turn on the shared server; call the returned function when it ends. */
	beginTurn(): () => void {
		this.turns++;
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this.turns--;
			if (this.turns === 0 && this.reloadPending) this.configChanged();
		};
	}

	dispose(): Promise<void> {
		return this.server.close();
	}
}
