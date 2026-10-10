import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "./Icons.tsx";

export interface SelectOption<T> {
	value: T;
	label: ReactNode;
	disabled?: boolean;
}

/** A titled run of options, like an `<optgroup>`. */
export interface SelectGroup<T> {
	label: string;
	options: SelectOption<T>[];
}

export type SelectEntry<T> = SelectOption<T> | SelectGroup<T>;

const MARGIN = 6;
const GAP = 4;
const MAX_HEIGHT = 320;

function isGroup<T>(entry: SelectEntry<T>): entry is SelectGroup<T> {
	return "options" in entry;
}

/**
 * A drop-down in place of `<select>`: the native list is drawn by the OS (and differs per
 * platform), so this one opens the app's own menu in a portal.
 */
export function Select<T extends string | number>({
	value,
	options,
	onChange,
	disabled,
	title,
	className,
	ariaLabel,
}: {
	value: T;
	options: SelectEntry<T>[];
	onChange(value: NoInfer<T>): void;
	disabled?: boolean;
	title?: string;
	className?: string;
	ariaLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const flat = options.flatMap((entry) => (isGroup(entry) ? entry.options : [entry]));
	const current = flat.find((option) => option.value === value);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const close = (refocus: boolean) => {
		setOpen(false);
		if (refocus) triggerRef.current?.focus({ preventScroll: true });
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={`select${open ? " open" : ""}${className ? ` ${className}` : ""}`}
				disabled={disabled}
				title={title}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				onKeyDown={(e) => {
					if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
					e.preventDefault();
					setOpen(true);
				}}
			>
				{/* Every label shares one grid cell, so the button is as wide as the longest (like a native select). */}
				<span className="select-value">
					{flat.map((option) => (
						<span key={String(option.value)} className={option === current ? undefined : "select-sizer"}>
							{option.label}
						</span>
					))}
				</span>
				<IconChevronDown size={13} className="select-chevron" />
			</button>
			{open ? (
				<SelectMenu
					anchor={triggerRef}
					options={options}
					value={value}
					onClose={close}
					onPick={(next) => {
						close(true);
						if (next !== value) onChange(next);
					}}
				/>
			) : null}
		</>
	);
}

interface Placement {
	left: number;
	top?: number;
	bottom?: number;
	minWidth: number;
	maxHeight: number;
}

function SelectMenu<T extends string | number>({
	anchor,
	options,
	value,
	onClose,
	onPick,
}: {
	anchor: RefObject<HTMLButtonElement | null>;
	options: SelectEntry<T>[];
	value: T;
	onClose(refocus: boolean): void;
	onPick(value: T): void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const triggerPosition = useRef<{ left: number; top: number } | undefined>(undefined);
	const [placed, setPlaced] = useState<Placement>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Open below the trigger, or above it when there is more room there; keep inside the window.
	useLayoutEffect(() => {
		const menu = ref.current;
		const trigger = anchor.current;
		if (!menu || !trigger) return;
		const rect = trigger.getBoundingClientRect();
		triggerPosition.current = { left: rect.left, top: rect.top };
		const below = window.innerHeight - rect.bottom - GAP - MARGIN;
		const above = rect.top - GAP - MARGIN;
		const up = menu.scrollHeight > below && above > below;
		const width = Math.max(rect.width, menu.offsetWidth);
		setPlaced({
			left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - MARGIN - width)),
			...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
			minWidth: rect.width,
			maxHeight: Math.min(MAX_HEIGHT, up ? above : below),
		});
	}, [anchor]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current(true);
		};
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			// The trigger toggles the menu itself.
			if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
			onCloseRef.current(false);
		};
		const onScroll = (e: Event) => {
			const target = e.target as Node;
			if (ref.current?.contains(target)) return;
			// Only scrolling a container of the trigger moves it away from the menu.
			if (anchor.current && !target.contains?.(anchor.current)) return;
			// A focus/scroll-into-view just before opening can dispatch its scroll event later.
			// Keep the menu if it was already placed at the trigger's current position.
			const rect = anchor.current?.getBoundingClientRect();
			const previous = triggerPosition.current;
			if (rect && previous && Math.abs(rect.left - previous.left) < 1 && Math.abs(rect.top - previous.top) < 1) return;
			onCloseRef.current(false);
		};
		const dismiss = () => onCloseRef.current(false);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("scroll", onScroll, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", dismiss);
		window.addEventListener("resize", dismiss);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("scroll", onScroll, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("blur", dismiss);
			window.removeEventListener("resize", dismiss);
		};
	}, [anchor]);

	// Once placed (it is hidden, hence unfocusable, before), focus the chosen option and scroll it into view.
	useEffect(() => {
		const menu = ref.current;
		if (!placed || !menu) return;
		const item =
			menu.querySelector<HTMLButtonElement>("button.selected:not(:disabled)") ??
			menu.querySelector<HTMLButtonElement>("button:not(:disabled)");
		if (!item) return;
		item.focus({ preventScroll: true });
		menu.scrollTop = item.offsetTop - (menu.clientHeight - item.offsetHeight) / 2;
	}, [placed]);

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const move = (next: number) => buttons[(next + buttons.length) % buttons.length]?.focus();
		if (e.key === "ArrowDown") move(index + 1);
		else if (e.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
		else if (e.key === "Home") move(0);
		else if (e.key === "End") move(-1);
		else if (e.key === "Tab") onClose(true);
		else return;
		e.preventDefault();
		e.stopPropagation();
	};

	const item = (option: SelectOption<T>) => {
		const selected = option.value === value;
		return (
			<button
				key={String(option.value)}
				type="button"
				role="option"
				aria-selected={selected}
				className={`dropdown-item${selected ? " selected" : ""}`}
				disabled={option.disabled}
				onClick={() => onPick(option.value)}
			>
				<span className="select-option-label">{option.label}</span>
				{selected ? <IconCheck size={14} className="select-check" /> : null}
			</button>
		);
	};

	return createPortal(
		<div
			ref={ref}
			className="dropdown-menu select-menu"
			role="listbox"
			tabIndex={-1}
			style={
				placed
					? {
							...placed,
							transformOrigin: placed.bottom === undefined ? "top left" : "bottom left",
						}
					: { visibility: "hidden", left: 0, top: 0 }
			}
			onKeyDown={onKeyDown}
		>
			{options.map((entry) =>
				isGroup(entry) ? (
					<div key={`group:${entry.label}`}>
						<div className="dropdown-group-title">{entry.label}</div>
						{entry.options.map(item)}
					</div>
				) : (
					item(entry)
				),
			)}
		</div>,
		document.body,
	);
}
