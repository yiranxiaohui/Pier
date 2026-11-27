import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type AgentConfigFile, PierProtocolError, type PluginInfo, type ResourceScope } from "@pier/protocol";
import type { ExtensionTarget } from "../pi/extensions.ts";
import type { AgentConfigFiles } from "./agent-config.ts";
import { type JsonObject, object, readJson } from "./resource-files.ts";

/** A visible installation, with what Pier lists from it besides the summary. */
export interface ClaudePlugin extends PluginInfo {
	/** Skill directories, each holding a `SKILL.md` (any case). */
	skills: Array<{ dir: string; file: string }>;
	mcpServers: Array<{ name: string; config: JsonObject; path: string }>;
	/** Installed by managed (organization) settings: listed as `user`, but not the user's to uninstall. */
	managed: boolean;
}

interface Installation {
	scope: string;
	installPath?: unknown;
	projectPath?: unknown;
	version?: unknown;
}

/** Claude Code's specificity order of installation scopes: a project's own install wins. */
const INSTALL_ORDER = ["local", "project", "user", "managed"];

/** How long `claude plugin uninstall` may take. */
const UNINSTALL_TIMEOUT_MS = 60_000;

/**
 * Plugin IDs Pier passes to `claude plugin uninstall`: Claude Code's `name@marketplace` names. The
 * first character keeps an ID from reading as an option, the rest keep it out of a Windows shell.
 */
const COMMAND_LINE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*(@[A-Za-z0-9._+-]+)?$/;

function failure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32" || process.platform === "darwin"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The `SKILL.md` of a skill directory; Claude Code accepts any case. */
function skillFile(dir: string): string | undefined {
	try {
		const name = readdirSync(dir).find((entry) => /^skill\.md$/i.test(entry));
		return name ? join(dir, name) : undefined;
	} catch {
		return undefined;
	}
}

/** Markdown files below `path` (or `path` itself), as Claude Code loads commands and agents. */
function markdownFiles(path: string, depth = 0): number {
	if (depth > 8) return 0;
	try {
		if (!statSync(path).isDirectory()) return path.toLowerCase().endsWith(".md") ? 1 : 0;
		return readdirSync(path).reduce((sum, entry) => sum + markdownFiles(join(path, entry), depth + 1), 0);
	} catch {
		return 0;
	}
}

interface CliRun {
	/** Exit code; `null` when the command did not exit on its own. */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Why the command could not be started. */
	spawnError?: string;
}

function runCli(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<CliRun> {
	return new Promise((done) => {
		try {
			execFile(
				executable,
				args,
				{
					cwd: options.cwd,
					env: options.env,
					timeout: UNINSTALL_TIMEOUT_MS,
					maxBuffer: 1024 * 1024,
					windowsHide: true,
					// npm installs `claude.cmd` on Windows, which only a shell runs.
					shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
				},
				(error, stdout, stderr) => {
					const run = { stdout: String(stdout), stderr: String(stderr) };
					if (!error) return done({ ...run, code: 0, timedOut: false });
					const { code, killed, signal } = error as { code?: unknown; killed?: boolean; signal?: unknown };
					done({
						...run,
						code: typeof code === "number" ? code : null,
						timedOut: Boolean(killed && signal),
						// A string code (`ENOENT`, `EACCES`) means the command never ran.
						...(typeof code === "string" ? { spawnError: error.message } : {}),
					});
				},
			);
		} catch (error) {
			// Invalid native executables can throw before the callback on macOS and Windows.
			done({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: failure(error) });
		}
	});
}

/** The result line `--json` prints: `{ command, outcome: "ok" | "failed", message, failureCode? }`. */
function cliOutcome(stdout: string): { outcome: string; message?: string; failureCode?: string } | undefined {
	for (const line of stdout.split(/\r?\n/).reverse()) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			const value = object(JSON.parse(text));
			if (typeof value.outcome !== "string") continue;
			return {
				outcome: value.outcome,
				...(typeof value.message === "string" ? { message: value.message } : {}),
				...(typeof value.failureCode === "string" ? { failureCode: value.failureCode } : {}),
			};
		} catch {
			// Not the result line.
		}
	}
	return undefined;
}

/** The last line the CLI printed, for a failure without a result line. */
function lastLine(run: CliRun): string {
	const lines = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).map((line) => line.trim());
	return (lines.filter(Boolean).pop() ?? "").slice(0, 500);
}

/**
 * Installed Claude Code plugins. Claude Code installs them (`/plugin`, `claude plugin install`)
 * and records them in `plugins/installed_plugins.json`; `enabledPlugins` in its settings files
 * decides which ones load. Pier lists them and switches `enabledPlugins`; uninstalling is left to
 * the `claude` CLI, which also cleans up the plugin's settings and data.
 */
export class ClaudePlugins {
	/** Uninstalls run one at a time: each rewrites Claude Code's registry and settings. */
	private uninstalling: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly configs: AgentConfigFiles,
		/** The `claude` executable, when Claude Code is installed. */
		private readonly executable: () => string | undefined = () => undefined,
	) {}

	private dir(): string {
		const custom = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
		return custom ? resolve(custom) : join(this.configs.configDir("claude-code"), "plugins");
	}

	/** The settings files that can set `enabledPlugins` here, lowest precedence first. */
	private settings(target?: ExtensionTarget): { files: AgentConfigFile[]; errors: string[] } {
		const files: AgentConfigFile[] = [];
		const errors: string[] = [];
		for (const scope of this.configs.scopes("claude-code")) {
			if (scope !== "user" && !target) continue;
			try {
				const file = this.configs.read("claude-code", scope, target?.path);
				if (file.error) errors.push(`无法解析插件设置：${file.path}`);
				files.push(file);
			} catch (error) {
				errors.push(failure(error));
			}
		}
		return { files, errors };
	}

	/**
	 * User installs, plus the project / local installs of the selected workspace. The skill and MCP
	 * lists pass `settingsErrors: false`: they already report the settings files they read.
	 */
	list(target?: ExtensionTarget, { settingsErrors = true } = {}): { plugins: ClaudePlugin[]; errors: string[] } {
		const settings = this.settings(target);
		const files = settings.files;
		const errors = settingsErrors ? settings.errors : [];
		const registry = join(this.dir(), "installed_plugins.json");
		let doc: JsonObject;
		try {
			doc = readJson(registry);
		} catch (error) {
			return { plugins: [], errors: [...errors, failure(error)] };
		}
		const plugins: ClaudePlugin[] = [];
		for (const [id, value] of Object.entries(object(doc.plugins))) {
			// Version 2 keeps a list of installations per plugin; version 1 one user installation.
			const entries = (Array.isArray(value) ? value : [{ ...object(value), scope: "user" }])
				.map((entry) => object(entry) as unknown as Installation)
				.filter((entry) => {
					if (entry.scope === "user" || entry.scope === "managed") return true;
					if (entry.scope !== "project" && entry.scope !== "local") return false;
					return Boolean(target && typeof entry.projectPath === "string" && samePath(entry.projectPath, target.path));
				})
				.sort((a, b) => INSTALL_ORDER.indexOf(a.scope) - INSTALL_ORDER.indexOf(b.scope));
			const entry = entries[0];
			if (!entry) continue;
			if (typeof entry.installPath !== "string" || !isAbsolute(entry.installPath)) {
				errors.push(`插件 ${id} 没有记录安装目录：${registry}`);
				continue;
			}
			if (!isDir(entry.installPath)) {
				errors.push(`插件 ${id} 的安装目录不存在：${entry.installPath}，请在 Claude Code 中重新安装`);
				continue;
			}
			plugins.push(this.describe(id, entry, entry.installPath, files, errors));
		}
		plugins.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		return { plugins, errors };
	}

	private describe(
		id: string,
		entry: Installation,
		root: string,
		files: AgentConfigFile[],
		errors: string[],
	): ClaudePlugin {
		const manifestPath = join(root, ".claude-plugin", "plugin.json");
		let manifest: JsonObject = {};
		try {
			manifest = readJson(manifestPath);
		} catch (error) {
			errors.push(failure(error));
		}
		const at = id.lastIndexOf("@");
		const name = typeof manifest.name === "string" && manifest.name ? manifest.name : at > 0 ? id.slice(0, at) : id;
		// Manifest paths are relative to the plugin and supplement its default folders.
		const paths = (value: unknown): string[] =>
			(typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
				.filter((p): p is string => typeof p === "string" && Boolean(p))
				.map((p) => resolve(root, p))
				.filter((p) => !relative(root, p).startsWith(".."));

		const skills: ClaudePlugin["skills"] = [];
		const seen = new Set<string>();
		const addSkill = (dir: string) => {
			const file = skillFile(dir);
			if (file && !seen.has(dir)) {
				seen.add(dir);
				skills.push({ dir, file });
			}
		};
		for (const folder of [join(root, "skills"), ...paths(manifest.skills)]) {
			if (!isDir(folder)) continue;
			if (skillFile(folder)) {
				addSkill(folder);
				continue;
			}
			try {
				for (const child of readdirSync(folder).sort()) if (isDir(join(folder, child))) addSkill(join(folder, child));
			} catch (error) {
				errors.push(`无法读取插件 ${id} 的技能目录：${folder}（${failure(error)}）`);
			}
		}

		const servers = new Map<string, { config: JsonObject; path: string }>();
		const addServers = (value: JsonObject, path: string) => {
			// `.mcp.json` either wraps its servers in `mcpServers` or is the map itself.
			const map = value.mcpServers && typeof value.mcpServers === "object" ? object(value.mcpServers) : value;
			for (const [server, config] of Object.entries(map))
				if (config && typeof config === "object" && !Array.isArray(config))
					servers.set(server, { config: config as JsonObject, path });
		};
		const readServers = (path: string) => {
			try {
				if (existsSync(path)) addServers(readJson(path), path);
			} catch (error) {
				errors.push(failure(error));
			}
		};
		readServers(join(root, ".mcp.json"));
		for (const source of Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers]) {
			if (typeof source === "string") {
				const [path] = paths(source);
				if (path?.toLowerCase().endsWith(".json")) readServers(path);
			} else if (source && typeof source === "object") addServers({ mcpServers: source }, manifestPath);
		}

		const count = (folder: string, extra: unknown) =>
			[join(root, folder), ...paths(extra)].reduce((sum, path) => sum + markdownFiles(path), 0);
		const author =
			typeof manifest.author === "string"
				? manifest.author
				: typeof object(manifest.author).name === "string"
					? (object(manifest.author).name as string)
					: undefined;
		const version = [manifest.version, entry.version].find(
			(v): v is string => typeof v === "string" && Boolean(v) && v !== "unknown",
		);
		const scope: ResourceScope = entry.scope === "project" || entry.scope === "local" ? entry.scope : "user";
		return {
			runtime: "claude-code",
			id,
			name,
			marketplace: at > 0 ? id.slice(at + 1) : "",
			description: typeof manifest.description === "string" ? manifest.description : "",
			...(version ? { version } : {}),
			...(author ? { author } : {}),
			scope,
			path: root,
			enabled: this.enabled(id, files),
			contents: {
				skills: skills.length,
				commands: count("commands", manifest.commands),
				agents: count("agents", manifest.agents),
				mcpServers: servers.size,
				hooks: existsSync(join(root, "hooks", "hooks.json")) || manifest.hooks !== undefined,
			},
			skills,
			mcpServers: [...servers].map(([server, value]) => ({ name: server, ...value })),
			managed: entry.scope === "managed",
		};
	}

	/** The most specific settings file that names the plugin decides; only `true` loads it. */
	private enabled(id: string, files: AgentConfigFile[]): boolean {
		let value: unknown;
		for (const file of files) {
			const plugins = object(file.settings?.enabledPlugins);
			if (Object.hasOwn(plugins, id)) value = plugins[id];
		}
		return value === true;
	}

	setEnabled(id: string, enabled: boolean, target?: ExtensionTarget): { changed: boolean } {
		const plugin = this.list(target).plugins.find((p) => p.id === id);
		if (!plugin) throw new PierProtocolError("NOT_FOUND", "插件不存在，请刷新列表");
		const { files } = this.settings(target);
		const broken = files.find((file) => file.error);
		if (broken) throw new PierProtocolError("CONFLICT", `无法解析设置：${broken.path}，请先修复该文件`);
		// Write where it takes effect: the most specific file that already decides the plugin, else
		// the settings of the scope it was installed in (as `claude plugin enable` does).
		const deciding = files.findLast((file) => Object.hasOwn(object(file.settings?.enabledPlugins), id));
		const scope = deciding?.scope ?? plugin.scope;
		const { changed } = this.configs.update("claude-code", scope, target?.path, [
			{ path: ["enabledPlugins", id], value: enabled },
		]);
		return { changed };
	}

	/**
	 * Uninstall the installation `list` shows for `id` with `claude plugin uninstall`, the way the
	 * user would in a terminal: Claude Code removes it from its registry and settings and deletes
	 * the plugin's data directory unless `keepData`.
	 */
	uninstall(id: string, keepData: boolean, target?: ExtensionTarget): Promise<void> {
		const run = this.uninstalling.then(() => this.runUninstall(id, keepData, target));
		this.uninstalling = run.catch(() => undefined);
		return run;
	}

	private async runUninstall(id: string, keepData: boolean, target?: ExtensionTarget): Promise<void> {
		const plugin = this.list(target).plugins.find((p) => p.id === id);
		if (!plugin) throw new PierProtocolError("NOT_FOUND", "插件不存在，请刷新列表");
		if (plugin.managed) throw new PierProtocolError("CONFLICT", `${plugin.name} 由组织的托管设置安装，不能在这里卸载`);
		if (!COMMAND_LINE_ID.test(id))
			throw new PierProtocolError(
				"BAD_REQUEST",
				`插件 ID「${id}」含有不能传给 Claude Code 的字符，请在 Claude Code 中卸载`,
			);
		const executable = this.executable();
		if (!executable)
			throw new PierProtocolError(
				"CONFLICT",
				"未找到 Claude Code，无法卸载插件。请在「设置 → Agent 配置 → Claude Code」安装，或设置 PIER_CLAUDE_PATH。",
			);
		const args = ["plugin", "uninstall", id, "--scope", plugin.scope, "--json", ...(keepData ? ["--keep-data"] : [])];
		// Claude Code finds project and local installs through the working directory.
		const cwd = plugin.scope !== "user" && target ? target.path : homedir();
		const run = await runCli(executable, args, { cwd, env: this.cliEnv() });
		const outcome = cliOutcome(run.stdout);
		if (outcome?.outcome === "ok") return;
		const prefix = `Claude Code 未能卸载 ${plugin.name}`;
		if (outcome) {
			const code = outcome.failureCode?.startsWith("not_installed") ? "NOT_FOUND" : "CONFLICT";
			throw new PierProtocolError(code, `${prefix}：${outcome.message ?? outcome.failureCode ?? "未知原因"}`);
		}
		if (run.spawnError) throw new PierProtocolError("INTERNAL", `无法运行 Claude Code：${run.spawnError}`);
		if (run.timedOut)
			throw new PierProtocolError("TIMEOUT", `${prefix}：${UNINSTALL_TIMEOUT_MS / 1000} 秒内没有完成，请在终端中重试`);
		// Without a result line: a Claude Code that predates `--json` or `--keep-data` fails on the option.
		if (run.code === 0) return;
		const line = lastLine(run);
		if (/unknown option/i.test(line))
			throw new PierProtocolError(
				"CONFLICT",
				`${prefix}：这个版本的 Claude Code 不支持该操作，请先更新 Claude Code（${line}）`,
			);
		throw new PierProtocolError("INTERNAL", `${prefix}：${line || `退出码 ${run.code ?? "未知"}`}`);
	}

	/** The environment of the `claude` CLI: it must change the configuration Pier lists. */
	private cliEnv(): NodeJS.ProcessEnv {
		const dir = this.configs.configDir("claude-code");
		const own = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
		return samePath(dir, own) ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: dir };
	}
}
