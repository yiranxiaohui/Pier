/**
 * Integrated terminals: tab state plus the xterm.js instances behind them.
 *
 * The xterm instances live outside React so terminals keep their scrollback and keep
 * running while the panel is hidden, the settings page is open, or the user switches
 * sessions. React components only attach an instance's element to the visible container.
 */

import type { WorkspaceInfo } from "@pier/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ITheme, Terminal } from "@xterm/xterm";
import { useSyncExternalStore } from "react";
import { type Bridge, bridge, type TerminalBridge } from "./bridge.ts";

export type TerminalStatus = "starting" | "running" | "exited" | "failed";

export interface TerminalTab {
	key: string;
	/** Shell name once started, e.g. `zsh`. */
	shell?: string;
	/** Directory the shell started in. */
	cwd?: string;
	workspaceId?: string;
	workspaceName?: string;
	status: TerminalStatus;
	exitCode?: number | null;
	/** The title the shell set (OSC 0/2), shown as a tooltip. */
	title?: string;
}

export interface TerminalState {
	/** The panel is shown. */
	open: boolean;
	height: number;
	tabs: TerminalTab[];
	active?: string;
}

export interface OpenTerminalOptions {
	workspace?: WorkspaceInfo;
	/** Start directory; defaults to the workspace root, then the home directory. */
	cwd?: string;
}

interface Instance {
	term: Terminal;
	fit: FitAddon;
	element: HTMLDivElement;
	opened: boolean;
	id?: number;
	/** Input typed before the shell was ready. */
	pending: Array<{ data: string; binary: boolean }>;
}

const PANEL_KEY = "pier.terminal";
export const TERMINAL_DEFAULT_HEIGHT = 280;
export const TERMINAL_MIN_HEIGHT = 120;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function clampTerminalHeight(height: number, available = window.innerHeight): number {
	const max = Math.max(TERMINAL_MIN_HEIGHT, available - 220);
	return Math.round(Math.min(Math.max(height, TERMINAL_MIN_HEIGHT), max));
}

const DARK_ANSI = {
	black: "#1c1e25",
	red: "#f06464",
	green: "#3fb96f",
	yellow: "#e9b44c",
	blue: "#6aa4f0",
	magenta: "#c678dd",
	cyan: "#2ab5aa",
	white: "#c9ccd6",
	brightBlack: "#646773",
	brightRed: "#ff8a8a",
	brightGreen: "#7ee2a8",
	brightYellow: "#f5cf7a",
	brightBlue: "#94bff7",
	brightMagenta: "#dba4ea",
	brightCyan: "#5fd6cb",
	brightWhite: "#ececf1",
};

const LIGHT_ANSI = {
	black: "#24262d",
	red: "#c93c3c",
	green: "#1f8a4c",
	yellow: "#9a6a00",
	blue: "#2f63b8",
	magenta: "#9b3fb5",
	cyan: "#138a81",
	white: "#6b6e7a",
	brightBlack: "#8a8d99",
	brightRed: "#e05252",
	brightGreen: "#2ba35f",
	brightYellow: "#b58300",
	brightBlue: "#3f7ad6",
	brightMagenta: "#b152cc",
	brightCyan: "#1aa198",
	brightWhite: "#2a2c33",
};

function cssVar(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}

function currentTheme(): ITheme {
	const light = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
	return {
		background: cssVar("--bg", light ? "#ffffff" : "#111217"),
		foreground: cssVar("--text", light ? "#1c1d22" : "#ececf1"),
		cursor: cssVar("--accent", "#2ab5aa"),
		cursorAccent: cssVar("--bg", light ? "#ffffff" : "#111217"),
		selectionBackground: light ? "rgba(42, 181, 170, 0.28)" : "rgba(42, 181, 170, 0.32)",
		scrollbarSliderBackground: light ? "rgba(0, 0, 0, 0.14)" : "rgba(255, 255, 255, 0.12)",
		scrollbarSliderHoverBackground: light ? "rgba(0, 0, 0, 0.24)" : "rgba(255, 255, 255, 0.2)",
		scrollbarSliderActiveBackground: light ? "rgba(0, 0, 0, 0.3)" : "rgba(255, 255, 255, 0.26)",
		...(light ? LIGHT_ANSI : DARK_ANSI),
	};
}

function fontFamily(): string {
	return cssVar("--mono", "Menlo, Consolas, 'DejaVu Sans Mono', monospace");
}

export class TerminalManager {
	private state: TerminalState;
	private readonly listeners = new Set<() => void>();
	private readonly instances = new Map<string, Instance>();
	private nextKey = 0;
	/** Hangs up shells orphaned by a page reload, once, before the first spawn. */
	private cleanup: Promise<void> | undefined;

	constructor(
		private readonly backend: TerminalBridge | undefined,
		private readonly openExternal: Bridge["openExternal"],
	) {
		const saved = (() => {
			try {
				return JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}") as { height?: number };
			} catch {
				return {};
			}
		})();
		this.state = {
			open: false,
			height: clampTerminalHeight(saved.height ?? TERMINAL_DEFAULT_HEIGHT),
			tabs: [],
		};
		window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
			const theme = currentTheme();
			for (const instance of this.instances.values()) instance.term.options.theme = theme;
		});
	}

	get supported(): boolean {
		return this.backend !== undefined;
	}

	getState = (): TerminalState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private set(next: Partial<TerminalState>): void {
		this.state = { ...this.state, ...next };
		if ("height" in next) localStorage.setItem(PANEL_KEY, JSON.stringify({ height: this.state.height }));
		for (const listener of this.listeners) listener();
	}

	private patchTab(key: string, patch: Partial<TerminalTab>): void {
		if (!this.state.tabs.some((t) => t.key === key)) return;
		this.set({ tabs: this.state.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) });
	}

	/** Show or hide the panel; showing an empty panel opens a terminal in `workspace`. */
	toggle(options: OpenTerminalOptions = {}, open = !this.state.open): void {
		if (open === this.state.open) return;
		if (open && !this.state.tabs.length) {
			this.create(options);
			return;
		}
		this.set({ open });
		if (open) this.focusActive();
	}

	setHeight(height: number): void {
		const clamped = clampTerminalHeight(height);
		if (clamped !== this.state.height) this.set({ height: clamped });
	}

	select(key: string): void {
		if (this.state.active !== key) this.set({ active: key });
		this.focusActive();
	}

	/** Open a new terminal tab and show the panel. The shell starts once the tab is laid out. */
	create({ workspace, cwd }: OpenTerminalOptions = {}): string {
		const key = `t${++this.nextKey}`;
		const tab: TerminalTab = {
			key,
			status: "starting",
			...((cwd ?? workspace?.path) ? { cwd: cwd ?? workspace?.path } : {}),
			...(workspace ? { workspaceId: workspace.id, workspaceName: workspace.name } : {}),
		};
		this.instances.set(key, this.createInstance(key));
		this.set({ tabs: [...this.state.tabs, tab], active: key, open: true });
		return key;
	}

	/** Close a tab and hang up its shell. Closing the last tab hides the panel. */
	close(key: string): void {
		const instance = this.instances.get(key);
		if (instance) {
			this.instances.delete(key);
			if (instance.id !== undefined) void this.backend?.kill(instance.id).catch(() => {});
			instance.term.dispose();
			instance.element.remove();
		}
		const index = this.state.tabs.findIndex((t) => t.key === key);
		if (index < 0) return;
		const tabs = this.state.tabs.filter((t) => t.key !== key);
		const active =
			this.state.active === key ? (tabs[Math.min(index, tabs.length - 1)]?.key ?? undefined) : this.state.active;
		this.set({ tabs, active, open: tabs.length ? this.state.open : false });
		if (tabs.length) this.focusActive();
	}

	/** Hang up every shell, e.g. before quitting. */
	closeAll(): void {
		for (const tab of [...this.state.tabs]) this.close(tab.key);
	}

	clear(key: string): void {
		this.instances.get(key)?.term.clear();
	}

	/** Show a tab's terminal in `container` (the visible panel body), replacing the previous one. */
	attach(key: string, container: HTMLElement): void {
		const instance = this.instances.get(key);
		if (!instance) return;
		if (instance.element.parentElement !== container) container.replaceChildren(instance.element);
		if (!instance.opened) {
			instance.opened = true;
			instance.term.open(instance.element);
			this.fit(key);
			instance.term.focus();
			void this.start(key, instance);
		} else {
			this.fit(key);
			instance.term.refresh(0, instance.term.rows - 1);
		}
	}

	/** Resize a terminal to its container; the PTY follows through `onResize`. */
	fit(key: string): void {
		const instance = this.instances.get(key);
		if (!instance?.opened || !instance.element.isConnected || !instance.element.clientWidth) return;
		try {
			instance.fit.fit();
		} catch {
			// Not laid out yet.
		}
	}

	focus(key: string): void {
		this.instances.get(key)?.term.focus();
	}

	private focusActive(): void {
		const key = this.state.active;
		if (key) requestAnimationFrame(() => this.focus(key));
	}

	private createInstance(key: string): Instance {
		const element = document.createElement("div");
		element.className = "terminal-instance";
		const term = new Terminal({
			allowProposedApi: false,
			cursorBlink: true,
			fontFamily: fontFamily(),
			fontSize: 13,
			lineHeight: 1.15,
			macOptionIsMeta: true,
			scrollback: 5000,
			theme: currentTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.loadAddon(
			new WebLinksAddon((event, uri) => {
				event.preventDefault();
				void this.openExternal(uri);
			}),
		);
		const instance: Instance = { term, fit, element, opened: false, pending: [] };

		term.attachCustomKeyEventHandler((event) => this.handleKey(key, instance, event));
		term.onData((data) => this.input(key, instance, data, false));
		term.onBinary((data) => this.input(key, instance, data, true));
		term.onResize(({ cols, rows }) => {
			if (instance.id !== undefined) void this.backend?.resize(instance.id, cols, rows).catch(() => {});
		});
		term.onTitleChange((title) => this.patchTab(key, { title }));
		return instance;
	}

	/** `false` hands the key to the browser / app shortcuts instead of the shell. */
	private handleKey(key: string, instance: Instance, event: KeyboardEvent): boolean {
		if (event.type !== "keydown") return true;
		const lower = event.key.toLowerCase();
		const mod = isMac ? event.metaKey : event.ctrlKey;
		// App shortcuts: Ctrl+` toggles the terminal (on macOS too, like editors), Ctrl/⌘+Shift+E the file panel.
		if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === "`") return false;
		if (mod && event.shiftKey && !event.altKey && lower === "e") return false;
		if (isMac) {
			if (event.metaKey && !event.ctrlKey && !event.altKey && lower === "k") {
				event.preventDefault();
				instance.term.clear();
				return false;
			}
			// Other ⌘ shortcuts (copy, paste, select all) belong to the webview.
			return !event.metaKey;
		}
		if (event.ctrlKey && event.shiftKey && !event.altKey) {
			if (lower === "c") {
				event.preventDefault();
				const selection = instance.term.getSelection();
				if (selection) void navigator.clipboard?.writeText(selection).catch(() => {});
				return false;
			}
			if (lower === "v") {
				event.preventDefault();
				void navigator.clipboard
					?.readText()
					.then((text) => {
						if (text && this.instances.get(key) === instance) instance.term.paste(text);
					})
					.catch(() => {});
				return false;
			}
		}
		return true;
	}

	private input(key: string, instance: Instance, data: string, binary: boolean): void {
		const tab = this.state.tabs.find((t) => t.key === key);
		if (tab?.status === "exited" || tab?.status === "failed") {
			if (data === "\r") this.close(key);
			return;
		}
		if (instance.id === undefined) {
			instance.pending.push({ data, binary });
			return;
		}
		void this.backend?.write(instance.id, data, binary).catch(() => {});
	}

	private async start(key: string, instance: Instance): Promise<void> {
		const tab = this.state.tabs.find((t) => t.key === key);
		const backend = this.backend;
		if (!tab || !backend) {
			instance.term.write("\x1b[33m仅桌面应用支持终端。\x1b[0m\r\n");
			this.patchTab(key, { status: "failed" });
			return;
		}
		try {
			this.cleanup ??= backend.killAll().catch(() => {});
			await this.cleanup;
			const spawned = await backend.spawn(
				{ ...(tab.cwd ? { cwd: tab.cwd } : {}), cols: instance.term.cols, rows: instance.term.rows },
				{
					output: (data) => instance.term.write(data),
					exit: (code) => this.exited(key, instance, code),
				},
			);
			if (this.instances.get(key) !== instance) {
				// Closed while starting.
				void backend.kill(spawned.id).catch(() => {});
				return;
			}
			instance.id = spawned.id;
			this.patchTab(key, { status: "running", shell: spawned.shell, cwd: spawned.cwd });
			// The panel may have been resized while the shell was starting.
			void backend.resize(spawned.id, instance.term.cols, instance.term.rows).catch(() => {});
			for (const { data, binary } of instance.pending.splice(0)) {
				void backend.write(spawned.id, data, binary).catch(() => {});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			instance.term.write(`\x1b[31m无法启动终端：${message}\x1b[0m\r\n`);
			instance.term.write("\x1b[2m按回车键关闭\x1b[0m");
			this.patchTab(key, { status: "failed" });
		}
	}

	/** `exit` (code 0) closes the tab like other terminals; failures stay visible. */
	private exited(key: string, instance: Instance, code: number | null): void {
		if (this.instances.get(key) !== instance) return;
		instance.id = undefined;
		if (code === 0) {
			this.close(key);
			return;
		}
		const detail = code === null ? "进程已结束" : `进程已退出，代码 ${code}`;
		instance.term.write(`\r\n\x1b[2m[${detail}] 按回车键关闭\x1b[0m`);
		this.patchTab(key, { status: "exited", exitCode: code });
	}
}

export const terminals = new TerminalManager(bridge.terminal, bridge.openExternal);

export function useTerminals<T>(selector: (state: TerminalState) => T): T {
	return useSyncExternalStore(terminals.subscribe, () => selector(terminals.getState()));
}

/** Short tab label: `zsh · workspace`. */
export function terminalLabel(tab: TerminalTab): string {
	const shell = tab.shell ?? "终端";
	return tab.workspaceName ? `${shell} · ${tab.workspaceName}` : shell;
}
