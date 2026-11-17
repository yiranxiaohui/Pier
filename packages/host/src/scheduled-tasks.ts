import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
	PierProtocolError,
	type ScheduledTask,
	type ScheduledTaskInput,
	ScheduledTaskInputSchema,
	type ScheduledTaskRun,
	ScheduledTaskRunSchema,
	ScheduledTaskSchema,
	type TaskSchedule,
	type WorkspaceInfo,
} from "@pier/protocol";
import { Cron } from "croner";
import { z } from "zod";
import { writePrivateFile } from "./config.ts";
import { errorMessage, type ManagedSession, replyText } from "./managed-session.ts";
import type { SessionPool } from "./session-pool.ts";

const StoreSchema = z.object({
	version: z.literal(1),
	tasks: z.array(ScheduledTaskSchema),
	runs: z.array(ScheduledTaskRunSchema),
});
type TaskStore = z.infer<typeof StoreSchema>;
const MAX_TASKS = 100;
const RUNS_PER_TASK = 50;
const MAX_RUN_HISTORY = 500;
const MAX_CONCURRENT_RUNS = 4;

/** Strictly after `now`; intervals keep their original phase even after sleep/restart. */
export function nextTaskRun(schedule: TaskSchedule, now: Date, anchor?: string | null): string | null {
	if (schedule.kind === "once") return Date.parse(schedule.at) > now.getTime() ? schedule.at : null;
	if (schedule.kind === "interval") {
		const step = schedule.minutes * 60000;
		const base = anchor ? Date.parse(anchor) : now.getTime();
		return new Date(base + Math.max(1, Math.floor((now.getTime() - base) / step) + 1) * step).toISOString();
	}
	const [hour, minute] = schedule.time.split(":");
	const days = schedule.kind === "weekly" ? [...new Set(schedule.days)].join(",") : "*";
	return (
		new Cron(`${minute} ${hour} * * ${days}`, { timezone: schedule.timeZone, paused: true })
			.nextRun(now)
			?.toISOString() ?? null
	);
}

interface ActiveRun {
	runId: string;
	session?: ManagedSession;
	accepted: boolean;
	settled?: boolean;
	off?: () => void;
	cancelling?: boolean;
}

export interface ScheduledTasksOptions {
	file: string;
	pool: Pick<SessionPool, "create" | "get" | "close" | "runtime">;
	workspace(id: string): WorkspaceInfo;
	onChanged(): void;
	onSessionCreated(workspaceId: string): void;
	log(message: string): void;
	now?: () => Date;
}

/** Host-owned scheduler. Runs survive window closure; unfinished runs never replay after a crash. */
export class ScheduledTasks {
	private data: TaskStore;
	private readonly active = new Map<string, ActiveRun>();
	private readonly launches = new Set<Promise<void>>();
	private timer?: ReturnType<typeof setInterval>;
	private stopped = false;
	private readonly now: () => Date;

	constructor(private readonly options: ScheduledTasksOptions) {
		this.now = options.now ?? (() => new Date());
		this.data = existsSync(options.file)
			? StoreSchema.parse(JSON.parse(readFileSync(options.file, "utf8")))
			: { version: 1, tasks: [], runs: [] };
		if (this.data.runs.some((r) => r.status === "running" || r.status === "waiting")) {
			this.change((data) => {
				for (const run of data.runs) {
					if (run.status !== "running" && run.status !== "waiting") continue;
					run.status = "interrupted";
					run.finishedAt = this.now().toISOString();
					run.error = "电脑或 Pier Host 已重启，本次运行已中断。";
					run.read = false;
				}
			});
		}
	}

	/** Commit to disk before exposing or acting on any new state. */
	private change(edit: (data: TaskStore) => void): void {
		const next = structuredClone(this.data);
		edit(next);
		writePrivateFile(this.options.file, `${JSON.stringify(next, null, 2)}\n`);
		this.data = next;
		this.options.onChanged();
	}

	list(): ScheduledTask[] {
		return structuredClone(this.data.tasks);
	}
	runs(taskId?: string): ScheduledTaskRun[] {
		return structuredClone(this.data.runs.filter((r) => !taskId || r.taskId === taskId));
	}
	private requireTask(id: string): ScheduledTask {
		const task = this.data.tasks.find((t) => t.id === id);
		if (!task) throw new PierProtocolError("NOT_FOUND", "定时任务不存在");
		return task;
	}

	private validate(input: ScheduledTaskInput): ScheduledTaskInput {
		const task = ScheduledTaskInputSchema.parse(input);
		this.options.workspace(task.workspaceId);
		this.options.pool.runtime(task.runtime);
		if (task.schedule.kind === "once" && !nextTaskRun(task.schedule, this.now())) {
			throw new PierProtocolError("BAD_REQUEST", "执行时间必须晚于当前时间");
		}
		return task;
	}

	create(input: ScheduledTaskInput): ScheduledTask {
		if (this.data.tasks.length >= MAX_TASKS) throw new PierProtocolError("CONFLICT", "最多保存 100 个定时任务");
		const task: ScheduledTask = {
			...this.validate(input),
			id: randomUUID(),
			status: "active",
			nextRunAt: nextTaskRun(input.schedule, this.now()),
			createdAt: this.now().toISOString(),
			updatedAt: this.now().toISOString(),
		};
		this.change((data) => data.tasks.push(task));
		return structuredClone(task);
	}

	update(id: string, input: ScheduledTaskInput): ScheduledTask {
		const previous = this.requireTask(id);
		if (this.active.has(id)) throw new PierProtocolError("CONFLICT", "任务正在运行，请结束后再编辑");
		const task: ScheduledTask = {
			...previous,
			...this.validate(input),
			status: previous.status === "paused" ? "paused" : "active",
			nextRunAt: nextTaskRun(input.schedule, this.now()),
			updatedAt: this.now().toISOString(),
		};
		this.change((data) => {
			data.tasks = data.tasks.map((t) => (t.id === id ? task : t));
		});
		return structuredClone(task);
	}

	setStatus(id: string, status: "active" | "paused"): ScheduledTask {
		const previous = this.requireTask(id);
		const next = nextTaskRun(previous.schedule, this.now());
		if (status === "active" && !next) throw new PierProtocolError("CONFLICT", "单次任务的时间已过，请编辑执行时间");
		const task: ScheduledTask = { ...previous, status, nextRunAt: next, updatedAt: this.now().toISOString() };
		this.change((data) => {
			data.tasks = data.tasks.map((t) => (t.id === id ? task : t));
		});
		return structuredClone(task);
	}

	delete(id: string): boolean {
		if (this.active.has(id)) throw new PierProtocolError("CONFLICT", "任务正在运行，请结束后再删除");
		if (!this.data.tasks.some((t) => t.id === id)) return false;
		this.change((data) => {
			data.tasks = data.tasks.filter((t) => t.id !== id);
			data.runs = data.runs.filter((r) => r.taskId !== id);
		});
		return true;
	}

	readRun(id: string): ScheduledTaskRun {
		if (!this.data.runs.some((r) => r.id === id)) throw new PierProtocolError("NOT_FOUND", "运行记录不存在");
		this.change((data) => {
			const run = data.runs.find((r) => r.id === id);
			if (run) run.read = true;
		});
		return structuredClone(this.data.runs.find((r) => r.id === id) as ScheduledTaskRun);
	}

	start(): void {
		this.timer = setInterval(() => this.tick(), 1000);
		this.timer.unref?.();
		this.tick();
	}

	tick(): void {
		if (this.stopped) return;
		try {
			for (const entry of this.active.values()) if (entry.session && entry.accepted) this.activity(entry.session);
			for (const task of this.data.tasks) {
				if (task.status !== "active" || !task.nextRunAt || Date.parse(task.nextRunAt) > this.now().getTime()) continue;
				if (this.active.has(task.id)) {
					// Recurring runs never overlap; skip elapsed slots while a previous run is active.
					if (task.schedule.kind !== "once")
						this.change((data) => {
							const current = data.tasks.find((t) => t.id === task.id);
							if (current) current.nextRunAt = nextTaskRun(current.schedule, this.now(), current.nextRunAt);
						});
					continue;
				}
				if (this.active.size >= MAX_CONCURRENT_RUNS) break;
				this.run(task.id, "schedule");
			}
		} catch (error) {
			this.options.log(`scheduled tasks: ${errorMessage(error)}`);
		}
	}

	run(id: string, trigger: "schedule" | "manual" = "manual"): ScheduledTaskRun {
		if (this.stopped) throw new PierProtocolError("CONFLICT", "Pier Host 正在关闭");
		const task = structuredClone(this.requireTask(id));
		if (this.active.has(id)) throw new PierProtocolError("CONFLICT", "这个任务已经在运行");
		if (this.active.size >= MAX_CONCURRENT_RUNS)
			throw new PierProtocolError("CONFLICT", "已有 4 个任务在运行，请稍后再试");
		const run: ScheduledTaskRun = {
			id: randomUUID(),
			taskId: id,
			taskName: task.name,
			workspaceId: task.workspaceId,
			runtime: task.runtime,
			trigger,
			status: "running",
			startedAt: this.now().toISOString(),
			read: false,
		};
		this.change((data) => {
			data.runs.unshift(run);
			let count = 0;
			const retained = data.runs.filter((r) => r.taskId !== id || ++count <= RUNS_PER_TASK);
			const isRunning = (r: ScheduledTaskRun) => r.status === "running" || r.status === "waiting";
			const runningCount = retained.filter(isRunning).length;
			let finishedCount = 0;
			data.runs = retained.filter((r) => isRunning(r) || ++finishedCount <= MAX_RUN_HISTORY - runningCount);
			if (trigger === "schedule") {
				const current = data.tasks.find((t) => t.id === id);
				if (current) {
					current.nextRunAt = nextTaskRun(current.schedule, this.now(), current.nextRunAt);
					if (!current.nextRunAt) current.status = "completed";
				}
			}
		});
		const entry: ActiveRun = { runId: run.id, accepted: false };
		this.active.set(id, entry);
		const launch = this.launch(task, entry);
		this.launches.add(launch);
		void launch.finally(() => this.launches.delete(launch));
		return structuredClone(run);
	}

	private async launch(task: ScheduledTask, entry: ActiveRun): Promise<void> {
		try {
			const session = await this.options.pool.create(
				this.options.workspace(task.workspaceId),
				`定时 · ${task.name}`,
				task.runtime,
			);
			entry.session = session;
			if (this.stopped || entry.cancelling || this.active.get(task.id) !== entry) {
				await this.options.pool.close(session.id, true);
				return;
			}
			this.change((data) => {
				const run = data.runs.find((r) => r.id === entry.runId);
				if (run) run.sessionId = session.id;
			});
			this.options.onSessionCreated(task.workspaceId);
			if (task.model) await session.setModel(task.model.provider, task.model.modelId, false);
			if (task.thinkingLevel) await session.setThinking(task.thinkingLevel, false);
			if (this.stopped || entry.cancelling || this.active.get(task.id) !== entry) return;
			const subscriberId = `scheduled-task:${entry.runId}`;
			entry.off = () => session.unsubscribe(subscriberId);
			session
				.subscribe({
					connectionId: subscriberId,
					send: (frame) => {
						if (frame.event.type !== "agent_settled") return;
						entry.settled = true;
						if (frame.event.aborted) entry.cancelling = true;
						// Runtime events precede the session's idle state update.
						queueMicrotask(() => this.activity(session));
					},
				})
				.start();
			await session.prompt(task.prompt);
			entry.accepted = true;
			this.activity(session);
		} catch (error) {
			try {
				this.finish(task.id, "failed", errorMessage(error));
			} catch (saveError) {
				this.options.log(`saving scheduled task failure: ${errorMessage(saveError)}`);
			}
		}
	}

	/** Also called by the session pool, so approvals appear immediately without opening the chat. */
	activity(session: ManagedSession): void {
		const found = [...this.active].find(([, entry]) => entry.session === session);
		if (!found) return;
		const [taskId, entry] = found;
		try {
			if (entry.accepted && entry.settled && !session.busy) {
				if (entry.cancelling) {
					this.finish(taskId, "interrupted", "本次运行已停止。");
					return;
				}
				const snapshot = session.snapshot();
				const last = [...snapshot.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
					| { content?: unknown; stopReason?: string; errorMessage?: string }
					| undefined;
				const error =
					snapshot.errorMessage || (last?.stopReason === "error" ? last.errorMessage || "Agent 执行失败" : undefined);
				if (last?.stopReason === "aborted") {
					this.finish(taskId, "interrupted", "本次运行已停止。");
					return;
				}
				this.finish(
					taskId,
					error ? "failed" : "succeeded",
					error,
					last ? replyText(last.content).slice(0, 4000) : undefined,
				);
			} else {
				const status = session.bridge.pendingRequests.length ? "waiting" : "running";
				const run = this.data.runs.find((r) => r.id === entry.runId);
				if (run && (run.status !== status || run.sessionId !== session.id))
					this.change((data) => {
						const current = data.runs.find((r) => r.id === entry.runId);
						if (current) {
							current.status = status;
							current.sessionId = session.id;
							current.read = false;
						}
					});
			}
		} catch (error) {
			this.options.log(`scheduled task activity: ${errorMessage(error)}`);
		}
	}

	private finish(
		taskId: string,
		status: "succeeded" | "failed" | "interrupted",
		error?: string,
		summary?: string,
	): void {
		const entry = this.active.get(taskId);
		if (!entry) return;
		this.change((data) => {
			const run = data.runs.find((r) => r.id === entry.runId);
			if (run) {
				run.status = status;
				run.finishedAt = this.now().toISOString();
				run.read = false;
				if (error) run.error = error.slice(0, 4000);
				if (summary) run.summary = summary;
				if (entry.session) run.sessionId = entry.session.id;
			}
		});
		this.active.delete(taskId);
		entry.off?.();
	}

	sessionClosed(session: ManagedSession): void {
		const found = [...this.active].find(([, entry]) => entry.session === session);
		if (found) this.finish(found[0], "interrupted", "会话已关闭，本次运行已中断。");
	}

	sessionAborting(session: ManagedSession): void {
		const found = [...this.active.values()].find((entry) => entry.session === session);
		if (found) found.cancelling = true;
	}

	async stop(id: string): Promise<boolean> {
		this.requireTask(id);
		const entry = this.active.get(id);
		if (!entry) return false;
		entry.cancelling = true;
		if (entry.session) await entry.session.abort();
		this.finish(id, "interrupted", "本次运行已停止。");
		return true;
	}

	removeWorkspace(workspaceId: string): void {
		for (const [id] of this.active)
			if (this.requireTask(id).workspaceId === workspaceId) {
				this.finish(id, "interrupted", "工作区已移除，本次运行已中断。");
			}
		if (this.data.tasks.some((t) => t.workspaceId === workspaceId))
			this.change((data) => {
				for (const task of data.tasks) if (task.workspaceId === workspaceId) task.status = "paused";
			});
	}

	async shutdown(): Promise<void> {
		this.stopped = true;
		clearInterval(this.timer);
		for (const [id] of this.active) this.finish(id, "interrupted", "Pier Host 已退出，本次运行已中断。");
		await Promise.allSettled(this.launches);
	}
}
