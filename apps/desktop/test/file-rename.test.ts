/* biome-ignore-all lint/complexity/useLiteralKeys: Seed store clients and nodes without changing the public API. */
import type { PierClient } from "@pier/client";
import { type HostInfo, PierProtocolError } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { LOCAL_NODE, PierStore } from "../src/lib/store.tsx";
import {
	beginWorkspacePaste,
	clearWorkspaceClipboard,
	finishWorkspacePaste,
	getWorkspaceClipboard,
	setWorkspaceClipboard,
} from "../src/lib/workspace-clipboard.ts";

beforeEach(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	clearWorkspaceClipboard();
	finishWorkspacePaste();
});
afterEach(() => {
	vi.unstubAllGlobals();
	clearWorkspaceClipboard();
	finishWorkspacePaste();
});

function setup(owner: string, version = "1.41", connection: "open" | "closed" = "open") {
	const store = new PierStore({ kind: "browser" } as Bridge);
	const request = vi.fn(async (_method: string, params: { path: string; destinationPath: string }) => ({
		sourcePath: params.path,
		path: params.destinationPath,
		kind: "file" as const,
	}));
	const otherRequest = vi.fn();
	store["clients"].set(owner, { request } as unknown as PierClient);
	store["clients"].set("other", { request: otherRequest } as unknown as PierClient);
	store["patchNode"](owner, { connection, hostInfo: { protocolVersion: version } as HostInfo });
	store["set"]({ node: "other", workspaceNodes: { workspace: owner } });
	return { store, request, otherRequest };
}

describe("workspace file renaming", () => {
	it.each([LOCAL_NODE, "peer"])("renames a dotfile on its owning computer (%s)", async (owner) => {
		const { store, request, otherRequest } = setup(owner);
		await store.renamePath("workspace", "docs/.env.example", " .env.local ");
		expect(request).toHaveBeenCalledWith("workspace.transferPath", {
			workspaceId: "workspace",
			path: "docs/.env.example",
			destinationWorkspaceId: "workspace",
			destinationPath: "docs/.env.local",
			mode: "move",
		});
		expect(otherRequest).not.toHaveBeenCalled();
		expect(store.getState().filesVersion.workspace).toBe(1);
	});

	it("updates copied/cut roots and descendants while preserving unrelated paths", async () => {
		const { store } = setup("peer");
		setWorkspaceClipboard("move", "workspace", [
			{ path: "folder", name: "folder", kind: "directory" },
			{ path: "folder/nested/file.txt", name: "file.txt", kind: "file" },
			{ path: "folder-old/keep.txt", name: "keep.txt", kind: "file" },
		]);
		store.openFilePreview("workspace", "folder/nested/file.txt");
		await store.renamePath("workspace", "folder", "renamed");
		expect(getWorkspaceClipboard()).toMatchObject({
			mode: "move",
			entries: [
				{ path: "renamed", name: "renamed" },
				{ path: "renamed/nested/file.txt", name: "file.txt" },
				{ path: "folder-old/keep.txt", name: "keep.txt" },
			],
		});
		expect(store.getState().filePreviews).toEqual([]);
		expect(store.getState().activeFilePreview).toBeUndefined();
	});

	it("keeps previews and clipboard entries from other workspaces", async () => {
		const { store } = setup("peer");
		setWorkspaceClipboard("copy", "other-workspace", [{ path: "file", name: "file", kind: "file" }]);
		const clipboard = getWorkspaceClipboard();
		store.openFilePreview("other-workspace", "file");
		await store.renamePath("workspace", "file", "renamed");
		expect(getWorkspaceClipboard()).toBe(clipboard);
		expect(store.getState().filePreviews.map((tab) => tab.path)).toEqual(["file"]);
	});

	it("preserves state on conflict and permits retrying with another name", async () => {
		const { store, request } = setup("peer");
		setWorkspaceClipboard("copy", "workspace", [{ path: "file", name: "file", kind: "file" }]);
		const clipboard = getWorkspaceClipboard();
		store.openFilePreview("workspace", "file");
		request.mockRejectedValueOnce(new PierProtocolError("CONFLICT", "Already exists"));
		await expect(store.renamePath("workspace", "file", "existing")).rejects.toMatchObject({ code: "CONFLICT" });
		expect(getWorkspaceClipboard()).toBe(clipboard);
		expect(store.getState().filePreviews.map((tab) => tab.path)).toEqual(["file"]);
		expect(store.getState().filesVersion.workspace).toBeUndefined();
		await store.renamePath("workspace", "file", "available");
		expect(getWorkspaceClipboard()?.entries[0]?.path).toBe("available");
	});

	it.each(["", ".", "..", "../escape", "nested/file", "nested\\file", "C:escape", "bad\0name", "file"])(
		"rejects an invalid or unchanged name (%j) before contacting the Host",
		async (name) => {
			const { store, request } = setup("peer");
			await expect(store.renamePath("workspace", "file", name)).rejects.toThrow();
			expect(request).not.toHaveBeenCalled();
		},
	);

	it("requires an online compatible Host and waits for other moves to finish", async () => {
		const outdated = setup("peer", "1.40");
		await expect(outdated.store.renamePath("workspace", "file", "new")).rejects.toThrow("请先更新");
		expect(outdated.request).not.toHaveBeenCalled();
		const offline = setup("peer", "1.41", "closed");
		await expect(offline.store.renamePath("workspace", "file", "new")).rejects.toThrow("尚未连接");
		expect(offline.request).not.toHaveBeenCalled();
		const busy = setup("peer");
		beginWorkspacePaste();
		await expect(busy.store.renamePath("workspace", "file", "new")).rejects.toThrow("请稍后重试");
		expect(busy.request).not.toHaveBeenCalled();
	});
});
