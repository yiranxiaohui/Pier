import "@xterm/xterm/css/xterm.css";
import type { WorkspaceInfo } from "@pier/protocol";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef } from "react";
import { TERMINAL_DEFAULT_HEIGHT, type TerminalTab, terminalLabel, terminals, useTerminals } from "../lib/terminals.ts";
import { IconChevronDown, IconPlus, IconTerminal, IconTrash, IconX } from "./Icons.tsx";

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
	const parts = [tab.title, tab.cwd].filter(Boolean);
	if (tab.status === "exited") parts.push(tab.exitCode === null ? "已结束" : `已退出（${tab.exitCode}）`);
	if (tab.status === "failed") parts.push("启动失败");
	return parts.join("\n") || terminalLabel(tab);
}

/**
 * Bottom panel with the integrated terminals. `workspace` is where new terminals start
 * (the workspace on screen).
 */
export function TerminalPanel({ workspace }: { workspace?: WorkspaceInfo }) {
	const { tabs, active, height } = useTerminals((s) => s);
	const body = useRef<HTMLDivElement>(null);

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

	const newTerminal = () => terminals.create(workspace ? { workspace } : {});
	return (
		<section className="terminal-panel" style={{ height }} aria-label="终端">
			<ResizeHandle />
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
						title={workspace ? `新建终端（${workspace.name}）` : "新建终端"}
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
					<button
						type="button"
						className="ghost icon"
						title="隐藏终端面板（Ctrl+`），终端继续运行"
						onClick={() => terminals.toggle({}, false)}
					>
						<IconChevronDown size={14} />
					</button>
				</div>
			</header>
			<div className="terminal-body" ref={body} />
		</section>
	);
}

/** Header button that shows or hides the terminal panel. */
export function TerminalToggle({ workspace }: { workspace?: WorkspaceInfo | undefined }) {
	const open = useTerminals((s) => s.open);
	if (!terminals.supported) return null;
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
