import {
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
	type FilePreviewTab,
	useAppState,
	useStore,
} from "../lib/store.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { IconFile, IconImage, IconMaximize, IconPanelRight, IconX } from "./Icons.tsx";

/** Matches the panel's width transition in file-preview.css, plus a little slack. */
const CLOSE_MS = 320;
/** The navigation rail's width (`.window-body` in statusbar.css). */
const NAV_RAIL_WIDTH = 60;
/** The conversation keeps at least this width beside the panel, while the window allows it. */
const MAIN_MIN_WIDTH = 400;
/** What a collapsed sidebar or file panel still takes: the gap beside the main panel. */
const COLLAPSED_SIDE_WIDTH = 8;

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;

function splitPath(path: string): string[] {
	return path.split(/[\\/]/).filter(Boolean);
}

/** The widest the panel may get in the current window, leaving `reserved` pixels to the rest. */
function maxPanelWidth(reserved: number): number {
	return Math.min(FILE_PREVIEW_MAX_WIDTH, Math.max(FILE_PREVIEW_MIN_WIDTH, window.innerWidth - reserved));
}

/** Drag handle on the preview panel's left edge; double click goes back to the default width. */
function PreviewResizeHandle({ shell, reserved }: { shell: RefObject<HTMLDivElement | null>; reserved: number }) {
	const store = useStore();
	const width = useAppState((s) => s.filePreviewWidth);
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
	// The panel may be narrower than the saved width in a small window: start from what is on screen.
	const current = () => Math.round(shell.current?.getBoundingClientRect().width ?? width ?? FILE_PREVIEW_MIN_WIDTH);
	const resize = (next: number) => store.setFilePreviewWidth(Math.min(maxPanelWidth(reserved), next));

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || !e.isPrimary) return;
		e.preventDefault();
		stopResize.current?.();
		const startX = e.clientX;
		const startWidth = current();
		const target = e.currentTarget;
		const pointerId = e.pointerId;
		target.setPointerCapture(pointerId);
		target.focus({ focusVisible: false });
		document.body.classList.add("resizing-preview");
		const move = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) resize(startWidth + startX - ev.clientX);
		};
		const stop = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", end);
			target.removeEventListener("pointercancel", end);
			target.removeEventListener("lostpointercapture", end);
			if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
			document.body.classList.remove("resizing-preview");
			stopResize.current = undefined;
		};
		const end = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) stop();
		};
		stopResize.current = stop;
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", end);
		target.addEventListener("pointercancel", end);
		target.addEventListener("lostpointercapture", end);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? 80 : 20;
		if (e.key === "ArrowLeft") resize(current() + step);
		else if (e.key === "ArrowRight") resize(current() - step);
		else if (e.key === "Home") resize(FILE_PREVIEW_MIN_WIDTH);
		else if (e.key === "End") resize(maxPanelWidth(reserved));
		else return;
		e.preventDefault();
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: focusable window splitter, not a thematic break.
		<div
			className="file-preview-resize"
			role="separator"
			aria-label="调整文件预览宽度"
			aria-orientation="vertical"
			aria-valuemin={FILE_PREVIEW_MIN_WIDTH}
			aria-valuemax={FILE_PREVIEW_MAX_WIDTH}
			aria-valuenow={measured ?? width ?? FILE_PREVIEW_MIN_WIDTH}
			tabIndex={0}
			title="拖动或按左右方向键调整宽度，双击恢复默认"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			onDoubleClick={() => store.setFilePreviewWidth(undefined)}
		/>
	);
}

/**
 * The files opened for preview, one browser-like tab each. In `panel` mode they sit in a
 * resizable panel on the window's right, beside the conversation; in `modal` mode in a dialog
 * filling the window. Switching modes keeps every tab (and its unsaved edits) mounted, and so
 * does `hidden`, used while the settings or scheduled tasks replace the main screen.
 * `screenWorkspaceId` / `screenComposerKey` describe the composer on screen: a tab's
 * "insert" button targets it when it belongs to the tab's workspace.
 */
export function FilePreview({
	hidden = false,
	screenWorkspaceId,
	screenComposerKey,
}: {
	hidden?: boolean;
	screenWorkspaceId?: string | undefined;
	screenComposerKey?: string | undefined;
}) {
	const store = useStore();
	const mode = useAppState((s) => s.filePreviewMode);
	const width = useAppState((s) => s.filePreviewWidth);
	const allTabs = useAppState((s) => s.filePreviews);
	const workspaces = useAppState((s) => s.workspaces);
	const activeId = useAppState((s) => s.activeFilePreview);
	// Room for the rail, the sidebar, the conversation and the file panel (as App lays them out).
	const sidebarSpace = useAppState((s) => (s.sidebar ? s.sidebarWidth : COLLAPSED_SIDE_WIDTH));
	const filesSpace = useAppState((s) =>
		s.filesPanel && s.workspaces.length > 0 ? s.filesPanelWidth : COLLAPSED_SIDE_WIDTH,
	);
	const reserved = NAV_RAIL_WIDTH + sidebarSpace + MAIN_MIN_WIDTH + filesSpace;
	const tabs = allTabs.filter((tab) => workspaces.some((w) => w.id === tab.workspaceId));
	const open = tabs.length > 0;
	const shell = useRef<HTMLDivElement>(null);
	const strip = useRef<HTMLDivElement>(null);
	const ids = useId();

	// The panel slides closed with its last tabs still on screen.
	const last = useRef<{ tabs: FilePreviewTab[]; active?: string | undefined }>({ tabs: [] });
	const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
	if (open) last.current = { tabs, active: active?.id };
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		const timer = setTimeout(() => setMounted(false), CLOSE_MS);
		return () => clearTimeout(timer);
	}, [open]);
	const shown = open ? tabs : mounted && mode === "panel" ? last.current.tabs : [];
	const shownActive = open ? active?.id : last.current.active;

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
	/** Close every tab; with unsaved edits, close the others and ask about those first. */
	const closeAll = () => {
		const unsaved = tabs.filter((tab) => dirty[tab.id]);
		if (!unsaved.length) {
			store.closeFilePreview();
			return;
		}
		for (const tab of tabs) if (!dirty[tab.id]) store.closeFilePreview(tab.id);
		const first = unsaved.find((tab) => tab.id === active?.id) ?? unsaved[0];
		if (first) closeTab(first.id);
	};

	// Keep the tab on screen visible in a strip that scrolls sideways.
	useEffect(() => {
		if (!shownActive) return;
		const tab = strip.current?.querySelector<HTMLElement>(".file-preview-tab.active");
		tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [shownActive]);

	const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
		let next: number;
		if (e.key === "ArrowLeft") next = index - 1;
		else if (e.key === "ArrowRight") next = index + 1;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = shown.length - 1;
		else return;
		e.preventDefault();
		const tab = shown[(next + shown.length) % shown.length];
		if (!tab) return;
		store.selectFilePreview(tab.id);
		strip.current?.querySelectorAll<HTMLElement>("[role=tab]")[shown.indexOf(tab)]?.focus();
	};

	// Same names in different folders show their folder too.
	const nameCounts = new Map<string, number>();
	for (const tab of shown) {
		const name = splitPath(tab.path).pop() ?? tab.path;
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}

	const modal = mode === "modal";
	const style = {
		...(width ? { "--preview-width": `${width}px` } : {}),
		"--preview-room": `calc(100vw - ${reserved}px)`,
	} as CSSProperties;
	return (
		<div
			ref={shell}
			className={`file-preview${open ? "" : " collapsed"}`}
			data-mode={mode}
			style={style}
			hidden={hidden}
			inert={!open}
		>
			{shown.length ? (
				<section
					className="file-preview-window"
					aria-label="文件预览"
					{...(modal ? { role: "dialog", "aria-modal": true } : {})}
				>
					{modal ? null : <PreviewResizeHandle shell={shell} reserved={reserved} />}
					<header className="file-preview-header">
						<div
							ref={strip}
							className="file-preview-tabs"
							role="tablist"
							aria-label="已打开的文件"
							onWheel={(e) => {
								if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
							}}
						>
							{shown.map((tab, index) => {
								const parts = splitPath(tab.path);
								const name = parts.pop() ?? tab.path;
								const folder = (nameCounts.get(name) ?? 0) > 1 ? parts.pop() : undefined;
								const workspace = workspaces.find((w) => w.id === tab.workspaceId);
								const selected = tab.id === shownActive;
								const unsaved = !!dirty[tab.id];
								return (
									<div
										key={tab.id}
										className={`file-preview-tab${selected ? " active" : ""}${unsaved ? " dirty" : ""}`}
									>
										<button
											type="button"
											role="tab"
											id={`${ids}-tab-${index}`}
											aria-selected={selected}
											aria-controls={`${ids}-page-${index}`}
											tabIndex={selected ? 0 : -1}
											className="file-preview-tab-label"
											title={`${workspace ? `${workspace.name} · ` : ""}${tab.path}${unsaved ? "（未保存）" : ""}`}
											onClick={() => store.selectFilePreview(tab.id)}
											onKeyDown={(e) => onTabKeyDown(e, index)}
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
						<div className="file-preview-header-actions">
							<button
								type="button"
								className="ghost icon"
								title={modal ? "停靠到右侧面板" : "全屏显示"}
								onClick={() => store.setFilePreviewMode(modal ? "panel" : "modal")}
							>
								{modal ? <IconPanelRight size={15} /> : <IconMaximize size={15} />}
							</button>
							<button
								type="button"
								className="ghost icon"
								title={shown.length > 1 ? "关闭全部文件" : "关闭"}
								onClick={closeAll}
							>
								<IconX size={16} />
							</button>
						</div>
					</header>
					<div className="file-preview-pages">
						{shown.map((tab, index) => {
							const target =
								tab.composerKey &&
								(screenWorkspaceId === tab.workspaceId && screenComposerKey ? screenComposerKey : tab.composerKey);
							return (
								<div
									key={tab.id}
									id={`${ids}-page-${index}`}
									className="file-preview-page"
									role="tabpanel"
									aria-labelledby={`${ids}-tab-${index}`}
									hidden={tab.id !== shownActive}
								>
									<FileViewer
										workspaceId={tab.workspaceId}
										path={tab.path}
										fromMarkdown={tab.fromMarkdown}
										onClose={() => store.closeFilePreview(tab.id)}
										onInsert={target ? () => store.insertFileIntoComposer(target, tab.path) : undefined}
										closeOnInsert={modal}
										onDirtyChange={(value) => reportDirty(tab.id, value)}
										closeRequest={closeRequests[tab.id] ?? 0}
									/>
								</div>
							);
						})}
					</div>
				</section>
			) : null}
		</div>
	);
}
