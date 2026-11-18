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
const id = "ses_pier";
function event(type: string, properties: unknown) {
	controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
}

beforeEach(async () => {
	host = await startTestHost({ agents: { opencode: { executable: process.execPath } } });
	client = await host.connect();
	workspace = (await client.request("workspace.add", { path: host.workspaceDir, policy: "ask" })).workspace;
	const session = { id, directory: workspace.path, title: "OpenCode test", time: { created: 1, updated: 2 } };
	reply = undefined;
	aborts = 0;
	rules = [];
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
