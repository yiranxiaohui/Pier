import type { GitBranchInfo, GitWorktreeInfo, WorkspaceInfo } from "@pier/protocol";
import { useCallback, useEffect, useState } from "react";
import { baseName, gitErrorText, suggestWorktreePath, worktreeLocalBranch } from "../lib/git.ts";
import { useStore } from "../lib/store.tsx";
import {
	IconAlert,
	IconBroom,
	IconCheck,
	IconCopy,
	IconFolderOpen,
	IconFolderPlus,
	IconLayers,
	IconLoader,
	IconPlus,
	IconTrash,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";

/** Client-side timeout of `git.addWorktree`, which checks out a whole tree and runs hooks. */
const ADD_MS = 6 * 60_000;

function worktreeLabel(w: GitWorktreeInfo): string {
	if (w.bare) return "裸仓库";
	if (w.branch) return w.branch;
	return w.head ? `${w.head.slice(0, 7)}（游离）` : "（无提交）";
}

/**
 * Lists the work trees of the workspace's repository, adds new ones (optionally opening them as
 * workspaces) and removes linked ones.
 */
export function GitWorktreeDialog({
	workspace,
	current,
	remotes,
	onClose,
}: {
	workspace: WorkspaceInfo;
	/** The branch checked out in the workspace, the default start point of new branches. */
	current?: string | undefined;
	remotes?: string[] | undefined;
	onClose: () => void;
}) {
	const store = useStore();
	const workspaceId = workspace.id;
	const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>();
	const [branches, setBranches] = useState<GitBranchInfo[]>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const [confirmRemove, setConfirmRemove] = useState<string>();
	const [branch, setBranch] = useState("");
	const [path, setPath] = useState("");
	const [pathEdited, setPathEdited] = useState(false);
	const [open, setOpen] = useState(true);

	const load = useCallback(async () => {
		try {
			const [list, refs] = await Promise.all([
				store.git("git.worktrees", { workspaceId }),
				store.git("git.branches", { workspaceId }),
			]);
			setWorktrees(list.worktrees);
			setBranches(refs.branches);
		} catch (e) {
			setError(gitErrorText(e));
		}
	}, [store, workspaceId]);
	useEffect(() => {
		void load();
	}, [load]);

	const main = worktrees?.find((w) => w.main);
	const name = branch.trim();
	const existing = (branches ?? []).find((b) => b.name === name);
	const local = existing ? worktreeLocalBranch(existing.name, remotes, existing.remote) : name;
	/** Branches already checked out somewhere cannot be checked out in another work tree. */
	const checkedOut = new Set((worktrees ?? []).map((w) => w.branch).filter(Boolean));
	const busyBranch = !!name && checkedOut.has(local);
	const validName = !name || /^[^-\s][^\s]*$/.test(name);
	const suggested = main ? suggestWorktreePath(main.path, local || "detached") : "";
	const target = (pathEdited ? path : suggested).trim();
	const canAdd = !busy && !!worktrees && validName && !busyBranch && !!target;

	const choices = (branches ?? []).filter((b) => b.remote || !checkedOut.has(b.name));

	const act = async (label: string, fn: () => Promise<void>) => {
		if (busy) return;
		setBusy(label);
		setError(undefined);
		try {
			await fn();
		} catch (e) {
			setError(`${label}失败：${gitErrorText(e)}`);
		} finally {
			setBusy(undefined);
		}
	};

	const add = () =>
		act("创建工作树", async () => {
			const params = name
				? existing
					? { branch: existing.name }
					: { branch: name, create: true, ...(current ? { startPoint: current } : {}) }
				: {};
			const result = await store.git("git.addWorktree", { workspaceId, path: target, ...params }, ADD_MS);
			store.toast("info", `已创建工作树 ${baseName(result.path)}`);
			if (open) {
				const added = await store.addWorkspace(result.path, workspace.policy, store.nodeOf(workspaceId));
				if (added) {
					onClose();
					return;
				}
			}
			setBranch("");
			setPathEdited(false);
			await load();
		});

	const openWorktree = (w: GitWorktreeInfo) =>
		act("打开工作树", async () => {
			if (w.workspaceId) store.selectWorkspace(w.workspaceId);
			else if (!(await store.addWorkspace(w.path, workspace.policy, store.nodeOf(workspaceId)))) return;
			onClose();
		});

	const remove = (w: GitWorktreeInfo, force: boolean) =>
		act("删除工作树", async () => {
			await store.git("git.removeWorktree", { workspaceId, path: w.path, ...(force ? { force: true } : {}) });
			setConfirmRemove(undefined);
			// The workspace of a removed work tree points at a directory that is gone.
			if (w.workspaceId) await store.removeWorkspace(w.workspaceId);
			store.toast("info", `已删除工作树 ${baseName(w.path)}`);
			await load();
		});

	const prune = () =>
		act("清理工作树", async () => {
			await store.git("git.pruneWorktrees", { workspaceId });
			await load();
		});

	const copy = (text: string) =>
		void navigator.clipboard.writeText(text).then(
			() => store.toast("info", "已复制"),
			() => store.toast("error", "复制失败"),
		);

	const row = (w: GitWorktreeInfo) => {
		const badges = [
			w.main ? "主工作树" : "",
			w.current ? "当前" : "",
			w.workspaceId && !w.current ? "已是工作区" : "",
			w.locked ? `已锁定${w.lockReason ? `：${w.lockReason}` : ""}` : "",
			w.prunable ? "目录已不存在" : "",
		].filter(Boolean);
		const removable = !w.main && !w.current;
		return (
			<div key={w.path} className={`git-branch-row git-worktree-row${w.current ? " current" : ""}`}>
				<button
					type="button"
					className="git-branch-main"
					disabled={!!busy || w.current || w.bare || w.prunable}
					onClick={() => void openWorktree(w)}
					title={w.workspaceId ? `切换到工作区 ${w.path}` : `添加为工作区并打开 ${w.path}`}
				>
					<span className="git-branch-icon">{w.current ? <IconCheck size={13} /> : <IconLayers size={13} />}</span>
					<span className="git-branch-text">
						<span className="git-branch-name">
							{baseName(w.path)}
							<span className="git-branch-track">{worktreeLabel(w)}</span>
						</span>
						<span className="git-branch-sub">{w.path}</span>
						{badges.length ? (
							<span className="git-worktree-badges">
								{badges.map((b) => (
									<span key={b} className={`git-ref${b === "目录已不存在" ? " warn" : ""}`}>
										{b}
									</span>
								))}
							</span>
						) : null}
					</span>
				</button>
				{confirmRemove === w.path ? (
					<span className="git-branch-confirm">
						<button type="button" className="ghost small" disabled={!!busy} onClick={() => setConfirmRemove(undefined)}>
							取消
						</button>
						<button type="button" className="danger small" disabled={!!busy} onClick={() => void remove(w, false)}>
							删除
						</button>
						<button
							type="button"
							className="danger small"
							disabled={!!busy}
							title="即使有未提交的更改、未跟踪的文件或已锁定也删除"
							onClick={() => void remove(w, true)}
						>
							强制删除
						</button>
					</span>
				) : (
					<span className="git-worktree-actions">
						{!w.current && !w.bare && !w.prunable ? (
							<button
								type="button"
								className="ghost icon"
								title={w.workspaceId ? "切换到这个工作区" : "添加为工作区并打开"}
								disabled={!!busy}
								onClick={() => void openWorktree(w)}
							>
								<IconFolderOpen size={13} />
							</button>
						) : null}
						<button type="button" className="ghost icon" title="复制路径" onClick={() => copy(w.path)}>
							<IconCopy size={13} />
						</button>
						{removable ? (
							<button
								type="button"
								className="ghost icon"
								title={w.workspaceId ? "删除工作树（同时移除它的工作区）" : "删除工作树"}
								disabled={!!busy}
								onClick={() => setConfirmRemove(w.path)}
							>
								<IconTrash size={13} />
							</button>
						) : null}
					</span>
				)}
			</div>
		);
	};

	let hint: string;
	if (!validName) hint = "分支名称无效";
	else if (busyBranch) hint = `分支 ${local} 已在其他工作树中检出，不能再检出一次`;
	else if (!name) hint = "新工作树停在当前提交（HEAD 游离）";
	else if (existing?.remote)
		hint =
			local && (branches ?? []).some((b) => !b.remote && b.name === local)
				? `检出本地分支 ${local}`
				: `新建跟踪 ${existing.name} 的本地分支 ${local}`;
	else if (existing) hint = `检出已有分支 ${existing.name}`;
	else hint = `从${current ? ` ${current} ` : "当前提交"}新建分支 ${name}`;

	const removing = worktrees?.find((w) => w.path === confirmRemove);

	return (
		<Modal title="工作树" onClose={onClose} className="git-branch-dialog git-worktree-dialog">
			<form
				className="git-worktree-form"
				onSubmit={(e) => {
					e.preventDefault();
					if (canAdd) void add();
				}}
			>
				<label>
					<span>分支</span>
					<input
						// biome-ignore lint/a11y/noAutofocus: the dialog is opened to add a work tree.
						autoFocus
						list={`git-worktree-branches-${workspaceId}`}
						value={branch}
						placeholder="新分支名称，或选择已有分支；留空则停在当前提交"
						onChange={(e) => setBranch(e.target.value)}
					/>
					<datalist id={`git-worktree-branches-${workspaceId}`}>
						{choices.map((b) => (
							<option key={`${b.remote}:${b.name}`} value={b.name} />
						))}
					</datalist>
				</label>
				<label>
					<span>路径</span>
					<input
						value={pathEdited ? path : suggested}
						placeholder="新工作树的绝对路径"
						spellCheck={false}
						onChange={(e) => {
							setPath(e.target.value);
							setPathEdited(true);
						}}
					/>
				</label>
				<div className="git-worktree-submit">
					<label className="git-amend">
						<input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
						添加为工作区并打开
					</label>
					<span className={`muted small git-worktree-hint${!validName || busyBranch ? " error-text" : ""}`}>
						{hint}
					</span>
					<button type="submit" className="primary" disabled={!canAdd}>
						{busy === "创建工作树" ? <IconLoader size={14} className="spin" /> : <IconPlus size={14} />}
						创建工作树
					</button>
				</div>
			</form>
			{error ? (
				<p className="error-text small git-branch-error">
					<IconAlert size={13} /> {error}
				</p>
			) : null}
			{removing?.workspaceId ? (
				<p className="muted small git-branch-error">
					删除后会同时从 Pier 中移除它的工作区并关闭其中的会话。未提交的更改与未跟踪的文件会随目录一起删除。
				</p>
			) : null}
			<div className="git-branch-list">
				<div className="git-branch-heading git-worktree-heading">
					<span>已有工作树</span>
					{worktrees?.some((w) => w.prunable) ? (
						<button
							type="button"
							className="ghost small"
							disabled={!!busy}
							title="清理目录已不存在的工作树记录（git worktree prune）"
							onClick={() => void prune()}
						>
							<IconBroom size={12} />
							清理失效记录
						</button>
					) : null}
				</div>
				{!worktrees && !error ? (
					<div className="files-note">
						<IconLoader size={13} className="spin" />
						加载中…
					</div>
				) : null}
				{worktrees?.map(row)}
				{worktrees && worktrees.length <= 1 ? (
					<div className="files-note">
						<IconFolderPlus size={13} />
						还没有其他工作树。在上面填写分支后创建一个，即可在独立目录中并行开发。
					</div>
				) : null}
			</div>
		</Modal>
	);
}
