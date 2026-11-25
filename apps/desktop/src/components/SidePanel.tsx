import type { WorkspaceInfo } from "@pier/protocol";
import {
	type ComponentType,
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	FILE_PREVIEW_MAX_WIDTH,
	FILE_PREVIEW_MIN_WIDTH,
	FILES_PANEL_DEFAULT_WIDTH,
	FILES_PANEL_MAX_WIDTH,
	FILES_PANEL_MIN_WIDTH,
	type FilePreviewTab,
	type RightPanelTab,
	useAppState,
	useStore,
} from "../lib/store.tsx";
import { BrowserView } from "./BrowserPanel.tsx";
import { FilesPanel } from "./FilesPanel.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { GitPanel } from "./GitPanel.tsx";
import {
	IconBot,
	IconBrowser,
	IconFile,
	IconFolder,
	IconGitBranch,
	IconImage,
	IconMaximize,
	IconPanelRight,
	IconPlus,
	IconTerminal,
	IconX,
} from "./Icons.tsx";
import { useGitChangeCount } from "./PanelChrome.tsx";
import { PanelLauncher } from "./PanelLauncher.tsx";
import { SubagentPanel } from "./SubagentPanel.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";

/** Matches the panel's width transition in side-panel.css, plus a little slack. */
const CLOSE_MS = 320;
/** The navigation rail's width (`.window-body` in statusbar.css). */
const NAV_RAIL_WIDTH = 60;
/** The conversation keeps at least this width beside a file tab, while the window allows it. */
const MAIN_MIN_WIDTH = 400;
/** What a collapsed sidebar still takes: the gap beside the main panel. */
const COLLAPSED_SIDEBAR_WIDTH = 8;

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;

/**
 * What the panel shows: nothing, its files / source control / browser / terminal / subagent
 * view or launcher, the active file tab, or (`modal` mode) the file tabs in a dialog filling
 * the window.
 */
type View = "closed" | "tool" | "file" | "overlay";

/** The views that open as tabs from the launcher (or a subagent card). */
const TOOLS: Record<RightPanelTab, { label: string; hint: string; Icon: ComponentType<{ size?: number }> }> = {
	files: { label: "文件", hint: "工作区文件（Ctrl/⌘+Shift+E）", Icon: IconFolder },
	git: { label: "源代码管理", hint: "Git 源代码管理（Ctrl/⌘+Shift+G）", Icon: IconGitBranch },
	browser: { label: "浏览器", hint: "工作区所在电脑的浏览器", Icon: IconBrowser },
	terminal: { label: "终端", hint: "终端（Ctrl+`）", Icon: IconTerminal },
	subagent: { label: "Subagent", hint: "Subagent 的对话", Icon: IconBot },
};

function splitPath(path: string): string[] {
	return path.split(/[\\/]/).filter(Boolean);
}

/** The widest a file tab may make the panel in the current window, leaving `reserved` pixels to the rest. */
function maxPreviewWidth(reserved: number): number {
	return Math.min(FILE_PREVIEW_MAX_WIDTH, Math.max(FILE_PREVIEW_MIN_WIDTH, window.innerWidth - reserved));
}

/**
 * Drag handle on the panel's left edge. The files / source control views and the file tabs
 * keep separate widths (`target`); double click goes back to the default.
 */
function PanelResizeHandle({
	shell,
	target,
	reserved,
}: {
	shell: RefObject<HTMLDivElement | null>;
	target: "tool" | "file";
	reserved: number;
}) {
	const store = useStore();
	const saved = useAppState((s) => (target === "tool" ? s.filesPanelWidth : s.filePreviewWidth));
	const min = target === "tool" ? FILES_PANEL_MIN_WIDTH : FILE_PREVIEW_MIN_WIDTH;
	const max = target === "tool" ? FILES_PANEL_MAX_WIDTH : FILE_PREVIEW_MAX_WIDTH;
	const stopResize = useRef<(() => void) | undefined>(undefined);
	useEffect(() => () => stopResize.current?.(), []);
	const [measured, setMeasured] = useState<number>();
	useEffect(() => {
		const el = shell.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setMeasured(Math.round(el.getBoundingClientRect().width)));
		observer.observe(el);
		return () => observer.disconnect();
	}, [shell]);
	// A file tab may be narrower than its saved width in a small window: start from what is on screen.
	const current = () => Math.round(shell.current?.getBoundingClientRect().width ?? saved ?? min);
	const resize = (next: number) => {
		if (target === "tool") store.setFilesPanelWidth(next);
		else store.setFilePreviewWidth(Math.min(maxPreviewWidth(reserved), next));
	};

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || !e.isPrimary) return;
		e.preventDefault();
		stopResize.current?.();
		const startX = e.clientX;
		const startWidth = current();
		const handle = e.currentTarget;
		const pointerId = e.pointerId;
		handle.setPointerCapture(pointerId);
		handle.focus({ focusVisible: false });
		document.body.classList.add("resizing-panel");
		const move = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) resize(startWidth + startX - ev.clientX);
		};
		const stop = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			handle.removeEventListener("lostpointercapture", end);
			if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
			document.body.classList.remove("resizing-panel");
			stopResize.current = undefined;
		};
		const end = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) stop();
		};
		stopResize.current = stop;
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
		handle.addEventListener("lostpointercapture", end);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? 80 : 20;
		if (e.key === "ArrowLeft") resize(current() + step);
		else if (e.key === "ArrowRight") resize(current() - step);
		else if (e.key === "Home") resize(min);
		else if (e.key === "End") resize(target === "tool" ? max : maxPreviewWidth(reserved));
		else return;
		e.preventDefault();
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: focusable window splitter, not a thematic break.
		<div
			className="side-panel-resize"
			role="separator"
			aria-label="调整右侧面板宽度"
			aria-orientation="vertical"
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={measured ?? saved ?? min}
			tabIndex={0}
			title="拖动或按左右方向键调整宽度，双击恢复默认"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			onDoubleClick={() =>
				target === "tool" ? store.setFilesPanelWidth(FILES_PANEL_DEFAULT_WIDTH) : store.setFilePreviewWidth(undefined)
			}
		/>
	);
}

/**
 * The panel's files, source control, terminal or subagent view of the workspace on screen, or its
 * launcher. The browser has its own page (it stays mounted while other views are on top).
 */
function ToolView({
	workspace,
	composerKey,
	active,
	hidden,
	focusRequest,
}: {
	workspace: WorkspaceInfo;
	composerKey?: string | undefined;
	/** The view is on screen. */
	active: boolean;
	/** The panel is hidden (another page replaces the main screen). */
	hidden: boolean;
	focusRequest: number;
}) {
	const tab = useAppState((s) => s.rightPanelTab);
	const subagent = useAppState((s) => s.subagentView);
	if (tab === "subagent" && subagent && subagent.sessionId === composerKey) {
		return <SubagentPanel key={`${subagent.sessionId}:${subagent.subagentId}`} workspace={workspace} {...subagent} />;
	}
	if (tab === "git") {
		return <GitPanel key={workspace.id} workspace={workspace} {...(composerKey ? { composerKey } : {})} />;
	}
	if (tab === "files") {
		return <FilesPanel key={workspace.id} workspace={workspace} {...(composerKey ? { composerKey } : {})} />;
	}
	if (tab === "browser") return null;
	// While the panel is hidden the remote hosts page may show the terminals instead; they are
	// attached here again when the panel shows.
	if (tab === "terminal") return hidden ? null : <TerminalPanel workspace={workspace} />;
	return <PanelLauncher workspace={workspace} active={active} focusRequest={focusRequest} />;
}

/**
 * The right-hand panel, laid out like a browser: a tab per view opened from its launcher (the
 * workspace's files, source control, the browser, the terminals, a subagent's conversation),
 * then one tab per opened file, so one column holds them all; `+` after the tabs shows the
 * launcher again, as does a panel with nothing open. The views and the file tabs keep separate
 * widths. In `modal` mode the file tabs show in a dialog filling the window instead. Open files
 * (with their unsaved edits) stay mounted across tab and mode switches, and while `hidden` (the
 * settings or scheduled tasks replace the main screen). `workspace` / `composerKey` are the
 * workspace and composer on screen.
 */
export function SidePanel({
	hidden = false,
	workspace,
	composerKey,
}: {
	hidden?: boolean;
	workspace?: WorkspaceInfo | undefined;
	composerKey?: string | undefined;
}) {
	const store = useStore();
	const mode = useAppState((s) => s.filePreviewMode);
	const previewWidth = useAppState((s) => s.filePreviewWidth);
	const filesWidth = useAppState((s) => s.filesPanelWidth);
	const filesPanel = useAppState((s) => s.filesPanel);
	const toolTab = useAppState((s) => s.rightPanelTab);
	const openTools = useAppState((s) => s.rightPanelTabs);
	const hasSubagent = useAppState((s) => s.subagentView !== undefined);
	const previewShown = useAppState((s) => s.filePreviewShown);
	const allTabs = useAppState((s) => s.filePreviews);
	const workspaces = useAppState((s) => s.workspaces);
	const activeId = useAppState((s) => s.activeFilePreview);
	const sidebarSpace = useAppState((s) => (s.sidebar ? s.sidebarWidth : COLLAPSED_SIDEBAR_WIDTH));
	const gitCount = useGitChangeCount(workspace?.id);
	const reserved = NAV_RAIL_WIDTH + sidebarSpace + MAIN_MIN_WIDTH;
	const shell = useRef<HTMLDivElement>(null);
	const strip = useRef<HTMLDivElement>(null);
	const ids = useId();
	/** Bumped when `+` shows the launcher, which then takes the focus. */
	const [launcherFocus, setLauncherFocus] = useState(0);

	const modal = mode === "modal";
	const tabs = allTabs.filter((tab) => workspaces.some((w) => w.id === tab.workspaceId));
	const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
	const toolOpen = filesPanel && !!workspace;
	const fileShown = previewShown && tabs.length > 0;
	const view: View = fileShown ? (modal ? "overlay" : "file") : toolOpen ? "tool" : "closed";
	/** The panel's own column: under a dialog it keeps its files / source control view, if open. */
	const sideView: View = view === "overlay" ? (toolOpen ? "tool" : "closed") : view;

	// The browser and the terminals take the room of a file tab rather than that of the files view.
	const sizeOf = (shown: "tool" | "file"): "tool" | "file" =>
		shown === "tool" && (toolTab === "browser" || toolTab === "terminal") ? "file" : shown;
	// Closing slides the panel away at its last size, with its last content.
	const lastOpen = useRef<"tool" | "file">(sideView === "file" ? "file" : "tool");
	const lastSize = useRef<"tool" | "file">(lastOpen.current);
	if (view === "tool" || view === "file") {
		lastOpen.current = view;
		lastSize.current = sizeOf(view);
	}
	const size = sideView === "tool" || sideView === "file" ? sizeOf(sideView) : lastSize.current;
	const content: View = view === "closed" ? lastOpen.current : view;
	// A dialog that closes leaves at once, not by sliding out of the panel.
	const previousView = useRef(view);
	const instant = previousView.current === "overlay" && view !== "overlay";
	useEffect(() => {
		previousView.current = view;
	});

	// The last file tabs stay on screen while the panel slides closed.
	const hasTabs = tabs.length > 0;
	const lastTabs = useRef<{ tabs: FilePreviewTab[]; active?: string | undefined }>({ tabs: [] });
	if (hasTabs) lastTabs.current = { tabs, active: active?.id };
	const [tabsMounted, setTabsMounted] = useState(hasTabs);
	useEffect(() => {
		if (hasTabs) {
			setTabsMounted(true);
			return;
		}
		const timer = setTimeout(() => setTabsMounted(false), CLOSE_MS);
		return () => clearTimeout(timer);
	}, [hasTabs]);
	const shownTabs = hasTabs ? tabs : tabsMounted && !modal ? lastTabs.current.tabs : [];
	const shownActive = hasTabs ? active?.id : lastTabs.current.active;

	// The files / source control view stays mounted (folders, scroll) while a file tab is on top,
	// and until the closing animation ends; a hidden panel neither reloads nor keeps upload questions.
	const toolLive = toolOpen && !hidden;
	const [toolMounted, setToolMounted] = useState(toolLive);
	useEffect(() => {
		if (toolLive) {
			setToolMounted(true);
			return;
		}
		const timer = setTimeout(() => setToolMounted(false), CLOSE_MS);
		return () => clearTimeout(timer);
	}, [toolLive]);

	/** Tabs with unsaved edits, as their viewers report them. */
	const [dirty, setDirty] = useState<Record<string, boolean>>({});
	/** Bumped to ask a tab's viewer to close (it offers to save unsaved edits first). */
	const [closeRequests, setCloseRequests] = useState<Record<string, number>>({});
	const reportDirty = useCallback(
		(id: string, value: boolean) => setDirty((d) => (!!d[id] === value ? d : { ...d, [id]: value })),
		[],
	);
	// Forget closed tabs, so a file opened again starts clean.
	useEffect(() => {
		const open = new Set(allTabs.map((tab) => tab.id));
		const prune = <T,>(map: Record<string, T>) =>
			Object.keys(map).every((id) => open.has(id))
				? map
				: Object.fromEntries(Object.entries(map).filter(([id]) => open.has(id)));
		setDirty(prune);
		setCloseRequests(prune);
	}, [allTabs]);

	const closeTab = (id: string) => {
		if (!dirty[id]) {
			store.closeFilePreview(id);
			return;
		}
		store.selectFilePreview(id);
		setCloseRequests((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }));
	};
	/** Close every file tab; with unsaved edits, close the others and ask about those first. */
	const closeAllFiles = () => {
		const unsaved = tabs.filter((tab) => dirty[tab.id]);
		if (!unsaved.length) {
			store.closeFilePreview();
			return;
		}
		for (const tab of tabs) if (!dirty[tab.id]) store.closeFilePreview(tab.id);
		const first = unsaved.find((tab) => tab.id === active?.id) ?? unsaved[0];
		if (first) closeTab(first.id);
	};

	const fileOnTop = content === "file" || content === "overlay";
	const selectedFile = fileOnTop ? shownActive : undefined;
	// Keep the tab on screen visible in a strip that scrolls sideways.
	useEffect(() => {
		if (!selectedFile) return;
		const tab = strip.current?.querySelector<HTMLElement>(".file-preview-tab.active");
		tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [selectedFile]);

	/** Arrow keys move along all the panel's tabs, as in a tab list. */
	const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
		const all = [...(strip.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])];
		const index = all.indexOf(e.currentTarget);
		let next: number;
		if (e.key === "ArrowLeft") next = index - 1;
		else if (e.key === "ArrowRight") next = index + 1;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = all.length - 1;
		else return;
		e.preventDefault();
		const target = all[(next + all.length) % all.length];
		target?.focus();
		target?.click();
	};

	const overlay = view === "overlay";
	const tools = !overlay && workspace ? openTools.filter((id) => id !== "subagent" || hasSubagent) : [];
	const launcherShown = content === "tool" && toolTab === "launcher";
	const browserOpen = !!workspace && openTools.includes("browser");
	const browserShown = content === "tool" && toolTab === "browser";
	// In `modal` mode file tabs live in the dialog only.
	const stripTabs = modal && !overlay ? [] : shownTabs;
	// Same names in different folders show their folder too.
	const nameCounts = new Map<string, number>();
	for (const tab of stripTabs) {
		const name = splitPath(tab.path).pop() ?? tab.path;
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}

	const style = {
		"--files-width": `${filesWidth}px`,
		...(previewWidth ? { "--preview-width": `${previewWidth}px` } : {}),
		"--preview-room": `calc(100vw - ${reserved}px)`,
	} as CSSProperties;
	return (
		<div
			ref={shell}
			className={`side-panel${instant ? " instant" : ""}`}
			data-view={sideView}
			data-size={size}
			style={style}
			hidden={hidden}
			inert={view === "closed"}
		>
			{overlay ? <div className="side-panel-backdrop" /> : null}
			<section
				className={`side-panel-window${overlay ? " overlay" : ""}`}
				aria-label={overlay ? "文件预览" : "右侧面板"}
				{...(overlay ? { role: "dialog", "aria-modal": true } : {})}
			>
				{overlay || sideView === "closed" ? null : (
					<PanelResizeHandle key={size} shell={shell} target={size} reserved={reserved} />
				)}
				<header className="side-panel-strip">
					<div
						ref={strip}
						className="side-panel-tabs"
						role="tablist"
						aria-label={overlay ? "已打开的文件" : "右侧面板"}
						onWheel={(e) => {
							if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
						}}
					>
						{tools.map((id) => {
							const { label, hint, Icon } = TOOLS[id];
							const selected = content === "tool" && toolTab === id;
							const compact = stripTabs.length > 0;
							return (
								<div
									key={id}
									className={`file-preview-tab side-panel-tool-tab${selected ? " active" : ""}${compact ? " compact" : ""}`}
								>
									<button
										type="button"
										role="tab"
										id={`${ids}-tool-${id}`}
										aria-selected={selected}
										aria-controls={`${ids}-${id === "browser" ? "browser" : "tool"}`}
										aria-label={label}
										tabIndex={selected ? 0 : -1}
										className="file-preview-tab-label"
										title={hint}
										onClick={() => store.showRightPanel(id)}
										onKeyDown={onTabKeyDown}
										onMouseDown={(e) => {
											if (e.button === 1) e.preventDefault();
										}}
										onAuxClick={(e) => {
											if (e.button !== 1) return;
											e.preventDefault();
											store.closeRightPanelTab(id);
										}}
									>
										<Icon size={14} />
										{compact ? null : <span className="file-preview-tab-name">{label}</span>}
										{id === "git" && gitCount ? (
											<span className="panel-tab-badge">{gitCount > 999 ? "999+" : gitCount}</span>
										) : null}
									</button>
									<button
										type="button"
										className="file-preview-tab-close"
										title={id === "terminal" ? "关闭，终端继续运行" : "关闭"}
										aria-label={`关闭 ${label}`}
										tabIndex={selected ? 0 : -1}
										onClick={() => store.closeRightPanelTab(id)}
									>
										<IconX size={12} />
									</button>
								</div>
							);
						})}
						{tools.length && stripTabs.length ? <span className="side-panel-divider" aria-hidden="true" /> : null}
						{stripTabs.map((tab, index) => {
							const parts = splitPath(tab.path);
							const name = parts.pop() ?? tab.path;
							const folder = (nameCounts.get(name) ?? 0) > 1 ? parts.pop() : undefined;
							const owner = workspaces.find((w) => w.id === tab.workspaceId);
							const selected = tab.id === selectedFile;
							const unsaved = !!dirty[tab.id];
							return (
								<div key={tab.id} className={`file-preview-tab${selected ? " active" : ""}${unsaved ? " dirty" : ""}`}>
									<button
										type="button"
										role="tab"
										id={`${ids}-tab-${index}`}
										aria-selected={selected}
										aria-controls={`${ids}-page-${index}`}
										tabIndex={selected ? 0 : -1}
										className="file-preview-tab-label"
										title={`${owner ? `${owner.name} · ` : ""}${tab.path}${unsaved ? "（未保存）" : ""}`}
										onClick={() => store.selectFilePreview(tab.id)}
										onKeyDown={onTabKeyDown}
										onMouseDown={(e) => {
											// Middle click closes the tab, as in a browser; no autoscroll.
											if (e.button === 1) e.preventDefault();
										}}
										onAuxClick={(e) => {
											if (e.button !== 1) return;
											e.preventDefault();
											closeTab(tab.id);
										}}
									>
										{IMAGE.test(name) ? <IconImage size={13} /> : <IconFile size={13} />}
										<span className="file-preview-tab-name">{name}</span>
										{folder ? <span className="file-preview-tab-folder">{folder}</span> : null}
									</button>
									<button
										type="button"
										className="file-preview-tab-close"
										title={unsaved ? "关闭（有未保存的修改）" : "关闭"}
										aria-label={`关闭 ${name}`}
										tabIndex={selected ? 0 : -1}
										onClick={() => closeTab(tab.id)}
									>
										<span className="file-preview-tab-dot" aria-hidden="true" />
										<IconX size={12} />
									</button>
								</div>
							);
						})}
					</div>
					{!overlay && workspace ? (
						<button
							type="button"
							id={`${ids}-launcher`}
							className={`ghost icon side-panel-new${launcherShown ? " active" : ""}`}
							title="打开面板"
							aria-label="打开面板"
							aria-pressed={launcherShown}
							onClick={() => {
								store.showRightPanelLauncher();
								setLauncherFocus((n) => n + 1);
							}}
						>
							<IconPlus size={15} />
						</button>
					) : null}
					<div className="side-panel-actions">
						{view === "file" || overlay ? (
							<button
								type="button"
								className="ghost icon"
								title={overlay ? "停靠到右侧面板" : "全屏显示"}
								onClick={() => store.setFilePreviewMode(overlay ? "panel" : "modal")}
							>
								{overlay ? <IconPanelRight size={15} /> : <IconMaximize size={15} />}
							</button>
						) : null}
						<button
							type="button"
							className="ghost icon"
							title={overlay ? (tabs.length > 1 ? "关闭全部文件" : "关闭") : "关闭面板"}
							onClick={overlay ? closeAllFiles : () => store.toggleFilesPanel(false)}
						>
							<IconX size={16} />
						</button>
					</div>
				</header>
				<div className="side-panel-body">
					<div
						className="side-panel-view"
						id={`${ids}-tool`}
						role="tabpanel"
						aria-labelledby={`${ids}-${toolTab === "launcher" ? "launcher" : `tool-${toolTab}`}`}
						hidden={content !== "tool" || browserShown}
					>
						{(toolLive || toolMounted) && workspace ? (
							<ToolView
								workspace={workspace}
								composerKey={composerKey}
								active={content === "tool" && view !== "closed" && !hidden}
								hidden={hidden}
								focusRequest={launcherFocus}
							/>
						) : null}
					</div>
					{/* The browser stays mounted under other tabs: its picture keeps streaming. */}
					{browserOpen && (toolLive || toolMounted) && workspace ? (
						<div
							className="side-panel-view browser-page"
							id={`${ids}-browser`}
							role="tabpanel"
							aria-labelledby={`${ids}-tool-browser`}
							hidden={!browserShown}
						>
							<BrowserView
								key={workspace.id}
								workspace={workspace}
								composerKey={composerKey}
								active={browserShown && view !== "closed" && !hidden}
							/>
						</div>
					) : null}
					{shownTabs.map((tab, index) => {
						const target =
							tab.composerKey && (workspace?.id === tab.workspaceId && composerKey ? composerKey : tab.composerKey);
						return (
							<div
								key={tab.id}
								id={`${ids}-page-${index}`}
								className="file-preview-page"
								role="tabpanel"
								aria-labelledby={`${ids}-tab-${index}`}
								hidden={!fileOnTop || tab.id !== shownActive}
							>
								<FileViewer
									workspaceId={tab.workspaceId}
									path={tab.path}
									fromMarkdown={tab.fromMarkdown}
									onClose={() => store.closeFilePreview(tab.id)}
									onInsert={target ? () => store.insertFileIntoComposer(target, tab.path) : undefined}
									closeOnInsert={overlay}
									onDirtyChange={(value) => reportDirty(tab.id, value)}
									closeRequest={closeRequests[tab.id] ?? 0}
								/>
							</div>
						);
					})}
				</div>
			</section>
		</div>
	);
}
