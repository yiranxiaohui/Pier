import type { WorkspaceInfo } from "@pier/protocol";
import { type ComponentType, type KeyboardEvent, useEffect, useRef } from "react";
import { useCanOpenTerminal } from "../lib/remote-terminals.ts";
import { type RightPanelTab, useAppState, useStore } from "../lib/store.tsx";
import { terminals, useTerminals } from "../lib/terminals.ts";
import { IconBrowser, IconFolder, IconGitBranch, IconTerminal } from "./Icons.tsx";
import { useGitChangeCount } from "./PanelChrome.tsx";

/** Where a letter is text, not a shortcut: fields, editors (Monaco, CodeMirror) and terminals. */
const EDITING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, .monaco-editor';

interface LauncherItem {
	id: string;
	label: string;
	/** Pressed on its own (no modifier) while the launcher is on screen. */
	shortcut: string;
	hint: string;
	Icon: ComponentType<{ size?: number }>;
	disabled?: boolean;
	badge?: number | undefined;
	/** Shown as a tab of the panel (true), or opened elsewhere: then the launcher steps aside. */
	inPanel: boolean;
	run(): void;
}

/**
 * The right-hand panel's launcher (`+` after its tabs, and the panel with no tab open): what
 * can be opened for the workspace on screen. Files, source control and the browser open as tabs
 * of the panel; the terminal opens the bottom panel, and then the launcher gives way to the
 * panel's last view, or hides an empty panel. Each item has a one-letter shortcut while the
 * launcher is on screen (`active`), unless the letter is being typed.
 */
export function PanelLauncher({
	workspace,
	active,
	focusRequest,
}: {
	workspace: WorkspaceInfo;
	active: boolean;
	/** Bumped to move the focus to the first item (the launcher was opened from the keyboard or `+`). */
	focusRequest: number;
}) {
	const store = useStore();
	const gitCount = useGitChangeCount(workspace.id);
	const canOpenTerminal = useCanOpenTerminal(workspace);
	const hasTerminals = useTerminals((s) => s.tabs.length > 0);
	const terminalOpen = useTerminals((s) => s.open);
	const openTabs = useAppState((s) => s.rightPanelTabs);
	const root = useRef<HTMLDivElement>(null);

	/** After opening something outside the panel: back to its last view, or hide it when empty. */
	const stepAside = () => {
		const state = store.getState();
		const last = state.rightPanelTabs[state.rightPanelTabs.length - 1];
		const file = state.filePreviewMode === "panel" ? state.activeFilePreview : undefined;
		if (last) store.showRightPanel(last);
		else if (file) store.selectFilePreview(file);
		else store.toggleFilesPanel(false);
	};

	const items: LauncherItem[] = [
		{
			id: "files",
			label: "文件",
			shortcut: "F",
			hint: "工作区文件（Ctrl/⌘+Shift+E）",
			Icon: IconFolder,
			inPanel: true,
			run: () => store.showRightPanel("files"),
		},
		{
			id: "git",
			label: "源代码管理",
			shortcut: "G",
			hint: "Git 更改、提交与分支（Ctrl/⌘+Shift+G）",
			Icon: IconGitBranch,
			badge: gitCount,
			inPanel: true,
			run: () => store.showRightPanel("git"),
		},
		{
			id: "browser",
			label: "浏览器",
			shortcut: "B",
			hint: "工作区所在电脑的浏览器：打开网页，选取元素或标注截图发给 Agent",
			Icon: IconBrowser,
			inPanel: true,
			run: () => store.showRightPanel("browser"),
		},
		{
			id: "terminal",
			label: "终端",
			shortcut: "T",
			hint: canOpenTerminal ? "在底部面板打开终端（Ctrl+`）" : "这台电脑上无法打开终端",
			Icon: IconTerminal,
			disabled: !canOpenTerminal && !hasTerminals,
			inPanel: false,
			run: () => {
				if (!terminalOpen) terminals.toggle({ workspace }, true);
				else if (canOpenTerminal) terminals.create({ workspace });
			},
		},
	];

	const launch = (item: LauncherItem) => {
		if (item.disabled) return;
		item.run();
		if (!item.inPanel) stepAside();
	};

	const buttons = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];

	// biome-ignore lint/correctness/useExhaustiveDependencies: focus only when asked again.
	useEffect(() => {
		if (focusRequest && active) buttons()[0]?.focus();
	}, [focusRequest]);

	// The letters work wherever nothing is being typed, and no dialog or menu is open.
	const launchRef = useRef(launch);
	launchRef.current = launch;
	const itemsRef = useRef(items);
	itemsRef.current = items;
	useEffect(() => {
		if (!active) return;
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented || e.isComposing) return;
			const target = e.target instanceof Element ? e.target : null;
			if (target?.closest(EDITING)) return;
			if (document.querySelector(".modal-backdrop, .side-panel-backdrop, [role=menu], [role=listbox]")) return;
			const item = itemsRef.current.find((i) => i.shortcut.toLowerCase() === e.key.toLowerCase());
			if (!item || item.disabled) return;
			e.preventDefault();
			launchRef.current(item);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);

	/** Up and down move between the items, as in a menu. */
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const all = buttons();
		const index = all.indexOf(document.activeElement as HTMLButtonElement);
		let next: number;
		if (e.key === "ArrowDown") next = index + 1;
		else if (e.key === "ArrowUp") next = index < 0 ? all.length - 1 : index - 1;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = all.length - 1;
		else return;
		e.preventDefault();
		all[(next + all.length) % all.length]?.focus();
	};

	return (
		<div className="panel-launcher" ref={root}>
			<div className="panel-launcher-card">
				<h2 className="panel-launcher-title" title={workspace.path}>
					打开面板
				</h2>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the buttons inside. */}
				<div className="panel-launcher-items" onKeyDown={onKeyDown}>
					{items.map((item) => {
						const opened = item.inPanel && openTabs.includes(item.id as RightPanelTab);
						return (
							<button
								key={item.id}
								type="button"
								className="panel-launcher-item"
								title={item.hint}
								disabled={item.disabled}
								aria-keyshortcuts={item.shortcut}
								onClick={() => launch(item)}
							>
								<item.Icon size={16} />
								<span className="panel-launcher-label">{item.label}</span>
								{opened ? <span className="panel-launcher-opened">已打开</span> : null}
								{item.badge ? <span className="panel-tab-badge">{item.badge > 999 ? "999+" : item.badge}</span> : null}
								<kbd>{item.shortcut}</kbd>
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
