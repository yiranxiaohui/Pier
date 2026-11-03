import type { GitBranchInfo, GitCommitInfo, GitDiffResult, GitStatus, WorkspaceInfo } from "@pier/protocol";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "../lib/format.ts";
import {
	changeLabel,
	changePaths,
	type GitChange,
	type GitGroup,
	gitErrorText,
	groupChanges,
	splitPath,
	workspacePath,
} from "../lib/git.ts";
import { diffStats, parseGitDiff } from "../lib/git-diff.ts";
import { useCanOpenTerminal } from "../lib/remote-terminals.ts";
import { hostSupportsGit, hostSupportsWorktrees, useAppState, useStore } from "../lib/store.tsx";
import { terminals } from "../lib/terminals.ts";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import { GitDiffView } from "./GitDiff.tsx";
import { GitWorktreeDialog } from "./GitWorktreeDialog.tsx";
import {
	IconAlert,
	IconArrowDown,
	IconArrowUp,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconDownload,
	IconFile,
	IconGitBranch,
	IconLayers,
	IconLoader,
	IconMessagePlus,
	IconMinus,
	IconMore,
	IconPlus,
	IconRefresh,
	IconTerminal,
	IconTrash,
	IconUndo,
	IconUpload,
	IconX,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { PanelHeading, ResizeHandle, setGitChangeCount } from "./PanelChrome.tsx";

/** Client-side timeout of commands that may run hooks or wait for a remote (the host allows 5 minutes). */
const LONG_MS = 6 * 60_000;
/** How often the status is refreshed while the window is visible. */
const POLL_MS = 10_000;
const LOG_PAGE = 50;

/** Commit message drafts per workspace, kept while the app runs. */
const drafts = new Map<string, string>();
/** Collapsed sections per workspace (the history starts collapsed). */
const collapsedByWorkspace = new Map<string, Set<string>>();

const OPERATION_TEXT: Record<string, string> = {
	merge: "正在合并：解决冲突并暂存后提交即可完成合并。",
	rebase: "正在变基：解决冲突并暂存后，请在终端中运行 git rebase --continue。",
	"cherry-pick": "正在拣选提交：解决冲突并暂存后提交即可完成。",
	revert: "正在还原提交：解决冲突并暂存后提交即可完成。",
	bisect: "正在二分查找（git bisect）。",
};

type DiffTarget = { kind: "change"; change: GitChange } | { kind: "commit"; commit: GitCommitInfo };

function useCopy() {
	const store = useStore();
	return (text: string) =>
		void navigator.clipboard.writeText(text).then(
			() => store.toast("info", "已复制"),
			() => store.toast("error", "复制失败"),
		);
}

/** Confirms throwing away changes; untracked files are deleted. */
function DiscardDialog({
	changes,
	onConfirm,
	onClose,
}: {
	changes: GitChange[];
	onConfirm: () => void;
	onClose: () => void;
}) {
	const untracked = changes.filter((c) => c.file.index === "?").length;
	const single = changes.length === 1 ? changes[0] : undefined;
	return (
		<Modal title="放弃更改" onClose={onClose}>
			<p>
				{single ? (
					<>
						确定要放弃「<strong>{single.file.path}</strong>」的更改吗？
					</>
				) : (
					<>确定要放弃 {changes.length} 个文件的更改吗？</>
				)}
			</p>
			<p className="muted small">
				{untracked
					? single
						? "这是未跟踪的文件，会被永久删除。"
						: `其中 ${untracked} 个未跟踪的文件会被永久删除。`
					: "已修改的文件会恢复为暂存区中的内容。"}
				此操作无法撤销。
			</p>
			<div className="modal-actions">
				{/* biome-ignore lint/a11y/noAutofocus: focus the safe choice so Enter does not discard. */}
				<button type="button" className="ghost" autoFocus onClick={onClose}>
					取消
				</button>
				<button
					type="button"
					className="danger"
					onClick={() => {
						onConfirm();
						onClose();
					}}
				>
					<IconUndo size={14} />
					放弃更改
				</button>
			</div>
		</Modal>
	);
}

/** Shows the diff of one changed path, or the message and diff of one commit. */
function DiffDialog({
	workspaceId,
	target,
	actions,
	onClose,
}: {
	workspaceId: string;
	target: DiffTarget;
	/** Buttons for the change (stage, discard, open). */
	actions?: ReactNode;
	onClose: () => void;
}) {
	const store = useStore();
	const [result, setResult] = useState<GitDiffResult>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		setLoading(true);
		setError(undefined);
		try {
			const diff =
				target.kind === "commit"
					? await store.git("git.show", { workspaceId, commit: target.commit.hash })
					: await store.git("git.diff", {
							workspaceId,
							path: target.change.file.path,
							...(target.change.group === "staged" ? { staged: true } : {}),
							...(target.change.group === "staged" && target.change.file.origPath
								? { origPath: target.change.file.origPath }
								: {}),
						});
			if (seq.current === id) setResult(diff);
		} catch (e) {
			if (seq.current === id) setError(gitErrorText(e));
		} finally {
			if (seq.current === id) setLoading(false);
		}
	}, [store, workspaceId, target]);
	useEffect(() => {
		void load();
	}, [load]);
	const stats = useMemo(() => (result ? diffStats(parseGitDiff(result.diff)) : undefined), [result]);

	let title: string;
	let meta: ReactNode;
	if (target.kind === "commit") {
		const c = target.commit;
		title = `提交 ${c.shortHash}`;
		meta = (
			<>
				<span className="file-viewer-path">{c.subject}</span>
				<span>
					{c.authorName} · {relativeTime(c.date)}
				</span>
			</>
		);
	} else {
		const { change } = target;
		const where = change.group === "staged" ? "已暂存" : change.group === "conflict" ? "冲突" : "工作区";
		title = `${splitPath(change.file.path).name}（${where}）`;
		meta = (
			<>
				<span className="file-viewer-path">
					{change.file.origPath ? `${change.file.origPath} → ` : ""}
					{change.file.path}
				</span>
				<span>{changeLabel(change)}</span>
			</>
		);
	}
	return (
		<Modal title={title} onClose={onClose} wide className="file-viewer git-diff-dialog">
			<div className="file-viewer-toolbar">
				<span
					className="file-viewer-meta"
					title={target.kind === "change" ? target.change.file.path : target.commit.hash}
				>
					{meta}
				</span>
				<span className="file-viewer-actions">
					{stats && (stats.added || stats.removed) ? (
						<span className="git-stats">
							<span className="add">+{stats.added}</span>
							<span className="del">−{stats.removed}</span>
						</span>
					) : null}
					{target.kind === "commit" ? (
						<button
							type="button"
							className="ghost icon"
							title="复制提交哈希"
							onClick={() => void navigator.clipboard.writeText(target.commit.hash)}
						>
							<IconCopy size={14} />
						</button>
					) : null}
					{actions}
					<button type="button" className="ghost icon" title="重新读取" disabled={loading} onClick={() => void load()}>
						<IconRefresh size={14} className={loading ? "spin" : undefined} />
					</button>
				</span>
			</div>
			<div className="file-viewer-body">
				{error ? (
					<div className="file-viewer-notice error">
						<IconAlert size={20} />
						<div>
							<strong>无法读取差异</strong>
							<p>{error}</p>
						</div>
					</div>
				) : result ? (
					<GitDiffView diff={result.diff} truncated={result.truncated} />
				) : (
					<div className="file-viewer-empty">
						<IconLoader size={16} className="spin" />
						正在读取…
					</div>
				)}
			</div>
		</Modal>
	);
}

function branchTrack(branch: GitBranchInfo): string {
	if (branch.upstreamGone) return "上游已删除";
	const parts: string[] = [];
	if (branch.behind) parts.push(`↓${branch.behind}`);
	if (branch.ahead) parts.push(`↑${branch.ahead}`);
	return parts.join(" ");
}

/** Lists branches to switch to, creates and deletes them. */
function BranchDialog({
	workspaceId,
	current,
	onClose,
}: {
	workspaceId: string;
	current?: string | undefined;
	onClose: () => void;
}) {
	const store = useStore();
	const [branches, setBranches] = useState<GitBranchInfo[]>();
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<string>();

	const load = useCallback(async () => {
		try {
			setBranches((await store.git("git.branches", { workspaceId })).branches);
		} catch (e) {
			setError(gitErrorText(e));
		}
	}, [store, workspaceId]);
	useEffect(() => {
		void load();
	}, [load]);

	const act = async (fn: () => Promise<unknown>, close: boolean) => {
		setBusy(true);
		setError(undefined);
		try {
			await fn();
			if (close) onClose();
			else await load();
		} catch (e) {
			setError(gitErrorText(e));
		} finally {
			setBusy(false);
		}
	};
	const checkout = (branch: string, create = false) =>
		act(() => store.git("git.checkout", { workspaceId, branch, ...(create ? { create: true } : {}) }), true);
	const remove = (branch: string, force: boolean) =>
		act(async () => {
			await store.git("git.deleteBranch", { workspaceId, branch, ...(force ? { force: true } : {}) });
			setConfirmDelete(undefined);
		}, false);

	const name = query.trim();
	const q = name.toLowerCase();
	const matches = (branches ?? []).filter((b) => b.name.toLowerCase().includes(q));
	const local = matches.filter((b) => !b.remote);
	const remote = matches.filter((b) => b.remote);
	const canCreate =
		!!name && /^[^-\s][^\s]*$/.test(name) && !(branches ?? []).some((b) => !b.remote && b.name === name);

	const row = (b: GitBranchInfo) => {
		const track = branchTrack(b);
		return (
			<div key={`${b.remote}:${b.name}`} className={`git-branch-row${b.current ? " current" : ""}`}>
				<button
					type="button"
					className="git-branch-main"
					disabled={busy || b.current}
					onClick={() => void checkout(b.name)}
					title={b.remote ? `切换到跟踪 ${b.name} 的本地分支` : `切换到 ${b.name}`}
				>
					<span className="git-branch-icon">{b.current ? <IconCheck size={13} /> : <IconGitBranch size={13} />}</span>
					<span className="git-branch-text">
						<span className="git-branch-name">
							{b.name}
							{track ? <span className="git-branch-track">{track}</span> : null}
						</span>
						<span className="git-branch-sub">
							{b.shortHash} · {b.subject}
							{b.date ? ` · ${relativeTime(b.date)}` : ""}
						</span>
					</span>
				</button>
				{!b.remote && !b.current ? (
					confirmDelete === b.name ? (
						<span className="git-branch-confirm">
							<button type="button" className="ghost small" disabled={busy} onClick={() => setConfirmDelete(undefined)}>
								取消
							</button>
							<button type="button" className="danger small" disabled={busy} onClick={() => void remove(b.name, false)}>
								删除
							</button>
							<button
								type="button"
								className="danger small"
								disabled={busy}
								title="即使分支没有合并也删除"
								onClick={() => void remove(b.name, true)}
							>
								强制删除
							</button>
						</span>
					) : (
						<button
							type="button"
							className="ghost icon git-branch-delete"
							title="删除分支"
							disabled={busy}
							onClick={() => setConfirmDelete(b.name)}
						>
							<IconTrash size={13} />
						</button>
					)
				) : null}
			</div>
		);
	};

	return (
		<Modal title="切换分支" onClose={onClose} className="git-branch-dialog">
			<input
				className="git-branch-search"
				// biome-ignore lint/a11y/noAutofocus: the dialog is opened to type a branch name.
				autoFocus
				value={query}
				placeholder="搜索分支，或输入新分支的名称"
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== "Enter" || busy) return;
					e.preventDefault();
					const exact = (branches ?? []).find((b) => b.name === name);
					if (exact && !exact.current) void checkout(exact.name);
					else if (canCreate) void checkout(name, true);
				}}
			/>
			{error ? <p className="error-text small git-branch-error">{error}</p> : null}
			<div className="git-branch-list">
				{canCreate ? (
					<button type="button" className="git-branch-create" disabled={busy} onClick={() => void checkout(name, true)}>
						<IconPlus size={13} />
						<span>
							从{current ? ` ${current} ` : "当前提交"}新建分支「<strong>{name}</strong>」并切换
						</span>
					</button>
				) : null}
				{!branches ? (
					<div className="files-note">
						<IconLoader size={13} className="spin" />
						加载中…
					</div>
				) : null}
				{local.length ? <div className="git-branch-heading">本地分支</div> : null}
				{local.map(row)}
				{remote.length ? <div className="git-branch-heading">远程分支</div> : null}
				{remote.map(row)}
				{branches && !matches.length && !canCreate ? <div className="files-note">没有匹配的分支</div> : null}
			</div>
		</Modal>
	);
}

/**
 * The source control view of the right-hand panel: changes of the repository the workspace
 * is in, staging, commits, branches, sync with the remote and history, like an editor's.
 * `composerKey` is the draft key of the composer on screen, if any.
 */
export function GitPanel({ workspace, composerKey }: { workspace: WorkspaceInfo; composerKey?: string }) {
	const store = useStore();
	const workspaceId = workspace.id;
	const connection = useAppState((s) => s.connection);
	const supported = useAppState((s) => hostSupportsGit(s.nodes[s.workspaceNodes[workspaceId] ?? s.node]?.hostInfo));
	const online = useAppState((s) => s.nodes[s.workspaceNodes[workspaceId] ?? s.node]?.connection === "open");
	const worktreesSupported = useAppState((s) =>
		hostSupportsWorktrees(s.nodes[s.workspaceNodes[workspaceId] ?? s.node]?.hostInfo),
	);
	const version = useAppState((s) => s.filesVersion[workspaceId] ?? 0);
	const canTerminal = useCanOpenTerminal(workspace);
	const copy = useCopy();

	const [status, setStatus] = useState<GitStatus>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [opError, setOpError] = useState<string>();
	const [message, setMessageState] = useState(() => drafts.get(workspaceId) ?? "");
	const [amend, setAmend] = useState(false);
	const [collapsed, setCollapsed] = useState<Set<string>>(
		() => collapsedByWorkspace.get(workspaceId) ?? new Set(["history"]),
	);
	const [log, setLog] = useState<{ commits: GitCommitInfo[]; more: boolean; loading: boolean; error?: string }>();
	const [diff, setDiff] = useState<DiffTarget>();
	const [branchDialog, setBranchDialog] = useState(false);
	const [worktreeDialog, setWorktreeDialog] = useState(false);
	const [discarding, setDiscarding] = useState<GitChange[]>();
	const [menu, setMenu] = useState<{ position: ContextMenuPosition; change?: GitChange }>();
	const [selected, setSelected] = useState<string>();
	const seq = useRef(0);
	const lastLoad = useRef(0);

	const setMessage = (text: string) => {
		setMessageState(text);
		if (text) drafts.set(workspaceId, text);
		else drafts.delete(workspaceId);
	};

	const load = useCallback(async () => {
		const id = ++seq.current;
		lastLoad.current = Date.now();
		setLoading(true);
		try {
			const next = await store.git("git.status", { workspaceId });
			if (seq.current !== id) return;
			setStatus(next);
			setError(undefined);
			setGitChangeCount(workspaceId, next.repository ? (next.files?.length ?? 0) : undefined);
		} catch (e) {
			if (seq.current === id) setError(gitErrorText(e));
		} finally {
			if (seq.current === id) setLoading(false);
		}
	}, [store, workspaceId]);

	const loadLog = useCallback(
		async (append: boolean) => {
			setLog((l) => ({ commits: l?.commits ?? [], more: false, loading: true }));
			try {
				const skip = append ? (log?.commits.length ?? 0) : 0;
				const { commits } = await store.git("git.log", { workspaceId, limit: LOG_PAGE, skip });
				setLog((l) => ({
					commits: append ? [...(l?.commits ?? []), ...commits] : commits,
					more: commits.length === LOG_PAGE,
					loading: false,
				}));
			} catch (e) {
				setLog((l) => ({ commits: l?.commits ?? [], more: false, loading: false, error: gitErrorText(e) }));
			}
		},
		[store, workspaceId, log?.commits.length],
	);
	const historyOpen = !collapsed.has("history");
	const repository = status?.repository === true;
	const head = status?.head;

	// Reload when shown, reconnected, after Git commands and agent runs (they bump `version`).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger.
	useEffect(() => {
		if (connection !== "open" || !online || !supported) return;
		void load();
	}, [connection, online, supported, version, load]);

	// The history follows HEAD while it is shown.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload only when HEAD moves or the section opens.
	useEffect(() => {
		if (historyOpen && repository) void loadLog(false);
	}, [historyOpen, repository, head]);

	// Files change outside Pier too (an editor, a terminal): refresh on focus and now and then.
	useEffect(() => {
		if (!supported) return;
		const refresh = () => {
			if (document.visibilityState !== "visible" || Date.now() - lastLoad.current < 2000) return;
			void load();
		};
		const timer = setInterval(refresh, POLL_MS);
		window.addEventListener("focus", refresh);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", refresh);
		};
	}, [load, supported]);

	const groups = useMemo(() => groupChanges(status?.files), [status?.files]);
	const prefix = status?.prefix;

	const toggleSection = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			collapsedByWorkspace.set(workspaceId, next);
			return next;
		});
	};

	/** Run one Git command at a time; failures show in the panel with Git's message. */
	const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
		if (busy) return;
		setBusy(label);
		setOpError(undefined);
		try {
			await fn();
			if (done) store.toast("info", done);
		} catch (e) {
			setOpError(`${label}失败：${gitErrorText(e)}`);
		} finally {
			setBusy(undefined);
			void load();
		}
	};

	const stage = (changes: GitChange[]) =>
		run("暂存", () => store.git("git.stage", { workspaceId, paths: changePaths(changes) }));
	const unstage = (changes: GitChange[]) =>
		run("取消暂存", () => store.git("git.unstage", { workspaceId, paths: changePaths(changes) }));
	const discard = (changes: GitChange[]) =>
		run("放弃更改", () => store.git("git.discard", { workspaceId, paths: changes.map((c) => c.file.path) }));
	const stageAll = () => run("暂存", () => store.git("git.stage", { workspaceId }));
	const unstageAll = () => run("取消暂存", () => store.git("git.unstage", { workspaceId }));

	const anyChanges = groups.staged.length + groups.changes.length + groups.conflict.length > 0;
	const commitLabel = amend ? "修改上次提交" : groups.staged.length || !anyChanges ? "提交" : "提交全部更改";
	const canCommit = !busy && (amend ? !!head : !!message.trim() && anyChanges);
	const commit = () => {
		if (!canCommit) return;
		void run("提交", async () => {
			if (!amend && !groups.staged.length) await store.git("git.stage", { workspaceId });
			const result = await store.git(
				"git.commit",
				{ workspaceId, message: message.trim(), ...(amend ? { amend: true } : {}) },
				LONG_MS,
			);
			setMessage("");
			setAmend(false);
			store.toast("info", `已提交 ${result.hash.slice(0, 7)}`);
		});
	};

	const pull = (rebase = false) =>
		run("拉取", () => store.git("git.pull", { workspaceId, ...(rebase ? { rebase: true } : {}) }, LONG_MS), "已拉取");
	const push = (force = false) =>
		run("推送", () => store.git("git.push", { workspaceId, ...(force ? { force: true } : {}) }, LONG_MS), "已推送");
	const fetch = () => run("抓取", () => store.git("git.fetch", { workspaceId }, LONG_MS), "已抓取所有远程仓库");
	const sync = () =>
		run(
			"同步",
			async () => {
				if (!status?.upstream) {
					await store.git("git.push", { workspaceId }, LONG_MS);
					return;
				}
				if (status.behind) await store.git("git.pull", { workspaceId }, LONG_MS);
				const after = await store.git("git.status", { workspaceId });
				if (after.ahead) await store.git("git.push", { workspaceId }, LONG_MS);
			},
			status?.upstream ? "已同步" : "已发布分支",
		);

	const openFile = (change: GitChange) => {
		const path = workspacePath(change.file.path, prefix);
		if (path) store.openFilePreview(workspaceId, path, composerKey);
	};
	const fileOpenable = (change: GitChange) => !!workspacePath(change.file.path, prefix) && change.letter !== "D";
	const insert = (change: GitChange) => {
		const path = workspacePath(change.file.path, prefix);
		if (composerKey && path) store.insertFileIntoComposer(composerKey, path);
	};

	const rowActions = (change: GitChange, size = 13): ReactNode => (
		<>
			{fileOpenable(change) ? (
				<button type="button" className="ghost icon" title="打开文件" onClick={() => openFile(change)}>
					<IconFile size={size} />
				</button>
			) : null}
			{change.group === "changes" ? (
				<button
					type="button"
					className="ghost icon"
					title="放弃更改"
					disabled={!!busy}
					onClick={() => setDiscarding([change])}
				>
					<IconUndo size={size} />
				</button>
			) : null}
			{change.group === "staged" ? (
				<button
					type="button"
					className="ghost icon"
					title="取消暂存"
					disabled={!!busy}
					onClick={() => void unstage([change])}
				>
					<IconMinus size={size} />
				</button>
			) : (
				<button
					type="button"
					className="ghost icon"
					title={change.group === "conflict" ? "标记为已解决（暂存）" : "暂存更改"}
					disabled={!!busy}
					onClick={() => void stage([change])}
				>
					<IconPlus size={size} />
				</button>
			)}
		</>
	);

	const changeMenu = (change: GitChange): ContextMenuItem[] => {
		const path = workspacePath(change.file.path, prefix);
		return [
			{ label: "查看更改", icon: <IconFile size={14} />, onSelect: () => setDiff({ kind: "change", change }) },
			fileOpenable(change) && { label: "打开文件", icon: <IconFile size={14} />, onSelect: () => openFile(change) },
			"separator",
			change.group === "staged"
				? { label: "取消暂存", icon: <IconMinus size={14} />, disabled: !!busy, onSelect: () => void unstage([change]) }
				: {
						label: change.group === "conflict" ? "标记为已解决（暂存）" : "暂存更改",
						icon: <IconPlus size={14} />,
						disabled: !!busy,
						onSelect: () => void stage([change]),
					},
			change.group === "changes" && {
				label: "放弃更改…",
				icon: <IconUndo size={14} />,
				danger: true,
				disabled: !!busy,
				onSelect: () => setDiscarding([change]),
			},
			"separator",
			!!composerKey &&
				!!path && {
					label: "插入路径到输入框",
					icon: <IconMessagePlus size={14} />,
					onSelect: () => insert(change),
				},
			{ label: "复制相对路径", icon: <IconCopy size={14} />, onSelect: () => copy(path ?? change.file.path) },
		];
	};

	const moreMenu = (): ContextMenuItem[] => {
		const hasRemote = !!status?.remotes?.length;
		return [
			{ label: "拉取", icon: <IconArrowDown size={14} />, disabled: !!busy || !hasRemote, onSelect: () => void pull() },
			{
				label: "拉取（变基）",
				icon: <IconArrowDown size={14} />,
				disabled: !!busy || !hasRemote,
				onSelect: () => void pull(true),
			},
			{ label: "推送", icon: <IconArrowUp size={14} />, disabled: !!busy || !hasRemote, onSelect: () => void push() },
			{
				label: "强制推送（--force-with-lease）",
				icon: <IconArrowUp size={14} />,
				danger: true,
				disabled: !!busy || !hasRemote || !status?.upstream,
				onSelect: () => void push(true),
			},
			{ label: "抓取", icon: <IconDownload size={14} />, disabled: !!busy || !hasRemote, onSelect: () => void fetch() },
			"separator",
			{
				label: "切换分支…",
				icon: <IconGitBranch size={14} />,
				disabled: !!busy,
				onSelect: () => setBranchDialog(true),
			},
			worktreesSupported && {
				label: "工作树…",
				icon: <IconLayers size={14} />,
				disabled: !!busy,
				onSelect: () => setWorktreeDialog(true),
			},
			"separator",
			{
				label: "储藏所有更改",
				icon: <IconDownload size={14} />,
				disabled: !!busy || !anyChanges,
				onSelect: () =>
					void run("储藏", () => store.git("git.stash", { workspaceId, action: "push" }), "已储藏所有更改"),
			},
			{
				label: "弹出最新的储藏",
				icon: <IconUpload size={14} />,
				disabled: !!busy,
				onSelect: () =>
					void run("弹出储藏", () => store.git("git.stash", { workspaceId, action: "pop" }), "已弹出储藏"),
			},
			"separator",
			canTerminal && {
				label: "在终端中打开",
				icon: <IconTerminal size={14} />,
				onSelect: () => terminals.create({ workspace, cwd: status?.root ?? workspace.path }),
			},
			!!status?.root && {
				label: "复制仓库路径",
				icon: <IconCopy size={14} />,
				onSelect: () => copy(status.root ?? ""),
			},
		];
	};

	const renderChange = (change: GitChange) => {
		const { name, dir } = splitPath(change.file.path);
		const key = `${change.group}:${change.file.path}`;
		const deleted = change.letter === "D";
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: the row's button is the focusable control; this only adds its context menu.
			<div
				key={key}
				className={`files-row git-row${selected === key ? " selected" : ""}${menu?.change === change ? " menu-open" : ""}`}
				onContextMenu={(event) => {
					event.preventDefault();
					event.stopPropagation();
					setSelected(key);
					setMenu({ position: contextMenuPosition(event), change });
				}}
			>
				<button
					type="button"
					className="files-entry"
					title={`${change.file.origPath ? `${change.file.origPath} → ` : ""}${change.file.path} · ${changeLabel(change)}`}
					onClick={() => {
						setSelected(key);
						setDiff({ kind: "change", change });
					}}
				>
					<span className="files-icon">
						<IconFile size={14} />
					</span>
					<span className={`files-name${deleted ? " git-deleted" : ""}`}>{name}</span>
					{dir ? <span className="git-dir">{dir}</span> : null}
				</button>
				<span className="files-actions">{rowActions(change)}</span>
				<span className={`git-letter git-letter-${change.letter === "!" ? "conflict" : change.letter}`}>
					{change.letter}
				</span>
			</div>
		);
	};

	const section = (id: GitGroup, title: string, items: GitChange[], actions: ReactNode) => {
		if (!items.length) return null;
		const open = !collapsed.has(id);
		return (
			<div className="git-section" key={id}>
				<div className="git-section-header">
					<button type="button" className="git-section-toggle" aria-expanded={open} onClick={() => toggleSection(id)}>
						<span className={`files-chevron${open ? " open" : ""}`}>
							<IconChevronRight size={12} />
						</span>
						<span className="git-section-title">{title}</span>
					</button>
					<span className="files-actions git-section-actions">{actions}</span>
					<span className="git-count">{items.length}</span>
				</div>
				{open ? items.map(renderChange) : null}
			</div>
		);
	};

	const history = () => {
		const open = historyOpen;
		return (
			<div className="git-section">
				<div className="git-section-header">
					<button
						type="button"
						className="git-section-toggle"
						aria-expanded={open}
						onClick={() => toggleSection("history")}
					>
						<span className={`files-chevron${open ? " open" : ""}`}>
							<IconChevronRight size={12} />
						</span>
						<span className="git-section-title">提交记录</span>
					</button>
					{open ? (
						<span className="files-actions git-section-actions">
							<button
								type="button"
								className="ghost icon"
								title="刷新提交记录"
								disabled={log?.loading}
								onClick={() => void loadLog(false)}
							>
								<IconRefresh size={13} />
							</button>
						</span>
					) : null}
				</div>
				{open ? (
					<>
						{log?.commits.map((c) => (
							<button
								type="button"
								key={c.hash}
								className={`git-commit${selected === c.hash ? " selected" : ""}`}
								title={`${c.hash}\n${c.authorName} <${c.authorEmail}>\n${c.date}`}
								onClick={() => {
									setSelected(c.hash);
									setDiff({ kind: "commit", commit: c });
								}}
							>
								<span className="git-commit-subject">
									{c.refs
										? c.refs
												.split(", ")
												.filter((r) => r && r !== "HEAD")
												.map((r) => (
													<span key={r} className="git-ref">
														{r.replace(/^HEAD -> /, "").replace(/^tag: /, "🏷 ")}
													</span>
												))
										: null}
									{c.subject || "（无提交信息）"}
								</span>
								<span className="git-commit-meta">
									{c.shortHash} · {c.authorName} · {relativeTime(c.date)}
								</span>
							</button>
						))}
						{log?.loading ? (
							<div className="files-note">
								<IconLoader size={13} className="spin" />
								加载中…
							</div>
						) : null}
						{log?.error ? (
							<div className="files-note error">
								<IconAlert size={13} />
								<span>{log.error}</span>
							</div>
						) : null}
						{log && !log.loading && !log.error && !log.commits.length ? (
							<div className="files-note">还没有提交</div>
						) : null}
						{log?.more && !log.loading ? (
							<button type="button" className="ghost small git-more" onClick={() => void loadLog(true)}>
								加载更多
							</button>
						) : null}
					</>
				) : null}
			</div>
		);
	};

	let body: ReactNode;
	if (!supported) {
		body = <div className="files-note">那台电脑的 Pier 版本过旧，不支持 Git，请先更新它</div>;
	} else if (!status) {
		body = error ? (
			<div className="files-note error">
				<IconAlert size={13} />
				<span>{error}</span>
			</div>
		) : (
			<div className="files-note">
				<IconLoader size={13} className="spin" />
				{connection === "open" ? "加载中…" : "正在连接 Pier Host…"}
			</div>
		);
	} else if (status.gitMissing) {
		body = (
			<div className="git-empty">
				<IconGitBranch size={22} />
				<strong>这台电脑上没有安装 Git</strong>
				<p>安装 Git 后点击右上角的刷新。</p>
			</div>
		);
	} else if (!status.repository) {
		body = (
			<div className="git-empty">
				<IconGitBranch size={22} />
				<strong>工作区不是 Git 仓库</strong>
				<p>初始化后，可以在这里查看更改、提交，并与远程仓库同步。</p>
				<button
					type="button"
					className="primary"
					disabled={!!busy}
					onClick={() => void run("初始化仓库", () => store.git("git.init", { workspaceId }), "已初始化 Git 仓库")}
				>
					{busy ? <IconLoader size={14} className="spin" /> : <IconPlus size={14} />}
					初始化仓库
				</button>
			</div>
		);
	} else {
		const hasRemote = !!status.remotes?.length;
		const syncLabel = status.upstream
			? `同步更改：拉取 ${status.behind ?? 0} 个提交，推送 ${status.ahead ?? 0} 个提交（${status.upstream}）`
			: "发布分支：推送到远程仓库并跟踪它";
		body = (
			<>
				<div className="git-branch-bar">
					<button
						type="button"
						className="ghost git-branch-button"
						title={`切换分支${status.root ? `\n仓库：${status.root}` : ""}`}
						disabled={!!busy}
						onClick={() => setBranchDialog(true)}
					>
						<IconGitBranch size={14} />
						<span className="git-branch-label">
							{status.branch ?? (status.head ? `${status.head.slice(0, 7)}（游离）` : "（无分支）")}
						</span>
						<IconChevronDown size={12} />
					</button>
					{hasRemote && status.branch ? (
						<button
							type="button"
							className="ghost git-sync"
							title={syncLabel}
							disabled={!!busy || !status.head}
							onClick={() => void sync()}
						>
							{status.upstream ? (
								<>
									<IconRefresh size={13} className={busy === "同步" ? "spin" : undefined} />
									{status.behind ? (
										<span>
											{status.behind}
											<IconArrowDown size={11} />
										</span>
									) : null}
									{status.ahead ? (
										<span>
											{status.ahead}
											<IconArrowUp size={11} />
										</span>
									) : null}
								</>
							) : (
								<>
									<IconUpload size={13} />
									发布
								</>
							)}
						</button>
					) : null}
				</div>
				{status.operation ? <div className="git-banner">{OPERATION_TEXT[status.operation]}</div> : null}
				{status.prefix ? (
					<div className="git-banner info" title={status.root}>
						工作区位于仓库的子目录 {status.prefix} 中，这里显示整个仓库的更改。
					</div>
				) : null}
				<div className="git-commit-box">
					<textarea
						value={message}
						rows={Math.min(8, Math.max(2, message.split("\n").length))}
						placeholder={
							amend
								? "提交信息（留空则保留上次的提交信息）"
								: `提交信息（Ctrl/⌘+Enter 提交到 ${status.branch ?? "HEAD"}）`
						}
						onChange={(e) => setMessage(e.target.value)}
						onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
								e.preventDefault();
								commit();
							}
						}}
					/>
					<div className="git-commit-actions">
						<button
							type="button"
							className="primary git-commit-button"
							disabled={!canCommit}
							onClick={commit}
							title={
								!amend && !groups.staged.length && anyChanges
									? "没有暂存的更改：会暂存所有更改（包括未跟踪的文件）后提交"
									: undefined
							}
						>
							{busy === "提交" ? <IconLoader size={14} className="spin" /> : <IconCheck size={14} />}
							{commitLabel}
						</button>
						<label className="git-amend" title="把暂存的更改并入上一个提交，并可修改它的提交信息">
							<input type="checkbox" checked={amend} disabled={!head} onChange={(e) => setAmend(e.target.checked)} />
							修改上次提交
						</label>
					</div>
				</div>
				{opError ? (
					<div className="git-banner error">
						<span>{opError}</span>
						<button type="button" className="ghost icon" title="关闭" onClick={() => setOpError(undefined)}>
							<IconX size={12} />
						</button>
					</div>
				) : null}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: the context menu repeats the header's actions. */}
				<div
					className="files-tree git-tree"
					onContextMenu={(event) => {
						event.preventDefault();
						setMenu({ position: contextMenuPosition(event) });
					}}
				>
					{section(
						"conflict",
						"合并冲突",
						groups.conflict,
						<button
							type="button"
							className="ghost icon"
							title="全部标记为已解决（暂存）"
							disabled={!!busy}
							onClick={() => void stage(groups.conflict)}
						>
							<IconPlus size={13} />
						</button>,
					)}
					{section(
						"staged",
						"暂存的更改",
						groups.staged,
						<button
							type="button"
							className="ghost icon"
							title="全部取消暂存"
							disabled={!!busy}
							onClick={() => void unstageAll()}
						>
							<IconMinus size={13} />
						</button>,
					)}
					{section(
						"changes",
						"更改",
						groups.changes,
						<>
							<button
								type="button"
								className="ghost icon"
								title="放弃所有更改"
								disabled={!!busy}
								onClick={() => setDiscarding(groups.changes)}
							>
								<IconUndo size={13} />
							</button>
							<button
								type="button"
								className="ghost icon"
								title="暂存所有更改"
								disabled={!!busy}
								onClick={() => void stageAll()}
							>
								<IconPlus size={13} />
							</button>
						</>,
					)}
					{!anyChanges ? <div className="files-note">没有更改</div> : null}
					{status.truncated ? <div className="files-note">更改太多，只显示了前 {status.files?.length} 项</div> : null}
					{history()}
				</div>
			</>
		);
	}

	const diffActions = (change: GitChange): ReactNode => {
		const close = () => setDiff(undefined);
		return (
			<>
				{fileOpenable(change) ? (
					<button
						type="button"
						className="ghost small"
						onClick={() => {
							close();
							openFile(change);
						}}
					>
						<IconFile size={13} />
						打开文件
					</button>
				) : null}
				{change.group === "changes" ? (
					<button
						type="button"
						className="ghost small error-text"
						disabled={!!busy}
						onClick={() => {
							close();
							setDiscarding([change]);
						}}
					>
						<IconUndo size={13} />
						放弃
					</button>
				) : null}
				{change.group === "staged" ? (
					<button
						type="button"
						className="ghost small"
						disabled={!!busy}
						onClick={() => {
							close();
							void unstage([change]);
						}}
					>
						<IconMinus size={13} />
						取消暂存
					</button>
				) : (
					<button
						type="button"
						className="ghost small"
						disabled={!!busy}
						onClick={() => {
							close();
							void stage([change]);
						}}
					>
						<IconPlus size={13} />
						{change.group === "conflict" ? "标记为已解决" : "暂存"}
					</button>
				)}
			</>
		);
	};

	return (
		<aside className="files-panel git-panel" aria-label="源代码管理">
			<ResizeHandle />
			<header className="files-header">
				<PanelHeading workspaceId={workspaceId} name={workspace.name} title={status?.root ?? workspace.path} />
				<button
					type="button"
					className="ghost icon"
					title="刷新"
					disabled={connection !== "open" || !supported}
					onClick={() => void load()}
				>
					<IconRefresh size={14} className={loading || busy ? "spin" : undefined} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title="更多 Git 操作"
					disabled={!repository}
					onClick={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						setMenu({ position: { x: rect.left, y: rect.bottom + 4, anchor: event.currentTarget } });
					}}
				>
					<IconMore size={14} />
				</button>
				<button type="button" className="ghost icon" title="关闭面板" onClick={() => store.toggleFilesPanel(false)}>
					<IconX size={14} />
				</button>
			</header>
			<div className="git-body">{body}</div>
			<div className="files-hint">{busy ? `正在${busy}…` : "单击查看更改，右键更多操作"}</div>
			{menu ? (
				<ContextMenu
					position={menu.position}
					label={menu.change ? splitPath(menu.change.file.path).name : "Git"}
					items={menu.change ? changeMenu(menu.change) : moreMenu()}
					onClose={() => setMenu(undefined)}
				/>
			) : null}
			{diff ? (
				<DiffDialog
					workspaceId={workspaceId}
					target={diff}
					{...(diff.kind === "change" ? { actions: diffActions(diff.change) } : {})}
					onClose={() => setDiff(undefined)}
				/>
			) : null}
			{branchDialog ? (
				<BranchDialog
					workspaceId={workspaceId}
					current={status?.branch}
					onClose={() => {
						setBranchDialog(false);
						void load();
					}}
				/>
			) : null}
			{worktreeDialog ? (
				<GitWorktreeDialog
					workspace={workspace}
					current={status?.branch}
					remotes={status?.remotes}
					onClose={() => {
						setWorktreeDialog(false);
						void load();
					}}
				/>
			) : null}
			{discarding ? (
				<DiscardDialog
					changes={discarding}
					onConfirm={() => void discard(discarding)}
					onClose={() => setDiscarding(undefined)}
				/>
			) : null}
		</aside>
	);
}
