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
import { type SelectionUpdate, selectByKeyboard, selectByPointer } from "../lib/file-selection.ts";
import {
	downloadFile,
	dragHasFiles,
	dropEntries,
	type OverwriteAnswer,
	type OverwriteQuestion,
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
import { hostCanDeleteFiles, hostTransfersFiles, useAppState, useStore } from "../lib/store.tsx";
import { terminals } from "../lib/terminals.ts";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import {
	IconAlert,
	IconChevronRight,
	IconChevronUp,
	IconCopy,
	IconDownload,
	IconExternal,
	IconFile,
	IconFolder,
	IconFolderOpen,
	IconLink,
	IconLoader,
	IconMessagePlus,
	IconPanelRight,
	IconRefresh,
	IconTerminal,
	IconTrash,
	IconUpload,
	IconX,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { PanelHeading, ResizeHandle } from "./PanelChrome.tsx";

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

/** Asks whether an upload may replace an existing file. */
function OverwriteDialog({
	question,
	onAnswer,
}: {
	question: OverwriteQuestion;
	onAnswer: (answer: OverwriteAnswer) => void;
}) {
	const [all, setAll] = useState(false);
	return (
		<Modal title="文件已存在" onClose={() => onAnswer({ choice: "cancel" })}>
			<p>工作区中已经有同名文件，要用上传的文件替换它吗？</p>
			<code className="path">{question.path}</code>
			{question.more ? (
				<label className="files-overwrite-all muted small">
					<input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
					对其余同名文件执行相同操作
				</label>
			) : null}
			<div className="modal-actions">
				<button type="button" className="ghost" onClick={() => onAnswer({ choice: "cancel" })}>
					{question.more ? "取消其余上传" : "取消"}
				</button>
				{/* biome-ignore lint/a11y/noAutofocus: focus the safe choice so Enter does not replace. */}
				<button type="button" autoFocus onClick={() => onAnswer({ choice: "skip", all })}>
					跳过
				</button>
				<button type="button" className="danger" onClick={() => onAnswer({ choice: "overwrite", all })}>
					替换
				</button>
			</div>
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
			return t.kind === "upload" ? "已上传" : "已下载";
		case "cancelled":
			return "已取消";
		case "skipped":
			return "已跳过";
		case "error":
			return t.error ?? "失败";
	}
}

/** Uploads and downloads of one workspace, with progress. */
function TransferList({ workspaceId }: { workspaceId: string }) {
	const items = useTransfers(workspaceId);
	if (!items.length) return null;
	const finished = items.filter(transferFinished).length;
	return (
		<section className="files-transfers" aria-label="上传与下载">
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
							{t.kind === "upload" ? <IconUpload size={13} /> : <IconDownload size={13} />}
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

	return { dirs, expanded, reload, toggle, collapseAll };
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
	const connection = useAppState((s) => s.connection);
	// Terminals open on the workspace's computer (this one, or a paired one that runs them).
	const canTerminal = useCanOpenTerminal(workspace);
	const canDelete = useAppState((s) => hostCanDeleteFiles(s.hostInfo));
	const canTransfer = useAppState(
		(s) =>
			s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.connection === "open" &&
			hostTransfersFiles(s.nodes[s.workspaceNodes[workspace.id] ?? s.node]?.hostInfo),
	);
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	/** Workspace directory the next picked files go to. */
	const uploadDir = useRef("");
	/** Directory highlighted while files are dragged over the tree. */
	const [dropDir, setDropDir] = useState<string>();
	const [overwrite, setOverwrite] = useState<{
		question: OverwriteQuestion;
		resolve: (answer: OverwriteAnswer) => void;
	}>();
	/** Entries awaiting delete confirmation. */
	const [deleting, setDeleting] = useState<WorkspaceFileEntry[]>();
	const version = useAppState((s) => s.filesVersion[workspace.id] ?? 0);
	const { dirs, expanded, reload, toggle, collapseAll } = useWorkspaceTree(workspace.id);
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
	const copySelectedPaths = (absolute: boolean) => {
		const paths = visibleSelection().map((entry) => (absolute ? joinPath(workspace.path, entry.path) : entry.path));
		copyText(paths.join("\n"), paths.length === 1 ? paths[0] : undefined);
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
			if (selectedPaths.size) copySelectedPaths(event.shiftKey);
		} else if (event.key === "Escape") {
			setSelectedPaths(new Set());
			setSelectionAnchor(undefined);
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
		void uploadFiles(
			store,
			workspace,
			items,
			(question) => new Promise((resolve) => setOverwrite({ question, resolve })),
		);
	};
	const answerOverwrite = (answer: OverwriteAnswer) => {
		overwrite?.resolve(answer);
		setOverwrite(undefined);
	};
	// A question left open when the panel closes cancels the rest of its uploads.
	const overwriteRef = useRef(overwrite);
	overwriteRef.current = overwrite;
	useEffect(() => () => overwriteRef.current?.resolve({ choice: "cancel" }), []);
	const pickUpload = (dir: string, folder: boolean) => {
		uploadDir.current = dir;
		const input = folder ? folderInput.current : fileInput.current;
		if (!input) return;
		input.value = "";
		input.click();
	};
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
	const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
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
		if (!entry) {
			return [
				{ label: "刷新", icon: <IconRefresh size={14} />, disabled: connection !== "open", onSelect: refresh },
				{ label: "全部折叠", icon: <IconChevronUp size={14} />, disabled: !expanded.size, onSelect: collapseAll },
				"separator",
				{ label: "复制工作区路径", icon: <IconCopy size={14} />, onSelect: () => copyText(workspace.path) },
				"separator",
				...uploadItems(""),
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
			{ label: "复制相对路径", icon: <IconCopy size={14} />, onSelect: () => copyPath(entry) },
			{
				label: "复制绝对路径",
				icon: <IconCopy size={14} />,
				onSelect: () => copyText(absolute, entry.path),
			},
			{ label: "复制名称", icon: <IconCopy size={14} />, onSelect: () => copyText(entry.name, entry.path) },
			"separator",
			...(isDir
				? uploadItems(entry.path)
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
								className={`files-row${isSelected ? " selected" : ""}${menu?.entry?.path === entry.path ? " menu-open" : ""}${entry.kind === "other" ? " dim" : ""}${isDir && dropDir === entry.path ? " drop-target" : ""}`}
								style={{ paddingLeft: 6 + depth * 14 }}
								data-drop-dir={isDir ? entry.path : parentPath(entry.path)}
								onContextMenu={(event) => {
									event.preventDefault();
									event.stopPropagation();
									clearTimeout(clickTimer.current);
									if (!selectedPaths.has(entry.path)) {
										applySelection(selectByPointer(visiblePaths, selectedPaths, selectionAnchor, entry.path));
									}
									setMenu({ position: contextMenuPosition(event), entry });
								}}
							>
								<button
									type="button"
									className="files-entry"
									ref={(button) => {
										if (button) entryRefs.current.set(entry.path, button);
										else entryRefs.current.delete(entry.path);
									}}
									data-entry-path={entry.path}
									aria-pressed={isSelected}
									title={entryTitle(entry)}
									{...(isDir ? { "aria-expanded": open } : {})}
									onKeyDown={(event) => onEntryKeyDown(event, entry)}
									onClick={(event) => {
										clearTimeout(clickTimer.current);
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
			<ResizeHandle />
			<header className="files-header">
				<PanelHeading workspaceId={workspace.id} name={workspace.name} title={workspace.path} />
				<button type="button" className="ghost icon" title="刷新" disabled={connection !== "open"} onClick={refresh}>
					<IconRefresh size={14} className={loading ? "spin" : undefined} />
				</button>
				<button type="button" className="ghost icon" title="全部折叠" disabled={!expanded.size} onClick={collapseAll}>
					<IconChevronUp size={14} />
				</button>
				<button type="button" className="ghost icon" title="关闭面板" onClick={() => store.toggleFilesPanel(false)}>
					<IconX size={14} />
				</button>
			</header>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: context menu for the blank area; every action is also in the header. */}
			<div
				className={`files-tree${dropDir === "" ? " drop-target" : ""}`}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					clearTimeout(clickTimer.current);
					setSelectedPaths(new Set());
					setSelectionAnchor(undefined);
				}}
				onClick={(event) => {
					if ((event.target as Element).closest(".files-row")) return;
					clearTimeout(clickTimer.current);
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
				title={`Shift+单击范围选择，${/Mac/.test(platform) ? "⌘" : "Ctrl"}+单击增减选择；方向键导航，Shift+↑/↓ 扩展选择，←/→ 折叠/展开；空格增减选择，Ctrl/⌘+A 全选可见项目，Ctrl/⌘+C 复制相对路径，Ctrl/⌘+Shift+C 复制绝对路径，Delete / ⌘⌫ 删除，Esc 清除选择`}
			>
				{selectedPaths.size > 1
					? `已选择 ${selectedPaths.size} 项 · 右键批量操作`
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
			{overwrite ? <OverwriteDialog question={overwrite.question} onAnswer={answerOverwrite} /> : null}
			{deleting ? (
				<DeleteDialog workspace={workspace} entries={deleting} onClose={() => setDeleting(undefined)} />
			) : null}
		</aside>
	);
}

/** Header button that shows or hides the file panel. */
export function FilesPanelToggle() {
	const store = useStore();
	const open = useAppState((s) => s.filesPanel);
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
