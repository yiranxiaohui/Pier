import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { PierClient } from "@pier/client";
import type { WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenCodeRuntime } from "../src/opencode/opencode-runtime.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

let host: TestHost;
let client: PierClient;
let workspace: WorkspaceInfo;
let controller: ReadableStreamDefaultController<Uint8Array>;
let reply: string | undefined;
let aborts: number;
let rules: unknown[];
let prompt: Record<string, unknown>;
let configDir: string;
/** Input tokens of the reply in `reply` mode; `approval` asks for a bash command instead. */
let flow: { mode: "approval" } | { mode: "reply"; input: number };
let summaries: Array<Record<string, unknown>>;
let replies = 0;
const id = "ses_pier";
function event(type: string, properties: unknown) {
	controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
}

beforeEach(async () => {
	configDir = mkdtempSync(join(tmpdir(), "pier-opencode-config-"));
	host = await startTestHost({
		agents: { opencode: { executable: process.execPath } },
		agentConfigDirs: { opencode: configDir },
	});
	client = await host.connect();
	workspace = (await client.request("workspace.add", { path: host.workspaceDir, policy: "ask" })).workspace;
	const session = { id, directory: workspace.path, title: "OpenCode test", time: { created: 1, updated: 2 } };
	reply = undefined;
	aborts = 0;
	rules = [];
	flow = { mode: "approval" };
	summaries = [];
	const sdk = createOpencodeClient({
		baseUrl: "http://opencode.test",
		fetch: async (input) => {
			const request = input instanceof Request ? input : new Request(input);
			const path = new URL(request.url).pathname;
			if (path === "/event") {
				return new Response(
					new ReadableStream({
						start(c) {
							controller = c;
							event("server.connected", {});
						},
					}),
				);
			}
			if (path === "/session" && request.method === "GET")
				return Response.json([
					session,
					{ ...session, id: "ses_other", directory: join(workspace.path, "other") },
					{ ...session, id: "ses_child", parentID: id },
				]);
			if (path === "/session" || (path === `/session/${id}` && request.method === "GET"))
				return Response.json({ ...session, permission: rules });
			if (path === `/session/${id}` && request.method === "PATCH") {
				rules = (await request.json()).permission;
				return Response.json(session);
			}
			if (path === "/agent")
				return Response.json([
					{ name: "build", permission: [{ permission: "read", pattern: ".env", action: "deny" }] },
				]);
			if (path === "/config") return Response.json({});
			if (path === `/session/${id}/summarize`) {
				summaries.push(await request.json());
				return Response.json(true);
			}
			if (path === `/session/${id}/prompt_async` && flow.mode === "reply") {
				prompt = await request.json();
				const messageID = `msg_${++replies}`;
				const time = Date.now();
				event("message.part.updated", {
					part: {
						id: `prt_${replies}`,
						sessionID: id,
						messageID,
						type: "text",
						text: "done",
						time: { start: time, end: time },
					},
				});
				event("message.updated", {
					info: {
						id: messageID,
						sessionID: id,
						role: "assistant",
						time: { created: time, completed: time },
						parentID: "msg_user",
						providerID: "prov",
						modelID: "model-a",
						mode: "build",
						agent: "build",
						path: { cwd: workspace.path, root: workspace.path },
						cost: 0,
						tokens: { input: flow.input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
					},
				});
				event("session.idle", { sessionID: id });
				return new Response(null, { status: 204 });
			}
			if (path === `/session/${id}/prompt_async`) {
				prompt = await request.json();
				event("permission.asked", {
					id: "req1",
					sessionID: id,
					permission: "bash",
					metadata: { command: "pwd" },
					patterns: ["pwd"],
				});
				return new Response(null, { status: 204 });
			}
			if (path === "/permission/req1/reply") {
				reply = (await request.json()).reply;
				event("session.idle", { sessionID: id });
				return Response.json(true);
			}
			if (path === `/session/${id}/abort`) {
				aborts++;
				return Response.json(true);
			}
			throw new Error(`Unexpected OpenCode request: ${request.method} ${path}`);
		},
	});
	const runtime = host.host.pool.runtime("opencode") as OpenCodeRuntime;
	vi.spyOn(runtime.server, "client").mockResolvedValue(sdk);
});
afterEach(async () => {
	await host.close();
	rmSync(configDir, { recursive: true, force: true });
});

it("discovers OpenCode and isolates sessions by their native workspace directory", async () => {
	const { runtimes } = await client.request("runtime.list", {});
	expect(runtimes.find((r) => r.id === "opencode")).toMatchObject({ name: "OpenCode", available: true });
	const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
	expect(sessions.map((s) => s.id)).toEqual([id]);
	await expect(
		client.request("session.open", { workspaceId: workspace.id, sessionId: "ses_other" }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it.each(["deny", "abort"])("handles %s while OpenCode waits for approval", async (action) => {
	const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "opencode" });
	const rec = new Recorder();
	await client.subscribe(session.id, rec.handler);
	await client.request("session.prompt", {
		sessionId: id,
		text: "Check directory",
		images: [{ type: "image", mimeType: "image/png", data: "YWJj" }],
	});
	const frame = await rec.waitForType("ui.request");
	expect(frame.event.request).toMatchObject({ kind: "approval", approval: { toolName: "bash" } });
	expect(rules).toContainEqual({ permission: "read", pattern: ".env", action: "deny" });
	expect(prompt.parts).toContainEqual({ type: "file", mime: "image/png", url: "data:image/png;base64,YWJj" });
	await expect(client.request("session.prompt", { sessionId: id, text: "busy" })).rejects.toMatchObject({
		code: "CONFLICT",
	});
	if (action === "abort") {
		await client.request("session.abort", { sessionId: id });
		expect(aborts).toBe(1);
		expect(reply).toBeUndefined();
	} else {
		await client.request("ui.respond", {
			sessionId: id,
			requestId: (frame.event.request as { id: string }).id,
			response: { decision: "deny" },
		});
		await rec.waitForType("agent_settled");
		expect(reply).toBe("reject");
	}
	expect(rules).toEqual([]);
	expect((await client.request("session.snapshot", { sessionId: id })).session.state).toBe("idle");
});

it("restarts the OpenCode server after its configuration changes, once no turn runs", async () => {
	const runtime = host.host.pool.runtime("opencode") as OpenCodeRuntime;
	const restart = vi.spyOn(runtime.server, "restart").mockResolvedValue();
	const change = (model: string) =>
		client.request("agentConfig.update", {
			runtime: "opencode",
			scope: "user",
			changes: [{ path: ["model"], value: model }],
		});
	const get = await client.request("agentConfig.get", { runtime: "opencode" });
	expect(get).toMatchObject({ format: "jsonc", configDir, available: true });

	await change("a/one");
	expect(restart).toHaveBeenCalledTimes(1);

	const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "opencode" });
	const rec = new Recorder();
	await client.subscribe(session.id, rec.handler);
	await client.request("session.prompt", { sessionId: id, text: "Check directory" });
	const frame = await rec.waitForType("ui.request");
	await change("a/two");
	expect(restart).toHaveBeenCalledTimes(1);
	await client.request("ui.respond", {
		sessionId: id,
		requestId: (frame.event.request as { id: string }).id,
		response: { decision: "deny" },
	});
	await rec.waitForType("agent_settled");
	await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2));
});

it("compacts with OpenCode's summary once a turn ends past the context limit (1.64)", async () => {
	const { runtimes } = await client.request("runtime.list", {});
	expect(runtimes.find((r) => r.id === "opencode")?.capabilities).toMatchObject({
		compact: true,
		contextLimit: { min: 64_000, enforcement: "turn" },
	});
	const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "opencode" });
	const rec = new Recorder();
	await client.subscribe(session.id, rec.handler);
	const { contextInfo } = await client.request("contextLimit.set", { sessionId: id, limit: 64_000 });
	expect(contextInfo).toEqual({ autoCompaction: "configured", contextLimit: 64_000, compactionThreshold: 64_000 });

	// Below the limit: nothing happens.
	flow = { mode: "reply", input: 30_000 };
	await client.request("session.prompt", { sessionId: id, text: "small" });
	await rec.waitForType("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(summaries).toEqual([]);

	// Past it: OpenCode summarizes with the reply's model and does not continue on its own.
	flow = { mode: "reply", input: 70_000 };
	let from = rec.mark();
	await client.request("session.prompt", { sessionId: id, text: "large" });
	const end = await rec.waitForType("compaction_end", from);
	expect(end.event).toMatchObject({ reason: "threshold", aborted: false, result: { tokensBefore: 70_100 } });
	expect(summaries).toEqual([{ providerID: "prov", modelID: "model-a", auto: false }]);
	await vi.waitFor(async () =>
		expect((await client.request("session.snapshot", { sessionId: id })).session.state).toBe("idle"),
	);
	const snapshot = await client.request("session.snapshot", { sessionId: id });
	expect(snapshot.messages.at(-1)).toMatchObject({ role: "compactionSummary", tokensBefore: 70_100 });

	// Manual compaction works too, also without a limit.
	await client.request("contextLimit.set", { sessionId: id, limit: null });
	from = rec.mark();
	expect(await client.request("session.compact", { sessionId: id })).toEqual({ summary: "", tokensBefore: 0 });
	expect(rec.frames.slice(from).find((f) => f.event.type === "compaction_start")?.event).toMatchObject({
		reason: "manual",
	});
	expect(summaries).toHaveLength(2);

	// Lowering the limit below the current context compacts at once.
	from = rec.mark();
	await client.request("session.prompt", { sessionId: id, text: "large again" });
	await rec.waitForType("agent_settled", from);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(summaries).toHaveLength(2);
	from = rec.mark();
	await client.request("contextLimit.set", { sessionId: id, limit: 64_000 });
	await rec.waitForType("compaction_end", from);
	expect(summaries).toHaveLength(3);
});

it("shows OpenCode's stored compactions as compaction markers", async () => {
	const { OpenCodeTranscript } = await import("../src/opencode/transcript.ts");
	const { LiveTranscript } = await import("../src/runtimes/live-transcript.ts");
	const transcript = new LiveTranscript(
		() => {},
		() => ({ provider: "opencode" }),
	);
	const base = { sessionID: id, time: { created: 5 } };
	const assistant = {
		...base,
		role: "assistant",
		parentID: "u2",
		providerID: "p",
		modelID: "m",
		mode: "compaction",
		agent: "compaction",
		path: { cwd: "/", root: "/" },
		cost: 0,
		tokens: { input: 9000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
	};
	new OpenCodeTranscript(transcript).history([
		{
			info: { ...base, id: "u1", role: "user", agent: "build", model: { providerID: "p", modelID: "m" } },
			parts: [{ id: "t1", sessionID: id, messageID: "u1", type: "text", text: "hello" }],
		},
		{
			info: { ...base, id: "u2", role: "user", agent: "build", model: { providerID: "p", modelID: "m" } },
			parts: [{ id: "c1", sessionID: id, messageID: "u2", type: "compaction", auto: true }],
		},
		{
			info: { ...assistant, id: "a1", summary: true, time: { created: 6, completed: 7 } },
			parts: [{ id: "t2", sessionID: id, messageID: "a1", type: "text", text: "## Summary" }],
		},
	] as never);
	expect(transcript.messages.map((m) => m.role)).toEqual(["user", "compactionSummary"]);
	expect(transcript.messages[1]).toMatchObject({ summary: "## Summary", timestamp: 6 });
});
