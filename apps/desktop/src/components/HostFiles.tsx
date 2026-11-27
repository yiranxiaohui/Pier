import type { WorkspaceFileEntry, WorkspaceFilesResult, WorkspaceInfo } from "@pier/protocol";
import {
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { selectByKeyboard, selectByPointer } from "../lib/file-selection.ts";
import {
	downloadFile,
	dragHasFiles,
	dropEntries,
	hostTransferKey,
	type OverwriteAnswer,
	type OverwriteQuestion,
	type PasteConflictAnswer,
	type PasteConflictQuestion,
	type UploadItem,
	uploadFiles,
	uploadItemsFromInput,
} from "../lib/file-transfers.ts";
import { formatSize, relativeTime } from "../lib/format.ts";
import {
	canPasteInto,
	clearHostClipboard,
	type FileScope,
	type FileSort,
	type FileSortKey,
	fileAbilities,
	fileErrorText,
	type HostClipboard,
	isCut,
	isHiddenEntry,
	newEntryPath,
	pasteHostEntries,
	renameEntry,
	scopeAbsolute,
	scopeDirectory,
	scopeFiles,
	setHostClipboard,
	sortFileEntries,
	useHostClipboard,
	useHostPasteBusy,
} from "../lib/host-files.ts";
import { useCanOpenTerminal } from "../lib/remote-terminals.ts";
import { hostSpeaksMinor } from "../lib/settings-target.ts";
import { type ComputerInfo, hostTransfersFiles, LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { terminals } from "../lib/terminals.ts";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import { OverwriteDialog, TransferList } from "./FilesPanel.tsx";
import { HostFileViewer } from "./HostFileViewer.tsx";
import {
	IconArrowUp,
	IconChevronDown,
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
	IconFolderOpen,
	IconFolderPlus,
	IconHome,
	IconInfo,
	IconLink,
	IconLoader,
	IconMore,
	IconPaste,
	IconPencil,
	IconRefresh,
	IconTerminal,
	IconTrash,
	IconUpload,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

export function HostFiles({ computer }: { computer: ComputerInfo }) {
	const store = useStore();
	const [selected, setSelected] = useState("");
	if (hostSpeaksMinor(computer.state.hostInfo, 57)) return <FileBrowser node={computer.id} />;
	if (!hostTransfersFiles(computer.state.hostInfo))
		return <p className="host-notice">请更新此主机的 Pier 以管理文件。</p>;
	const workspaces = computer.state.workspaces;
	const workspace = workspaces.find((item) => item.id === selected) ?? workspaces[0];
	return (
		<>
			<div className="host-legacy-files">
				<span>此主机的 Pier 版本只能管理工作区内的文件，更新后可浏览整台主机。</span>
				{workspace && (
					<Select
						ariaLabel="工作区"
						value={workspace.id}
						options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
						onChange={setSelected}
					/>
				)}
				<button type="button" onClick={() => void store.pickAndAddWorkspace(computer.id)}>
					添加工作区
				</button>
			</div>
			{workspace && <FileBrowser key={workspace.id} node={computer.id} workspace={workspace} />}
		</>
	);
}

type Listing = WorkspaceFilesResult & { directory: string; parent?: string; separator: string };

const HIDDEN_KEY = "pier.hostFiles.showHidden";
const DRAG_TYPE = "application/x-pier-host-files";
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? "⌘" : "Ctrl+";
const revealLabel = isMac
	? "在访达中显示"
	: typeof navigator !== "undefined" && /Win/.test(navigator.platform || navigator.userAgent)
		? "在资源管理器中显示"
		: "在文件管理器中显示";
/** `webkitdirectory` is not in React's input attribute types. */
const folderInputProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

function loadShowHidden(): boolean {
	try {
		return localStorage.getItem(HIDDEN_KEY) === "1";
	} catch {
		return false;
	}
}

function entryTitle(entry: WorkspaceFileEntry): string {
	const parts = [entry.name];
	if (entry.kind === "file" && entry.size !== undefined) parts.push(formatSize(entry.size));
	if (entry.modifiedAt) parts.push(`修改于 ${new Date(entry.modifiedAt).toLocaleString()}`);
	if (entry.symlink) parts.push(entry.kind === "other" ? "符号链接（目标不可用）" : "符号链接");
	return parts.join(" · ");
}

type Conflict = (
	| { kind: "upload"; question: OverwriteQuestion; resolve: (answer: OverwriteAnswer) => void }
	| { kind: "paste"; question: PasteConflictQuestion; resolve: (answer: PasteConflictAnswer) => void }
) & { id: number };

/**
 * A file manager for one computer: browse its directories (or, on old Hosts, a workspace),
 * preview and edit files, create, rename, copy, cut, paste and delete entries, upload by
 * picking or dropping local files and download files.
 */
function FileBrowser({ node, workspace }: { node: string; workspace?: WorkspaceInfo }) {
	const store = useStore();
	const client = store.nodeClient(node);
	const hostInfo = useAppState((s) => s.nodes[node]?.hostInfo);
	const connected = useAppState((s) => s.nodes[node]?.connection === "open");
	const abilities = fileAbilities(workspace ? "workspace" : "host", hostInfo);
	const canManage = connected && abilities.manage;
	const canTransfer = connected && abilities.transfer;
	const canTerminal = useCanOpenTerminal(undefined, node);
	const canReveal = node === LOCAL_NODE && store.canRevealLocalPaths;
	const key = workspace?.id ?? hostTransferKey(node);
	const version = useAppState((s) => s.filesVersion[key] ?? 0);
	const [directory, setDirectory] = useState("");
	const [address, setAddress] = useState("");
	const [listing, setListing] = useState<Listing>();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [refresh, setRefresh] = useState(0);
	const [showHidden, setShowHidden] = useState(loadShowHidden);
	const [sort, setSort] = useState<FileSort>({ by: "name", desc: false });
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [anchor, setAnchor] = useState<string>();
	const [menu, setMenu] = useState<{ position: ContextMenuPosition; entry?: WorkspaceFileEntry; upload?: boolean }>();
	const [creating, setCreating] = useState<"file" | "directory">();
	const [renaming, setRenaming] = useState<WorkspaceFileEntry>();
	const [deleting, setDeleting] = useState<WorkspaceFileEntry[]>();
	const [viewing, setViewing] = useState<{ scope: FileScope; entry: WorkspaceFileEntry }>();
	const [dropDir, setDropDir] = useState<string>();
	const [dragging, setDragging] = useState<ReadonlySet<string>>(() => new Set());
	const [conflict, setConflict] = useState<Conflict>();
	const clipboard = useHostClipboard();
	const pasteBusy = useHostPasteBusy();
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const uploadDir = useRef("");
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());
	const listRef = useRef<HTMLDivElement>(null);
	const dragged = useRef<HostClipboard>(undefined);
	const conflictRef = useRef(conflict);
	const nextConflict = useRef(0);
	const mounted = useRef(false);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			conflictRef.current?.resolve({ choice: "cancel" });
		};
	}, []);

	const workspaceId = workspace?.id;
	const list = useCallback(async (): Promise<Listing> => {
		if (!client) throw new Error("主机未连接");
		if (!workspaceId) return client.request("host.files", directory ? { directory } : {});
		const result = await client.request("workspace.files", { workspaceId, path: directory });
		const parent = result.path.split("/").slice(0, -1).join("/");
		return { ...result, directory: result.path, separator: "/", ...(result.path ? { parent } : {}) };
	}, [client, workspaceId, directory]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: file changes and the refresh button reload the listing.
	useEffect(() => {
		let current = true;
		setLoading(true);
		setError("");
		void list()
			.then((value) => {
				if (!current) return;
				setListing(value);
				setAddress(value.directory);
			})
			.catch((e: unknown) => {
				if (!current) return;
				setListing(undefined);
				setError(fileErrorText(e));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [list, version, refresh]);

	const scope = useMemo<FileScope | undefined>(() => {
		if (!listing) return undefined;
		return workspace
			? { kind: "workspace", node, workspace, dir: listing.path }
			: { kind: "host", node, directory: listing.directory };
	}, [listing, node, workspace]);

	const hiddenCount = useMemo(
		() => (showHidden ? 0 : (listing?.entries.filter(isHiddenEntry).length ?? 0)),
		[listing, showHidden],
	);
	const entries = useMemo(() => {
		const all = listing?.entries ?? [];
		return sortFileEntries(showHidden ? all : all.filter((entry) => !isHiddenEntry(entry)), sort);
	}, [listing, showHidden, sort]);
	const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);

	// A refresh or a hidden toggle must not keep selections the list no longer shows.
	useEffect(() => {
		const visible = new Set(paths);
		setSelected((current) => {
			const next = new Set([...current].filter((path) => visible.has(path)));
			return next.size === current.size ? current : next;
		});
		setAnchor((current) => (current && visible.has(current) ? current : undefined));
	}, [paths]);

	const refreshList = () => setRefresh((n) => n + 1);
	const bump = () => store.bumpFiles(key);
	const go = (path: string) => {
		setAddress(path);
		setListing(undefined);
		setSelected(new Set());
		setAnchor(undefined);
		setLoading(true);
		setDirectory(path);
		refreshList();
	};
	const childDirectory = (entry: WorkspaceFileEntry): string => {
		if (!listing || workspace) return entry.path;
		const separator = listing.directory.endsWith(listing.separator) ? "" : listing.separator;
		return listing.directory + separator + entry.name;
	};
	/** The scope of a folder in the list, for pasting or dropping into it. */
	const folderScope = (entry: WorkspaceFileEntry): FileScope | undefined => {
		if (!scope) return undefined;
		return scope.kind === "host" ? { ...scope, directory: childDirectory(entry) } : { ...scope, dir: entry.path };
	};
	const location = workspace ?? (listing && { node, directory: listing.directory });
	const selection = () => entries.filter((entry) => selected.has(entry.path));
	const targets = (entry: WorkspaceFileEntry) => (selected.has(entry.path) ? selection() : [entry]);

	const askUpload = (question: OverwriteQuestion): Promise<OverwriteAnswer> =>
		new Promise((resolve) => {
			if (!mounted.current) return resolve({ choice: "cancel" });
			conflictRef.current?.resolve({ choice: "cancel" });
			const pending: Conflict = { kind: "upload", question, resolve, id: nextConflict.current++ };
			conflictRef.current = pending;
			setConflict(pending);
		});
	const askPaste = (question: PasteConflictQuestion): Promise<PasteConflictAnswer> =>
		new Promise((resolve) => {
			if (!mounted.current) return resolve({ choice: "cancel" });
			conflictRef.current?.resolve({ choice: "cancel" });
			const pending: Conflict = { kind: "paste", question, resolve, id: nextConflict.current++ };
			conflictRef.current = pending;
			setConflict(pending);
		});
	const answerConflict = (answer: PasteConflictAnswer) => {
		const pending = conflictRef.current;
		if (!pending) return;
		if (pending.kind === "paste") pending.resolve(answer);
		else if (answer.choice !== "rename") pending.resolve(answer);
		conflictRef.current = undefined;
		setConflict(undefined);
	};

	const copyText = (text: string, what: string) => {
		void navigator.clipboard.writeText(text).then(
			() => store.toast("info", `已复制${what}`),
			() => store.toast("error", "复制失败"),
		);
	};
	const upload = (items: UploadItem[]) => {
		if (!location) return;
		if (!items.length) store.toast("info", "没有可上传的文件（空文件夹不会上传）");
		else void uploadFiles(store, location, items, askUpload);
	};
	const pickUpload = (dir: string, folder: boolean) => {
		uploadDir.current = dir;
		const input = folder ? folderInput.current : fileInput.current;
		if (!input) return;
		input.value = "";
		input.click();
	};
	/** Where an upload into the shown directory (or one of its folders) goes, relative to the scope. */
	const uploadBase = (entry?: WorkspaceFileEntry) => entry?.path ?? (workspace ? (listing?.path ?? "") : "");
	const download = async (list: WorkspaceFileEntry[]) => {
		if (!location) return;
		for (const entry of list) if (entry.kind === "file") await downloadFile(store, location, entry.path);
	};
	const open = (entry: WorkspaceFileEntry) => {
		if (entry.kind === "directory") go(childDirectory(entry));
		else if (entry.kind === "file" && scope) {
			if (canManage) setViewing({ scope, entry });
			else if (canTransfer) void download([entry]);
		}
	};
	const openTerminal = (cwd: string) => {
		terminals.create({ node, cwd });
		store.selectHostView(node, "shell");
	};
	const copyEntries = (list: WorkspaceFileEntry[], mode: "copy" | "move") => {
		if (!scope || !canManage || pasteBusy) return;
		if (list.some((entry) => entry.kind === "other" && !entry.symlink)) {
			store.toast("error", "请选择普通文件或文件夹");
			return;
		}
		setHostClipboard(
			mode,
			scope,
			list.map((entry) => ({
				path: entry.path,
				name: entry.name,
				kind: entry.kind === "directory" ? "directory" : "file",
				...(entry.symlink ? { symlink: true } : {}),
			})),
		);
		store.toast(
			"info",
			`已${mode === "move" ? "剪切" : "复制"} ${list.length} 项，可在这台主机的任意文件夹粘贴（${mod}V）`,
		);
	};
	const pasteInto = (destination: FileScope | undefined) => {
		if (!client || !clipboard || !destination || !canManage) return;
		void pasteHostEntries(store, client, clipboard, destination, askPaste);
	};
	const canPasteHere = canManage && !pasteBusy && canPasteInto(clipboard, scope);

	const focusRow = (path: string) => {
		const row = rowRefs.current.get(path);
		row?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: "nearest" });
	};
	const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: WorkspaceFileEntry) => {
		if (event.nativeEvent.isComposing) return;
		const command = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		const move = (path: string) => {
			const update = selectByKeyboard(paths, anchor ?? entry.path, path, event.shiftKey);
			setSelected(update.selected);
			setAnchor(update.anchor);
			focusRow(path);
		};
		if (event.altKey) {
			if (event.key !== "ArrowUp" || listing?.parent === undefined) return;
			go(listing.parent);
		} else if (command && key === "a" && !event.shiftKey) {
			setSelected(new Set(paths));
			setAnchor(entry.path);
		} else if (command && key === "c") {
			if (event.shiftKey && scope)
				copyText(
					targets(entry)
						.map((item) => scopeAbsolute(scope, item.path))
						.join("\n"),
					"路径",
				);
			else copyEntries(targets(entry), "copy");
		} else if (command && key === "x" && !event.shiftKey) {
			copyEntries(targets(entry), "move");
		} else if (command && key === "v" && !event.shiftKey) {
			if (canPasteHere) pasteInto(scope);
		} else if (!command && event.key === "F2") {
			if (canManage && targets(entry).length === 1) setRenaming(entry);
		} else if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
			if (canManage) setDeleting(targets(entry));
		} else if (!command && event.key === "Backspace") {
			if (listing?.parent !== undefined) go(listing.parent);
		} else if (event.key === "Escape") {
			setSelected(new Set());
			setAnchor(undefined);
			clearHostClipboard();
		} else if (!command && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			const index = paths.indexOf(entry.path);
			const next =
				event.key === "Home"
					? 0
					: event.key === "End"
						? paths.length - 1
						: Math.max(0, Math.min(paths.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
			const path = paths[next];
			if (path) move(path);
		} else if (event.key === " " && !event.shiftKey) {
			if (event.repeat) return;
			const update = selectByPointer(paths, selected, anchor, entry.path, { ctrlKey: true });
			setSelected(update.selected);
			setAnchor(update.anchor);
		} else if (!command && event.key === "Enter") {
			open(entry);
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	// --- Drag and drop: local files upload, rows move into folders --------------------------------
	const dropTarget = (event: ReactDragEvent): WorkspaceFileEntry | undefined => {
		const path = (event.target as Element).closest?.("[data-drop-folder]")?.getAttribute("data-drop-folder");
		return path === null || path === undefined ? undefined : entries.find((entry) => entry.path === path);
	};
	const endDrag = () => {
		dragged.current = undefined;
		setDragging(new Set());
		setDropDir(undefined);
	};
	const onRowDragStart = (event: ReactDragEvent<HTMLButtonElement>, entry: WorkspaceFileEntry) => {
		const list = targets(entry);
		if (!scope || !canManage || list.some((item) => item.kind === "other" && !item.symlink)) {
			event.preventDefault();
			return;
		}
		if (!selected.has(entry.path)) {
			setSelected(new Set([entry.path]));
			setAnchor(entry.path);
		}
		dragged.current = {
			mode: "move",
			scope,
			entries: list.map((item) => ({
				path: item.path,
				name: item.name,
				kind: item.kind === "directory" ? "directory" : "file",
				...(item.symlink ? { symlink: true } : {}),
			})),
		};
		setDragging(new Set(list.map((item) => item.path)));
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(DRAG_TYPE, node);
	};
	const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
		const folder = dropTarget(event);
		if ([...event.dataTransfer.types].includes(DRAG_TYPE)) {
			event.preventDefault();
			const valid = Boolean(folder && dragged.current && !dragging.has(folder.path));
			event.dataTransfer.dropEffect = valid ? "move" : "none";
			setDropDir(valid ? folder?.path : undefined);
			return;
		}
		if (!canTransfer || !dragHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		const dir = folder?.path ?? "";
		if (dir !== dropDir) setDropDir(dir);
	};
	const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
		const folder = dropTarget(event);
		if ([...event.dataTransfer.types].includes(DRAG_TYPE)) {
			event.preventDefault();
			const snapshot = dragged.current;
			endDrag();
			const destination = folder && folderScope(folder);
			if (!client || !snapshot || !folder || !destination || snapshot.entries.some((e) => e.path === folder.path))
				return;
			void pasteHostEntries(store, client, snapshot, destination, askPaste);
			return;
		}
		setDropDir(undefined);
		if (!canTransfer || !dragHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		const files = dropEntries(event.dataTransfer);
		void files(uploadBase(folder)).then(upload, (e: unknown) =>
			store.toast("error", `读取拖入的文件失败：${e instanceof Error ? e.message : String(e)}`),
		);
	};

	// --- Menus ----------------------------------------------------------------------------------
	const needsUpdate = "请更新此主机的 Pier 以使用此功能";
	const manageHint = canManage ? undefined : abilities.manage ? "主机未连接" : needsUpdate;
	const createItems = (): ContextMenuItem[] => [
		{
			label: "新建文件…",
			icon: <IconFilePlus size={14} />,
			disabled: !canManage,
			onSelect: () => setCreating("file"),
		},
		{
			label: "新建文件夹…",
			icon: <IconFolderPlus size={14} />,
			disabled: !canManage,
			onSelect: () => setCreating("directory"),
		},
	];
	const uploadItems = (folder?: WorkspaceFileEntry): ContextMenuItem[] => [
		{
			label: folder ? "上传文件到此文件夹…" : "上传文件…",
			icon: <IconUpload size={14} />,
			disabled: !canTransfer || !listing,
			onSelect: () => pickUpload(uploadBase(folder), false),
		},
		{
			label: folder ? "上传文件夹到此文件夹…" : "上传文件夹…",
			icon: <IconFolderOpen size={14} />,
			disabled: !canTransfer || !listing,
			onSelect: () => pickUpload(uploadBase(folder), true),
		},
	];
	const menuItems = (entry?: WorkspaceFileEntry): ContextMenuItem[] => {
		if (menu?.upload) return uploadItems();
		const here = scope ? scopeDirectory(scope) : "";
		if (!entry) {
			return [
				...createItems(),
				"separator",
				...uploadItems(),
				{
					label: "粘贴",
					icon: <IconPaste size={14} />,
					hint: `${mod}V`,
					disabled: !canPasteHere,
					onSelect: () => pasteInto(scope),
				},
				"separator",
				{ label: "刷新", icon: <IconRefresh size={14} />, onSelect: refreshList },
				{
					label: showHidden ? "不显示隐藏文件" : "显示隐藏文件",
					icon: showHidden ? <IconEyeOff size={14} /> : <IconEye size={14} />,
					onSelect: () => toggleHidden(),
				},
				{ label: "复制当前路径", icon: <IconCopy size={14} />, onSelect: () => copyText(here, "路径") },
				"separator",
				canTerminal && {
					label: "在此处打开终端",
					icon: <IconTerminal size={14} />,
					onSelect: () => openTerminal(here),
				},
				canReveal && { label: revealLabel, icon: <IconExternal size={14} />, onSelect: () => store.revealPath(here) },
			];
		}
		const list = targets(entry);
		const files = list.filter((item) => item.kind === "file");
		const isDir = entry.kind === "directory";
		const absolute = scope ? scopeAbsolute(scope, entry.path) : entry.path;
		const special = list.some((item) => item.kind === "other" && !item.symlink);
		if (list.length > 1) {
			return [
				{
					label: `下载 ${files.length} 个文件`,
					icon: <IconDownload size={14} />,
					disabled: !canTransfer || !files.length,
					onSelect: () => void download(files),
				},
				"separator",
				{
					label: `复制 ${list.length} 项`,
					icon: <IconCopy size={14} />,
					hint: `${mod}C`,
					disabled: !canManage || pasteBusy || special,
					onSelect: () => copyEntries(list, "copy"),
				},
				{
					label: `剪切 ${list.length} 项`,
					icon: <IconCut size={14} />,
					hint: `${mod}X`,
					disabled: !canManage || pasteBusy || special,
					onSelect: () => copyEntries(list, "move"),
				},
				{
					label: `复制 ${list.length} 个路径`,
					icon: <IconCopy size={14} />,
					onSelect: () => scope && copyText(list.map((item) => scopeAbsolute(scope, item.path)).join("\n"), "路径"),
				},
				"separator",
				{
					label: `删除 ${list.length} 项…`,
					icon: <IconTrash size={14} />,
					danger: true,
					disabled: !canManage,
					onSelect: () => setDeleting(list),
				},
			];
		}
		return [
			isDir
				? { label: "打开", icon: <IconFolderOpen size={14} />, onSelect: () => open(entry) }
				: {
						label: canManage ? "查看 / 编辑" : "打开",
						icon: <IconFile size={14} />,
						disabled: entry.kind !== "file" || !(canManage || canTransfer),
						onSelect: () => open(entry),
					},
			!isDir && {
				label: "下载…",
				icon: <IconDownload size={14} />,
				disabled: !canTransfer || entry.kind !== "file",
				onSelect: () => void download([entry]),
			},
			"separator",
			{
				label: "复制",
				icon: <IconCopy size={14} />,
				hint: `${mod}C`,
				disabled: !canManage || pasteBusy || special,
				onSelect: () => copyEntries([entry], "copy"),
			},
			{
				label: "剪切",
				icon: <IconCut size={14} />,
				hint: `${mod}X`,
				disabled: !canManage || pasteBusy || special,
				onSelect: () => copyEntries([entry], "move"),
			},
			isDir && {
				label: "粘贴到此文件夹",
				icon: <IconPaste size={14} />,
				disabled: !canPasteHere,
				onSelect: () => pasteInto(folderScope(entry)),
			},
			{
				label: "重命名…",
				icon: <IconPencil size={14} />,
				hint: "F2",
				disabled: !canManage,
				onSelect: () => setRenaming(entry),
			},
			"separator",
			{ label: "复制路径", icon: <IconCopy size={14} />, onSelect: () => copyText(absolute, "路径") },
			{ label: "复制名称", icon: <IconCopy size={14} />, onSelect: () => copyText(entry.name, "名称") },
			isDir && "separator",
			...(isDir ? uploadItems(entry) : []),
			"separator",
			canTerminal && {
				label: isDir ? "在终端中打开" : "在所在目录打开终端",
				icon: <IconTerminal size={14} />,
				onSelect: () => openTerminal(isDir ? absolute : here),
			},
			canReveal && { label: revealLabel, icon: <IconExternal size={14} />, onSelect: () => store.revealPath(absolute) },
			"separator",
			{
				label: "删除…",
				icon: <IconTrash size={14} />,
				hint: isMac ? "⌘⌫" : "Delete",
				danger: true,
				disabled: !canManage,
				onSelect: () => setDeleting([entry]),
			},
		];
	};

	const toggleHidden = () => {
		setShowHidden((value) => {
			try {
				localStorage.setItem(HIDDEN_KEY, value ? "0" : "1");
			} catch {
				// Not persisted; the toggle still applies to this page.
			}
			return !value;
		});
	};
	const sortBy = (by: FileSortKey) => setSort((current) => ({ by, desc: current.by === by ? !current.desc : false }));
	const sortHeader = (by: FileSortKey, label: string) => (
		<button
			type="button"
			className={`ghost host-file-sort${sort.by === by ? " active" : ""}`}
			title={sort.by === by ? (sort.desc ? "降序，点击改为升序" : "升序，点击改为降序") : `按${label}排序`}
			onClick={() => sortBy(by)}
		>
			{label}
			{sort.by === by ? sort.desc ? <IconChevronDown size={12} /> : <IconChevronUp size={12} /> : null}
		</button>
	);

	let body: ReactNode;
	if (error) {
		body = (
			<p role="alert" className="host-notice error-text">
				{error}
			</p>
		);
	} else if (!listing) {
		body = (
			<p className="host-notice">
				<IconLoader size={14} className="spin" /> 正在读取目录…
			</p>
		);
	} else if (!entries.length) {
		body = <p className="host-notice">{hiddenCount ? `此目录只有 ${hiddenCount} 个隐藏项目` : "此目录为空"}</p>;
	} else {
		body = entries.map((entry) => {
			const isDir = entry.kind === "directory";
			const isSelected = selected.has(entry.path);
			const classes = [
				"host-file-row",
				isSelected && "selected",
				entry.kind === "other" && "dim",
				scope && isCut(clipboard, scope, entry.path) && "cut",
				dragging.has(entry.path) && "dragging",
				isDir && dropDir === entry.path && "drop-target",
				menu?.entry?.path === entry.path && "menu-open",
			]
				.filter(Boolean)
				.join(" ");
			return (
				// biome-ignore lint/a11y/noStaticElementInteractions: the row's button is the focusable control; this adds its context menu.
				<div
					key={entry.path}
					className={classes}
					{...(isDir ? { "data-drop-folder": entry.path } : {})}
					onContextMenu={(event) => {
						event.preventDefault();
						event.stopPropagation();
						if (!selected.has(entry.path)) {
							setSelected(new Set([entry.path]));
							setAnchor(entry.path);
						}
						focusRow(entry.path);
						setMenu({ position: contextMenuPosition(event), entry });
					}}
				>
					<button
						type="button"
						role="option"
						aria-selected={isSelected}
						className="host-file-entry"
						title={entryTitle(entry)}
						draggable={canManage && entry.kind !== "other"}
						ref={(row) => {
							if (row) rowRefs.current.set(entry.path, row);
							else rowRefs.current.delete(entry.path);
						}}
						onDragStart={(event) => onRowDragStart(event, entry)}
						onDragEnd={endDrag}
						onKeyDown={(event) => onRowKeyDown(event, entry)}
						onClick={(event) => {
							// WebKit on macOS does not focus buttons on pointer clicks.
							event.currentTarget.focus({ preventScroll: true });
							const update = selectByPointer(paths, selected, anchor, entry.path, event);
							setSelected(update.selected);
							setAnchor(update.anchor);
						}}
						onDoubleClick={(event) => {
							if (!event.shiftKey && !event.metaKey && !event.ctrlKey) open(entry);
						}}
					>
						<span className={`host-file-icon${isDir ? " dir" : ""}`}>
							{isDir ? <IconFolder size={16} /> : <IconFile size={16} />}
						</span>
						<span className="host-file-label">{entry.name}</span>
						{entry.symlink ? <IconLink size={12} className="host-file-link" /> : null}
						<span className="host-file-size">
							{entry.kind === "file" && entry.size !== undefined ? formatSize(entry.size) : "—"}
						</span>
						<span className="host-file-time">{entry.modifiedAt ? relativeTime(entry.modifiedAt) : ""}</span>
					</button>
					<span className="host-file-actions">
						{entry.kind === "file" && canTransfer ? (
							<button
								type="button"
								className="ghost icon"
								title={`下载 ${entry.name}`}
								onClick={() => void download([entry])}
							>
								<IconDownload size={14} />
							</button>
						) : null}
						<button
							type="button"
							className="ghost icon"
							title="更多操作"
							onClick={(event) => {
								if (!selected.has(entry.path)) {
									setSelected(new Set([entry.path]));
									setAnchor(entry.path);
								}
								const rect = event.currentTarget.getBoundingClientRect();
								setMenu({ position: { x: rect.left, y: rect.bottom, anchor: event.currentTarget }, entry });
							}}
						>
							<IconMore size={14} />
						</button>
					</span>
				</div>
			);
		});
	}

	const selectedCount = selected.size;
	const total = listing ? listing.entries.length : 0;
	return (
		<section className="host-files" aria-label="主机文件">
			<form
				className="host-file-toolbar"
				onSubmit={(e) => {
					e.preventDefault();
					go(address.trim());
				}}
			>
				<button
					type="button"
					className="ghost icon"
					title="上一级目录（Backspace）"
					disabled={listing?.parent === undefined || loading}
					onClick={() => listing?.parent !== undefined && go(listing.parent)}
				>
					<IconArrowUp size={16} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title={workspace ? "工作区根目录" : "主目录"}
					onClick={() => go("")}
				>
					<IconHome size={16} />
				</button>
				<input
					className="mono"
					aria-label="目录路径"
					placeholder={workspace ? workspace.path : "输入主机上的绝对路径"}
					value={address}
					onChange={(e) => setAddress(e.target.value)}
					spellCheck={false}
				/>
				<button type="button" className="ghost icon" title="刷新" onClick={refreshList}>
					<IconRefresh size={15} className={loading ? "spin" : undefined} />
				</button>
				<span className="host-file-toolbar-divider" />
				<button
					type="button"
					className="ghost icon"
					title={manageHint ?? "新建文件"}
					disabled={!canManage || !listing}
					onClick={() => setCreating("file")}
				>
					<IconFilePlus size={16} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title={manageHint ?? "新建文件夹"}
					disabled={!canManage || !listing}
					onClick={() => setCreating("directory")}
				>
					<IconFolderPlus size={16} />
				</button>
				{clipboard ? (
					<button
						type="button"
						className="ghost icon"
						title={
							pasteBusy
								? "正在粘贴…"
								: canPasteInto(clipboard, scope)
									? `粘贴 ${clipboard.entries.length} 项（${mod}V）`
									: "剪贴板中的项目来自另一台主机，只能在同一台主机内粘贴"
						}
						disabled={!canPasteHere}
						onClick={() => pasteInto(scope)}
					>
						<IconPaste size={16} />
					</button>
				) : null}
				<button
					type="button"
					className={`ghost icon${showHidden ? " active" : ""}`}
					title={showHidden ? "不显示隐藏文件" : "显示隐藏文件"}
					aria-pressed={showHidden}
					onClick={toggleHidden}
				>
					{showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
				</button>
				<button
					type="button"
					disabled={!canTransfer || !listing}
					onClick={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						setMenu({ position: { x: rect.left, y: rect.bottom + 4, anchor: event.currentTarget }, upload: true });
					}}
				>
					<IconUpload size={15} />
					上传
				</button>
			</form>
			{connected && abilities.transfer && !abilities.manage ? (
				<p className="host-file-banner">
					<IconInfo size={14} />
					此主机的 Pier 版本只支持浏览、上传和下载；更新后可预览、编辑、新建、重命名、复制、移动和删除文件。
				</p>
			) : null}
			<div className="host-file-header" aria-hidden={!listing}>
				{sortHeader("name", "名称")}
				{sortHeader("size", "大小")}
				{sortHeader("modified", "修改时间")}
				<span />
			</div>
			<div
				ref={listRef}
				className={`host-file-list${dropDir === "" ? " drop-target" : ""}`}
				role="listbox"
				aria-label="文件列表"
				aria-multiselectable="true"
				tabIndex={-1}
				onClick={(event) => {
					if ((event.target as Element).closest(".host-file-row")) return;
					event.currentTarget.focus({ preventScroll: true });
					setSelected(new Set());
					setAnchor(undefined);
				}}
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
					const command = event.metaKey || event.ctrlKey;
					if (command && event.key.toLowerCase() === "v" && canPasteHere) {
						event.preventDefault();
						pasteInto(scope);
					}
				}}
				onContextMenu={(event) => {
					if ((event.target as Element).closest(".host-file-row")) return;
					event.preventDefault();
					setSelected(new Set());
					setMenu({ position: contextMenuPosition(event) });
				}}
				onDragOver={onDragOver}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDir(undefined);
				}}
				onDrop={onDrop}
			>
				{body}
				{listing?.truncated ? (
					<p className="host-notice">
						已显示 {listing.entries.length} 项，共 {listing.total} 项。
					</p>
				) : null}
			</div>
			<div className="host-file-status">
				<span>
					{listing
						? `${total} 项${hiddenCount ? `（${hiddenCount} 个隐藏）` : ""}${selectedCount ? ` · 已选择 ${selectedCount} 项` : ""}`
						: ""}
					{clipboard && canPasteInto(clipboard, scope)
						? ` · 剪贴板：${clipboard.mode === "move" ? "剪切" : "复制"} ${clipboard.entries.length} 项`
						: ""}
				</span>
				<span className="muted" title="Shift / Ctrl+单击多选，拖入本地文件上传，拖动项目到文件夹移动">
					双击打开 · 右键更多操作 · 拖入文件上传
				</span>
			</div>
			<TransferList workspaceId={key} />
			<input
				type="file"
				multiple
				hidden
				ref={fileInput}
				onChange={(e) => {
					const items = uploadItemsFromInput(e.target.files, uploadDir.current);
					e.target.value = "";
					upload(items);
				}}
			/>
			<input
				type="file"
				hidden
				ref={folderInput}
				{...folderInputProps}
				onChange={(e) => {
					const items = uploadItemsFromInput(e.target.files, uploadDir.current);
					e.target.value = "";
					upload(items);
				}}
			/>
			{menu ? (
				<ContextMenu
					position={menu.position}
					label={menu.entry ? menu.entry.name : "文件"}
					items={menuItems(menu.entry)}
					onClose={() => setMenu(undefined)}
				/>
			) : null}
			{conflict ? (
				<OverwriteDialog
					key={conflict.id}
					question={conflict.question}
					onAnswer={answerConflict}
					rename={
						conflict.kind === "paste"
							? { ...conflict.question, onRename: (name) => answerConflict({ choice: "rename", name }) }
							: undefined
					}
				/>
			) : null}
			{creating && scope && client ? (
				<NameDialog
					title={creating === "file" ? "新建文件" : "新建文件夹"}
					label={creating === "file" ? "文件名称" : "文件夹名称"}
					location={scopeDirectory(scope)}
					placeholder={creating === "file" ? "例如 notes/todo.md" : "例如 projects/demo"}
					hint="可以带子目录，缺少的上级文件夹会自动创建。"
					submit="创建"
					icon={creating === "file" ? <IconFilePlus size={14} /> : <IconFolderPlus size={14} />}
					onClose={() => setCreating(undefined)}
					onSubmit={async (value) => {
						const path = newEntryPath(scope, value);
						if (!path) throw new Error("请输入当前目录内的名称或相对路径，不能使用绝对路径、.. 或控制字符");
						const files = scopeFiles(client, scope);
						const result: { path: string; modifiedAt?: string } =
							creating === "file" ? await files.createFile(path) : await files.createDirectory(path);
						store.toast("info", `已创建${creating === "file" ? "文件" : "文件夹"}「${value.trim()}」`);
						setCreating(undefined);
						bump();
						const depth = scope.kind === "workspace" && scope.dir ? scope.dir.split("/").length : 0;
						const shown = result.path
							.split("/")
							.slice(0, depth + 1)
							.join("/");
						setSelected(new Set([shown]));
						setAnchor(shown);
						if (creating === "file" && shown === result.path) {
							setViewing({
								scope,
								entry: { name: shown.slice(shown.lastIndexOf("/") + 1), path: result.path, kind: "file", size: 0 },
							});
						}
					}}
				/>
			) : null}
			{renaming && scope && client ? (
				<NameDialog
					key={renaming.path}
					title="重命名"
					label="新名称"
					location={scopeAbsolute(scope, renaming.path)}
					initial={renaming.name}
					selectStem={renaming.kind === "file" && !renaming.symlink && !renaming.name.startsWith(".")}
					submit="重命名"
					icon={<IconPencil size={14} />}
					onClose={() => setRenaming(undefined)}
					onSubmit={async (value) => {
						if (value.trim() === renaming.name) {
							setRenaming(undefined);
							return;
						}
						const result = await renameEntry(client, scope, renaming, value);
						store.toast("info", `已重命名为「${value.trim()}」`);
						setRenaming(undefined);
						bump();
						setSelected(new Set([result.path]));
						setAnchor(result.path);
					}}
				/>
			) : null}
			{deleting && scope && client ? (
				<DeleteDialog
					scope={scope}
					entries={deleting}
					onDelete={(entry) => scopeFiles(client, scope).deletePath(entry.path)}
					onClose={(changed) => {
						setDeleting(undefined);
						if (changed) bump();
						listRef.current?.focus({ preventScroll: true });
					}}
				/>
			) : null}
			{viewing ? (
				<HostFileViewer
					client={client}
					scope={viewing.scope}
					path={viewing.entry.path}
					name={viewing.entry.name}
					editable={canManage}
					canReadBytes={canTransfer}
					onClose={() => setViewing(undefined)}
					onSaved={bump}
					onDownload={canTransfer && location ? () => void download([viewing.entry]) : undefined}
				/>
			) : null}
		</section>
	);
}

/** A name input for creating or renaming; `onSubmit` throws to show its error. */
function NameDialog({
	title,
	label,
	location,
	initial = "",
	placeholder,
	hint,
	submit,
	icon,
	selectStem,
	onSubmit,
	onClose,
}: {
	title: string;
	label: string;
	location: string;
	initial?: string;
	placeholder?: string;
	hint?: string;
	submit: string;
	icon: ReactNode;
	selectStem?: boolean;
	onSubmit: (value: string) => Promise<void>;
	onClose: () => void;
}) {
	const [value, setValue] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const element = input.current;
		if (!element) return;
		element.focus();
		const dot = selectStem ? initial.lastIndexOf(".") : -1;
		element.setSelectionRange(0, dot > 0 ? dot : initial.length);
	}, [initial, selectStem]);
	const run = async () => {
		if (busy || !value.trim()) return;
		setBusy(true);
		setError(undefined);
		try {
			await onSubmit(value);
		} catch (e) {
			setError(fileErrorText(e));
			setBusy(false);
		}
	};
	return (
		<Modal title={title} className="files-create-dialog" onClose={() => !busy && onClose()}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void run();
				}}
			>
				<code className="path">{location}</code>
				<label className="field">
					<span className="field-label">{label}</span>
					<input
						ref={input}
						value={value}
						onChange={(event) => {
							setValue(event.target.value);
							setError(undefined);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
						}}
						placeholder={placeholder}
						maxLength={4096}
						disabled={busy}
						autoComplete="off"
						spellCheck={false}
					/>
				</label>
				{hint ? <p className="muted small">{hint}</p> : null}
				{error ? (
					<p className="error-text small" role="alert">
						{error}
					</p>
				) : null}
				<div className="modal-actions">
					<button type="button" className="ghost" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button type="submit" disabled={busy || !value.trim()}>
						{busy ? <IconLoader size={14} className="spin" /> : icon}
						{busy ? "正在处理…" : submit}
					</button>
				</div>
			</form>
		</Modal>
	);
}

/** Confirms and permanently deletes entries one at a time; retrying skips the finished ones. */
function DeleteDialog({
	scope,
	entries,
	onDelete,
	onClose,
}: {
	scope: FileScope;
	entries: WorkspaceFileEntry[];
	onDelete: (entry: WorkspaceFileEntry) => Promise<unknown>;
	onClose: (changed: boolean) => void;
}) {
	const store = useStore();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const completed = useRef(new Set<string>());
	const single = entries.length === 1 ? entries[0] : undefined;
	const isDir = single?.kind === "directory" && !single.symlink;
	const what = single ? (single.symlink ? "符号链接" : isDir ? "文件夹" : "文件") : "项目";
	const cancel = () => onClose(completed.current.size > 0);
	const remove = async () => {
		setBusy(true);
		setError(undefined);
		for (const entry of entries) {
			if (completed.current.has(entry.path)) continue;
			try {
				await onDelete(entry);
			} catch (e) {
				if ((e as { code?: string }).code !== "NOT_FOUND") {
					const progress = completed.current.size ? `已删除 ${completed.current.size} 项；` : "";
					setError(`${progress}删除「${entry.name}」失败：${fileErrorText(e)}`);
					setBusy(false);
					return;
				}
			}
			completed.current.add(entry.path);
		}
		store.toast("info", single ? `已删除${what}「${single.name}」` : `已删除 ${entries.length} 个项目`);
		onClose(true);
	};
	return (
		<Modal title={single ? `删除${what}` : `删除 ${entries.length} 个项目`} onClose={() => !busy && cancel()}>
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
						{scopeAbsolute(scope, entry.path)}
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
				<button type="button" className="ghost" autoFocus disabled={busy} onClick={cancel}>
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
