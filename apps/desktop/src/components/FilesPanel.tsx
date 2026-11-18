import type { WorkspaceFileEntry, WorkspaceInfo } from "@pier/protocol";
import {
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { WORKSPACE_FILE_DRAG_TYPE, workspaceDragEntries, workspaceDropEntries } from "../lib/file-drag.ts";
import { workspaceNameError } from "../lib/file-names.ts";
import { type SelectionUpdate, selectByKeyboard, selectByPointer } from "../lib/file-selection.ts";
import {
	downloadFile,
	dragHasFiles,
	dropEntries,
	type OverwriteAnswer,
	type OverwriteQuestion,
	type PasteConflictAnswer,
	type PasteConflictQuestion,
	pasteNameError,
	pasteWorkspaceEntries,
	type Transfer,
	transferFinished,
	transfers,
	type UploadItem,
	uploadFiles,
	uploadItemsFromInput,
	useTransfers,
} from "../lib/file-transfers.ts";
import { formatBytes, joinPath, relativeTime } from "../lib/format.ts";
import { useCanOpenTerminal } from "../lib/remote-terminals.ts";
import {
	hostCanCreateFiles,
	hostCanDeleteFiles,
	hostTransfersFiles,
	hostTransfersWorkspacePaths,
	isRightPanelOpen,
	useAppState,
	useStore,
} from "../lib/store.tsx";
import { terminals } from "../lib/terminals.ts";
import {
	clearWorkspaceClipboard,
	setWorkspaceClipboard,
	useWorkspaceClipboard,
	useWorkspacePasteBusy,
	type WorkspaceClipboardEntry,
	type WorkspaceClipboardMode,
	type WorkspaceClipboardState,
} from "../lib/workspace-clipboard.ts";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import {
	IconAlert,
	IconChevronRight,
	IconChevronUp,
	IconCopy,
	IconCut,
	IconDownload,
	IconExternal,
	IconFile,
	IconFilePlus,
	IconFolder,
	IconFolderOpen,
	IconFolderPlus,
	IconLink,
	IconLoader,
	IconMessagePlus,
	IconPanelRight,
	IconPaste,
	IconPencil,
	IconRefresh,
	IconTerminal,
	IconTrash,
	IconUpload,
	IconX,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { PanelHeading } from "./PanelChrome.tsx";

interface DirState {
	entries?: WorkspaceFileEntry[];
	error?: string;
	loading: boolean;
	truncated?: boolean;
	total?: number;
}

/** Expanded directories per workspace, kept while the app runs so switching back restores the tree. */
const expandedByWorkspace = new Map<string, Set<string>>();

const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
const revealLabel = /Mac/.test(platform)
	? "在访达中显示"
	: /Win/.test(platform)
		? "在资源管理器中显示"
		: "在文件管理器中显示";

/** The parent of a workspace-relative path (`""` for the workspace root). */
function parentPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function errorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持文件列表，请更新 Pier";
	if (code === "NOT_FOUND") return "目录不存在";
	if (code === "FORBIDDEN") return "无权访问该目录";
	return message;
}

/** Create an entry on the workspace's computer, without opening a local file picker. */
function CreateDialog({
	workspace,
	dir,
	kind,
	onClose,
	onCreated,
}: {
	workspace: WorkspaceInfo;
	dir: string;
	kind: "file" | "directory";
	onClose: () => void;
	onCreated: (path: string) => void;
}) {
	const store = useStore();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.focus(), []);
	const what = kind === "file" ? "文件" : "文件夹";
	const create = async () => {
		if (busy || !name.trim()) return;
		const value = name.trim();
		const segments = value.split(/[\\/]+/).filter((part) => part && part !== ".");
		if (!segments.length || /^[\\/]|^[a-zA-Z]:/.test(value) || segments.some((part) => part === "..")) {
			setError("请输入当前目录内的名称或相对路径，不能使用绝对路径或 ..");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const path = dir ? `${dir}/${value}` : value;
			const result =
				kind === "file" ? await store.createFile(workspace.id, path) : await store.createDirectory(workspace.id, path);
			store.toast("info", `已创建${what}「${result.path}」`);
			onCreated(result.path);
		} catch (error) {
			const code = (error as { code?: string }).code;
			setError(
				code === "CONFLICT"
					? "已有同名文件或文件夹，请使用其他名称"
					: code === "FORBIDDEN"
						? "没有权限创建，或目标目录位于工作区之外"
						: `创建失败：${errorText(error)}`,
			);
			setBusy(false);
		}
	};
	return (
		<Modal title={`新建${what}`} className="files-create-dialog" onClose={() => !busy && onClose()}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void create();
				}}
			>
				<p className="muted small">创建位置：{store.nodeName(store.nodeOf(workspace.id))}</p>
				<code className="path">{joinPath(workspace.path, dir)}</code>
				<label className="field">
					<span className="field-label">{what}名称</span>
					<input
						ref={input}
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder={kind === "file" ? "例如 notes/todo.md" : "例如 src/components"}
						maxLength={4096}
						disabled={busy}
						autoComplete="off"
					/>
				</label>
				<p className="muted small">可以带子目录，缺少的上级文件夹会自动创建。</p>
				{error ? (
					<p className="error-text small" role="alert">
						{error}
					</p>
				) : null}
				<div className="modal-actions">
					<button type="button" className="ghost" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button type="submit" disabled={busy || !name.trim()}>
						{busy ? (
							<IconLoader size={14} className="spin" />
						) : kind === "file" ? (
							<IconFilePlus size={14} />
						) : (
							<IconFolderPlus size={14} />
						)}
						{busy ? "正在创建…" : "创建"}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function RenameDialog({
	workspace,
	entry,
	onClose,
	onRenamed,
}: {
	workspace: WorkspaceInfo;
	entry: WorkspaceFileEntry;
	onClose: () => void;
	onRenamed: (path: string) => void;
}) {
	const store = useStore();
	const [name, setName] = useState(entry.name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
		// Select the stem of ordinary files, but the entire name of dotfiles, folders and links.
		const dot =
			entry.kind === "file" && !entry.symlink && !entry.name.startsWith(".") ? entry.name.lastIndexOf(".") : -1;
		input.current?.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
	}, [entry]);
	const rename = async () => {
		if (busy || name.trim() === entry.name) return;
		const invalid = workspaceNameError(name);
		if (invalid) {
			setError(invalid);
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const result = await store.renamePath(workspace.id, entry.path, name);
			store.toast("info", `已重命名为「${name.trim()}」`);
			onRenamed(result.path);
		} catch (error) {
			const code = (error as { code?: string }).code;
			setError(
				code === "CONFLICT"
					? "已有同名文件或文件夹，请使用其他名称"
					: code === "NOT_FOUND"
						? "原项目或所在目录已不存在，请刷新文件列表"
						: code === "FORBIDDEN"
							? "没有权限重命名，或所在目录位于工作区之外"
							: `重命名失败：${errorText(error)}`,
			);
			setBusy(false);
		}
	};
	return (
		<Modal title="重命名" className="files-create-dialog" onClose={() => !busy && onClose()}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void rename();
				}}
			>
				<code className="path">{joinPath(workspace.path, entry.path)}</code>
				<label className="field">
					<span className="field-label">新名称</span>
					<input
						ref={input}
						value={name}
						onChange={(event) => {
							setName(event.target.value);
							setError(undefined);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
						}}
						maxLength={255}
						disabled={busy}
						autoComplete="off"
					/>
				</label>
				{error ? (
					<p className="error-text small" role="alert">
						{error}
					</p>
				) : null}
				<div className="modal-actions">
					<button type="button" className="ghost" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button type="submit" disabled={busy || !name.trim() || name.trim() === entry.name}>
						{busy ? <IconLoader size={14} className="spin" /> : <IconPencil size={14} />}
						{busy ? "正在重命名…" : "重命名"}
					</button>
				</div>
			</form>
		</Modal>
	);
}

/** Confirms and performs a permanent delete of one or more entries of the file panel. */
function DeleteDialog({
	workspace,
	entries,
	onClose,
}: {
	workspace: WorkspaceInfo;
	entries: WorkspaceFileEntry[];
	onClose: () => void;
}) {
	const store = useStore();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const completed = useRef(new Set<string>());
	const single = entries.length === 1 ? entries[0] : undefined;
	const isDir = single?.kind === "directory" && !single.symlink;
	const what = single ? (single.symlink ? "符号链接" : isDir ? "文件夹" : "文件") : "项目";
	const remove = async () => {
		setBusy(true);
		setError(undefined);
		for (const entry of entries) {
			if (completed.current.has(entry.path)) continue;
			try {
				await store.deletePath(workspace.id, entry.path);
			} catch (e) {
				const code = (e as { code?: string }).code;
				if (code === "NOT_FOUND") store.bumpFiles(workspace.id);
				else {
					const reason = code === "FORBIDDEN" ? "没有权限删除，或它位于工作区之外" : errorText(e);
					const progress = completed.current.size ? `已完成 ${completed.current.size} 项；` : "";
					setError(`${progress}删除「${entry.name}」失败：${reason}`);
					setBusy(false);
					return;
				}
			}
			completed.current.add(entry.path);
		}
		store.toast("info", single ? `已删除${what}「${single.name}」` : `已删除 ${entries.length} 个项目`);
		onClose();
	};
	return (
		<Modal title={single ? `删除${what}` : `删除 ${entries.length} 个项目`} onClose={() => !busy && onClose()}>
			<p>
				{single ? (
					<>
						确定要永久删除{what}「<strong>{single.name}</strong>」吗？
					</>
				) : (
					<>确定要永久删除选中的 {entries.length} 个文件或文件夹吗？</>
				)}
			</p>
			<div className="files-delete-paths">
				{entries.map((entry) => (
					<code className="path" key={entry.path}>
						{joinPath(workspace.path, entry.path)}
					</code>
				))}
			</div>
			<p className="muted small">
				{single?.symlink
					? "只删除这个链接，不影响它指向的内容。"
					: isDir
						? "文件夹中的所有文件和子文件夹都会一起删除。"
						: single
							? null
							: "选中的文件夹会连同其中的内容一起删除；符号链接只删除链接本身。"}
				删除不会进入废纸篓 / 回收站，无法撤销。
			</p>
			{error ? <p className="error-text small">{error}</p> : null}
			<div className="modal-actions">
				{/* biome-ignore lint/a11y/noAutofocus: focus the safe choice so Enter does not delete. */}
				<button type="button" className="ghost" autoFocus disabled={busy} onClick={onClose}>
					取消
				</button>
				<button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
					{busy ? <IconLoader size={14} className="spin" /> : <IconTrash size={14} />}
					{busy ? "正在删除…" : completed.current.size ? "重试剩余项目" : "永久删除"}
				</button>
			</div>
		</Modal>
	);
}

/** Resolves a name conflict, with an editable destination name when pasting. */
export function OverwriteDialog({
	question,
	onAnswer,
	rename,
}: {
	question: OverwriteQuestion;
	onAnswer: (answer: OverwriteAnswer) => void;
	rename?: { suggestedName: string; error?: string; onRename: (name: string) => void };
}) {
	const [all, setAll] = useState(false);
	const [name, setName] = useState(rename?.suggestedName ?? "");
	const [error, setError] = useState(rename?.error);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	return (
		<Modal
			title={rename ? "改名后粘贴" : "目标已存在"}
			className="files-conflict-dialog"
			onClose={() => onAnswer({ choice: "cancel" })}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (!rename) return;
					const invalid = pasteNameError(name, question.path.slice(question.path.lastIndexOf("/") + 1));
					if (invalid) setError(invalid);
					else rename.onRename(name.trim());
				}}
			>
				<p>
					{rename
						? "目标目录中已有同名文件或文件夹，请输入新名称后继续粘贴。"
						: question.canOverwrite === false
							? "目标目录中已经有同名项目，请跳过或取消后更改名称。"
							: "目标目录中已经有同名文件，要替换它吗？"}
				</p>
				<code className="path">{question.path}</code>
				{rename ? (
					<label className="field">
						<span className="field-label">新名称</span>
						<input
							ref={input}
							value={name}
							onChange={(event) => {
								setName(event.target.value);
								setError(undefined);
							}}
							autoComplete="off"
						/>
					</label>
				) : null}
				{error ? (
					<p className="error-text small" role="alert">
						{error}
					</p>
				) : null}
				{question.more && question.canOverwrite !== false ? (
					<label className="files-overwrite-all muted small">
						<input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
						{rename ? "对其余同名文件应用跳过或替换" : "对其余同名文件执行相同操作"}
					</label>
				) : null}
				<div className="modal-actions">
					<button type="button" className="ghost" onClick={() => onAnswer({ choice: "cancel" })}>
						{question.more ? "取消其余操作" : "取消"}
					</button>
					{/* biome-ignore lint/a11y/noAutofocus: focus the safe choice so Enter does not replace. */}
					<button type="button" autoFocus={!rename} onClick={() => onAnswer({ choice: "skip", all })}>
						跳过
					</button>
					{question.canOverwrite !== false ? (
						<button type="button" className="danger" onClick={() => onAnswer({ choice: "overwrite", all })}>
							替换
						</button>
					) : null}
					{rename ? (
						<button type="submit" disabled={!name.trim()}>
							改名并粘贴
						</button>
					) : null}
				</div>
			</form>
		</Modal>
	);
}

function transferStatus(t: Transfer): string {
	switch (t.state) {
		case "queued":
			return "等待中";
		case "running":
			return t.total !== undefined ? `${formatBytes(t.done)} / ${formatBytes(t.total)}` : "准备中…";
		case "done":
			return t.kind === "upload"
				? "已上传"
				: t.kind === "download"
					? "已下载"
					: t.kind === "move"
						? "已移动"
						: "已复制";
		case "cancelled":
			return "已取消";
		case "skipped":
			return "已跳过";
		case "error":
			return t.error ?? "失败";
	}
}

/** Uploads and downloads of one workspace, with progress. */
export function TransferList({ workspaceId }: { workspaceId: string }) {
	const items = useTransfers(workspaceId);
	if (!items.length) return null;
	const finished = items.filter(transferFinished).length;
	return (
		<section className="files-transfers" aria-label="文件传输">
			{items.map((t) => {
				const percent = t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === "done" ? 100 : 0;
				const done = transferFinished(t);
				return (
					<div
						key={t.id}
						className={`files-transfer ${t.state}`}
						title={`${t.path}${t.savedTo ? ` → ${t.savedTo}` : ""}`}
					>
						<span className="files-transfer-icon">
							{t.kind === "upload" ? (
								<IconUpload size={13} />
							) : t.kind === "download" ? (
								<IconDownload size={13} />
							) : t.kind === "move" ? (
								<IconCut size={13} />
							) : (
								<IconCopy size={13} />
							)}
						</span>
						<div className="files-transfer-main">
							<div className="files-transfer-line">
								<span className="files-transfer-name">{t.name}</span>
								<span className="files-transfer-status">{transferStatus(t)}</span>
							</div>
							{t.state === "running" || t.state === "queued" ? (
								<div className="files-transfer-bar">
									<span className="files-transfer-fill" style={{ width: `${percent}%` }} />
								</div>
							) : null}
						</div>
						<button
							type="button"
							className="ghost icon"
							title={done ? "移除" : "取消"}
							disabled={!done && t.cancellable === false}
							onClick={() => (done ? transfers.dismiss(t.id) : transfers.cancel(t.id))}
						>
							<IconX size={12} />
						</button>
					</div>
				);
			})}
			{finished > 1 ? (
				<button
					type="button"
					className="ghost files-transfers-clear"
					onClick={() => transfers.clearFinished(workspaceId)}
				>
					清除已结束的
				</button>
			) : null}
		</section>
	);
}

/** `webkitdirectory` is not in React's input attribute types. */
const folderInputProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

function useWorkspaceTree(workspaceId: string) {
	const store = useStore();
	const [dirs, setDirs] = useState<Record<string, DirState>>({});
	const [expanded, setExpanded] = useState<Set<string>>(() => expandedByWorkspace.get(workspaceId) ?? new Set());
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	/** Latest request per directory, so a slow old answer never overwrites a newer one. */
	const requests = useRef(new Map<string, number>());
	const seq = useRef(0);

	const updateExpanded = useCallback(
		(fn: (set: Set<string>) => void) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				fn(next);
				expandedByWorkspace.set(workspaceId, next);
				return next;
			});
		},
		[workspaceId],
	);

	const load = useCallback(
		async (path: string) => {
			const id = ++seq.current;
			requests.current.set(path, id);
			setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true } }));
			try {
				const result = await store.listFiles(workspaceId, path);
				if (requests.current.get(path) !== id) return;
				setDirs((d) => ({
					...d,
					[path]: {
						entries: result.entries,
						loading: false,
						...(result.truncated ? { truncated: true, total: result.total } : {}),
					},
				}));
			} catch (error) {
				if (requests.current.get(path) !== id) return;
				// An expanded directory that disappeared collapses instead of showing an error.
				if (path && (error as { code?: string }).code === "NOT_FOUND") {
					updateExpanded((set) => {
						for (const p of [...set]) if (p === path || p.startsWith(`${path}/`)) set.delete(p);
					});
					setDirs((d) => {
						const { [path]: _gone, ...rest } = d;
						return rest;
					});
					return;
				}
				setDirs((d) => ({ ...d, [path]: { ...d[path], loading: false, error: errorText(error) } }));
			}
		},
		[store, workspaceId, updateExpanded],
	);

	const reload = useCallback(() => {
		void load("");
		for (const path of expandedRef.current) void load(path);
	}, [load]);

	const toggle = useCallback(
		(path: string) => {
			const open = !expandedRef.current.has(path);
			updateExpanded((set) => {
				if (open) set.add(path);
				else set.delete(path);
			});
			if (open) void load(path);
		},
		[load, updateExpanded],
	);

	const collapseAll = useCallback(() => updateExpanded((set) => set.clear()), [updateExpanded]);
	const reveal = useCallback(
		(path: string, directory: boolean) => {
			const parents: string[] = [];
			for (let parent = directory ? path : parentPath(path); parent; parent = parentPath(parent)) parents.push(parent);
			updateExpanded((set) => {
				for (const parent of parents) set.add(parent);
			});
			void load("");
			for (const parent of parents) void load(parent);
		},
		[load, updateExpanded],
	);

	const renamed = (from: string, to: string) => {
		const remap = (path: string) =>
			path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
		// Ignore in-flight listings from before the rename, including the old parent listing.
		requests.current.clear();
		setDirs((current) =>
			Object.fromEntries(
				Object.entries(current).map(([path, dir]) => [
					remap(path),
					{
						...dir,
						entries: dir.entries?.map((entry) => ({
							...entry,
							path: remap(entry.path),
							name: entry.path === from ? to.slice(to.lastIndexOf("/") + 1) : entry.name,
						})),
					},
				]),
			),
		);
		updateExpanded((set) => {
			const next = [...set].map(remap);
			set.clear();
			for (const path of next) set.add(path);
		});
		void load("");
		for (const path of expandedRef.current) void load(remap(path));
	};

	return { dirs, expanded, reload, toggle, collapseAll, reveal, renamed };
}

function entryTitle(entry: WorkspaceFileEntry): string {
	const parts = [entry.path];
	if (entry.kind === "file" && entry.size !== undefined) parts.push(formatBytes(entry.size));
	if (entry.modifiedAt) parts.push(`修改于 ${relativeTime(entry.modifiedAt)}`);
	if (entry.symlink) parts.push("符号链接");
	return parts.join(" · ");
}

/** Flatten the entries currently visible in the expanded tree, in display order. */
function collectVisibleEntries(
	path: string,
	dirs: Record<string, DirState>,
	expanded: ReadonlySet<string>,
	out: WorkspaceFileEntry[],
): void {
	for (const entry of dirs[path]?.entries ?? []) {
		out.push(entry);
		if (entry.kind === "directory" && expanded.has(entry.path)) collectVisibleEntries(entry.path, dirs, expanded, out);
	}
}

/** Selected directories make their descendants redundant for a bulk delete. */
function deleteRoots(entries: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
	const paths = new Set(entries.map((entry) => entry.path));
	return entries.filter((entry) => {
		for (let parent = parentPath(entry.path); parent; parent = parentPath(parent)) {
			if (paths.has(parent)) return false;
		}
		return true;
	});
}

/**
 * `composerKey` is the draft key of the composer on screen (a session id, or the new-chat
 * draft); without it the panel only offers copying paths.
 */
export function FilesPanel({ workspace, composerKey }: { workspace: WorkspaceInfo; composerKey?: string }) {
	const store = useStore();
	const connection = useAppState((s) => s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.connection);
	// Terminals open on the workspace's computer (this one, or a paired one that runs them).
	const canTerminal = useCanOpenTerminal(workspace);
	const canDelete = useAppState((s) => hostCanDeleteFiles(s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.hostInfo));
	const canCreate = useAppState((s) => hostCanCreateFiles(s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.hostInfo));
	const canTransfer = useAppState(
		(s) =>
			s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.connection === "open" &&
			hostTransfersFiles(s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.hostInfo),
	);
	const clipboard = useWorkspaceClipboard();
	const pasteBusy = useWorkspacePasteBusy();
	const canPaste = canTransfer && Boolean(clipboard) && !pasteBusy;
	const nativeTransfers = useAppState((s) =>
		hostTransfersWorkspacePaths(s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.hostInfo),
	);
	const canMove = canTransfer && nativeTransfers && !pasteBusy;
	const dragged = useRef<WorkspaceClipboardState>(undefined);
	const [dragPaths, setDragPaths] = useState<ReadonlySet<string>>(() => new Set());
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	/** Workspace directory the next picked files go to. */
	const uploadDir = useRef("");
	/** Directory highlighted while files are dragged over the tree. */
	const [dropDir, setDropDir] = useState<string>();
	const [overwrite, setOverwrite] = useState<
		(
			| { kind: "upload"; question: OverwriteQuestion; resolve: (answer: OverwriteAnswer) => void }
			| { kind: "paste"; question: PasteConflictQuestion; resolve: (answer: PasteConflictAnswer) => void }
		) & { id: number }
	>();
	const overwriteRef = useRef(overwrite);
	const nextConflictId = useRef(0);
	const mounted = useRef(true);
	const askOverwrite = (question: OverwriteQuestion): Promise<OverwriteAnswer> =>
		new Promise((resolve) => {
			if (!mounted.current) {
				resolve({ choice: "cancel" });
				return;
			}
			overwriteRef.current?.resolve({ choice: "cancel" });
			const pending = { kind: "upload" as const, question, resolve, id: nextConflictId.current++ };
			overwriteRef.current = pending;
			setOverwrite(pending);
		});
	const askPasteConflict = (question: PasteConflictQuestion): Promise<PasteConflictAnswer> =>
		new Promise((resolve) => {
			if (!mounted.current) {
				resolve({ choice: "cancel" });
				return;
			}
			overwriteRef.current?.resolve({ choice: "cancel" });
			const pending = { kind: "paste" as const, question, resolve, id: nextConflictId.current++ };
			overwriteRef.current = pending;
			setOverwrite(pending);
		});
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			overwriteRef.current?.resolve({ choice: "cancel" });
		};
	}, []);
	/** Entries awaiting delete confirmation. */
	const [deleting, setDeleting] = useState<WorkspaceFileEntry[]>();
	const [creating, setCreating] = useState<{ dir: string; kind: "file" | "directory" }>();
	const [renaming, setRenaming] = useState<WorkspaceFileEntry>();
	const version = useAppState((s) => s.filesVersion[workspace.id] ?? 0);
	const { dirs, expanded, reload, toggle, collapseAll, reveal, renamed } = useWorkspaceTree(workspace.id);
	const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
	const [selectionAnchor, setSelectionAnchor] = useState<string>();
	const [copied, setCopied] = useState<string>();
	/** Open context menu; without `entry` it is the menu for the workspace root (blank area). */
	const [menu, setMenu] = useState<{ position: ContextMenuPosition; entry?: WorkspaceFileEntry }>();
	const lastReload = useRef(0);
	/** Pending single-click preview, cancelled when the click turns out to be a double click. */
	const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const entryRefs = useRef(new Map<string, HTMLButtonElement>());
	const visibleEntries = useMemo(() => {
		const entries: WorkspaceFileEntry[] = [];
		collectVisibleEntries("", dirs, expanded, entries);
		return entries;
	}, [dirs, expanded]);
	const visiblePaths = useMemo(() => visibleEntries.map((entry) => entry.path), [visibleEntries]);
	useEffect(() => () => clearTimeout(clickTimer.current), []);

	// Refreshes and collapsed directories must not leave hidden selections.
	useEffect(() => {
		const visible = new Set(visiblePaths);
		setSelectedPaths((current) => {
			const next = new Set([...current].filter((path) => visible.has(path)));
			return next.size === current.size ? current : next;
		});
		if (selectionAnchor && !visible.has(selectionAnchor)) setSelectionAnchor(undefined);
	}, [selectionAnchor, visiblePaths]);

	// Reload when opened, reconnected, or after an agent run in this workspace.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger.
	useEffect(() => {
		if (connection !== "open") return;
		lastReload.current = Date.now();
		reload();
	}, [connection, version, reload]);

	// Files often change outside Pier (an editor, git): refresh when the window regains focus.
	useEffect(() => {
		const onFocus = () => {
			if (Date.now() - lastReload.current < 2000) return;
			lastReload.current = Date.now();
			reload();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [reload]);

	const copyText = (text: string, badge?: string) => {
		void navigator.clipboard.writeText(text).then(
			() => {
				if (badge === undefined) return;
				setCopied(badge);
				setTimeout(() => setCopied((c) => (c === badge ? undefined : c)), 1200);
			},
			() => store.toast("error", "复制失败"),
		);
	};
	const copyPath = (entry: WorkspaceFileEntry) => copyText(entry.path, entry.path);
	const insert = (entry: WorkspaceFileEntry) => {
		if (composerKey) store.insertFileIntoComposer(composerKey, entry.path, entry.kind === "directory");
	};
	const refresh = () => {
		lastReload.current = Date.now();
		reload();
	};
	const applySelection = (update: SelectionUpdate) => {
		setSelectedPaths(update.selected);
		setSelectionAnchor(update.anchor);
	};
	const selectEntry = (entry: WorkspaceFileEntry, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
		applySelection(selectByPointer(visiblePaths, selectedPaths, selectionAnchor, entry.path, event));
	};
	const focusEntry = (path: string) => {
		const button = entryRefs.current.get(path);
		button?.focus({ preventScroll: true });
		button?.scrollIntoView({ block: "nearest" });
	};
	const visibleSelection = () => visibleEntries.filter((entry) => selectedPaths.has(entry.path));
	const startRename = (entry: WorkspaceFileEntry) => {
		if (!canMove || (entry.kind === "other" && !entry.symlink)) return;
		clearTimeout(clickTimer.current);
		setRenaming(entry);
	};
	const copySelectedPaths = (absolute: boolean) => {
		const paths = visibleSelection().map((entry) => (absolute ? joinPath(workspace.path, entry.path) : entry.path));
		copyText(paths.join("\n"), paths.length === 1 ? paths[0] : undefined);
	};
	const copyEntries = (entries: WorkspaceFileEntry[], mode: WorkspaceClipboardMode) => {
		if (!canTransfer || pasteBusy) return;
		const roots = deleteRoots(entries);
		if (roots.some((entry) => entry.kind === "other")) {
			store.toast("error", "请选择普通文件或文件夹");
			return;
		}
		setWorkspaceClipboard(mode, workspace.id, roots as WorkspaceClipboardEntry[]);
		store.toast("info", `已${mode === "move" ? "剪切" : "复制"} ${roots.length} 项，切换到目标工作区后粘贴`);
	};
	const paste = (dir: string) => {
		if (!canPaste || !clipboard) return;
		void pasteWorkspaceEntries(store, clipboard, workspace, dir, askPasteConflict);
	};
	const openEntry = (entry: WorkspaceFileEntry) => {
		if (entry.kind === "directory") {
			toggle(entry.path);
			return;
		}
		if (entry.kind === "file") store.openFilePreview(workspace.id, entry.path, composerKey);
	};
	const onEntryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: WorkspaceFileEntry) => {
		if (event.nativeEvent.isComposing || event.altKey) return;
		const command = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		const move = (path: string) => {
			applySelection(selectByKeyboard(visiblePaths, selectionAnchor ?? entry.path, path, event.shiftKey));
			focusEntry(path);
		};
		if (command && key === "a" && !event.shiftKey) {
			setSelectedPaths(new Set(visiblePaths));
			setSelectionAnchor(entry.path);
		} else if (command && key === "c") {
			if (event.shiftKey) copySelectedPaths(true);
			else copyEntries(selectedPaths.has(entry.path) ? visibleSelection() : [entry], "copy");
		} else if (command && key === "x" && !event.shiftKey) {
			copyEntries(selectedPaths.has(entry.path) ? visibleSelection() : [entry], "move");
		} else if (command && key === "v" && !event.shiftKey) {
			paste(entry.kind === "directory" ? entry.path : parentPath(entry.path));
		} else if (!command && !event.shiftKey && event.key === "F2") {
			if (selectedPaths.has(entry.path) && selectedPaths.size > 1) return;
			startRename(entry);
		} else if (event.key === "Escape") {
			setSelectedPaths(new Set());
			setSelectionAnchor(undefined);
			clearWorkspaceClipboard();
		} else if (!command && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			const index = visiblePaths.indexOf(entry.path);
			const next =
				event.key === "Home"
					? 0
					: event.key === "End"
						? visiblePaths.length - 1
						: Math.max(0, Math.min(visiblePaths.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
			const path = visiblePaths[next];
			if (path) move(path);
		} else if (!command && event.key === "ArrowRight") {
			if (entry.kind === "directory") {
				if (!expanded.has(entry.path)) toggle(entry.path);
				else {
					const child = dirs[entry.path]?.entries?.[0];
					if (child) move(child.path);
				}
			}
		} else if (!command && event.key === "ArrowLeft") {
			if (entry.kind === "directory" && expanded.has(entry.path)) toggle(entry.path);
			else {
				const parent = parentPath(entry.path);
				if (parent) move(parent);
			}
		} else if (event.key === " " && !event.shiftKey) {
			if (!event.repeat) selectEntry(entry, { shiftKey: false, ctrlKey: true, metaKey: false });
		} else if (!command && event.key === "Enter") {
			openEntry(entry);
		} else if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
			if (!canDelete || connection !== "open") return;
			const targets = selectedPaths.has(entry.path) ? visibleSelection() : [entry];
			setDeleting(deleteRoots(targets));
		} else return;
		clearTimeout(clickTimer.current);
		event.preventDefault();
		event.stopPropagation();
	};

	const upload = (items: UploadItem[]) => {
		void uploadFiles(store, workspace, items, askOverwrite);
	};
	const answerOverwrite = (answer: OverwriteAnswer) => {
		overwriteRef.current?.resolve(answer);
		overwriteRef.current = undefined;
		setOverwrite(undefined);
	};
	const answerRename = (name: string) => {
		const pending = overwriteRef.current;
		if (pending?.kind !== "paste") return;
		pending.resolve({ choice: "rename", name });
		overwriteRef.current = undefined;
		setOverwrite(undefined);
	};
	const pickUpload = (dir: string, folder: boolean) => {
		uploadDir.current = dir;
		const input = folder ? folderInput.current : fileInput.current;
		if (!input) return;
		input.value = "";
		input.click();
	};
	const createItems = (dir: string): ContextMenuItem[] => [
		{
			label: "新建文件…",
			icon: <IconFilePlus size={14} />,
			disabled: !canCreate || connection !== "open",
			onSelect: () => setCreating({ dir, kind: "file" }),
		},
		{
			label: "新建文件夹…",
			icon: <IconFolderPlus size={14} />,
			disabled: !canCreate || connection !== "open",
			onSelect: () => setCreating({ dir, kind: "directory" }),
		},
	];
	const uploadItems = (dir: string): ContextMenuItem[] => [
		{
			label: dir ? "上传文件到此处…" : "上传文件…",
			icon: <IconUpload size={14} />,
			disabled: !canTransfer,
			onSelect: () => pickUpload(dir, false),
		},
		{
			label: dir ? "上传文件夹到此处…" : "上传文件夹…",
			icon: <IconFolderOpen size={14} />,
			disabled: !canTransfer,
			onSelect: () => pickUpload(dir, true),
		},
	];

	/** The directory a drop at `event` goes to: a folder row, a file's folder, or the root. */
	const dropTarget = (event: ReactDragEvent): string => {
		const row = (event.target as Element).closest?.("[data-drop-dir]");
		return row?.getAttribute("data-drop-dir") ?? "";
	};
	const endDrag = () => {
		dragged.current = undefined;
		setDragPaths(new Set());
		setDropDir(undefined);
	};
	const onEntryDragStart = (event: ReactDragEvent<HTMLButtonElement>, entry: WorkspaceFileEntry) => {
		clearTimeout(clickTimer.current);
		const entries = workspaceDragEntries(visibleEntries, selectedPaths, entry);
		if (!canMove || !entries.length) {
			event.preventDefault();
			return;
		}
		event.stopPropagation();
		if (!selectedPaths.has(entry.path)) {
			applySelection(selectByPointer(visiblePaths, selectedPaths, selectionAnchor, entry.path));
		}
		setMenu(undefined);
		dragged.current = { mode: "move", sourceWorkspaceId: workspace.id, entries };
		setDragPaths(new Set(entries.map((item) => item.path)));
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, workspace.id);
	};
	const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
		if ([...event.dataTransfer.types].includes(WORKSPACE_FILE_DRAG_TYPE)) {
			event.preventDefault();
			event.stopPropagation();
			const dir = dropTarget(event);
			const valid = canMove && dragged.current && workspaceDropEntries(dragged.current.entries, dir).length > 0;
			event.dataTransfer.dropEffect = valid ? "move" : "none";
			setDropDir(valid ? dir : undefined);
			return;
		}
		if (!canTransfer || !dragHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		const dir = dropTarget(event);
		if (dir !== dropDir) setDropDir(dir);
	};
	const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDir(undefined);
	};
	const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
		if ([...event.dataTransfer.types].includes(WORKSPACE_FILE_DRAG_TYPE)) {
			event.preventDefault();
			event.stopPropagation();
			const snapshot = dragged.current;
			const dir = dropTarget(event);
			endDrag();
			if (!canMove || !snapshot) return;
			const entries = workspaceDropEntries(snapshot.entries, dir);
			if (entries.length) void pasteWorkspaceEntries(store, { ...snapshot, entries }, workspace, dir, askPasteConflict);
			return;
		}
		setDropDir(undefined);
		if (!canTransfer || !dragHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		const dir = dropTarget(event);
		const list = dropEntries(event.dataTransfer);
		void list(dir).then(
			(items) => {
				if (items.length) upload(items);
				else store.toast("info", "没有可上传的文件（空文件夹不会上传）");
			},
			(error: unknown) =>
				store.toast("error", `读取拖入的文件失败：${error instanceof Error ? error.message : String(error)}`),
		);
	};

	const menuItems = (entry?: WorkspaceFileEntry): ContextMenuItem[] => {
		const reveal = store.canRevealPaths;
		const pasteItem = (dir: string): ContextMenuItem => ({
			label: dir ? "粘贴到此处" : "粘贴到工作区",
			icon: <IconPaste size={14} />,
			hint: /Mac/.test(platform) ? "⌘V" : "Ctrl+V",
			disabled: !canPaste,
			onSelect: () => paste(dir),
		});
		const copyItems = (entries: WorkspaceFileEntry[]): ContextMenuItem[] => [
			{
				label: entries.length > 1 ? `复制 ${deleteRoots(entries).length} 个项目` : "复制",
				icon: <IconCopy size={14} />,
				hint: /Mac/.test(platform) ? "⌘C" : "Ctrl+C",
				disabled: !canTransfer || pasteBusy || entries.some((e) => e.kind === "other"),
				onSelect: () => copyEntries(entries, "copy"),
			},
			{
				label: entries.length > 1 ? `剪切 ${deleteRoots(entries).length} 个项目` : "剪切",
				icon: <IconCut size={14} />,
				hint: /Mac/.test(platform) ? "⌘X" : "Ctrl+X",
				disabled: !canTransfer || pasteBusy || entries.some((e) => e.kind === "other"),
				onSelect: () => copyEntries(entries, "move"),
			},
		];
		if (!entry) {
			return [
				...createItems(""),
				"separator",
				{ label: "刷新", icon: <IconRefresh size={14} />, disabled: connection !== "open", onSelect: refresh },
				{ label: "全部折叠", icon: <IconChevronUp size={14} />, disabled: !expanded.size, onSelect: collapseAll },
				"separator",
				{ label: "复制工作区路径", icon: <IconCopy size={14} />, onSelect: () => copyText(workspace.path) },
				"separator",
				...uploadItems(""),
				pasteItem(""),
				"separator",
				canTerminal && {
					label: "在终端中打开",
					icon: <IconTerminal size={14} />,
					onSelect: () => terminals.create({ workspace, cwd: workspace.path }),
				},
				reveal && {
					label: revealLabel,
					icon: <IconExternal size={14} />,
					onSelect: () => store.revealPath(workspace.path),
				},
			];
		}
		const selectedEntries = selectedPaths.has(entry.path) ? visibleSelection() : [entry];
		if (selectedEntries.length > 1) {
			return [
				...copyItems(selectedEntries),
				"separator",
				{
					label: `复制 ${selectedEntries.length} 个相对路径`,
					icon: <IconCopy size={14} />,
					onSelect: () => copySelectedPaths(false),
				},
				{
					label: `复制 ${selectedEntries.length} 个绝对路径`,
					icon: <IconCopy size={14} />,
					onSelect: () => copySelectedPaths(true),
				},
				composerKey
					? {
							label: `插入 ${selectedEntries.length} 个路径到输入框`,
							icon: <IconMessagePlus size={14} />,
							onSelect: () => selectedEntries.forEach(insert),
						}
					: null,
				"separator",
				canDelete && {
					label: `删除 ${selectedEntries.length} 个项目…`,
					icon: <IconTrash size={14} />,
					danger: true,
					disabled: connection !== "open",
					onSelect: () => setDeleting(deleteRoots(selectedEntries)),
				},
			];
		}
		const isDir = entry.kind === "directory";
		const absolute = joinPath(workspace.path, entry.path);
		const open = isDir && expanded.has(entry.path);
		return [
			isDir
				? {
						label: open ? "折叠" : "展开",
						icon: open ? <IconFolder size={14} /> : <IconFolderOpen size={14} />,
						onSelect: () => toggle(entry.path),
					}
				: {
						label: "打开",
						icon: <IconFile size={14} />,
						disabled: entry.kind !== "file",
						onSelect: () => store.openFilePreview(workspace.id, entry.path, composerKey),
					},
			composerKey
				? { label: "插入路径到输入框", icon: <IconMessagePlus size={14} />, onSelect: () => insert(entry) }
				: null,
			"separator",
			...copyItems([entry]),
			pasteItem(isDir ? entry.path : parentPath(entry.path)),
			{
				label: "重命名…",
				icon: <IconPencil size={14} />,
				hint: "F2",
				disabled: !canMove || (entry.kind === "other" && !entry.symlink),
				onSelect: () => startRename(entry),
			},
			"separator",
			{ label: "复制相对路径", icon: <IconCopy size={14} />, onSelect: () => copyPath(entry) },
			{
				label: "复制绝对路径",
				icon: <IconCopy size={14} />,
				onSelect: () => copyText(absolute, entry.path),
			},
			{ label: "复制名称", icon: <IconCopy size={14} />, onSelect: () => copyText(entry.name, entry.path) },
			"separator",
			...(isDir
				? [...createItems(entry.path), "separator" as const, ...uploadItems(entry.path)]
				: [
						{
							label: "下载…",
							icon: <IconDownload size={14} />,
							disabled: !canTransfer || entry.kind !== "file",
							onSelect: () => void downloadFile(store, workspace, entry.path),
						},
					]),
			"separator",
			canTerminal && {
				label: isDir ? "在终端中打开" : "在所在目录打开终端",
				icon: <IconTerminal size={14} />,
				onSelect: () =>
					terminals.create({ workspace, cwd: isDir ? absolute : joinPath(workspace.path, parentPath(entry.path)) }),
			},
			reveal && { label: revealLabel, icon: <IconExternal size={14} />, onSelect: () => store.revealPath(absolute) },
			"separator",
			canDelete && {
				label: "删除…",
				icon: <IconTrash size={14} />,
				hint: /Mac/.test(platform) ? "⌘⌫" : "Delete",
				danger: true,
				disabled: connection !== "open",
				onSelect: () => setDeleting([entry]),
			},
		];
	};

	const renderDir = (path: string, depth: number) => {
		const dir = dirs[path];
		if (!dir || (!dir.entries && dir.loading)) {
			return (
				<div className="files-note" style={{ paddingLeft: 12 + depth * 14 }}>
					<IconLoader size={13} className="spin" />
					加载中…
				</div>
			);
		}
		if (dir.error && !dir.entries) {
			return (
				<div className="files-note error" style={{ paddingLeft: 12 + depth * 14 }}>
					<IconAlert size={13} />
					<span>{dir.error}</span>
				</div>
			);
		}
		const entries = dir.entries ?? [];
		if (!entries.length) {
			return (
				<div className="files-note" style={{ paddingLeft: 12 + depth * 14 + (depth ? 18 : 0) }}>
					{depth ? "空目录" : "工作区中还没有文件"}
				</div>
			);
		}
		return (
			<>
				{entries.map((entry) => {
					const isDir = entry.kind === "directory";
					const open = isDir && expanded.has(entry.path);
					const isSelected = selectedPaths.has(entry.path);
					return (
						<div key={entry.path}>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: the row's button is the focusable control; this only adds its context menu. */}
							<div
								className={`files-row${isSelected ? " selected" : ""}${menu?.entry?.path === entry.path ? " menu-open" : ""}${entry.kind === "other" ? " dim" : ""}${clipboard?.mode === "move" && clipboard.sourceWorkspaceId === workspace.id && clipboard.entries.some((item) => entry.path === item.path || entry.path.startsWith(`${item.path}/`)) ? " cut" : ""}${dragPaths.has(entry.path) ? " dragging" : ""}${isDir && dropDir === entry.path ? " drop-target" : ""}`}
								style={{ paddingLeft: 6 + depth * 14 }}
								data-drop-dir={isDir ? entry.path : parentPath(entry.path)}
								onContextMenu={(event) => {
									event.preventDefault();
									event.stopPropagation();
									clearTimeout(clickTimer.current);
									if (!selectedPaths.has(entry.path)) {
										applySelection(selectByPointer(visiblePaths, selectedPaths, selectionAnchor, entry.path));
									}
									focusEntry(entry.path);
									setMenu({ position: contextMenuPosition(event), entry });
								}}
							>
								<button
									type="button"
									role="treeitem"
									className="files-entry"
									ref={(button) => {
										if (button) entryRefs.current.set(entry.path, button);
										else entryRefs.current.delete(entry.path);
									}}
									data-entry-path={entry.path}
									aria-selected={isSelected}
									draggable={canMove && entry.kind !== "other"}
									onDragStart={(event) => onEntryDragStart(event, entry)}
									onDragEnd={endDrag}
									title={entryTitle(entry)}
									{...(isDir ? { "aria-expanded": open } : {})}
									onKeyDown={(event) => onEntryKeyDown(event, entry)}
									onClick={(event) => {
										clearTimeout(clickTimer.current);
										// WebKit on macOS does not focus buttons on pointer clicks.
										event.currentTarget.focus({ preventScroll: true });
										selectEntry(entry, event);
										if (event.shiftKey || event.metaKey || event.ctrlKey) return;
										if (isDir) {
											toggle(entry.path);
											return;
										}
										if (entry.kind !== "file" || event.detail > 1) return;
										// With a composer, wait briefly so a double click inserts the path instead.
										const open = () => store.openFilePreview(workspace.id, entry.path, composerKey);
										if (composerKey && event.detail === 1) clickTimer.current = setTimeout(open, 250);
										else open();
									}}
									onDoubleClick={(event) => {
										clearTimeout(clickTimer.current);
										if (event.shiftKey || event.metaKey || event.ctrlKey) return;
										if (!isDir) insert(entry);
									}}
								>
									<span className={`files-chevron${open ? " open" : ""}`}>
										{isDir ? <IconChevronRight size={12} /> : null}
									</span>
									<span className={`files-icon${isDir ? " dir" : ""}`}>
										{isDir ? open ? <IconFolderOpen size={14} /> : <IconFolder size={14} /> : <IconFile size={14} />}
									</span>
									<span className="files-name">{entry.name}</span>
									{entry.symlink ? <IconLink size={11} className="files-link" /> : null}
								</button>
								<span className="files-actions">
									{isDir && canTerminal ? (
										<button
											type="button"
											className="ghost icon"
											title="在终端中打开"
											onClick={() => terminals.create({ workspace, cwd: joinPath(workspace.path, entry.path) })}
										>
											<IconTerminal size={13} />
										</button>
									) : null}
									{composerKey ? (
										<button type="button" className="ghost icon" title="插入路径到输入框" onClick={() => insert(entry)}>
											<IconMessagePlus size={13} />
										</button>
									) : null}
									<button type="button" className="ghost icon" title="复制相对路径" onClick={() => copyPath(entry)}>
										<IconCopy size={13} />
									</button>
								</span>
								{copied === entry.path ? <span className="files-copied">已复制</span> : null}
							</div>
							{open ? renderDir(entry.path, depth + 1) : null}
						</div>
					);
				})}
				{dir.truncated ? (
					<div className="files-note" style={{ paddingLeft: 12 + depth * 14 + 18 }}>
						仅显示前 {entries.length} 项（共 {dir.total} 项）
					</div>
				) : null}
			</>
		);
	};

	const loading = Object.values(dirs).some((d) => d.loading);
	return (
		<aside className="files-panel" aria-label="工作区文件">
			<header className="files-header files-header-with-toolbar">
				<PanelHeading name={workspace.name} title={workspace.path} />
				<div className="files-toolbar">
					<button
						type="button"
						className="ghost icon"
						title={canCreate ? "新建文件" : "新建文件（请更新文件所在电脑的 Pier）"}
						disabled={!canCreate || connection !== "open"}
						onClick={() => setCreating({ dir: "", kind: "file" })}
					>
						<IconFilePlus size={14} />
					</button>
					<button
						type="button"
						className="ghost icon"
						title={canCreate ? "新建文件夹" : "新建文件夹（请更新文件所在电脑的 Pier）"}
						disabled={!canCreate || connection !== "open"}
						onClick={() => setCreating({ dir: "", kind: "directory" })}
					>
						<IconFolderPlus size={14} />
					</button>
					{clipboard ? (
						<button
							type="button"
							className="ghost icon"
							title={pasteBusy ? "正在粘贴…" : "粘贴到工作区（Ctrl/⌘+V）"}
							disabled={!canPaste}
							onClick={() => paste("")}
						>
							<IconPaste size={14} />
						</button>
					) : null}
					<button type="button" className="ghost icon" title="刷新" disabled={connection !== "open"} onClick={refresh}>
						<IconRefresh size={14} className={loading ? "spin" : undefined} />
					</button>
					<button type="button" className="ghost icon" title="全部折叠" disabled={!expanded.size} onClick={collapseAll}>
						<IconChevronUp size={14} />
					</button>
				</div>
			</header>
			<div
				className={`files-tree${dropDir === "" ? " drop-target" : ""}`}
				role="tree"
				aria-label="工作区文件列表"
				aria-multiselectable="true"
				tabIndex={0}
				onKeyDown={(event) => {
					if (
						event.target === event.currentTarget &&
						event.key === "F2" &&
						!event.ctrlKey &&
						!event.metaKey &&
						!event.altKey &&
						!event.shiftKey &&
						!event.nativeEvent.isComposing
					) {
						const selected = visibleSelection();
						if (selected.length === 1 && selected[0]) startRename(selected[0]);
						event.preventDefault();
						return;
					}
					if (
						(event.ctrlKey || event.metaKey) &&
						event.key.toLowerCase() === "v" &&
						!event.shiftKey &&
						!event.altKey &&
						!event.nativeEvent.isComposing
					) {
						event.preventDefault();
						event.stopPropagation();
						const selected = visibleSelection();
						const target = selected.find((entry) => entry.path === selectionAnchor) ?? selected.at(-1);
						paste(target ? (target.kind === "directory" ? target.path : parentPath(target.path)) : "");
						return;
					}
					if (event.key !== "Escape") return;
					clearTimeout(clickTimer.current);
					setSelectedPaths(new Set());
					setSelectionAnchor(undefined);
					clearWorkspaceClipboard();
				}}
				onClick={(event) => {
					if ((event.target as Element).closest(".files-row")) return;
					clearTimeout(clickTimer.current);
					event.currentTarget.focus({ preventScroll: true });
					setSelectedPaths(new Set());
					setSelectionAnchor(undefined);
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu({ position: contextMenuPosition(event) });
				}}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
			>
				{connection === "open" || dirs[""] ? renderDir("", 0) : <div className="files-note">正在连接 Pier Host…</div>}
			</div>
			<TransferList workspaceId={workspace.id} />
			<div
				className="files-hint"
				title={`拖动项目到文件夹移动，拖到空白处移回工作区根目录；Shift+单击范围选择，${/Mac/.test(platform) ? "⌘" : "Ctrl"}+单击增减选择；方向键导航，Shift+↑/↓ 扩展选择，←/→ 折叠/展开；Ctrl/⌘+A 全选，Ctrl/⌘+C 复制，Ctrl/⌘+X 剪切，Ctrl/⌘+V 粘贴到当前文件夹，F2 重命名，Ctrl/⌘+Shift+C 复制绝对路径，Delete / ⌘⌫ 删除，Esc 清除选择与文件剪贴板`}
			>
				{selectedPaths.size > 1
					? `已选择 ${selectedPaths.size} 项 · 右键批量操作`
					: canMove
						? `拖到文件夹移动 · ${composerKey ? "双击插入路径" : "单击查看"}`
						: composerKey
							? "单击查看，双击插入路径 · Shift 范围选择，Ctrl/⌘ 多选"
							: "单击查看 · Shift 范围选择，Ctrl/⌘ 多选 · 右键更多操作"}
			</div>
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				onChange={(e) => upload(uploadItemsFromInput(e.target.files, uploadDir.current))}
			/>
			<input
				ref={folderInput}
				type="file"
				hidden
				{...folderInputProps}
				onChange={(e) => upload(uploadItemsFromInput(e.target.files, uploadDir.current))}
			/>
			{menu ? (
				<ContextMenu
					position={menu.position}
					label={menu.entry ? menu.entry.name : workspace.name}
					items={menuItems(menu.entry)}
					onClose={() => setMenu(undefined)}
				/>
			) : null}
			{overwrite ? (
				<OverwriteDialog
					key={overwrite.id}
					question={overwrite.question}
					onAnswer={answerOverwrite}
					rename={overwrite.kind === "paste" ? { ...overwrite.question, onRename: answerRename } : undefined}
				/>
			) : null}
			{creating ? (
				<CreateDialog
					workspace={workspace}
					dir={creating.dir}
					kind={creating.kind}
					onClose={() => setCreating(undefined)}
					onCreated={(path) => {
						reveal(path, creating.kind === "directory");
						if (creating.kind === "file") store.openFilePreview(workspace.id, path, composerKey);
						setCreating(undefined);
					}}
				/>
			) : null}
			{renaming ? (
				<RenameDialog
					key={renaming.path}
					workspace={workspace}
					entry={renaming}
					onClose={() => setRenaming(undefined)}
					onRenamed={(path) => {
						renamed(renaming.path, path);
						setSelectedPaths(new Set([path]));
						setSelectionAnchor(path);
						setRenaming(undefined);
					}}
				/>
			) : null}
			{deleting ? (
				<DeleteDialog workspace={workspace} entries={deleting} onClose={() => setDeleting(undefined)} />
			) : null}
		</aside>
	);
}

/** Header button that shows or hides the file panel. */
export function FilesPanelToggle() {
	const store = useStore();
	const open = useAppState(isRightPanelOpen);
	return (
		<button
			type="button"
			className={`chip icon-chip${open ? " active" : ""}`}
			title={
				open
					? "隐藏右侧面板（Ctrl/⌘+Shift+E 文件，Ctrl/⌘+Shift+G 源代码管理）"
					: "显示工作区文件与源代码管理（Ctrl/⌘+Shift+E / G）"
			}
			aria-pressed={open}
			onClick={() => store.toggleFilesPanel()}
		>
			<IconPanelRight size={15} />
		</button>
	);
}
