import type { BrowserControl, BrowserControlResult, BrowserInput, BrowserPopup, PierHostEvent } from "@pier/protocol";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { LOCAL_NODE, useStore } from "../lib/store.tsx";
import { IconLoader } from "./Icons.tsx";

type FrameEvent = Extract<PierHostEvent, { type: "browser.frame" }>;
type PopupEvent = Extract<PierHostEvent, { type: "browser.popup" }>;
type SelectPopup = Extract<BrowserPopup, { kind: "select" }>;
type DialogPopup = Extract<BrowserPopup, { kind: "dialog" }>;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const BUTTONS = ["left", "middle", "right", "back", "forward"] as const;
/** Presses this close in time and place count as a double (or triple) click. */
const CLICK_MS = 500;
const CLICK_PX = 5;

function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
	return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const clampDelta = (value: number) => Math.max(-10_000, Math.min(10_000, value));

/** The viewport the panel asks for: its size in CSS pixels, at the screen's pixel ratio. */
export function screenViewport(width: number, height: number, ratio: number) {
	const w = Math.max(100, Math.min(8192, Math.floor(width)));
	const h = Math.max(100, Math.min(8192, Math.floor(height)));
	const scale = Math.round(Math.max(0.5, Math.min(4, ratio || 1, 4096 / w, 4096 / h)) * 100) / 100;
	return { width: w, height: h, scale };
}

/** The text a key types, as the browser's own key event would carry it; none for shortcuts. */
export function keyText(event: {
	key: string;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}): string | undefined {
	if (event.key === "Enter") return "\r";
	if ([...event.key].length !== 1 || event.metaKey) return undefined;
	// Ctrl+Alt is AltGr on Windows keyboards, which types characters.
	if (event.ctrlKey && !event.altKey) return undefined;
	return event.key;
}

/**
 * The page of a windowless local browser, drawn from its frames, taking the pointer, keys and the
 * input method like the page itself: the panel is the browser's window. Select lists, dialogs and
 * file choosers, which such a browser does not draw, are shown here.
 */
export function BrowserScreen({
	browserId,
	active,
	interactive,
	onShortcut,
	onError,
}: {
	browserId: string;
	/** The panel tab is on screen: stream the page. */
	active: boolean;
	/** The page takes the pointer and keys (not while a screenshot is being marked up). */
	interactive: boolean;
	/** A browser shortcut pressed on the page: reload, history, the address bar. */
	onShortcut(action: "reload" | "back" | "forward" | "address"): void;
	onError(message: string): void;
}) {
	const store = useStore();
	const local = store.nodeClient(LOCAL_NODE);
	const box = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const keys = useRef<HTMLTextAreaElement>(null);
	const [frame, setFrame] = useState<{ tabId: string; width: number; height: number }>();
	const frameRef = useRef(frame);
	frameRef.current = frame;
	const [popup, setPopup] = useState<{ tabId: string; popup: BrowserPopup }>();
	const [cursor, setCursor] = useState("default");
	/** Where the input method's candidates show: the last press on the page. */
	const [caret, setCaret] = useState({ x: 0, y: 0 });
	const interactiveRef = useRef(interactive);
	interactiveRef.current = interactive;
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;

	const control = useCallback(
		(command: BrowserControl, timeoutMs?: number): Promise<BrowserControlResult> =>
			store.browserControl(browserId, command, timeoutMs),
		[store, browserId],
	);
	// Input is written in order and not waited for; only a mouse move answers (the pointer's shape).
	const send = useCallback(
		(input: BrowserInput) =>
			control({ op: "input", input }).then(
				(result) => {
					if (result.cursor) setCursor(result.cursor);
				},
				() => {},
			),
		[control],
	);

	// Frames and popups of this browser, drawing only the newest frame when they come faster.
	useEffect(() => {
		if (!local) return;
		let live = true;
		let latest: FrameEvent | undefined;
		let drawing = false;
		const draw = async () => {
			drawing = true;
			while (live && latest) {
				const next = latest;
				latest = undefined;
				const image = new Image();
				image.src = `data:image/jpeg;base64,${next.data}`;
				try {
					await image.decode();
				} catch {
					continue;
				}
				const el = canvas.current;
				if (!live || !el) break;
				if (el.width !== image.naturalWidth) el.width = image.naturalWidth;
				if (el.height !== image.naturalHeight) el.height = image.naturalHeight;
				el.getContext("2d")?.drawImage(image, 0, 0);
				const shown = frameRef.current;
				if (shown?.tabId !== next.tabId || shown.width !== next.width || shown.height !== next.height) {
					const size = { tabId: next.tabId, width: next.width, height: next.height };
					frameRef.current = size;
					setFrame(size);
				}
			}
			drawing = false;
		};
		const off = local.onEvent((wire) => {
			if (wire.event.type === "browser.frame") {
				const event = wire.event as unknown as FrameEvent;
				if (event.browserId !== browserId) return;
				latest = event;
				if (!drawing) void draw();
			} else if (wire.event.type === "browser.popup") {
				const event = wire.event as unknown as PopupEvent;
				if (event.browserId !== browserId) return;
				const shown = event.popup;
				setPopup((current) =>
					shown ? { tabId: event.tabId, popup: shown } : current?.tabId === event.tabId ? undefined : current,
				);
			}
		});
		return () => {
			live = false;
			off();
		};
	}, [local, browserId]);

	// Stream while on screen, at the size of the panel (and again when it is resized).
	useEffect(() => {
		const el = box.current;
		if (!active || !el) return;
		let last = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const apply = () => {
			// Collapsed or not laid out yet.
			if (el.clientWidth < 40 || el.clientHeight < 40) return;
			const viewport = screenViewport(el.clientWidth, el.clientHeight, window.devicePixelRatio);
			const key = `${viewport.width}x${viewport.height}@${viewport.scale}`;
			if (key === last) return;
			last = key;
			control({ op: "screencast", value: true, ...viewport }).catch((error: unknown) => {
				last = "";
				onErrorRef.current(error instanceof Error ? error.message : String(error));
			});
		};
		const later = () => {
			clearTimeout(timer);
			timer = setTimeout(apply, 120);
		};
		apply();
		const observer = new ResizeObserver(later);
		observer.observe(el);
		// Moving the window to a screen with another pixel ratio.
		window.addEventListener("resize", later);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", later);
			clearTimeout(timer);
			control({ op: "screencast", value: false }).catch(() => {});
		};
	}, [active, control]);

	/** A point of the page under the pointer, in its CSS pixels. */
	const point = useCallback((event: { clientX: number; clientY: number }) => {
		const shown = frameRef.current;
		const rect = canvas.current?.getBoundingClientRect();
		if (!shown || !rect?.width || !rect.height) return undefined;
		return {
			x: Math.round(((event.clientX - rect.left) * shown.width * 100) / rect.width) / 100,
			y: Math.round(((event.clientY - rect.top) * shown.height * 100) / rect.height) / 100,
		};
	}, []);

	// Mouse moves go at most once per display frame; a press or the wheel sends the last one first.
	const pendingMove = useRef<BrowserInput>(undefined);
	const moveFrame = useRef(0);
	const flushMove = useCallback(() => {
		cancelAnimationFrame(moveFrame.current);
		moveFrame.current = 0;
		const move = pendingMove.current;
		pendingMove.current = undefined;
		if (move) void send(move);
	}, [send]);
	const queueMove = (move: BrowserInput) => {
		pendingMove.current = move;
		if (!moveFrame.current) moveFrame.current = requestAnimationFrame(flushMove);
	};
	useEffect(() => () => cancelAnimationFrame(moveFrame.current), []);

	const clicks = useRef({ time: 0, x: 0, y: 0, button: -1, count: 0 });
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!interactive) return;
		// Keep the keys here: the page has the focus now.
		event.preventDefault();
		keys.current?.focus({ preventScroll: true });
		const at = point(event);
		if (!at) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const boxRect = box.current?.getBoundingClientRect();
		if (boxRect) setCaret({ x: event.clientX - boxRect.left, y: event.clientY - boxRect.top });
		const last = clicks.current;
		const now = performance.now();
		const again =
			last.button === event.button &&
			now - last.time < CLICK_MS &&
			Math.abs(last.x - event.clientX) < CLICK_PX &&
			Math.abs(last.y - event.clientY) < CLICK_PX;
		clicks.current = {
			time: now,
			x: event.clientX,
			y: event.clientY,
			button: event.button,
			count: again ? Math.min(3, last.count + 1) : 1,
		};
		flushMove();
		void send({
			type: "mouse",
			event: "down",
			...at,
			button: BUTTONS[event.button] ?? "left",
			buttons: event.buttons,
			clickCount: clicks.current.count,
			modifiers: modifiers(event),
		});
	};
	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!interactive) return;
		const at = point(event);
		if (!at) return;
		flushMove();
		void send({
			type: "mouse",
			event: "up",
			...at,
			button: BUTTONS[event.button] ?? "left",
			buttons: event.buttons,
			clickCount: clicks.current.count || 1,
			modifiers: modifiers(event),
		});
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!interactive) return;
		const at = point(event);
		if (at) queueMove({ type: "mouse", event: "move", ...at, buttons: event.buttons, modifiers: modifiers(event) });
	};

	// The wheel scrolls the page, not the panel: a non-passive listener, one event per display frame.
	const surface = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = surface.current;
		if (!el) return;
		let sum = { x: 0, y: 0, deltaX: 0, deltaY: 0, modifiers: 0 };
		let raf = 0;
		const onWheel = (event: WheelEvent) => {
			if (!interactiveRef.current) return;
			event.preventDefault();
			const at = point(event);
			if (!at) return;
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (frameRef.current?.height ?? 600) : 1;
			sum = {
				x: at.x,
				y: at.y,
				deltaX: sum.deltaX + event.deltaX * unit,
				deltaY: sum.deltaY + event.deltaY * unit,
				modifiers: modifiers(event),
			};
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const wheel = sum;
				sum = { x: 0, y: 0, deltaX: 0, deltaY: 0, modifiers: 0 };
				flushMove();
				void send({
					type: "mouse",
					event: "wheel",
					x: wheel.x,
					y: wheel.y,
					deltaX: clampDelta(wheel.deltaX),
					deltaY: clampDelta(wheel.deltaY),
					modifiers: wheel.modifiers,
				});
			});
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			el.removeEventListener("wheel", onWheel);
			cancelAnimationFrame(raf);
		};
	}, [point, send, flushMove]);

	// ---- keys and the input method -----------------------------------------------------------

	const composing = useRef(false);
	const copySelection = async () => {
		try {
			const { text } = await control({ op: "copy" });
			if (text) await navigator.clipboard.writeText(text);
		} catch {
			/* Nothing selected, or the clipboard refused. */
		}
	};
	const sendKey = (event: ReactKeyboardEvent, kind: "down" | "up") => {
		const text = kind === "down" ? keyText(event) : undefined;
		void send({
			type: "key",
			event: kind,
			key: event.key.slice(0, 32),
			code: event.code.slice(0, 32),
			keyCode: event.keyCode & 255,
			...(text ? { text } : {}),
			modifiers: modifiers(event),
			repeat: event.repeat,
			location: Math.min(3, Math.max(0, event.location)),
		});
	};
	const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (!interactive || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
		const primary = isMac ? event.metaKey : event.ctrlKey;
		const key = event.key.toLowerCase();
		// A browser's own shortcuts work on the page as in a browser window.
		if (event.key === "F5" || (primary && key === "r" && !event.altKey)) {
			event.preventDefault();
			onShortcut("reload");
			return;
		}
		if (primary && key === "l" && !event.altKey && !event.shiftKey) {
			event.preventDefault();
			onShortcut("address");
			return;
		}
		const history = isMac
			? event.metaKey && (event.key === "[" || event.key === "]")
			: event.altKey && !event.ctrlKey && (event.key === "ArrowLeft" || event.key === "ArrowRight");
		if (history) {
			event.preventDefault();
			onShortcut(event.key === "[" || event.key === "ArrowLeft" ? "back" : "forward");
			return;
		}
		// Pasting comes as the paste event below, with the system clipboard's text.
		if (primary && key === "v" && !event.altKey) return;
		// The page copies into the browser's own clipboard; the system one gets the selection.
		if (primary && (key === "c" || key === "x") && !event.altKey && !event.shiftKey) void copySelection();
		event.preventDefault();
		sendKey(event, "down");
	};
	const onKeyUp = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (!interactive || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		sendKey(event, "up");
	};

	// ---- popups -------------------------------------------------------------------------------

	const shown = popup && popup.tabId === frame?.tabId ? popup.popup : undefined;
	const answer = useCallback(
		(command: BrowserControl) => {
			setPopup(undefined);
			control(command).catch((error: unknown) =>
				onErrorRef.current(error instanceof Error ? error.message : String(error)),
			);
			keys.current?.focus({ preventScroll: true });
		},
		[control],
	);
	// A file chooser opens the system's file dialog at once, as the page asked.
	const filesAsked = shown?.kind === "files" ? shown : undefined;
	useEffect(() => {
		if (!filesAsked) return;
		let live = true;
		store.pickFiles(filesAsked.multiple).then(
			(files) => {
				if (live) answer({ op: "files", files });
			},
			() => {
				if (live) answer({ op: "files" });
			},
		);
		return () => {
			live = false;
		};
	}, [filesAsked, store, answer]);

	return (
		<div ref={box} className="browser-screen">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the page itself; its keys go to the textarea a press focuses. */}
			<div
				ref={surface}
				className="browser-screen-surface"
				style={{ cursor: interactive ? cursor : undefined }}
				onPointerDown={onPointerDown}
				onPointerUp={onPointerUp}
				onPointerMove={onPointerMove}
				onContextMenu={(event) => event.preventDefault()}
			>
				<canvas
					ref={canvas}
					className="browser-screen-canvas"
					style={frame ? { width: frame.width, height: frame.height } : { visibility: "hidden" }}
				/>
			</div>
			<textarea
				ref={keys}
				className="browser-screen-keys"
				style={{ left: caret.x, top: caret.y }}
				aria-label="网页键盘输入"
				autoComplete="off"
				autoCorrect="off"
				autoCapitalize="off"
				spellCheck={false}
				tabIndex={-1}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionUpdate={(event) => {
					void send({ type: "composition", text: event.data.slice(0, 1000) });
				}}
				onCompositionEnd={(event) => {
					composing.current = false;
					const text = event.data;
					void send(text ? { type: "text", text } : { type: "composition", text: "" });
					event.currentTarget.value = "";
				}}
				onPaste={(event) => {
					event.preventDefault();
					const text = event.clipboardData.getData("text/plain");
					if (text && interactive) void send({ type: "text", text: text.slice(0, 100_000) });
				}}
				onInput={(event) => {
					if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
					// Text inserted without keys or a composition (an emoji panel, dictation, some IMEs).
					const text = event.currentTarget.value;
					event.currentTarget.value = "";
					if (text && interactive) void send({ type: "text", text: text.slice(0, 100_000) });
				}}
			/>
			{!frame ? (
				<div className="browser-screen-wait">
					<IconLoader size={18} className="spin" />
				</div>
			) : null}
			{shown?.kind === "select" ? (
				<BrowserSelectList
					popup={shown}
					onChoose={(index) => answer({ op: "choose", ...(index === undefined ? {} : { index }) })}
				/>
			) : null}
			{shown?.kind === "dialog" ? (
				<BrowserDialog
					key={`${shown.dialog}:${shown.message}`}
					popup={shown}
					onAnswer={(accept, text) => answer({ op: "dialog", value: accept, ...(text === undefined ? {} : { text }) })}
				/>
			) : null}
		</div>
	);
}

/** A select's list under it on the page, like the browser's own: arrows, Enter, Escape, typing. */
function BrowserSelectList({ popup, onChoose }: { popup: SelectPopup; onChoose(index?: number): void }) {
	const ref = useRef<HTMLDivElement>(null);
	const [focus, setFocus] = useState(Math.max(0, popup.selected));
	const [above, setAbove] = useState(false);
	const onChooseRef = useRef(onChoose);
	onChooseRef.current = onChoose;

	// Below the select, or above it when the panel has no room under it.
	useLayoutEffect(() => {
		const el = ref.current;
		const parent = el?.offsetParent as HTMLElement | null;
		if (!el || !parent) return;
		const below = parent.clientHeight - (popup.rect.y + popup.rect.height);
		setAbove(below < Math.min(el.offsetHeight, 200) && popup.rect.y > below);
		el.focus({ preventScroll: true });
	}, [popup]);
	useEffect(() => {
		ref.current?.querySelector(`[data-index="${focus}"]`)?.scrollIntoView({ block: "nearest" });
	}, [focus]);
	// A press outside closes it without choosing, as the browser's list does; on the page, the
	// press only closes it.
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (ref.current?.contains(target)) return;
			if (ref.current?.parentElement?.contains(target)) {
				event.preventDefault();
				event.stopPropagation();
			}
			onChooseRef.current();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, []);

	const enabled = popup.options.flatMap((option, index) => (option.disabled ? [] : [index]));
	const step = (delta: number) => {
		const at = enabled.indexOf(focus);
		const next = enabled[Math.max(0, Math.min(enabled.length - 1, (at < 0 ? -1 : at) + delta))];
		if (next !== undefined) setFocus(next);
	};
	const onKeyDown = (event: ReactKeyboardEvent) => {
		if (event.key === "ArrowDown") step(1);
		else if (event.key === "ArrowUp") step(-1);
		else if (event.key === "Home") setFocus(enabled[0] ?? focus);
		else if (event.key === "End") setFocus(enabled[enabled.length - 1] ?? focus);
		else if (event.key === "PageDown") step(10);
		else if (event.key === "PageUp") step(-10);
		else if (event.key === "Enter" || event.key === " ") onChoose(focus);
		else if (event.key === "Escape" || event.key === "Tab") onChoose();
		else if ([...event.key].length === 1) {
			// Typing jumps to the next option starting with that letter.
			const letter = event.key.toLowerCase();
			const order = [...enabled.filter((i) => i > focus), ...enabled.filter((i) => i <= focus)];
			const match = order.find((i) => popup.options[i]?.label.trim().toLowerCase().startsWith(letter));
			if (match !== undefined) setFocus(match);
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	let group: string | undefined;
	return (
		<div
			ref={ref}
			className="dropdown-menu browser-select"
			role="listbox"
			tabIndex={-1}
			aria-activedescendant={`browser-option-${focus}`}
			style={{
				left: popup.rect.x,
				minWidth: Math.max(120, popup.rect.width),
				...(above ? { bottom: `calc(100% - ${popup.rect.y}px)` } : { top: popup.rect.y + popup.rect.height }),
			}}
			onKeyDown={onKeyDown}
		>
			{popup.options.map((option, index) => {
				const heading = option.group !== group && option.group !== undefined ? option.group : undefined;
				group = option.group;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: options are identified by their place.
					<div key={index} className="browser-select-entry">
						{heading !== undefined ? <div className="browser-select-group">{heading}</div> : null}
						<button
							type="button"
							tabIndex={-1}
							id={`browser-option-${index}`}
							data-index={index}
							role="option"
							aria-selected={index === popup.selected}
							disabled={option.disabled}
							className={`browser-select-option${index === focus ? " focused" : ""}${
								index === popup.selected ? " selected" : ""
							}${option.group !== undefined ? " grouped" : ""}`}
							onPointerEnter={() => !option.disabled && setFocus(index)}
							onClick={() => onChoose(index)}
						>
							{option.label || " "}
						</button>
					</div>
				);
			})}
		</div>
	);
}

const DIALOG_TITLES: Record<DialogPopup["dialog"], string> = {
	alert: "网页提示",
	confirm: "网页询问",
	prompt: "网页请求输入",
	beforeunload: "离开此网页？",
};

/** A page's alert, confirm, prompt or leave-page question; the page waits until it is answered. */
function BrowserDialog({ popup, onAnswer }: { popup: DialogPopup; onAnswer(accept: boolean, text?: string): void }) {
	const [text, setText] = useState(popup.defaultPrompt ?? "");
	const first = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (popup.dialog === "prompt") input.current?.select();
		else first.current?.focus();
	}, [popup]);
	const cancellable = popup.dialog !== "alert";
	return (
		<div className="browser-dialog-backdrop">
			<form
				className="browser-dialog"
				role="alertdialog"
				aria-label={DIALOG_TITLES[popup.dialog]}
				onSubmit={(event) => {
					event.preventDefault();
					onAnswer(true, popup.dialog === "prompt" ? text : undefined);
				}}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					onAnswer(false);
				}}
			>
				<strong>{DIALOG_TITLES[popup.dialog]}</strong>
				{popup.message ? <p className="browser-dialog-message">{popup.message}</p> : null}
				{popup.dialog === "prompt" ? (
					<input ref={input} value={text} aria-label="输入内容" onChange={(event) => setText(event.target.value)} />
				) : null}
				<div className="browser-dialog-actions">
					{cancellable ? (
						<button type="button" onClick={() => onAnswer(false)}>
							{popup.dialog === "beforeunload" ? "留下" : "取消"}
						</button>
					) : null}
					<button ref={first} type="submit" className="primary">
						{popup.dialog === "beforeunload" ? "离开" : "确定"}
					</button>
				</div>
			</form>
		</div>
	);
}
