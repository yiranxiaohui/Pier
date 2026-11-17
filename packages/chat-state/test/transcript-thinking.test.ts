import type { EventFrame, SessionSnapshot } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import { buildTranscript, initialChatState, isWaitingForModel, reduceChat } from "../src/index.ts";

const summary = {
	id: "s1",
	workspaceId: "w1",
	cwd: "/tmp/w",
	createdAt: "2026-01-01T00:00:00.000Z",
	modifiedAt: "2026-01-01T00:00:00.000Z",
	messageCount: 0,
	firstMessage: "",
	active: true,
	state: "idle",
} as const;

function stateWith(overrides: Partial<SessionSnapshot>) {
	const snapshot: SessionSnapshot = {
		session: summary,
		seq: 1,
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
	const frame: EventFrame = { type: "evt", sessionId: "s1", event: { type: "session.snapshot", snapshot } };
	return reduceChat(initialChatState("s1"), frame);
}

describe("transcript thinking tags", () => {
	it("shows tagged thinking in a reply as thinking, joined with the thinking before it", () => {
		const state = stateWith({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "**Planning merge**" },
						{ type: "text", text: "<thinking>**Merging task branch into main**</thinking>\nMerging now." },
						{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "git merge" } },
					],
					stopReason: "toolUse",
					timestamp: 1,
				},
			],
		});
		const [item] = buildTranscript(state);
		expect(item?.kind === "assistant" && item.blocks.map((b) => (b.kind === "tool" ? b.kind : b))).toEqual([
			{
				kind: "thinking",
				text: "**Planning merge**\n\n**Merging task branch into main**",
				redacted: false,
				live: false,
			},
			{ kind: "text", text: "Merging now." },
			"tool",
		]);
	});

	it("marks an unclosed tag in the streaming reply as live thinking", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "<thinking>**Deploying rebuilt container", completed: false }],
			timestamp: 2,
		};
		const state = { ...stateWith({}), runState: "streaming" as const, streaming: message as never };
		const item = buildTranscript(state).at(-1);
		expect(item?.kind === "assistant" && item.blocks).toEqual([
			{ kind: "thinking", text: "**Deploying rebuilt container", redacted: false, live: true },
		]);
		expect(isWaitingForModel(state, buildTranscript(state))).toBe(false);

		const closed = {
			...message,
			content: [{ type: "text", text: "<thinking>**Deploying**</thinking>\n", completed: false }],
		};
		const next = { ...state, streaming: closed as never };
		// Only collapsed thinking is visible: keep showing that the model is working.
		expect(isWaitingForModel(next, buildTranscript(next))).toBe(true);
	});
});
