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
}

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
	]),
	tabId: z.string().max(256).optional(),
	url: z.string().max(8192).optional(),
	nodeId: z.number().int().nonnegative().optional(),
	value: z.boolean().optional(),
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
}

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
