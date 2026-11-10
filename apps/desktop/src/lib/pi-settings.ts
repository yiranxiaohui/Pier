/**
 * The pi settings shown in Settings → Agent 配置 → pi: which keys exist, how to edit them, and their
 * built-in defaults (from pi's settings reference). Anything not described here stays
 * editable in the JSON view, and the host keeps unknown keys when a field is changed.
 */

import type { GroupDef, SettingsObject } from "./config-fields.ts";

export {
	builtinDefault,
	type FieldDef,
	type FieldKind,
	formatValue,
	type GroupDef,
	getPath,
	isValidValue,
	type JsonScalar,
	parseListInput,
	parseNumberInput,
	type SettingsObject,
	sameValue,
} from "./config-fields.ts";

export const THINKING_LEVEL_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "off", label: "off" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max" },
];

export const BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;
export const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

const QUEUE_MODES = [
	{ value: "one-at-a-time", label: "逐条发送" },
	{ value: "all", label: "一次全部发送" },
];

const AUTO_ON_OFF = [
	{ value: "auto", label: "自动检测" },
	{ value: true, label: "开启" },
	{ value: false, label: "关闭" },
];

const TOKENS = { unit: "tokens", min: 0 };
const MS = { unit: "毫秒", min: 0 };

export const SETTINGS_GROUPS: GroupDef[] = [
	{
		id: "model",
		title: "模型与思考",
		description: "默认模型在「模型与服务商」中设置。",
		fields: [
			{
				path: ["defaultThinkingLevel"],
				label: "默认思考等级",
				description: "新会话使用的思考等级（模型支持时）。",
				kind: { type: "enum", options: THINKING_LEVEL_OPTIONS, default: "medium" },
			},
			{
				path: ["enabledModels"],
				label: "模型轮换列表",
				description:
					"启动时选择与切换模型时使用的模型，每行一个，支持 provider/model、通配符 *，格式同 --models。留空为全部可用模型。",
				kind: { type: "list", placeholder: "anthropic/claude-*\nopenai/gpt-5" },
				defaultLabel: "全部可用模型",
			},
			{
				path: ["thinkingBudgets", "minimal"],
				label: "思考预算：minimal",
				description: "按 token 数控制思考的模型在 minimal 等级下的预算。",
				kind: { type: "number", ...TOKENS },
				defaultLabel: "内置值",
			},
			{
				path: ["thinkingBudgets", "low"],
				label: "思考预算：low",
				kind: { type: "number", ...TOKENS },
				defaultLabel: "内置值",
			},
			{
				path: ["thinkingBudgets", "medium"],
				label: "思考预算：medium",
				kind: { type: "number", ...TOKENS },
				defaultLabel: "内置值",
			},
			{
				path: ["thinkingBudgets", "high"],
				label: "思考预算：high",
				kind: { type: "number", ...TOKENS },
				defaultLabel: "内置值",
			},
			{
				path: ["cacheWarming"],
				label: "提示缓存预热",
				description: "在运行中（或包括空闲时）保持服务商的提示缓存有效，只在预计能省钱时进行，预热请求计入用量。",
				globalOnly: true,
				kind: {
					type: "enum",
					options: [
						{ value: "off", label: "关闭" },
						{ value: "streaming", label: "运行时" },
						{ value: "idle", label: "运行时与空闲时" },
					],
					default: "idle",
				},
			},
		],
	},
	{
		id: "interaction",
		title: "交互",
		fields: [
			{
				path: ["steeringMode"],
				label: "插话发送方式",
				description: "Agent 运行中排队的插话（steer）消息如何交给模型。",
				kind: { type: "enum", options: QUEUE_MODES, default: "one-at-a-time" },
			},
			{
				path: ["followUpMode"],
				label: "追加消息发送方式",
				description: "排队的追加（follow-up）消息如何交给模型。",
				kind: { type: "enum", options: QUEUE_MODES, default: "one-at-a-time" },
			},
		],
	},
	{
		id: "tools",
		title: "工具与 Shell",
		fields: [
			{
				path: ["defaultTools"],
				label: "默认内置工具",
				description: "新会话启用的内置工具。全部取消会停用所有内置工具（扩展提供的工具不受影响）。",
				kind: { type: "tools", options: BUILTIN_TOOLS, default: DEFAULT_TOOLS },
			},
			{
				path: ["shellPath"],
				label: "Shell 路径",
				description: "bash 工具使用的 Shell 可执行文件，支持 ~。",
				kind: { type: "string", placeholder: "/bin/bash", mono: true },
				defaultLabel: "系统默认",
			},
			{
				path: ["shellCommandPrefix"],
				label: "命令前缀",
				description: "加在每条 Shell 命令之前，例如 source ~/.profile &&。",
				kind: { type: "string", placeholder: "source ~/.profile &&", mono: true },
				defaultLabel: "无",
			},
			{
				path: ["npmCommand"],
				label: "npm 命令",
				description:
					"查找与安装 npm 扩展包时使用的命令及参数，每行一项。支持 npm、pnpm 和 bun，可从下方检测到的包管理器中选择，或填写完整路径。",
				kind: { type: "list", placeholder: "/usr/local/bin/npm" },
				defaultLabel: "npm",
				suggest: "packageManagers",
			},
		],
	},
	{
		id: "sessions",
		title: "会话与压缩",
		fields: [
			{
				path: ["sessionDir"],
				label: "会话目录",
				description: "会话文件的保存位置，相对路径从工作目录解析。环境变量 PI_CODING_AGENT_SESSION_DIR 优先。",
				kind: { type: "string", placeholder: "~/.pi/agent/sessions", mono: true },
				defaultLabel: "pi 默认目录",
			},
			{
				path: ["compaction", "enabled"],
				label: "自动压缩",
				description: "上下文接近上限时自动总结较早的对话。",
				kind: { type: "boolean", default: true },
			},
			{
				path: ["compaction", "reserveTokens"],
				label: "为回复预留",
				description: "压缩时为模型回复保留的 token 数。",
				kind: { type: "number", default: 16384, ...TOKENS },
			},
			{
				path: ["compaction", "keepRecentTokens"],
				label: "保留最近内容",
				description: "压缩时不做总结、原样保留的最近 token 数。",
				kind: { type: "number", default: 20000, ...TOKENS },
			},
			{
				path: ["branchSummary", "reserveTokens"],
				label: "分支总结预留",
				description: "总结分支历史时预留的 token 数。",
				kind: { type: "number", default: 16384, ...TOKENS },
			},
		],
	},
	{
		id: "network",
		title: "网络与重试",
		fields: [
			{
				path: ["transport"],
				label: "传输方式",
				description: "服务商同时支持多种传输方式时优先使用的一种。",
				kind: {
					type: "enum",
					options: [
						{ value: "auto", label: "自动" },
						{ value: "sse", label: "SSE" },
						{ value: "websocket", label: "WebSocket" },
						{ value: "websocket-cached", label: "WebSocket（复用连接）" },
					],
					default: "auto",
				},
			},
			{
				path: ["httpIdleTimeoutMs"],
				label: "HTTP 空闲超时",
				description: "等待响应头或响应体的最长空闲时间，0 为不限制。",
				kind: { type: "number", default: 300000, ...MS },
			},
			{
				path: ["websocketConnectTimeoutMs"],
				label: "WebSocket 连接超时",
				description: "0 为不限制。",
				kind: { type: "number", default: 15000, ...MS },
			},
			{
				path: ["httpProxy"],
				label: "HTTP 代理",
				description: "终端中的 pi 启动时设为 HTTP_PROXY / HTTPS_PROXY；Pier Host 不读取这一项，请改用系统环境变量。",
				globalOnly: true,
				terminal: true,
				kind: { type: "string", placeholder: "http://127.0.0.1:7890", mono: true },
				defaultLabel: "无",
			},
			{
				path: ["retry", "enabled"],
				label: "自动重试",
				description: "遇到临时错误（限流、过载、服务端错误）时自动重试。",
				kind: { type: "boolean", default: true },
			},
			{
				path: ["retry", "maxRetries"],
				label: "最多重试次数",
				kind: { type: "number", default: 3, min: 0 },
			},
			{
				path: ["retry", "baseDelayMs"],
				label: "首次重试延迟",
				description: "之后按指数退避增加。",
				kind: { type: "number", default: 2000, ...MS },
			},
			{
				path: ["retry", "maxAgentDelayMs"],
				label: "最长重试延迟",
				kind: { type: "number", default: 60000, ...MS },
			},
			{
				path: ["retry", "provider", "timeoutMs"],
				label: "服务商请求超时",
				kind: { type: "number", ...MS },
				defaultLabel: "同 HTTP 空闲超时",
			},
			{
				path: ["retry", "provider", "maxRetries"],
				label: "服务商层重试次数",
				description: "一般保持 0：服务商层重试会推迟 pi 对额度与用量错误的处理。",
				kind: { type: "number", default: 0, min: 0 },
			},
			{
				path: ["retry", "provider", "maxRetryDelayMs"],
				label: "服务端要求的最长等待",
				description: "服务端要求更长的等待时直接失败，0 为不限制。",
				kind: { type: "number", default: 60000, ...MS },
			},
		],
	},
	{
		id: "images",
		title: "图片",
		fields: [
			{
				path: ["images", "autoResize"],
				label: "自动缩放图片",
				description: "发送给模型前把图片缩小到 2000×2000 以内。",
				kind: { type: "boolean", default: true },
			},
			{
				path: ["images", "blockImages"],
				label: "禁止发送图片",
				description: "不把任何图片发送给模型。",
				kind: { type: "boolean", default: false },
			},
		],
	},
	{
		id: "privacy",
		title: "更新与统计",
		fields: [
			{
				path: ["enableInstallTelemetry"],
				label: "匿名安装统计",
				description: "匿名报告安装 / 更新，并在部分服务商请求中附带来源标识。不影响更新检查。",
				kind: { type: "boolean", default: true },
			},
			{
				path: ["enableAnalytics"],
				label: "分享使用数据",
				description: "目前只用于终端 pi 的实验性首次设置。",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
		],
	},
	{
		id: "terminal",
		title: "终端中的 pi",
		description: "以下设置只影响在终端中运行的 pi（与 Pier 共用这份配置），修改后不会重新加载 Pier 的会话。",
		collapsed: true,
		fields: [
			{
				path: ["defaultProjectTrust"],
				label: "项目信任",
				description: "首次在目录中运行 pi 时如何对待项目配置。Pier 中添加的工作区总是视为已信任。",
				globalOnly: true,
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "ask", label: "询问" },
						{ value: "always", label: "总是信任" },
						{ value: "never", label: "从不信任" },
					],
					default: "ask",
				},
			},
			{
				path: ["theme"],
				label: "主题",
				description: "内置或自定义主题名称。",
				terminal: true,
				kind: { type: "string", placeholder: "dark", mono: true },
				defaultLabel: "自动检测",
			},
			{
				path: ["quietStartup"],
				label: "安静启动",
				description: "不显示启动信息。",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["hideThinkingBlock"],
				label: "隐藏思考过程",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["showCacheMissNotices"],
				label: "显示缓存提示",
				description: "显示明显的缓存未命中、缓存预热、压缩用量与服务商恢复的提示。",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["enableSkillCommands"],
				label: "技能斜杠命令",
				description: "把技能注册为 /skill:名称 命令。",
				terminal: true,
				kind: { type: "boolean", default: true },
			},
			{
				path: ["externalEditor"],
				label: "外部编辑器",
				description: "外部编辑器快捷键打开的命令。",
				terminal: true,
				kind: { type: "string", placeholder: "code --wait", mono: true },
				defaultLabel: "$VISUAL / $EDITOR",
			},
			{
				path: ["doubleEscapeAction"],
				label: "双击 Esc",
				description: "输入框为空时双击 Esc 的动作。",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "tree", label: "会话树 /tree" },
						{ value: "fork", label: "分叉 /fork" },
						{ value: "none", label: "无" },
					],
					default: "tree",
				},
			},
			{
				path: ["treeFilterMode"],
				label: "/tree 默认筛选",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "default", label: "默认" },
						{ value: "no-tools", label: "隐藏工具" },
						{ value: "user-only", label: "仅用户消息" },
						{ value: "labeled-only", label: "仅带标签" },
						{ value: "all", label: "全部" },
					],
					default: "default",
				},
			},
			{
				path: ["branchSummary", "skipPrompt"],
				label: "跳过分支总结询问",
				description: "切换分支时不询问，默认不生成总结。",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["tuiMode"],
				label: "界面模式",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "regular", label: "常规" },
						{ value: "fullscreen", label: "全屏" },
					],
					default: "regular",
				},
			},
			{
				path: ["fullscreenExitOutput"],
				label: "退出全屏时输出",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "transcript", label: "对话记录" },
						{ value: "resume-hint", label: "恢复提示" },
					],
					default: "transcript",
				},
			},
			{
				path: ["fullscreenScrollbar"],
				label: "全屏滚动条",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "auto", label: "自动" },
						{ value: "always", label: "总是显示" },
						{ value: "hidden", label: "隐藏" },
					],
					default: "auto",
				},
			},
			{
				path: ["fullscreenCopyOnSelect"],
				label: "全屏选中即复制",
				terminal: true,
				kind: { type: "boolean", default: true },
			},
			{
				path: ["editorPaddingX"],
				label: "输入框水平边距",
				terminal: true,
				kind: { type: "number", default: 0, min: 0, max: 3, unit: "格" },
			},
			{
				path: ["outputPad"],
				label: "对话水平边距",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: 0, label: "0" },
						{ value: 1, label: "1" },
					],
					default: 1,
				},
			},
			{
				path: ["autocompleteMaxVisible"],
				label: "自动补全可见条数",
				terminal: true,
				kind: { type: "number", default: 5, min: 3, max: 20 },
			},
			{
				path: ["showHardwareCursor"],
				label: "显示终端光标",
				description: "方便输入法定位。",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["terminal", "showImages"],
				label: "显示内联图片",
				terminal: true,
				kind: { type: "boolean", default: true },
			},
			{
				path: ["terminal", "imageWidthCells"],
				label: "内联图片宽度",
				terminal: true,
				kind: { type: "number", default: 60, min: 1, unit: "格" },
			},
			{
				path: ["terminal", "images"],
				label: "内联图片协议",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "auto", label: "自动检测" },
						{ value: "kitty", label: "Kitty" },
						{ value: "iterm2", label: "iTerm2" },
						{ value: false, label: "关闭" },
					],
					default: "auto",
				},
			},
			{
				path: ["terminal", "hyperlinks"],
				label: "超链接（OSC 8）",
				terminal: true,
				kind: { type: "enum", options: AUTO_ON_OFF, default: "auto" },
			},
			{
				path: ["terminal", "trueColor"],
				label: "真彩色",
				terminal: true,
				kind: { type: "enum", options: AUTO_ON_OFF, default: "auto" },
			},
			{
				path: ["terminal", "clearOnShrink"],
				label: "内容变短时清除空行",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["terminal", "showTerminalProgress"],
				label: "标签页进度（OSC 9;4）",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["markdown", "mermaid"],
				label: "Mermaid 渲染",
				terminal: true,
				kind: {
					type: "enum",
					options: [
						{ value: "off", label: "关闭" },
						{ value: "final", label: "完成后" },
						{ value: "streaming", label: "流式" },
					],
					default: "streaming",
				},
			},
			{
				path: ["markdown", "codeBlockIndent"],
				label: "代码块缩进",
				terminal: true,
				kind: { type: "string", placeholder: "两个空格", mono: true },
				defaultLabel: "两个空格",
			},
			{
				path: ["collapseChangelog"],
				label: "精简更新日志",
				terminal: true,
				kind: { type: "boolean", default: false },
			},
			{
				path: ["warnings", "anthropicExtraUsage"],
				label: "Anthropic 额外用量提醒",
				description: "使用 Anthropic 订阅登录可能产生付费额外用量时提醒。",
				terminal: true,
				kind: { type: "boolean", default: true },
			},
		],
	},
];

/** Top-level keys the form edits, or that other pages manage (resources, default model). */
const HANDLED_KEYS = new Set([
	...SETTINGS_GROUPS.flatMap((group) => group.fields.map((field) => field.path[0] as string)),
	"defaultProvider",
	"defaultModel",
	"packages",
	"extensions",
	"skills",
	"prompts",
	"themes",
	// Written by pi itself.
	"lastChangelogVersion",
	"trackingId",
]);

/** Keys of `settings` the form does not show (edited in the JSON view). */
export function unhandledKeys(settings: SettingsObject | undefined): string[] {
	return Object.keys(settings ?? {}).filter((key) => !HANDLED_KEYS.has(key));
}

/** Validate the JSON editor's text: a JSON object, or an error message. */
export function parseSettingsText(text: string): { settings?: SettingsObject; error?: string } {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { error: "settings.json 需要是一个 JSON 对象（{ … }）" };
		}
		return { settings: parsed as SettingsObject };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The detected package manager an `npmCommand` value runs: the default npm when it is unset, the
 * one at that path, or the first of that name on the host's PATH for a bare name. Undefined for a
 * wrapper command (`mise exec -- pnpm`) or a path that was not detected.
 */
export function currentPackageManager<T extends { name: string; path: string; default?: true }>(
	command: readonly string[] | undefined,
	managers: readonly T[],
): T | undefined {
	if (!command || command.length === 0) return managers.find((m) => m.name === "npm" && m.default);
	if (command.length !== 1) return undefined;
	const [value = ""] = command;
	if (/[\\/]/.test(value)) return managers.find((m) => m.path === value);
	const name = value.replace(/\.(cmd|exe)$/i, "");
	return managers.find((m) => m.name === name && m.default);
}
