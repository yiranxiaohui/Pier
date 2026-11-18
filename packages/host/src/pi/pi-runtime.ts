import type { AgentRuntimeInfo, ModelInfo, ThinkingLevel, WorkspaceInfo } from "@pier/protocol";
import { PierProtocolError } from "@pier/protocol";
import type { ManagedSession, ManagedSessionOptions } from "../managed-session.ts";
import type { AgentRuntime, ForkResult, StoredSession } from "../runtimes/types.ts";
import type { PiEnvironment } from "./environment.ts";
import { PI_CAPABILITIES, PiManagedSession } from "./pi-session.ts";

/** pi, run in-process through the SDK of the user's pi installation (see `sdk.ts`). */
export class PiRuntime implements AgentRuntime {
	readonly id = "pi";
	readonly name = "pi";
	readonly capabilities = PI_CAPABILITIES;

	constructor(readonly env: PiEnvironment) {}

	/** Load pi if it can be; false when it is not installed or cannot be used. */
	private available(): Promise<boolean> {
		return this.env.ready().then(
			() => true,
			() => false,
		);
	}

	async info(): Promise<AgentRuntimeInfo> {
		// pi installed while the Host runs is picked up here, when clients list the agents again.
		await this.available();
		const state = this.env.state();
		const installation = state.location.state === "found" ? state.location.installation : undefined;
		const executable =
			installation?.command ?? (state.location.state === "invalid" ? state.location.command : undefined);
		const base = { id: this.id, name: this.name, capabilities: this.capabilities };
		const version = this.env.version;
		if (version) return { ...base, available: true, version, ...(executable ? { executable } : {}) };
		return {
			...base,
			available: false,
			reason: state.reason ?? "pi 尚未加载",
			...(installation ? { version: installation.version } : {}),
			...(executable ? { executable } : {}),
		};
	}

	async listSessions(workspace: WorkspaceInfo): Promise<StoredSession[]> {
		// Without pi its sessions cannot be read; they show up again once pi is installed.
		if (!(await this.available())) return [];
		const infos = await this.env.listSessions(workspace.path);
		return infos.map((info) => ({
			id: info.id,
			path: info.path,
			...(info.name ? { name: info.name } : {}),
			cwd: info.cwd,
			created: info.created,
			modified: info.modified,
			messageCount: info.messageCount,
			firstMessage: info.firstMessage,
			...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
		}));
	}

	private sessionOptions(options: ManagedSessionOptions) {
		return { ...options, env: this.env };
	}

	async create(options: ManagedSessionOptions): Promise<ManagedSession> {
		await this.env.ready();
		const sessionManager = this.env.newSessionManager(options.workspace().path);
		return PiManagedSession.start(this.sessionOptions(options), sessionManager);
	}

	async open(options: ManagedSessionOptions, stored: StoredSession): Promise<ManagedSession> {
		if (!stored.path) throw new PierProtocolError("NOT_FOUND", "Session file not found");
		await this.env.ready();
		const sessionManager = this.env.openSessionManager(stored.path, options.workspace().path);
		return PiManagedSession.start(this.sessionOptions(options), sessionManager);
	}

	async fork(
		source: ManagedSession,
		entryId: string,
		position: "before" | "at",
		options: ManagedSessionOptions,
	): Promise<ForkResult> {
		if (!(source instanceof PiManagedSession)) throw new PierProtocolError("BAD_REQUEST", "Not a pi session");
		await this.env.ready();
		let forked: ReturnType<PiEnvironment["forkSessionManager"]>;
		try {
			forked = this.env.forkSessionManager(source.session, entryId, position);
		} catch (error) {
			throw new PierProtocolError("BAD_REQUEST", error instanceof Error ? error.message : String(error));
		}
		const session = await PiManagedSession.start(this.sessionOptions(options), forked.sessionManager);
		return forked.selectedText === undefined ? { session } : { session, selectedText: forked.selectedText };
	}

	async listModels(): Promise<ModelInfo[]> {
		if (!(await this.available())) return [];
		return this.env.listModels();
	}

	async newSessionDefaults(cwd: string): Promise<{ model?: ModelInfo; thinkingLevel: ThinkingLevel }> {
		if (!(await this.available())) return { thinkingLevel: "off" };
		return this.env.newSessionDefaults(cwd);
	}

	async dispose(): Promise<void> {}
}
