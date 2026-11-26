/**
 * Helpers for a windowless browser drawn in the desktop's panel: the page scripts that stand in
 * for what a headless browser does not draw (a select's list), and the mapping from the panel's
 * input to the DevTools protocol.
 */
import type { BrowserInput, BrowserPopup, BrowserSelectOption } from "@pier/protocol";

/** The isolated world Pier's page script runs in: the page cannot see or call into it. */
export const PIER_WORLD = "__pier";
/** Called by the page script (in `PIER_WORLD` only) when a select list should open. */
export const SELECT_BINDING = "__pierSelect";

/**
 * Opens select lists in the panel instead of the browser's own popup, which a headless browser
 * renders nowhere. A trusted press on a single-line `<select>` is taken over: its options and
 * where it is (in the top page's CSS pixels) go to `SELECT_BINDING`, and `__pierChoose(index)`
 * later picks one as the user would (input and change events), or just refocuses it (-1).
 * Inside a cross-origin frame its position is unknown, so the browser keeps the press.
 */
export const SELECT_SCRIPT = `(() => {
	if (globalThis.__pierChoose) return;
	let open = null;
	document.addEventListener("mousedown", (event) => {
		if (event.button !== 0 || !event.isTrusted) return;
		const select = event.target instanceof Element ? event.target.closest("select") : null;
		if (!select || select.multiple || select.size > 1 || select.disabled) return;
		const report = globalThis[${JSON.stringify(SELECT_BINDING)}];
		if (typeof report !== "function") return;
		let left = 0;
		let top = 0;
		try {
			for (let view = window; view !== view.top; view = view.parent) {
				const frame = view.frameElement;
				if (!frame) return;
				const box = frame.getBoundingClientRect();
				left += box.left + frame.clientLeft;
				top += box.top + frame.clientTop;
			}
		} catch {
			return;
		}
		event.preventDefault();
		select.focus();
		open = select;
		const box = select.getBoundingClientRect();
		const options = Array.from(select.options).slice(0, 1000).map((option) => {
			const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
			return {
				label: (option.label || option.text).slice(0, 300),
				disabled: option.disabled || Boolean(group && group.disabled),
				group: group ? group.label.slice(0, 300) : undefined,
			};
		});
		report(JSON.stringify({
			rect: { x: box.left + left, y: box.top + top, width: box.width, height: box.height },
			options,
			selected: select.selectedIndex,
		}));
	}, true);
	globalThis.__pierChoose = (index) => {
		const select = open;
		open = null;
		if (!select || !select.isConnected) return false;
		select.focus();
		const option = select.options[index];
		if (!option || option.disabled) return false;
		if (select.selectedIndex !== index) {
			select.selectedIndex = index;
			select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
		return true;
	};
})()`;

/** The selected text of the page, looking into same-origin frames and text fields (not passwords). */
export const COPY_SCRIPT = `(() => {
	let doc = document;
	for (let depth = 0; depth < 8; depth++) {
		const active = doc.activeElement;
		if (!active || (active.tagName !== "IFRAME" && active.tagName !== "FRAME")) break;
		let inner = null;
		try { inner = active.contentDocument; } catch {}
		if (!inner) break;
		doc = inner;
	}
	const active = doc.activeElement;
	if (active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type !== "password"))) {
		try {
			if (typeof active.selectionStart === "number" && active.selectionEnd > active.selectionStart)
				return active.value.slice(active.selectionStart, active.selectionEnd);
		} catch {}
	}
	const selection = doc.getSelection();
	return selection ? String(selection) : "";
})()`;

/**
 * The pointer's shape at a point of the page, as the browser would show it: the element's CSS
 * cursor, or for `auto` a hand over links and an I-beam over editable fields and selectable text.
 */
export function cursorScript(x: number, y: number): string {
	return `((x, y) => {
	let doc = document;
	let element = doc.elementFromPoint(x, y);
	for (let depth = 0; depth < 8 && element && (element.tagName === "IFRAME" || element.tagName === "FRAME"); depth++) {
		let inner = null;
		try { inner = element.contentDocument; } catch {}
		if (!inner) break;
		const box = element.getBoundingClientRect();
		x -= box.left + element.clientLeft;
		y -= box.top + element.clientTop;
		doc = inner;
		element = doc.elementFromPoint(x, y);
	}
	if (!element) return "default";
	const style = (doc.defaultView || window).getComputedStyle(element);
	if (style.cursor !== "auto") return style.cursor;
	if (element.closest("a[href], area[href]")) return "pointer";
	if (element.isContentEditable) return "text";
	const field = element.closest("textarea, input");
	if (field) return field.tagName === "TEXTAREA" || !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(field.type) ? "text" : "default";
	if (style.userSelect === "none" || !doc.caretRangeFromPoint) return "default";
	const caret = doc.caretRangeFromPoint(x, y);
	if (!caret || caret.startContainer.nodeType !== 3) return "default";
	const range = doc.createRange();
	range.selectNodeContents(caret.startContainer);
	for (const box of range.getClientRects())
		if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return "text";
	return "default";
})(${x}, ${y})`;
}

const CURSORS = new Set([
	"default",
	"none",
	"context-menu",
	"help",
	"pointer",
	"progress",
	"wait",
	"cell",
	"crosshair",
	"text",
	"vertical-text",
	"alias",
	"copy",
	"move",
	"no-drop",
	"not-allowed",
	"grab",
	"grabbing",
	"all-scroll",
	"col-resize",
	"row-resize",
	"n-resize",
	"e-resize",
	"s-resize",
	"w-resize",
	"ne-resize",
	"nw-resize",
	"se-resize",
	"sw-resize",
	"ew-resize",
	"ns-resize",
	"nesw-resize",
	"nwse-resize",
	"zoom-in",
	"zoom-out",
]);

/** A CSS cursor value reduced to a keyword the panel may show: no page images, `auto` is the arrow. */
export function cursorKeyword(value: unknown): string {
	if (typeof value !== "string") return "default";
	// `url(...) x y, pointer`: the keyword fallback is last.
	const keyword = value.split(",").pop()?.trim().toLowerCase() ?? "";
	return CURSORS.has(keyword) ? keyword : "default";
}

/** A select list reported by `SELECT_SCRIPT`, checked; undefined when it is not one. */
export function parseSelect(payload: unknown): Extract<BrowserPopup, { kind: "select" }> | undefined {
	if (typeof payload !== "string" || payload.length > 1_000_000) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return undefined;
	}
	const raw = value as { rect?: Record<string, unknown>; options?: unknown; selected?: unknown } | null;
	const rect = raw?.rect;
	const number = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
	const x = number(rect?.x);
	const y = number(rect?.y);
	const width = number(rect?.width);
	const height = number(rect?.height);
	if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
	if (!Array.isArray(raw?.options)) return undefined;
	const options: BrowserSelectOption[] = [];
	for (const option of raw.options.slice(0, 1000)) {
		const entry = option as { label?: unknown; disabled?: unknown; group?: unknown } | null;
		options.push({
			label: typeof entry?.label === "string" ? entry.label.slice(0, 300) : "",
			...(entry?.disabled === true ? { disabled: true } : {}),
			...(typeof entry?.group === "string" ? { group: entry.group.slice(0, 300) } : {}),
		});
	}
	const selected = number(raw.selected);
	return {
		kind: "select",
		rect: { x, y, width: Math.max(0, width), height: Math.max(0, height) },
		options,
		selected: selected !== undefined && Number.isInteger(selected) && selected < options.length ? selected : -1,
	};
}

const DIALOGS = new Set(["alert", "confirm", "prompt", "beforeunload"]);

/** A JavaScript dialog the page opened (`Page.javascriptDialogOpening`). */
export function dialogPopup(params: Record<string, unknown>): Extract<BrowserPopup, { kind: "dialog" }> {
	const type = typeof params.type === "string" && DIALOGS.has(params.type) ? params.type : "alert";
	return {
		kind: "dialog",
		dialog: type as Extract<BrowserPopup, { kind: "dialog" }>["dialog"],
		message: String(params.message ?? "").slice(0, 10_000),
		...(type === "prompt" ? { defaultPrompt: String(params.defaultPrompt ?? "").slice(0, 10_000) } : {}),
	};
}

const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased", wheel: "mouseWheel" } as const;

/** `Input.dispatchMouseEvent` parameters for the panel's mouse input. */
export function mouseEvent(input: Extract<BrowserInput, { type: "mouse" }>): Record<string, unknown> {
	const press = input.event === "down" || input.event === "up";
	return {
		type: MOUSE_TYPES[input.event],
		x: input.x,
		y: input.y,
		modifiers: input.modifiers ?? 0,
		button: input.event === "wheel" ? "none" : (input.button ?? "none"),
		buttons: input.buttons ?? 0,
		clickCount: input.clickCount ?? (press ? 1 : 0),
		...(input.event === "wheel" ? { deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 } : {}),
	};
}

const ALT = 1;
const META = 4;
const SHIFT = 8;

/**
 * The editing commands a key triggers on macOS. There they come from the application menu and
 * the text system, not from the page, so a synthesized key does nothing without them.
 */
export function macCommands(input: Extract<BrowserInput, { type: "key" }>): string[] {
	if (input.event !== "down") return [];
	const modifiers = input.modifiers ?? 0;
	const meta = (modifiers & META) !== 0;
	const alt = (modifiers & ALT) !== 0;
	const shift = (modifiers & SHIFT) !== 0;
	const select = (command: string) => (shift ? `${command}AndModifySelection` : command);
	if (meta) {
		switch (input.code) {
			case "KeyA":
				return ["selectAll"];
			case "KeyC":
				return ["copy"];
			case "KeyX":
				return ["cut"];
			case "KeyZ":
				return [shift ? "redo" : "undo"];
			case "ArrowLeft":
				return [select("moveToBeginningOfLine")];
			case "ArrowRight":
				return [select("moveToEndOfLine")];
			case "ArrowUp":
				return [select("moveToBeginningOfDocument")];
			case "ArrowDown":
				return [select("moveToEndOfDocument")];
			case "Backspace":
				return ["deleteToBeginningOfLine"];
		}
		return [];
	}
	if (alt) {
		switch (input.code) {
			case "ArrowLeft":
				return [select("moveWordLeft")];
			case "ArrowRight":
				return [select("moveWordRight")];
			case "Backspace":
				return ["deleteWordBackward"];
		}
	}
	return [];
}

/** `Input.dispatchKeyEvent` parameters for the panel's key input. */
export function keyEvent(
	input: Extract<BrowserInput, { type: "key" }>,
	platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
	const typing = input.event === "down" && !!input.text;
	const commands = platform === "darwin" ? macCommands(input) : [];
	return {
		type: input.event === "up" ? "keyUp" : typing ? "keyDown" : "rawKeyDown",
		key: input.key,
		code: input.code,
		windowsVirtualKeyCode: input.keyCode,
		nativeVirtualKeyCode: input.keyCode,
		modifiers: input.modifiers ?? 0,
		autoRepeat: input.repeat === true,
		location: input.location ?? 0,
		isKeypad: input.location === 3,
		...(typing ? { text: input.text, unmodifiedText: input.text } : {}),
		...(commands.length ? { commands } : {}),
	};
}

const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** A BCP 47 tag fit for `--lang` and `Accept-Language`, if it is one. */
export function browserLocale(locale: string | undefined): string | undefined {
	return locale && LOCALE.test(locale) ? locale : undefined;
}

/** `Accept-Language` for a locale: `zh-CN,zh;q=0.9,en;q=0.8`. */
export function acceptLanguage(locale: string): string {
	const base = locale.split("-")[0]?.toLowerCase() ?? locale;
	const languages = [locale];
	if (base !== locale.toLowerCase()) languages.push(`${base};q=0.9`);
	if (base !== "en") languages.push("en;q=0.8");
	return languages.join(",");
}
