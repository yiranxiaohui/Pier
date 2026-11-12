import type { ApprovalPolicy, SessionRunState } from "@pier/protocol";

export { sessionTitle } from "@pier/chat-state";

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

/** A size in bytes with a binary unit up to TB, e.g. `15.0 GB`. */
export function formatSize(n: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = Math.max(0, n);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** A transfer rate in bytes per second, e.g. `1.2 MB/s`. */
export function formatRate(bytesPerSecond: number): string {
	return `${formatSize(bytesPerSecond)}/s`;
}

/** How long a computer has been up, e.g. `3 天 4 小时`. */
export function formatUptime(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
	if (hours > 0) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
	return `${Math.max(1, minutes)} 分钟`;
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

/** Return a path relative to a workspace root when both paths identify the same tree. */
export function relativeWorkspacePath(root: string, path: string): string | undefined {
	const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	const normalizedPath = path.replaceAll("\\", "/");
	const windows = /^[a-zA-Z]:\//.test(normalizedRoot);
	const comparableRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
	const comparablePath = windows ? normalizedPath.toLowerCase() : normalizedPath;
	if (comparablePath === comparableRoot) return undefined;
	const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
	if (!comparablePath.startsWith(windows ? prefix.toLowerCase() : prefix)) return undefined;
	return normalizedPath.slice(prefix.length);
}

/** A short duration, e.g. `58s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
