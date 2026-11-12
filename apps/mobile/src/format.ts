import type { ApprovalPolicy, SessionRunState } from "@pier/protocol";

export { sessionTitle } from "@pier/chat-state";

export function relativeTime(iso: string | number | undefined): string {
	if (iso === undefined) return "";
	const time = typeof iso === "number" ? iso : Date.parse(iso);
	if (!Number.isFinite(time)) return "";
	const diff = Date.now() - time;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Date(time).toLocaleDateString();
}

export const RUN_STATE_LABEL: Record<SessionRunState, string> = {
	inactive: "未加载",
	idle: "空闲",
	streaming: "运行中",
	compacting: "压缩中",
	retrying: "重试中",
};

export function isBusy(state: SessionRunState): boolean {
	return state === "streaming" || state === "compacting" || state === "retrying";
}

export const POLICY_LABEL: Record<ApprovalPolicy, string> = {
	ask: "逐项审批",
	smart: "智能",
	auto: "自动放行",
};

/** One-line summaries for the compact approval-policy picker in a session. */
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

/** Token counts as `950`, `12.3k`, `128k` or `1.2M`. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(n: number): string {
	if (!n) return "$0";
	return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** A 0–1 ratio as a whole-number percentage (one decimal below 10%). */
export function formatPercent(ratio: number): string {
	const pct = ratio * 100;
	if (pct > 0 && pct < 10) return `${pct.toFixed(1)}%`;
	return `${Math.round(pct)}%`;
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

/** Last segment of a workspace-relative (`/`-joined) path; the workspace name for the root. */
export function baseName(path: string, root = ""): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.split("/").pop() || root;
}

/** Parent of a workspace-relative path (`""` is the workspace root). */
export function parentPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	return index < 0 ? "" : trimmed.slice(0, index);
}

/** Join a workspace-relative directory and a name with `/`. */
export function childPath(directory: string, name: string): string {
	return directory ? `${directory.replace(/\/+$/, "")}/${name}` : name;
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Shorten a home-directory prefix (`/home/me`, `/Users/me`, `C:\Users\me`) to `~`. */
export function shortPath(path: string): string {
	return path.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/, "~");
}

/** `root/relative` (a workspace-relative path using `/`) with the separator style of `root`. */
export function absolutePath(root: string, relative: string): string {
	if (!relative) return root;
	const windows = /^[a-zA-Z]:\\|^\\\\/.test(root) || (root.includes("\\") && !root.includes("/"));
	const sep = windows ? "\\" : "/";
	const rel = windows ? relative.replaceAll("/", "\\") : relative;
	return root.endsWith(sep) ? root + rel : root + sep + rel;
}
