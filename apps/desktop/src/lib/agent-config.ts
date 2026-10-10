/**
 * The Claude Code and Codex settings shown in Settings → Claude Code / Codex: Claude Code's
 * `settings.json` files and Codex's `config.toml` files (from their settings references).
 * Anything not described here stays editable as text, and the host keeps unknown keys (and
 * TOML comments) when a field is changed.
 */

import { parse as parseToml } from "@decimalturn/toml-patch";
import type { AgentConfigFormat, AgentConfigRuntime, AgentConfigScope } from "@pier/protocol";
import type { FieldDef, GroupDef, SettingsObject } from "./config-fields.ts";

const TOKENS = { unit: "tokens", min: 0 };

// ---- Claude Code -------------------------------------------------------------------------

/** Environment variables with their own fields; the rest are listed under 其他环境变量. */
const CLAUDE_ENV_FIELDS: FieldDef[] = [];

function env(name: string, def: Omit<FieldDef, "path">): FieldDef {
	const field: FieldDef = { path: ["env", name], ...def };
	CLAUDE_ENV_FIELDS.push(field);
	return field;
}

const CLAUDE_EFFORT = [
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max" },
];

const CLAUDE_API_FIELDS: FieldDef[] = [
	env("ANTHROPIC_BASE_URL", {
		label: "API 地址",
		description: "使用中转或兼容 Anthropic 的接口时填写，留空使用官方接口。",
		kind: { type: "string", placeholder: "https://api.anthropic.com", mono: true },
		defaultLabel: "官方接口",
	}),
	env("ANTHROPIC_AUTH_TOKEN", {
		label: "认证令牌",
		description: "以 Authorization: Bearer 发送，多数中转接口使用这一项。",
		kind: { type: "string", placeholder: "sk-…", secret: true },
		defaultLabel: "无",
	}),
	env("ANTHROPIC_API_KEY", {
		label: "API Key",
		description: "以 X-Api-Key 发送 Anthropic Console 的 API Key；设置后优先于账号登录。",
		kind: { type: "string", placeholder: "sk-ant-…", secret: true },
		defaultLabel: "无（使用登录的账号）",
	}),
	{
		path: ["apiKeyHelper"],
		label: "API Key 脚本",
		description: "输出 API Key 的脚本，Claude Code 定期运行它来获取（刷新）密钥。",
		kind: { type: "string", placeholder: "~/bin/get-claude-key.sh", mono: true },
		defaultLabel: "无",
	},
	{
		path: ["forceLoginMethod"],
		label: "登录方式",
		description: "限制 /login 只能使用 Claude 账号（Pro / Max）或 Anthropic Console。",
		kind: {
			type: "enum",
			options: [
				{ value: "claudeai", label: "Claude 账号" },
				{ value: "console", label: "Anthropic Console" },
			],
		},
		defaultLabel: "不限制",
	},
	env("API_TIMEOUT_MS", {
		label: "请求超时",
		description: "单个 API 请求的超时（毫秒），慢速中转可以调大。",
		kind: { type: "string", placeholder: "600000", mono: true },
		defaultLabel: "600000 毫秒",
	}),
	env("HTTPS_PROXY", {
		label: "HTTPS 代理",
		kind: { type: "string", placeholder: "http://127.0.0.1:7890", mono: true },
		defaultLabel: "系统环境变量",
	}),
	env("NO_PROXY", {
		label: "不走代理的地址",
		description: "逗号分隔的域名或地址。",
		kind: { type: "string", placeholder: "localhost,127.0.0.1", mono: true },
		defaultLabel: "系统环境变量",
	}),
];

const CLAUDE_MODEL_FIELDS: FieldDef[] = [
	{
		path: ["model"],
		label: "默认模型",
		description:
			"新会话使用的模型：别名（sonnet、opus、haiku、opusplan）或完整模型名。在 Pier 中为会话选择的模型优先。",
		kind: {
			type: "string",
			placeholder: "sonnet",
			mono: true,
			suggestions: ["default", "sonnet", "opus", "haiku", "opusplan", "sonnet[1m]"],
			select: true,
		},
		defaultLabel: "按账号决定",
	},
	{
		path: ["effortLevel"],
		label: "默认思考程度",
		description: "支持调节思考程度的模型默认使用的档位。",
		kind: { type: "enum", options: CLAUDE_EFFORT },
		defaultLabel: "按模型决定",
	},
	{
		path: ["alwaysThinkingEnabled"],
		label: "默认开启扩展思考",
		kind: { type: "boolean", default: false },
	},
	env("ANTHROPIC_DEFAULT_OPUS_MODEL", {
		label: "opus 对应的模型",
		description: "别名 opus（以及 opusplan 的规划阶段）实际使用的模型名，适合中转接口使用不同的模型 ID 时。",
		kind: { type: "string", placeholder: "claude-opus-4-1", mono: true },
		defaultLabel: "内置",
	}),
	env("ANTHROPIC_DEFAULT_SONNET_MODEL", {
		label: "sonnet 对应的模型",
		kind: { type: "string", placeholder: "claude-sonnet-4-5", mono: true },
		defaultLabel: "内置",
	}),
	env("ANTHROPIC_DEFAULT_HAIKU_MODEL", {
		label: "haiku 对应的模型",
		description: "也用于后台任务（生成标题等）。",
		kind: { type: "string", placeholder: "claude-haiku-4-5", mono: true },
		defaultLabel: "内置",
	}),
	env("CLAUDE_CODE_SUBAGENT_MODEL", {
		label: "子 Agent 模型",
		kind: { type: "string", placeholder: "sonnet", mono: true },
		defaultLabel: "同主模型",
	}),
	env("CLAUDE_CODE_MAX_OUTPUT_TOKENS", {
		label: "最大输出 tokens",
		kind: { type: "string", placeholder: "32000", mono: true },
		defaultLabel: "按模型决定",
	}),
	env("MAX_THINKING_TOKENS", {
		label: "思考预算",
		description: "扩展思考可以使用的 token 数。",
		kind: { type: "string", placeholder: "31999", mono: true },
		defaultLabel: "按模型决定",
	}),
	{
		path: ["language"],
		label: "回复语言",
		description: "Claude 默认使用的回复语言，例如 chinese、japanese。",
		kind: { type: "string", placeholder: "chinese", suggestions: ["chinese", "english", "japanese"] },
		defaultLabel: "跟随对话",
	},
	{
		path: ["outputStyle"],
		label: "输出风格",
		description: "内置的 Explanatory、Learning，或 ~/.claude/output-styles 中的自定义风格。",
		kind: { type: "string", placeholder: "default", suggestions: ["default", "Explanatory", "Learning"] },
		defaultLabel: "default",
	},
];

export const CLAUDE_GROUPS: GroupDef[] = [
	{
		id: "api",
		title: "接口与认证",
		description: "写入 settings.json 的 env，只对 Claude Code 生效；已在终端里 /login 的账号在未设置这些值时继续使用。",
		fields: CLAUDE_API_FIELDS,
	},
	{ id: "model", title: "模型与思考", fields: CLAUDE_MODEL_FIELDS },
	{
		id: "permissions",
		title: "权限",
		description:
			"规则写法如 Bash(npm run test:*)、Read(./.env)、Edit(src/**)、WebFetch(domain:example.com)、mcp__github。禁止优先于询问，询问优先于允许；其余操作按工作区的审批策略处理。",
		fields: [
			{
				path: ["permissions", "allow"],
				label: "允许",
				description: "无需询问即可执行的操作，每行一条规则。",
				kind: { type: "list", placeholder: "Bash(npm run test:*)\nRead(~/.zshrc)" },
				defaultLabel: "无",
			},
			{
				path: ["permissions", "ask"],
				label: "总是询问",
				description: "即使审批策略会放行，也先询问你。",
				kind: { type: "list", placeholder: "Bash(git push:*)" },
				defaultLabel: "无",
			},
			{
				path: ["permissions", "deny"],
				label: "禁止",
				description: "直接拒绝的操作，例如不允许读取密钥文件。",
				kind: { type: "list", placeholder: "Read(./.env)\nRead(./secrets/**)" },
				defaultLabel: "无",
			},
			{
				path: ["permissions", "additionalDirectories"],
				label: "额外的工作目录",
				description: "工作区之外 Claude 也可以访问的目录，每行一个。",
				kind: { type: "list", placeholder: "../shared-lib" },
				defaultLabel: "无",
			},
			{
				path: ["permissions", "defaultMode"],
				label: "默认权限模式",
				description: "只影响终端中的 Claude Code；Pier 中的会话按工作区的审批策略处理。",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "default", label: "逐项询问" },
						{ value: "acceptEdits", label: "自动接受编辑" },
						{ value: "plan", label: "计划模式" },
						{ value: "bypassPermissions", label: "跳过所有权限检查" },
					],
					default: "default",
				},
			},
		],
	},
	{
		id: "sandbox",
		title: "沙箱",
		description: "在 macOS 与 Linux 上把 Bash 命令放进系统沙箱，限制文件与网络访问。",
		fields: [
			{
				path: ["sandbox", "enabled"],
				label: "启用 Bash 沙箱",
				kind: { type: "boolean", default: false },
			},
			{
				path: ["sandbox", "autoAllowBashIfSandboxed"],
				label: "沙箱内的命令自动放行",
				description: "命令在沙箱中运行时不再询问。",
				kind: { type: "boolean", default: true },
			},
		],
	},
	{
		id: "mcp",
		title: "MCP 与 Hooks",
		description:
			"MCP 服务器本身在 ~/.claude.json 或项目的 .mcp.json 中配置（claude mcp add）；Hooks 与状态栏可以在 JSON 中编辑。",
		fields: [
			{
				path: ["enableAllProjectMcpServers"],
				label: "信任项目的全部 MCP 服务器",
				description: "自动启用项目 .mcp.json 中的所有服务器，不再逐个确认。",
				kind: { type: "boolean", default: false },
			},
			{
				path: ["enabledMcpjsonServers"],
				label: "启用的项目 MCP 服务器",
				description: ".mcp.json 中要启用的服务器名称，每行一个。",
				kind: { type: "list", placeholder: "github\nmemory" },
				defaultLabel: "无",
			},
			{
				path: ["disabledMcpjsonServers"],
				label: "停用的项目 MCP 服务器",
				kind: { type: "list", placeholder: "filesystem" },
				defaultLabel: "无",
			},
			{
				path: ["disableAllHooks"],
				label: "停用所有 Hooks",
				kind: { type: "boolean", default: false },
			},
		],
	},
	{
		id: "privacy",
		title: "隐私、更新与会话",
		fields: [
			env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", {
				label: "禁用非必要网络请求",
				description: "同时关闭自动更新、错误报告、遥测与 /bug 反馈。",
				kind: { type: "flag" },
			}),
			env("DISABLE_TELEMETRY", {
				label: "禁用遥测",
				kind: { type: "flag" },
			}),
			env("DISABLE_ERROR_REPORTING", {
				label: "禁用错误报告",
				kind: { type: "flag" },
			}),
			env("DISABLE_AUTOUPDATER", {
				label: "禁用自动更新",
				kind: { type: "flag" },
			}),
			{
				path: ["cleanupPeriodDays"],
				label: "会话记录保留天数",
				description: "超过这一天数未活动的本地会话记录在启动时删除（Pier 中的会话列表随之减少）。",
				kind: { type: "number", default: 30, min: 1, unit: "天" },
			},
			{
				path: ["respectGitignore"],
				label: "文件选择遵循 .gitignore",
				description: "@ 文件选择器中不列出被忽略的文件。",
				kind: { type: "boolean", default: true },
			},
		],
	},
];

/** The remaining `env` entries, after the variables with their own fields. */
export const CLAUDE_ENV_GROUP: GroupDef = {
	id: "env",
	title: "其他环境变量",
	description: "Claude Code 启动时设置的其他环境变量（settings.json 的 env）。",
	fields: [
		{
			path: ["env"],
			label: "环境变量",
			kind: {
				type: "map",
				exclude: CLAUDE_ENV_FIELDS.map((field) => field.path[1] as string),
				keyPlaceholder: "变量名，如 BASH_DEFAULT_TIMEOUT_MS",
				valuePlaceholder: "值",
			},
		},
	],
};

// ---- Codex -------------------------------------------------------------------------------

const CODEX_EFFORT = [
	{ value: "none", label: "none" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max" },
	{ value: "ultra", label: "ultra" },
];

export const CODEX_GROUPS: GroupDef[] = [
	{
		id: "model",
		title: "模型与思考",
		fields: [
			{
				path: ["model"],
				label: "默认模型",
				description: "新会话使用的模型。在 Pier 中为会话选择的模型优先。",
				kind: { type: "string", placeholder: "gpt-5-codex", mono: true, select: true },
				defaultLabel: "Codex 默认",
			},
			{
				path: ["model_provider"],
				label: "服务商",
				description: "使用的服务商 ID：内置的 openai、oss（本地 Ollama），或下方「服务商」中添加的。",
				kind: { type: "string", placeholder: "openai", mono: true },
				defaultLabel: "openai",
			},
			{
				path: ["profile"],
				label: "默认配置档",
				description: "启动时使用 [profiles.<名称>] 中的一组设置（在 TOML 中编辑配置档）。",
				kind: { type: "string", mono: true },
				defaultLabel: "无",
			},
			{
				path: ["model_reasoning_effort"],
				label: "默认思考程度",
				description: "推理模型的思考程度；可用档位取决于模型，max 与 ultra 需要模型支持。",
				kind: { type: "enum", options: CODEX_EFFORT, default: "medium" },
			},
			{
				path: ["model_reasoning_summary"],
				label: "思考摘要",
				kind: {
					type: "enum",
					options: [
						{ value: "auto", label: "自动" },
						{ value: "concise", label: "简洁" },
						{ value: "detailed", label: "详细" },
						{ value: "none", label: "不显示" },
					],
					default: "auto",
				},
			},
			{
				path: ["model_verbosity"],
				label: "回复详细程度",
				description: "Responses API 的 text.verbosity（GPT-5 系列）。",
				kind: {
					type: "enum",
					options: [
						{ value: "low", label: "简短" },
						{ value: "medium", label: "中等" },
						{ value: "high", label: "详细" },
					],
				},
				defaultLabel: "按模型决定",
			},
			{
				path: ["model_context_window"],
				label: "上下文窗口",
				description: "Codex 不认识的模型（自定义服务商）需要手动填写。",
				kind: { type: "number", ...TOKENS },
				defaultLabel: "按模型决定",
			},
			{
				path: ["model_auto_compact_token_limit"],
				label: "自动压缩阈值",
				description: "对话达到这一 token 数时自动压缩。",
				kind: { type: "number", ...TOKENS },
				defaultLabel: "按模型决定",
			},
		],
	},
	{
		id: "tools",
		title: "工具与环境",
		fields: [
			{
				path: ["web_search"],
				label: "网页搜索",
				kind: {
					type: "enum",
					options: [
						{ value: "cached", label: "使用缓存结果" },
						{ value: "live", label: "实时搜索" },
						{ value: "disabled", label: "关闭" },
					],
				},
				defaultLabel: "Codex 默认",
			},
			{
				path: ["shell_environment_policy", "inherit"],
				label: "命令继承的环境变量",
				description: "Codex 运行命令时从 Pier Host 继承哪些环境变量。",
				kind: {
					type: "enum",
					options: [
						{ value: "all", label: "全部" },
						{ value: "core", label: "仅核心变量（HOME、PATH 等）" },
						{ value: "none", label: "不继承" },
					],
					default: "all",
				},
			},
			{
				path: ["project_doc_max_bytes"],
				label: "AGENTS.md 读取上限",
				kind: { type: "number", default: 32768, min: 0, unit: "字节" },
			},
			{
				path: ["project_doc_fallback_filenames"],
				label: "AGENTS.md 的备选文件名",
				description: "目录中没有 AGENTS.md 时依次查找的文件，每行一个。",
				kind: { type: "list", placeholder: "CLAUDE.md\n.agents.md" },
				defaultLabel: "无",
			},
			{
				path: ["forced_login_method"],
				label: "登录方式",
				description: "限制只能用 ChatGPT 账号或 API Key 登录。",
				kind: {
					type: "enum",
					options: [
						{ value: "chatgpt", label: "ChatGPT 账号" },
						{ value: "api", label: "API Key" },
					],
				},
				defaultLabel: "不限制",
			},
			{
				path: ["notify"],
				label: "完成通知命令",
				description: "每轮结束时运行的程序及参数（每行一项），Codex 把事件 JSON 作为最后一个参数传入。",
				kind: { type: "list", placeholder: "notify-send\nCodex" },
				defaultLabel: "无",
			},
		],
	},
	{
		id: "sandbox",
		title: "审批与沙箱",
		description: "只影响终端中的 Codex：Pier 中的会话按工作区的审批策略设置审批与沙箱。",
		fields: [
			{
				path: ["approval_policy"],
				label: "审批策略",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "untrusted", label: "不受信任的命令先询问" },
						{ value: "on-request", label: "由模型决定何时询问" },
						{ value: "on-failure", label: "沙箱中失败时询问" },
						{ value: "never", label: "从不询问" },
					],
					default: "on-request",
				},
			},
			{
				path: ["sandbox_mode"],
				label: "沙箱模式",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "read-only", label: "只读" },
						{ value: "workspace-write", label: "可写工作区" },
						{ value: "danger-full-access", label: "不使用沙箱" },
					],
					default: "read-only",
				},
			},
			{
				path: ["sandbox_workspace_write", "network_access"],
				label: "可写工作区时允许联网",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["sandbox_workspace_write", "writable_roots"],
				label: "额外的可写目录",
				terminal: true,
				kind: { type: "list", placeholder: "/tmp/build" },
				defaultLabel: "无",
			},
		],
	},
	{
		id: "terminal",
		title: "终端中的 Codex",
		description: "以下设置只影响在终端中运行的 Codex。",
		collapsed: true,
		fields: [
			{
				path: ["file_opener"],
				label: "打开文件引用",
				description: "点击输出中的文件引用时使用的编辑器。",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "vscode", label: "VS Code" },
						{ value: "vscode-insiders", label: "VS Code Insiders" },
						{ value: "cursor", label: "Cursor" },
						{ value: "windsurf", label: "Windsurf" },
						{ value: "none", label: "不打开" },
					],
					default: "vscode",
				},
			},
			{
				path: ["hide_agent_reasoning"],
				label: "隐藏思考过程",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["show_raw_agent_reasoning"],
				label: "显示原始思考内容",
				description: "模型提供时显示未经摘要的思考内容。",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["tui", "notifications"],
				label: "桌面通知",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["history", "persistence"],
				label: "保存输入历史",
				description: "是否把输入历史写入 ~/.codex/history.jsonl。",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "save-all", label: "保存" },
						{ value: "none", label: "不保存" },
					],
					default: "save-all",
				},
			},
			{
				path: ["check_for_update_on_startup"],
				label: "启动时检查更新",
				terminal: true,
				kind: { type: "boolean", default: true },
			},
		],
	},
];

/** Fields of one entry of Codex's `model_providers`. */
export function codexProviderFields(id: string): FieldDef[] {
	const base = ["model_providers", id];
	return [
		{
			path: [...base, "name"],
			label: "显示名称",
			kind: { type: "string", placeholder: id },
			defaultLabel: id,
		},
		{
			path: [...base, "base_url"],
			label: "API 地址",
			description: "兼容 OpenAI 的接口地址，一般以 /v1 结尾。",
			kind: { type: "string", placeholder: "https://api.example.com/v1", mono: true },
			defaultLabel: "未设置",
		},
		{
			path: [...base, "wire_api"],
			label: "接口协议",
			kind: {
				type: "enum",
				options: [
					{ value: "responses", label: "Responses API" },
					{ value: "chat", label: "Chat Completions" },
				],
			},
			defaultLabel: "Codex 默认",
		},
		{
			path: [...base, "env_key"],
			label: "API Key 环境变量",
			description: "从这个环境变量读取 API Key；需要在 Pier Host 的环境中设置（例如登录 shell 的配置文件）。",
			kind: { type: "string", placeholder: "RELAY_API_KEY", mono: true },
			defaultLabel: "无",
		},
		{
			path: [...base, "experimental_bearer_token"],
			label: "API Key",
			description: "直接写在 config.toml 中的密钥（不推荐与他人共享这个文件）；优先使用环境变量。",
			kind: { type: "string", placeholder: "sk-…", secret: true },
			defaultLabel: "无",
		},
		{
			path: [...base, "requires_openai_auth"],
			label: "使用 Codex 登录的凭据",
			description: "用 codex login（ChatGPT 账号或 --with-api-key）保存的凭据访问这个服务商。",
			kind: { type: "boolean", default: false },
		},
	];
}

/** Built-in Codex providers (not listed under `model_providers`). */
export const CODEX_BUILTIN_PROVIDERS = ["openai", "oss"];

/** A new Codex provider id: letters, digits, `-` and `_`. */
export function validProviderId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

// ---- shared ------------------------------------------------------------------------------

export interface AgentConfigMeta {
	name: string;
	/** File name shown in hints. */
	fileName: string;
	groups: GroupDef[];
	/** Top-level keys the form (or its extra sections) edits. */
	handled: Set<string>;
}

function topKeys(groups: GroupDef[], extra: string[]): Set<string> {
	return new Set([...groups.flatMap((g) => g.fields.map((f) => f.path[0] as string)), ...extra]);
}

export const AGENT_CONFIG_META: Record<AgentConfigRuntime, AgentConfigMeta> = {
	"claude-code": {
		name: "Claude Code",
		fileName: "settings.json",
		groups: CLAUDE_GROUPS,
		handled: topKeys(CLAUDE_GROUPS, ["env", "$schema"]),
	},
	codex: {
		name: "Codex",
		fileName: "config.toml",
		groups: CODEX_GROUPS,
		handled: topKeys(CODEX_GROUPS, ["model_providers", "projects"]),
	},
};

/** How a scope is named in the file picker and in inherited values. */
export const SCOPE_LABEL: Record<AgentConfigScope, string> = {
	user: "全局",
	project: "项目",
	local: "本地",
};

/** Top-level keys of `settings` the form does not show (edited as text). */
export function agentUnhandledKeys(runtime: AgentConfigRuntime, settings: SettingsObject | undefined): string[] {
	const handled = AGENT_CONFIG_META[runtime].handled;
	return Object.keys(settings ?? {}).filter((key) => !handled.has(key));
}

/** Why the text editor's content cannot be saved, or undefined. */
export function validateConfigText(format: AgentConfigFormat, text: string): string | undefined {
	if (!text.trim()) return undefined;
	try {
		if (format === "toml") {
			parseToml(text);
			return undefined;
		}
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return "settings.json 需要是一个 JSON 对象（{ … }）";
		}
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Ids of the providers defined in a Codex config. */
export function codexProviderIds(settings: SettingsObject | undefined): string[] {
	const providers = settings?.model_providers;
	if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return [];
	return Object.keys(providers).filter((id) => {
		const entry = (providers as SettingsObject)[id];
		return typeof entry === "object" && entry !== null && !Array.isArray(entry);
	});
}

/** Ids of the profiles defined in a Codex config. */
export function codexProfileIds(settings: SettingsObject | undefined): string[] {
	const profiles = settings?.profiles;
	if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) return [];
	return Object.keys(profiles);
}
