import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SDKControlInitializeResponse, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type AgentRuntimeInfo,
	type ModelInfo,
	PierProtocolError,
	type SessionCommandInfo,
	type ThinkingLevel,
	type WorkspaceInfo,
} from "@pier/protocol";
import type { ManagedSession, ManagedSessionOptions } from "../managed-session.ts";
import { findExecutable, probeVersion } from "../runtimes/executable.ts";
import { InputQueue } from "../runtimes/input-queue.ts";
import { AgentInstaller } from "../runtimes/installation.ts";
import type { UserMessage } from "../runtimes/live-transcript.ts";
import { userContentText } from "../runtimes/live-transcript.ts";
import type { AgentRuntime, ForkResult, StoredSession, UsageRecord } from "../runtimes/types.ts";
import { FileUsageCache } from "../runtimes/usage-files.ts";
import {
	CLAUDE_CAPABILITIES,
	CLAUDE_THINKING_LEVELS,
	ClaudeCodeSession,
	type ClaudeSdk,
	type ClaudeSessionHost,
} from "./claude-session.ts";
import { CLAUDE_PROVIDER, convertTranscript } from "./convert.ts";
import { claudeSessionUsage } from "./usage.ts";

export interface ClaudeCodeRuntimeOptions {
	installationHome?: string;
	managedDirectory?: string;
	/** `claude` executable. Defaults to `PIER_CLAUDE_PATH`, then `claude` on `PATH`. */
	executable?: string;
	/** Claude Code's configuration directory. Defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`. */
	configDir?: string;
	/** SDK implementation (tests). Defaults to `@anthropic-ai/claude-agent-sdk`. */
	sdk?: ClaudeSdk;
	/** Models and slash commands, instead of asking the CLI (tests). */
	catalog?: { models: ModelInfo[]; commands: SessionCommandInfo[] };
	/** How long an idle session keeps its Claude Code process (tests). Defaults to 10 minutes. */
	processIdleMs?: number;
	log?: (message: string) => void;
}

/** How long the CLI's model and command list is reused. */
const CATALOG_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;

/** Commands that only make sense in Claude Code's terminal UI. */
const TERMINAL_COMMANDS = new Set([
	"clear",
	"config",
	"doctor",
	"exit",
	"quit",
	"ide",
	"keybindings",
	"login",
	"logout",
	"resume",
	"statusline",
	"terminal-setup",
	"theme",
	"vim",
	"bug",
	"feedback",
	"permissions",
	"hooks",
	"agents",
	"mcp",
	"plugin",
	"upgrade",
]);

/** Claude Code's configuration directory: `configDir`, `CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeConfigDir(configDir?: string): string {
	return configDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
}

/** Claude Code's project directory name for a cwd. */
export function claudeProjectKey(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** A model of Claude Code's catalog, with the description its `/model` picker shows. */
export function claudeModelInfo(model: SDKControlInitializeResponse["models"][number]): ModelInfo {
	const efforts = (model.supportedEffortLevels ?? []) as ThinkingLevel[];
	const levels: ThinkingLevel[] = efforts.length ? ["off", ...efforts] : ["off"];
	const description = typeof model.description === "string" ? model.description.trim() : "";
	return {
		provider: CLAUDE_PROVIDER,
		id: model.value,
		name: model.displayName || model.value,
		...(description ? { description } : {}),
		reasoning: model.supportsEffort === true || model.supportsAdaptiveThinking === true,
		input: ["text", "image"],
		...(/\[1m\]/i.test(model.value) || /\[1m\]/i.test(model.resolvedModel ?? "") ? { contextWindow: 1_000_000 } : {}),
		thinkingLevels: levels,
	};
}

interface CountCacheEntry {
	mtimeMs: number;
	size: number;
	count: number;
}

/** Claude Code, driven through the Claude Agent SDK with the user's own `claude` CLI and login. */
export class ClaudeCodeRuntime implements AgentRuntime {
	readonly id = "claude-code";
	readonly name = "Claude Code";
	readonly capabilities = CLAUDE_CAPABILITIES;
	private sdkPromise: Promise<ClaudeSdk> | undefined;
	private versionPromise: Promise<string | undefined> | undefined;
	private versionFor: string | undefined;
	private catalog: { models: ModelInfo[]; commands: SessionCommandInfo[]; at: number } | undefined;
	private catalogPromise: Promise<void> | undefined;
	private readonly counts = new Map<string, CountCacheEntry>();
	private readonly usageFiles = new FileUsageCache();
	private readonly log: (message: string) => void;

	constructor(private readonly options: ClaudeCodeRuntimeOptions = {}) {
		this.log = options.log ?? (() => {});
		if (options.catalog) this.catalog = { ...options.catalog, at: Number.POSITIVE_INFINITY };
	}

	executable(): string | undefined {
		if (this.options.executable) return this.options.executable;
		return findExecutable(
			"claude",
			process.env.PIER_CLAUDE_PATH,
			this.options.managedDirectory
				? AgentInstaller.executable(this.options.managedDirectory, this.id, this.options.installationHome)
				: undefined,
		);
	}

	private get configDir(): string {
		return claudeConfigDir(this.options.configDir);
	}

	/** Where Claude Code reads its user settings. */
	userConfigDir(): string {
		return this.configDir;
	}

	/** A settings file changed (model, environment): read the models and commands again. */
	configChanged(): void {
		if (!this.options.catalog) this.catalog = undefined;
	}

	installationChanged(): void {
		this.versionFor = undefined;
		this.versionPromise = undefined;
		this.configChanged();
	}

	sdk(): Promise<ClaudeSdk> {
		if (this.options.sdk) return Promise.resolve(this.options.sdk);
		this.sdkPromise ??= import("@anthropic-ai/claude-agent-sdk");
		return this.sdkPromise;
	}

	/** Where Claude Code stores a session of `cwd`. */
	sessionFile(cwd: string, sessionId: string): string {
		const direct = join(this.configDir, "projects", claudeProjectKey(cwd), `${sessionId}.jsonl`);
		if (existsSync(direct)) return direct;
		// Long paths are shortened with a hash; look for the session in every project directory.
		try {
			for (const dir of readdirSync(join(this.configDir, "projects"))) {
				const candidate = join(this.configDir, "projects", dir, `${sessionId}.jsonl`);
				if (existsSync(candidate)) return candidate;
			}
		} catch {
			// No projects yet.
		}
		return direct;
	}

	async info(refresh = false): Promise<AgentRuntimeInfo> {
		const executable = this.executable();
		if (!executable) {
			return {
				id: this.id,
				name: this.name,
				available: false,
				reason: "未找到 Claude Code，请在「设置 → Agent 配置 → Claude Code」安装并登录，或设置 PIER_CLAUDE_PATH。",
				capabilities: this.capabilities,
			};
		}
		if (refresh || this.versionFor !== executable) {
			this.versionFor = executable;
			this.versionPromise = probeVersion(executable);
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

	private sessionHost(): ClaudeSessionHost {
		return {
			sdk: () => this.sdk(),
			executable: () => this.executable(),
			sessionFile: (cwd, id) => this.sessionFile(cwd, id),
			model: (id) => this.catalog?.models.find((m) => m.id === id),
			commands: () => this.catalog?.commands ?? [],
			defaultThinkingLevel: () => this.defaultThinkingLevel(),
			...(this.options.processIdleMs !== undefined ? { processIdleMs: this.options.processIdleMs } : {}),
			log: this.log,
		};
	}

	private defaultThinkingLevel(): ThinkingLevel {
		try {
			const settings = JSON.parse(readFileSync(join(this.configDir, "settings.json"), "utf8")) as {
				effortLevel?: unknown;
				alwaysThinkingEnabled?: unknown;
			};
			if (typeof settings.effortLevel === "string" && CLAUDE_THINKING_LEVELS.includes(settings.effortLevel as never)) {
				return settings.effortLevel as ThinkingLevel;
			}
		} catch {
			// No settings.
		}
		return "high";
	}

	/** Approximate number of prompts and replies in a session file (cached by size and mtime). */
	private messageCount(path: string): number {
		try {
			const stat = statSync(path);
			const cached = this.counts.get(path);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.count;
			let count = 0;
			const replies = new Set<string>();
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (line.includes('"isSidechain":true') || line.includes('"isMeta":true')) continue;
				if (line.includes('"type":"user"') && !line.includes('"tool_result"')) count++;
				else if (line.includes('"type":"assistant"')) {
					const id = /"id":"(msg_[A-Za-z0-9_-]+)"/.exec(line)?.[1];
					if (id) replies.add(id);
				}
			}
			count += replies.size;
			this.counts.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, count });
			return count;
		} catch {
			return 0;
		}
	}

	async listSessions(workspace: WorkspaceInfo): Promise<StoredSession[]> {
		if (!this.options.sdk && !this.executable()) return [];
		const projects = join(this.configDir, "projects");
		if (!this.options.sdk && !existsSync(projects)) return [];
		const sdk = await this.sdk();
		const infos = await sdk.listSessions({ dir: workspace.path, includeWorktrees: false, includeProgrammatic: true });
		const sessions: StoredSession[] = [];
		for (const info of infos) {
			if (info.cwd && info.cwd !== workspace.path) continue;
			const path = this.sessionFile(workspace.path, info.sessionId);
			const name = info.customTitle?.trim();
			sessions.push({
				id: info.sessionId,
				...(existsSync(path) ? { path } : {}),
				...(name ? { name } : {}),
				cwd: info.cwd ?? workspace.path,
				created: new Date(info.createdAt ?? info.lastModified),
				modified: new Date(info.lastModified),
				messageCount: existsSync(path) ? this.messageCount(path) : 0,
				firstMessage: (info.firstPrompt ?? info.summary ?? "").slice(0, 200),
			});
		}
		return sessions;
	}

	/** The session's replies and its subagents' (1.68), from Claude Code's transcripts. */
	usage(_workspace: WorkspaceInfo, stored: StoredSession): Promise<UsageRecord[]> {
		return stored.path ? claudeSessionUsage(stored.path, this.usageFiles) : Promise.resolve([]);
	}

	async create(options: ManagedSessionOptions): Promise<ManagedSession> {
		await this.ensureCatalog();
		return ClaudeCodeSession.start(options, this.sessionHost(), { sessionId: randomUUID(), existing: false });
	}

	async open(options: ManagedSessionOptions, stored: StoredSession): Promise<ManagedSession> {
		const sdk = await this.sdk();
		const [entries] = await Promise.all([
			sdk.getSessionMessages(stored.id, { dir: options.workspace().path }),
			this.ensureCatalog(),
		]);
		return ClaudeCodeSession.start(options, this.sessionHost(), {
			sessionId: stored.id,
			existing: true,
			...(stored.name ? { name: stored.name } : {}),
			createdAt: stored.created.toISOString(),
			messages: convertTranscript(entries),
		});
	}

	async fork(
		source: ManagedSession,
		entryId: string,
		position: "before" | "at",
		options: ManagedSessionOptions,
	): Promise<ForkResult> {
		if (source.busy) throw new PierProtocolError("CONFLICT", "Wait for the agent to finish before forking");
		const cwd = options.workspace().path;
		const sdk = await this.sdk();
		const entries = await sdk.getSessionMessages(source.id, { dir: cwd });
		const index = entries.findIndex((e) => e.uuid === entryId);
		const entry = entries[index];
		if (entry?.type !== "user") throw new PierProtocolError("BAD_REQUEST", "Invalid entry ID for forking");
		const prompt = convertTranscript([entry]).find((m): m is UserMessage => m.role === "user");
		const selectedText = prompt ? userContentText(prompt.content) : undefined;
		const upTo = position === "at" ? entry.uuid : entries[index - 1]?.uuid;
		await this.ensureCatalog();
		if (!upTo) {
			const session = ClaudeCodeSession.start(options, this.sessionHost(), {
				sessionId: randomUUID(),
				existing: false,
			});
			return selectedText === undefined || position === "at" ? { session } : { session, selectedText };
		}
		const { sessionId } = await sdk.forkSession(source.id, { dir: cwd, upToMessageId: upTo });
		const forkedEntries = await sdk.getSessionMessages(sessionId, { dir: cwd });
		const session = ClaudeCodeSession.start(options, this.sessionHost(), {
			sessionId,
			existing: true,
			messages: convertTranscript(forkedEntries),
		});
		return position === "before" && selectedText !== undefined ? { session, selectedText } : { session };
	}

	/** Ask the CLI for its models and slash commands (a short-lived process that sends no prompt). */
	private ensureCatalog(): Promise<void> {
		if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return Promise.resolve();
		this.catalogPromise ??= this.probe().finally(() => {
			this.catalogPromise = undefined;
		});
		return this.catalogPromise;
	}

	private async probe(): Promise<void> {
		const executable = this.executable();
		if (!executable) return;
		const sdk = await this.sdk();
		const input = new InputQueue<SDKUserMessage>();
		const query = sdk.query({
			prompt: input,
			options: { cwd: homedir(), pathToClaudeCodeExecutable: executable, persistSession: false },
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const init = await Promise.race([
				query.initializationResult(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Claude Code did not start in time")), PROBE_TIMEOUT_MS);
				}),
			]);
			this.catalog = {
				models: init.models.map(claudeModelInfo),
				commands: init.commands
					.filter((c) => !TERMINAL_COMMANDS.has(c.name))
					.map((c) => ({
						name: c.name,
						...(c.description ? { description: c.description } : {}),
						...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
						source: "prompt" as const,
					})),
				at: Date.now(),
			};
		} catch (error) {
			this.log(`reading Claude Code's models failed: ${error instanceof Error ? error.message : error}`);
		} finally {
			if (timer) clearTimeout(timer);
			input.close();
			try {
				query.close();
			} catch {
				// Already closed.
			}
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		if (!this.executable() && !this.options.catalog) return [];
		await this.ensureCatalog();
		return this.catalog?.models ?? [];
	}

	async newSessionDefaults(_cwd: string): Promise<{ model?: ModelInfo; thinkingLevel: ThinkingLevel }> {
		const models = await this.listModels();
		const model = models.find((m) => m.id === "default") ?? models[0];
		const level = this.defaultThinkingLevel();
		const thinkingLevel = model?.thinkingLevels?.includes(level) ? level : (model?.thinkingLevels?.at(-1) ?? level);
		return model ? { model, thinkingLevel } : { thinkingLevel };
	}

	async dispose(): Promise<void> {}
}
