/* biome-ignore-all lint/complexity/useLiteralKeys: Seed clients and nodes without changing the public API. */
import type { PierClient } from "@pier/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { LOCAL_NODE, PierStore } from "../src/lib/store.tsx";

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} }));
afterEach(() => vi.unstubAllGlobals());
function setup(node: string, version = "1.48") {
	const openExternal = vi.fn(async () => {});
	const store = new PierStore({ kind: "browser", openExternal } as unknown as Bridge);
	const request = vi.fn(async () => ({ browserId: "browser", mode: "remote" }));
	store["clients"].set(LOCAL_NODE, { request, host: { protocolVersion: version } } as unknown as PierClient);
	store["set"]({ workspaceNodes: { workspace: node } });
	return { store, request, openExternal };
}
describe("workspace browser routing", () => {
	it("opens the system browser locally without launching a managed process", async () => {
		const { store, request, openExternal } = setup(LOCAL_NODE);
		await store.openBrowser("workspace", "http://localhost:3000/path?q=1#tab");
		expect(openExternal).toHaveBeenCalledWith("http://localhost:3000/path?q=1#tab");
		expect(request).not.toHaveBeenCalled();
	});
	it("launches on the remote host and leaves localhost in that host's namespace", async () => {
		const { store, request, openExternal } = setup("peer");
		await store.openBrowser("workspace", "http://localhost:3000/path", true);
		expect(request).toHaveBeenCalledWith(
			"browser.open",
			{
				workspaceId: "workspace",
				peerId: "peer",
				url: "http://localhost:3000/path",
				mode: "remote",
				controlled: true,
				transport: "webrtc",
			},
			{ timeoutMs: 900_000 },
		);
		expect(openExternal).not.toHaveBeenCalled();
	});
	it("requires opt-in for a controlled local window and supports the compatible remote transport", async () => {
		const local = setup(LOCAL_NODE);
		await local.store.openBrowser("workspace", "https://example.com", true);
		expect(local.request).toHaveBeenCalledWith(
			"browser.open",
			{ workspaceId: "workspace", url: "https://example.com/", mode: "service", controlled: true },
			{ timeoutMs: 60_000 },
		);
		const remote = setup("peer");
		await remote.store.openBrowser("workspace", "https://example.com", false, "websockets");
		expect(remote.request.mock.calls[0]).toEqual([
			"browser.open",
			expect.objectContaining({ mode: "remote", transport: "websockets" }),
			{ timeoutMs: 900_000 },
		]);
	});
	it("rejects old hosts and unsafe URLs before launching anything", async () => {
		const { store, request, openExternal } = setup("peer", "1.46");
		await expect(store.openBrowser("workspace", "https://example.com")).rejects.toThrow("请先更新");
		for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com"])
			await expect(store.openBrowser("workspace", url)).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
	});
	it("launches a managed window locally for the panel, once this computer's Host can drive it", async () => {
		const { store, request, openExternal } = setup(LOCAL_NODE, "1.67");
		await store.openBrowser("workspace", "http://localhost:3000/", false, "webrtc", true);
		expect(request).toHaveBeenCalledWith(
			"browser.open",
			{ workspaceId: "workspace", url: "http://localhost:3000/", mode: "service", controlled: false, managed: true },
			{ timeoutMs: 60_000 },
		);
		expect(openExternal).not.toHaveBeenCalled();
		expect(store.canControlBrowsers).toBe(true);
		const old = setup(LOCAL_NODE, "1.66");
		await expect(old.store.openBrowser("workspace", "http://localhost:3000/", false, "webrtc", true)).rejects.toThrow(
			"1.67",
		);
		expect(old.store.canControlBrowsers).toBe(false);
		expect(old.request).not.toHaveBeenCalled();
	});
	it("drives the browser through this computer's Host", async () => {
		const { store, request } = setup("peer", "1.67");
		await store.browserControl("browser", { op: "navigate", url: "http://localhost:5173/" });
		expect(request).toHaveBeenCalledWith(
			"browser.control",
			{ browserId: "browser", command: { op: "navigate", url: "http://localhost:5173/" } },
			{ timeoutMs: 30_000 },
		);
	});
});

describe("attaching browser picks to a composer", () => {
	const context = {
		id: "c1",
		kind: "element" as const,
		label: "div.card",
		text: "<browser-element>…</browser-element>",
	};
	const image = { data: "AAAA", mimeType: "image/png", name: "div.card" };
	it("hands them to the composer on screen", () => {
		const store = new PierStore({ kind: "browser" } as unknown as Bridge);
		const attach = vi.fn();
		const unregister = store.registerComposer("session", { insertFile: vi.fn(), attach });
		store.attachToComposer("session", { context, images: [image] });
		expect(attach).toHaveBeenCalledWith({ context, images: [image] });
		expect(store.draft("session")).toEqual({ text: "", images: [] });
		unregister();
	});
	it("keeps them in the saved draft of a composer that is not on screen, up to 16 images", () => {
		const store = new PierStore({ kind: "browser" } as unknown as Bridge);
		store.saveDraft("session", { text: "hi", images: Array.from({ length: 15 }, () => image) });
		store.attachToComposer("session", { context, images: [image, image] });
		const draft = store.draft("session");
		expect(draft.text).toBe("hi");
		expect(draft.images).toHaveLength(16);
		expect(draft.contexts).toEqual([context]);
		// A draft with only a pick is kept.
		store.attachToComposer("other", { context });
		expect(store.draft("other")).toEqual({ text: "", images: [], contexts: [context] });
	});
});
