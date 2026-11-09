import type { AgentRuntimeInfo, ModelInfo, ThinkingLevel, WorkspaceInfo } from "@pier/protocol";
import { PierProtocolError } from "@pier/protocol";
import type { ManagedSession, ManagedSessionOptions } from "../managed-session.ts";
import type { AgentRuntime, ForkResult, StoredSession } from "../runtimes/types.ts";
import { PI_VERSION, type PiEnvironment } from "./environment.ts";
import { PI_CAPABILITIES, PiManagedSession } from "./pi-session.ts";

/** The built-in pi runtime (pi SDK). */
export class PiRuntime implements AgentRuntime {
	readonly id = "pi";
	readonly name = "pi";
	readonly capabilities = PI_CAPABILITIES;

	constructor(readonly env: PiEnvironment) {}

	async info(): Promise<AgentRuntimeInfo> {
		return { id: this.id, name: this.name, available: true, version: PI_VERSION, capabilities: this.capabilities };
	}

	async listSessions(workspace: WorkspaceInfo): Promise<StoredSession[]> {
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

	create(options: ManagedSessionOptions): Promise<ManagedSession> {
		const sessionManager = this.env.newSessionManager(options.workspace().path);
		return PiManagedSession.start(this.sessionOptions(options), sessionManager);
	}

	open(options: ManagedSessionOptions, stored: StoredSession): Promise<ManagedSession> {
		if (!stored.path) throw new PierProtocolError("NOT_FOUND", "Session file not found");
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
		return this.env.listModels();
	}

	async newSessionDefaults(cwd: string): Promise<{ model?: ModelInfo; thinkingLevel: ThinkingLevel }> {
		return this.env.newSessionDefaults(cwd);
	}

	async dispose(): Promise<void> {}
}
