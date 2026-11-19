import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PierClient } from "@pier/client";
import type { WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HermesRuntime } from "../src/hermes/hermes-runtime.ts";
import { modelState, splitChoice } from "../src/hermes/models.ts";
import { mapHermesTool, textDiff } from "../src/hermes/transcript.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

const FAKE_HERMES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-hermes-acp.mjs");

type Json = Record<string, unknown>;

describe("Hermes runtime", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let dir: string;

	async function start(policy: "ask" | "smart" | "auto" = "ask") {
		t = await startTestHost({
			agents: {
				hermes: {
					executable: process.execPath,
					scriptArgs: [FAKE_HERMES],
					env: { ...process.env, FAKE_HERMES_DIR: dir },
				},
			},
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir, policy })).workspace;
	}

	function requests(method?: string): Json[] {
		const lines = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n");
		return lines.map((l) => JSON.parse(l) as Json).filter((r) => !method || r.method === method);
	}

	function stored(): Record<string, Json> {
		return JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pier-hermes-"));
	});
	afterEach(async () => {
		await t?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("streams a turn, lists Hermes' models and switches model and reasoning effort", async () => {
		await start();
		const { runtimes } = await client.request("runtime.list", {});
		expect(runtimes.find((r) => r.id === "hermes")).toMatchObject({
			name: "Hermes",
			available: true,
			version: "0.0.0-fake",
		});

		const listed = await client.request("model.list", { runtime: "hermes", workspaceId: workspace.id });
		expect(listed.models.map((m) => `${m.provider}/${m.id}`)).toEqual([
			"deepseek/deepseek-chat",
			"deepseek/deepseek-reasoner",
			"custom:proxy/gpt-x",
		]);
		expect(listed.models[0]).toMatchObject({ providerName: "DeepSeek", name: "deepseek-chat", reasoning: true });
		expect(listed.models[2]).toMatchObject({ providerName: "My Proxy", name: "gpt-x" });
		expect(listed.current).toMatchObject({ provider: "deepseek", id: "deepseek-chat" });
		expect(listed.thinkingLevel).toBe("medium");

		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "hermes" });
		// The session the model list was read with is used for the new session.
		expect(requests("session/new")).toHaveLength(1);
		expect((requests("initialize")[0]?.params as Json | undefined)?.clientCapabilities).toMatchObject({
			terminal: false,
			elicitation: { form: {} },
		});

		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler);
		await client.request("model.set", { sessionId: session.id, provider: "deepseek", modelId: "deepseek-reasoner" });
		expect(await client.request("thinking.set", { sessionId: session.id, level: "high" })).toEqual({ level: "high" });
		expect(requests("session/set_config_option").map((r) => (r.params as Json).value)).toEqual([
			"deepseek:deepseek-reasoner",
			"high",
		]);

		await client.request("session.prompt", {
			sessionId: session.id,
			text: "Say hello",
			images: [{ type: "image", mimeType: "image/png", data: "YWJj" }],
		});
		await rec.waitForType("agent_settled");
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		const assistant = snapshot.messages.at(-1) as Json;
		expect(assistant).toMatchObject({
			role: "assistant",
			provider: "deepseek",
			model: "deepseek-reasoner",
			content: [
				{ type: "thinking", thinking: "Let me think." },
				{ type: "text", text: "Hello from deepseek:deepseek-reasoner." },
			],
			// 100 prompt tokens, 40 of them cached.
			usage: { input: 60, output: 20, cacheRead: 40 },
		});
		expect(snapshot.model).toMatchObject({ provider: "deepseek", id: "deepseek-reasoner" });
		expect(snapshot.thinkingLevel).toBe("high");
		expect(snapshot.contextInfo).toMatchObject({ contextWindow: 128000, contextTokens: 1000 });
		expect(snapshot.session.name).toBe("Title of Say hello");
		const prompt = requests("session/prompt")[0]?.params as Json;
		expect(prompt.prompt).toEqual([
			{ type: "text", text: "Say hello" },
			{ type: "image", mimeType: "image/png", data: "YWJj" },
		]);
		const { commands } = await client.request("session.commands", { sessionId: session.id });
		expect(commands).toContainEqual({
			name: "title",
			description: "Show or set the session title",
			argumentHint: "<new title>",
			source: "prompt",
		});
	});

	it("asks for Hermes' approvals with the workspace policy and answers its questions", async () => {
		await start("ask");
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "hermes" });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler);

		await client.request("session.prompt", { sessionId: session.id, text: "approve the cleanup" });
		const approval = await rec.waitForType("ui.request");
		expect(approval.event.request).toMatchObject({
			kind: "approval",
			approval: { toolName: "bash", summary: "rm -rf build" },
		});
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (approval.event.request as { id: string }).id,
			response: { decision: "deny", reason: "keep it" },
		});
		await rec.waitForType("agent_settled");
		let snapshot = await client.request("session.snapshot", { sessionId: session.id });
		const call = snapshot.messages.find(
			(m) => (m as Json).role === "assistant" && JSON.stringify(m).includes("toolCall"),
		) as Json;
		expect(call.content).toContainEqual({
			type: "toolCall",
			id: expect.any(String),
			name: "bash",
			arguments: { command: "rm -rf build" },
		});
		expect(snapshot.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "bash", isError: true }),
		);
		expect(stored()[session.id]?.history).toBeDefined();

		let from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "edit the notes" });
		const edit = await rec.waitFor((f) => f.event.type === "ui.request", from);
		expect(edit.event.request).toMatchObject({ approval: { toolName: "edit", summary: "notes.txt" } });
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (edit.event.request as { id: string }).id,
			response: { decision: "allow_once" },
		});
		await rec.waitFor((f) => f.event.type === "agent_settled", from);
		snapshot = await client.request("session.snapshot", { sessionId: session.id });
		const result = snapshot.messages.findLast((m) => (m as Json).role === "toolResult") as Json;
		expect(result).toMatchObject({ toolName: "edit", isError: false });
		expect((result.details as { diff: string }).diff).toContain("-2 two");
		expect((result.details as { diff: string }).diff).toContain("+2 TWO");

		from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "a question for you" });
		const question = await rec.waitFor((f) => f.event.type === "ui.request", from);
		expect(question.event.request).toMatchObject({ kind: "select", options: ["red", "blue"] });
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (question.event.request as { id: string }).id,
			response: { value: "blue" },
		});
		await rec.waitFor((f) => f.event.type === "agent_settled", from);
		snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(JSON.stringify(snapshot.messages.at(-1))).toContain("You chose blue.");
	});

	it("lets the auto policy approve without asking", async () => {
		await start("auto");
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "hermes" });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler);
		await client.request("session.prompt", { sessionId: session.id, text: "approve the cleanup" });
		await rec.waitForType("agent_settled");
		expect(rec.types()).not.toContain("ui.request");
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(snapshot.messages).toContainEqual(expect.objectContaining({ role: "toolResult", isError: false }));
	});

	it("reopens, renames and deletes stored sessions, and aborts a running turn", async () => {
		await start();
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "hermes" });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler);
		// Before the first turn the session is not stored: the name is applied after it.
		await client.request("session.rename", { sessionId: session.id, name: "My task" });
		await client.request("session.prompt", { sessionId: session.id, text: "approve it" });
		const approval = await rec.waitForType("ui.request");
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (approval.event.request as { id: string }).id,
			response: { decision: "allow_once" },
		});
		await rec.waitForType("agent_settled");
		await expect.poll(() => stored()[session.id]?.title).toBe("My task");
		expect((await client.request("session.snapshot", { sessionId: session.id })).session.name).toBe("My task");

		await client.request("session.close", { sessionId: session.id });
		// A new ACP server: the session is loaded from Hermes' store.
		await (await (t.host.pool.runtime("hermes") as HermesRuntime).connect()).stop();
		const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
		expect(sessions.find((s) => s.id === session.id)).toMatchObject({ name: "My task", runtime: "hermes" });

		const reopened = await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		const snapshot = await client.request("session.snapshot", { sessionId: reopened.session.id });
		expect(snapshot.messages.map((m) => (m as Json).role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(snapshot.messages[0]).toMatchObject({ role: "user", content: "approve it" });
		expect(snapshot.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "bash", isError: false }),
		);
		expect(snapshot.model).toMatchObject({ id: "deepseek-chat" });

		const rec2 = new Recorder();
		await client.subscribe(session.id, rec2.handler);
		await client.request("session.prompt", { sessionId: session.id, text: "hold on" });
		await rec2.waitFor((f) => f.event.type === "message_update");
		await client.request("session.abort", { sessionId: session.id });
		const aborted = await client.request("session.snapshot", { sessionId: session.id });
		expect(aborted.session.state).toBe("idle");
		expect(aborted.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(requests("session/cancel")).toHaveLength(1);

		await client.request("session.close", { sessionId: session.id });
		expect(await client.request("session.delete", { workspaceId: workspace.id, sessionId: session.id })).toEqual({
			deleted: true,
		});
		expect(stored()[session.id]).toBeUndefined();
		const after = await client.request("session.list", { workspaceId: workspace.id });
		expect(after.sessions.find((s) => s.id === session.id)).toBeUndefined();
	});

	it("re-attaches an open session after the ACP server restarted", async () => {
		await start();
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "hermes" });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler);
		await client.request("session.prompt", { sessionId: session.id, text: "first" });
		await rec.waitForType("agent_settled");
		const runtime = t.host.pool.runtime("hermes") as HermesRuntime;
		await (await runtime.connect()).stop();
		const from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "second" });
		await rec.waitFor((f) => f.event.type === "agent_settled", from);
		expect(requests("session/resume")).toHaveLength(1);
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		// The resumed session's replayed history is not added again.
		expect(snapshot.messages.map((m) => (m as Json).role)).toEqual(["user", "assistant", "user", "assistant"]);
	});

	it("compresses with /compress once a turn ends past the context limit (1.64)", async () => {
		await start("auto");
		const { runtimes } = await client.request("runtime.list", {});
		expect(runtimes.find((r) => r.id === "hermes")?.capabilities).toMatchObject({
			compact: true,
			contextLimit: { min: 64_000, enforcement: "turn" },
		});
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "hermes" });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		const sessionId = session.id;
		const compresses = () =>
			requests("session/prompt")
				.map((r) => ((r.params as { prompt: Array<{ text?: string }> }).prompt[0]?.text ?? "").trim())
				.filter((text) => text.startsWith("/compress"));

		const { contextInfo } = await client.request("contextLimit.set", { sessionId, limit: 64_000 });
		expect(contextInfo).toMatchObject({
			autoCompaction: "configured",
			contextLimit: 64_000,
			compactionThreshold: 64_000,
		});
		await client.request("session.prompt", { sessionId, text: "hello" });
		await rec.waitForType("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(compresses()).toEqual([]);

		let from = rec.mark();
		await client.request("session.prompt", { sessionId, text: "grow 70000" });
		const end = await rec.waitForType("compaction_end", from);
		expect(end.event).toMatchObject({ reason: "threshold", aborted: false, result: { tokensBefore: 71_000 } });
		expect(compresses()).toEqual(["/compress"]);
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle", from);
		const snapshot = await client.request("session.snapshot", { sessionId });
		expect(snapshot.messages.at(-1)).toMatchObject({ role: "compactionSummary", tokensBefore: 71_000 });
		expect(snapshot.contextInfo?.contextTokens).toBe(1500);
		// Hermes' answer to the command stays out of the conversation.
		expect(JSON.stringify(snapshot.messages)).not.toContain("Context compressed");

		// Manual compaction passes the instructions as the summary's focus.
		expect(await client.request("session.compact", { sessionId, instructions: "keep the TODOs" })).toEqual({
			summary: "",
			tokensBefore: 1500,
		});
		expect(compresses().at(-1)).toBe("/compress keep the TODOs");

		// Without a limit nothing happens; lowering it below the current context compresses at once.
		await client.request("contextLimit.set", { sessionId, limit: null });
		from = rec.mark();
		await client.request("session.prompt", { sessionId, text: "grow 80000" });
		await rec.waitForType("agent_settled", from);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(compresses()).toHaveLength(2);
		from = rec.mark();
		await client.request("contextLimit.set", { sessionId, limit: 64_000 });
		await rec.waitForType("compaction_end", from);
		expect(compresses()).toHaveLength(3);
	});
});

describe("Hermes conversions", () => {
	it("splits Hermes' model choices", () => {
		expect(splitChoice("deepseek:deepseek-chat")).toEqual({ provider: "deepseek", id: "deepseek-chat" });
		expect(splitChoice("custom:local:qwen3:8b")).toEqual({ provider: "custom:local", id: "qwen3:8b" });
		expect(splitChoice("ollama:qwen3:8b")).toEqual({ provider: "ollama", id: "qwen3:8b" });
		expect(splitChoice("gpt-x")).toEqual({ provider: "hermes", id: "gpt-x" });
	});

	it("reads the older models state when Hermes sends no config options", () => {
		const state = modelState({
			models: {
				currentModelId: "deepseek:deepseek-chat",
				availableModels: [{ modelId: "deepseek:deepseek-chat", name: "DeepSeek · deepseek-chat" }],
			},
		});
		expect(state.current).toMatchObject({ provider: "deepseek", id: "deepseek-chat", providerName: "DeepSeek" });
		expect(state.levels).toEqual(["off"]);
		expect(state.hasReasoning).toBe(false);
	});

	it("maps Hermes tools to the tools Pier renders", () => {
		const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
		expect(mapHermesTool({ title: "terminal: ls -la", content: text("$ ls -la") })).toMatchObject({
			name: "bash",
			arguments: { command: "ls -la" },
		});
		expect(mapHermesTool({ title: "read_file: src/a.ts", locations: [{ path: "src/a.ts" }] })).toMatchObject({
			name: "read",
			arguments: { path: "src/a.ts" },
		});
		expect(
			mapHermesTool({ title: "search_files: TODO", content: text("Searching for 'TODO' (content) in src") }),
		).toMatchObject({ name: "grep", arguments: { pattern: "TODO", path: "src" } });
		expect(mapHermesTool({ title: "web_search: pier", content: text("Searching the web for: pier") })).toMatchObject({
			name: "web_search",
			arguments: { summary: "pier", details: "Searching the web for: pier" },
		});
		expect(mapHermesTool({ title: "browser_click", content: text('{"ref": "@e3"}') })).toMatchObject({
			name: "browser_click",
			arguments: { ref: "@e3" },
		});
	});

	it("diffs whole-file edits around the changed lines", () => {
		const old = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		const changed = old.replace("line 6", "LINE 6");
		expect(textDiff(old, changed)).toBe(
			[
				"   ...",
				" 3 line 3",
				" 4 line 4",
				" 5 line 5",
				"-6 line 6",
				"+6 LINE 6",
				" 7 line 7",
				" 8 line 8",
				" 9 line 9",
				"   ...",
			].join("\n"),
		);
		expect(textDiff(undefined, "a\nb\n")).toBe("+1 a\n+2 b");
	});
});
