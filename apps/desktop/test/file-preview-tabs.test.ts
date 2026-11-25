import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import {
	FILE_PREVIEW_MAX_WIDTH,
	FILE_PREVIEW_MIN_WIDTH,
	isRightPanelOpen,
	isRightPanelViewShown,
	PierStore,
} from "../src/lib/store.tsx";

let storage: Map<string, string>;

beforeEach(() => {
	storage = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
});
afterEach(() => vi.unstubAllGlobals());

const newStore = () => new PierStore({ kind: "browser" } as Bridge);
const paths = (store: PierStore) => store.getState().filePreviews.map((tab) => tab.path);
const activePath = (store: PierStore) =>
	store.getState().filePreviews.find((tab) => tab.id === store.getState().activeFilePreview)?.path;

describe("file preview tabs", () => {
	it("opens each file once, after the tab on screen", () => {
		const store = newStore();
		store.openFilePreview("w", "a.ts");
		store.openFilePreview("w", "b.ts");
		store.selectFilePreview(store.getState().filePreviews[0]?.id ?? "");
		store.openFilePreview("w", "c.ts", "session");
		expect(paths(store)).toEqual(["a.ts", "c.ts", "b.ts"]);
		expect(activePath(store)).toBe("c.ts");

		store.openFilePreview("w", "b.ts", "session");
		expect(paths(store)).toEqual(["a.ts", "c.ts", "b.ts"]);
		expect(activePath(store)).toBe("b.ts");
		expect(store.getState().filePreviews[2]?.composerKey).toBe("session");
	});

	it("keeps Markdown previews, other workspaces and the same path apart", () => {
		const store = newStore();
		store.openFilePreview("w", "doc.md");
		store.openMarkdownFilePreview("w", "doc.md");
		store.openFilePreview("other", "doc.md");
		const tabs = store.getState().filePreviews;
		expect(tabs).toHaveLength(3);
		expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3);
		expect(tabs[1]?.fromMarkdown).toBe(true);
	});

	it("shows the right-hand neighbour, else the left one, after closing the tab on screen", () => {
		const store = newStore();
		for (const path of ["a", "b", "c"]) store.openFilePreview("w", path);
		const [a, b, c] = store.getState().filePreviews.map((tab) => tab.id);
		store.selectFilePreview(b ?? "");
		store.closeFilePreview(b);
		expect(paths(store)).toEqual(["a", "c"]);
		expect(store.getState().activeFilePreview).toBe(c);
		store.closeFilePreview(c);
		expect(store.getState().activeFilePreview).toBe(a);
		store.openFilePreview("w", "d");
		store.closeFilePreview(a);
		expect(activePath(store)).toBe("d");
		store.closeFilePreview();
		expect(store.getState().filePreviews).toEqual([]);
		expect(store.getState().activeFilePreview).toBeUndefined();
	});

	it("closes previews of a moved or deleted path and everything inside it", () => {
		const store = newStore();
		store.openFilePreview("w", "docs/a.md");
		store.openFilePreview("w", "docs/sub/b.md");
		store.openFilePreview("w", "docs-old/c.md");
		store.openFilePreview("other", "docs/a.md");
		store.closeMovedFilePreview("w", "docs");
		expect(store.getState().filePreviews.map((tab) => `${tab.workspaceId}:${tab.path}`)).toEqual([
			"w:docs-old/c.md",
			"other:docs/a.md",
		]);
		expect(activePath(store)).toBe("docs/a.md");
	});

	it("remembers the display mode and panel width on this device", () => {
		const store = newStore();
		expect(store.getState().filePreviewMode).toBe("panel");
		expect(store.getState().filePreviewWidth).toBeUndefined();
		store.setFilePreviewMode("modal");
		store.setFilePreviewWidth(99_999);
		expect(store.getState().filePreviewWidth).toBe(FILE_PREVIEW_MAX_WIDTH);
		store.setFilePreviewWidth(12.4);
		expect(store.getState().filePreviewWidth).toBe(FILE_PREVIEW_MIN_WIDTH);
		store.setFilePreviewWidth(720.6);

		const restored = newStore().getState();
		expect(restored.filePreviewMode).toBe("modal");
		expect(restored.filePreviewWidth).toBe(721);
		expect(restored.filePreviews).toEqual([]);

		store.setFilePreviewWidth(undefined);
		expect(newStore().getState().filePreviewWidth).toBeUndefined();
	});

	it("ignores a damaged saved preference", () => {
		storage.set("pier.filePreview", JSON.stringify({ mode: "sideways", width: "wide" }));
		const damaged = newStore().getState();
		expect(damaged.filePreviewMode).toBe("panel");
		expect(damaged.filePreviewWidth).toBeUndefined();
		storage.set("pier.filePreview", "{not json");
		expect(newStore().getState().filePreviewMode).toBe("panel");
		storage.set("pier.filePreview", "null");
		expect(newStore().getState().filePreviewMode).toBe("panel");
	});
});

describe("file tabs in the right-hand panel", () => {
	const withWorkspace = () => {
		const store = newStore();
		(store as unknown as { set(patch: object): void }).set({
			workspaces: [{ id: "w", name: "w", path: "/w", policy: "smart" }],
		});
		return store;
	};

	it("opens the panel on a file tab and hides it again when the last one closes", () => {
		const store = withWorkspace();
		expect(isRightPanelOpen(store.getState())).toBe(false);
		store.openFilePreview("w", "a.ts");
		expect(store.getState()).toMatchObject({ filePreviewShown: true, filesPanel: false });
		expect(isRightPanelOpen(store.getState())).toBe(true);
		store.closeFilePreview(store.getState().activeFilePreview);
		expect(store.getState().filePreviewShown).toBe(false);
		expect(isRightPanelOpen(store.getState())).toBe(false);
	});

	it("switches between the files / source control views and the file tabs", () => {
		const store = withWorkspace();
		store.showRightPanel("files");
		store.openFilePreview("w", "a.ts");
		store.openFilePreview("w", "b.ts");
		store.showRightPanel("git");
		expect(store.getState()).toMatchObject({ rightPanelTab: "git", filePreviewShown: false, filesPanel: true });
		expect(paths(store)).toEqual(["a.ts", "b.ts"]);
		const first = store.getState().filePreviews[0]?.id ?? "";
		store.selectFilePreview(first);
		expect(store.getState()).toMatchObject({ activeFilePreview: first, filePreviewShown: true });
		// Closing every file shows the source control view again.
		store.closeFilePreview();
		expect(store.getState()).toMatchObject({ rightPanelTab: "git", filePreviewShown: false });
		expect(isRightPanelOpen(store.getState())).toBe(true);
	});

	it("hides the panel, file tabs included, and keeps the tabs for later", () => {
		const store = withWorkspace();
		store.openFilePreview("w", "a.ts");
		store.toggleFilesPanel();
		expect(isRightPanelOpen(store.getState())).toBe(false);
		expect(paths(store)).toEqual(["a.ts"]);
		store.toggleFilesPanel();
		expect(store.getState()).toMatchObject({ filesPanel: true, filePreviewShown: false });
		store.openSubagent("session", "agent");
		expect(store.getState()).toMatchObject({ rightPanelTab: "subagent", filePreviewShown: false });
	});

	it("does not count a full-window file dialog as the open panel", () => {
		const store = withWorkspace();
		store.setFilePreviewMode("modal");
		store.openFilePreview("w", "a.ts");
		expect(store.getState().filePreviewShown).toBe(true);
		expect(isRightPanelOpen(store.getState())).toBe(false);
	});
});

describe("views opened from the right-hand panel's launcher", () => {
	const withWorkspace = () => {
		const store = newStore();
		(store as unknown as { set(patch: object): void }).set({
			workspaces: [{ id: "w", name: "w", path: "/w", policy: "smart" }],
		});
		return store;
	};
	const panel = (store: PierStore) => {
		const { rightPanelTabs, rightPanelTab, filesPanel, filePreviewShown } = store.getState();
		return { rightPanelTabs, rightPanelTab, filesPanel, filePreviewShown };
	};

	it("starts with no view open: the panel shows its launcher", () => {
		const store = withWorkspace();
		expect(panel(store)).toEqual({
			rightPanelTabs: [],
			rightPanelTab: "launcher",
			filesPanel: false,
			filePreviewShown: false,
		});
		store.toggleFilesPanel();
		expect(panel(store)).toMatchObject({ rightPanelTab: "launcher", filesPanel: true });
		expect(isRightPanelOpen(store.getState())).toBe(true);
	});

	it("opens each view once, in the order they were opened", () => {
		const store = withWorkspace();
		store.showRightPanel("git");
		store.showRightPanel("files");
		store.showRightPanel("git");
		expect(panel(store)).toEqual({
			rightPanelTabs: ["git", "files"],
			rightPanelTab: "git",
			filesPanel: true,
			filePreviewShown: false,
		});
		store.openFilePreview("w", "a.ts");
		store.showRightPanelLauncher();
		expect(panel(store)).toMatchObject({ rightPanelTabs: ["git", "files"], rightPanelTab: "launcher" });
		expect(store.getState().filePreviewShown).toBe(false);
	});

	it("hands over to the right-hand neighbour when the view on screen closes", () => {
		const store = withWorkspace();
		store.showRightPanel("files");
		store.showRightPanel("git");
		store.openSubagent("session", "agent");
		store.showRightPanel("git");
		store.closeRightPanelTab("git");
		expect(panel(store)).toMatchObject({ rightPanelTabs: ["files", "subagent"], rightPanelTab: "subagent" });
		store.closeRightPanelTab("subagent");
		expect(store.getState().subagentView).toBeUndefined();
		expect(panel(store)).toMatchObject({ rightPanelTabs: ["files"], rightPanelTab: "files", filesPanel: true });
		// The last view closing leaves the panel open on its launcher.
		store.closeRightPanelTab("files");
		expect(panel(store)).toEqual({
			rightPanelTabs: [],
			rightPanelTab: "launcher",
			filesPanel: true,
			filePreviewShown: false,
		});
	});

	it("shows the first file tab after the last view, and closes views off screen quietly", () => {
		const store = withWorkspace();
		store.showRightPanel("files");
		store.showRightPanel("git");
		store.openFilePreview("w", "a.ts");
		store.openFilePreview("w", "b.ts");
		store.closeRightPanelTab("files");
		expect(panel(store)).toMatchObject({ rightPanelTabs: ["git"], filePreviewShown: true });
		expect(activePath(store)).toBe("b.ts");
		store.showRightPanel("git");
		store.closeRightPanelTab("git");
		expect(panel(store)).toMatchObject({ rightPanelTabs: [], rightPanelTab: "launcher", filePreviewShown: true });
		expect(activePath(store)).toBe("a.ts");
		store.closeFilePreview();
		expect(panel(store)).toMatchObject({ rightPanelTab: "launcher", filesPanel: true, filePreviewShown: false });
	});

	it("drops the subagent's tab when its session is left", () => {
		const store = withWorkspace();
		store.openSubagent("session", "agent");
		expect(panel(store)).toMatchObject({ rightPanelTabs: ["subagent"], rightPanelTab: "subagent" });
		store.closeSubagent();
		expect(store.getState().subagentView).toBeUndefined();
		expect(panel(store)).toMatchObject({ rightPanelTabs: [], rightPanelTab: "launcher", filesPanel: true });
		store.showRightPanel("subagent");
		expect(store.getState().rightPanelTabs).toEqual([]);
	});

	it("remembers the open views on this device, without a subagent", () => {
		const store = withWorkspace();
		store.showRightPanel("git");
		store.showRightPanel("files");
		store.openSubagent("session", "agent");
		expect(panel(newStore())).toEqual({
			rightPanelTabs: ["git", "files"],
			rightPanelTab: "files",
			filesPanel: true,
			filePreviewShown: false,
		});
		store.showRightPanelLauncher();
		expect(newStore().getState().rightPanelTab).toBe("launcher");
	});

	it("remembers the browser's tab too", () => {
		const store = withWorkspace();
		store.showRightPanel("files");
		store.showRightPanel("browser");
		expect(panel(newStore())).toMatchObject({ rightPanelTabs: ["files", "browser"], rightPanelTab: "browser" });
		store.closeRightPanelTab("browser");
		expect(panel(newStore())).toMatchObject({ rightPanelTabs: ["files"], rightPanelTab: "files" });
	});

	it("does not bring the terminals' tab back after a restart: their shells end", () => {
		const store = withWorkspace();
		store.showRightPanel("git");
		store.showRightPanel("terminal");
		expect(isRightPanelViewShown(store.getState(), "terminal")).toBe(true);
		expect(panel(newStore())).toEqual({
			rightPanelTabs: ["git"],
			rightPanelTab: "git",
			filesPanel: true,
			filePreviewShown: false,
		});
		store.closeRightPanelTab("git");
		expect(panel(newStore())).toMatchObject({ rightPanelTabs: [], rightPanelTab: "launcher" });
	});

	it("tells whether a view is on screen, not under a file tab or in a hidden panel", () => {
		const store = withWorkspace();
		store.showRightPanel("terminal");
		store.openFilePreview("w", "a.ts");
		expect(isRightPanelViewShown(store.getState(), "terminal")).toBe(false);
		store.showRightPanel("terminal");
		expect(isRightPanelViewShown(store.getState(), "terminal")).toBe(true);
		store.toggleFilesPanel(false);
		expect(isRightPanelViewShown(store.getState(), "terminal")).toBe(false);
		expect(store.getState().rightPanelTabs).toEqual(["terminal"]);
	});

	it("keeps the view of a panel saved before views were opened on demand", () => {
		storage.set("pier.filesPanel", JSON.stringify({ open: true, width: 300, tab: "git" }));
		expect(panel(newStore())).toMatchObject({ rightPanelTabs: ["git"], rightPanelTab: "git", filesPanel: true });
		storage.set("pier.filesPanel", JSON.stringify({ open: false, tab: "git" }));
		expect(panel(newStore())).toMatchObject({ rightPanelTabs: [], rightPanelTab: "launcher" });
		storage.set("pier.filesPanel", JSON.stringify({ open: true, tabs: ["files", "subagent", "x", "files"], tab: "x" }));
		expect(panel(newStore())).toMatchObject({ rightPanelTabs: ["files"], rightPanelTab: "files" });
		storage.set("pier.filesPanel", "null");
		expect(panel(newStore())).toMatchObject({ rightPanelTabs: [], rightPanelTab: "launcher", filesPanel: false });
	});
});
