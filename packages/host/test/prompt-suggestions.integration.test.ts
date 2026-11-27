import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import type { SessionSnapshot, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanSuggestion, excerptPrompt, SUGGESTION_INSTRUCTION } from "../src/runtimes/prompt-suggestion.ts";
import { fauxAssistantMessage, Recorder, startTestHost, type TestHost } from "./helpers.ts";

describe("prompt suggestion text", () => {
	it("keeps a short answer and drops quotes, NONE and long answers", () => {
		expect(cleanSuggestion("  Run the tests  ")).toBe("Run the tests");
		expect(cleanSuggestion('"Run the tests"')).toBe("Run the tests");
		expect(cleanSuggestion("「把测试也跑一遍」")).toBe("把测试也跑一遍");
		expect(cleanSuggestion("NONE")).toBeUndefined();
		expect(cleanSuggestion("none.")).toBeUndefined();
		expect(cleanSuggestion("")).toBeUndefined();
		expect(cleanSuggestion(undefined)).toBeUndefined();
		expect(cleanSuggestion("x".repeat(501))).toBeUndefined();
	});

	it("quotes the end of a conversation within a budget", () => {
		expect(excerptPrompt([{ role: "assistant", text: "Hello" }])).toBeUndefined();
		const prompt = excerptPrompt([
			{ role: "user", text: "The first question" },
			...Array.from({ length: 5 }, () => ({ role: "assistant" as const, text: "reply ".repeat(1000) })),
			{ role: "user", text: "Fix the bug" },
			{ role: "assistant", text: "Fixed it." },
		]);
		expect(prompt).toContain("User: Fix the bug\n\nAssistant: Fixed it.");
		// Long messages are cut, and the oldest ones no longer fit.
		expect(prompt).toContain("reply …");
		expect(prompt).not.toContain("The first question");
		expect(prompt?.length).toBeLessThan(14_000);
	});
});

describe("prompt suggestions (pi)", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost();
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	async function newSession(): Promise<{ session: SessionSummary; rec: Recorder }> {
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		return { session, rec };
	}

	it("is off by default and saved in Pier's config", async () => {
		expect(await client.request("suggestions.get", {})).toEqual({ enabled: false });
		expect(await client.request("suggestions.set", { enabled: true })).toEqual({ enabled: true });
		expect(await client.request("suggestions.get", {})).toEqual({ enabled: true });
		const config = JSON.parse(readFileSync(join(t.root, "pier", "config.json"), "utf8"));
		expect(config.promptSuggestions).toBe(true);
	});

	it("makes no extra request while off", async () => {
		t.faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Run the tests")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "fix it" });
		await rec.waitForType("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(t.faux.getPendingResponseCount()).toBe(1);
		expect(rec.types()).not.toContain("session.suggestion");
	});

	it("predicts the next prompt from the whole conversation and clears it when a run starts", async () => {
		await client.request("suggestions.set", { enabled: true });
		const seen: unknown[][] = [];
		t.faux.setResponses([
			(context) => {
				seen.push(context.messages);
				return fauxAssistantMessage("Fixed the bug.");
			},
			(context) => {
				seen.push(context.messages);
				return fauxAssistantMessage('"Now run the tests"');
			},
			fauxAssistantMessage("Tests pass."),
			fauxAssistantMessage("NONE"),
		]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "fix the bug" });
		const frame = await rec.waitFor((f) => f.event.type === "session.suggestion" && f.event.text !== undefined);
		expect(frame.event).toEqual({ type: "session.suggestion", text: "Now run the tests" });
		// The prediction saw the conversation and the instruction as the last user message, and the
		// session did not record it.
		const [turn, prediction] = seen as Array<Array<{ role: string; content: unknown }>>;
		expect(prediction?.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		// It starts like the turn's request, so it reads the same prompt cache.
		expect(prediction?.slice(0, turn?.length)).toEqual(turn);
		expect(JSON.stringify(prediction?.at(-1)?.content)).toContain("Pier prompt suggestion");
		const snapshot: SessionSnapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(snapshot.suggestion).toBe("Now run the tests");
		expect((snapshot.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		expect(JSON.stringify(snapshot.messages)).not.toContain(SUGGESTION_INSTRUCTION.slice(0, 30));

		const from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "Now run the tests" });
		const cleared = await rec.waitForType("session.suggestion", from);
		expect(cleared.event).toEqual({ type: "session.suggestion" });
		await rec.waitForType("agent_settled", from);
		// "NONE" means there is nothing to suggest.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(t.faux.getPendingResponseCount()).toBe(0);
		expect(rec.frames.slice(from).filter((f) => f.event.type === "session.suggestion")).toHaveLength(1);
		expect((await client.request("session.snapshot", { sessionId: session.id })).suggestion).toBeUndefined();
	});

	it("drops the suggestion when the setting goes off", async () => {
		await client.request("suggestions.set", { enabled: true });
		t.faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Commit it")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "fix it" });
		await rec.waitFor((f) => f.event.type === "session.suggestion" && f.event.text === "Commit it");
		const from = rec.mark();
		await client.request("suggestions.set", { enabled: false });
		expect((await rec.waitForType("session.suggestion", from)).event).toEqual({ type: "session.suggestion" });
		expect((await client.request("session.snapshot", { sessionId: session.id })).suggestion).toBeUndefined();
	});
});
