import "@xterm/xterm/css/xterm.css";
import type { WorkspaceInfo } from "@pier/protocol";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCanOpenTerminal } from "../lib/remote-terminals.ts";
import {
	TERMINAL_DEFAULT_HEIGHT,
	TERMINAL_SHORTCUTS,
	type TerminalTab,
	terminalLabel,
	terminals,
	useTerminals,
} from "../lib/terminals.ts";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import {
	IconChevronDown,
	IconCopy,
	IconPaste,
	IconPlus,
	IconSelectAll,
	IconTerminal,
	IconTrash,
	IconX,
} from "./Icons.tsx";

function ResizeHandle() {
	const height = useTerminals((s) => s.height);
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startY = e.clientY;
		const startHeight = height;
		const target = e.currentTarget;
		target.setPointerCapture(e.pointerId);
		document.body.classList.add("resizing-terminal");
		const move = (ev: PointerEvent) => terminals.setHeight(startHeight + (startY - ev.clientY));
		const up = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", up);
			target.removeEventListener("pointercancel", up);
			document.body.classList.remove("resizing-terminal");
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", up);
		target.addEventListener("pointercancel", up);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize affordance; height also persists.
		<div
			className="terminal-resize"
			title="拖动调整高度，双击恢复默认"
			onPointerDown={onPointerDown}
			onDoubleClick={() => terminals.setHeight(TERMINAL_DEFAULT_HEIGHT)}
		/>
	);
}

function tabTitle(tab: TerminalTab): string {
	const parts = [tab.title, tab.hostName ? `${tab.hostName}：${tab.cwd ?? "~"}` : tab.cwd].filter(Boolean);
	if (tab.status === "exited") parts.push(tab.exitCode === null ? "已结束" : `已退出（${tab.exitCode}）`);
	if (tab.status === "failed") parts.push("启动失败");
	return parts.join("\n") || terminalLabel(tab);
}

/** The terminal's right-click menu: the webview's own is suppressed app-wide (see `main.tsx`). */
function terminalMenu(tab: TerminalTab, selection: boolean): ContextMenuItem[] {
	const ended = tab.status === "exited" || tab.status === "failed";
	return [
		{
			label: "复制",
			icon: <IconCopy size={14} />,
			hint: TERMINAL_SHORTCUTS.copy,
			disabled: !selection,
			onSelect: () => terminals.copySelection(tab.key),
		},
		{
			label: "粘贴",
			icon: <IconPaste size={14} />,
			hint: TERMINAL_SHORTCUTS.paste,
			disabled: ended,
			onSelect: () => terminals.paste(tab.key),
		},
		{ label: "全选", icon: <IconSelectAll size={14} />, onSelect: () => terminals.selectAll(tab.key) },
		"separator",
		{
			label: "清屏",
			icon: <IconTrash size={14} />,
			...(TERMINAL_SHORTCUTS.clear ? { hint: TERMINAL_SHORTCUTS.clear } : {}),
			onSelect: () => terminals.clear(tab.key),
		},
	];
}

/**
 * Bottom panel with the integrated terminals. `workspace` is where new terminals start
 * (the workspace on screen).
 */
export function TerminalPanel({ workspace, node }: { workspace?: WorkspaceInfo; node?: string }) {
	const state = useTerminals((s) => s);
	const tabs = node ? state.tabs.filter((tab) => tab.node === node) : state.tabs;
	const active = tabs.find((tab) => tab.key === state.active)?.key ?? tabs.at(-1)?.key;
	const body = useRef<HTMLDivElement>(null);
	const canOpen = useCanOpenTerminal(workspace, node);
	const [menu, setMenu] = useState<{ position: ContextMenuPosition; key: string; selection: boolean }>();
	const menuTab = menu && tabs.find((tab) => tab.key === menu.key);

	useLayoutEffect(() => {
		if (active && body.current) terminals.attach(active, body.current);
	}, [active]);

	// Follow panel and window size changes.
	useEffect(() => {
		const element = body.current;
		if (!element || !active) return;
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => terminals.fit(active));
		});
		observer.observe(element);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [active]);

	const newTerminal = () => terminals.create(node ? { node } : workspace ? { workspace } : {});
	return (
		<section className="terminal-panel" style={node ? undefined : { height: state.height }} aria-label="终端">
			{node ? null : <ResizeHandle />}
			<header className="terminal-header">
				<div className="terminal-tabs" role="tablist">
					{tabs.map((tab) => (
						<div
							key={tab.key}
							className={`terminal-tab${tab.key === active ? " active" : ""}${tab.status === "exited" || tab.status === "failed" ? " ended" : ""}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={tab.key === active}
								className="terminal-tab-label"
								title={tabTitle(tab)}
								onClick={() => terminals.select(tab.key)}
								onAuxClick={(e) => {
									if (e.button === 1) terminals.close(tab.key);
								}}
							>
								<IconTerminal size={13} />
								<span>{terminalLabel(tab)}</span>
							</button>
							<button
								type="button"
								className="ghost icon terminal-tab-close"
								title="关闭终端"
								onClick={() => terminals.close(tab.key)}
							>
								<IconX size={12} />
							</button>
						</div>
					))}
				</div>
				<div className="terminal-actions">
					<button
						type="button"
						className="ghost icon"
						title={
							!canOpen
								? "这个工作区所在的电脑暂时不能打开终端"
								: workspace
									? `新建终端（${workspace.name}）`
									: "新建终端"
						}
						disabled={!canOpen}
						onClick={newTerminal}
					>
						<IconPlus size={14} />
					</button>
					<button
						type="button"
						className="ghost icon"
						title="清屏"
						disabled={!active}
						onClick={() => {
							if (active) {
								terminals.clear(active);
								terminals.focus(active);
							}
						}}
					>
						<IconTrash size={14} />
					</button>
					{!node && (
						<button
							type="button"
							className="ghost icon"
							title="隐藏终端面板（Ctrl+`），终端继续运行"
							onClick={() => terminals.toggle({}, false)}
						>
							<IconChevronDown size={14} />
						</button>
					)}
				</div>
			</header>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the terminal (xterm's focused textarea) takes the keyboard; this only opens its context menu. */}
			<div
				className="terminal-body"
				ref={body}
				key={active ?? "empty"}
				onContextMenu={(event) => {
					if (!active) return;
					event.preventDefault();
					setMenu({
						position: contextMenuPosition(event),
						key: active,
						selection: terminals.hasSelection(active),
					});
				}}
			/>
			{menu && menuTab ? (
				<ContextMenu
					label="终端"
					position={menu.position}
					items={terminalMenu(menuTab, menu.selection)}
					onClose={() => setMenu(undefined)}
				/>
			) : null}
			{node && !tabs.length && (
				<div className="host-shell-empty">
					<IconTerminal size={26} />
					{canOpen ? (
						<button type="button" className="primary" onClick={newTerminal}>
							新建 Shell 终端
						</button>
					) : (
						<p>此主机暂时无法启动终端，请检查连接和 Host 的终端支持。</p>
					)}
				</div>
			)}
		</section>
	);
}

/** Header button that shows or hides the terminal panel. */
export function TerminalToggle({ workspace }: { workspace?: WorkspaceInfo | undefined }) {
	const open = useTerminals((s) => s.open);
	const hasTabs = useTerminals((s) => s.tabs.length > 0);
	const canOpen = useCanOpenTerminal(workspace);
	if (!canOpen && !hasTabs) return null;
	return (
		<button
			type="button"
			className={`chip icon-chip${open ? " active" : ""}`}
			title={open ? "隐藏终端（Ctrl+`）" : "打开终端（Ctrl+`）"}
			aria-pressed={open}
			onClick={() => terminals.toggle(workspace ? { workspace } : {})}
		>
			<IconTerminal size={15} />
		</button>
	);
}
