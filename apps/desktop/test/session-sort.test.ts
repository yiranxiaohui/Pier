/* biome-ignore-all lint/complexity/useLiteralKeys: Bracket access lets this harness seed private store state without changing its public API. */
import type { SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { sessionListTime, sortSessions, withSessionActivity } from "../src/lib/session-list.ts";
import { LOCAL_NODE, PierStore } from "../src/lib/store.tsx";

const workspace: WorkspaceInfo = { id: "w", name: "W", path: "/w", policy: "ask" };

function session(
	id: string,
	createdAt: string,
	modifiedAt: string,
	extra: Partial<SessionSummary> = {},
): SessionSummary {
	return {
		id,
		workspaceId: workspace.id,
		cwd: workspace.path,
		messageCount: 1,
		firstMessage: id,
		state: "inactive",
		active: false,
		createdAt,
		modifiedAt,
		...extra,
	};
}

// `old` was created first but used last; `fresh` was created last; `middle` sits between.
const old = session("old", "2026-11-01T00:00:00.000Z", "2026-11-20T00:00:00.000Z");
const middle = session("middle", "2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z");
const fresh = session("fresh", "2026-11-10T00:00:00.000Z", "2026-11-10T00:00:00.000Z");
const ids = (sessions: readonly SessionSummary[] | undefined) => sessions?.map((s) => s.id);

describe("sortSessions", () => {
	it("lists sessions newest-created first by default, whatever their activity", () => {
		expect(ids(sortSessions([old, middle, fresh], false))).toEqual(["fresh", "middle", "old"]);
		expect(sessionListTime(old, false)).toBe(old.createdAt);
	});

	it("lists the latest active session first when sorting by activity", () => {
		expect(ids(sortSessions([fresh, middle, old], true))).toEqual(["old", "fresh", "middle"]);
		expect(sessionListTime(old, true)).toBe(old.modifiedAt);
	});

	it("keeps the host's order for equal times and puts unreadable times last", () => {
		const twin = session("twin", fresh.createdAt, fresh.modifiedAt);
		const broken = session("broken", "", "not a date");
		expect(ids(sortSessions([broken, twin, fresh, middle], false))).toEqual(["twin", "fresh", "middle", "broken"]);
		expect(ids(sortSessions([broken, fresh, twin, middle], true))).toEqual(["fresh", "twin", "middle", "broken"]);
	});

	it("leaves the list it was given alone", () => {
		const list = [old, middle, fresh];
		sortSessions(list, true);
		expect(ids(list)).toEqual(["old", "middle", "fresh"]);
	});
});

describe("withSessionActivity", () => {
	const now = Date.parse("2026-11-27T12:00:00.000Z");

	it("makes a session that starts running the latest active one", () => {
		const next = withSessionActivity([old, middle, fresh], "middle", "streaming", 0, now);
		expect(next?.find((s) => s.id === "middle")).toMatchObject({
			state: "streaming",
			pendingUi: 0,
			active: true,
			modifiedAt: "2026-11-27T12:00:00.000Z",
			createdAt: middle.createdAt,
		});
		expect(ids(sortSessions(next ?? [], true))).toEqual(["middle", "old", "fresh"]);
		// Sorted by creation time, nothing moves.
		expect(ids(sortSessions(next ?? [], false))).toEqual(["fresh", "middle", "old"]);
	});

	it("puts it on top even when the host's clock runs ahead", () => {
		const ahead = session("ahead", fresh.createdAt, "2026-11-27T12:05:00.000Z");
		const next = withSessionActivity([ahead, middle], "middle", "streaming", 0, now) ?? [];
		expect(next.find((s) => s.id === "middle")?.modifiedAt).toBe("2026-11-27T12:05:00.001Z");
		expect(ids(sortSessions(next, true))).toEqual(["middle", "ahead"]);
	});

	it("does not move a session that keeps running, stops or waits for an answer", () => {
		const running = session("running", middle.createdAt, middle.modifiedAt, { state: "streaming", active: true });
		const list = [old, running];
		expect(withSessionActivity(list, "running", "retrying", 0, now)?.[1]).toMatchObject({
			state: "retrying",
			modifiedAt: middle.modifiedAt,
		});
		expect(withSessionActivity(list, "running", "idle", 0, now)?.[1]?.modifiedAt).toBe(middle.modifiedAt);
		expect(withSessionActivity(list, "old", "idle", 1, now)?.[0]).toMatchObject({
			pendingUi: 1,
			modifiedAt: old.modifiedAt,
		});
	});

	it("reports a session that is not listed", () => {
		expect(withSessionActivity([old], "missing", "streaming", 0, now)).toBeUndefined();
	});
});

describe("the store's session sort preference", () => {
	beforeEach(() => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("is off by default and is remembered on this device", () => {
		const store = new PierStore({ kind: "browser" } as Bridge);
		expect(store.getState().sortSessionsByActivity).toBe(false);
		store.setSortSessionsByActivity(true);
		expect(store.getState().sortSessionsByActivity).toBe(true);
		expect(new PierStore({ kind: "browser" } as Bridge).getState().sortSessionsByActivity).toBe(true);
		store.setSortSessionsByActivity(false);
		expect(new PierStore({ kind: "browser" } as Bridge).getState().sortSessionsByActivity).toBe(false);
	});

	it("marks a listed session active when the host reports it started running", () => {
		vi.useFakeTimers({ now: Date.parse("2026-11-27T12:00:00.000Z") });
		const store = new PierStore({ kind: "browser" } as Bridge);
		store["patchNode"](LOCAL_NODE, { connection: "open", workspacesLoaded: true, workspaces: [workspace] });
		store["set"]({ sessions: { [workspace.id]: [old, middle, fresh] } });
		store["onNodeEvent"](LOCAL_NODE, {
			type: "evt",
			event: {
				type: "session.activity",
				workspaceId: workspace.id,
				sessionId: "fresh",
				state: "streaming",
				pendingUi: 0,
			},
		});
		const listed = store.getState().sessions[workspace.id] ?? [];
		expect(listed.find((s) => s.id === "fresh")).toMatchObject({
			state: "streaming",
			modifiedAt: "2026-11-27T12:00:00.000Z",
		});
		expect(ids(sortSessions(listed, true))).toEqual(["fresh", "old", "middle"]);
	});
});
