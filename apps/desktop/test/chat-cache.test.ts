/* biome-ignore-all lint/complexity/useLiteralKeys: Seed private store state without changing its public API. */
import { type ChatState, initialChatState } from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import type { SessionSummary } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { PierStore } from "../src/lib/store.tsx";

beforeEach(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function summary(id: string): SessionSummary {
	return {
		id,
		workspaceId: "ws",
		cwd: "/work",
		createdAt: "2026-11-19T01:00:00.000Z",
		modifiedAt: "2026-11-19T02:00:00.000Z",
		messageCount: 2,
		firstMessage: "hello",
		active: false,
		state: "inactive",
	};
}

/** What a chat looked like after it loaded its transcript. */
function loaded(id: string): ChatState {
	return {
		...initialChatState(id, summary(id)),
		loaded: true,
		seq: 7,
		epoch: "e1",
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
		] as ChatState["messages"],
	};
}

/** A store connected to the computer `peer`, whose client records how chats follow sessions. */
function setup() {
	const store = new PierStore({ kind: "tauri", logs: vi.fn(), onLog: vi.fn() } as unknown as Bridge);
	const subscribed: Array<{ sessionId: string; resume?: { seq: number; epoch: string } }> = [];
	const client = {
		subscribeOpensSessions: true,
		request: vi.fn(async () => ({})),
		subscribe: vi.fn(
			async (sessionId: string, _handler: unknown, options: { resume?: { seq: number; epoch: string } }) => {
				subscribed.push({ sessionId, ...(options.resume ? { resume: options.resume } : {}) });
				return { sessionId, lastSeq: 0, resubscribe: async () => true, unsubscribe: async () => {} };
			},
		),
	};
	store["patchNode"]("peer", { connection: "open" });
	store["clients"].set("peer", client as unknown as PierClient);
	store["set"]({ workspaceNodes: { ws: "peer" } });
	return { store, subscribed };
}

describe("chats that are no longer live", () => {
	it("show their last state at once and resume from it", async () => {
		const { store, subscribed } = setup();
		const first = store.chat(summary("s1"));
		if (!first) throw new Error("no chat");
		first["view"] = { chat: loaded("s1") };
		store["dropChat"]("s1");

		const again = store.chat(summary("s1"));
		expect(again).not.toBe(first);
		expect(again?.chat.messages).toEqual(loaded("s1").messages);
		await vi.waitFor(() => expect(subscribed).toHaveLength(2));
		expect(subscribed[1]).toEqual({ sessionId: "s1", resume: { seq: 7, epoch: "e1" } });
		// Used once: the live chat now holds the state.
		expect(store["chatCache"].size).toBe(0);
	});

	it("forget deleted sessions and keep only the most recent ones", () => {
		const { store } = setup();
		for (let i = 0; i < 20; i++) {
			const id = `s${i}`;
			const chat = store.chat(summary(id));
			if (!chat) throw new Error("no chat");
			chat["view"] = { chat: loaded(id) };
			store["dropChat"](id);
		}
		expect(store["chatCache"].size).toBe(16);
		expect(store["chatCache"].has("peer\ns0")).toBe(false);
		expect(store["chatCache"].has("peer\ns19")).toBe(true);

		const chat = store.chat(summary("s19"));
		if (!chat) throw new Error("no chat");
		store["dropChat"]("s19", false);
		expect(store["chatCache"].has("peer\ns19")).toBe(false);
		store["dropChat"]("s18", false);
		expect(store["chatCache"].has("peer\ns18")).toBe(false);
	});
});
