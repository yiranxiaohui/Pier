import type { EventFrame, SessionSnapshot } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	buildTranscript,
	formatThinking,
	initialChatState,
	isWaitingForModel,
	reduceChat,
	splitThinkingTags,
	thinkingHeadline,
} from "../src/index.ts";

describe("splitThinkingTags", () => {
	it("leaves text without tags unchanged", () => {
		expect(splitThinkingTags("  plain **text**\n")).toEqual([{ kind: "text", text: "  plain **text**\n" }]);
		expect(splitThinkingTags("")).toEqual([]);
	});

	it("splits closed tags out of the reply", () => {
		expect(splitThinkingTags("<thinking>**Locating the proxy code**</thinking>\nThe project already has it.")).toEqual([
			{ kind: "thinking", text: "**Locating the proxy code**", closed: true },
			{ kind: "text", text: "The project already has it." },
		]);
		expect(splitThinkingTags("Intro\n\n<think>\nstep\n</think>\n\nAnswer")).toEqual([
			{ kind: "text", text: "Intro" },
			{ kind: "thinking", text: "step", closed: true },
			{ kind: "text", text: "Answer" },
		]);
	});

	it("runs an unclosed tag to the end of the text", () => {
		expect(splitThinkingTags("<thinking>**Merging task branch into main**")).toEqual([
			{ kind: "thinking", text: "**Merging task branch into main**", closed: false },
		]);
	});

	it("keeps tags in code blocks and in the middle of a line as text", () => {
		const code = "```xml\n<thinking>kept</thinking>\n```";
		expect(splitThinkingTags(code)).toEqual([{ kind: "text", text: code }]);
		const inline = "Claude wraps it in <thinking> tags.";
		expect(splitThinkingTags(inline)).toEqual([{ kind: "text", text: inline }]);
	});

	it("holds back the start of a tag while it streams", () => {
		expect(splitThinkingTags("<thin", true)).toEqual([]);
		expect(splitThinkingTags("Done.\n<", true)).toEqual([{ kind: "text", text: "Done." }]);
		expect(splitThinkingTags("a < b", true)).toEqual([{ kind: "text", text: "a < b" }]);
		expect(splitThinkingTags("<thin")).toEqual([{ kind: "text", text: "<thin" }]);
	});
});

describe("formatThinking", () => {
	it("puts run-together summary titles on lines of their own", () => {
		expect(formatThinking("**Planning merge****Checking tests**")).toBe("**Planning merge**\n\n**Checking tests**");
		expect(formatThinking("Looked at it.**Next step**\n\nBody")).toBe("Looked at it.\n\n**Next step**\n\nBody");
		expect(formatThinking("a **bold** word\nand **end**")).toBe("a **bold** word\nand **end**");
		expect(formatThinking("**A****B**", { plain: true })).toBe("A\n\nB");
	});

	it("finds the latest headline", () => {
		expect(thinkingHeadline("**Planning merge****Checking tests**")).toBe("Checking tests");
		expect(thinkingHeadline("**Plan**\n\nSome details.\n\n**Deploy**\n\nMore.")).toBe("Deploy");
		expect(thinkingHeadline("Fetch direct remote then merge push")).toBe("Fetch direct remote then merge push");
		expect(thinkingHeadline("First line.\nSecond line.")).toBeUndefined();
		expect(thinkingHeadline("")).toBeUndefined();
	});
});

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
