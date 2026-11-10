import { type PointerEvent as ReactPointerEvent, useSyncExternalStore } from "react";
import { FILES_PANEL_DEFAULT_WIDTH, type RightPanelTab, useAppState, useStore } from "../lib/store.tsx";

/** Changed-path counts last seen per workspace, for the source control tab's badge. */
const changeCounts = new Map<string, number>();
const countListeners = new Set<() => void>();

export function setGitChangeCount(workspaceId: string, count: number | undefined): void {
	if (changeCounts.get(workspaceId) === count) return;
	if (count === undefined) changeCounts.delete(workspaceId);
	else changeCounts.set(workspaceId, count);
	for (const listener of countListeners) listener();
}

function useGitChangeCount(workspaceId: string): number | undefined {
	return useSyncExternalStore(
		(listener) => {
			countListeners.add(listener);
			return () => countListeners.delete(listener);
		},
		() => changeCounts.get(workspaceId),
	);
}

/** Drag handle on the right panel's left edge; double click restores the default width. */
export function ResizeHandle() {
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
			onDoubleClick={() => store.setFilesPanelWidth(FILES_PANEL_DEFAULT_WIDTH)}
		/>
	);
}

const TABS: Array<{ id: RightPanelTab; label: string; hint: string }> = [
	{ id: "files", label: "文件", hint: "工作区文件（Ctrl/⌘+Shift+E）" },
	{ id: "git", label: "源代码管理", hint: "Git 源代码管理（Ctrl/⌘+Shift+G）" },
];
const SUBAGENT_TAB = { id: "subagent" as const, label: "Subagent", hint: "Subagent 的对话" };

/** The right panel's view switcher (files / source control) with the workspace name below. */
export function PanelHeading({
	workspaceId,
	name,
	title,
}: {
	workspaceId: string;
	name: string;
	/** Tooltip of the workspace name, e.g. its path. */
	title: string;
}) {
	const store = useStore();
	const tab = useAppState((s) => s.rightPanelTab);
	const subagent = useAppState((s) => s.subagentView !== undefined);
	const count = useGitChangeCount(workspaceId);
	const tabs = subagent ? [...TABS, SUBAGENT_TAB] : TABS;
	return (
		<div className="files-heading">
			<div className="panel-tabs" role="tablist" aria-label="右侧面板">
				{tabs.map((t) => (
					<button
						key={t.id}
						type="button"
						role="tab"
						aria-selected={tab === t.id}
						className={`panel-tab${tab === t.id ? " active" : ""}`}
						title={t.hint}
						onClick={() => store.showRightPanel(t.id)}
					>
						{t.label}
						{t.id === "git" && count ? <span className="panel-tab-badge">{count > 999 ? "999+" : count}</span> : null}
					</button>
				))}
			</div>
			<span className="files-workspace" title={title}>
				{name}
			</span>
		</div>
	);
}
