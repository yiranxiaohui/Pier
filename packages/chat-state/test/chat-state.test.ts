import type { EventFrame, SessionSnapshot, SessionSummary, SubagentInfo, UiRequest } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	applySnapshot,
	buildTranscript,
	type ChatState,
	cacheableChatState,
	editReplacements,
	initialChatState,
	isSubagentTool,
	isWaitingForModel,
	parsePartialJson,
	reduceChat,
	sessionUsage,
	stripImageHints,
	stripTrailingImageHints,
	subagentList,
	summarizeToolCall,
	userText,
	waitingForModelLabel,
} from "../src/index.ts";

const summary: SessionSummary = {
	id: "s1",
	workspaceId: "w1",
	cwd: "/tmp/w",
	createdAt: "2026-01-01T00:00:00.000Z",
	modifiedAt: "2026-01-01T00:00:00.000Z",
	messageCount: 0,
	firstMessage: "",
	active: true,
	state: "idle",
};

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		session: summary,
		seq: 10,
		epoch: "e1",
		messages: [],
		pendingToolCalls: [],
		pendingUi: [],
		queue: { steering: [], followUp: [] },
		thinkingLevel: "medium",
		statuses: {},
		widgets: {},
		...overrides,
	};
}

let seq = 10;
function evt(event: Record<string, unknown>, withSeq = true): EventFrame {
	return {
		type: "evt",
		sessionId: "s1",
		...(withSeq ? { seq: ++seq } : {}),
		event: event as EventFrame["event"],
	};
}

function run(state: ChatState, events: Array<Record<string, unknown>>): ChatState {
	return events.reduce((s, e) => reduceChat(s, evt(e)), state);
}

function loaded(overrides: Partial<SessionSnapshot> = {}): ChatState {
	seq = 10;
	return reduceChat(initialChatState("s1"), evt({ type: "session.snapshot", snapshot: snapshot(overrides) }, false));
}

describe("reduceChat", () => {
	it("applies a snapshot and ignores already-applied seqs", () => {
		const state = loaded();
		expect(state.loaded).toBe(true);
		expect(state.seq).toBe(10);
		expect(state.thinkingLevel).toBe("medium");
		const stale = reduceChat(state, {
			type: "evt",
			sessionId: "s1",
			seq: 9,
			event: { type: "session.status", state: "streaming" },
		});
		expect(stale).toBe(state);
		const other = reduceChat(state, {
			type: "evt",
			sessionId: "s2",
			seq: 99,
			event: { type: "session.status", state: "streaming" },
		});
		expect(other).toBe(state);
	});

	it("keeps context window and compaction limits from snapshots and model changes", () => {
		const info = {
			autoCompaction: "configured" as const,
			contextWindow: 128_000,
			compactionThreshold: 111_616,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		};
		let state = loaded({ contextInfo: info });
		expect(state.contextInfo).toEqual(info);
		state = run(state, [
			{
				type: "session.model",
				model: { provider: "p", id: "next", name: "Next", reasoning: false, input: ["text"] },
				contextInfo: { autoCompaction: "disabled", contextWindow: 64_000 },
				thinkingLevel: "off",
			},
		]);
		expect(state.contextInfo).toEqual({ autoCompaction: "disabled", contextWindow: 64_000 });
	});

	it("rebuilds a streamed assistant message from deltas", () => {
		let state = loaded();
		state = run(state, [
			{ type: "session.status", state: "streaming" },
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "message_start", message: { role: "assistant", content: [], timestamp: 2 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "t1", toolName: "bash" },
			},
			{
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"command":"ls -' },
			},
		]);
		expect(state.streaming?.content[0]).toEqual({ type: "thinking", thinking: "hmm", completed: false });
		expect(state.streaming?.content[1]).toEqual({ type: "text", text: "Hello", completed: false });
		expect(state.streaming?.content[2]).toMatchObject({ type: "toolCall", id: "t1", arguments: { command: "ls -" } });

		let items = buildTranscript(state);
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
		const streamingItem = items[1];
		expect(streamingItem?.kind === "assistant" && streamingItem.streaming).toBe(true);
		expect(streamingItem?.kind === "assistant" && streamingItem.blocks[2]).toMatchObject({ status: "generating" });

		const final = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Hello" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la" } },
			],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } },
			stopReason: "toolUse",
			timestamp: 2,
		};
		state = run(state, [
			{
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: final.content[2] },
			},
			{ type: "message_end", message: final },
		]);
		expect(state.streaming).toBeUndefined();
		items = buildTranscript(state);
		expect(items[1]?.kind === "assistant" && items[1].blocks[2]).toMatchObject({ status: "pending" });

		state = run(state, [
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } },
			{
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				partialResult: { content: [{ type: "text", text: "a\n" }] },
			},
		]);
		items = buildTranscript(state);
		expect(items[1]?.kind === "assistant" && items[1].blocks[2]).toMatchObject({
			status: "running",
			execution: { partialResult: { content: [{ type: "text", text: "a\n" }] } },
		});

		const toolResult = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text: "a\nb\n" }],
			isError: false,
			timestamp: 3,
		};
		state = run(state, [
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: toolResult, isError: false },
			{ type: "message_start", message: toolResult },
			{ type: "message_end", message: toolResult },
			{ type: "session.status", state: "idle" },
		]);
		items = buildTranscript(state);
		// Tool results are folded into their calls.
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
		expect(items[1]?.kind === "assistant" && items[1].blocks[2]).toMatchObject({ status: "done", result: toolResult });
		expect(sessionUsage(state)).toMatchObject({ input: 10, output: 5, cacheRead: 0, cacheHitRate: 0, lastContext: 15 });
	});

	it("keeps an empty in-progress thinking block visible while streaming", () => {
		let state = run(loaded(), [
			{ type: "session.status", state: "streaming" },
			{ type: "message_start", message: { role: "assistant", content: [], timestamp: 2 } },
		]);
		let item = buildTranscript(state).at(-1);
		// Nothing visible yet: the UI keeps its typing indicator.
		expect(item?.kind === "assistant" && item.blocks).toEqual([]);

		state = run(state, [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
		]);
		item = buildTranscript(state).at(-1);
		expect(item?.kind === "assistant" && item.blocks).toEqual([
			{ kind: "thinking", text: "", redacted: false, live: true },
		]);

		state = run(state, [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hi" } },
		]);
		item = buildTranscript(state).at(-1);
		expect(item?.kind === "assistant" && item.blocks).toEqual([{ kind: "text", text: "Hi" }]);
	});

	it("marks tool calls without a result as interrupted once idle", () => {
		const state = loaded({
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "t9", name: "write", arguments: { path: "a.txt" } }],
					stopReason: "aborted",
					timestamp: 1,
				},
			],
		});
		const [item] = buildTranscript(state);
		expect(item?.kind === "assistant" && item.blocks[0]).toMatchObject({ status: "interrupted" });
	});

	it("shows activity between streamed parts after a progress message", () => {
		let state = run(loaded(), [
			{ type: "session.status", state: "streaming" },
			{ type: "message_start", message: { role: "assistant", content: [], timestamp: 2 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "已完成修改。" } },
		]);
		const waiting = () => isWaitingForModel(state, buildTranscript(state));
		expect(waiting()).toBe(false);
		state = run(state, [{ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } }]);
		expect(waiting()).toBe(true);
		expect(state.streaming?.content[0]).toMatchObject({ text: "已完成修改。", completed: true });

		state = run(state, [{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } }]);
		// Earlier visible text must not hide activity while the next part is still empty.
		expect(waiting()).toBe(true);
		state = run(state, [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 2 } },
		]);
		expect(waiting()).toBe(false);
		state = run(state, [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "检查结果" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 2 } },
		]);
		expect(waiting()).toBe(true);
		const item = buildTranscript(state).at(-1);
		expect(item?.kind === "assistant" && item.blocks.at(-1)).toMatchObject({ kind: "thinking", live: false });
		state = run(state, [{ type: "session.status", state: "idle" }]);
		expect(waiting()).toBe(false);
	});

	it("restores waiting after completed text and reasoning from a snapshot", () => {
		for (const part of [
			{ type: "text", text: "进度说明", completed: true },
			{ type: "thinking", thinking: "", completed: true },
		]) {
			const state = loaded({
				session: { ...summary, state: "streaming" },
				streamingMessage: { role: "assistant", content: [part], timestamp: 2 },
				model: { provider: "codex", id: "m", name: "M", reasoning: true, input: ["text"] },
			});
			expect(isWaitingForModel(state, buildTranscript(state))).toBe(true);
			expect(waitingForModelLabel(state)).toBe("思考中…");
		}
		// Old hosts omit completion metadata: keep visible streaming text as the activity signal.
		const oldHost = loaded({
			session: { ...summary, state: "streaming" },
			streamingMessage: { role: "assistant", content: [{ type: "text", text: "输出中" }], timestamp: 2 },
		});
		expect(isWaitingForModel(oldHost, buildTranscript(oldHost))).toBe(false);
	});

	it("uses tool progress while a tool runs and resumes waiting after it finishes", () => {
		let state = loaded({
			session: { ...summary, state: "streaming" },
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "test" } }],
					timestamp: 1,
				},
			],
			pendingToolCalls: ["t1"],
			streamingMessage: {
				role: "assistant",
				content: [{ type: "text", text: "等待测试", completed: true }],
				timestamp: 2,
			},
		});
		expect(isWaitingForModel(state, buildTranscript(state))).toBe(false);
		state = run(state, [{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false }]);
		expect(isWaitingForModel(state, buildTranscript(state))).toBe(true);
	});

	it("shows retry and compaction activity without showing it during loading or approval", () => {
		const state = loaded({ session: { ...summary, state: "streaming" } });
		expect(isWaitingForModel({ ...state, loaded: false }, [])).toBe(false);
		const request: UiRequest = {
			id: "u1",
			sessionId: "s1",
			kind: "approval",
			title: "Approve",
			createdAt: summary.createdAt,
		};
		expect(isWaitingForModel({ ...state, pendingUi: [request] }, [])).toBe(false);
		for (const runState of ["idle", "inactive"] as const) {
			expect(isWaitingForModel({ ...state, runState }, [])).toBe(false);
		}
		for (const [runState, label] of [
			["retrying", "正在重试…"],
			["compacting", "正在压缩上下文…"],
		] as const) {
			const busy = { ...state, runState };
			expect(isWaitingForModel(busy, [])).toBe(true);
			expect(waitingForModelLabel(busy)).toBe(label);
		}
		expect(waitingForModelLabel(state)).toBe("Agent 工作中…");
	});

	it("does not let an unfinished tool from an earlier turn hide current activity", () => {
		const state = loaded({
			session: { ...summary, state: "streaming" },
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "old", name: "bash", arguments: {} }], timestamp: 1 },
				{ role: "user", content: "继续", timestamp: 2 },
			],
			streamingMessage: {
				role: "assistant",
				content: [{ type: "text", text: "正在检查", completed: true }],
				timestamp: 3,
			},
		});
		expect(isWaitingForModel(state, buildTranscript(state))).toBe(true);
	});

	it("restores in-flight state from a snapshot", () => {
		const request: UiRequest = {
			id: "u1",
			sessionId: "s1",
			kind: "approval",
			title: "Approve",
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		const state = loaded({
			session: { ...summary, state: "streaming" },
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "make" } }],
					timestamp: 1,
				},
			],
			streamingMessage: { role: "assistant", content: [{ type: "text", text: "par" }], timestamp: 2 },
			pendingToolCalls: ["t1"],
			pendingUi: [request],
			queue: { steering: ["s"], followUp: [] },
		});
		expect(state.runState).toBe("streaming");
		expect(state.tools.t1).toMatchObject({ toolName: "bash", status: "running", args: { command: "make" } });
		expect(state.pendingUi).toHaveLength(1);
		expect(state.streaming?.content[0]).toEqual({ type: "text", text: "par" });
		const next = run(state, [
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tial" } },
			{ type: "ui.resolved", requestId: "u1", resolution: "answered" },
			{ type: "queue_update", steering: [], followUp: ["f"] },
		]);
		expect(next.streaming?.content[0]).toEqual({ type: "text", text: "partial", completed: false });
		expect(next.pendingUi).toHaveLength(0);
		expect(next.queue).toEqual({ steering: [], followUp: ["f"] });
		// Snapshot input is not mutated by later deltas.
		expect(state.streaming?.content[0]).toEqual({ type: "text", text: "par" });
	});

	it("tracks model, thinking, ui side channels, notices, and resync", () => {
		let state = loaded();
		state = run(state, [
			{
				type: "session.model",
				model: { provider: "p", id: "m", name: "M", reasoning: true, input: ["text"] },
				thinkingLevel: "high",
			},
			{ type: "thinking_level_changed", level: "low" },
			{ type: "ui.status", key: "git", text: "main" },
			{ type: "ui.widget", key: "todo", lines: ["a", "b"], placement: "aboveEditor" },
			{ type: "ui.title", title: "T" },
			{ type: "ui.editorText", text: "draft" },
			{ type: "ui.notify", level: "warning", message: "careful" },
			{ type: "extension.error", extensionPath: "/x.ts", event: "tool_call", error: "boom" },
			{ type: "session_info_changed", name: "Renamed" },
			{ type: "compaction_start", reason: "manual" },
		]);
		expect(state.model?.id).toBe("m");
		expect(state.thinkingLevel).toBe("low");
		expect(state.statuses).toEqual({ git: "main" });
		expect(state.widgets.todo).toEqual({ lines: ["a", "b"], placement: "aboveEditor" });
		expect(state.title).toBe("T");
		expect(state.editorText).toEqual({ text: "draft", nonce: 1 });
		expect(state.notices.map((n) => [n.kind, n.level, n.message])).toEqual([
			["notify", "warning", "careful"],
			["extension", "error", "boom"],
		]);
		expect(state.session?.name).toBe("Renamed");
		expect(state.compacting).toEqual({ reason: "manual" });
		state = run(state, [
			{ type: "ui.status", key: "git" },
			{ type: "ui.widget", key: "todo" },
			{ type: "compaction_end", reason: "manual", aborted: false, willRetry: false },
		]);
		expect(state.statuses).toEqual({});
		expect(state.widgets).toEqual({});
		expect(state.compacting).toBeUndefined();
		expect(state.needsResync).toBe(true);
		const resynced = applySnapshot(state, snapshot({ seq: 30 }));
		expect(resynced.needsResync).toBe(false);
		expect(resynced.notices).toHaveLength(2);
	});

	it("records run errors and retries", () => {
		let state = loaded();
		state = run(state, [
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "overloaded" },
		]);
		expect(state.retry).toEqual({ attempt: 1, maxAttempts: 3, errorMessage: "overloaded" });
		state = run(state, [
			{ type: "auto_retry_end", success: false },
			{
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "quota", timestamp: 1 },
			},
		]);
		expect(state.retry).toBeUndefined();
		expect(state.errorMessage).toBe("quota");
		state = run(state, [{ type: "agent_start" }]);
		expect(state.errorMessage).toBeUndefined();
	});

	it("handles session replacement and close", () => {
		let state = loaded();
		state = run(state, [{ type: "session.replaced", previousSessionId: "s1", session: { ...summary, id: "s2" } }]);
		expect(state.sessionId).toBe("s2");
		expect(state.loaded).toBe(false);
		const closed = reduceChat(state, {
			type: "evt",
			sessionId: "s2",
			seq: 1,
			event: { type: "session.closed", reason: "idle" },
		});
		expect(closed.closed).toBe("idle");
		expect(closed.runState).toBe("inactive");
	});
});

describe("cached transcripts", () => {
	const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });

	it("keeps the known prefix when a snapshot starts after it", () => {
		const state = loaded({ messages: [user("a", 1), user("b", 2)] });
		const next = applySnapshot(state, snapshot({ seq: 20, epoch: "e2", messages: [user("c", 3)], messagesFrom: 2 }));
		expect(next.messages).toEqual([user("a", 1), user("b", 2), user("c", 3)]);
		expect(next.seq).toBe(20);
		expect(next.epoch).toBe("e2");
		expect(next.needsResync).toBe(false);
	});

	it("asks for a full snapshot when it lacks the prefix the snapshot assumes", () => {
		const state = loaded({ messages: [user("a", 1)] });
		const next = applySnapshot(state, snapshot({ seq: 20, messages: [user("c", 3)], messagesFrom: 2 }));
		expect(next.needsResync).toBe(true);
		expect(next.messages).toEqual([user("a", 1)]);
	});

	it("caches only loaded state, without client-local notices", () => {
		expect(cacheableChatState(initialChatState("s1"))).toBeUndefined();
		let state = loaded({ messages: [user("a", 1)] });
		state = run(state, [{ type: "ui.notify", message: "hi" }]);
		const cached = cacheableChatState(state);
		expect(cached?.notices).toEqual([]);
		expect(cached?.messages).toEqual([user("a", 1)]);
		expect(cached?.seq).toBe(state.seq);
	});
});

describe("helpers", () => {
	it("parses partial JSON", () => {
		expect(parsePartialJson('{"path":"a.ts","content":"line1\\nli')).toEqual({ path: "a.ts", content: "line1\nli" });
		expect(parsePartialJson('{"edits":[{"oldText":"a"')).toEqual({ edits: [{ oldText: "a" }] });
		expect(parsePartialJson('{"a":')).toEqual({});
		expect(parsePartialJson("[1,2")).toBeUndefined();
		expect(parsePartialJson("")).toBeUndefined();
	});

	it("summarizes tool calls", () => {
		expect(summarizeToolCall("bash", { command: "ls" })).toBe("ls");
		expect(summarizeToolCall("edit", { path: "src/a.ts" })).toBe("src/a.ts");
		expect(summarizeToolCall("grep", { pattern: "foo", path: "src" })).toBe("foo  ·  src");
		expect(summarizeToolCall("custom", { query: "q", n: 1 })).toBe("q");
		expect(summarizeToolCall("ls", {})).toBe(".");
	});

	it("aggregates prompt cache usage into a hit rate", () => {
		const assistant = (input: number, cacheRead: number, cacheWrite: number) => ({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input, output: 10, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 10 },
			timestamp: 1,
		});
		const state = loaded({
			messages: [assistant(100, 0, 900), assistant(50, 900, 50)] as SessionSnapshot["messages"],
		});
		const usage = sessionUsage(state);
		expect(usage).toMatchObject({ input: 2000, output: 20, cacheRead: 900, cacheWrite: 950, lastContext: 1010 });
		expect(usage.cacheHitRate).toBeCloseTo(0.45);
		expect(sessionUsage(loaded()).cacheHitRate).toBeUndefined();
	});

	it("extracts edit replacements", () => {
		expect(editReplacements({ path: "a", edits: [{ oldText: "x", newText: "y" }] })).toEqual([
			{ oldText: "x", newText: "y" },
		]);
		expect(editReplacements({ path: "a", oldText: "x", newText: "y" })).toEqual([{ oldText: "x", newText: "y" }]);
		expect(editReplacements(null)).toEqual([]);
	});
});

describe("stripTrailingImageHints", () => {
	const note =
		"[Image: original 1080x2400, displayed at 900x2000. Multiply coordinates by 1.20 to map to original image.]";

	it("removes notes joined with spaces or cut off", () => {
		expect(stripTrailingImageHints(`手机不能切换审批模式吗 ${note}`)).toBe("手机不能切换审批模式吗");
		expect(stripTrailingImageHints(`a ${note} ${note}`)).toBe("a");
		expect(stripTrailingImageHints(`a\n\n${note}`)).toBe("a");
		expect(stripTrailingImageHints("a [Image converted from image/bmp to image/png.]")).toBe("a");
		expect(stripTrailingImageHints("a [Image: original 1080x2400, displayed at 9")).toBe("a");
		expect(stripTrailingImageHints("a [Image omitted: could not")).toBe("a");
		expect(stripTrailingImageHints(note)).toBe("");
	});

	it("leaves other text unchanged", () => {
		expect(stripTrailingImageHints("hello")).toBe("hello");
		expect(stripTrailingImageHints(`${note} after`)).toBe(`${note} after`);
		expect(stripTrailingImageHints("x [Image: something else]")).toBe("x [Image: something else]");
		expect(stripTrailingImageHints("x [Image")).toBe("x [Image");
	});
});

describe("stripImageHints", () => {
	const note =
		"[Image: original 2039x1128, displayed at 2000x1106. Multiply coordinates by 1.02 to map to original image.]";

	it("removes the notes pi appends to prompts with images", () => {
		expect(stripImageHints(`不支持下拉吗\n\n${note}`)).toBe("不支持下拉吗");
		expect(stripImageHints(`a\nb\n\n[Image converted from image/bmp to image/png.]\n${note}`)).toBe("a\nb");
		expect(stripImageHints("x\n\n[Image omitted: could not be resized below the inline image size limit.]")).toBe("x");
		expect(stripImageHints(`\n\n${note}`)).toBe("");
		expect(stripImageHints(`x\n\n\n${note}`)).toBe("x\n");
	});

	it("leaves other text unchanged", () => {
		expect(stripImageHints("hello")).toBe("hello");
		expect(stripImageHints(note)).toBe(note);
		expect(stripImageHints(`x\n${note}`)).toBe(`x\n${note}`);
		expect(stripImageHints(`${note}\n\nafter`)).toBe(`${note}\n\nafter`);
		expect(stripImageHints("x\n\n[Image: something else]")).toBe("x\n\n[Image: something else]");
	});

	it("applies to user transcript items only", () => {
		const content = [
			{ type: "text", text: `看图\n\n${note}` },
			{ type: "image", data: "AAA", mimeType: "image/png" },
		];
		expect(userText(content)).toBe("看图");
		const state: ChatState = {
			...initialChatState("s1"),
			messages: [{ role: "user", content, timestamp: 1 } as ChatState["messages"][number]],
		};
		const [item] = buildTranscript(state);
		expect(item).toMatchObject({ kind: "user", text: "看图" });
	});
});

describe("subagents", () => {
	const subagent = (patch: Partial<SubagentInfo>): SubagentInfo => ({
		id: "a",
		toolCallId: "call-1",
		name: "explorer",
		status: "running",
		steps: 0,
		stoppable: true,
		transcript: true,
		revision: 0,
		...patch,
	});
	const call = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "Agent", arguments: { prompt: "look" } }],
		timestamp: 1,
	};

	it("keeps subagents from snapshots and updates and attaches them to their tool calls", () => {
		let state = applySnapshot(
			initialChatState("s1"),
			snapshot({ messages: [call], pendingToolCalls: ["call-1"], subagents: [subagent({})] }),
		);
		expect(Object.keys(state.subagents)).toEqual(["a"]);
		state = run(state, [
			{ type: "subagent.update", subagent: subagent({ steps: 3, activity: "bash: ls" }) },
			{ type: "subagent.update", subagent: subagent({ id: "b", name: "reviewer" }) },
			{ type: "subagent.update", subagent: subagent({ id: "c", toolCallId: "other", parentId: "a" }) },
		]);
		expect(subagentList(state).map((s) => [s.id, s.steps])).toEqual([
			["a", 3],
			["b", 0],
			["c", 0],
		]);
		const [item] = buildTranscript(state);
		const block = item?.kind === "assistant" ? item.blocks[0] : undefined;
		expect(block).toMatchObject({ kind: "tool", status: "running", subagents: [{ id: "a" }, { id: "b" }] });
		// Older hosts and plain tools carry no subagents.
		const plain = applySnapshot(initialChatState("s1"), snapshot({ messages: [call] }));
		expect(plain.subagents).toEqual({});
		const tool = buildTranscript(plain)[0];
		expect(tool?.kind === "assistant" ? tool.blocks[0] : undefined).toMatchObject({ subagents: [] });
	});

	it("recognizes the tools that delegate", () => {
		expect(["Agent", "Task", "spawn_agent", "subagent"].every(isSubagentTool)).toBe(true);
		expect(isSubagentTool("bash")).toBe(false);
	});
});
