import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { FILE_PREVIEW_MAX_WIDTH, FILE_PREVIEW_MIN_WIDTH, PierStore } from "../src/lib/store.tsx";

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
