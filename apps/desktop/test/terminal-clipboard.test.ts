import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The xterm instances the manager created, newest last. */
const created = vi.hoisted(() => [] as FakeTerminal[]);

interface FakeTerminal {
	selection: string;
	keyHandler: (event: KeyboardEvent) => boolean;
	pasted: string[];
	clearSelection: ReturnType<typeof vi.fn>;
	selectAll: ReturnType<typeof vi.fn>;
}

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		selection = "";
		pasted: string[] = [];
		keyHandler: (event: KeyboardEvent) => boolean = () => true;
		options = {};
		rows = 24;
		cols = 80;
		clearSelection = vi.fn(() => {
			this.selection = "";
		});
		selectAll = vi.fn();
		constructor() {
			created.push(this as unknown as FakeTerminal);
		}
		loadAddon() {}
		attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
			this.keyHandler = handler;
		}
		onData() {}
		onBinary() {}
		onResize() {}
		onTitleChange() {}
		hasSelection() {
			return this.selection !== "";
		}
		getSelection() {
			return this.selection;
		}
		paste(text: string) {
			this.pasted.push(text);
		}
		clear() {}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("../src/lib/theme.ts", () => ({ currentTheme: () => "dark", onThemeChange: () => () => {} }));
vi.mock("../src/lib/bridge.ts", () => ({
	bridge: { terminal: undefined, openExternal: async () => {}, readClipboardText: async () => "" },
}));

const writeText = vi.fn(async (_text: string) => {});

/** Load the terminal module as on `platform` (it reads the platform once, when loaded). */
async function load(platform: string) {
	vi.resetModules();
	vi.stubGlobal("navigator", { platform, userAgent: "", clipboard: { writeText } });
	const module = await import("../src/lib/terminals.ts");
	const readClipboard = vi.fn(async () => "echo hi");
	const manager = new module.TerminalManager(undefined, async () => {}, readClipboard);
	const key = manager.create();
	const term = created.at(-1) as FakeTerminal;
	return { ...module, manager, key, term, readClipboard };
}

function keydown(key: string, modifiers: { ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}) {
	return {
		type: "keydown",
		key,
		ctrlKey: modifiers.ctrl ?? false,
		shiftKey: modifiers.shift ?? false,
		metaKey: modifiers.meta ?? false,
		altKey: modifiers.alt ?? false,
		preventDefault: vi.fn(),
	} as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

/** Let the clipboard read resolve. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	created.length = 0;
	writeText.mockClear();
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	vi.stubGlobal("document", {
		createElement: () => ({ className: "", remove() {} }),
		documentElement: {},
	});
	vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
	vi.stubGlobal("requestAnimationFrame", () => 0);
	vi.stubGlobal("window", { innerHeight: 900 });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("terminal clipboard on Windows", () => {
	it("copies a selection with Ctrl+C and clears it, so the next Ctrl+C interrupts", async () => {
		const { term } = await load("Win32");
		term.selection = "ssh-ed25519 AAAA dev@host";
		const copy = keydown("c", { ctrl: true });
		expect(term.keyHandler(copy)).toBe(false);
		expect(copy.preventDefault).toHaveBeenCalled();
		expect(writeText).toHaveBeenCalledWith("ssh-ed25519 AAAA dev@host");
		expect(term.clearSelection).toHaveBeenCalled();

		expect(term.keyHandler(keydown("c", { ctrl: true }))).toBe(true);
		expect(writeText).toHaveBeenCalledTimes(1);
	});

	it("pastes the clipboard with Ctrl+V", async () => {
		const { term, readClipboard } = await load("Win32");
		const paste = keydown("v", { ctrl: true });
		expect(term.keyHandler(paste)).toBe(false);
		expect(paste.preventDefault).toHaveBeenCalled();
		await settle();
		expect(readClipboard).toHaveBeenCalledTimes(1);
		expect(term.pasted).toEqual(["echo hi"]);
	});

	it("leaves AltGr combinations (Ctrl+Alt) to the shell", async () => {
		const { term, readClipboard } = await load("Win32");
		term.selection = "x";
		expect(term.keyHandler(keydown("c", { ctrl: true, alt: true }))).toBe(true);
		expect(term.keyHandler(keydown("v", { ctrl: true, alt: true }))).toBe(true);
		expect(writeText).not.toHaveBeenCalled();
		expect(readClipboard).not.toHaveBeenCalled();
	});

	it("shows Windows shortcuts in the context menu", async () => {
		const { TERMINAL_SHORTCUTS } = await load("Win32");
		expect(TERMINAL_SHORTCUTS).toEqual({ copy: "Ctrl+C", paste: "Ctrl+V" });
	});
});

describe("terminal clipboard on Linux", () => {
	it("keeps Ctrl+C and Ctrl+V for the shell", async () => {
		const { term, readClipboard } = await load("Linux x86_64");
		term.selection = "selected";
		expect(term.keyHandler(keydown("c", { ctrl: true }))).toBe(true);
		expect(term.keyHandler(keydown("v", { ctrl: true }))).toBe(true);
		expect(writeText).not.toHaveBeenCalled();
		expect(readClipboard).not.toHaveBeenCalled();
	});

	it("copies with Ctrl+Shift+C and pastes with Ctrl+Shift+V through the bridge", async () => {
		const { term, readClipboard, TERMINAL_SHORTCUTS } = await load("Linux x86_64");
		term.selection = "selected";
		expect(term.keyHandler(keydown("C", { ctrl: true, shift: true }))).toBe(false);
		expect(writeText).toHaveBeenCalledWith("selected");
		expect(term.keyHandler(keydown("V", { ctrl: true, shift: true }))).toBe(false);
		await settle();
		expect(readClipboard).toHaveBeenCalledTimes(1);
		expect(term.pasted).toEqual(["echo hi"]);
		expect(TERMINAL_SHORTCUTS).toEqual({ copy: "Ctrl+Shift+C", paste: "Ctrl+Shift+V" });
	});
});

describe("terminal context menu actions", () => {
	it("copies, pastes and selects all in the chosen terminal", async () => {
		const { manager, key, term, readClipboard } = await load("Win32");
		expect(manager.hasSelection(key)).toBe(false);
		term.selection = "line";
		expect(manager.hasSelection(key)).toBe(true);
		manager.copySelection(key);
		expect(writeText).toHaveBeenCalledWith("line");
		// Copying from the menu keeps the selection.
		expect(term.clearSelection).not.toHaveBeenCalled();

		manager.paste(key);
		await settle();
		expect(readClipboard).toHaveBeenCalledTimes(1);
		expect(term.pasted).toEqual(["echo hi"]);

		manager.selectAll(key);
		expect(term.selectAll).toHaveBeenCalled();
	});

	it("drops a paste that resolves after the terminal closed", async () => {
		const { manager, key, term } = await load("Win32");
		manager.paste(key);
		manager.close(key);
		await settle();
		expect(term.pasted).toEqual([]);
	});

	it("uses the native ⌘ shortcuts on macOS", async () => {
		const { term, TERMINAL_SHORTCUTS } = await load("MacIntel");
		term.selection = "x";
		expect(term.keyHandler(keydown("c", { meta: true }))).toBe(false);
		expect(term.keyHandler(keydown("c", { ctrl: true }))).toBe(true);
		expect(writeText).not.toHaveBeenCalled();
		expect(TERMINAL_SHORTCUTS).toEqual({ copy: "⌘C", paste: "⌘V", clear: "⌘K" });
	});
});
