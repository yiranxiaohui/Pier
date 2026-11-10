import type { SubagentInfo, WireEvent } from "@pier/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storedSubagents as claudeStoredSubagents, parseAgentResult } from "../src/claude/convert.ts";
import { storedSubagents as codexStoredSubagents, convertTurns, toolCallFor } from "../src/codex/convert.ts";
import { piSubagentUpdates, storedPiSubagents } from "../src/pi/subagents.ts";
import type { TranscriptMessage } from "../src/runtimes/live-transcript.ts";
import { SubagentTracker, toolActivity } from "../src/runtimes/subagents.ts";

function tracker() {
	const events: WireEvent[] = [];
	const stop = vi.fn(async (_s: SubagentInfo) => {});
	const t = new SubagentTracker(
		(event) => events.push(event),
		() => ({ stop, load: async () => [{ role: "user", content: "stored", timestamp: 1 }] }),
	);
	return { t, events, stop, updates: () => events.map((e) => e.subagent as SubagentInfo) };
}

describe("SubagentTracker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends new subagents and status changes at once and throttles progress", () => {
		vi.useFakeTimers();
		const { t, updates } = tracker();
		t.update("a", { name: "explorer", toolCallId: "call", startedAt: 1 });
		expect(updates()).toMatchObject([{ id: "a", name: "explorer", status: "running", steps: 0, revision: 0 }]);
		t.update("a", { steps: 1 });
		t.update("a", { steps: 2, activity: "bash: ls" });
		expect(updates()).toHaveLength(1);
		vi.advanceTimersByTime(300);
		expect(updates()).toHaveLength(2);
		expect(updates()[1]).toMatchObject({ steps: 2, activity: "bash: ls" });
		t.finish("a", "completed", { result: "done" });
		expect(updates()[2]).toMatchObject({ status: "completed", result: "done", revision: 1 });
		expect(updates()[2]?.endedAt).toBeTypeOf("number");
		expect(t.forToolCall("call").map((s) => s.id)).toEqual(["a"]);
	});

	it("records live conversations, counts steps and serves them from an index", async () => {
		const { t } = tracker();
		t.update("a", { name: "explorer" });
		const conversation = t.conversation("a");
		conversation.addUser("task");
		conversation.toolCall({ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la" } });
		conversation.endAssistant();
		expect(t.get("a")).toMatchObject({ steps: 1, activity: "bash: ls -la", transcript: true });
		// A runtime reporting fewer steps than were seen does not lower the count.
		t.update("a", { steps: 0 });
		conversation.toolCall({ type: "toolCall", id: "t2", name: "read", arguments: { path: "a.txt" } });
		conversation.endAssistant();
		expect(t.get("a")?.steps).toBe(2);
		t.finish("a", "stopped");
		const result = await t.transcript("a", 1);
		expect(result).toMatchObject({ from: 1, total: 5 });
		expect(result.messages.map((m) => (m as TranscriptMessage).role)).toEqual([
			"assistant",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		expect((await t.transcript("a", 9)).messages).toEqual([]);
	});

	it("loads stored conversations on demand and stops running subagents", async () => {
		const { t, stop } = tracker();
		t.load([
			{ id: "s", name: "stored", status: "completed", steps: 3, stoppable: false, transcript: true, revision: 0 },
			{ id: "r", name: "live", status: "running", steps: 0, stoppable: true, transcript: false, revision: 0 },
			{ id: "x", name: "fixed", status: "running", steps: 0, stoppable: false, transcript: false, revision: 0 },
		]);
		expect((await t.transcript("s")).messages).toEqual([{ role: "user", content: "stored", timestamp: 1 }]);
		await expect(t.transcript("r")).rejects.toMatchObject({ code: "UNSUPPORTED" });
		await expect(t.transcript("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await t.stop()).toBe(1);
		expect(stop).toHaveBeenCalledWith(expect.objectContaining({ id: "r" }));
		await expect(t.stop("x")).rejects.toMatchObject({ code: "UNSUPPORTED" });
		expect(await t.stop("s")).toBe(0);
	});

	it("describes tool calls in one line", () => {
		expect(toolActivity("bash", { command: "npm test\n  --watch" })).toBe("bash: npm test --watch");
		expect(toolActivity("read", { path: "src/a.ts" })).toBe("read: src/a.ts");
		expect(toolActivity("wait", {})).toBe("wait");
	});
});

describe("pi-subagents details", () => {
	const details = {
		mode: "parallel",
		results: [
			{
				index: 0,
				agent: "explorer",
				task: "Map the routes",
				exitCode: 0,
				model: "openai/gpt-5:high",
				sessionName: "explorer: Map routes",
				sessionFile: "/tmp/child-0.jsonl",
				finalOutput: "Routes mapped",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			},
			{ index: 1, agent: "reviewer", task: "[prompt redacted]", exitCode: 1, error: "boom" },
		],
		progress: [
			{
				index: 0,
				agent: "explorer",
				status: "running",
				task: "Map the routes",
				currentTool: "bash",
				currentToolArgs: "rg routes",
				recentTools: [],
				recentOutput: [],
				toolCount: 4,
				tokens: 900,
				thinking: "high",
				durationMs: 1000,
			},
			{
				index: 1,
				agent: "reviewer",
				status: "failed",
				task: "[prompt redacted]",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				tokens: 0,
				durationMs: 10,
			},
		],
	};

	it("maps partial results to running and failed children", () => {
		const updates = piSubagentUpdates("call", details, false);
		expect(updates).toMatchObject([
			{
				id: "call:0",
				sessionFile: "/tmp/child-0.jsonl",
				patch: {
					toolCallId: "call",
					name: "explorer",
					task: "Map the routes",
					description: "Map routes",
					model: "gpt-5",
					thinkingLevel: "high",
					status: "running",
					steps: 4,
					tokens: 900,
					activity: "bash: rg routes",
					transcript: true,
				},
			},
			{ id: "call:1", patch: { name: "reviewer", status: "failed", error: "boom" } },
		]);
		expect(updates[0]?.patch.result).toBeUndefined();
		expect(updates[1]?.patch.task).toBeUndefined();
	});

	it("ends children with their result in the final details and in stored sessions", () => {
		const final = piSubagentUpdates("call", details, true);
		expect(final[0]?.patch).toMatchObject({ status: "completed", result: "Routes mapped" });
		expect(final[0]?.patch.activity).toBeUndefined();
		const stored = storedPiSubagents([
			{ role: "assistant", content: [] },
			{ role: "toolResult", toolName: "subagent", toolCallId: "call", details },
			{ role: "toolResult", toolName: "bash", toolCallId: "other", details },
		]);
		expect(stored.map((s) => [s.info.id, s.info.status, s.sessionFile])).toEqual([
			["call:0", "completed", "/tmp/child-0.jsonl"],
			["call:1", "failed", undefined],
		]);
		expect(piSubagentUpdates("call", { mode: "management", results: [] }, true)).toEqual([]);
	});
});

describe("Claude Code Agent results", () => {
	const text = [
		"  <tools-used-before-summary>Read</tools-used-before-summary>",
		"  ",
		"[Subagent hand-back] The text below is the final report of a subagent. The report follows:",
		"  Line one",
		"  ",
		"  - item",
		"agentId: a1b2 (use SendMessage with to: 'a1b2' to continue this agent)",
		"<usage>subagent_tokens: 31870",
		"tool_uses: 2",
		"duration_ms: 7616</usage>",
	].join("\n");

	it("parses the report, agent id and usage", () => {
		expect(parseAgentResult(text)).toEqual({
			report: "Line one\n\n- item",
			agentId: "a1b2",
			tokens: 31870,
			toolUses: 2,
			durationMs: 7616,
		});
		expect(parseAgentResult("plain result")).toEqual({ report: "plain result" });
	});

	it("finds the subagents of a stored conversation", () => {
		const messages: TranscriptMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_1",
						name: "Agent",
						arguments: { description: "Read files", subagent_type: "Explore", prompt: "Read them" },
					},
					{ type: "toolCall", id: "toolu_2", name: "Agent", arguments: { prompt: "Never finished" } },
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "Agent",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 2,
			},
		];
		expect(claudeStoredSubagents(messages, true)).toMatchObject([
			{
				agentId: "a1b2",
				info: {
					id: "toolu_1",
					name: "Explore",
					description: "Read files",
					task: "Read them",
					status: "completed",
					steps: 2,
					tokens: 31870,
					durationMs: 7616,
					result: "Line one\n\n- item",
					transcript: true,
				},
			},
			{ info: { id: "toolu_2", name: "Agent", status: "stopped" } },
		]);
	});
});

describe("Codex sub-agent items", () => {
	const started = {
		type: "subAgentActivity",
		id: "call_1",
		kind: "started",
		agentThreadId: "child-1",
		agentPath: "/root/read_files",
		model: "gpt-x",
		reasoningEffort: "low",
	};
	const turns = [
		{
			id: "turn-1",
			status: "completed",
			startedAt: 1,
			items: [
				{ type: "userMessage", id: "u", content: [{ type: "text", text: "go" }] },
				started,
				{
					type: "collabAgentToolCall",
					id: "call_2",
					tool: "spawnAgent",
					status: "completed",
					senderThreadId: "main",
					receiverThreadIds: ["child-2"],
					prompt: "Review the diff",
					model: null,
					reasoningEffort: "high",
					agentsStates: { "child-2": { status: "running", message: null } },
				},
				{
					type: "subAgentActivity",
					id: "subagent-completed-x",
					kind: "completed",
					agentThreadId: "child-1",
					agentPath: "/root/read_files",
				},
				{
					type: "collabAgentToolCall",
					id: "call_3",
					tool: "wait",
					status: "completed",
					senderThreadId: "main",
					receiverThreadIds: ["child-2"],
					prompt: null,
					model: null,
					reasoningEffort: null,
					agentsStates: { "child-2": { status: "errored", message: "crashed" } },
				},
			],
		},
	];

	it("shows spawns and collaboration tools as tool calls", () => {
		expect(toolCallFor(started)).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "spawn_agent",
			arguments: { agent: "read_files", agentPath: "/root/read_files", model: "gpt-x", reasoningEffort: "low" },
		});
		expect(toolCallFor({ ...started, kind: "completed" })).toBeUndefined();
		const messages = convertTurns(turns);
		const calls = messages.flatMap((m) =>
			m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall").map((p) => p.name) : [],
		);
		expect(calls).toEqual(["spawn_agent", "spawn_agent", "wait_agent"]);
	});

	it("finds the sub-agents of stored turns", () => {
		expect(codexStoredSubagents(turns)).toEqual([
			{
				id: "child-1",
				toolCallId: "call_1",
				name: "read_files",
				model: "gpt-x",
				thinkingLevel: "low",
				status: "completed",
				steps: 0,
				stoppable: false,
				transcript: true,
				revision: 0,
			},
			{
				id: "child-2",
				toolCallId: "call_2",
				name: "Subagent",
				task: "Review the diff",
				thinkingLevel: "high",
				status: "failed",
				error: "crashed",
				steps: 0,
				stoppable: false,
				transcript: true,
				revision: 0,
			},
		]);
	});
});
