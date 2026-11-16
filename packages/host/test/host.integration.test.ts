import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { PierClient } from "@pier/client";
import {
	PierProtocolError,
	PROTOCOL_VERSION,
	type SessionSnapshot,
	type SessionSummary,
	type UiRequest,
	type WorkspaceInfo,
} from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { PIER_HOST_VERSION } from "../src/host.ts";
import {
	deferred,
	fauxAssistantMessage,
	fauxToolCall,
	lastToolResultText,
	Recorder,
	startTestHost,
	type TestHost,
	TOKEN,
} from "./helpers.ts";

const posixShell = process.platform !== "win32";

async function rawRequest(url: string, frames: unknown[], origin?: string): Promise<unknown[]> {
	const socket = new WebSocket(url, origin ? { origin } : {});
	const received: unknown[] = [];
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	return new Promise((resolve) => {
		socket.on("message", (data) => {
			received.push(JSON.parse(data.toString()));
			if (received.length === frames.length) {
				socket.close();
				resolve(received);
			}
		});
		socket.on("close", () => resolve(received));
		for (const frame of frames) socket.send(JSON.stringify(frame));
	});
}

async function expectError(promise: Promise<unknown>, code: string): Promise<PierProtocolError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(PierProtocolError);
		expect((error as PierProtocolError).code).toBe(code);
		return error as PierProtocolError;
	}
	throw new Error(`Expected ${code} error`);
}

describe("authentication and handshake", () => {
	let t: TestHost;
	beforeEach(async () => {
		t = await startTestHost();
	});
	afterEach(() => t.close());

	const hello = (overrides: Record<string, unknown> = {}) => ({
		type: "req",
		id: "h",
		method: "host.hello",
		params: { protocolVersion: PROTOCOL_VERSION, client: { name: "raw", version: "0" }, token: TOKEN, ...overrides },
	});

	it("rejects requests before host.hello", async () => {
		const [res] = await rawRequest(t.url, [{ type: "req", id: "1", method: "workspace.list" }]);
		expect(res).toMatchObject({ id: "1", ok: false, error: { code: "UNAUTHENTICATED" } });
	});

	it("rejects a wrong token and closes the connection", async () => {
		const [res] = await rawRequest(t.url, [hello({ token: "wrong" })]);
		expect(res).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
	});

	it("rejects an incompatible protocol major version", async () => {
		const [res] = await rawRequest(t.url, [hello({ protocolVersion: "2.0" })]);
		expect(res).toMatchObject({
			ok: false,
			error: { code: "PROTOCOL_MISMATCH", data: { hostVersion: PROTOCOL_VERSION } },
		});
	});

	it("rejects malformed frames and unknown methods, and accepts requests pipelined after hello", async () => {
		const responses = (await rawRequest(t.url, [
			hello(),
			{ nope: true },
			{ type: "req", id: "2", method: "x.y" },
			{ type: "req", id: "3", method: "workspace.list" },
		])) as Array<{ id: string }>;
		const byId = (id: string) => responses.find((r) => r.id === id);
		expect(byId("h")).toMatchObject({ ok: true, result: { protocolVersion: PROTOCOL_VERSION } });
		expect(byId("")).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
		expect(byId("2")).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
		expect(byId("3")).toMatchObject({ ok: true, result: { workspaces: [] } });
	});

	it("rejects browser origins other than the desktop app", async () => {
		await expect(rawRequest(t.url, [hello()], "https://evil.example")).rejects.toThrow(/403/);
		const [res] = await rawRequest(t.url, [hello()], "tauri://localhost");
		expect(res).toMatchObject({ ok: true });
	});

	it("reports host info and refuses pairing while remote access is off", async () => {
		const client = await t.connect();
		expect(client.host).toMatchObject({ protocolVersion: PROTOCOL_VERSION, version: PIER_HOST_VERSION });
		expect(await client.request("remote.status")).toMatchObject({ enabled: false, running: false, addresses: [] });
		await expectError(client.request("pairing.start"), "CONFLICT");
		await expectError(client.request("session.prompt", { sessionId: "nope", text: "x" }), "NOT_FOUND");
		await expectError(client.request("workspace.add", { path: "relative/path" }), "BAD_REQUEST");
	});

	it("lists the package managers on the host", async () => {
		const client = await t.connect();
		const { managers } = await client.request("host.packageManagers");
		expect(Array.isArray(managers)).toBe(true);
		for (const manager of managers) {
			expect(["npm", "pnpm", "bun"]).toContain(manager.name);
			expect(manager.path).toMatch(/[\\/]/);
		}
	});
});

describe("sessions end to end", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost();
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	async function newSession(c: PierClient = client): Promise<{ session: SessionSummary; rec: Recorder }> {
		const { session } = await c.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await c.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		return { session, rec };
	}

	it("manages workspaces", async () => {
		expect(workspace).toMatchObject({ policy: "smart", name: "workspace" });
		expect((await client.request("workspace.add", { path: t.workspaceDir })).workspace.id).toBe(workspace.id);
		const updated = await client.request("workspace.setPolicy", { workspaceId: workspace.id, policy: "ask" });
		expect(updated.workspace.policy).toBe("ask");
		expect((await client.request("workspace.list")).workspaces).toHaveLength(1);
		expect(await client.request("workspace.remove", { workspaceId: workspace.id })).toEqual({ removed: true });
		expect((await client.request("workspace.list")).workspaces).toHaveLength(0);
	});

	it("creates a session, streams a prompt, and lists it", async () => {
		t.faux.setResponses([fauxAssistantMessage("Hello from faux!")]);
		const { session, rec } = await newSession();
		expect(rec.frames[0]?.event.type).toBe("session.snapshot");
		const snapshot = rec.frames[0]?.event.snapshot as SessionSnapshot;
		expect(snapshot).toMatchObject({
			seq: 0,
			pendingUi: [],
			model: { provider: "faux", id: "faux-1" },
			contextInfo: {
				autoCompaction: "configured",
				contextWindow: 128_000,
				compactionThreshold: 111_616,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
			},
		});

		const from = rec.mark();
		expect(await client.request("session.prompt", { sessionId: session.id, text: "hi" })).toEqual({ accepted: true });
		await rec.waitForType("agent_settled", from);
		expect(rec.text(from)).toBe("Hello from faux!");
		const types = rec.types(from);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_end");
		expect(types).toContain("session.status");

		// Seqs are contiguous.
		const seqs = rec.frames.slice(from).map((f) => f.seq);
		expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] as number) + i));

		const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ id: session.id, active: true, state: "idle", messageCount: 2 });
		expect(sessions[0]?.firstMessage).toBe("hi");
	});

	it.skipIf(!posixShell)("asks for approval and blocks denied tool calls with the reason", async () => {
		let seenResult = "";
		t.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "touch denied.txt" }), { stopReason: "toolUse" }),
			(context) => {
				seenResult = lastToolResultText(context);
				return fauxAssistantMessage("ok, I will not");
			},
		]);
		const { session, rec } = await newSession();
		const other = await t.connect();
		const otherRec = new Recorder();
		await other.subscribe(session.id, otherRec.handler);

		await client.request("session.prompt", { sessionId: session.id, text: "make a file" });
		const requestFrame = await rec.waitForType("ui.request");
		const request = requestFrame.event.request as UiRequest;
		expect(request).toMatchObject({
			kind: "approval",
			approval: { toolName: "bash", summary: "touch denied.txt", severity: "normal", sessionAllowable: true },
		});
		await otherRec.waitForType("ui.request");

		// The late subscriber's snapshot includes the pending request.
		const late = await t.connect();
		const lateRec = new Recorder();
		await late.subscribe(session.id, lateRec.handler);
		const lateSnapshot = (await lateRec.waitForType("session.snapshot")).event.snapshot as SessionSnapshot;
		expect(lateSnapshot.pendingUi.map((r) => r.id)).toEqual([request.id]);
		expect(lateSnapshot.session.state).toBe("streaming");

		// First answer wins.
		const answer = { sessionId: session.id, requestId: request.id };
		expect(await other.request("ui.respond", { ...answer, response: { decision: "deny", reason: "nope" } })).toEqual({
			accepted: true,
		});
		expect(await client.request("ui.respond", { ...answer, response: { decision: "allow_once" } })).toEqual({
			accepted: false,
		});
		const resolved = await rec.waitForType("ui.resolved");
		expect(resolved.event).toMatchObject({ resolution: "answered", by: other.connectionId });
		await rec.waitForType("agent_settled");
		expect(seenResult).toContain("Denied by the user: nope");
		expect(existsSync(join(t.workspaceDir, "denied.txt"))).toBe(false);
	});

	it.skipIf(!posixShell)("runs approved calls and remembers allow-for-session", async () => {
		t.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "touch one.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "touch two.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "ls" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "make files" });
		const request = (await rec.waitForType("ui.request")).event.request as UiRequest;
		expect(request.approval?.sessionScope).toContain("`touch`");
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: request.id,
			response: { decision: "allow_session" },
		});
		await rec.waitForType("agent_settled");
		expect(existsSync(join(t.workspaceDir, "one.txt"))).toBe(true);
		expect(existsSync(join(t.workspaceDir, "two.txt"))).toBe(true);
		expect(rec.frames.filter((f) => f.event.type === "ui.request")).toHaveLength(1);
	});

	it("treats a no-answer timeout as a denial", async () => {
		await t.close();
		t = await startTestHost({ uiTimeoutMs: 100 });
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir, policy: "ask" })).workspace;
		let seenResult = "";
		t.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "x" }), { stopReason: "toolUse" }),
			(context) => {
				seenResult = lastToolResultText(context);
				return fauxAssistantMessage("fine");
			},
		]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "write" });
		const resolved = await rec.waitForType("ui.resolved");
		expect(resolved.event.resolution).toBe("timeout");
		await rec.waitForType("agent_settled");
		expect(seenResult).toContain("did not approve");
		expect(existsSync(join(t.workspaceDir, "a.txt"))).toBe(false);
	});

	it("rejects a second prompt while streaming and supports follow-up and abort", async () => {
		const gate = deferred<void>();
		t.faux.setResponses([
			async () => {
				await gate.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "one" });
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "streaming");
		await expectError(client.request("session.prompt", { sessionId: session.id, text: "two" }), "CONFLICT");
		const { queue } = await client.request("session.followUp", { sessionId: session.id, text: "two" });
		expect(queue.followUp).toEqual(["two"]);
		await expectError(client.request("session.close", { sessionId: session.id }), "CONFLICT");
		gate.resolve();
		await rec.waitFor(() => rec.text().includes("second"));
		await rec.waitForType("agent_settled");

		t.faux.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					// Like a real provider, stop when the run is aborted.
					options?.signal?.addEventListener("abort", () =>
						resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					);
				}),
		]);
		const from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "three" });
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "streaming", from);
		expect(await client.request("session.abort", { sessionId: session.id })).toEqual({ aborted: true });
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle", from);
	});

	it("resumes with a replay of missed events after a dropped connection", async () => {
		t.faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "one" });
		await rec.waitForType("agent_settled");

		const driver = await t.connect();
		const states: string[] = [];
		client.onState((s) => states.push(s));
		const from = rec.mark();
		client.dropConnection();
		await driver.request("session.prompt", { sessionId: session.id, text: "two" });
		await rec.waitForType("agent_settled", from);

		expect(states).toContain("reconnecting");
		expect(states.at(-1)).toBe("open");
		expect(rec.types(from)).not.toContain("session.snapshot");
		expect(rec.text(from)).toBe("second answer");
		const seqs = rec.frames.filter((f) => f.seq !== undefined).map((f) => f.seq as number);
		expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] as number) + i));
	});

	it("falls back to a snapshot when the missed events left the buffer", async () => {
		await t.close();
		t = await startTestHost({ eventLogCapacity: 5 });
		// Reconnect slowly so the whole run happens while this client is offline.
		client = await t.connect({ reconnect: { initialDelayMs: 300, maxDelayMs: 300 } });
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
		t.faux.setResponses([fauxAssistantMessage("a long enough answer to overflow the tiny buffer")]);
		const { session, rec } = await newSession();
		const driver = await t.connect();
		const driverRec = new Recorder();
		await driver.subscribe(session.id, driverRec.handler);
		const from = rec.mark();
		client.dropConnection();
		await driver.request("session.prompt", { sessionId: session.id, text: "go" });
		await driverRec.waitForType("agent_settled");
		// More than 5 events were missed, so the client resumes from a fresh snapshot.
		const snapshot = (await rec.waitForType("session.snapshot", from)).event.snapshot as SessionSnapshot;
		expect(snapshot.seq).toBeGreaterThan(5);
		expect(snapshot.messages.length).toBeGreaterThanOrEqual(3);
	});

	it("merges streaming deltas for clients that ask for it", async () => {
		await t.close();
		t = await startTestHost({ tokensPerSecond: 400 });
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
		const text = "The quick brown fox jumps over the lazy dog. ".repeat(4);
		t.faux.setResponses([fauxAssistantMessage(text)]);
		const { session, rec } = await newSession();
		const mobile = await t.connect({ coalesceMs: 60 });
		const mobileRec = new Recorder();
		await mobile.subscribe(session.id, mobileRec.handler);
		await mobileRec.waitForType("session.snapshot");

		await client.request("session.prompt", { sessionId: session.id, text: "fox" });
		await rec.waitForType("agent_settled");
		await mobileRec.waitForType("agent_settled");
		const count = (r: Recorder) => r.frames.filter((f) => f.event.type === "message_update").length;
		expect(rec.text()).toBe(text);
		expect(mobileRec.text()).toBe(text);
		expect(count(mobileRec)).toBeLessThan(count(rec) / 2);
	});

	it("renames, switches models and thinking levels, and lists models", async () => {
		const { session, rec } = await newSession();
		const renamed = await client.request("session.rename", { sessionId: session.id, name: "My session" });
		expect(renamed.session.name).toBe("My session");
		const { models, current, thinkingLevel } = await client.request("model.list", { sessionId: session.id });
		expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual(["faux/faux-1", "faux/faux-2"]);
		expect(models.map((m) => m.thinkingLevels)).toEqual([["off", "minimal", "low", "medium", "high"], ["off"]]);
		expect(current?.id).toBe("faux-1");
		expect(thinkingLevel).toBe("medium");
		// What a new session in the workspace would start with.
		await expect(client.request("model.list", { workspaceId: workspace.id })).resolves.toMatchObject({
			current: { provider: "faux", id: "faux-1" },
			thinkingLevel: "medium",
		});
		expect(await client.request("model.list")).not.toHaveProperty("current");
		const { model } = await client.request("model.set", { sessionId: session.id, provider: "faux", modelId: "faux-2" });
		expect(model.name).toBe("Faux Two");
		await rec.waitFor((f) => f.event.type === "session.model");
		await expectError(
			client.request("model.set", { sessionId: session.id, provider: "faux", modelId: "missing" }),
			"NOT_FOUND",
		);
		await client.request("model.set", { sessionId: session.id, provider: "faux", modelId: "faux-1" });
		const { level } = await client.request("thinking.set", { sessionId: session.id, level: "high" });
		expect(level).toBe("high");
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(snapshot).toMatchObject({ thinkingLevel: "high", session: { name: "My session" }, model: { id: "faux-1" } });
		const clamped = await client.request("thinking.set", { sessionId: session.id, level: "ultra" });
		expect(clamped.level).not.toBe("ultra");
		expect(snapshot.model?.thinkingLevels).toContain(clamped.level);
	});

	it("forks a session before a user message", async () => {
		t.faux.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "first question" });
		await rec.waitForType("agent_settled");
		const from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "second question" });
		await rec.waitForType("agent_settled", from);

		const { points } = await client.request("session.forkPoints", { sessionId: session.id });
		expect(points.map((p) => p.text)).toEqual(["first question", "second question"]);
		const forked = await client.request("session.fork", { sessionId: session.id, entryId: points[1]?.entryId ?? "" });
		expect(forked.selectedText).toBe("second question");
		expect(forked.session.id).not.toBe(session.id);
		expect(forked.session.parentSessionPath).toBe(session.path);
		const snapshot = await client.request("session.snapshot", { sessionId: forked.session.id });
		const roles = (snapshot.messages as Array<{ role: string }>).map((m) => m.role).filter((r) => r !== "system");
		expect(roles).toEqual(["user", "assistant"]);
		// The original stays open and unchanged.
		const original = await client.request("session.snapshot", { sessionId: session.id });
		expect((original.messages as Array<{ role: string }>).filter((m) => m.role === "user")).toHaveLength(2);
	});

	it("closes, reopens from the list, and refuses paths outside the workspace", async () => {
		t.faux.setResponses([fauxAssistantMessage("persisted")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "remember" });
		await rec.waitForType("agent_settled");
		expect(await client.request("session.close", { sessionId: session.id })).toEqual({ closed: true });
		await rec.waitForType("session.closed");
		await expectError(client.request("session.snapshot", { sessionId: session.id }), "NOT_FOUND");

		const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
		expect(sessions[0]).toMatchObject({ id: session.id, active: false, state: "inactive" });
		const reopened = await client.request("session.open", { workspaceId: workspace.id, path: sessions[0]?.path ?? "" });
		expect(reopened.session.id).toBe(session.id);
		const again = await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		expect(again.session.id).toBe(session.id);
		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(snapshot.messages.length).toBeGreaterThanOrEqual(3);

		await expectError(client.request("session.open", { workspaceId: workspace.id, path: "/etc/passwd" }), "NOT_FOUND");
	});

	it("deletes sessions into the trash", async () => {
		const trash = join(t.root, "pier", "trash", "sessions");
		t.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "keep me" });
		await rec.waitForType("agent_settled");
		const file = session.path ?? "";
		expect(existsSync(file)).toBe(true);

		// Active session: closed with reason "deleted", file moved to the trash.
		expect(await client.request("session.delete", { workspaceId: workspace.id, sessionId: session.id })).toEqual({
			deleted: true,
		});
		expect((await rec.waitForType("session.closed")).event.reason).toBe("deleted");
		expect(existsSync(file)).toBe(false);
		expect(readdirSync(trash).some((name) => name.endsWith(basename(file)))).toBe(true);
		expect((await client.request("session.list", { workspaceId: workspace.id })).sessions).toEqual([]);
		await expectError(
			client.request("session.open", { workspaceId: workspace.id, sessionId: session.id }),
			"NOT_FOUND",
		);
		expect(await client.request("session.delete", { workspaceId: workspace.id, sessionId: session.id })).toEqual({
			deleted: false,
		});

		// Inactive session from the list.
		const second = await newSession();
		await client.request("session.prompt", { sessionId: second.session.id, text: "again" });
		await second.rec.waitForType("agent_settled");
		await client.request("session.close", { sessionId: second.session.id });
		expect(await client.request("session.delete", { workspaceId: workspace.id, sessionId: second.session.id })).toEqual(
			{ deleted: true },
		);
		expect(existsSync(second.session.path ?? "")).toBe(false);
		expect(readdirSync(trash)).toHaveLength(2);

		// A new session that was never written only needs closing.
		const empty = await newSession();
		expect(await client.request("session.delete", { workspaceId: workspace.id, sessionId: empty.session.id })).toEqual({
			deleted: true,
		});
		expect(t.host.pool.size).toBe(0);

		// Sessions of another workspace are not reachable through this one.
		const otherDir = join(t.root, "other");
		mkdirSync(otherDir);
		const other = (await client.request("workspace.add", { path: otherDir })).workspace;
		const foreign = await client.request("session.create", { workspaceId: other.id });
		await expectError(
			client.request("session.delete", { workspaceId: workspace.id, sessionId: foreign.session.id }),
			"NOT_FOUND",
		);
	});

	it("refuses to delete a running session unless forced", async () => {
		const gate = deferred<void>();
		t.faux.setResponses([
			// Like a real provider, the request stops when the run is aborted: pi 1.5.1 waits for that
			// before it disposes a session.
			async (_context, options) => {
				const aborted = new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				await Promise.race([gate.promise, aborted]);
				return fauxAssistantMessage("late");
			},
		]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "work" });
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "streaming");
		const ref = { workspaceId: workspace.id, sessionId: session.id };
		await expectError(client.request("session.delete", ref), "CONFLICT");
		expect(await client.request("session.delete", { ...ref, force: true })).toEqual({ deleted: true });
		gate.resolve();
		expect(t.host.pool.size).toBe(0);
		expect((await client.request("session.list", { workspaceId: workspace.id })).sessions).toEqual([]);
	});

	it("archives and unarchives sessions", async () => {
		t.faux.setResponses([fauxAssistantMessage("one")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "archive me" });
		await rec.waitForType("agent_settled");
		const ref = { workspaceId: workspace.id, sessionId: session.id };

		// Active session: the live summary carries the flag.
		const archived = await client.request("session.archive", { ...ref, archived: true });
		expect(archived.session).toMatchObject({ id: session.id, archived: true, active: true });
		expect((await client.request("session.snapshot", { sessionId: session.id })).session.archived).toBe(true);

		// Inactive session: listed with the flag, which survives a host restart via the file.
		await client.request("session.close", { sessionId: session.id });
		const listed = (await client.request("session.list", { workspaceId: workspace.id })).sessions;
		expect(listed[0]).toMatchObject({ id: session.id, archived: true, active: false });
		expect(existsSync(join(t.root, "pier", "archived-sessions.json"))).toBe(true);
		const reopened = await client.request("session.open", ref);
		expect(reopened.session.archived).toBe(true);
		await client.request("session.close", { sessionId: session.id });

		const restored = await client.request("session.archive", { ...ref, archived: false });
		expect(restored.session.archived).toBeUndefined();
		expect((await client.request("session.list", { workspaceId: workspace.id })).sessions[0]?.archived).toBeUndefined();

		await expectError(
			client.request("session.archive", { workspaceId: workspace.id, sessionId: "missing", archived: true }),
			"NOT_FOUND",
		);

		// Deleting forgets the archive marker.
		await client.request("session.archive", { ...ref, archived: true });
		await client.request("session.delete", ref);
		expect(t.host.pool.size).toBe(0);
	});

	it("cleans up old or archived sessions, skipping running ones", async () => {
		const gate = deferred<void>();
		t.faux.setResponses([
			fauxAssistantMessage("a"),
			fauxAssistantMessage("b"),
			async () => {
				await gate.promise;
				return fauxAssistantMessage("late");
			},
		]);
		const first = await newSession();
		await client.request("session.prompt", { sessionId: first.session.id, text: "first" });
		await first.rec.waitForType("agent_settled");
		await client.request("session.close", { sessionId: first.session.id });
		const second = await newSession();
		await client.request("session.prompt", { sessionId: second.session.id, text: "second" });
		await second.rec.waitForType("agent_settled");
		await client.request("session.close", { sessionId: second.session.id });
		const running = await newSession();
		await client.request("session.prompt", { sessionId: running.session.id, text: "busy" });
		await running.rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "streaming");
		const ws = { workspaceId: workspace.id };

		// Nothing is older than a time in the past.
		const past = new Date(Date.now() - 24 * 3600_000).toISOString();
		expect(
			await client.request("session.cleanup", { ...ws, action: "delete", modifiedBefore: past, dryRun: true }),
		).toEqual({ sessionIds: [], skipped: [] });

		// Archive everything but the running session... archiving does not skip it.
		const future = new Date(Date.now() + 60_000).toISOString();
		const archived = await client.request("session.cleanup", { ...ws, action: "archive", modifiedBefore: future });
		expect(new Set(archived.sessionIds)).toEqual(new Set([first.session.id, second.session.id, running.session.id]));
		const listed = (await client.request("session.list", ws)).sessions;
		expect(listed.every((s) => s.archived)).toBe(true);
		await client.request("session.archive", { ...ws, sessionId: second.session.id, archived: false });

		// Dry run of deleting archived sessions reports the running one as skipped.
		const preview = await client.request("session.cleanup", {
			...ws,
			action: "delete",
			scope: "archived",
			dryRun: true,
		});
		expect(preview).toEqual({
			sessionIds: [first.session.id],
			skipped: [{ sessionId: running.session.id, reason: "running" }],
		});
		expect(existsSync(first.session.path ?? "")).toBe(true);

		const done = await client.request("session.cleanup", { ...ws, action: "delete", scope: "archived" });
		expect(done.sessionIds).toEqual([first.session.id]);
		expect(existsSync(first.session.path ?? "")).toBe(false);
		const remaining = (await client.request("session.list", ws)).sessions.map((s) => s.id);
		expect(new Set(remaining)).toEqual(new Set([second.session.id, running.session.id]));

		gate.resolve();
		await running.rec.waitForType("agent_settled");
		const progress: Array<{ done: number; total: number }> = [];
		const off = client.onEvent((frame) => {
			const event = frame.event;
			if (event.type === "session.cleanupProgress" && event.operationId === "op-1") {
				expect(event).toMatchObject({ workspaceId: workspace.id, action: "delete" });
				progress.push({ done: Number(event.done), total: Number(event.total) });
			}
		});
		const all = await client.request("session.cleanup", { ...ws, action: "delete", operationId: "op-1" });
		off();
		expect(new Set(all.sessionIds)).toEqual(new Set([second.session.id, running.session.id]));
		expect(progress).toEqual([
			{ done: 0, total: 2 },
			{ done: 1, total: 2 },
			{ done: 2, total: 2 },
		]);
		expect((await client.request("session.list", ws)).sessions).toEqual([]);
		expect(t.host.pool.size).toBe(0);
	});

	it("refuses to write after the session file changed outside Pier", async () => {
		t.faux.setResponses([fauxAssistantMessage("one")]);
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "hello" });
		await rec.waitForType("agent_settled");
		appendFileSync(session.path ?? "", "\n");
		await expectError(client.request("session.prompt", { sessionId: session.id, text: "again" }), "CONFLICT");
	});

	it("evicts idle sessions without subscribers", async () => {
		const { session } = await newSession();
		expect(await t.host.pool.sweep(Date.now() + 60 * 60 * 1000)).toEqual([]);
		await client.request("session.unsubscribe", { sessionId: session.id });
		expect(await t.host.pool.sweep(Date.now() + 60 * 60 * 1000)).toEqual([session.id]);
		expect(t.host.pool.size).toBe(0);
	});
});

describe("session titles", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost({ sessionTitles: true });
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	async function prompt(text: string): Promise<string> {
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		await client.request("session.prompt", { sessionId: session.id, text });
		await rec.waitForType("agent_settled");
		return session.id;
	}

	async function listed(sessionId: string): Promise<SessionSummary | undefined> {
		const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
		return sessions.find((s) => s.id === sessionId);
	}

	it("names a session after a long first prompt and leaves a short one as it is", async () => {
		// The title request and the agent's turn run side by side, so either may take a response first.
		const reply = (context: { messages: unknown[] }) =>
			fauxAssistantMessage(JSON.stringify(context.messages).includes("为这条消息起标题") ? "「重构登录流程」。" : "ok");
		t.faux.setResponses([reply, reply]);
		const text = "请帮我把登录流程重构一下，拆成更小的函数并补上单元测试";
		const long = await prompt(text);
		await vi.waitFor(async () =>
			expect(await listed(long)).toMatchObject({ name: "重构登录流程", firstMessage: text }),
		);

		t.faux.setResponses([fauxAssistantMessage("ok")]);
		const short = await prompt("修一下这个 bug");
		expect(await listed(short)).not.toHaveProperty("name");
		expect(t.faux.getPendingResponseCount()).toBe(0);
	});
});
