import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { UiBridge } from "../ui-bridge.ts";
import type { PiAgentModule } from "./sdk.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
let themeInitialized = false;

/** Unstyled stand-in used when pi's theme assets are unavailable: styling calls return their text. */
const plainTheme = new Proxy(
	{},
	{
		get: (_target, prop) => (prop === "name" ? "plain" : (...args: unknown[]) => String(args.at(-1) ?? "")),
	},
) as Theme;

/**
 * Extensions may style text through `ctx.ui.theme` even without a terminal. pi keeps
 * its theme in a global that is only set by `initTheme()`, so initialize it once.
 */
function currentTheme(initTheme: PiAgentModule["initTheme"]): Theme {
	const globals = globalThis as unknown as Record<symbol, Theme | undefined>;
	if (!globals[THEME_KEY] && !themeInitialized) {
		themeInitialized = true;
		try {
			initTheme("dark");
		} catch {
			// The theme files of this pi installation could not be read; fall back below.
		}
	}
	return globals[THEME_KEY] ?? plainTheme;
}

/**
 * pi `ExtensionUIContext` backed by the protocol UI bridge.
 *
 * Dialogs and fire-and-forget calls are forwarded to clients; terminal-only
 * features degrade to no-ops the same way pi's RPC mode does.
 */
export function createUiContext(bridge: UiBridge, initTheme: PiAgentModule["initTheme"]): ExtensionUIContext {
	const ui: ExtensionUIContext = {
		select: async (title, options, opts) => {
			const response = await bridge.request(
				{ kind: "select", title, options },
				{ signal: opts?.signal, ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) },
			);
			return response?.value;
		},
		confirm: async (title, message, opts) => {
			const response = await bridge.request(
				{ kind: "confirm", title, message },
				{ signal: opts?.signal, ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) },
			);
			return response?.confirmed === true;
		},
		input: async (title, placeholder, opts) => {
			const response = await bridge.request(
				{ kind: "input", title, ...(placeholder === undefined ? {} : { placeholder }) },
				{ signal: opts?.signal, ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) },
			);
			return response?.value;
		},
		editor: async (title, prefill) => {
			const response = await bridge.request({ kind: "editor", title, ...(prefill === undefined ? {} : { prefill }) });
			return response?.value;
		},
		notify: (message, type) => bridge.notify(message, type ?? "info"),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => bridge.setStatus(key, text),
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: ((key: string, content: unknown, options?: { placement?: string }) => {
			// Component factories need a terminal; only string widgets are forwarded.
			if (content === undefined || Array.isArray(content)) {
				bridge.setWidget(key, content as string[] | undefined, options?.placement);
			}
		}) as ExtensionUIContext["setWidget"],
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (title) => bridge.setTitle(title),
		custom: async () => undefined as never,
		pasteToEditor: (text) => bridge.setEditorText(text),
		setEditorText: (text) => bridge.setEditorText(text),
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return currentTheme(initTheme);
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not supported by Pier" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	return ui;
}
