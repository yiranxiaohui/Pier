import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalPanelHost } from "../src/lib/terminals.ts";

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		options = {};
		rows = 24;
		cols = 80;
		loadAddon() {}
		attachCustomKeyEventHandler() {}
		onData() {}
		onBinary() {}
		onResize() {}
		onTitleChange() {}
		focus() {}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("../src/lib/theme.ts", () => ({ currentTheme: () => "dark", onThemeChange: () => () => {} }));
vi.mock("../src/lib/bridge.ts", () => ({
	bridge: { terminal: undefined, openExternal: async () => {}, readClipboardText: async () => "" },
}));

/** The right-hand panel's terminal tab, as the app installs it: shown or not, and what was asked. */
function fakePanel() {
	const calls: string[] = [];
	let shown = false;
	const panel: TerminalPanelHost = {
		shown: () => shown,
		show: () => {
			calls.push("show");
			shown = true;
		},
		hide: () => {
			calls.push("hide");
			shown = false;
		},
		closed: () => {
			calls.push("closed");
			shown = false;
		},
	};
	return { panel, calls, setShown: (value: boolean) => (shown = value) };
}

async function load() {
	vi.resetModules();
	const { TerminalManager } = await import("../src/lib/terminals.ts");
	const manager = new TerminalManager(
		undefined,
		async () => {},
		async () => "",
	);
	const fake = fakePanel();
	manager.setPanel(fake.panel);
	return { manager, ...fake };
}

beforeEach(() => {
	vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgent: "" });
	vi.stubGlobal("document", {
		createElement: () => ({ className: "", remove() {} }),
		documentElement: {},
	});
	vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
	vi.stubGlobal("requestAnimationFrame", () => 0);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("terminals in the right-hand panel", () => {
	it("shows the terminal tab for a new workspace terminal, not for a remote hosts page shell", async () => {
		const { manager, calls } = await load();
		manager.create({ node: "peer" });
		expect(calls).toEqual([]);
		manager.create();
		expect(calls).toEqual(["show"]);
		expect(manager.getState().tabs).toHaveLength(2);
	});

	it("toggles the tab, opening a terminal the first time and keeping the shells when hiding", async () => {
		const { manager, calls } = await load();
		manager.toggle();
		expect(calls).toEqual(["show"]);
		expect(manager.getState().tabs).toHaveLength(1);
		manager.toggle();
		expect(calls).toEqual(["show", "hide"]);
		expect(manager.getState().tabs).toHaveLength(1);
		// Showing again brings back the same terminal rather than another one.
		manager.toggle();
		expect(calls).toEqual(["show", "hide", "show"]);
		expect(manager.getState().tabs).toHaveLength(1);
	});

	it("only shows or only hides when asked to", async () => {
		const { manager, calls, setShown } = await load();
		manager.toggle({}, false);
		expect(calls).toEqual([]);
		manager.create();
		manager.toggle({}, true);
		expect(calls).toEqual(["show", "show"]);
		expect(manager.getState().tabs).toHaveLength(1);
		setShown(false);
		manager.toggle({}, false);
		expect(calls).toEqual(["show", "show"]);
	});

	it("closes the terminal tab with the last terminal", async () => {
		const { manager, calls } = await load();
		const first = manager.create();
		const second = manager.create();
		manager.close(first);
		expect(calls).toEqual(["show", "show"]);
		expect(manager.getState().active).toBe(second);
		manager.close(second);
		expect(calls).toEqual(["show", "show", "closed"]);
		expect(manager.getState()).toEqual({ tabs: [], active: undefined });
	});
});
