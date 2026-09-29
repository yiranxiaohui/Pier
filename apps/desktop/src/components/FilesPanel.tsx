import type { WorkspaceFileEntry, WorkspaceInfo } from "@pier/protocol";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, joinPath, relativeTime } from "../lib/format.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { terminals } from "../lib/terminals.ts";
import {
	IconAlert,
	IconChevronRight,
	IconChevronUp,
	IconCopy,
	IconFile,
	IconFolder,
	IconFolderOpen,
	IconLink,
	IconLoader,
	IconMessagePlus,
	IconPanelRight,
	IconRefresh,
	IconTerminal,
	IconX,
} from "./Icons.tsx";

interface DirState {
	entries?: WorkspaceFileEntry[];
	error?: string;
	loading: boolean;
	truncated?: boolean;
	total?: number;
}

/** Expanded directories per workspace, kept while the app runs so switching back restores the tree. */
const expandedByWorkspace = new Map<string, Set<string>>();

function errorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持文件列表，请更新 Pier";
	if (code === "NOT_FOUND") return "目录不存在";
	if (code === "FORBIDDEN") return "无权访问该目录";
	return message;
}

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

function ResizeHandle() {
	const store = useStore();
	const width = useAppState((s) => s.filesPanelWidth);
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = width;
		const target = e.currentTarget;
		target.setPointerCapture(e.pointerId);
		document.body.classList.add("resizing-panel");
		const move = (ev: PointerEvent) => store.setFilesPanelWidth(startWidth + (startX - ev.clientX));
		const up = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", up);
			target.removeEventListener("pointercancel", up);
			document.body.classList.remove("resizing-panel");
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", up);
		target.addEventListener("pointercancel", up);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize affordance; width also persists.
		<div
			className="files-resize"
			title="拖动调整宽度，双击恢复默认"
			onPointerDown={onPointerDown}
			onDoubleClick={() => store.setFilesPanelWidth(280)}
		/>
	);
}

/**
 * `composerKey` is the draft key of the composer on screen (a session id, or the new-chat
 * draft); without it the panel only offers copying paths.
 */
export function FilesPanel({ workspace, composerKey }: { workspace: WorkspaceInfo; composerKey?: string }) {
	const store = useStore();
	const connection = useAppState((s) => s.connection);
	const version = useAppState((s) => s.filesVersion[workspace.id] ?? 0);
	const { dirs, expanded, reload, toggle, collapseAll } = useWorkspaceTree(workspace.id);
	const [selected, setSelected] = useState<string>();
	const [copied, setCopied] = useState<string>();
	const lastReload = useRef(0);
	/** Pending single-click preview, cancelled when the click turns out to be a double click. */
	const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(clickTimer.current), []);

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

	const copyPath = (entry: WorkspaceFileEntry) => {
		void navigator.clipboard.writeText(entry.path).then(
			() => {
				setCopied(entry.path);
				setTimeout(() => setCopied((c) => (c === entry.path ? undefined : c)), 1200);
			},
			() => store.toast("error", "复制失败"),
		);
	};
	const insert = (entry: WorkspaceFileEntry) => {
		if (composerKey) store.insertFileIntoComposer(composerKey, entry.path, entry.kind === "directory");
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
					return (
						<div key={entry.path}>
							<div
								className={`files-row${selected === entry.path ? " selected" : ""}${entry.kind === "other" ? " dim" : ""}`}
								style={{ paddingLeft: 6 + depth * 14 }}
							>
								<button
									type="button"
									className="files-entry"
									title={entryTitle(entry)}
									{...(isDir ? { "aria-expanded": open } : {})}
									onClick={(event) => {
										setSelected(entry.path);
										if (isDir) {
											toggle(entry.path);
											return;
										}
										clearTimeout(clickTimer.current);
										if (entry.kind !== "file" || event.detail > 1) return;
										// With a composer, wait briefly so a double click inserts the path instead.
										const open = () => store.openFilePreview(workspace.id, entry.path, composerKey);
										if (composerKey && event.detail === 1) clickTimer.current = setTimeout(open, 250);
										else open();
									}}
									onDoubleClick={() => {
										clearTimeout(clickTimer.current);
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
									{isDir && terminals.supported ? (
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
				<div className="files-heading">
					<span className="files-title">文件</span>
					<span className="files-workspace" title={workspace.path}>
						{workspace.name}
					</span>
				</div>
				<button
					type="button"
					className="ghost icon"
					title="刷新"
					disabled={connection !== "open"}
					onClick={() => {
						lastReload.current = Date.now();
						reload();
					}}
				>
					<IconRefresh size={14} className={loading ? "spin" : undefined} />
				</button>
				<button type="button" className="ghost icon" title="全部折叠" disabled={!expanded.size} onClick={collapseAll}>
					<IconChevronUp size={14} />
				</button>
				<button type="button" className="ghost icon" title="关闭文件面板" onClick={() => store.toggleFilesPanel(false)}>
					<IconX size={14} />
				</button>
			</header>
			<div className="files-tree">
				{connection === "open" || dirs[""] ? renderDir("", 0) : <div className="files-note">正在连接 Pier Host…</div>}
			</div>
			<div className="files-hint">{composerKey ? "单击文件查看内容，双击把路径插入输入框" : "单击文件查看内容"}</div>
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
			title={open ? "隐藏文件面板（Ctrl/⌘+Shift+E）" : "显示工作区文件（Ctrl/⌘+Shift+E）"}
			aria-pressed={open}
			onClick={() => store.toggleFilesPanel()}
		>
			<IconPanelRight size={15} />
		</button>
	);
}
