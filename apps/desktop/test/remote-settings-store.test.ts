/* biome-ignore-all lint/complexity/useLiteralKeys: Seed private store state without changing its public API. */
import type { PierClient } from "@pier/client";
import type { AppUpdateStatus } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { LOCAL_NODE, PierStore } from "../src/lib/store.tsx";

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} }));
afterEach(() => vi.unstubAllGlobals());

function setup() {
	const bridge = { kind: "tauri", logs: vi.fn(), onLog: vi.fn() };
	const store = new PierStore(bridge as unknown as Bridge);
	const local = vi.fn();
	const peer = vi.fn(async (method: string) => {
		if (method === "remote.status") return { port: 7444 };
		if (method === "device.list") return { devices: [{ id: "remote-device" }] };
		if (method === "peer.list") return { peers: [{ id: "remote-peer" }] };
		if (method === "host.logs") return { lines: ["remote diagnostics"] };
		throw new Error(`Unexpected request: ${method}`);
	});
	store["clients"].set(LOCAL_NODE, { request: local } as unknown as PierClient);
	store["clients"].set("peer", { request: peer } as unknown as PierClient);
	store["patchNode"]("peer", { connection: "open" });
	return { store, bridge, local, peer };
}

describe("remote settings routing", () => {
	it("keeps a saved peer route when a check on its previous route replies late", async () => {
		const { store, local } = setup();
		const previous: AppUpdateStatus = {
			state: "idle",
			downloaded: 0,
			autoCheck: false,
			currentVersion: "1",
			mirrorPrefix: "",
		};
		const saved = { ...previous, mirrorPrefix: "https://peer.example/" };
		let finish!: (status: AppUpdateStatus) => void;
		const check = new Promise<AppUpdateStatus>((resolve) => {
			finish = resolve;
		});
		const request = vi.fn((method: string) => (method === "update.setMirror" ? Promise.resolve(saved) : check));
		store["clients"].set("peer", { request } as unknown as PierClient);
		store["patchPeerUpdate"]("peer", { status: previous });
		const pending = store.checkPeerUpdate("peer");
		expect(await store.setPeerUpdateMirror("peer", saved.mirrorPrefix)).toBe(true);
		finish(previous);
		await pending;
		expect(store.getState().peerUpdates.peer?.status).toEqual(saved);
		expect(local).not.toHaveBeenCalled();
	});
	it("reads only the explicitly selected host and never overwrites local device state", async () => {
		const { store, bridge, local, peer } = setup();
		const localState = {
			remote: store.getState().remote,
			devices: store.getState().devices,
			peers: store.getState().peers,
		};
		expect(await store.remoteOverview("peer")).toEqual({
			remote: { port: 7444 },
			devices: [{ id: "remote-device" }],
			peers: [{ id: "remote-peer" }],
		});
		expect(await store.hostLogs("peer")).toEqual(["remote diagnostics"]);
		expect(peer.mock.calls.map(([method]) => method)).toEqual([
			"remote.status",
			"device.list",
			"peer.list",
			"host.logs",
		]);
		expect({
			remote: store.getState().remote,
			devices: store.getState().devices,
			peers: store.getState().peers,
		}).toEqual(localState);
		expect(local).not.toHaveBeenCalled();
		expect(bridge.logs).not.toHaveBeenCalled();
		expect(bridge.onLog).not.toHaveBeenCalled();
	});

	it("does not fall back to local data when the peer is disconnected", async () => {
		const { store, local, peer } = setup();
		store["patchNode"]("peer", { connection: "reconnecting" });
		await expect(store.remoteOverview("peer")).rejects.toThrow("未连接");
		await expect(store.hostLogs("peer")).rejects.toThrow("未连接");
		expect(await store.setPeerUpdateMirror("peer", "")).toBe(false);
		expect(peer).not.toHaveBeenCalled();
		expect(local).not.toHaveBeenCalled();
	});
});
