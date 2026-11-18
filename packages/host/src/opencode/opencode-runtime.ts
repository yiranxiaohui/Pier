import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { type AgentRuntimeInfo, type ModelInfo, PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import type { ManagedSessionOptions } from "../managed-session.ts";
import { findExecutable, probeVersion } from "../runtimes/executable.ts";
import type { AgentRuntime, StoredSession } from "../runtimes/types.ts";
import { OPENCODE_CAPABILITIES, OpenCodeSession } from "./opencode-session.ts";
import { OpenCodeServer } from "./server.ts";

export interface OpenCodeRuntimeOptions {
	executable?: string;
	env?: NodeJS.ProcessEnv;
}

export class OpenCodeRuntime implements AgentRuntime {
	readonly id = "opencode";
	readonly name = "OpenCode";
	readonly capabilities = OPENCODE_CAPABILITIES;
	readonly server: OpenCodeServer;
	private probe?: { executable: string; version: Promise<string | undefined> };

	constructor(private readonly options: OpenCodeRuntimeOptions = {}) {
		this.server = new OpenCodeServer(() => this.executable(), options.env);
	}

	executable(): string | undefined {
		return findExecutable("opencode", this.options.executable ?? process.env.PIER_OPENCODE_PATH);
	}

	async info(refresh = false): Promise<AgentRuntimeInfo> {
		const executable = this.executable();
		const base = { id: this.id, name: this.name, capabilities: this.capabilities };
		if (!executable)
			return { ...base, available: false, reason: "请在目标电脑安装 OpenCode，或设置 PIER_OPENCODE_PATH。" };
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

	dispose(): Promise<void> {
		return this.server.close();
	}
}
