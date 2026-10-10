/* biome-ignore-all lint/complexity/useLiteralKeys: Seed host state without widening the store's public API. */
import type { PeerInfo, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { LOCAL_NODE, PierStore } from "../src/lib/store.tsx";

const workspace = (id: string): WorkspaceInfo => ({ id, name: id, path: `/${id}`, policy: "ask" });
const peer: PeerInfo = {
	id: "peer",
	name: "Remote",
	fingerprint: "",
	addresses: [],
	deviceId: "device",
	pairedAt: "",
	connected: false,
};
const ids = (store: PierStore) => store.getState().workspaces.map((w) => w.id);

function setup(local = ["a", "b"], remote = ["c"]) {
	const store = new PierStore({ kind: "browser" } as Bridge);
	store["set"]({ peers: [peer] });
	store["patchNode"](LOCAL_NODE, { connection: "open", workspaces: local.map(workspace), workspacesLoaded: true });
	store["patchNode"](peer.id, { workspaces: remote.map(workspace), workspacesLoaded: true });
	return store;
}

beforeEach(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("sidebar workspace order", () => {
	it("moves offline remote groups above local groups and back down, preserving selection and sessions", () => {
		const store = setup();
		store["set"]({ selectedWorkspaceId: "a", selectedSessionId: "session", expanded: { a: true } });
		const sessions = store.getState().sessions;
		const nodes = store.getState().nodes;
		expect(ids(store)).toEqual(["a", "b", "c"]);
		store.moveWorkspace("c", "a", "before");
		expect(ids(store)).toEqual(["c", "a", "b"]);
		expect(JSON.parse(localStorage.getItem("pier.workspaceOrder") ?? "[]")).toEqual(["c", "a", "b"]);
		expect(store.getState()).toMatchObject({
			selectedWorkspaceId: "a",
			selectedSessionId: "session",
			expanded: { a: true },
			workspaceNodes: { a: LOCAL_NODE, b: LOCAL_NODE, c: peer.id },
		});
		expect(store.getState().sessions).toBe(sessions);
		expect(store.getState().nodes).toBe(nodes);
		store.moveWorkspace("c", "b", "after");
		expect(ids(store)).toEqual(["a", "b", "c"]);
	});

	it("restores order after restart, host list refreshes and peers arriving later", () => {
		setup().moveWorkspace("c", "a", "before");
		const store = new PierStore({ kind: "browser" } as Bridge);
		store["patchNode"](LOCAL_NODE, { workspaces: [workspace("b"), workspace("a")] });
		expect(ids(store)).toEqual(["a", "b"]);
		store["set"]({ peers: [peer] });
		store["patchNode"](peer.id, { workspaces: [workspace("c")] });
		expect(ids(store)).toEqual(["c", "a", "b"]);
		store["patchNode"](LOCAL_NODE, { workspaces: [workspace("d"), workspace("a"), workspace("b")] });
		expect(ids(store)).toEqual(["c", "a", "b", "d"]);
	});

	it("retains unloaded computers' saved positions when another group is moved", () => {
		setup().moveWorkspace("c", "a", "before");
		const store = setup(["a", "b"], []);
		store.moveWorkspace("b", "a", "before");
		store["patchNode"](peer.id, { workspaces: [workspace("c")] });
		expect(ids(store)).toEqual(["c", "b", "a"]);
	});

	it("ignores drops onto itself and groups removed during a drag", () => {
		const store = setup();
		const listener = vi.fn();
		store.subscribe(listener);
		store.moveWorkspace("a", "a", "after");
		store.moveWorkspace("missing", "a", "before");
		store.moveWorkspace("a", "missing", "after");
		expect(ids(store)).toEqual(["a", "b", "c"]);
		expect(listener).not.toHaveBeenCalled();
	});

	it("removes deleted workspaces from the saved order", () => {
		const store = setup();
		store.moveWorkspace("c", "a", "before");
		store["forgetWorkspace"](peer.id, "c");
		expect(ids(store)).toEqual(["a", "b"]);
		expect(JSON.parse(localStorage.getItem("pier.workspaceOrder") ?? "[]")).toEqual(["a", "b"]);
	});

	it("forgets the order of unpaired computers without changing the remaining order", () => {
		const store = setup();
		store.moveWorkspace("b", "a", "before");
		store.moveWorkspace("c", "b", "before");
		store["forgetNode"](peer.id);
		expect(ids(store)).toEqual(["b", "a"]);
		expect(JSON.parse(localStorage.getItem("pier.workspaceOrder") ?? "[]")).toEqual(["b", "a"]);
	});

	it.each(["{", "null", "{}", "42"])("ignores invalid saved order %s", (saved) => {
		localStorage.setItem("pier.workspaceOrder", saved);
		expect(ids(setup())).toEqual(["a", "b", "c"]);
	});

	it("deduplicates saved IDs and ignores non-string entries", () => {
		localStorage.setItem("pier.workspaceOrder", '["c",null,"c",2,"a"]');
		const store = setup();
		expect(ids(store)).toEqual(["c", "a", "b"]);
		expect(store.getState().workspaceOrder).toEqual(["c", "a"]);
	});
});
