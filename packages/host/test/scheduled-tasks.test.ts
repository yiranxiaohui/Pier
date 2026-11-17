import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ScheduledTaskInput, ScheduledTaskInputSchema } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ManagedSession, replyText, type SessionSubscriber } from "../src/managed-session.ts";
import { nextTaskRun, ScheduledTasks, type ScheduledTasksOptions } from "../src/scheduled-tasks.ts";
import { deferred } from "./helpers.ts";

describe("run summaries", () => {
	it("leave out thinking the model writes into its reply as tags", () => {
		expect(
			replyText([
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "<thinking>**Checking the logs**</thinking>\nAll jobs passed." },
				{ type: "text", text: "<think>unclosed" },
				{ type: "text", text: "Report sent." },
			]),
		).toBe("All jobs passed. Report sent.");
		expect(replyText("plain")).toBe("plain");
	});
});

describe("task recurrence", () => {
	it("computes intervals without drifting after a missed day", () => {
		expect(
			nextTaskRun({ kind: "interval", minutes: 60 }, new Date("2026-10-10T10:20:00Z"), "2026-10-09T09:15:00Z"),
		).toBe("2026-10-10T11:15:00.000Z");
	});
	it("uses the saved timezone and moves strictly past the current occurrence", () => {
		const schedule = { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" } as const;
		expect(nextTaskRun(schedule, new Date("2026-10-10T00:30:00Z"))).toBe("2026-10-10T01:00:00.000Z");
		expect(nextTaskRun(schedule, new Date("2026-10-10T01:00:00Z"))).toBe("2026-10-11T01:00:00.000Z");
	});
	it("keeps wall-clock time across DST and handles weekly Sunday", () => {
		expect(
			nextTaskRun({ kind: "daily", time: "09:00", timeZone: "America/New_York" }, new Date("2026-03-07T15:00:00Z")),
		).toBe("2026-03-08T13:00:00.000Z");
		expect(
			nextTaskRun({ kind: "weekly", time: "09:00", timeZone: "UTC", days: [0] }, new Date("2026-10-10T12:00:00Z")),
		).toBe("2026-10-11T09:00:00.000Z");
	});
	it("rejects impossible dates, times, timezones, empty weekdays and invalid intervals", () => {
		const input = { name: "test", prompt: "do work", workspaceId: "w" };
		for (const schedule of [
			{ kind: "once", at: "2026-02-30T09:00:00Z" },
			{ kind: "daily", time: "24:00", timeZone: "UTC" },
			{ kind: "daily", time: "09:00", timeZone: "bad/timezone" },
			{ kind: "weekly", time: "09:00", timeZone: "UTC", days: [] },
			{ kind: "interval", minutes: 0 },
		])
			expect(ScheduledTaskInputSchema.safeParse({ ...input, schedule }).success).toBe(false);
	});
});

describe("host task scheduler", () => {
	let root: string;
	let now: Date;
	let tasks: ScheduledTasks;
	let options: ScheduledTasksOptions;
	let session: ManagedSession;
	let input: ScheduledTaskInput;
	let create: ReturnType<typeof vi.fn>;
	let subscriber: SessionSubscriber;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-tasks-"));
		now = new Date("2026-10-10T10:00:00Z");
		session = {
			id: "s",
			busy: true,
			bridge: { pendingRequests: [] },
			prompt: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinking: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			subscribe: vi.fn((value: SessionSubscriber) => {
				subscriber = value;
				return { start: () => {} };
			}),
			unsubscribe: vi.fn(),
			snapshot: () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "report" }] }] }),
		} as unknown as ManagedSession;
		create = vi.fn(async () => session);
		options = {
			file: join(root, "scheduled-tasks.json"),
			pool: { create, runtime: vi.fn(), close: vi.fn() } as unknown as ScheduledTasksOptions["pool"],
			workspace: () => ({ id: "w", name: "workspace", path: root, policy: "smart", addedAt: now.toISOString() }),
			onChanged: vi.fn(),
			onSessionCreated: vi.fn(),
			log: vi.fn(),
			now: () => now,
		};
		tasks = new ScheduledTasks(options);
		input = {
			name: "report",
			prompt: "check the project",
			workspaceId: "w",
			runtime: "pi",
			schedule: { kind: "interval", minutes: 60 },
		};
	});
	afterEach(async () => {
		await tasks.shutdown();
		rmSync(root, { recursive: true, force: true });
	});

	it("persists private tasks, coalesces overdue slots and reserves a run before async creation", async () => {
		const gate = deferred<ManagedSession>();
		create.mockReturnValueOnce(gate.promise);
		const task = tasks.create(input);
		now = new Date("2026-10-12T10:30:00Z");
		tasks.tick();
		tasks.tick();
		expect(create).toHaveBeenCalledTimes(1);
		expect(tasks.list()[0]?.nextRunAt).toBe("2026-10-12T11:00:00.000Z");
		expect(() => tasks.run(task.id)).toThrow(/已经在运行/);
		gate.resolve(session);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledWith(input.prompt));
		expect(JSON.parse(readFileSync(options.file, "utf8")).runs).toHaveLength(1);
		if (process.platform !== "win32") expect(statSync(options.file).mode & 0o777).toBe(0o600);
	});

	it("marks a once task complete, tracks approvals and keeps completion unread", async () => {
		const task = tasks.create({ ...input, schedule: { kind: "once", at: "2026-10-10T10:01:00Z" } });
		now = new Date("2026-10-10T10:01:01Z");
		tasks.tick();
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
		session.bridge.pendingRequests.push({} as never);
		tasks.activity(session);
		expect(tasks.runs()[0]?.status).toBe("waiting");
		tasks.readRun(tasks.runs()[0]?.id ?? "");
		session.bridge.pendingRequests.pop();
		Object.defineProperty(session, "busy", { value: false });
		subscriber.send({ type: "evt", sessionId: session.id, event: { type: "agent_settled" } });
		tasks.activity(session);
		tasks.tick();
		expect(tasks.runs()[0]).toMatchObject({ status: "succeeded", read: false, summary: "report" });
		expect(tasks.list()[0]).toMatchObject({ id: task.id, status: "completed", nextRunAt: null });
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("blocks overlap and mutation while allowing pause and stopping only the current run", async () => {
		const task = tasks.create(input);
		tasks.run(task.id);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
		expect(() => tasks.update(task.id, input)).toThrow(/正在运行/);
		expect(() => tasks.delete(task.id)).toThrow(/正在运行/);
		tasks.setStatus(task.id, "paused");
		await tasks.stop(task.id);
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(tasks.runs()[0]?.status).toBe("interrupted");
		now = new Date("2026-10-11T10:00:00Z");
		tasks.tick();
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("stops a task during async creation before any prompt runs", async () => {
		const gate = deferred<ManagedSession>();
		create.mockReturnValueOnce(gate.promise);
		const task = tasks.create(input);
		tasks.run(task.id);
		await tasks.stop(task.id);
		gate.resolve(session);
		await vi.waitFor(() => expect(options.pool.close).toHaveBeenCalledWith("s", true));
		expect(session.prompt).not.toHaveBeenCalled();
		expect(tasks.runs()[0]?.status).toBe("interrupted");
	});

	it("does not mistake accepted prompts or transient idle states for completion", async () => {
		Object.defineProperty(session, "busy", { value: false });
		const task = tasks.create(input);
		tasks.run(task.id);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
		tasks.activity(session);
		tasks.tick();
		expect(tasks.runs()[0]?.status).toBe("running");
		subscriber.send({ type: "evt", sessionId: session.id, event: { type: "agent_settled" } });
		await vi.waitFor(() => expect(tasks.runs()[0]?.status).toBe("succeeded"));
	});

	it("reports creation failures and supports retry without changing the scheduled time", async () => {
		create.mockRejectedValueOnce(new Error("runtime unavailable"));
		const task = tasks.create(input);
		tasks.run(task.id);
		await vi.waitFor(() => expect(tasks.runs()[0]?.status).toBe("failed"));
		expect(tasks.runs()[0]?.error).toBe("runtime unavailable");
		expect(tasks.list()[0]?.nextRunAt).toBe(task.nextRunAt);
		tasks.run(task.id);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
	});

	it("recovers interrupted runs on restart without replaying their prompts", async () => {
		const task = tasks.create(input);
		tasks.run(task.id);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
		const restored = new ScheduledTasks(options);
		expect(restored.runs()[0]).toMatchObject({ status: "interrupted", read: false });
		restored.tick();
		expect(create).toHaveBeenCalledTimes(1);
		await restored.shutdown();
	});

	it("never executes or exposes a mutation when persistence fails", () => {
		mkdirSync(options.file);
		expect(() => tasks.create(input)).toThrow();
		expect(tasks.list()).toEqual([]);
		expect(create).not.toHaveBeenCalled();
	});

	it("preserves corrupt storage for recovery", () => {
		writeFileSync(options.file, "broken-json");
		expect(() => new ScheduledTasks(options)).toThrow();
		expect(readFileSync(options.file, "utf8")).toBe("broken-json");
	});

	it("bounds concurrent launches on the host", async () => {
		const gate = deferred<ManagedSession>();
		create.mockReturnValue(gate.promise);
		const list = Array.from({ length: 5 }, () => tasks.create(input));
		for (const task of list.slice(0, 4)) tasks.run(task.id);
		expect(() => tasks.run(list[4]?.id ?? "")).toThrow(/已有 4 个/);
		gate.resolve(session);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(4));
	});
});
