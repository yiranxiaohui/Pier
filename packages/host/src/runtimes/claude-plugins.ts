import { existsSync, readdirSync, statSync } from "node:fs";
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
}

interface Installation {
	scope: string;
	installPath?: unknown;
	projectPath?: unknown;
	version?: unknown;
}

/** Claude Code's specificity order of installation scopes: a project's own install wins. */
const INSTALL_ORDER = ["local", "project", "user", "managed"];

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

/**
 * Installed Claude Code plugins. Claude Code installs them (`/plugin`, `claude plugin install`)
 * and records them in `plugins/installed_plugins.json`; `enabledPlugins` in its settings files
 * decides which ones load. Pier lists them and switches `enabledPlugins`, nothing else.
 */
export class ClaudePlugins {
	constructor(private readonly configs: AgentConfigFiles) {}

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
}
