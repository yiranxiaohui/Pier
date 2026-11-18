/* biome-ignore-all lint/complexity/useLiteralKeys: Seed private store state without changing its public API. */
import type { ChatController } from "@pier/chat-state";
import type { EventFrame, SessionRunState, SessionSummary } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { PierStore } from "../src/lib/store.tsx";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "s1",
		workspaceId: "ws",
		cwd: "/work",
		createdAt: "2026-11-17T09:08:53.000Z",
		modifiedAt: "2026-11-17T12:30:00.000Z",
		messageCount: 2,
		firstMessage: "为什么识别不到",
		active: true,
		state: "streaming",
		...patch,
	};
}

/** A store following one session on the computer `peer`, through a stand-in live chat. */
function setup(runState: SessionRunState = "streaming", listed: Partial<SessionSummary> = {}) {
	const store = new PierStore({ kind: "tauri", logs: vi.fn(), onLog: vi.fn() } as unknown as Bridge);
	const chat = {
		workspaceId: "ws",
		sessionId: "s1",
		chat: { loaded: true, runState } as { loaded: boolean; runState: SessionRunState; closed?: string },
		recover: vi.fn(async () => true),
		dispose: vi.fn(),
	};
	store["patchNode"]("peer", { connection: "open" });
	store["chats"].set("s1", chat as unknown as ChatController);
	store["chatNodes"].set(chat as unknown as ChatController, "peer");
	store["set"]({ sessions: { ws: [summary(listed)] } });
	const activity = (state: SessionRunState) =>
		store["onNodeEvent"]("peer", {
			type: "evt",
			event: { type: "session.activity", workspaceId: "ws", sessionId: "s1", state, pendingUi: 0 },
		} as EventFrame);
	return { store, chat, activity };
}

describe("live chats that missed their session's events", () => {
	it("follow the session again when the host reports a run state they did not see", async () => {
		const { chat, activity } = setup("streaming");
		activity("idle");
		await vi.advanceTimersByTimeAsync(2900);
		expect(chat.recover).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(200);
		expect(chat.recover).toHaveBeenCalledTimes(1);
	});

	it("follow the session again when the host no longer has it open", async () => {
		const { store, chat } = setup("streaming", { active: false, state: "inactive" });
		store["checkChats"]("ws");
		await vi.advanceTimersByTimeAsync(3100);
		expect(chat.recover).toHaveBeenCalledTimes(1);
		// Still out of sync: not retried right away.
		store["checkChats"]("ws");
		await vi.advanceTimersByTimeAsync(3100);
		expect(chat.recover).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		store["checkChats"]("ws");
		await vi.advanceTimersByTimeAsync(3100);
		expect(chat.recover).toHaveBeenCalledTimes(2);
	});

	it("leave chats alone that agree with the host, or catch up within the delay", async () => {
		const { chat, activity } = setup("idle", { state: "idle" });
		activity("idle");
		await vi.advanceTimersByTimeAsync(5000);
		activity("streaming");
		chat.chat.runState = "streaming";
		await vi.advanceTimersByTimeAsync(5000);
		expect(chat.recover).not.toHaveBeenCalled();
	});

	it("leave closed chats and offline computers alone", async () => {
		const { store, chat } = setup("streaming", { active: false, state: "inactive" });
		chat.chat.closed = "idle";
		store["checkChats"]("ws");
		await vi.advanceTimersByTimeAsync(5000);
		chat.chat.closed = undefined;
		store["patchNode"]("peer", { connection: "reconnecting" });
		store["checkChats"]("ws");
		await vi.advanceTimersByTimeAsync(5000);
		expect(chat.recover).not.toHaveBeenCalled();
	});

	it("stop checking a chat once it is dropped", async () => {
		const { store, chat, activity } = setup("streaming");
		activity("idle");
		store["dropChat"]("s1");
		await vi.advanceTimersByTimeAsync(5000);
		expect(chat.dispose).toHaveBeenCalled();
		expect(chat.recover).not.toHaveBeenCalled();
	});
});
