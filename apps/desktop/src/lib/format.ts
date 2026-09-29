import type { ApprovalPolicy, SessionRunState, SessionSummary } from "@pier/protocol";

export function sessionTitle(session: Pick<SessionSummary, "name" | "firstMessage">): string {
	const text = session.name || session.firstMessage.replace(/\s+/g, " ").trim();
	return text || "新会话";
}

export function relativeTime(iso: string | number): string {
	const time = typeof iso === "number" ? iso : Date.parse(iso);
	if (!Number.isFinite(time)) return "";
	const diff = Date.now() - time;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Date(time).toLocaleDateString();
}

export function clockTime(time: number): string {
	return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(n: number): string {
	if (!n) return "$0";
	return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Format a 0–1 ratio as a whole-number percentage (keeps one decimal below 10%). */
export function formatPercent(ratio: number): string {
	const pct = ratio * 100;
	if (pct > 0 && pct < 10) return `${pct.toFixed(1)}%`;
	return `${Math.round(pct)}%`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const RUN_STATE_LABEL: Record<SessionRunState, string> = {
	inactive: "未加载",
	idle: "空闲",
	streaming: "运行中",
	compacting: "压缩中",
	retrying: "重试中",
};

export const POLICY_LABEL: Record<ApprovalPolicy, string> = {
	ask: "逐项审批",
	smart: "智能",
	auto: "自动放行",
};

/** One-line summaries for the compact permission-mode menu. */
export const POLICY_SUMMARY: Record<ApprovalPolicy, string> = {
	ask: "bash、写文件、编辑每次都先询问",
	smart: "只读与工作区内修改直接放行，其余询问",
	auto: "所有工具调用直接执行，不再询问",
};

export const POLICY_DESCRIPTION: Record<ApprovalPolicy, string> = {
	ask: "bash、write、edit 每次都需要你批准。",
	smart: "只读命令与工作区内的文件修改直接放行；其他命令、工作区外写入与危险操作需要批准。",
	auto: "所有工具调用直接执行，不再询问。仅在你完全信任当前任务时使用。",
};

/** Shorten a home-relative path for display. */
export function shortPath(path: string, home?: string): string {
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	rs: "rust",
	py: "python",
	go: "go",
	md: "markdown",
	sh: "bash",
	bash: "bash",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	css: "css",
	html: "xml",
	xml: "xml",
	sql: "sql",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	rb: "ruby",
	php: "php",
};

export function languageForPath(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase();
	return ext ? EXTENSION_LANGUAGE[ext] : undefined;
}

/** `base/relative` (a workspace-relative path using `/`) with the separator style of `base`. */
export function joinPath(base: string, relative: string): string {
	if (!relative) return base;
	const windows = /^[a-zA-Z]:\\|^\\\\/.test(base) || (base.includes("\\") && !base.includes("/"));
	const sep = windows ? "\\" : "/";
	const rel = windows ? relative.replaceAll("/", "\\") : relative;
	return base.endsWith(sep) ? base + rel : base + sep + rel;
}
