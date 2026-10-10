import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import {
	type McpServerInfo,
	PierProtocolError,
	type ResourceList,
	type ResourceRuntime,
	type ResourceScope,
} from "@pier/protocol";
import type { ExtensionTarget } from "../pi/extensions.ts";
import type { AgentConfigFiles } from "./agent-config.ts";
import { type JsonObject, object, readJson, revision, strings, writeJson } from "./resource-files.ts";

interface Options {
	home?: string;
	agentDir: string;
	pierDir: string;
	configs: AgentConfigFiles;
}
interface Store {
	path: string;
	doc: JsonObject;
	servers: JsonObject;
	key: string[];
}

function piOverride(config: JsonObject): boolean {
	return config.command === undefined && config.url === undefined && config.type === undefined;
}

function validatePiOptions(config: JsonObject): void {
	const exposures = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];
	if (config.exposure !== undefined && (typeof config.exposure !== "string" || !exposures.includes(config.exposure)))
		throw new PierProtocolError("BAD_REQUEST", "无效的 pi MCP 工具展示方式");
	if (
		config.toolExposure !== undefined &&
		(!config.toolExposure ||
			typeof config.toolExposure !== "object" ||
			Array.isArray(config.toolExposure) ||
			Object.values(config.toolExposure).some((v) => typeof v !== "string" || !exposures.includes(v)))
	)
		throw new PierProtocolError("BAD_REQUEST", "toolExposure 必须将工具名称映射到展示方式");
	if (config.enabled !== undefined && typeof config.enabled !== "boolean")
		throw new PierProtocolError("BAD_REQUEST", "enabled 必须是布尔值");
}

function piNativeConfig(config: JsonObject): McpServerConfig {
	const exposure = (value: unknown) => (value === "codemode-deferred" ? "codemode" : value);
	return {
		...config,
		...(config.exposure === undefined ? {} : { exposure: exposure(config.exposure) }),
		...(config.toolExposure === undefined
			? {}
			: {
					toolExposure: Object.fromEntries(
						Object.entries(object(config.toolExposure)).map(([name, value]) => [name, exposure(value)]),
					),
				}),
	} as unknown as McpServerConfig;
}

export function validateMcpConfig(runtime: ResourceRuntime, config: JsonObject): void {
	if (runtime === "pi") validatePiOptions(config);
	const command = typeof config.command === "string" && config.command.trim();
	const url = typeof config.url === "string" && config.url.trim();
	if (Boolean(command) === Boolean(url))
		throw new PierProtocolError("BAD_REQUEST", "MCP 需要 command 或 url，两者只能设置一个");
	if (command && config.type !== undefined && config.type !== "stdio")
		throw new PierProtocolError("BAD_REQUEST", "命令服务器需要 stdio 类型");
	if (url) {
		try {
			if (!["http:", "https:"].includes(new URL(String(url)).protocol)) throw new Error();
		} catch {
			throw new PierProtocolError("BAD_REQUEST", "MCP URL 必须使用 http 或 https");
		}
		if (config.type !== undefined && !["http", "sse", "streamable-http"].includes(String(config.type)))
			throw new PierProtocolError("BAD_REQUEST", "不支持的 MCP 传输类型");
		if (runtime === "codex" && config.type === "sse")
			throw new PierProtocolError("BAD_REQUEST", "Codex 仅支持 stdio 和 Streamable HTTP");
		if (runtime === "pi" && config.type === "sse")
			throw new PierProtocolError("BAD_REQUEST", "pi 仅支持 stdio 和 Streamable HTTP");
	}
	if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((a) => typeof a !== "string")))
		throw new PierProtocolError("BAD_REQUEST", "args 必须是字符串数组");
	for (const key of ["env", "headers", "http_headers", "env_http_headers"]) {
		const value = config[key];
		if (
			value !== undefined &&
			(!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.values(value).some((v) => typeof v !== "string"))
		)
			throw new PierProtocolError("BAD_REQUEST", `${key} 必须是字符串键值表`);
	}
	if (
		config.env_vars !== undefined &&
		(!Array.isArray(config.env_vars) ||
			config.env_vars.some(
				(v) =>
					typeof v !== "string" &&
					!(typeof object(v).name === "string" && ["local", "remote"].includes(String(object(v).source))),
			))
	)
		throw new PierProtocolError("BAD_REQUEST", "env_vars 需要变量名称或 name/source 对象");
}

export class McpManager {
	private readonly home: string;
	constructor(private readonly options: Options) {
		this.home = options.home ?? homedir();
	}
	private scopes(runtime: ResourceRuntime, target?: ExtensionTarget): ResourceScope[] {
		return target ? (runtime === "claude-code" ? ["user", "project", "local"] : ["user", "project"]) : ["user"];
	}
	private archivePath(): string {
		return join(this.options.pierDir, "resources", "disabled-mcp.json");
	}
	private store(runtime: ResourceRuntime, scope: ResourceScope, target?: ExtensionTarget): Store {
		if (scope !== "user" && !target) throw new PierProtocolError("BAD_REQUEST", "请先选择工作区");
		if (scope === "local" && runtime !== "claude-code")
			throw new PierProtocolError("BAD_REQUEST", "仅 Claude Code MCP 支持本地范围");
		const workspacePath = target?.path ?? "";
		if (runtime === "codex") {
			const file = this.options.configs.read(runtime, scope, target?.path);
			if (!file.settings) throw new PierProtocolError("CONFLICT", `无法读取 TOML 配置：${file.path}`);
			const servers = file.settings.mcp_servers;
			if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers)))
				throw new PierProtocolError("CONFLICT", `MCP 配置结构无效：${file.path}`);
			return { path: file.path, doc: file.settings, servers: object(file.settings.mcp_servers), key: ["mcp_servers"] };
		}
		let path: string;
		let key: string[] = ["mcpServers"];
		if (runtime === "pi")
			path = scope === "user" ? join(this.options.agentDir, "mcp.json") : join(workspacePath, ".pi", "mcp.json");
		else if (scope === "project") path = join(workspacePath, ".mcp.json");
		else {
			const configDir = this.options.configs.configDir(runtime);
			path =
				resolve(configDir) === resolve(this.home, ".claude")
					? join(this.home, ".claude.json")
					: join(configDir, ".claude.json");
			if (scope === "local") key = ["projects", workspacePath, "mcpServers"];
		}
		const doc = readJson(path);
		let node = doc;
		for (const part of key) {
			const value = node[part];
			if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
				throw new PierProtocolError("CONFLICT", `MCP 配置结构无效：${path}`);
			node = object(value);
		}
		return { path, doc, servers: node, key };
	}
	private archiveKey(store: Store): string {
		return `${store.path}#${JSON.stringify(store.key)}`;
	}
	private archived(store: Store): JsonObject {
		return object(readJson(this.archivePath())[this.archiveKey(store)]);
	}
	private enabled(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		name: string,
		config: JsonObject,
		archived: boolean,
		target?: ExtensionTarget,
	): boolean {
		if (archived || (runtime !== "claude-code" && config.enabled === false)) return false;
		if (runtime !== "claude-code" || !target) return true;
		const state = this.store(runtime, "local", target);
		if (strings(object(object(state.doc.projects)[target.path]).disabledMcpServers).includes(name)) return false;
		if (scope === "project") {
			return !this.options.configs
				.scopes(runtime)
				.some((s) =>
					strings(this.options.configs.read(runtime, s, target.path).settings?.disabledMcpjsonServers).includes(name),
				);
		}
		return true;
	}
	list(runtime: ResourceRuntime, target?: ExtensionTarget): ResourceList<McpServerInfo> {
		const items: McpServerInfo[] = [];
		const errors: string[] = [];
		for (const scope of this.scopes(runtime, target)) {
			try {
				const store = this.store(runtime, scope, target);
				const archived = runtime === "claude-code" ? this.archived(store) : {};
				const servers = { ...archived, ...store.servers };
				for (const [name, value] of Object.entries(servers)) {
					const config = object(value);
					const enabled = this.enabled(runtime, scope, name, config, !Object.hasOwn(store.servers, name), target);
					items.push({
						runtime,
						scope,
						name,
						path: store.path,
						config,
						enabled,
						revision: revision(JSON.stringify({ config, enabled })),
					});
				}
			} catch (error) {
				errors.push(error instanceof PierProtocolError ? error.message : `无法读取 ${runtime} ${scope} MCP 配置`);
			}
		}
		return { items, errors };
	}

	/** Match pi's global/project merge, including project enablement-only overrides. */
	piConfig(cwd: string): LoadedMcpConfig {
		const { items, errors } = this.list("pi", { id: "", path: cwd });
		let autoEnableCodemode: boolean | undefined;
		for (const scope of ["user", "project"] as const) {
			try {
				const store = this.store("pi", scope, { id: "", path: cwd });
				const value = store.doc.autoEnableCodemode;
				if (typeof value === "boolean") autoEnableCodemode = value;
				else if (value !== undefined) errors.push(`autoEnableCodemode 必须是布尔值：${store.path}`);
			} catch {
				// list() already reports unreadable files.
			}
		}
		const merged = new Map<string, McpServerEntry>();
		for (const item of items) {
			try {
				if (!/^[A-Za-z0-9_-]+$/.test(item.name)) throw new Error();
				const previous = merged.get(item.name);
				if (item.scope === "project" && piOverride(item.config) && previous) {
					if (Object.keys(item.config).some((k) => !["enabled", "exposure", "toolExposure"].includes(k)))
						throw new Error();
					validateMcpConfig("pi", { ...previous.config, ...item.config });
					merged.set(item.name, {
						...previous,
						config: piNativeConfig({ ...previous.config, ...item.config }),
						override: item.path,
					});
				} else {
					validateMcpConfig("pi", item.config);
					if (item.scope === "project" && item.config.auth !== undefined) throw new Error();
					if (
						[...merged.keys()].some(
							(name) => name !== item.name && name.replace(/-/g, "_") === item.name.replace(/-/g, "_"),
						)
					)
						throw new Error();
					merged.set(item.name, {
						name: item.name,
						source: item.path,
						scope: item.scope === "user" ? "global" : "project",
						config: piNativeConfig(item.config),
					});
				}
			} catch {
				errors.push(`MCP ${item.name} 的配置无效：${item.path}`);
			}
		}
		return { servers: [...merged.values()], errors, autoEnableCodemode, projectConfig: join(cwd, ".pi", "mcp.json") };
	}

	connectionServer(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		name: string,
		target?: ExtensionTarget,
	): McpServerInfo {
		const server = this.require(runtime, scope, name, target);
		if (runtime === "pi" && scope === "project" && piOverride(server.config)) {
			const global = this.require(runtime, "user", name);
			return { ...server, config: { ...global.config, ...server.config } };
		}
		return server;
	}
	require(runtime: ResourceRuntime, scope: ResourceScope, name: string, target?: ExtensionTarget): McpServerInfo {
		const found = this.list(runtime, target).items.find((s) => s.scope === scope && s.name === name);
		if (!found) throw new PierProtocolError("NOT_FOUND", "MCP 服务器不存在，请刷新列表");
		return found;
	}
	private write(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		store: Store,
		name: string,
		config: JsonObject | undefined,
		target?: ExtensionTarget,
	): void {
		if (runtime === "codex") {
			this.options.configs.update(runtime, scope, target?.path, [
				{ path: ["mcp_servers", name], ...(config ? { value: config } : {}) },
			]);
			return;
		}
		let node = store.doc;
		for (const part of store.key) {
			node[part] = object(node[part]);
			node = node[part] as JsonObject;
		}
		if (config) node[name] = config;
		else delete node[name];
		writeJson(store.path, store.doc);
	}
	/** Read every related file before changing the server; global rejections need an explicit settings edit. */
	private claudeEnableChanges(scope: ResourceScope, name: string, target?: ExtensionTarget): () => void {
		if (!target) return () => {};
		const store = this.store("claude-code", "local", target);
		const project = object(object(store.doc.projects)[target.path]);
		const disabled = strings(project.disabledMcpServers);
		const files =
			scope === "project"
				? this.options.configs
						.scopes("claude-code")
						.map((s) => this.options.configs.read("claude-code", s, target.path))
				: [];
		for (const file of files) {
			if (file.error) throw new PierProtocolError("CONFLICT", `无法读取设置：${file.path}`);
			if (file.scope === "user" && strings(file.settings?.disabledMcpjsonServers).includes(name))
				throw new PierProtocolError("CONFLICT", "全局设置仍拒绝该 MCP，请在 Agent 配置中调整 disabledMcpjsonServers");
		}
		return () => {
			// Re-read: user/local servers share this document with disabledMcpServers.
			if (disabled.includes(name)) {
				const latest = this.store("claude-code", "local", target);
				object(object(latest.doc.projects)[target.path]).disabledMcpServers = disabled.filter((n) => n !== name);
				writeJson(latest.path, latest.doc);
			}
			if (scope === "project") {
				for (const file of files) {
					const s = file.scope;
					const rejected = strings(file.settings?.disabledMcpjsonServers);
					const allowed = strings(file.settings?.enabledMcpjsonServers);
					if (rejected.includes(name))
						this.options.configs.update("claude-code", s, target.path, [
							{ path: ["disabledMcpjsonServers"], value: rejected.filter((n) => n !== name) },
						]);
					if (s === "local" && !allowed.includes(name))
						this.options.configs.update("claude-code", s, target.path, [
							{ path: ["enabledMcpjsonServers"], value: [...allowed, name] },
						]);
				}
			}
		};
	}
	save(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		name: string,
		config: JsonObject,
		enabled: boolean,
		target?: ExtensionTarget,
		expectedRevision?: string,
		create = false,
	): McpServerInfo {
		if (runtime === "pi") validatePiOptions(config);
		if (runtime === "pi" && scope === "project" && piOverride(config)) {
			if (
				!this.list("pi").items.some((s) => s.name === name) ||
				Object.keys(config).some((k) => !["enabled", "exposure", "toolExposure"].includes(k))
			)
				throw new PierProtocolError("BAD_REQUEST", "项目 MCP 覆盖需要同名全局服务器，仅能覆盖启用状态和工具展示方式");
		} else validateMcpConfig(runtime, config);
		if (runtime === "pi" && !/^[A-Za-z0-9_-]+$/.test(name))
			throw new PierProtocolError("BAD_REQUEST", "pi MCP 名称仅支持字母、数字、下划线和连字符");
		if (runtime === "pi" && scope === "project" && config.auth !== undefined)
			throw new PierProtocolError("BAD_REQUEST", "项目 MCP 不能引用 pi 全局服务商凭据");
		const store = this.store(runtime, scope, target);
		const current = this.list(runtime, target).items.find((s) => s.scope === scope && s.name === name);
		if (current && (create || !expectedRevision || current.revision !== expectedRevision))
			throw new PierProtocolError("CONFLICT", "该 MCP 已存在或已被修改，请刷新后重试");
		if (!current && expectedRevision) throw new PierProtocolError("CONFLICT", "该 MCP 已被删除，请刷新后重试");
		const native = { ...config };
		if (runtime === "codex") {
			delete native.type;
			native.enabled = enabled;
		}
		if (runtime === "pi") {
			native.enabled = enabled;
			if (create && !piOverride(config) && native.exposure === undefined) native.exposure = "direct";
		}
		if (runtime === "claude-code") {
			delete native.enabled;
			const archive = readJson(this.archivePath());
			const key = this.archiveKey(store);
			const saved = object(archive[key]);
			const applyEnable = enabled ? this.claudeEnableChanges(scope, name, target) : undefined;
			if (!enabled) {
				saved[name] = native;
				archive[key] = saved;
				writeJson(this.archivePath(), archive);
				this.write(runtime, scope, store, name, undefined, target);
			} else {
				this.write(runtime, scope, store, name, native, target);
				delete saved[name];
				archive[key] = saved;
				writeJson(this.archivePath(), archive);
				applyEnable?.();
			}
		} else this.write(runtime, scope, store, name, native, target);
		return this.require(runtime, scope, name, target);
	}
	setEnabled(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		name: string,
		enabled: boolean,
		expectedRevision: string,
		target?: ExtensionTarget,
	): McpServerInfo {
		const current = this.require(runtime, scope, name, target);
		return this.save(runtime, scope, name, current.config, enabled, target, expectedRevision);
	}
	delete(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		name: string,
		expectedRevision: string,
		target?: ExtensionTarget,
	): { deleted: boolean } {
		const current = this.require(runtime, scope, name, target);
		if (current.revision !== expectedRevision) throw new PierProtocolError("CONFLICT", "该 MCP 已被修改，请刷新后重试");
		const archive = runtime === "claude-code" ? readJson(this.archivePath()) : undefined;
		this.write(runtime, scope, this.store(runtime, scope, target), name, undefined, target);
		if (runtime === "claude-code") {
			if (!archive) throw new PierProtocolError("INTERNAL", "MCP 存档不可用");
			const key = this.archiveKey(this.store(runtime, scope, target));
			const saved = object(archive[key]);
			delete saved[name];
			archive[key] = saved;
			writeJson(this.archivePath(), archive);
		}
		return { deleted: true };
	}
}
