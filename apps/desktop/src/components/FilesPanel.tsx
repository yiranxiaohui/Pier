import type { WorkspaceFileEntry, WorkspaceFilesResult, WorkspaceInfo } from "@pier/protocol";
import {
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
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
	childPath,
	downloadFile,
	dragHasFiles,
	dropEntries,
	hostTransferKey,
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
import {
	type FilesLocation,
	isWorkspaceRoot,
	locationBreadcrumbs,
	locationDirectory,
	locationForPath,
	locationKey,
	locationParent,
	panelPasteSource,
	WORKSPACE_ROOT,
} from "../lib/files-location.ts";
import { formatBytes, joinPath, relativeTime } from "../lib/format.ts";
import {
	clearHostClipboard,
	type FileScope,
	fileAbilities,
	isCutInDirectory,
	isHiddenEntry,
	pasteHostEntries,
	renameEntry,
	scopeAbsolute,
	scopeFiles,
	setHostClipboard,
	useHostClipboard,
	useHostPasteBusy,
} from "../lib/host-files.ts";
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
	completeWorkspaceMoves,
	setWorkspaceClipboard,
	useWorkspaceClipboard,
	useWorkspacePasteBusy,
	type WorkspaceClipboardEntry,
	type WorkspaceClipboardMode,
} from "../lib/workspace-clipboard.ts";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import { FilesPathBar, NEEDS_BROWSE_UPDATE } from "./FilesPathBar.tsx";
import { HostFileViewer } from "./HostFileViewer.tsx";
import {
	IconAlert,
	IconChevronRight,
	IconChevronUp,
	IconCopy,
	IconCut,
	IconDownload,
	IconExternal,
	IconEye,
	IconEyeOff,
	IconFile,
	IconFilePlus,
	IconFolder,
	IconFolderInput,
	IconFolderOpen,
	IconFolderPlus,
	IconLink,
	IconLoader,
	IconMessagePlus,
	IconMore,
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

/**
 * Expanded directories per tree, kept while the app runs so switching back restores the tree:
 * one per workspace (its folders share it), and one per directory outside the workspace.
 */
const expandedByTree = new Map<string, Set<string>>();
/** The folder each workspace's panel shows, kept while the app runs. */
const locationByWorkspace = new Map<string, FilesLocation>();
const SHOW_HIDDEN_KEY = "pier.filesPanel.showHidden";

const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
const isMac = /Mac/.test(platform);
const mod = isMac ? "⌘" : "Ctrl+";
const revealLabel = isMac ? "在访达中显示" : /Win/.test(platform) ? "在资源管理器中显示" : "在文件管理器中显示";
const needsHostUpdate = "请更新文件所在电脑的 Pier 以管理工作区以外的文件";

/** Dotfiles are shown unless hidden here (the workspace tree always showed them). */
function loadShowHidden(): boolean {
	try {
		return localStorage.getItem(SHOW_HIDDEN_KEY) !== "0";
	} catch {
		return true;
	}
}

/** The parent of a "/"-joined tree path (`""` at the top). */
function parentPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function errorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持文件列表，请更新 Pier";
	if (code === "BAD_REQUEST" && /Not a directory/.test(message)) return "这不是文件夹";
	if (code === "BAD_REQUEST" && /must be absolute/.test(message)) return "请输入绝对路径";
	if (code === "NOT_FOUND") return "目录不存在";
	if (code === "FORBIDDEN") return "无权访问该目录";
	return message;
}

/** Create an entry on the workspace's computer, without opening a local file picker. */
function CreateDialog({
	where,
	directory,
	kind,
	outside,
	create,
	onClose,
	onCreated,
}: {
	/** The computer the entry is created on. */
	where: string;
	/** The absolute directory it is created in. */
	directory: string;
	kind: "file" | "directory";
	/** The directory is outside the workspace. */
	outside: boolean;
	/** Create the typed name (or relative path); resolves with the new entry's tree path. */
	create: (name: string) => Promise<{ path: string }>;
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
	const submit = async () => {
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
			const result = await create(value);
			store.toast("info", `已创建${what}「${result.path}」`);
			onCreated(result.path);
		} catch (error) {
			const code = (error as { code?: string }).code;
			setError(
				code === "CONFLICT"
					? "已有同名文件或文件夹，请使用其他名称"
					: code === "FORBIDDEN"
						? outside
							? "没有权限在这里创建"
							: "没有权限创建，或目标目录位于工作区之外"
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
					void submit();
				}}
			>
				<p className="muted small">创建位置：{where}</p>
				<code className="path">{directory}</code>
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
	path,
	entry,
	outside,
	rename,
	onClose,
	onRenamed,
}: {
	/** The entry's absolute path. */
	path: string;
	entry: WorkspaceFileEntry;
	outside: boolean;
	/** Rename the entry; resolves with its new tree path. */
	rename: (name: string) => Promise<{ path: string }>;
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
	const submit = async () => {
		if (busy || name.trim() === entry.name) return;
		const invalid = workspaceNameError(name);
		if (invalid) {
			setError(invalid);
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const result = await rename(name);
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
							? outside
								? "没有权限重命名"
								: "没有权限重命名，或所在目录位于工作区之外"
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
					void submit();
				}}
			>
				<code className="path">{path}</code>
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
	entries,
	absolute,
	outside,
	remove,
	onGone,
	onClose,
}: {
	entries: WorkspaceFileEntry[];
	absolute: (path: string) => string;
	outside: boolean;
	remove: (entry: WorkspaceFileEntry) => Promise<unknown>;
	/** An entry was already gone: refresh the tree. */
	onGone: () => void;
	onClose: () => void;
}) {
	const store = useStore();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const completed = useRef(new Set<string>());
	const single = entries.length === 1 ? entries[0] : undefined;
	const isDir = single?.kind === "directory" && !single.symlink;
	const what = single ? (single.symlink ? "符号链接" : isDir ? "文件夹" : "文件") : "项目";
	const run = async () => {
		setBusy(true);
		setError(undefined);
		for (const entry of entries) {
			if (completed.current.has(entry.path)) continue;
			try {
				await remove(entry);
			} catch (e) {
				const code = (e as { code?: string }).code;
				if (code === "NOT_FOUND") onGone();
				else {
					const reason =
						code === "FORBIDDEN" ? (outside ? "没有权限删除" : "没有权限删除，或它位于工作区之外") : errorText(e);
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
						{absolute(entry.path)}
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
				<button type="button" className="danger" disabled={busy} onClick={() => void run()}>
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

/**
 * The directories of one tree rooted at `rootPath`: listings by path, and which are expanded.
 * Paths are "/"-joined and relative to the workspace root, or to the directory outside it.
 */
function useFileTree(treeKey: string, rootPath: string, list: (path: string) => Promise<WorkspaceFilesResult>) {
	const [dirs, setDirs] = useState<Record<string, DirState>>({});
	const [expanded, setExpanded] = useState<Set<string>>(() => expandedByTree.get(treeKey) ?? new Set());
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	/** Latest request per directory, so a slow old answer never overwrites a newer one. */
	const requests = useRef(new Map<string, number>());
	const seq = useRef(0);
	const underRoot = useCallback(
		(path: string) => path !== rootPath && (!rootPath || path.startsWith(`${rootPath}/`)),
		[rootPath],
	);

	const updateExpanded = useCallback(
		(fn: (set: Set<string>) => void) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				fn(next);
				expandedByTree.set(treeKey, next);
				return next;
			});
		},
		[treeKey],
	);

	const load = useCallback(
		async (path: string) => {
			const id = ++seq.current;
			requests.current.set(path, id);
			setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true } }));
			try {
				const result = await list(path);
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
				if (path !== rootPath && (error as { code?: string }).code === "NOT_FOUND") {
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
		[list, rootPath, updateExpanded],
	);

	const reload = useCallback(() => {
		void load(rootPath);
		for (const path of expandedRef.current) if (underRoot(path)) void load(path);
	}, [load, rootPath, underRoot]);

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

	const collapseAll = useCallback(
		() =>
			updateExpanded((set) => {
				for (const path of [...set]) if (underRoot(path)) set.delete(path);
			}),
		[underRoot, updateExpanded],
	);
	const reveal = useCallback(
		(path: string, directory: boolean) => {
			const parents: string[] = [];
			for (let parent = directory ? path : parentPath(path); underRoot(parent); parent = parentPath(parent)) {
				parents.push(parent);
			}
			updateExpanded((set) => {
				for (const parent of parents) set.add(parent);
			});
			void load(rootPath);
			for (const parent of parents) void load(parent);
		},
		[load, rootPath, underRoot, updateExpanded],
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
		void load(rootPath);
		for (const path of expandedRef.current) if (underRoot(remap(path))) void load(remap(path));
	};

	const hasExpanded = [...expanded].some(underRoot);
	return { dirs, expanded, hasExpanded, reload, toggle, collapseAll, reveal, renamed };
}

/** Flatten the entries currently visible in the expanded tree, in display order. */
function collectVisibleEntries(
	path: string,
	dirs: Record<string, DirState>,
	expanded: ReadonlySet<string>,
	showHidden: boolean,
	out: WorkspaceFileEntry[],
): void {
	for (const entry of dirs[path]?.entries ?? []) {
		if (!showHidden && isHiddenEntry(entry)) continue;
		out.push(entry);
		if (entry.kind === "directory" && expanded.has(entry.path))
			collectVisibleEntries(entry.path, dirs, expanded, showHidden, out);
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

function clipboardEntries(entries: WorkspaceFileEntry[]): WorkspaceClipboardEntry[] {
	return entries.map((entry) => ({
		path: entry.path,
		name: entry.name,
		kind: entry.kind === "directory" ? "directory" : "file",
		...(entry.symlink ? { symlink: true } : {}),
	}));
}

/**
 * The right-hand panel's file manager. It starts at the workspace root; the path bar goes up
 * (also above the workspace, on Hosts speaking protocol 1.57) or to any typed directory of the
 * workspace's computer.
 *
 * `composerKey` is the draft key of the composer on screen (a session id, or the new-chat
 * draft); without it the panel only offers copying paths.
 */
export function FilesPanel({ workspace, composerKey }: { workspace: WorkspaceInfo; composerKey?: string }) {
	const [view, setView] = useState<{ location: FilesLocation; select?: string; arrived?: boolean }>(() => ({
		location: locationByWorkspace.get(workspace.id) ?? WORKSPACE_ROOT,
	}));
	const navigate = useCallback(
		(location: FilesLocation, select?: string) => {
			locationByWorkspace.set(workspace.id, location);
			setView({ location, arrived: true, ...(select ? { select } : {}) });
		},
		[workspace.id],
	);
	return (
		<FilesView
			key={locationKey(view.location)}
			workspace={workspace}
			composerKey={composerKey}
			location={view.location}
			arrival={view.arrived ? { select: view.select } : undefined}
			navigate={navigate}
		/>
	);
}

/** One folder of the panel: its path bar, tools, tree, selection actions and transfers. */
function FilesView({
	workspace,
	composerKey,
	location,
	arrival,
	navigate,
}: {
	workspace: WorkspaceInfo;
	composerKey: string | undefined;
	location: FilesLocation;
	/** Set after navigating: focus the tree and select the folder named `select` (where the panel came from). */
	arrival: { select?: string | undefined } | undefined;
	navigate: (location: FilesLocation, select?: string) => void;
}) {
	const store = useStore();
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? s.node);
	const connection = useAppState((s) => s.nodes[node]?.connection);
	const hostInfo = useAppState((s) => s.nodes[node]?.hostInfo);
	const online = connection === "open";
	const hostKey = hostTransferKey(node);
	const hostDir = location.kind === "host" ? location.directory : undefined;
	const outside = hostDir !== undefined;
	const rootPath = location.kind === "workspace" ? location.dir : "";
	const rootAbsolute = locationDirectory(workspace.path, location);
	const hostAbilities = fileAbilities("host", hostInfo);
	/** Directories outside the workspace can be listed, uploaded to and downloaded from. */
	const canBrowseHost = online && hostAbilities.transfer;
	/** Files outside the workspace can be previewed, edited, created, renamed, copied, moved and deleted. */
	const manageHost = online && hostAbilities.manage;
	const scope = useMemo<FileScope>(
		() =>
			hostDir !== undefined
				? { kind: "host", node, directory: hostDir }
				: { kind: "workspace", node, workspace, dir: "" },
		[hostDir, node, workspace],
	);
	const absolute = (path: string) => scopeAbsolute(scope, path);
	const transferLocation = hostDir !== undefined ? { node, directory: hostDir } : workspace;
	// Terminals open on the workspace's computer (this one, or a paired one that runs them).
	const canTerminal = useCanOpenTerminal(workspace);
	const canDelete = outside ? hostAbilities.manage : hostCanDeleteFiles(hostInfo);
	const canCreate = outside ? hostAbilities.manage : hostCanCreateFiles(hostInfo);
	const canTransfer = online && (outside ? hostAbilities.transfer : hostTransfersFiles(hostInfo));
	const workspaceClipboard = useWorkspaceClipboard();
	const hostClipboard = useHostClipboard();
	const workspacePasteBusy = useWorkspacePasteBusy();
	const hostPasteBusy = useHostPasteBusy();
	const pasteBusy = workspacePasteBusy || hostPasteBusy;
	const pasteSource = panelPasteSource({
		location,
		node,
		manageHost,
		workspaceClipboard,
		hostClipboard,
		workspaceOf: (id) => {
			const state = store.getState();
			const owner = store.nodeOf(id);
			const info = state.nodes[owner]?.workspaces.find((item) => item.id === id);
			return info && { node: owner, path: info.path };
		},
	});
	const canPaste = canTransfer && Boolean(pasteSource) && !pasteBusy;
	const canCopy = (outside ? manageHost : canTransfer) && !pasteBusy;
	const canMove = (outside ? manageHost : canTransfer && hostTransfersWorkspacePaths(hostInfo)) && !pasteBusy;
	const dragged = useRef<WorkspaceClipboardEntry[]>(undefined);
	const [dragPaths, setDragPaths] = useState<ReadonlySet<string>>(() => new Set());
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const treeRef = useRef<HTMLDivElement>(null);
	/** Tree directory the next picked files go to. */
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
	/** A file outside the workspace open in the viewer. */
	const [viewing, setViewing] = useState<{ path: string; name: string }>();
	const [showHidden, setShowHidden] = useState(loadShowHidden);
	// Workspace changes (an agent run, an upload) and host file changes both refresh the tree.
	const version = useAppState((s) => (s.filesVersion[workspace.id] ?? 0) + (s.filesVersion[hostKey] ?? 0));
	const list = useCallback(
		async (path: string): Promise<WorkspaceFilesResult> => {
			if (hostDir === undefined) return store.listFiles(workspace.id, path);
			const client = store.nodeClient(node);
			if (!client) throw new Error("尚未连接到 Pier Host");
			const result = await client.request("host.files", { directory: joinPath(hostDir, path) });
			return {
				...result,
				path,
				entries: result.entries.map((entry) => ({ ...entry, path: childPath(path, entry.name) })),
			};
		},
		[store, workspace.id, node, hostDir],
	);
	const treeKey = hostDir === undefined ? workspace.id : `${workspace.id}\n${hostDir}`;
	const { dirs, expanded, hasExpanded, reload, toggle, collapseAll, reveal, renamed } = useFileTree(
		treeKey,
		rootPath,
		list,
	);
	const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
	const [selectionAnchor, setSelectionAnchor] = useState<string>();
	const [copied, setCopied] = useState<string>();
	/** Open menu: an entry's, the shown folder's (`entry` omitted), or the upload choices. */
	const [menu, setMenu] = useState<{ position: ContextMenuPosition; entry?: WorkspaceFileEntry; upload?: boolean }>();
	const lastReload = useRef(0);
	/** Pending single-click preview, cancelled when the click turns out to be a double click. */
	const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const entryRefs = useRef(new Map<string, HTMLButtonElement>());
	const visibleEntries = useMemo(() => {
		const entries: WorkspaceFileEntry[] = [];
		collectVisibleEntries(rootPath, dirs, expanded, showHidden, entries);
		return entries;
	}, [rootPath, dirs, expanded, showHidden]);
	const visiblePaths = useMemo(() => visibleEntries.map((entry) => entry.path), [visibleEntries]);
	const selectedEntries = useMemo(
		() => visibleEntries.filter((entry) => selectedPaths.has(entry.path)),
		[visibleEntries, selectedPaths],
	);
	const crumbs = useMemo(() => locationBreadcrumbs(workspace.path, location), [workspace.path, location]);
	const folderName = isWorkspaceRoot(location) ? workspace.name : (crumbs.at(-1)?.label ?? workspace.name);
	const parent = locationParent(workspace.path, location);
	const canGoUp = Boolean(parent) && (parent?.kind === "workspace" || canBrowseHost);
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
		if (!online) return;
		lastReload.current = Date.now();
		reload();
	}, [online, version, reload]);

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
	/** Workspace entries copy their workspace-relative path; entries outside it their absolute path. */
	const copyPath = (entry: WorkspaceFileEntry) => copyText(outside ? absolute(entry.path) : entry.path, entry.path);
	const insert = (entry: WorkspaceFileEntry) => {
		if (!composerKey) return;
		store.insertFileIntoComposer(composerKey, outside ? absolute(entry.path) : entry.path, entry.kind === "directory");
	};
	const refresh = () => {
		lastReload.current = Date.now();
		reload();
	};
	const applySelection = (update: SelectionUpdate) => {
		setSelectedPaths(update.selected);
		setSelectionAnchor(update.anchor);
	};
	const clearSelection = () => {
		setSelectedPaths(new Set());
		setSelectionAnchor(undefined);
	};
	const selectEntry = (entry: WorkspaceFileEntry, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
		applySelection(selectByPointer(visiblePaths, selectedPaths, selectionAnchor, entry.path, event));
	};
	const focusEntry = (path: string) => {
		const button = entryRefs.current.get(path);
		button?.focus({ preventScroll: true });
		button?.scrollIntoView({ block: "nearest" });
	};

	// After navigating, focus the tree and select the folder the panel came from.
	const arrived = useRef(arrival);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the shown folder is listed.
	useEffect(() => {
		const target = arrived.current;
		const root = dirs[rootPath];
		if (!target || !root || (!root.entries && !root.error)) return;
		arrived.current = undefined;
		const entry = target.select ? root.entries?.find((item) => item.name === target.select) : undefined;
		if (entry && (showHidden || !isHiddenEntry(entry))) {
			applySelection({ selected: new Set([entry.path]), anchor: entry.path });
			requestAnimationFrame(() => focusEntry(entry.path));
		} else treeRef.current?.focus({ preventScroll: true });
	}, [dirs, rootPath]);

	const goUp = () => {
		if (!parent || !canGoUp) return;
		navigate(parent, crumbs.at(-1)?.label);
	};
	const enter = (entry: WorkspaceFileEntry) => {
		if (entry.kind !== "directory") return;
		navigate(outside ? locationForPath(workspace.path, absolute(entry.path)) : { kind: "workspace", dir: entry.path });
	};
	const toggleHidden = () => {
		setShowHidden((value) => {
			try {
				localStorage.setItem(SHOW_HIDDEN_KEY, value ? "0" : "1");
			} catch {
				// Not persisted; the toggle still applies until the panel closes.
			}
			return !value;
		});
	};
	const hostClient = () => {
		const client = store.nodeClient(node);
		if (!client || !online) throw new Error("尚未连接到文件所在电脑的 Pier Host");
		return client;
	};
	const homeDirectory = async (): Promise<string> => {
		try {
			return (await hostClient().request("host.files", {})).directory;
		} catch (error) {
			throw new Error(errorText(error));
		}
	};

	const openFile = (entry: { path: string; name: string }) => {
		if (!outside) {
			store.openFilePreview(workspace.id, entry.path, composerKey);
			return;
		}
		if (manageHost) setViewing({ path: entry.path, name: entry.name });
		else if (canTransfer) void downloadFile(store, transferLocation, entry.path);
		else store.toast("error", needsHostUpdate);
	};
	const download = async (entries: WorkspaceFileEntry[]) => {
		for (const entry of entries) if (entry.kind === "file") await downloadFile(store, transferLocation, entry.path);
	};
	const startRename = (entry: WorkspaceFileEntry) => {
		if (!canMove || (entry.kind === "other" && !entry.symlink)) return;
		clearTimeout(clickTimer.current);
		setRenaming(entry);
	};
	const copySelectedPaths = (absolutePaths: boolean) => {
		const paths = selectedEntries.map((entry) => (absolutePaths || outside ? absolute(entry.path) : entry.path));
		copyText(paths.join("\n"), paths.length === 1 ? selectedEntries[0]?.path : undefined);
	};
	const copyEntries = (entries: WorkspaceFileEntry[], mode: WorkspaceClipboardMode) => {
		if (!canCopy) return;
		const roots = deleteRoots(entries);
		if (roots.some((entry) => entry.kind === "other" && !(outside && entry.symlink))) {
			store.toast("error", "请选择普通文件或文件夹");
			return;
		}
		// One clipboard at a time: the newer copy replaces the other kind.
		if (outside) {
			setHostClipboard(mode, scope, clipboardEntries(roots));
			clearWorkspaceClipboard();
		} else {
			setWorkspaceClipboard(mode, workspace.id, clipboardEntries(roots));
			clearHostClipboard();
		}
		store.toast("info", `已${mode === "move" ? "剪切" : "复制"} ${roots.length} 项，到目标文件夹粘贴（${mod}V）`);
	};
	/** Paste the clipboard into `dir` of the tree. */
	const paste = (dir: string) => {
		if (!canPaste || !pasteSource) return;
		if (pasteSource.kind === "workspace") {
			void pasteWorkspaceEntries(store, pasteSource.clipboard, workspace, dir, askPasteConflict);
			return;
		}
		let client: ReturnType<typeof hostClient>;
		try {
			client = hostClient();
		} catch (error) {
			store.toast("error", errorText(error));
			return;
		}
		const { clipboard: snapshot, fromWorkspace } = pasteSource;
		const destination: FileScope = { kind: "host", node, directory: absolute(dir) };
		void pasteHostEntries(store, client, snapshot, destination, askPasteConflict).then((completed) => {
			if (!outside) store.bumpFiles(workspace.id);
			if (!fromWorkspace) return;
			store.bumpFiles(fromWorkspace.sourceWorkspaceId);
			if (fromWorkspace.mode !== "move") return;
			for (const path of completed) store.closeMovedFilePreview(fromWorkspace.sourceWorkspaceId, path);
			completeWorkspaceMoves(fromWorkspace, completed);
		});
	};
	/** Move dragged tree entries into `dir`. */
	const moveInto = (entries: WorkspaceClipboardEntry[], dir: string) => {
		if (!outside) {
			void pasteWorkspaceEntries(
				store,
				{ mode: "move", sourceWorkspaceId: workspace.id, entries },
				workspace,
				dir,
				askPasteConflict,
			);
			return;
		}
		try {
			const destination: FileScope = { kind: "host", node, directory: absolute(dir) };
			void pasteHostEntries(store, hostClient(), { mode: "move", scope, entries }, destination, askPasteConflict);
		} catch (error) {
			store.toast("error", errorText(error));
		}
	};
	const isCut = (path: string) =>
		hostDir !== undefined
			? isCutInDirectory(hostClipboard, node, hostDir, path)
			: workspaceClipboard?.mode === "move" &&
				workspaceClipboard.sourceWorkspaceId === workspace.id &&
				workspaceClipboard.entries.some((item) => path === item.path || path.startsWith(`${item.path}/`));
	const openEntry = (entry: WorkspaceFileEntry) => {
		if (entry.kind === "directory") {
			toggle(entry.path);
			return;
		}
		if (entry.kind === "file") openFile(entry);
	};
	const onEntryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: WorkspaceFileEntry) => {
		if (event.nativeEvent.isComposing) return;
		const command = event.metaKey || event.ctrlKey;
		if (event.altKey) {
			if (event.key !== "ArrowUp" || command || event.shiftKey) return;
			goUp();
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const key = event.key.toLowerCase();
		const move = (path: string) => {
			applySelection(selectByKeyboard(visiblePaths, selectionAnchor ?? entry.path, path, event.shiftKey));
			focusEntry(path);
		};
		const targets = () => (selectedPaths.has(entry.path) ? selectedEntries : [entry]);
		if (command && key === "a" && !event.shiftKey) {
			setSelectedPaths(new Set(visiblePaths));
			setSelectionAnchor(entry.path);
		} else if (command && key === "c") {
			if (event.shiftKey) copySelectedPaths(true);
			else copyEntries(targets(), "copy");
		} else if (command && key === "x" && !event.shiftKey) {
			copyEntries(targets(), "move");
		} else if (command && key === "v" && !event.shiftKey) {
			paste(entry.kind === "directory" ? entry.path : parentPath(entry.path));
		} else if (!command && !event.shiftKey && event.key === "F2") {
			if (selectedPaths.has(entry.path) && selectedPaths.size > 1) return;
			startRename(entry);
		} else if (event.key === "Escape") {
			clearSelection();
			clearWorkspaceClipboard();
			clearHostClipboard();
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
					const child = visibleEntries[visiblePaths.indexOf(entry.path) + 1];
					if (child && parentPath(child.path) === entry.path) move(child.path);
				}
			}
		} else if (!command && event.key === "ArrowLeft") {
			if (entry.kind === "directory" && expanded.has(entry.path)) toggle(entry.path);
			else {
				const up = parentPath(entry.path);
				if (up !== rootPath && visiblePaths.includes(up)) move(up);
			}
		} else if (event.key === " " && !event.shiftKey) {
			if (!event.repeat) selectEntry(entry, { shiftKey: false, ctrlKey: true, metaKey: false });
		} else if (!command && event.key === "Enter") {
			openEntry(entry);
		} else if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
			if (!canDelete || !online) return;
			setDeleting(deleteRoots(targets()));
		} else if (!command && !event.shiftKey && event.key === "Backspace") {
			goUp();
		} else return;
		clearTimeout(clickTimer.current);
		event.preventDefault();
		event.stopPropagation();
	};

	const upload = (items: UploadItem[]) => {
		void uploadFiles(store, transferLocation, items, askOverwrite);
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
	const createTitle = (what: string) =>
		canCreate ? `新建${what}` : `新建${what}（${outside ? needsHostUpdate : "请更新文件所在电脑的 Pier"}）`;
	const createItems = (dir: string): ContextMenuItem[] => [
		{
			label: "新建文件…",
			icon: <IconFilePlus size={14} />,
			disabled: !canCreate || !online,
			onSelect: () => setCreating({ dir, kind: "file" }),
		},
		{
			label: "新建文件夹…",
			icon: <IconFolderPlus size={14} />,
			disabled: !canCreate || !online,
			onSelect: () => setCreating({ dir, kind: "directory" }),
		},
	];
	const uploadItems = (dir: string): ContextMenuItem[] => [
		{
			label: dir !== rootPath ? "上传文件到此处…" : "上传文件…",
			icon: <IconUpload size={14} />,
			disabled: !canTransfer,
			onSelect: () => pickUpload(dir, false),
		},
		{
			label: dir !== rootPath ? "上传文件夹到此处…" : "上传文件夹…",
			icon: <IconFolderOpen size={14} />,
			disabled: !canTransfer,
			onSelect: () => pickUpload(dir, true),
		},
	];
	const openMenuAt = (
		event: ReactMouseEvent<HTMLElement>,
		options: { entry?: WorkspaceFileEntry; upload?: boolean },
	) => {
		const rect = event.currentTarget.getBoundingClientRect();
		setMenu({ position: { x: rect.left, y: rect.bottom + 2, anchor: event.currentTarget }, ...options });
	};
	const openEntryMenu = (event: ReactMouseEvent<HTMLElement>, entry: WorkspaceFileEntry) => {
		clearTimeout(clickTimer.current);
		if (!selectedPaths.has(entry.path)) {
			applySelection(selectByPointer(visiblePaths, selectedPaths, selectionAnchor, entry.path));
		}
		openMenuAt(event, { entry });
	};

	/** The directory a drop at `event` goes to: a folder row, a file's folder, or the shown folder. */
	const dropTarget = (event: ReactDragEvent): string => {
		const row = (event.target as Element).closest?.("[data-drop-dir]");
		return row?.getAttribute("data-drop-dir") ?? rootPath;
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
		dragged.current = entries;
		setDragPaths(new Set(entries.map((item) => item.path)));
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, workspace.id);
	};
	const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
		if ([...event.dataTransfer.types].includes(WORKSPACE_FILE_DRAG_TYPE)) {
			event.preventDefault();
			event.stopPropagation();
			const dir = dropTarget(event);
			const valid = canMove && dragged.current && workspaceDropEntries(dragged.current, dir).length > 0;
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
			const entries = workspaceDropEntries(snapshot, dir);
			if (entries.length) moveInto(entries, dir);
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
		const canReveal = store.canRevealPaths;
		const pasteItem = (dir: string): ContextMenuItem => ({
			label: dir !== rootPath ? "粘贴到此处" : isWorkspaceRoot(location) ? "粘贴到工作区" : "粘贴到此文件夹",
			icon: <IconPaste size={14} />,
			hint: `${mod}V`,
			disabled: !canPaste,
			onSelect: () => paste(dir),
		});
		const copyItems = (entries: WorkspaceFileEntry[]): ContextMenuItem[] => {
			const special = entries.some((e) => e.kind === "other" && !(outside && e.symlink));
			const count = deleteRoots(entries).length;
			return [
				{
					label: entries.length > 1 ? `复制 ${count} 个项目` : "复制",
					icon: <IconCopy size={14} />,
					hint: `${mod}C`,
					disabled: !canCopy || special,
					onSelect: () => copyEntries(entries, "copy"),
				},
				{
					label: entries.length > 1 ? `剪切 ${count} 个项目` : "剪切",
					icon: <IconCut size={14} />,
					hint: `${mod}X`,
					disabled: !canCopy || special,
					onSelect: () => copyEntries(entries, "move"),
				},
			];
		};
		if (!entry) {
			return [
				...createItems(rootPath),
				"separator",
				...uploadItems(rootPath),
				pasteItem(rootPath),
				"separator",
				{ label: "刷新", icon: <IconRefresh size={14} />, disabled: !online, onSelect: refresh },
				{ label: "全部折叠", icon: <IconChevronUp size={14} />, disabled: !hasExpanded, onSelect: collapseAll },
				{
					label: showHidden ? "不显示隐藏文件" : "显示隐藏文件",
					icon: showHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />,
					onSelect: toggleHidden,
				},
				"separator",
				{
					label: isWorkspaceRoot(location) ? "复制工作区路径" : "复制当前路径",
					icon: <IconCopy size={14} />,
					onSelect: () => copyText(rootAbsolute),
				},
				"separator",
				canTerminal && {
					label: "在终端中打开",
					icon: <IconTerminal size={14} />,
					onSelect: () => terminals.create({ workspace, cwd: rootAbsolute }),
				},
				canReveal && {
					label: revealLabel,
					icon: <IconExternal size={14} />,
					onSelect: () => store.revealPath(rootAbsolute),
				},
			];
		}
		const targets = selectedPaths.has(entry.path) ? selectedEntries : [entry];
		if (targets.length > 1) {
			const files = targets.filter((item) => item.kind === "file");
			return [
				...copyItems(targets),
				{
					label: `下载 ${files.length} 个文件`,
					icon: <IconDownload size={14} />,
					disabled: !canTransfer || !files.length,
					onSelect: () => void download(files),
				},
				"separator",
				outside
					? {
							label: `复制 ${targets.length} 个路径`,
							icon: <IconCopy size={14} />,
							onSelect: () => copySelectedPaths(true),
						}
					: {
							label: `复制 ${targets.length} 个相对路径`,
							icon: <IconCopy size={14} />,
							onSelect: () => copySelectedPaths(false),
						},
				!outside && {
					label: `复制 ${targets.length} 个绝对路径`,
					icon: <IconCopy size={14} />,
					onSelect: () => copySelectedPaths(true),
				},
				composerKey
					? {
							label: `插入 ${targets.length} 个路径到输入框`,
							icon: <IconMessagePlus size={14} />,
							onSelect: () => targets.forEach(insert),
						}
					: null,
				"separator",
				canDelete && {
					label: `删除 ${targets.length} 个项目…`,
					icon: <IconTrash size={14} />,
					danger: true,
					disabled: !online,
					onSelect: () => setDeleting(deleteRoots(targets)),
				},
			];
		}
		const isDir = entry.kind === "directory";
		const entryAbsolute = absolute(entry.path);
		const open = isDir && expanded.has(entry.path);
		return [
			isDir
				? {
						label: open ? "折叠" : "展开",
						icon: open ? <IconFolder size={14} /> : <IconFolderOpen size={14} />,
						onSelect: () => toggle(entry.path),
					}
				: {
						label: outside && manageHost ? "查看 / 编辑" : "打开",
						icon: <IconFile size={14} />,
						disabled: entry.kind !== "file",
						onSelect: () => openFile(entry),
					},
			isDir && { label: "进入此文件夹", icon: <IconFolderInput size={14} />, onSelect: () => enter(entry) },
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
			outside
				? { label: "复制路径", icon: <IconCopy size={14} />, onSelect: () => copyText(entryAbsolute, entry.path) }
				: { label: "复制相对路径", icon: <IconCopy size={14} />, onSelect: () => copyPath(entry) },
			!outside && {
				label: "复制绝对路径",
				icon: <IconCopy size={14} />,
				onSelect: () => copyText(entryAbsolute, entry.path),
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
							onSelect: () => void downloadFile(store, transferLocation, entry.path),
						},
					]),
			"separator",
			canTerminal && {
				label: isDir ? "在终端中打开" : "在所在目录打开终端",
				icon: <IconTerminal size={14} />,
				onSelect: () => terminals.create({ workspace, cwd: isDir ? entryAbsolute : absolute(parentPath(entry.path)) }),
			},
			canReveal && {
				label: revealLabel,
				icon: <IconExternal size={14} />,
				onSelect: () => store.revealPath(entryAbsolute),
			},
			"separator",
			canDelete && {
				label: "删除…",
				icon: <IconTrash size={14} />,
				hint: isMac ? "⌘⌫" : "Delete",
				danger: true,
				disabled: !online,
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
		const all = dir.entries ?? [];
		const entries = showHidden ? all : all.filter((entry) => !isHiddenEntry(entry));
		if (!entries.length) {
			const hidden = all.length - entries.length;
			return (
				<div className="files-note" style={{ paddingLeft: 12 + depth * 14 + (depth ? 18 : 0) }}>
					{hidden
						? `只有 ${hidden} 个隐藏项目`
						: depth
							? "空目录"
							: isWorkspaceRoot(location)
								? "工作区中还没有文件"
								: "此文件夹为空"}
				</div>
			);
		}
		return (
			<>
				{entries.map((entry) => {
					const isDir = entry.kind === "directory";
					const open = isDir && expanded.has(entry.path);
					const isSelected = selectedPaths.has(entry.path);
					const classes = [
						"files-row",
						isSelected && "selected",
						menu?.entry?.path === entry.path && "menu-open",
						entry.kind === "other" && "dim",
						isCut(entry.path) && "cut",
						dragPaths.has(entry.path) && "dragging",
						isDir && dropDir === entry.path && "drop-target",
					]
						.filter(Boolean)
						.join(" ");
					return (
						<div key={entry.path}>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: the row's button is the focusable control; this only adds its context menu. */}
							<div
								className={classes}
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
									title={entryTitle(entry, outside ? absolute(entry.path) : entry.path)}
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
										if (composerKey && event.detail === 1) clickTimer.current = setTimeout(() => openFile(entry), 250);
										else openFile(entry);
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
								{copied === entry.path ? <span className="files-copied">已复制</span> : null}
								<span className="files-actions">
									{isDir ? (
										<button type="button" className="ghost icon" title="进入此文件夹" onClick={() => enter(entry)}>
											<IconFolderInput size={13} />
										</button>
									) : null}
									{isDir && canTerminal ? (
										<button
											type="button"
											className="ghost icon"
											title="在终端中打开"
											onClick={() => terminals.create({ workspace, cwd: absolute(entry.path) })}
										>
											<IconTerminal size={13} />
										</button>
									) : null}
									{composerKey ? (
										<button type="button" className="ghost icon" title="插入路径到输入框" onClick={() => insert(entry)}>
											<IconMessagePlus size={13} />
										</button>
									) : null}
									<button
										type="button"
										className="ghost icon"
										title={outside ? "复制路径" : "复制相对路径"}
										onClick={() => copyPath(entry)}
									>
										<IconCopy size={13} />
									</button>
									<button
										type="button"
										className="ghost icon"
										title="更多操作"
										aria-haspopup="menu"
										onClick={(event) => openEntryMenu(event, entry)}
									>
										<IconMore size={13} />
									</button>
								</span>
							</div>
							{open ? renderDir(entry.path, depth + 1) : null}
						</div>
					);
				})}
				{dir.truncated ? (
					<div className="files-note" style={{ paddingLeft: 12 + depth * 14 + 18 }}>
						仅显示前 {all.length} 项（共 {dir.total} 项）
					</div>
				) : null}
			</>
		);
	};

	const loading = Object.values(dirs).some((d) => d.loading);
	const selectedFiles = selectedEntries.filter((entry) => entry.kind === "file");
	const single = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
	const selectedSpecial = selectedEntries.some((e) => e.kind === "other" && !(outside && e.symlink));
	return (
		<aside className="files-panel" aria-label="工作区文件">
			<header className="files-header files-header-with-toolbar">
				<PanelHeading name={workspace.name} title={workspace.path} />
				<div className="files-toolbar">
					<button
						type="button"
						className="ghost icon"
						title={createTitle("文件")}
						disabled={!canCreate || !online}
						onClick={() => setCreating({ dir: rootPath, kind: "file" })}
					>
						<IconFilePlus size={14} />
					</button>
					<button
						type="button"
						className="ghost icon"
						title={createTitle("文件夹")}
						disabled={!canCreate || !online}
						onClick={() => setCreating({ dir: rootPath, kind: "directory" })}
					>
						<IconFolderPlus size={14} />
					</button>
					<button
						type="button"
						className="ghost icon"
						title={canTransfer ? "上传文件或文件夹到当前文件夹" : "上传（请更新文件所在电脑的 Pier）"}
						aria-haspopup="menu"
						disabled={!canTransfer}
						onClick={(event) => openMenuAt(event, { upload: true })}
					>
						<IconUpload size={14} />
					</button>
					{pasteSource ? (
						<button
							type="button"
							className="ghost icon"
							title={pasteBusy ? "正在粘贴…" : `粘贴到当前文件夹（${mod}V）`}
							disabled={!canPaste}
							onClick={() => paste(rootPath)}
						>
							<IconPaste size={14} />
						</button>
					) : null}
					<button type="button" className="ghost icon" title="刷新" disabled={!online} onClick={refresh}>
						<IconRefresh size={14} className={loading ? "spin" : undefined} />
					</button>
					<button type="button" className="ghost icon" title="全部折叠" disabled={!hasExpanded} onClick={collapseAll}>
						<IconChevronUp size={14} />
					</button>
					<button
						type="button"
						className="ghost icon"
						title="更多操作"
						aria-haspopup="menu"
						onClick={(event) => openMenuAt(event, {})}
					>
						<IconMore size={14} />
					</button>
				</div>
			</header>
			<FilesPathBar
				workspace={workspace}
				location={location}
				crumbs={crumbs}
				canBrowseHost={canBrowseHost}
				disabled={!online}
				onUp={canGoUp ? goUp : undefined}
				upTitle={
					!parent
						? "已在根目录"
						: canGoUp
							? `上一级（Alt+↑ / Backspace）：${locationDirectory(workspace.path, parent)}`
							: NEEDS_BROWSE_UPDATE
				}
				navigate={navigate}
				home={homeDirectory}
			/>
			<div
				ref={treeRef}
				className={`files-tree${dropDir === rootPath ? " drop-target" : ""}`}
				role="tree"
				aria-label={`${folderName} 中的文件`}
				aria-multiselectable="true"
				tabIndex={0}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return;
					const command = event.ctrlKey || event.metaKey;
					// Keys of the tree itself; rows handle their own.
					const self = event.target === event.currentTarget;
					if (
						self &&
						((event.altKey && event.key === "ArrowUp" && !command && !event.shiftKey) ||
							(event.key === "Backspace" && !event.altKey && !command && !event.shiftKey))
					) {
						event.preventDefault();
						goUp();
						return;
					}
					if (self && event.key === "F2" && !command && !event.altKey && !event.shiftKey) {
						if (selectedEntries.length === 1 && selectedEntries[0]) startRename(selectedEntries[0]);
						event.preventDefault();
						return;
					}
					if (command && event.key.toLowerCase() === "v" && !event.shiftKey && !event.altKey) {
						event.preventDefault();
						event.stopPropagation();
						const target = selectedEntries.find((entry) => entry.path === selectionAnchor) ?? selectedEntries.at(-1);
						paste(target ? (target.kind === "directory" ? target.path : parentPath(target.path)) : rootPath);
						return;
					}
					if (event.key !== "Escape") return;
					clearTimeout(clickTimer.current);
					clearSelection();
					clearWorkspaceClipboard();
					clearHostClipboard();
				}}
				onClick={(event) => {
					if ((event.target as Element).closest(".files-row")) return;
					clearTimeout(clickTimer.current);
					event.currentTarget.focus({ preventScroll: true });
					clearSelection();
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu({ position: contextMenuPosition(event) });
				}}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
			>
				{online || dirs[rootPath] ? renderDir(rootPath, 0) : <div className="files-note">正在连接 Pier Host…</div>}
			</div>
			<TransferList workspaceId={workspace.id} />
			<TransferList workspaceId={hostKey} />
			{selectedEntries.length ? (
				<div className="files-selection" role="toolbar" aria-label="选中项目的操作">
					<span className="files-selection-count" title={selectedEntries.map((entry) => entry.name).join("\n")}>
						{single ? single.name : `已选择 ${selectedEntries.length} 项`}
					</span>
					<button
						type="button"
						className="ghost icon"
						title={`复制（${mod}C），再到目标文件夹粘贴`}
						disabled={!canCopy || selectedSpecial}
						onClick={() => copyEntries(selectedEntries, "copy")}
					>
						<IconCopy size={13} />
					</button>
					<button
						type="button"
						className="ghost icon"
						title={`剪切（${mod}X），再到目标文件夹粘贴即可移动`}
						disabled={!canCopy || selectedSpecial}
						onClick={() => copyEntries(selectedEntries, "move")}
					>
						<IconCut size={13} />
					</button>
					{single ? (
						<button
							type="button"
							className="ghost icon"
							title="重命名（F2）"
							disabled={!canMove || (single.kind === "other" && !single.symlink)}
							onClick={() => startRename(single)}
						>
							<IconPencil size={13} />
						</button>
					) : null}
					<button
						type="button"
						className="ghost icon"
						title={selectedFiles.length > 1 ? `下载 ${selectedFiles.length} 个文件` : "下载"}
						disabled={!canTransfer || !selectedFiles.length}
						onClick={() => void download(selectedFiles)}
					>
						<IconDownload size={13} />
					</button>
					{canDelete ? (
						<button
							type="button"
							className="ghost icon files-selection-delete"
							title={`删除（${isMac ? "⌘⌫" : "Delete"}）`}
							disabled={!online}
							onClick={() => setDeleting(deleteRoots(selectedEntries))}
						>
							<IconTrash size={13} />
						</button>
					) : null}
					<button type="button" className="ghost icon" title="取消选择（Esc）" onClick={clearSelection}>
						<IconX size={13} />
					</button>
				</div>
			) : (
				<div
					className="files-hint"
					title={`拖动项目到文件夹移动，拖到空白处移到当前文件夹；Shift+单击范围选择，${isMac ? "⌘" : "Ctrl"}+单击增减选择；方向键导航，Shift+↑/↓ 扩展选择，←/→ 折叠/展开；Alt+↑ 或 Backspace 返回上一级；Ctrl/⌘+A 全选，Ctrl/⌘+C 复制，Ctrl/⌘+X 剪切，Ctrl/⌘+V 粘贴到当前文件夹，F2 重命名，Ctrl/⌘+Shift+C 复制绝对路径，Delete / ⌘⌫ 删除，Esc 清除选择与文件剪贴板`}
				>
					{canMove
						? `拖到文件夹移动 · ${composerKey ? "双击插入路径" : "单击查看"} · 右键更多操作`
						: composerKey
							? "单击查看，双击插入路径 · Shift 范围选择，Ctrl/⌘ 多选"
							: "单击查看 · Shift 范围选择，Ctrl/⌘ 多选 · 右键更多操作"}
				</div>
			)}
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
					label={menu.entry ? menu.entry.name : folderName}
					items={menu.upload ? uploadItems(rootPath) : menuItems(menu.entry)}
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
					where={store.nodeName(node)}
					directory={absolute(creating.dir)}
					kind={creating.kind}
					outside={outside}
					create={async (name) => {
						const path = childPath(creating.dir, name);
						if (!outside) {
							return creating.kind === "file"
								? store.createFile(workspace.id, path)
								: store.createDirectory(workspace.id, path);
						}
						const files = scopeFiles(hostClient(), scope);
						const result = creating.kind === "file" ? await files.createFile(path) : await files.createDirectory(path);
						store.bumpFiles(hostKey);
						return result;
					}}
					onClose={() => setCreating(undefined)}
					onCreated={(path) => {
						reveal(path, creating.kind === "directory");
						if (creating.kind === "file") openFile({ path, name: path.slice(path.lastIndexOf("/") + 1) });
						setCreating(undefined);
					}}
				/>
			) : null}
			{renaming ? (
				<RenameDialog
					key={renaming.path}
					path={absolute(renaming.path)}
					entry={renaming}
					outside={outside}
					rename={async (name) => {
						if (!outside) return store.renamePath(workspace.id, renaming.path, name);
						const result = await renameEntry(hostClient(), scope, renaming, name);
						store.bumpFiles(hostKey);
						return result;
					}}
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
				<DeleteDialog
					entries={deleting}
					absolute={absolute}
					outside={outside}
					remove={async (entry) => {
						if (!outside) return store.deletePath(workspace.id, entry.path);
						const result = await scopeFiles(hostClient(), scope).deletePath(entry.path);
						store.bumpFiles(hostKey);
						return result;
					}}
					onGone={() => store.bumpFiles(outside ? hostKey : workspace.id)}
					onClose={() => setDeleting(undefined)}
				/>
			) : null}
			{viewing ? (
				<HostFileViewer
					client={store.nodeClient(node)}
					scope={scope}
					path={viewing.path}
					name={viewing.name}
					editable={manageHost}
					onClose={() => setViewing(undefined)}
					onSaved={() => store.bumpFiles(hostKey)}
					onDownload={canTransfer ? () => void downloadFile(store, transferLocation, viewing.path) : undefined}
				/>
			) : null}
		</aside>
	);
}

function entryTitle(entry: WorkspaceFileEntry, path: string): string {
	const parts = [path];
	if (entry.kind === "file" && entry.size !== undefined) parts.push(formatBytes(entry.size));
	if (entry.modifiedAt) parts.push(`修改于 ${relativeTime(entry.modifiedAt)}`);
	if (entry.symlink) parts.push("符号链接");
	return parts.join(" · ");
}

/** Header button that shows or hides the right-hand panel (its launcher when no view is open). */
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
					: "显示右侧面板，打开文件、源代码管理等（Ctrl/⌘+Shift+E / G）"
			}
			aria-pressed={open}
			onClick={() => store.toggleFilesPanel()}
		>
			<IconPanelRight size={15} />
		</button>
	);
}
