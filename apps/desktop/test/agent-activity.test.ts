import { type ChatState, initialChatState } from "@pier/chat-state";
import type { SessionSummary, SubagentInfo, UiRequest } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	CAT_ACCESSORIES,
	CAT_COATS,
	catLook,
	DESK_ITEMS,
	studioActivity,
	toolActivity,
} from "../src/lib/agent-activity.ts";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "s1",
		workspaceId: "w1",
		cwd: "/repo",
		createdAt: "2026-11-27T00:00:00.000Z",
		modifiedAt: "2026-11-27T00:00:00.000Z",
		messageCount: 1,
		firstMessage: "hi",
		active: true,
		state: "streaming",
		...overrides,
	};
}

function chat(overrides: Partial<ChatState> = {}): ChatState {
	return { ...initialChatState("s1", session()), loaded: true, runState: "streaming", ...overrides };
}

function subagent(id: string, status: SubagentInfo["status"]): SubagentInfo {
	return { id, name: "explore", status, steps: 0, stoppable: true };
}

describe("toolActivity", () => {
	it("sorts tools into the kinds the cats act out, with a short detail", () => {
		expect(toolActivity("bash", { command: "bun run test\necho done" })).toEqual({
			mood: "command",
			label: "运行命令",
			detail: "bun run test",
		});
		expect(toolActivity("read", { path: "/repo/apps/desktop/src/App.tsx" })).toMatchObject({
			mood: "reading",
			detail: "App.tsx",
		});
		expect(toolActivity("edit", { file_path: "C:\\repo\\src\\main.ts" })).toMatchObject({
			mood: "editing",
			detail: "main.ts",
		});
		expect(toolActivity("write", { path: "notes.md" })).toMatchObject({ mood: "editing", label: "写新文件" });
		expect(toolActivity("grep", { pattern: "useStore", path: "src" })).toMatchObject({
			mood: "searching",
			detail: "useStore",
		});
		expect(toolActivity("WebSearch", { query: "lucide cat icon" })).toMatchObject({ mood: "browsing" });
		expect(toolActivity("browser_navigate", { url: "http://localhost:1420" })).toMatchObject({ mood: "browsing" });
		expect(toolActivity("Agent", { description: "Find the store" })).toMatchObject({
			mood: "delegating",
			detail: "Find the store",
		});
		expect(toolActivity("TodoWrite", {})).toEqual({ mood: "thinking", label: "列计划" });
		expect(toolActivity("mcp__thing", { key: "value" })).toMatchObject({ mood: "tool", detail: "value" });
	});

	it("clips long details to one short line", () => {
		const detail = toolActivity("bash", { command: "x".repeat(200) }).detail ?? "";
		expect(detail.length).toBeLessThanOrEqual(48);
		expect(detail.endsWith("…")).toBe(true);
		expect(toolActivity("read", {})).toEqual({ mood: "reading", label: "翻阅文件" });
	});
});

describe("studioActivity", () => {
	it("falls back to the session list until the live chat has loaded", () => {
		expect(studioActivity(undefined, session())).toMatchObject({ mood: "working" });
		expect(studioActivity(undefined, session({ state: "idle" }))).toMatchObject({ mood: "resting" });
		expect(studioActivity(undefined, session({ state: "idle", pendingUi: 1 }))).toMatchObject({ mood: "waiting" });
		expect(studioActivity({ ...chat(), loaded: false }, session())).toMatchObject({ mood: "working" });
	});

	it("puts a question or approval for the user first", () => {
		const approval: UiRequest = {
			id: "r1",
			sessionId: "s1",
			kind: "approval",
			title: "Run command?",
			createdAt: "2026-11-27T00:00:00.000Z",
			approval: {
				toolName: "bash",
				toolCallId: "t1",
				summary: "rm -rf dist",
				input: {},
				reason: "writes files",
				severity: "normal",
				sessionAllowable: true,
			},
		};
		expect(studioActivity(chat({ pendingUi: [approval] }), session())).toEqual({
			mood: "waiting",
			label: "等你批准",
			detail: "rm -rf dist",
		});
		const question: UiRequest = { ...approval, kind: "select", title: "Pick one" };
		delete question.approval;
		expect(studioActivity(chat({ pendingUi: [question] }), session())).toMatchObject({ label: "等你回答" });
	});

	it("shows compaction, retries, errors and rest", () => {
		expect(studioActivity(chat({ runState: "compacting" }), session())).toMatchObject({ mood: "compacting" });
		expect(
			studioActivity(
				chat({ runState: "retrying", retry: { attempt: 2, maxAttempts: 3, errorMessage: "" } }),
				session(),
			),
		).toMatchObject({ mood: "retrying", label: "第 2 次重试" });
		expect(studioActivity(chat({ runState: "idle", errorMessage: "rate limited" }), session())).toMatchObject({
			mood: "error",
			detail: "rate limited",
		});
		expect(studioActivity(chat({ runState: "idle" }), session())).toMatchObject({ mood: "resting" });
	});

	it("follows the newest running tool", () => {
		const state = chat({
			tools: {
				a: { toolCallId: "a", toolName: "read", args: { path: "a.ts" }, status: "done" },
				b: { toolCallId: "b", toolName: "bash", args: { command: "ls" }, status: "running" },
				c: { toolCallId: "c", toolName: "grep", args: { pattern: "x" }, status: "running" },
			},
		});
		expect(studioActivity(state, session())).toMatchObject({ mood: "searching", detail: "x" });
	});

	it("reads the streamed reply: a tool call being written, thinking, or text", () => {
		const streaming = (content: NonNullable<ChatState["streaming"]>["content"]) =>
			chat({ streaming: { role: "assistant", content, timestamp: 0 } });
		expect(
			studioActivity(
				streaming([{ type: "toolCall", id: "t", name: "edit", arguments: { path: "src/x.ts" } }]),
				session(),
			),
		).toMatchObject({ mood: "editing", detail: "x.ts" });
		expect(studioActivity(streaming([{ type: "thinking", thinking: "hmm" }]), session())).toMatchObject({
			mood: "thinking",
		});
		expect(studioActivity(streaming([{ type: "text", text: "Here it is" }]), session())).toMatchObject({
			mood: "writing",
		});
		// Nothing visible streamed yet: waiting for the model.
		expect(studioActivity(streaming([{ type: "text", text: "  " }]), session())).toMatchObject({ mood: "thinking" });
	});

	it("shows a finished call that has not started yet", () => {
		const state = chat({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "done", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "next", name: "bash", arguments: { command: "make" } },
					],
					timestamp: 0,
				},
			],
			tools: { done: { toolCallId: "done", toolName: "read", status: "done" } },
		});
		expect(studioActivity(state, session())).toMatchObject({ mood: "command", detail: "make" });
	});

	it("counts the helpers a delegating agent waits on", () => {
		const subagents = { x: subagent("x", "running"), y: subagent("y", "running"), z: subagent("z", "completed") };
		expect(
			studioActivity(
				chat({
					subagents,
					tools: { t: { toolCallId: "t", toolName: "Agent", args: { description: "scan" }, status: "running" } },
				}),
				session(),
			),
		).toMatchObject({ mood: "delegating", label: "派 2 个小帮手干活" });
		expect(studioActivity(chat({ subagents }), session())).toMatchObject({
			mood: "delegating",
			label: "等 2 个小帮手",
		});
	});
});

describe("catLook", () => {
	it("gives a session the same cat every time", () => {
		expect(catLook("session-a")).toEqual(catLook("session-a"));
		const look = catLook("session-b");
		expect(look.name.length).toBeGreaterThan(0);
		expect(CAT_ACCESSORIES).toContain(look.accessory);
		expect(CAT_COATS).toContain(look.coat);
		expect(DESK_ITEMS).toContain(look.deskItem);
		expect(look.phase).toBeGreaterThanOrEqual(0);
		expect(look.phase).toBeLessThan(4);
	});

	it("varies between sessions", () => {
		const looks = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(catLook(`session-${i}`))));
		expect(looks.size).toBeGreaterThan(20);
	});

	it("varies between ids that differ only at the end, as sequential ones do", () => {
		const ids = Array.from(
			{ length: 24 },
			(_, i) => `019ac3f2-7b1e-7d40-9a51-3c8e2f6b10${i.toString(16).padStart(2, "0")}`,
		);
		const looks = ids.map(catLook);
		expect(new Set(looks.map((look) => look.coat)).size).toBe(CAT_COATS.length);
		expect(new Set(looks.map((look) => look.deskItem)).size).toBe(DESK_ITEMS.length);
		expect(new Set(looks.map((look) => look.accessory)).size).toBeGreaterThanOrEqual(5);
		expect(new Set(looks.map((look) => look.name)).size).toBeGreaterThanOrEqual(10);
	});
});
