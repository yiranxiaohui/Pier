import { z } from "zod";

/** Actions shared by local windows and browsers running on the workspace host. */
export const BrowserCommandSchema = z.object({
	action: z.enum(["tabs", "navigate", "snapshot", "click", "fill", "press", "evaluate", "screenshot"]),
	tabId: z.string().max(256).optional(),
	url: z.string().max(8192).optional(),
	selector: z.string().max(4096).optional(),
	text: z.string().max(100_000).optional(),
	key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]).optional(),
	expression: z.string().max(100_000).optional(),
});
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

export interface BrowserResult {
	text?: string;
	image?: { data: string; mimeType: "image/png" };
}

export interface LocalBrowserInfo {
	browserId: string;
	workspaceId: string;
	peerId?: string;
	url: string;
	localUrl: string;
	mode: "service" | "network" | "remote";
	controllable: boolean;
	transport?: BrowserTransport;
	/**
	 * A Pier-managed browser process (1.67): its page can be driven with `browser.control`
	 * (address bar, history, tabs, element picking). Remote browsers always are; a local one is
	 * when opened with `managed` (or for external integrations / a remote network).
	 */
	managed?: boolean;
	/**
	 * A windowless local browser whose page is drawn in the panel (1.69): `browser.frame` events
	 * after `screencast`, driven with `input`; select lists, dialogs and file choosers come as
	 * `browser.popup`. Opened with `embedded`; `embed` switches it to a window and back.
	 */
	embedded?: boolean;
}

/** Modifier keys held during an input event: Alt 1, Ctrl 2, Meta / Command 4, Shift 8. */
const Modifiers = z.number().int().min(0).max(15).optional();
const Coordinate = z.number().finite().min(-100_000).max(100_000);

/**
 * Mouse, keyboard and text input to the page an embedded browser shows (1.69), in CSS pixels of
 * its viewport. `key` carries the DOM event's `key`, `code` and `keyCode`, and `text` when it types
 * a character; `text` inserts a string (a finished IME composition, a paste); `composition` shows
 * the IME's text in progress.
 */
export const BrowserInputSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("mouse"),
		event: z.enum(["move", "down", "up", "wheel"]),
		x: Coordinate,
		y: Coordinate,
		button: z.enum(["none", "left", "middle", "right", "back", "forward"]).optional(),
		/** Buttons held, as in the DOM's `MouseEvent.buttons`. */
		buttons: z.number().int().min(0).max(31).optional(),
		clickCount: z.number().int().min(0).max(3).optional(),
		deltaX: Coordinate.optional(),
		deltaY: Coordinate.optional(),
		modifiers: Modifiers,
	}),
	z.object({
		type: z.literal("key"),
		event: z.enum(["down", "up"]),
		key: z.string().max(32),
		code: z.string().max(32),
		keyCode: z.number().int().min(0).max(255),
		text: z.string().max(8).optional(),
		modifiers: Modifiers,
		repeat: z.boolean().optional(),
		location: z.number().int().min(0).max(3).optional(),
	}),
	z.object({ type: z.literal("text"), text: z.string().min(1).max(100_000) }),
	z.object({ type: z.literal("composition"), text: z.string().max(1000) }),
]);
export type BrowserInput = z.infer<typeof BrowserInputSchema>;

/**
 * The desktop's own controls of a browser it opened (1.67): the panel's address bar, history and
 * tabs, picking an element, screenshots. Unlike `BrowserCommand` this needs no opt-in: only the
 * connection that opened the browser may use it.
 *
 * - `state`: the tabs and the active tab's history.
 * - `navigate` / `back` / `forward` / `reload` / `stop`: the active (or given) tab.
 * - `newTab` (optional `url`), `activateTab`, `closeTab` (`tabId`); closing the last tab leaves
 *   an empty page instead of quitting the browser.
 * - `pick`: let the user click an element on the page, as in DevTools' inspector; resolves with
 *   the element, or `cancelled` (`cancelPick`, Esc in the page, navigation). One pick at a time.
 * - `highlight` (`nodeId` from a picked element) / `clearHighlight`: keep it outlined.
 * - `capture`: a PNG of the active tab's viewport.
 * - `fullscreen` (`value`): hide the browser's own tab strip and address bar while the panel's
 *   stand in for them, or show them again (a separate viewer window).
 *
 * An embedded local browser (1.69) also takes:
 * - `screencast` (`value`, `width`, `height`, `scale`): show the active tab at that viewport size
 *   (CSS pixels, device pixel ratio `scale`) as `browser.frame` events, or stop (`value: false`).
 * - `input` (`input`): mouse, keyboard or text for the tab on screen.
 * - `copy`: the page's selected text, as `text`.
 * - `dialog` (`value` accepts, `text` answers a prompt), `choose` (`index` of the option, none to
 *   dismiss), `files` (absolute paths, none to cancel): answer the `browser.popup` on screen.
 * - `embed` (`value`): reopen the browser drawn in the panel, or as a window (`value: false`),
 *   with the same tabs and profile.
 */
export const BrowserControlSchema = z.object({
	op: z.enum([
		"state",
		"navigate",
		"back",
		"forward",
		"reload",
		"stop",
		"newTab",
		"activateTab",
		"closeTab",
		"pick",
		"cancelPick",
		"highlight",
		"clearHighlight",
		"capture",
		"fullscreen",
		"screencast",
		"input",
		"copy",
		"dialog",
		"choose",
		"files",
		"embed",
	]),
	tabId: z.string().max(256).optional(),
	url: z.string().max(8192).optional(),
	nodeId: z.number().int().nonnegative().optional(),
	value: z.boolean().optional(),
	width: z.number().int().min(100).max(8192).optional(),
	height: z.number().int().min(100).max(8192).optional(),
	scale: z.number().finite().min(0.5).max(4).optional(),
	input: BrowserInputSchema.optional(),
	text: z.string().max(100_000).optional(),
	index: z.number().int().min(0).max(100_000).optional(),
	files: z.array(z.string().min(1).max(4096)).max(64).optional(),
});
export type BrowserControl = z.infer<typeof BrowserControlSchema>;

/** `pick` may wait this long for the user's click. */
export const BROWSER_PICK_TIMEOUT_MS = 30 * 60_000;

export interface BrowserTab {
	id: string;
	title: string;
	url: string;
}

/** The browser's tabs, the one on screen, and that tab's history. */
export interface BrowserPageState {
	tabs: BrowserTab[];
	activeTabId?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
	/** What an embedded browser's active tab is waiting for the user to answer (1.69). */
	popup?: BrowserPopup;
}

/** One entry of a select list. */
export interface BrowserSelectOption {
	label: string;
	disabled?: boolean;
	/** The `<optgroup>` it is in. */
	group?: string;
}

/**
 * Something the page on screen opened that a windowless browser does not draw (1.69): a select
 * list (where it is on the page, in CSS pixels), a JavaScript dialog, or a file chooser.
 */
export type BrowserPopup =
	| {
			kind: "select";
			rect: { x: number; y: number; width: number; height: number };
			options: BrowserSelectOption[];
			/** The option chosen now, -1 for none. */
			selected: number;
	  }
	| {
			kind: "dialog";
			dialog: "alert" | "confirm" | "prompt" | "beforeunload";
			message: string;
			defaultPrompt?: string;
	  }
	| { kind: "files"; multiple: boolean };

export interface BrowserImage {
	data: string;
	/** JPEG only for a viewport too large as a PNG. */
	mimeType: "image/png" | "image/jpeg";
	width: number;
	height: number;
}

/** An element picked on a page, described for an Agent. Text fields are cut to a bounded size. */
export interface BrowserElement {
	/** The page's backend node, for `highlight`; valid until the page changes. */
	nodeId: number;
	url: string;
	title: string;
	/** `div#id.class`, as DevTools labels an element. */
	label: string;
	/** A CSS selector that matched only this element when it was picked. */
	selector: string;
	tag: string;
	/** Its visible text (`innerText`), cut to 2,000 characters. */
	text: string;
	/** Its `outerHTML`, cut to 6,000 characters. */
	html: string;
	/** Where it is on the page, in CSS pixels relative to the top-level viewport. */
	rect: { x: number; y: number; width: number; height: number };
	/** Its visible part, when it has one. */
	image?: BrowserImage;
}

export interface BrowserControlResult {
	state?: BrowserPageState;
	element?: BrowserElement;
	image?: BrowserImage;
	/** A `pick` ended without an element. */
	cancelled?: boolean;
	/** `copy`: the selected text. */
	text?: string;
	/** `input` (a mouse move): the pointer's shape over the page, a CSS cursor keyword. */
	cursor?: string;
}

export type BrowserTransport = "webrtc" | "websockets";

/** A session on the workspace host. Only its owning connection receives the access token. */
export interface RemoteBrowserInfo {
	browserId: string;
	workspaceId: string;
	port: number;
	token: string;
	transport: BrowserTransport;
}

/** Initial setup can download several hundred MiB on the workspace host. */
export const BROWSER_OPEN_TIMEOUT_MS = 15 * 60_000;
/** Bounded log snapshot, not a delta: safe to recover through browser.list after reopening the panel. */
export const BROWSER_PREPARATION_LOG_LIMIT = 16_000;
export const BrowserPreparationProgressSchema = z.object({
	stage: z.enum(["checking", "downloading", "verifying", "installing", "starting"]),
	component: z.enum(["selkies", "chromium", "system"]).optional(),
	message: z.string().max(500),
	logs: z.string().max(BROWSER_PREPARATION_LOG_LIMIT).optional(),
	downloadedBytes: z
		.number()
		.int()
		.nonnegative()
		.max(600 * 1024 * 1024)
		.optional(),
	totalBytes: z
		.number()
		.int()
		.positive()
		.max(600 * 1024 * 1024)
		.optional(),
});
export type BrowserPreparationProgress = z.infer<typeof BrowserPreparationProgressSchema>;
export const BrowserPreparationSchema = z.object({
	browserId: z.string(),
	workspaceId: z.string(),
	peerId: z.string().optional(),
	progress: BrowserPreparationProgressSchema,
});
export type BrowserPreparation = z.infer<typeof BrowserPreparationSchema>;
