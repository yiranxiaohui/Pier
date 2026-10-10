/* biome-ignore-all lint/complexity/useLiteralKeys: Bracket access lets this harness seed private store state without changing its public API. */
import type { ChatController } from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import { type EventFrame, PierProtocolError, type SessionSummary, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { LOCAL_NODE, PierStore } from "../src/lib/store.tsx";

const removed: WorkspaceInfo = { id: "removed", name: "Removed", path: "/removed", policy: "ask" };
const kept: WorkspaceInfo = { id: "kept", name: "Kept", path: "/kept", policy: "ask" };
const session: SessionSummary = {
	id: "session",
	workspaceId: removed.id,
	name: "Session",
	cwd: removed.path,
	messageCount: 0,
	firstMessage: "",
	state: "idle",
	active: true,
	createdAt: "2026-10-10T00:00:00Z",
	modifiedAt: "2026-10-10T00:00:00Z",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function setup(node = LOCAL_NODE) {
	const store = new PierStore({ kind: "browser" } as Bridge);
	if (node !== LOCAL_NODE) {
		store["set"]({
			peers: [
				{ id: node, name: "Peer", fingerprint: "", addresses: [], deviceId: "device", pairedAt: "", connected: true },
			],
		});
	}
	const request = vi.fn(async (method: string, _params?: { workspaceId?: string }): Promise<unknown> => {
		if (method === "workspace.list") return { workspaces: [kept] };
		if (method === "session.list") return { sessions: [] };
		if (method === "task.list") return { tasks: [] };
		throw new Error(`Unexpected request: ${method}`);
	});
	store["clients"].set(node, { request } as unknown as PierClient);
	store["patchNode"](node, { connection: "open", workspacesLoaded: true, workspaces: [removed, kept] });
	store["set"]({ sessions: { [removed.id]: [session] }, expanded: { [removed.id]: true } });
	store.selectSession(session);
	const dispose = vi.fn();
	store["chats"].set(session.id, { workspaceId: removed.id, dispose } as unknown as ChatController);
	const emit = (event: EventFrame["event"]) => store["onNodeEvent"](node, { type: "evt", event });
	return { store, request, dispose, emit, node };
}

beforeEach(() => {
	vi.useFakeTimers();
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("workspace deletion synchronization", () => {
	it("reconciles a phone deletion when session-close refresh beats the workspace notification", async () => {
		const { store, request, dispose, emit } = setup();
		request.mockImplementation(async (method, params) => {
			if (method === "session.list" && params?.workspaceId === removed.id) {
				throw new PierProtocolError("NOT_FOUND", `Workspace ${removed.id} not found`);
			}
			if (method === "workspace.list") return { workspaces: [kept] };
			return { sessions: [] };
		});
		emit({ type: "session.listChanged", workspaceId: removed.id });
		await vi.advanceTimersByTimeAsync(150);

		expect(store.getState().toasts).toEqual([]);
		expect(store.getState().workspaces).toEqual([kept]);
		expect(store.getState().sessions[removed.id]).toBeUndefined();
		expect(store.getState().expanded[removed.id]).toBeUndefined();
		expect(store.getState().selectedWorkspaceId).toBe(kept.id);
		expect(store.getState().selectedSessionId).toBeUndefined();
		expect(dispose).toHaveBeenCalledOnce();
		await store.refreshSessions(removed.id);
		expect(request.mock.calls.filter(([m]) => m === "session.list")).toHaveLength(1);
	});

	it("cleans remote workspaces, cached sessions and pending refreshes on workspace.changed", async () => {
		const { store, dispose, emit, node, request } = setup("peer");
		emit({ type: "workspace.changed" });
		await vi.advanceTimersByTimeAsync(50);
		emit({ type: "session.listChanged", workspaceId: removed.id });
		await vi.advanceTimersByTimeAsync(150);

		expect(dispose).toHaveBeenCalledOnce();
		expect(store.getState().sessions[removed.id]).toBeUndefined();
		expect(store.getState().selectedWorkspaceId).toBe(kept.id);
		expect(store.getState().selectedSessionId).toBeUndefined();
		expect(store.getState().toasts).toEqual([]);
		expect(request.mock.calls.some(([m, p]) => m === "session.list" && p?.workspaceId === removed.id)).toBe(false);
		expect(JSON.parse(localStorage.getItem("pier.nodeWorkspaces") ?? "{}")[node]).toEqual([kept]);
	});

	it("moves a new-chat target away from a deleted workspace even while another computer is offline", async () => {
		const { store, node } = setup("peer");
		store.startNewChat(removed.id);
		await store.loadWorkspaces(node);
		expect(store.getState().newChat).toEqual({ workspaceId: kept.id });
	});

	it("clears the selection and new-chat target when the last workspace is removed", async () => {
		const { store, request, node } = setup("peer");
		store.startNewChat(removed.id);
		request.mockResolvedValue({ workspaces: [] });
		await store.loadWorkspaces(node);
		expect(store.getState().selectedWorkspaceId).toBeUndefined();
		expect(store.getState().selectedSessionId).toBeUndefined();
		expect(store.getState().newChat).toEqual({});
		expect(store.getState().sessions).toEqual({});
	});

	it.each(["resolve", "reject"] as const)("ignores a late session-list %s after workspace removal", async (outcome) => {
		const { store, request, node } = setup();
		const pending = deferred<{ sessions: SessionSummary[] }>();
		request.mockImplementation(async (method, params) => {
			if (method === "session.list" && params?.workspaceId === removed.id) return pending.promise;
			if (method === "workspace.list") return { workspaces: [kept] };
			return { sessions: [] };
		});
		const refresh = store.refreshSessions(removed.id);
		await store.loadWorkspaces(node);
		if (outcome === "resolve") pending.resolve({ sessions: [session] });
		else pending.reject(new PierProtocolError("NOT_FOUND", "Workspace removed"));
		await refresh;
		expect(store.getState().sessions[removed.id]).toBeUndefined();
		expect(store.getState().toasts).toEqual([]);
	});

	it("does not resurrect a removed workspace from an older workspace-list response", async () => {
		const { store, request, node } = setup();
		const pending = deferred<{ workspaces: WorkspaceInfo[] }>();
		request.mockImplementationOnce(() => pending.promise);
		const older = store.loadWorkspaces(node);
		await store.loadWorkspaces(node);
		pending.resolve({ workspaces: [removed, kept] });
		await older;
		expect(store.getState().workspaces).toEqual([kept]);
		expect(store.getState().sessions[removed.id]).toBeUndefined();
	});

	it("keeps reporting NOT_FOUND if the host confirms the workspace still exists", async () => {
		const { store, request } = setup();
		request.mockImplementation(async (method) => {
			if (method === "workspace.list") return { workspaces: [removed, kept] };
			throw new PierProtocolError("NOT_FOUND", "A runtime resource is missing");
		});
		await store.refreshSessions(removed.id);
		expect(store.getState().workspaces).toEqual([removed, kept]);
		expect(store.getState().toasts).toEqual([
			expect.objectContaining({ level: "error", message: "加载会话列表失败：A runtime resource is missing" }),
		]);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("keeps reporting other session-list failures", async () => {
		const { store, request } = setup();
		request.mockRejectedValue(new PierProtocolError("INTERNAL", "Disk read failed"));
		await store.refreshSessions(removed.id);
		expect(store.getState().toasts).toEqual([
			expect.objectContaining({ level: "error", message: "加载会话列表失败：Disk read failed" }),
		]);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
