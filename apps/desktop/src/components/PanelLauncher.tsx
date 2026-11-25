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
	id: RightPanelTab;
	label: string;
	/** Pressed on its own (no modifier) while the launcher is on screen. */
	shortcut: string;
	hint: string;
	Icon: ComponentType<{ size?: number }>;
	disabled?: boolean;
	badge?: number | undefined;
	run(): void;
}

/**
 * The right-hand panel's launcher (`+` after its tabs, and the panel with no tab open): what
 * can be opened for the workspace on screen, each as a tab of the panel (files, source control,
 * the browser, the terminals). Each item has a one-letter shortcut while the launcher is on
 * screen (`active`), unless the letter is being typed.
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
	const terminalCount = useTerminals((s) => s.tabs.length);
	const openTabs = useAppState((s) => s.rightPanelTabs);
	const root = useRef<HTMLDivElement>(null);

	const items: LauncherItem[] = [
		{
			id: "files",
			label: "文件",
			shortcut: "F",
			hint: "工作区文件（Ctrl/⌘+Shift+E）",
			Icon: IconFolder,
			run: () => store.showRightPanel("files"),
		},
		{
			id: "git",
			label: "源代码管理",
			shortcut: "G",
			hint: "Git 更改、提交与分支（Ctrl/⌘+Shift+G）",
			Icon: IconGitBranch,
			badge: gitCount,
			run: () => store.showRightPanel("git"),
		},
		{
			id: "browser",
			label: "浏览器",
			shortcut: "B",
			hint: "工作区所在电脑的浏览器：打开网页，选取元素或标注截图发给 Agent",
			Icon: IconBrowser,
			run: () => store.showRightPanel("browser"),
		},
		{
			id: "terminal",
			label: "终端",
			shortcut: "T",
			hint: canOpenTerminal ? "工作区所在电脑的终端（Ctrl+`）" : "这台电脑上无法打开终端",
			Icon: IconTerminal,
			// Running terminals, also while their tab is closed.
			badge: terminalCount,
			disabled: !canOpenTerminal && !terminalCount,
			// Shows the open terminals, or opens one when there is none.
			run: () => terminals.toggle({ workspace }, true),
		},
	];

	const launch = (item: LauncherItem) => {
		if (!item.disabled) item.run();
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
						const opened = openTabs.includes(item.id);
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
