import type { GitFileStatus } from "@pier/protocol";

export type GitGroup = "conflict" | "staged" | "changes";

/** One row of the source control list: a path in one group, with the letter shown for it. */
export interface GitChange {
	file: GitFileStatus;
	group: GitGroup;
	/** `M`, `A`, `D`, `R`, `C`, `T`, `U` (untracked or unmerged) or `!` for a conflict. */
	letter: string;
}

export interface GitGroups {
	conflict: GitChange[];
	staged: GitChange[];
	changes: GitChange[];
}

/**
 * Sort a status into the groups source control shows: conflicts, staged changes (index side)
 * and unstaged changes (work tree side, including untracked files). A path changed on both
 * sides appears in both groups.
 */
export function groupChanges(files: GitFileStatus[] | undefined): GitGroups {
	const groups: GitGroups = { conflict: [], staged: [], changes: [] };
	for (const file of files ?? []) {
		if (file.conflict) {
			groups.conflict.push({ file, group: "conflict", letter: "!" });
			continue;
		}
		if (file.index === "?") {
			groups.changes.push({ file, group: "changes", letter: "U" });
			continue;
		}
		if (file.index !== ".") groups.staged.push({ file, group: "staged", letter: file.index });
		if (file.worktree !== ".") groups.changes.push({ file, group: "changes", letter: file.worktree });
	}
	return groups;
}

/** Paths to pass to `git.stage` / `git.unstage` for changes: a rename's old path too. */
export function changePaths(changes: GitChange[]): string[] {
	const paths = new Set<string>();
	for (const change of changes) {
		paths.add(change.file.path);
		if (change.group === "staged" && change.file.origPath) paths.add(change.file.origPath);
	}
	return [...paths];
}

const LABELS: Record<string, string> = {
	M: "已修改",
	A: "新增",
	D: "已删除",
	R: "已重命名",
	C: "已复制",
	T: "类型已更改",
	U: "未跟踪",
	"!": "冲突",
};

export function changeLabel(change: GitChange): string {
	if (change.group === "changes" && change.letter === "U") return "未跟踪";
	return LABELS[change.letter] ?? change.letter;
}

/**
 * The workspace-relative path of a repository path, or undefined when it lies outside the
 * workspace (the workspace is a subdirectory `prefix` of the repository).
 */
export function workspacePath(repoPath: string, prefix: string | undefined): string | undefined {
	if (!prefix) return repoPath;
	return repoPath.startsWith(`${prefix}/`) ? repoPath.slice(prefix.length + 1) : undefined;
}

export function splitPath(path: string): { name: string; dir: string } {
	const i = path.lastIndexOf("/");
	return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** A message for a failed Git request. */
export function gitErrorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message))
		return "那台电脑的 Pier 版本过旧，不支持 Git，请先更新它";
	if (code === "UNSUPPORTED") return "那台电脑上没有安装 Git";
	if (code === "TIMEOUT") return "Git 操作超时";
	if (/not in a Git repository/.test(message)) return "工作区不在 Git 仓库中";
	if (/has no remote to push to/.test(message)) return "仓库没有配置远程仓库";
	if (/HEAD is detached/.test(message)) return "当前不在任何分支上（HEAD 游离），请先切换到分支";
	if (/Commit message is empty/.test(message)) return "请填写提交信息";
	if (/Invalid branch name/.test(message)) return "分支名称无效";
	if (/No such branch/.test(message)) return "分支不存在";
	if (/Work tree path must be absolute/.test(message)) return "工作树路径必须是绝对路径";
	if (/main work tree cannot be removed/.test(message)) return "不能删除主工作树";
	if (/workspace is in this work tree/.test(message)) return "当前工作区就在这个工作树中，请在其他工作区中删除它";
	if (/Not a work tree of this repository/.test(message)) return "这个目录不是该仓库的工作树";
	return message;
}

/** The last segment of a path that may use `/` or `\\`. */
export function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** The directory part of a path that may use `/` or `\\` (the path itself at the root). */
export function dirName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (i < 0) return trimmed;
	return i === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, i);
}

/**
 * The local branch a work tree for `branch` checks out: a remote-tracking branch
 * (`origin/x`) is checked out as `x`.
 */
export function worktreeLocalBranch(branch: string, remotes: string[] | undefined, remote: boolean): string {
	if (!remote) return branch;
	const name = (remotes ?? []).filter((r) => branch.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
	return name ? branch.slice(name.length + 1) : branch.slice(branch.indexOf("/") + 1);
}

/**
 * Where a new work tree for `branch` goes by default: `<repo>-worktrees/<branch>` next to the
 * main work tree, with `/` in the branch name turned into `-`.
 */
export function suggestWorktreePath(mainPath: string, branch: string): string {
	const sep = mainPath.includes("\\") && !mainPath.includes("/") ? "\\" : "/";
	const slug =
		branch
			.trim()
			.replace(/[\\/:*?"<>|\s]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "") || "worktree";
	const parent = dirName(mainPath);
	const join = (a: string, b: string) => (a.endsWith(sep) ? `${a}${b}` : `${a}${sep}${b}`);
	return join(join(parent, `${baseName(mainPath)}-worktrees`), slug);
}
