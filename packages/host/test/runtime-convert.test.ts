import { describe, expect, it } from "vitest";
import { claudeModelInfo } from "../src/claude/claude-runtime.ts";
import { convertTranscript, normalizeTool, promptText, structuredDiff } from "../src/claude/convert.ts";
import { convertTurns, fileChangeDiff, toModelInfo, toolResultFor } from "../src/codex/convert.ts";
import { hunksToDiff, parseUnifiedDiff } from "../src/runtimes/diff.ts";

describe("diffs in pi's format", () => {
	it("numbers added, removed and context lines", () => {
		expect(hunksToDiff([{ oldStart: 9, newStart: 9, lines: [" a", "-b", "+c", " d"] }])).toBe(
			"  9 a\n-10 b\n+10 c\n 11 d",
		);
	});

	it("parses unified diffs", () => {
		const hunks = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n");
		expect(hunks).toEqual([{ oldStart: 1, newStart: 1, lines: ["-old", "+new", " same"] }]);
	});
});

describe("Claude Code conversions", () => {
	it("maps Claude Code tools to pi tools", () => {
		expect(normalizeTool("Bash", { command: "ls", description: "List" })).toEqual({
			name: "bash",
			arguments: { command: "ls", description: "List" },
		});
		expect(normalizeTool("Edit", { file_path: "/w/a.txt", old_string: "x", new_string: "y" })).toEqual({
			name: "edit",
			arguments: { path: "/w/a.txt", edits: [{ oldText: "x", newText: "y" }] },
		});
		expect(normalizeTool("Write", { file_path: "/w/b.txt", content: "hi" }).name).toBe("write");
		expect(normalizeTool("WebFetch", { url: "https://x" })).toEqual({
			name: "WebFetch",
			arguments: { url: "https://x" },
		});
	});

	it("turns structured patches into diffs", () => {
		expect(
			structuredDiff({
				structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
			}),
		).toBe("-1 a\n+1 b");
		expect(structuredDiff({ type: "create", content: "x\ny\n", structuredPatch: [] })).toBe("+1 x\n+2 y");
	});

	it("hides entries Claude Code adds and restores typed commands", () => {
		expect(promptText("<command-name>/compact</command-name><command-args>keep tests</command-args>")).toBe(
			"/compact keep tests",
		);
		expect(promptText("<local-command-stdout>done</local-command-stdout>")).toBeUndefined();
		expect(promptText("hello")).toBe("hello");
	});

	it("merges assistant entries of one API message and attaches tool results", () => {
		const messages = convertTranscript([
			{ type: "user", uuid: "u1", message: { role: "user", content: "list files" } },
			{
				type: "assistant",
				uuid: "a1",
				message: { id: "msg_1", model: "claude-x", content: [{ type: "thinking", thinking: "hmm" }] },
			},
			{
				type: "assistant",
				uuid: "a2",
				message: {
					id: "msg_1",
					content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
					stop_reason: "tool_use",
					usage: { input_tokens: 3, output_tokens: 4 },
				},
			},
			{
				type: "user",
				uuid: "u2",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
			},
			{ type: "assistant", uuid: "a3", message: { id: "msg_2", content: [{ type: "text", text: "Done" }] } },
		]);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(messages[0]).toMatchObject({ content: "list files", entryId: "u1" });
		expect(messages[1]).toMatchObject({
			provider: "claude-code",
			model: "claude-x",
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			],
			usage: { input: 3, output: 4, totalTokens: 7 },
		});
		expect(messages[2]).toMatchObject({
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text: "a.txt" }],
		});
	});
});

describe("Codex conversions", () => {
	it("maps models and reasoning efforts", () => {
		expect(
			toModelInfo({
				id: "m",
				model: "gpt-x",
				displayName: "GPT X",
				supportedReasoningEfforts: [
					{ reasoningEffort: "future-effort" },
					{ reasoningEffort: "low" },
					{ reasoningEffort: "high" },
					{ reasoningEffort: "ultra" },
				],
				inputModalities: ["text", "image"],
				description: " Frontier agentic coding model. ",
			}),
		).toEqual({
			provider: "codex",
			id: "gpt-x",
			name: "GPT X",
			description: "Frontier agentic coding model.",
			reasoning: true,
			input: ["text", "image"],
			thinkingLevels: ["low", "high", "ultra"],
		});
	});

	it("leaves out an empty description", () => {
		expect(toModelInfo({ model: "gpt-y", displayName: "GPT Y", description: "  " })).not.toHaveProperty("description");
	});

	it("reports command results and file change diffs", () => {
		expect(
			toolResultFor({ type: "commandExecution", status: "completed", exitCode: 1, aggregatedOutput: "oops" }),
		).toEqual({ text: "oops\n\nCommand exited with code 1", isError: true });
		const change = {
			type: "fileChange",
			status: "completed",
			changes: [{ path: "a.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }],
		};
		expect(fileChangeDiff(change)).toBe("-1 a\n+1 b");
		expect(toolResultFor(change)).toMatchObject({
			text: "Updated a.txt",
			isError: false,
			details: { diff: "-1 a\n+1 b" },
		});
	});

	it("converts stored turns", () => {
		const messages = convertTurns([
			{
				id: "turn-1",
				startedAt: 100,
				status: "completed",
				items: [
					{ type: "userMessage", id: "i0", content: [{ type: "text", text: "run it", text_elements: [] }] },
					{ type: "reasoning", id: "i1", summary: ["thinking"], content: [] },
					{
						type: "commandExecution",
						id: "i2",
						command: "echo hi",
						cwd: "/w",
						status: "completed",
						exitCode: 0,
						aggregatedOutput: "hi\n",
					},
					{ type: "agentMessage", id: "i3", text: "Done." },
				],
			},
		]);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(messages[0]).toMatchObject({ content: "run it", entryId: "turn-1", timestamp: 100_000 });
		expect(messages[1]).toMatchObject({
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "thinking" },
				{ type: "toolCall", id: "i2", name: "bash", arguments: { command: "echo hi", cwd: "/w" } },
			],
		});
		expect(messages[2]).toMatchObject({ toolCallId: "i2", content: [{ type: "text", text: "hi\n" }], isError: false });
		expect(messages[3]).toMatchObject({ content: [{ type: "text", text: "Done." }], stopReason: "stop" });
	});
});

describe("Claude Code models", () => {
	it("keeps the description Claude Code's /model picker shows", () => {
		expect(
			claudeModelInfo({
				value: "default",
				resolvedModel: "claude-opus-5-5",
				displayName: "Default (recommended)",
				description: "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
				supportsEffort: true,
				supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
			}),
		).toEqual({
			provider: "claude-code",
			id: "default",
			name: "Default (recommended)",
			description: "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
			reasoning: true,
			input: ["text", "image"],
			thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
		});
		const plain = claudeModelInfo({ value: "opus[1m]", displayName: "", description: "" });
		expect(plain).toMatchObject({ id: "opus[1m]", name: "opus[1m]", contextWindow: 1_000_000 });
		expect(plain).not.toHaveProperty("description");
	});
});
