import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applySnapshot,
	buildTranscript,
	ChatController,
	type ChatState,
	initialChatState,
	isWaitingForModel,
	reduceChat,
	resolveSlash,
	runBuiltin,
	type SlashActions,
	subagentList,
	waitingForModelLabel,
} from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import type { SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

describe("Codex runtime", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let codexDir: string;

	beforeEach(async () => {
		codexDir = mkdtempSync(join(tmpdir(), "pier-codex-"));
		t = await startTestHost({
			agents: {
				claudeCode: false,
				codex: {
					executable: process.execPath,
					args: [FAKE_SERVER],
					env: { ...process.env, FAKE_CODEX_DIR: codexDir },
				},
			},
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
		rmSync(codexDir, { recursive: true, force: true });
	});

	function runtime(): CodexRuntime {
		return t.host.pool.runtime("codex") as CodexRuntime;
	}

	it("changes Fast mode through slash commands without a model turn and persists it across reopen", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const errors: string[] = [];
		const controller = new ChatController(client, session, {
			onChange() {},
			onReplaced() {},
			onSettled() {},
			onError: (message) => errors.push(message),
		});
		await controller.start();
		const list = await controller.loadCommands();
		expect(controller.chat.fastMode).toBe(false);
		const notices: string[] = [];
		const actions: SlashActions = {
			newSession: () => false,
			fork: () => false,
			notify: (_level, message) => notices.push(message),
		};
		const command = resolveSlash("/fast", list.commands, list.known, "codex");
		expect(command).toEqual({ kind: "builtin", name: "fast", args: "" });
		expect(await runBuiltin(controller, "fast", "", actions)).toEqual({ kind: "done" });
		expect(controller.chat.fastMode).toBe(true);
		expect(controller.chat.thinkingLevel).toBe("medium");
		expect(controller.chat.messages).toEqual([]);
		expect(await runtime().server().request("fake/lastTurn", { threadId: session.id })).toBeNull();
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(applySnapshot(initialChatState(session.id), snapshot).fastMode).toBe(true);
		await controller.dispose();
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "hello" });
		await rec.waitForType("agent_settled");
		expect(await runtime().server().request("fake/lastTurn", { threadId: session.id })).toMatchObject({
			serviceTier: "priority",
			effort: "medium",
		});
		const { points } = await client.request("session.forkPoints", { sessionId: session.id });
		const forked = await client.request("session.fork", {
			sessionId: session.id,
			entryId: points[0]?.entryId ?? "",
			position: "at",
		});
		expect((await client.request("session.snapshot", { sessionId: forked.session.id })).fastMode).toBe(true);
		await client.request("fast.set", { sessionId: session.id, enabled: false });
		await expect.poll(() => state().fastMode).toBe(false);
		const from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "standard speed" });
		await rec.waitForType("agent_settled", from);
		expect(await runtime().server().request("fake/lastTurn", { threadId: session.id })).toMatchObject({
			serviceTier: null,
		});
		await client.request("fast.set", { sessionId: session.id, enabled: true });
		await client.request("session.close", { sessionId: session.id });
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		expect((await client.request("session.snapshot", { sessionId: session.id })).fastMode).toBe(true);
		expect(errors).toEqual([]);
		expect(notices).toEqual(["Fast 模式已开启"]);
		await client.request("fast.set", { sessionId: session.id, enabled: false });
		await client.request("session.close", { sessionId: session.id });
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		expect((await client.request("session.snapshot", { sessionId: session.id })).fastMode).toBe(false);
	});

	it("applies Fast changes to the next queued turn and preserves state when Codex rejects the change", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "wait here" });
		await rec.waitForType("agent_start");
		await client.request("session.followUp", { sessionId: session.id, text: "next at Fast" });
		expect(await client.request("fast.set", { sessionId: session.id })).toEqual({ enabled: true });
		expect(
			await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id }),
		).not.toHaveProperty("serviceTier", "priority");
		await runtime().server().request("fake/rejectSettings", { threadId: session.id });
		await expect(client.request("fast.set", { sessionId: session.id, enabled: false })).rejects.toThrow(
			"Fast mode unavailable",
		);
		expect((await client.request("session.snapshot", { sessionId: session.id })).fastMode).toBe(true);
		await client.request("session.steer", { sessionId: session.id, text: "continue" });
		await rec.waitFor(
			(frame) =>
				frame.event.type === "message_end" && JSON.stringify(frame.event.message).includes("Reply to next at Fast"),
		);
		await expect.poll(() => state().runState).toBe("idle");
		expect(await runtime().server().request("fake/lastTurn", { threadId: session.id })).toMatchObject({
			serviceTier: "priority",
		});
		expect(await client.request("fast.set", { sessionId: session.id })).toEqual({ enabled: false });
	});

	it("rejects Fast mode for other runtimes", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		await expect(client.request("fast.set", { sessionId: session.id })).rejects.toMatchObject({ code: "UNSUPPORTED" });
	});

	it("serializes Fast toggles from multiple clients", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		expect(
			await Promise.all([
				client.request("fast.set", { sessionId: session.id }),
				client.request("fast.set", { sessionId: session.id }),
			]),
		).toEqual([{ enabled: true }, { enabled: false }]);
		expect((await client.request("session.snapshot", { sessionId: session.id })).fastMode).toBe(false);
	});

	async function open(session: SessionSummary) {
		let state: ChatState = initialChatState(session.id, session);
		const rec = new Recorder();
		await client.subscribe(
			session.id,
			(frame) => {
				state = reduceChat(state, frame);
				rec.handler(frame);
			},
			{ workspaceId: workspace.id },
		);
		await rec.waitForType("session.snapshot");
		return { rec, state: () => state };
	}

	it("reports the context window returned with token usage", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "hello" });
		await rec.waitForType("agent_settled");
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(snapshot.contextInfo).toMatchObject({ autoCompaction: "runtime", contextWindow: 100_000 });
	});

	it("preserves Ultra in the model catalog and sends it as the native turn effort", async () => {
		const models = await client.request("model.list", { workspaceId: workspace.id, runtime: "codex" });
		expect(models.models.find((m) => m.id === "gpt-test")?.thinkingLevels).toEqual([
			"low",
			"medium",
			"high",
			"max",
			"ultra",
		]);
		expect(models.models.find((m) => m.id === "gpt-mini")?.thinkingLevels).not.toContain("ultra");
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec } = await open(session);
		expect(await client.request("thinking.set", { sessionId: session.id, level: "ultra" })).toEqual({ level: "ultra" });
		await client.request("session.prompt", { sessionId: session.id, text: "hello at Ultra" });
		await rec.waitForType("agent_settled");
		const last = await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id });
		expect(last).toMatchObject({ effort: "ultra" });
		expect((await client.request("session.snapshot", { sessionId: session.id })).thinkingLevel).toBe("ultra");
		await client.request("model.set", { sessionId: session.id, provider: "codex", modelId: "gpt-mini" });
		expect(await client.request("thinking.set", { sessionId: session.id, level: "ultra" })).toEqual({ level: "low" });
	});

	it("routes native slash commands to session operations and clears into another Codex session", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const controller = new ChatController(client, session, {
			onChange() {},
			onReplaced() {},
			onSettled() {},
			onError(message) {
				throw new Error(message);
			},
		});
		await controller.start();
		const list = await controller.loadCommands();
		let created = session;
		const actions: SlashActions = {
			newSession: async () => {
				created = (
					await client.request("session.create", {
						workspaceId: workspace.id,
						runtime: controller.chat.session?.runtime,
					})
				).session;
				return true;
			},
			fork: () => false,
			notify() {},
		};
		for (const text of ["/rename Codex native", "/reasoning high", "/clear"]) {
			const command = resolveSlash(text, list.commands, list.known);
			expect(command.kind).toBe("builtin");
			if (command.kind !== "builtin") throw new Error("Expected a native command");
			expect(await runBuiltin(controller, command.name, command.args, actions)).toEqual({ kind: "done" });
		}
		expect(created.id).not.toBe(session.id);
		expect(created.runtime).toBe("codex");
		const previous = await client.request("session.snapshot", { sessionId: session.id });
		expect(previous.session.name).toBe("Codex native");
		expect(previous.thinkingLevel).toBe("high");
		expect(previous.messages).toEqual([]);
		await controller.dispose();
	});

	it("keeps existing sessions usable across an installation and switches servers after they close", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const before = runtime().server();
		const { rec } = await open(session);
		runtime().installationChanged();
		expect(runtime().server()).toBe(before);
		await client.request("session.prompt", { sessionId: session.id, text: "hello" });
		await rec.waitForType("agent_settled");
		expect(rec.text()).toBe("Reply to hello");
		await client.request("session.close", { sessionId: session.id });
		expect(runtime().server()).not.toBe(before);
	});

	it("runs a turn with an approval and stores the thread", async () => {
		const { runtimes } = await client.request("runtime.list", {});
		expect(runtimes.find((r) => r.id === "codex")).toMatchObject({ available: true, name: "Codex" });
		const models = await client.request("model.list", { workspaceId: workspace.id, runtime: "codex" });
		expect(models.models.map((m) => m.id)).toEqual(["gpt-test", "gpt-mini"]);
		expect(models).toMatchObject({ current: { id: "gpt-test" }, thinkingLevel: "medium" });

		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		expect(session.runtime).toBe("codex");
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "please run it" });
		const request = await rec.waitForType("ui.request");
		expect(request.event.request).toMatchObject({
			kind: "approval",
			approval: { toolName: "bash", summary: "npm install" },
		});
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (request.event.request as { id: string }).id,
			response: { decision: "allow_once" },
		});
		await rec.waitForType("agent_settled");
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle");
		expect(rec.text()).toBe("Reply to please run it");

		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(state().messages).toEqual(snapshot.messages);
		const items = buildTranscript(state());
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "assistant"]);
		expect(items[1]?.kind === "assistant" && items[1].blocks[0]).toMatchObject({
			kind: "tool",
			status: "done",
			call: { name: "bash", arguments: { command: "npm install" } },
			result: { content: [{ type: "text", text: "hi\n" }] },
		});
		expect(items[2]?.kind === "assistant" && items[2].blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
		const last = await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id });
		expect(last).toMatchObject({ approvalPolicy: "on-request", effort: "medium", cwd: workspace.path });

		await client.request("session.close", { sessionId: session.id });
		const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
		expect(sessions.find((s) => s.id === session.id)).toMatchObject({
			runtime: "codex",
			active: false,
			firstMessage: "please run it",
		});
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		const reopened = await client.request("session.snapshot", { sessionId: session.id });
		expect(reopened.messages.map((m) => (m as { role: string }).role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);

		// Deleting archives the thread in Codex.
		await client.request("session.close", { sessionId: session.id });
		expect(await client.request("session.delete", { workspaceId: workspace.id, sessionId: session.id })).toEqual({
			deleted: true,
		});
		const after = await client.request("session.list", { workspaceId: workspace.id });
		expect(after.sessions.some((s) => s.id === session.id)).toBe(false);
	});

	it("declines commands the user denies and follows the workspace policy", async () => {
		await client.request("workspace.setPolicy", { workspaceId: workspace.id, policy: "ask" });
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "run" });
		const request = await rec.waitForType("ui.request");
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (request.event.request as { id: string }).id,
			response: { decision: "deny" },
		});
		await rec.waitForType("agent_settled");
		const tool = buildTranscript(state())[1];
		expect(tool?.kind === "assistant" && tool.blocks[0]).toMatchObject({ kind: "tool", status: "error" });
		const last = await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id });
		expect(last).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite" } });
	});

	it("steers, queues follow-ups, switches models, renames and forks", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		expect(
			await client.request("model.set", { sessionId: session.id, provider: "codex", modelId: "gpt-mini" }),
		).toMatchObject({ model: { id: "gpt-mini", thinkingLevels: ["low"] } });
		expect(await client.request("thinking.set", { sessionId: session.id, level: "high" })).toEqual({ level: "low" });

		await client.request("session.prompt", { sessionId: session.id, text: "wait here" });
		await rec.waitForType("agent_start");
		await expect.poll(() => state().runState).toBe("streaming");
		await client.request("session.followUp", { sessionId: session.id, text: "later" });
		await expect
			.poll(async () => (await client.request("session.snapshot", { sessionId: session.id })).queue.followUp)
			.toEqual(["later"]);
		await client.request("session.steer", { sessionId: session.id, text: "now" });
		await rec.waitFor(
			(f) => f.event.type === "message_end" && JSON.stringify(f.event.message).includes("Reply to later"),
		);
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle");
		const users = buildTranscript(state())
			.filter((i) => i.kind === "user")
			.map((i) => (i.kind === "user" ? i.text : ""));
		expect(users).toEqual(["wait here", "now", "later"]);
		expect(rec.text()).toContain("Reply to wait here + 1 steer");
		const last = await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id });
		expect(last).toMatchObject({ model: "gpt-mini", effort: "low" });

		const renamed = await client.request("session.rename", { sessionId: session.id, name: "Codex chat" });
		expect(renamed.session.name).toBe("Codex chat");

		const { points } = await client.request("session.forkPoints", { sessionId: session.id });
		expect(points.map((p) => p.text)).toEqual(["wait here", "later"]);
		const forked = await client.request("session.fork", { sessionId: session.id, entryId: points[1]?.entryId ?? "" });
		expect(forked.selectedText).toBe("later");
		const snapshot = await client.request("session.snapshot", { sessionId: forked.session.id });
		expect(snapshot.messages.filter((m) => (m as { role: string }).role === "user")).toHaveLength(2);

		const compacted = await client.request("session.compact", { sessionId: session.id });
		expect(compacted).toEqual({ summary: "", tokensBefore: 0 });
	});

	it("keeps activity visible after commentary completes, including a fresh snapshot", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "progress then wait" });
		await rec.waitFor(
			(frame) =>
				frame.event.type === "message_update" &&
				(frame.event.assistantMessageEvent as { type: string }).type === "text_end",
		);
		expect(state().runState).toBe("streaming");
		expect(state().streaming?.content[0]).toMatchObject({ text: "Progress reported.", completed: true });
		expect(isWaitingForModel(state(), buildTranscript(state()))).toBe(true);
		expect(waitingForModelLabel(state())).toBe("思考中…");
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		const restored = applySnapshot(initialChatState(session.id), snapshot);
		expect(isWaitingForModel(restored, buildTranscript(restored))).toBe(true);
		await client.request("session.abort", { sessionId: session.id });
		await rec.waitFor((frame) => frame.event.type === "session.status" && frame.event.state === "idle");
		expect(isWaitingForModel(state(), buildTranscript(state()))).toBe(false);
	});

	it("follows sub-agent threads: card, live conversation, approvals, stop and history", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "delegate reading" });
		await rec.waitForType("agent_settled");
		await expect.poll(() => subagentList(state())[0]?.description).toBe("Volta");
		const [subagent] = subagentList(state());
		expect(subagent).toMatchObject({
			name: "reader",
			model: "gpt-test",
			thinkingLevel: "low",
			status: "completed",
			steps: 1,
			tokens: 42,
			result: "a.txt says hello",
			stoppable: false,
			transcript: true,
		});
		if (!subagent?.toolCallId) throw new Error("missing subagent");
		const items = buildTranscript(state());
		const blocks = items.flatMap((item) => (item.kind === "assistant" ? item.blocks : []));
		const spawn = blocks.find((b) => b.kind === "tool" && b.call.name === "spawn_agent");
		expect(spawn).toMatchObject({ call: { id: subagent.toolCallId }, subagents: [{ id: subagent.id }] });
		expect(blocks.some((b) => b.kind === "tool" && b.call.name === "wait_agent")).toBe(true);
		const transcript = await client.request("session.subagentTranscript", {
			sessionId: session.id,
			subagentId: subagent.id,
		});
		expect(transcript.total).toBe(3);
		expect(transcript.messages).toMatchObject([
			{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "cat a.txt" } }] },
			{ role: "toolResult", content: [{ type: "text", text: "hello\n" }] },
			{ role: "assistant", content: [{ type: "text", text: "a.txt says hello" }] },
		]);
		const later = await client.request("session.subagentTranscript", {
			sessionId: session.id,
			subagentId: subagent.id,
			from: 2,
		});
		expect(later).toMatchObject({ from: 2, total: 3, messages: [{ role: "assistant" }] });

		// A sub-agent that asks for approval reaches the session that started it.
		await client.request("workspace.setPolicy", { workspaceId: workspace.id, policy: "ask" });
		let from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "delegate-approve" });
		const asked = await rec.waitForType("ui.request", from);
		const request = asked.event.request as { id: string; approval?: { reason?: string } };
		expect(request.approval?.reason).toContain("[reader]");
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: request.id,
			response: { decision: "allow_once" },
		});
		await rec.waitForType("agent_settled", from);
		expect(await runtime().server().request("fake/childApproval", {})).toBe("accept");

		// Stopping a running sub-agent interrupts its turn.
		from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "delegate-hold" });
		await expect.poll(() => subagentList(state()).find((s) => s.status === "running" && s.stoppable)?.id).toBeDefined();
		const running = subagentList(state()).find((s) => s.status === "running");
		expect(await client.request("session.subagentStop", { sessionId: session.id })).toEqual({ stopped: 1 });
		await rec.waitForType("agent_settled", from);
		expect(state().subagents[running?.id ?? ""]).toMatchObject({ status: "stopped", stoppable: false });
		await expect(
			client.request("session.subagentStop", { sessionId: session.id, subagentId: "missing" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Reopened, the sub-agents come from the stored turns and their own threads.
		await client.request("session.close", { sessionId: session.id });
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(snapshot.subagents?.map((s) => s.status)).toEqual(["completed", "completed", "stopped"]);
		expect(snapshot.subagents?.[0]).toMatchObject({ name: "reader", toolCallId: subagent.toolCallId });
		const stored = await client.request("session.subagentTranscript", {
			sessionId: session.id,
			subagentId: subagent.id,
		});
		expect(stored.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ text: "a.txt says hello" }] });
		const sessions = (await client.request("session.list", { workspaceId: workspace.id })).sessions;
		expect(sessions.filter((s) => s.runtime === "codex").map((s) => s.id)).toEqual([session.id]);
	});

	it("aborts a running turn", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "wait forever" });
		await rec.waitForType("agent_start");
		await expect.poll(() => runtime().server().request("fake/lastTurn", { threadId: session.id })).not.toBeNull();
		await client.request("session.abort", { sessionId: session.id });
		await rec.waitForType("agent_settled");
		await rec.waitFor((frame) => frame.event.type === "session.status" && frame.event.state === "idle");
		expect(state().runState).toBe("idle");
		expect(state().errorMessage).toBeUndefined();
	});
});
