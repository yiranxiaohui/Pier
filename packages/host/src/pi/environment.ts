import { homedir } from "node:os";
import { join } from "node:path";
import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getAgentDir,
	type InlineExtension,
	type LoadedMcpConfig,
	ModelRuntime,
	VERSION as PI_VERSION,
	type SessionInfo,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelInfo, ThinkingLevel } from "@pier/protocol";

/** pi's default thinking level when settings name none (`DEFAULT_THINKING_LEVEL`). */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export { PI_VERSION };

export interface PiEnvironmentOptions {
	/** pi agent directory. Defaults to pi's own resolution (`~/.pi/agent` or `PI_CODING_AGENT_DIR`). */
	agentDir?: string;
	/** Shared model/auth runtime. Defaults to one backed by `<agentDir>/auth.json` and `models.json`. */
	modelRuntime?: ModelRuntime;
	/** models.json edited by Pier's provider settings. Defaults to `<agentDir>/models.json`. Must match the runtime's. */
	modelsPath?: string;
	/** Settings for a cwd. Defaults to pi's file-backed settings (global + project). */
	settingsManager?: (cwd: string) => SettingsManager;
	/** Session storage directory override. Defaults to pi's resolution (env, settings, per-cwd default). */
	sessionDir?: string;
	/** Disable discovery of extensions, skills, prompt templates, themes, and context files (tests). */
	isolated?: boolean;
	/** Resources loaded in addition to (or, when isolated, instead of) the discovered ones (tests). */
	extraResources?: {
		extensions?: InlineExtension[];
		skillPaths?: string[];
		promptTemplatePaths?: string[];
	};
}

export interface RuntimeRequest {
	cwd: string;
	sessionManager: SessionManager;
	/** Extensions injected by Pier (e.g. `pier-approval`). Recreated for every runtime replacement. */
	extensions: () => InlineExtension[];
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * Adapter over the pi SDK. All direct SDK calls for session storage, runtime creation,
 * and models live here so SDK upgrades are contained.
 */
export class PiEnvironment {
	readonly agentDir: string;
	readonly modelsPath: string;
	readonly modelRuntime: ModelRuntime;
	private readonly options: PiEnvironmentOptions;
	private mcpConfig: ((cwd: string) => LoadedMcpConfig) | undefined;

	setMcpConfig(load: (cwd: string) => LoadedMcpConfig): void {
		this.mcpConfig = load;
	}

	private constructor(options: PiEnvironmentOptions, agentDir: string, modelRuntime: ModelRuntime) {
		this.options = options;
		this.agentDir = agentDir;
		this.modelsPath = options.modelsPath ?? join(agentDir, "models.json");
		this.modelRuntime = modelRuntime;
	}

	static async create(options: PiEnvironmentOptions = {}): Promise<PiEnvironment> {
		const agentDir = options.agentDir ?? getAgentDir();
		const modelRuntime =
			options.modelRuntime ??
			(await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: options.modelsPath ?? join(agentDir, "models.json"),
			}));
		return new PiEnvironment(options, agentDir, modelRuntime);
	}

	settingsFor(cwd: string): SettingsManager {
		return this.options.settingsManager?.(cwd) ?? SettingsManager.create(cwd, this.agentDir);
	}

	/** Settings used for global values such as the default model (project settings do not apply). */
	globalSettings(): SettingsManager {
		return this.settingsFor(this.agentDir);
	}

	/** Session directory for a cwd, or undefined to use pi's per-cwd default. */
	sessionDirFor(cwd: string): string | undefined {
		if (this.options.sessionDir) return this.options.sessionDir;
		const env = process.env.PI_CODING_AGENT_SESSION_DIR;
		if (env) return expandHome(env);
		const configured = this.settingsFor(cwd).getSessionDir();
		return configured ? expandHome(configured) : undefined;
	}

	listSessions(cwd: string): Promise<SessionInfo[]> {
		return SessionManager.list(cwd, this.sessionDirFor(cwd));
	}

	findSessionPath(cwd: string, sessionId: string): string | undefined {
		return SessionManager.findById(cwd, sessionId, this.sessionDirFor(cwd));
	}

	newSessionManager(cwd: string): SessionManager {
		return SessionManager.create(cwd, this.sessionDirFor(cwd));
	}

	openSessionManager(path: string, cwd: string): SessionManager {
		return SessionManager.open(path, this.sessionDirFor(cwd));
	}

	/**
	 * Create a new session file forked from `session` without replacing it, mirroring
	 * `AgentSessionRuntime.fork()` semantics for `position`.
	 */
	forkSessionManager(
		session: AgentSession,
		entryId: string,
		position: "before" | "at",
	): { sessionManager: SessionManager; selectedText?: string } {
		const entry = session.sessionManager.getEntry(entryId);
		if (!entry) throw new Error("Invalid entry ID for forking");
		let targetLeafId: string | null;
		let selectedText: string | undefined;
		if (position === "at") {
			targetLeafId = entry.id;
		} else {
			if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Invalid entry ID for forking");
			targetLeafId = entry.parentId;
			selectedText = userText(entry.message.content);
		}
		const file = session.sessionFile;
		if (!file || !session.sessionManager.isPersisted()) throw new Error("Only persisted sessions can be forked");
		const cwd = session.sessionManager.getCwd();
		const sessionDir = session.sessionManager.getSessionDir();
		if (!targetLeafId) {
			const sessionManager = SessionManager.create(cwd, sessionDir);
			sessionManager.newSession({ parentSession: file });
			return { sessionManager, ...(selectedText === undefined ? {} : { selectedText }) };
		}
		const sessionManager = SessionManager.open(file, sessionDir);
		if (!sessionManager.createBranchedSession(targetLeafId)) throw new Error("Failed to create forked session");
		return { sessionManager, ...(selectedText === undefined ? {} : { selectedText }) };
	}

	async createRuntime(request: RuntimeRequest): Promise<AgentSessionRuntime> {
		const isolated = this.options.isolated === true;
		const extra = this.options.extraResources ?? {};
		const loadMcpConfig = this.mcpConfig;
		const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime: this.modelRuntime,
				settingsManager: this.settingsFor(cwd),
				resourceLoaderOptions: {
					extensionFactories: [
						...request.extensions(),
						...(loadMcpConfig
							? [
									{
										name: "mcp",
										builtin: true,
										replaceable: true,
										factory: createMcpExtension({
											loadConfig: () => loadMcpConfig(cwd),
											logPath: join(agentDir, "mcp.log"),
										}),
									},
									{
										name: "codemode",
										builtin: true,
										replaceable: true,
										factory: createCodemodeExtension(),
									},
									{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
								]
							: []),
						...(extra.extensions ?? []),
					],
					...(extra.skillPaths ? { additionalSkillPaths: extra.skillPaths } : {}),
					...(extra.promptTemplatePaths ? { additionalPromptTemplatePaths: extra.promptTemplatePaths } : {}),
					...(isolated
						? { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }
						: {}),
				},
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				...(sessionStartEvent ? { sessionStartEvent } : {}),
			});
			return { ...result, services, diagnostics: services.diagnostics };
		};
		return createAgentSessionRuntime(factory, {
			cwd: request.cwd,
			agentDir: this.agentDir,
			sessionManager: request.sessionManager,
		});
	}

	async listModels(): Promise<ModelInfo[]> {
		const models = await this.modelRuntime.getAvailable();
		return models.map(toModelInfo);
	}

	/**
	 * The model and thinking level a new session in `cwd` starts with, following pi's own
	 * resolution: the configured default model when its provider has credentials, otherwise the
	 * first available model; then the per-model thinking level, the default level, or `medium`,
	 * clamped to what the model supports.
	 */
	newSessionDefaults(cwd: string): { model?: ModelInfo; thinkingLevel: ThinkingLevel } {
		const settings = this.settingsFor(cwd);
		const runtime = this.modelRuntime;
		const provider = settings.getDefaultProvider();
		const modelId = settings.getDefaultModel();
		let model: Model<Api> | undefined;
		if (provider && modelId) {
			const found = runtime.getModel(provider, modelId);
			if (found && runtime.hasConfiguredAuth(found.provider)) model = found;
		}
		model ??= runtime.getAvailableSnapshot()[0];
		if (!model) return { thinkingLevel: "off" };
		const level =
			settings.getModelThinkingLevel(model.provider, model.id) ??
			settings.getDefaultThinkingLevel() ??
			DEFAULT_THINKING_LEVEL;
		return {
			model: toModelInfo(model),
			thinkingLevel: clampThinkingLevel(model, level === "ultra" ? "max" : level) as ThinkingLevel,
		};
	}
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && part.type === "text" ? String(part.text ?? "") : ""))
			.join("");
	}
	return "";
}

interface ModelLike {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: readonly string[];
	contextWindow?: number;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}

export function toModelInfo(model: ModelLike): ModelInfo {
	const reasoning = model.reasoning === true;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning,
		input: [...(model.input ?? ["text"])],
		...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
		thinkingLevels: getSupportedThinkingLevels({
			reasoning,
			...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		} as Model<Api>) as ThinkingLevel[],
	};
}
