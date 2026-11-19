import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PierClient } from "@pier/client";
import type { SessionSnapshot, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiManagedSession } from "../src/pi/pi-session.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

describe("context limits of pi sessions (1.64)", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost();
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir, policy: "auto" })).workspace;
	});
	afterEach(() => t.close());

	async function newSession(): Promise<{ session: SessionSummary; rec: Recorder }> {
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		return { session, rec };
	}

	function piSession(id: string): PiManagedSession {
		return t.host.pool.require(id) as PiManagedSession;
	}

	it("advertises the capability and limits the window pi compacts against", async () => {
		const { runtimes } = await client.request("runtime.list", {});
		expect(runtimes.find((r) => r.id === "pi")?.capabilities.contextLimit).toEqual({
			min: 64_000,
			enforcement: "request",
		});
		const { session, rec } = await newSession();
		const from = rec.mark();
		const { contextInfo } = await client.request("contextLimit.set", { sessionId: session.id, limit: 100_000 });
		expect(contextInfo).toEqual({
			autoCompaction: "configured",
			contextWindow: 128_000,
			contextLimit: 100_000,
			compactionThreshold: 100_000 - 16_384,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		});
		const event = await rec.waitForType("session.model", from);
		expect(event.event.contextInfo).toEqual(contextInfo);
		// pi itself sees the limit as the model's window; clients still get the real model.
		expect(piSession(session.id).session.model?.contextWindow).toBe(100_000);
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(snapshot.model?.contextWindow).toBe(128_000);
		expect(snapshot.contextInfo?.contextLimit).toBe(100_000);

		// Switching models keeps the limit; a model with a smaller window keeps its own.
		await client.request("model.set", { sessionId: session.id, provider: "faux", modelId: "faux-2" });
		expect(piSession(session.id).session.model?.id).toBe("faux-2");
		expect((await client.request("session.snapshot", { sessionId: session.id })).contextInfo?.contextLimit).toBe(
			100_000,
		);

		await client.request("contextLimit.set", { sessionId: session.id, limit: null });
		await client.request("model.set", { sessionId: session.id, provider: "faux", modelId: "faux-1" });
		expect(piSession(session.id).session.model?.contextWindow).toBe(128_000);
		const cleared = await client.request("session.snapshot", { sessionId: session.id });
		expect(cleared.contextInfo).not.toHaveProperty("contextLimit");
		expect(cleared.contextInfo?.compactionThreshold).toBe(128_000 - 16_384);
	});

	it("rejects limits below the runtime's minimum", async () => {
		const { session } = await newSession();
		await expect(client.request("contextLimit.set", { sessionId: session.id, limit: 10_000 })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect((await client.request("session.snapshot", { sessionId: session.id })).contextInfo).not.toHaveProperty(
			"contextLimit",
		);
	});

	it("keeps a session's limit when it is reopened and applies a runtime default to new sessions", async () => {
		t.faux.setResponses([fauxAssistantMessage("ok")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "hi" });
		await rec.waitForType("agent_settled");
		const result = await client.request("contextLimit.set", {
			sessionId: session.id,
			limit: 96_000,
			asDefault: true,
		});
		expect(result.defaultLimit).toBe(96_000);
		const stored = JSON.parse(readFileSync(join(t.root, "pier", "context-limits.json"), "utf8"));
		expect(stored).toEqual({ version: 1, defaults: { pi: 96_000 }, sessions: { [`pi:${session.id}`]: 96_000 } });
		const { runtimes } = await client.request("runtime.list", {});
		expect(runtimes.find((r) => r.id === "pi")?.contextLimitDefault).toBe(96_000);

		await client.request("session.close", { sessionId: session.id });
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		expect((await client.request("session.snapshot", { sessionId: session.id })).contextInfo?.contextLimit).toBe(
			96_000,
		);
		expect(piSession(session.id).session.model?.contextWindow).toBe(96_000);

		const { session: fresh } = await newSession();
		expect((await client.request("session.snapshot", { sessionId: fresh.id })).contextInfo?.contextLimit).toBe(96_000);
		// A session can still follow the model, and clearing the default leaves existing sessions alone.
		await client.request("contextLimit.set", { sessionId: fresh.id, limit: null, asDefault: true });
		const after = (await client.request("runtime.list", {})).runtimes.find((r) => r.id === "pi");
		expect(after).not.toHaveProperty("contextLimitDefault");
		expect((await client.request("session.snapshot", { sessionId: session.id })).contextInfo?.contextLimit).toBe(
			96_000,
		);

		await client.request("session.delete", { workspaceId: workspace.id, sessionId: session.id, force: true });
		const pruned = JSON.parse(readFileSync(join(t.root, "pier", "context-limits.json"), "utf8"));
		expect(pruned.sessions).toEqual({});
	});

	it("compacts once the context passes the limit, below the model's window", async () => {
		// The faux model counts four characters as a token: two turns of about 30k tokens each.
		const big = (label: string) => `${label} ${"lorem ipsum ".repeat(10_000)}`;
		const run = async (limit: number | null) => {
			const { session, rec } = await newSession();
			if (limit) await client.request("contextLimit.set", { sessionId: session.id, limit });
			t.faux.setResponses([
				fauxAssistantMessage("first"),
				fauxAssistantMessage("second"),
				fauxAssistantMessage("## Goal\nSummary of the conversation"),
			]);
			for (const text of [big("one"), big("two")]) {
				const from = rec.mark();
				await client.request("session.prompt", { sessionId: session.id, text });
				await rec.waitForType("agent_settled", from);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { rec, snapshot: await client.request("session.snapshot", { sessionId: session.id }) };
		};

		const unlimited = await run(null);
		expect(unlimited.rec.types()).not.toContain("compaction_start");

		const limited = await run(64_000);
		const end = limited.rec.frames.find((f) => f.event.type === "compaction_end");
		expect(end?.event).toMatchObject({ reason: "threshold", aborted: false });
		const roles = (limited.snapshot as SessionSnapshot).messages.map((m) => (m as { role: string }).role);
		expect(roles).toContain("compactionSummary");
	});
});
