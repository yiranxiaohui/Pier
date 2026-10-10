import type { McpServerInfo, ResourceRuntime, ResourceScope } from "@pier/protocol";

export const RESOURCE_RUNTIME_LABEL: Record<ResourceRuntime, string> = {
	pi: "pi",
	"claude-code": "Claude Code",
	codex: "Codex",
};
export const RESOURCE_SCOPE_LABEL: Record<ResourceScope, string> = {
	user: "全局",
	project: "项目",
	local: "本地（当前项目）",
};
export const NEW_SKILL_TEXT = "---\nname: my-skill\ndescription: 描述这个技能的用途\n---\n\n在这里编写技能指令。\n";

export interface McpDraft {
	name: string;
	transport: "stdio" | "http" | "sse" | "inherit";
	command: string;
	url: string;
	args: string;
	env: string;
	headers: string;
	advanced: string;
}

export function mcpDraft(server?: McpServerInfo): McpDraft {
	const config = server?.config ?? {};
	const advanced = { ...config };
	for (const key of ["type", "command", "url", "args", "env", "headers", "http_headers", "enabled"])
		delete advanced[key];
	return {
		name: server?.name ?? "",
		transport:
			server?.runtime === "pi" && server.scope === "project" && !config.command && !config.url
				? "inherit"
				: config.command
					? "stdio"
					: config.type === "sse"
						? "sse"
						: "http",
		command: typeof config.command === "string" ? config.command : "",
		url: typeof config.url === "string" ? config.url : "",
		args: Array.isArray(config.args) ? config.args.join("\n") : "",
		env: JSON.stringify(config.env ?? {}, null, 2),
		headers: JSON.stringify(config.headers ?? config.http_headers ?? {}, null, 2),
		advanced: JSON.stringify(advanced, null, 2),
	};
}

function jsonObject(text: string, label: string, stringsOnly = false): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text.trim() || "{}");
	} catch {
		throw new Error(`${label}需要有效的 JSON`);
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(stringsOnly && Object.values(value).some((v) => typeof v !== "string"))
	)
		throw new Error(`${label}需要${stringsOnly ? "字符串键值表" : "JSON 对象"}`);
	return value as Record<string, unknown>;
}

/** Build native config while retaining advanced options the simple form does not expose. */
export function mcpConfig(draft: McpDraft, runtime: ResourceRuntime): Record<string, unknown> {
	const config = jsonObject(draft.advanced, "高级配置");
	for (const key of ["type", "command", "url", "args", "env", "headers", "http_headers", "enabled"]) delete config[key];
	if (draft.transport === "inherit") {
		if (runtime !== "pi") throw new Error("只有 pi 项目 MCP 支持继承全局配置");
		return config;
	}
	if (draft.transport === "stdio") {
		if (!draft.command.trim()) throw new Error("请输入启动命令");
		config.command = draft.command.trim();
		config.args = draft.args ? draft.args.split("\n").map((s) => s.replace(/\r$/, "")) : [];
		const env = jsonObject(draft.env, "环境变量", true);
		if (Object.keys(env).length) config.env = env;
		if (runtime !== "codex") config.type = "stdio";
	} else {
		if (draft.transport === "sse" && runtime !== "claude-code")
			throw new Error("这个 Agent 仅支持 stdio 和 Streamable HTTP");
		if (!draft.url.trim()) throw new Error("请输入服务器 URL");
		config.url = draft.url.trim();
		const headers = jsonObject(draft.headers, "请求头", true);
		if (Object.keys(headers).length) config[runtime === "codex" ? "http_headers" : "headers"] = headers;
		if (runtime !== "codex") config.type = draft.transport;
	}
	return config;
}
