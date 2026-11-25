import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

export interface ContextMenuAction {
	label: string;
	icon?: ReactNode;
	/** Right-aligned secondary text, e.g. a shortcut. */
	hint?: string;
	disabled?: boolean;
	danger?: boolean;
	onSelect(): void;
}

/** `"separator"` draws a divider; falsy entries are skipped so callers can inline conditions. */
export type ContextMenuItem = ContextMenuAction | "separator" | false | null | undefined;

export interface ContextMenuPosition {
	x: number;
	y: number;
	/**
	 * The element the menu was opened on. Only scrolling one of its scroll containers closes
	 * the menu; scrolling elsewhere (e.g. the chat transcript auto-scrolling) leaves it open.
	 */
	anchor?: Element;
}

/**
 * The position for a `contextmenu` event: the pointer, or (for the keyboard menu key /
 * Shift+F10, which report 0,0 in some engines) the lower left of the target element.
 */
export function contextMenuPosition(event: { clientX: number; clientY: number; currentTarget: Element }) {
	const anchor = event.currentTarget;
	if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY, anchor };
	const rect = anchor.getBoundingClientRect();
	return { x: rect.left + 12, y: rect.bottom, anchor };
}

const MARGIN = 6;

/** Drops skipped entries and leading, trailing or repeated separators. */
function normalize(items: ContextMenuItem[]): (ContextMenuAction | "separator")[] {
	const out: (ContextMenuAction | "separator")[] = [];
	for (const item of items) {
		if (!item) continue;
		if (item === "separator" && (!out.length || out[out.length - 1] === "separator")) continue;
		out.push(item);
	}
	if (out[out.length - 1] === "separator") out.pop();
	return out;
}

/** A pointer-positioned menu rendered in a portal; closes on outside click, Escape, scroll, blur or resize. */
export function ContextMenu({
	position,
	items,
	label,
	stayOnScroll = false,
	onClose,
}: {
	position: ContextMenuPosition;
	items: ContextMenuItem[];
	label?: string;
	/**
	 * Stay open when the anchor's scroll containers scroll, for anchors in a chat transcript,
	 * which scrolls by itself while an agent replies.
	 */
	stayOnScroll?: boolean;
	onClose(): void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<ContextMenuPosition>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const anchorRef = useRef(position.anchor);
	anchorRef.current = position.anchor;
	const stayOnScrollRef = useRef(stayOnScroll);
	stayOnScrollRef.current = stayOnScroll;
	const entries = normalize(items);

	// Keep the menu inside the window: flip it left/up when it would overflow.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		let x = position.x;
		let y = position.y;
		if (x + width > window.innerWidth - MARGIN) x = Math.max(MARGIN, x - width);
		if (y + height > window.innerHeight - MARGIN) y = Math.max(MARGIN, window.innerHeight - MARGIN - height);
		setPlaced({ x, y });
	}, [position.x, position.y]);

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const close = () => onCloseRef.current();
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			close();
		};
		const onPointerDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) close();
		};
		const onScroll = (e: Event) => {
			const target = e.target as Node;
			if (stayOnScrollRef.current || ref.current?.contains(target)) return;
			// Unrelated scroll containers (another pane re-laying out) must not dismiss the menu.
			const anchor = anchorRef.current;
			if (anchor && !target.contains?.(anchor)) return;
			close();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("scroll", onScroll, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", close);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("scroll", onScroll, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("blur", close);
			window.removeEventListener("resize", close);
			// Return focus to where it was (e.g. the tree row) unless the action moved it elsewhere.
			if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
				previous.focus({ preventScroll: true });
			}
		};
	}, []);

	// Focus the first item once the menu is placed (it is hidden, hence unfocusable, before).
	useEffect(() => {
		if (placed) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
	}, [placed]);

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const move = (next: number) => buttons[(next + buttons.length) % buttons.length]?.focus();
		if (e.key === "ArrowDown") move(index + 1);
		else if (e.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
		else if (e.key === "Home") move(0);
		else if (e.key === "End") move(-1);
		else if (e.key === "Tab") onClose();
		else return;
		e.preventDefault();
		e.stopPropagation();
	};

	return createPortal(
		<div
			ref={ref}
			className="dropdown-menu context-menu"
			role="menu"
			aria-label={label}
			tabIndex={-1}
			style={{
				left: (placed ?? position).x,
				top: (placed ?? position).y,
				...(placed ? {} : { visibility: "hidden" }),
			}}
			onKeyDown={onKeyDown}
			onContextMenu={(e) => e.preventDefault()}
		>
			{entries.map((item, i) =>
				item === "separator" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity.
					<hr key={`sep-${i}`} className="context-menu-separator" />
				) : (
					<button
						key={item.label}
						type="button"
						role="menuitem"
						className={`dropdown-item${item.danger ? " danger" : ""}`}
						disabled={item.disabled}
						onClick={() => {
							onClose();
							item.onSelect();
						}}
					>
						<span className="menu-label">
							{item.icon}
							{item.label}
						</span>
						{item.hint ? <span className="context-menu-hint">{item.hint}</span> : null}
					</button>
				),
			)}
		</div>,
		document.body,
	);
}
