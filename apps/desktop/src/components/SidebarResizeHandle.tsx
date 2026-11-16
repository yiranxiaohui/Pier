import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useAppState, useStore } from "../lib/store.tsx";

/** Resize the workspace sidebar from its right edge; keep drag cleanup across renders. */
export function SidebarResizeHandle() {
	const store = useStore();
	const width = useAppState((s) => s.sidebarWidth);
	const stopResize = useRef<(() => void) | undefined>(undefined);
	useEffect(() => () => stopResize.current?.(), []);

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || !e.isPrimary) return;
		e.preventDefault();
		stopResize.current?.();
		const startX = e.clientX;
		const startWidth = width;
		const target = e.currentTarget;
		const pointerId = e.pointerId;
		target.setPointerCapture(pointerId);
		// Focused for the arrow keys, but marked only for keyboard focus: the composer usually has
		// focus, and taking it from there would otherwise count as keyboard focus.
		target.focus({ focusVisible: false });
		document.body.classList.add("resizing-sidebar");
		const move = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) store.setSidebarWidth(startWidth + ev.clientX - startX);
		};
		const stop = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", end);
			target.removeEventListener("pointercancel", end);
			target.removeEventListener("lostpointercapture", end);
			if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
			document.body.classList.remove("resizing-sidebar");
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
		const step = e.shiftKey ? 40 : 10;
		let nextWidth: number;
		switch (e.key) {
			case "ArrowLeft":
				nextWidth = width - step;
				break;
			case "ArrowRight":
				nextWidth = width + step;
				break;
			case "Home":
				nextWidth = SIDEBAR_MIN_WIDTH;
				break;
			case "End":
				nextWidth = SIDEBAR_MAX_WIDTH;
				break;
			default:
				return;
		}
		e.preventDefault();
		store.setSidebarWidth(nextWidth);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: focusable window splitter, not a thematic break.
		<div
			className="sidebar-resize"
			role="separator"
			aria-label="调整侧边栏宽度"
			aria-controls="workspace-sidebar"
			aria-orientation="vertical"
			aria-valuemin={SIDEBAR_MIN_WIDTH}
			aria-valuemax={SIDEBAR_MAX_WIDTH}
			aria-valuenow={width}
			tabIndex={0}
			title="拖动或按左右方向键调整宽度，双击恢复默认"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			onDoubleClick={() => store.setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
		/>
	);
}
