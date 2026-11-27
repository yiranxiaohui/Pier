import { PierProtocolError, type WorkspaceFileEntry, type WorkspaceInfo } from "@pier/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PasteConflictAnswer, PasteConflictQuestion } from "../src/lib/file-transfers.ts";
import { transfers } from "../src/lib/file-transfers.ts";
import {
	canPasteInto,
	clearHostClipboard,
	type FileScope,
	fileAbilities,
	getHostClipboard,
	isCut,
	newEntryPath,
	pasteHostEntries,
	renameEntry,
	scopeAbsolute,
	scopeFiles,
	setHostClipboard,
	sortFileEntries,
} from "../src/lib/host-files.ts";

interface Call {
	method: string;
	params: Record<string, unknown>;
}

function fakeClient(handle: (call: Call) => unknown = () => ({})) {
	const calls: Call[] = [];
	const client = {
		request: async (method: string, params: Record<string, unknown>) => {
			const call = { method, params };
			calls.push(call);
			return handle(call);
		},
	};
	return { client: client as never, calls };
}

const home: FileScope = { kind: "host", node: "peer", directory: "/home/me" };
const docs: FileScope = { kind: "host", node: "peer", directory: "/home/me/docs" };
const workspace = { id: "w1", path: "/ws", name: "ws" } as WorkspaceInfo;
const src: FileScope = { kind: "workspace", node: "local", workspace, dir: "src" };

function entry(name: string, kind: WorkspaceFileEntry["kind"], extra: Partial<WorkspaceFileEntry> = {}) {
	return { name, path: name, kind, ...extra } as WorkspaceFileEntry;
}

function info(protocolVersion: string) {
	return { protocolVersion } as never;
}

beforeEach(() => {
	clearHostClipboard();
	for (const t of transfers.snapshot()) transfers.cancel(t.id);
	transfers.clearFinished("host:peer");
});

describe("host file scopes", () => {
	it("maps operations to host methods with the shown directory", async () => {
		const { client, calls } = fakeClient();
		const files = scopeFiles(client, home);
		await files.createFile("notes/todo.md");
		await files.createDirectory("projects");
		await files.deletePath("old");
		await files.readFile("a.txt");
		await files.readBytes("clip.mp4", 1024, 2048);
		await files.writeFile("a.txt", "text", "2026-01-01T00:00:00.000Z");
		await files.transferTo("a.txt", docs, "b.txt", "copy");
		expect(calls).toEqual([
			{ method: "host.createFile", params: { directory: "/home/me", path: "notes/todo.md" } },
			{ method: "host.createDirectory", params: { directory: "/home/me", path: "projects" } },
			{ method: "host.deletePath", params: { directory: "/home/me", path: "old" } },
			{ method: "host.readFile", params: { directory: "/home/me", path: "a.txt" } },
			{ method: "host.readBytes", params: { directory: "/home/me", path: "clip.mp4", offset: 1024, length: 2048 } },
			{
				method: "host.writeFile",
				params: { directory: "/home/me", path: "a.txt", text: "text", expectedModifiedAt: "2026-01-01T00:00:00.000Z" },
			},
			{
				method: "host.transferPath",
				params: {
					directory: "/home/me",
					path: "a.txt",
					destinationDirectory: "/home/me/docs",
					destinationPath: "b.txt",
					mode: "copy",
					overwrite: false,
				},
			},
		]);
	});

	it("maps operations to workspace methods on older hosts", async () => {
		const { client, calls } = fakeClient();
		const files = scopeFiles(client, src);
		await files.createFile("src/a.ts");
		await files.transferTo("src/a.ts", { ...src, dir: "" }, "a.ts", "move");
		await files.readBytes("src/clip.mp4", 0, 10);
		expect(calls.map((call) => call.method)).toEqual([
			"workspace.createFile",
			"workspace.transferPath",
			"workspace.readBytes",
		]);
		expect(calls[1]?.params).toMatchObject({ workspaceId: "w1", destinationWorkspaceId: "w1", mode: "move" });
		expect(calls[2]?.params).toEqual({ workspaceId: "w1", path: "src/clip.mp4", offset: 0, length: 10 });
		await expect(files.transferTo("src/a.ts", home, "a.ts", "copy")).rejects.toThrow(/同一台主机/);
	});

	it("knows what each host version supports", () => {
		expect(fileAbilities("host", info("1.57"))).toEqual({ transfer: true, manage: false });
		expect(fileAbilities("host", info("1.58"))).toEqual({ transfer: true, manage: true });
		expect(fileAbilities("workspace", info("1.40"))).toEqual({ transfer: true, manage: false });
		expect(fileAbilities("workspace", info("1.41"))).toEqual({ transfer: true, manage: true });
		expect(fileAbilities("host", undefined)).toEqual({ transfer: false, manage: false });
	});

	it("builds absolute paths and new entry paths", () => {
		expect(scopeAbsolute(home, "a.txt")).toBe("/home/me/a.txt");
		expect(scopeAbsolute({ kind: "host", node: "w", directory: "C:\\Users\\me" }, "a.txt")).toBe(
			"C:\\Users\\me\\a.txt",
		);
		expect(scopeAbsolute(src, "src/a.ts")).toBe("/ws/src/a.ts");
		expect(newEntryPath(home, " notes/todo.md ")).toBe("notes/todo.md");
		expect(newEntryPath(src, "a.ts")).toBe("src/a.ts");
		for (const bad of ["", "/etc/passwd", "../x", "a/../../b", "C:\\x", "a\u0001b"]) {
			expect(newEntryPath(home, bad)).toBeUndefined();
		}
	});

	it("renames inside the same directory", async () => {
		const { client, calls } = fakeClient(() => ({ sourcePath: "a.txt", path: "b.txt", kind: "file" }));
		await renameEntry(client, home, { path: "a.txt", name: "a.txt" }, " b.txt ");
		expect(calls[0]).toEqual({
			method: "host.transferPath",
			params: {
				directory: "/home/me",
				path: "a.txt",
				destinationDirectory: "/home/me",
				destinationPath: "b.txt",
				mode: "move",
				overwrite: false,
			},
		});
		await renameEntry(client, src, { path: "src/a.ts", name: "a.ts" }, "b.ts");
		expect(calls[1]?.params).toMatchObject({ path: "src/a.ts", destinationPath: "src/b.ts" });
		await expect(renameEntry(client, home, { path: "a", name: "a" }, "x/y")).rejects.toThrow(/路径分隔符/);
		await expect(renameEntry(client, home, { path: "a", name: "a" }, "a")).rejects.toThrow(/新的名称/);
	});

	it("sorts folders first by the chosen column", () => {
		const entries = [
			entry("b.txt", "file", { size: 5, modifiedAt: "2026-01-03T00:00:00Z" }),
			entry("A", "directory", { modifiedAt: "2026-01-01T00:00:00Z" }),
			entry("a10.txt", "file", { size: 50, modifiedAt: "2026-01-01T00:00:00Z" }),
			entry("a9.txt", "file", { size: 500, modifiedAt: "2026-01-02T00:00:00Z" }),
		];
		const names = (by: "name" | "size" | "modified", desc = false) =>
			sortFileEntries(entries, { by, desc }).map((item) => item.name);
		expect(names("name")).toEqual(["A", "a9.txt", "a10.txt", "b.txt"]);
		expect(names("name", true)).toEqual(["A", "b.txt", "a10.txt", "a9.txt"]);
		expect(names("size", true)).toEqual(["A", "a9.txt", "a10.txt", "b.txt"]);
		expect(names("modified")).toEqual(["A", "a10.txt", "a9.txt", "b.txt"]);
	});
});

describe("host clipboard", () => {
	it("pastes only on the same computer", () => {
		setHostClipboard("move", home, [{ path: "a.txt", name: "a.txt", kind: "file" }]);
		const clip = getHostClipboard();
		expect(canPasteInto(clip, docs)).toBe(true);
		expect(canPasteInto(clip, { ...docs, node: "other" })).toBe(false);
		expect(canPasteInto(clip, src)).toBe(false);
		expect(isCut(clip, home, "a.txt")).toBe(true);
		expect(isCut(clip, docs, "a.txt")).toBe(false);
	});

	it("moves entries, renames on conflict and keeps failed ones on the clipboard", async () => {
		const { client, calls } = fakeClient((call) => {
			const { path, destinationPath } = call.params as { path: string; destinationPath: string };
			if (path === "a.txt" && destinationPath === "a.txt")
				throw new PierProtocolError("CONFLICT", "Destination already exists: a.txt", { kind: "file" });
			if (path === "locked") throw new PierProtocolError("FORBIDDEN", "Permission denied: locked");
			return { sourcePath: path, path: destinationPath, kind: "file" };
		});
		setHostClipboard("move", home, [
			{ path: "a.txt", name: "a.txt", kind: "file" },
			{ path: "locked", name: "locked", kind: "directory" },
		]);
		const snapshot = getHostClipboard();
		if (!snapshot) throw new Error("no clipboard");
		const store = { toast: vi.fn(), bumpFiles: vi.fn() };
		const questions: PasteConflictQuestion[] = [];
		const ask = async (question: PasteConflictQuestion): Promise<PasteConflictAnswer> => {
			questions.push(question);
			return { choice: "rename", name: question.suggestedName };
		};
		await pasteHostEntries(store, client, snapshot, docs, ask);
		expect(questions).toEqual([
			expect.objectContaining({ path: "/home/me/docs/a.txt", suggestedName: "a (副本).txt", canOverwrite: true }),
		]);
		expect(calls.map((call) => call.params.destinationPath)).toEqual(["a.txt", "a (副本).txt", "locked"]);
		expect(getHostClipboard()?.entries.map((item) => item.path)).toEqual(["locked"]);
		expect(store.bumpFiles).toHaveBeenCalledWith("host:peer");
		expect(store.toast).toHaveBeenCalledWith("error", expect.stringContaining("1 项失败"));
	});

	it("refuses pasting onto another computer", async () => {
		const { client, calls } = fakeClient();
		setHostClipboard("copy", home, [{ path: "a.txt", name: "a.txt", kind: "file" }]);
		const snapshot = getHostClipboard();
		if (!snapshot) throw new Error("no clipboard");
		const store = { toast: vi.fn(), bumpFiles: vi.fn() };
		await pasteHostEntries(store, client, snapshot, { ...docs, node: "other" }, async () => ({ choice: "cancel" }));
		expect(calls).toEqual([]);
		expect(store.toast).toHaveBeenCalledWith("error", expect.stringContaining("同一台主机"));
	});
});
