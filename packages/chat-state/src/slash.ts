import type {
	AgentRuntimeCapabilities,
	AgentRuntimeId,
	ForkPoint,
	ModelInfo,
	SessionCommandInfo,
	ThinkingLevel,
} from "@pier/protocol";
import { clampThinking, supportedThinkingLevels } from "./thinking.ts";

/**
 * Slash commands typed into the composer.
 *
 * Built-in commands are carried out by the client through ordinary protocol methods.
 * Every other command comes from the host (`session.commands`: extension commands, prompt
 * templates, and `skill:*`) and is sent unchanged as a prompt, which the agent runtime expands.
 */

export type SlashCommandSource = "builtin" | SessionCommandInfo["source"];

export interface SlashCommand {
	/** Without the leading `/`. */
	name: string;
	description?: string;
	argumentHint?: string;
	source: SlashCommandSource;
	/** Picking it in the menu runs it right away instead of completing `/name `. */
	immediate: boolean;
}

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	ultra: "ultra",
};

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
	{ name: "new", description: "新建会话", source: "builtin", immediate: true },
	{ name: "model", description: "切换模型", argumentHint: "<provider/model>", source: "builtin", immediate: false },
	{
		name: "thinking",
		description: "设置思考等级",
		argumentHint: "<等级>",
		source: "builtin",
		immediate: false,
	},
	{ name: "compact", description: "压缩上下文", argumentHint: "[摘要要点]", source: "builtin", immediate: true },
	{ name: "fork", description: "从历史消息分叉", source: "builtin", immediate: false },
	{ name: "name", description: "重命名会话", argumentHint: "<名称>", source: "builtin", immediate: false },
	{
		name: "reload",
		description: "重新加载扩展、skills、提示词模板与上下文文件",
		source: "builtin",
		immediate: true,
	},
];

/** Built-in commands whose argument is picked from a list. */
export const ARGUMENT_COMMANDS: ReadonlySet<string> = new Set([
	"model",
	"thinking",
	"reasoning",
	"effort",
	"fork",
	"fast",
]);

/** Use each agent's command names for the operations Pier implements. */
const RUNTIME_COMMAND_NAMES: Record<string, Partial<Record<string, string>>> = {
	"claude-code": { new: "clear", thinking: "effort", name: "rename" },
	codex: { thinking: "reasoning", name: "rename" },
};

/** Built-in commands that need a runtime capability (see `AgentRuntimeCapabilities`). */
const BUILTIN_CAPABILITY: Partial<Record<string, keyof AgentRuntimeCapabilities>> = {
	model: "setModel",
	thinking: "thinking",
	compact: "compact",
	fork: "fork",
	name: "rename",
	reload: "reload",
};

/** The built-in commands a session supports (all of them without `capabilities`, as for pi). */
export function builtinCommands(capabilities?: AgentRuntimeCapabilities, runtime?: AgentRuntimeId): SlashCommand[] {
	const names = runtime ? RUNTIME_COMMAND_NAMES[runtime] : undefined;
	const commands = BUILTIN_COMMANDS.filter((command) => {
		// These runtimes cannot reload pi resources, including before the first snapshot.
		if (names && command.name === "reload") return false;
		const needs = BUILTIN_CAPABILITY[command.name];
		return !needs || !capabilities || capabilities[needs];
	}).map((command) => {
		const name = names?.[command.name];
		return name ? { ...command, name } : command;
	});
	if (runtime === "codex") {
		commands.splice(1, 0, {
			name: "clear",
			description: "新建会话，清空当前上下文",
			source: "builtin",
			immediate: true,
		});
		if (capabilities?.fastMode) {
			commands.push({
				name: "fast",
				description: "切换 Fast 模式",
				argumentHint: "[on|off|status]",
				source: "builtin",
				immediate: true,
			});
		}
	}
	return commands;
}

/** Display name of an agent runtime. */
export function agentRuntimeLabel(id: AgentRuntimeId | undefined): string {
	switch (id) {
		case undefined:
		case "pi":
			return "PI";
		case "claude-code":
			return "Claude Code";
		case "codex":
			return "Codex";
		case "opencode":
			return "OpenCode";
		case "hermes":
			return "Hermes";
		default:
			return id;
	}
}

/**
 * Built-ins first; host commands that a built-in shadows are dropped. `capabilities` hides the
 * built-ins the session's runtime does not support (its own command of that name stays).
 */
export function mergeCommands(
	host: readonly SessionCommandInfo[],
	capabilities?: AgentRuntimeCapabilities,
	runtime?: AgentRuntimeId,
): SlashCommand[] {
	const builtins = builtinCommands(capabilities, runtime);
	const seen = new Set(builtins.map((c) => c.name));
	const merged: SlashCommand[] = [...builtins];
	for (const command of host) {
		if (seen.has(command.name)) continue;
		seen.add(command.name);
		merged.push({
			...command,
			// Skills and templates with arguments are usually followed by a task.
			immediate: command.source === "extension" || (command.source === "prompt" && !command.argumentHint),
		});
	}
	return merged;
}

export interface ParsedSlash {
	name: string;
	/** Everything after the name, trimmed. */
	args: string;
}

/**
 * Parse `/name args`. Text whose first word contains another `/` (a path such as
 * `/usr/bin`) or that starts with `//` is an ordinary message.
 */
export function parseSlash(text: string): ParsedSlash | undefined {
	const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	return { name: match[1] as string, args: (match[2] ?? "").trim() };
}

function rank(command: SlashCommand, query: string): number {
	if (!query) return 0;
	const name = command.name.toLowerCase();
	const bare = name.startsWith("skill:") ? name.slice(6) : name;
	if (name === query) return 0;
	if (name.startsWith(query) || bare.startsWith(query)) return 1;
	if (name.includes(query)) return 2;
	if (command.description?.toLowerCase().includes(query)) return 3;
	return -1;
}

/** Commands matching what follows the `/`, best matches first (stable otherwise). */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
	const q = query.trim().toLowerCase();
	return commands
		.map((command, index) => ({ command, index, score: rank(command, q) }))
		.filter((c) => c.score >= 0)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map((c) => c.command);
}

export type SlashMenuState =
	| { kind: "commands"; query: string; items: SlashCommand[] }
	| { kind: "arguments"; command: string; query: string };

/** What the composer menu should show for the current text, if anything. */
export function slashMenu(text: string, commands: readonly SlashCommand[]): SlashMenuState | undefined {
	if (!text.startsWith("/") || text.includes("\n")) return undefined;
	const name = /^\/([^\s/]*)$/.exec(text);
	if (name) return { kind: "commands", query: name[1] as string, items: filterCommands(commands, name[1] as string) };
	const args = /^\/(\S+)\s([\s\S]*)$/.exec(text);
	if (
		args &&
		ARGUMENT_COMMANDS.has(args[1] as string) &&
		commands.some((command) => command.name === args[1] && command.source === "builtin")
	) {
		return { kind: "arguments", command: args[1] as string, query: (args[2] as string).trimStart() };
	}
	return undefined;
}

/** Text after picking a command in the menu, and whether to run it right away. */
export function pickCommand(command: SlashCommand, run = true): { text: string; run: boolean } {
	return run && command.immediate ? { text: `/${command.name}`, run: true } : { text: `/${command.name} `, run: false };
}

export interface SlashOption {
	/** Argument sent with the command. */
	value: string;
	label: string;
	detail?: string;
	selected?: boolean;
}

/** The parts of `ChatController` the built-in commands use. */
export interface SlashTarget {
	readonly chat: { model?: ModelInfo; thinkingLevel: string; runState: string; fastMode?: boolean };
	listModels(): Promise<{ models: ModelInfo[] }>;
	setModel(provider: string, modelId: string): Promise<unknown>;
	setThinking(level: ThinkingLevel): Promise<unknown>;
	setFast(enabled?: boolean): Promise<{ enabled: boolean } | undefined>;
	compact(instructions?: string): Promise<unknown>;
	forkPoints(): Promise<{ points: ForkPoint[] }>;
	rename(name: string): Promise<unknown>;
	reload(): Promise<unknown>;
}

/** Options for the argument of `/model`, `/thinking`, or `/fork`. */
export async function loadArgumentOptions(
	target: Pick<SlashTarget, "chat" | "listModels" | "forkPoints">,
	command: string,
): Promise<SlashOption[]> {
	switch (command) {
		case "fast":
			return [
				{ value: "on", label: "on", detail: "开启 Fast 模式", selected: target.chat.fastMode === true },
				{ value: "off", label: "off", detail: "关闭 Fast 模式", selected: target.chat.fastMode === false },
				{ value: "status", label: "status", detail: "查看 Fast 模式状态" },
			];
		case "model": {
			const current = target.chat.model;
			const { models } = await target.listModels();
			return models.map((model) => ({
				value: `${model.provider}/${model.id}`,
				label: model.name || model.id,
				detail: `${model.provider}/${model.id}`,
				selected: current?.provider === model.provider && current.id === model.id,
			}));
		}
		case "thinking":
		case "reasoning":
		case "effort": {
			// Ultra needs an explicit capability; older catalogs offer only the legacy levels.
			const model = target.chat.model;
			const levels = model
				? supportedThinkingLevels(model)
				: (Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).filter((level) => level !== "ultra");
			const current = clampThinking(target.chat.thinkingLevel, levels);
			return levels.map((level) => ({
				value: level,
				label: THINKING_LEVEL_LABELS[level],
				detail: level,
				selected: current === level,
			}));
		}
		case "fork": {
			const { points } = await target.forkPoints();
			return [...points].reverse().map((point) => ({
				value: point.entryId,
				label: point.text.replace(/\s+/g, " ").trim().slice(0, 120) || "（空消息）",
			}));
		}
		default:
			return [];
	}
}

export function filterOptions(options: readonly SlashOption[], query: string): SlashOption[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...options];
	return options.filter((o) => `${o.value} ${o.label} ${o.detail ?? ""}`.toLowerCase().includes(q));
}

/** Resolve `/model <arg>`: `provider/id`, or an id or name that matches exactly one model. */
export function matchModel(models: readonly ModelInfo[], arg: string): ModelInfo | { error: string } {
	const q = arg.trim().toLowerCase();
	const exact = models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === q);
	if (exact) return exact;
	for (const key of ["id", "name"] as const) {
		const hits = models.filter((m) => m[key].toLowerCase() === q);
		if (hits.length === 1) return hits[0] as ModelInfo;
		if (hits.length > 1) return { error: `有多个模型叫 ${arg}，请写成 provider/model` };
	}
	return { error: `找不到模型 ${arg}` };
}

export interface SlashActions {
	newSession(): Promise<boolean> | boolean;
	fork(entryId: string): Promise<boolean> | boolean;
	notify(level: "info" | "warning" | "error", message: string): void;
}

export type SlashResolution =
	| { kind: "message" }
	| { kind: "builtin"; name: string; args: string }
	| { kind: "host"; command: string }
	| { kind: "unknown"; name: string };

/**
 * Classify composer text. `known` is false when the host could not list its commands
 * (an older host): unknown pi commands are then passed to the agent unchanged.
 * Native agents require a listed command so CLI-only controls never become ordinary prompts.
 */
export function resolveSlash(
	text: string,
	commands: readonly SlashCommand[],
	known = true,
	runtime?: AgentRuntimeId,
): SlashResolution {
	const parsed = parseSlash(text);
	if (!parsed) return { kind: "message" };
	const command = commands.find((c) => c.name === parsed.name);
	if (command?.source === "builtin") return { kind: "builtin", ...parsed };
	if (command || (!known && (!runtime || runtime === "pi"))) return { kind: "host", command: parsed.name };
	return { kind: "unknown", name: parsed.name };
}

/**
 * Result of a built-in command: `done` clears the composer, `failed` keeps it, and
 * `complete` replaces the text (the command needs an argument picked from the menu).
 */
export type SlashResult = { kind: "done" } | { kind: "failed" } | { kind: "complete"; text: string };

const DONE: SlashResult = { kind: "done" };
const FAILED: SlashResult = { kind: "failed" };

function isIdle(target: SlashTarget): boolean {
	return target.chat.runState === "idle" || target.chat.runState === "inactive";
}

/** Carry out a built-in command. Errors of the underlying requests are reported by the controller. */
export async function runBuiltin(
	target: SlashTarget,
	name: string,
	args: string,
	actions: SlashActions,
): Promise<SlashResult> {
	switch (name) {
		case "fast": {
			const arg = args.toLowerCase();
			if (arg && arg !== "on" && arg !== "off" && arg !== "status") {
				actions.notify("warning", "用法：/fast [on|off|status]，不带参数切换 Fast 模式");
				return FAILED;
			}
			if (arg === "status") {
				actions.notify("info", `Fast 模式${target.chat.fastMode ? "已开启" : "已关闭"}`);
				return DONE;
			}
			const result = await target.setFast(arg ? arg === "on" : undefined);
			if (result === undefined) return FAILED;
			const text = `Fast 模式${result.enabled ? "已开启" : "已关闭"}`;
			const suffix = isIdle(target) ? "" : "，从下一轮生效";
			actions.notify("info", text + suffix);
			return DONE;
		}
		case "new":
		case "clear":
			return (await actions.newSession()) ? DONE : FAILED;
		case "model": {
			if (!args) return { kind: "complete", text: "/model " };
			let models: ModelInfo[];
			try {
				models = (await target.listModels()).models;
			} catch (error) {
				actions.notify("error", `读取模型列表失败：${error instanceof Error ? error.message : String(error)}`);
				return FAILED;
			}
			const model = matchModel(models, args);
			if ("error" in model) {
				actions.notify("error", model.error);
				return FAILED;
			}
			return (await target.setModel(model.provider, model.id)) === undefined ? FAILED : DONE;
		}
		case "thinking":
		case "reasoning":
		case "effort": {
			if (!args) return { kind: "complete", text: `/${name} ` };
			const level = args.toLowerCase();
			if (!Object.hasOwn(THINKING_LEVEL_LABELS, level)) {
				actions.notify("error", `未知的思考等级 ${args}，可选：${Object.keys(THINKING_LEVEL_LABELS).join("、")}`);
				return FAILED;
			}
			if (!target.chat.model?.reasoning) actions.notify("warning", "当前模型不支持思考等级");
			return (await target.setThinking(level as ThinkingLevel)) === undefined ? FAILED : DONE;
		}
		case "compact":
			if (!isIdle(target)) {
				actions.notify("warning", "Agent 正在运行，请等它完成后再压缩上下文");
				return FAILED;
			}
			// Compaction can take minutes; the session state shows its progress.
			void target.compact(args || undefined);
			return DONE;
		case "fork": {
			if (!args) return { kind: "complete", text: "/fork " };
			let points: ForkPoint[];
			try {
				points = (await target.forkPoints()).points;
			} catch (error) {
				actions.notify("error", `读取历史消息失败：${error instanceof Error ? error.message : String(error)}`);
				return FAILED;
			}
			if (!points.some((p) => p.entryId === args)) {
				actions.notify("warning", "请从列表中选择要分叉的消息");
				return { kind: "complete", text: "/fork " };
			}
			return (await actions.fork(args)) ? DONE : FAILED;
		}
		case "name":
		case "rename":
			if (!args) {
				actions.notify("warning", `用法：/${name} <名称>`);
				return { kind: "complete", text: `/${name} ` };
			}
			return (await target.rename(args.slice(0, 200))) === undefined ? FAILED : DONE;
		case "reload":
			if (!isIdle(target)) {
				actions.notify("warning", "Agent 正在运行，请等它完成后再重新加载");
				return FAILED;
			}
			if ((await target.reload()) === undefined) return FAILED;
			actions.notify("info", "已重新加载扩展、skills、提示词模板与上下文文件");
			return DONE;
		default:
			actions.notify("error", `未知命令 /${name}`);
			return FAILED;
	}
}
