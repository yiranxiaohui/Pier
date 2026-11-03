import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stripTrailingImageHints } from "@pier/chat-state";
import {
	type AgentRuntimeId,
	type AgentRuntimeInfo,
	DEFAULT_AGENT_RUNTIME,
	PierProtocolError,
	type SessionCleanupResult,
	type SessionCleanupScope,
	type SessionSummary,
	type WorkspaceInfo,
} from "@pier/protocol";
import type { ConfigStore } from "./config.ts";
import type { ManagedSession, ManagedSessionOptions } from "./managed-session.ts";
import type { AgentRuntime, StoredSession } from "./runtimes/types.ts";
import type { SessionArchiveStore } from "./session-archive.ts";
import { SessionLock } from "./session-lock.ts";

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface SessionCleanupOptions {
	action: "archive" | "delete";
	/** Only sessions last modified before this time. */
	modifiedBefore?: Date;
	scope?: SessionCleanupScope;
	dryRun?: boolean;
	/** Called with the number of targets handled so far: first with 0, then after each one. */
	onProgress?: (done: number, total: number) => void;
}

export interface SessionPoolOptions {
	/** Agent runtimes; the first one is the default for new sessions. */
	runtimes: AgentRuntime[];
	config: ConfigStore;
	locksDir: string;
	/** Where deleted session files are moved. */
	trashDir: string;
	/** Archived session ids. */
	archive: SessionArchiveStore;
	uiTimeoutMs?: number;
	idleTimeoutMs?: number;
	eventLogCapacity?: number;
	/** Interval of the idle sweeper. */
	sweepIntervalMs?: number;
	onSessionReplaced?: (session: ManagedSession, previousId: string) => void;
	onSessionClosed?: (session: ManagedSession) => void;
	onSessionActivity?: (session: ManagedSession) => void;
	log?: (message: string) => void;
}

interface StoredEntry {
	runtime: AgentRuntime;
	stored: StoredSession;
}

/** Active session pool keyed by session id, loaded on demand and evicted when idle. */
export class SessionPool {
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly opening = new Map<string, Promise<ManagedSession>>();
	/** Resolved paths of session files being deleted; they cannot be opened meanwhile. */
	private readonly deleting = new Set<string>();
	private sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly options: SessionPoolOptions) {
		if (options.runtimes.length === 0) throw new Error("SessionPool needs at least one runtime");
	}

	get runtimes(): readonly AgentRuntime[] {
		return this.options.runtimes;
	}

	runtime(id: AgentRuntimeId = DEFAULT_AGENT_RUNTIME): AgentRuntime {
		const runtime = this.options.runtimes.find((r) => r.id === id);
		if (!runtime) throw new PierProtocolError("NOT_FOUND", `Unknown agent runtime ${id}`);
		return runtime;
	}

	async runtimeInfos(): Promise<AgentRuntimeInfo[]> {
		return Promise.all(this.options.runtimes.map((r) => r.info()));
	}

	/** Sessions every runtime stored for the workspace. A failing runtime is skipped (and logged). */
	private async listStored(workspace: WorkspaceInfo): Promise<StoredEntry[]> {
		const lists = await Promise.all(
			this.options.runtimes.map(async (runtime) => {
				try {
					return (await runtime.listSessions(workspace)).map((stored) => ({ runtime, stored }));
				} catch (error) {
					if (runtime.id === DEFAULT_AGENT_RUNTIME) throw error;
					this.options.log?.(
						`listing ${runtime.id} sessions failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return [];
				}
			}),
		);
		return lists.flat();
	}

	get size(): number {
		return this.sessions.size;
	}

	all(): ManagedSession[] {
		return [...this.sessions.values()];
	}

	get(sessionId: string): ManagedSession | undefined {
		return this.sessions.get(sessionId);
	}

	require(sessionId: string): ManagedSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new PierProtocolError("NOT_FOUND", `Session ${sessionId} is not open`);
		return session;
	}

	private workspaceAccessor(workspace: WorkspaceInfo): () => WorkspaceInfo {
		let last = workspace;
		return () => {
			const current = this.options.config.getWorkspace(workspace.id);
			if (current) last = current;
			return last;
		};
	}

	private sessionOptions(workspace: WorkspaceInfo): ManagedSessionOptions {
		return {
			workspace: this.workspaceAccessor(workspace),
			locksDir: this.options.locksDir,
			...(this.options.uiTimeoutMs === undefined ? {} : { uiTimeoutMs: this.options.uiTimeoutMs }),
			...(this.options.eventLogCapacity === undefined ? {} : { eventLogCapacity: this.options.eventLogCapacity }),
			onReplaced: (session, previousId) => {
				this.sessions.delete(previousId);
				this.sessions.set(session.id, session);
				this.options.onSessionReplaced?.(session, previousId);
			},
			onActivity: (session) => this.options.onSessionActivity?.(session),
			isArchived: (sessionId) => this.options.archive.has(sessionId),
		};
	}

	private add(session: ManagedSession): ManagedSession {
		this.sessions.set(session.id, session);
		return session;
	}

	async create(workspace: WorkspaceInfo, name?: string, runtimeId?: AgentRuntimeId): Promise<ManagedSession> {
		const runtime = this.runtime(runtimeId);
		const info = await runtime.info();
		if (!info.available) {
			throw new PierProtocolError("CONFLICT", info.reason ?? `${runtime.name} is not available on this computer`);
		}
		const session = this.add(await runtime.create(this.sessionOptions(workspace)));
		if (name) {
			try {
				await session.rename(name);
			} catch (error) {
				this.options.log?.(`naming the new session failed: ${error instanceof Error ? error.message : error}`);
			}
		}
		return session;
	}

	private findActiveByPath(path: string): ManagedSession | undefined {
		return this.all().find((s) => s.sessionFile && resolve(s.sessionFile) === resolve(path));
	}

	/**
	 * Open a session that belongs to `workspace`. Paths must come from the workspace's
	 * session list, so clients cannot make the host parse arbitrary files.
	 */
	async open(workspace: WorkspaceInfo, target: { sessionId: string } | { path: string }): Promise<ManagedSession> {
		if ("sessionId" in target) {
			const active = this.sessions.get(target.sessionId);
			if (active) {
				if (active.workspaceId !== workspace.id) throw new PierProtocolError("NOT_FOUND", "Session not in workspace");
				return active;
			}
		}
		const entries = await this.listStored(workspace);
		const entry =
			"sessionId" in target
				? entries.find((e) => e.stored.id === target.sessionId)
				: entries.find((e) => e.stored.path && resolve(e.stored.path) === resolve(target.path));
		if (!entry) throw new PierProtocolError("NOT_FOUND", "Session not found in this workspace");
		const { runtime, stored } = entry;

		const active = (stored.path ? this.findActiveByPath(stored.path) : undefined) ?? this.sessions.get(stored.id);
		if (active) return active;

		const key = stored.path ? resolve(stored.path) : `${runtime.id}:${stored.id}`;
		if (this.deleting.has(key)) throw new PierProtocolError("NOT_FOUND", "Session is being deleted");
		const pending = this.opening.get(key);
		if (pending) return pending;
		const promise = (async () => this.add(await runtime.open(this.sessionOptions(workspace), stored)))();
		this.opening.set(key, promise);
		try {
			return await promise;
		} finally {
			this.opening.delete(key);
		}
	}

	async fork(
		source: ManagedSession,
		entryId: string,
		position: "before" | "at",
	): Promise<{ session: ManagedSession; selectedText?: string }> {
		const workspace = this.options.config.getWorkspace(source.workspaceId);
		if (!workspace) throw new PierProtocolError("NOT_FOUND", "Workspace no longer exists");
		if (!source.capabilities.fork) throw new PierProtocolError("UNSUPPORTED", "This session cannot be forked");
		const runtime = this.runtime(source.runtimeId);
		const forked = await runtime.fork(source, entryId, position, this.sessionOptions(workspace));
		this.add(forked.session);
		return forked;
	}

	async list(workspace: WorkspaceInfo): Promise<SessionSummary[]> {
		const entries = await this.listStored(workspace);
		const summaries = new Map<string, SessionSummary>();
		for (const { runtime, stored: info } of entries) {
			summaries.set(info.id, {
				id: info.id,
				workspaceId: workspace.id,
				...(info.path ? { path: info.path } : {}),
				...(info.name ? { name: info.name } : {}),
				cwd: info.cwd,
				createdAt: info.created.toISOString(),
				modifiedAt: info.modified.toISOString(),
				messageCount: info.messageCount,
				firstMessage: stripTrailingImageHints(info.firstMessage).slice(0, 200),
				...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
				active: false,
				state: "inactive",
				...(this.options.archive.has(info.id) ? { archived: true } : {}),
				runtime: runtime.id,
			});
		}
		for (const session of this.all()) {
			if (session.workspaceId !== workspace.id) continue;
			const listed = summaries.get(session.id);
			const live = session.summary();
			summaries.set(session.id, listed ? { ...listed, ...live, createdAt: listed.createdAt } : live);
		}
		return [...summaries.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
	}

	/**
	 * Close a session of `workspace` (if active) and move its file to the trash. Resolves to
	 * false when the workspace has no such session. The file is taken from the active session
	 * or the workspace's session list, so clients cannot make the host move arbitrary files.
	 */
	async delete(workspace: WorkspaceInfo, sessionId: string, force = false): Promise<boolean> {
		let active = this.sessions.get(sessionId);
		if (active && active.workspaceId !== workspace.id) {
			throw new PierProtocolError("NOT_FOUND", "Session not in workspace");
		}
		let file = active?.sessionFile;
		let entry: StoredEntry | undefined;
		if (!active || active.runtimeId !== DEFAULT_AGENT_RUNTIME) {
			entry = (await this.listStored(workspace)).find((e) => e.stored.id === sessionId);
			if (!active && !entry) return false;
			file ??= entry?.stored.path;
		}
		const key = file ? resolve(file) : undefined;
		if (key && this.deleting.has(key)) throw new PierProtocolError("CONFLICT", "Session is already being deleted");
		if (key) this.deleting.add(key);
		try {
			const opening = key ? this.opening.get(key) : undefined;
			if (opening) await opening.catch(() => undefined);
			active = this.sessions.get(sessionId) ?? (file ? this.findActiveByPath(file) : undefined);
			if (active) await this.close(active.id, force, "deleted");
			if (entry?.runtime.deleteStored && (await entry.runtime.deleteStored(workspace, entry.stored))) {
				this.options.archive.set([sessionId], false);
				return true;
			}
			if (!file || !existsSync(file)) {
				this.options.archive.set([sessionId], false);
				return active !== undefined;
			}
			// Refuses when another Pier host has the session open.
			const lock = SessionLock.acquire(this.options.locksDir, file);
			try {
				moveToTrash(file, this.options.trashDir);
			} finally {
				lock.release();
			}
			this.options.archive.set([sessionId], false);
			return true;
		} finally {
			if (key) this.deleting.delete(key);
		}
	}

	/**
	 * Archive or unarchive one session of `workspace`. The session must be open or listed in
	 * the workspace.
	 */
	async setArchived(workspace: WorkspaceInfo, sessionId: string, archived: boolean): Promise<SessionSummary> {
		const active = this.sessions.get(sessionId);
		if (active && active.workspaceId !== workspace.id) {
			throw new PierProtocolError("NOT_FOUND", "Session not in workspace");
		}
		const summary = active ? undefined : (await this.list(workspace)).find((s) => s.id === sessionId);
		if (!active && !summary) throw new PierProtocolError("NOT_FOUND", "Session not found in this workspace");
		this.options.archive.set([sessionId], archived);
		if (active) return active.summary();
		const { archived: _previous, ...rest } = summary as SessionSummary;
		return archived ? { ...rest, archived: true } : rest;
	}

	/** Archive or delete the sessions of `workspace` matching `options`, skipping busy ones. */
	async cleanup(workspace: WorkspaceInfo, options: SessionCleanupOptions): Promise<SessionCleanupResult> {
		const scope = options.scope ?? "all";
		const cutoff = options.modifiedBefore?.getTime();
		const result: SessionCleanupResult = { sessionIds: [], skipped: [] };
		const selected = (await this.list(workspace)).filter((s) => {
			if (scope === "archived" && !s.archived) return false;
			if (scope === "unarchived" && s.archived) return false;
			if (options.action === "archive" && s.archived) return false;
			return cutoff === undefined || Date.parse(s.modifiedAt) < cutoff;
		});
		const targets: string[] = [];
		for (const summary of selected) {
			const active = this.sessions.get(summary.id);
			// Archiving does not touch the session, so only deleting skips running ones.
			if (options.action === "delete" && active?.busy) {
				result.skipped.push({ sessionId: summary.id, reason: "running" });
			} else {
				targets.push(summary.id);
			}
		}
		if (options.dryRun) return { ...result, sessionIds: targets };
		const total = targets.length;
		options.onProgress?.(0, total);
		if (options.action === "archive") {
			this.options.archive.set(targets, true);
			options.onProgress?.(total, total);
			return { ...result, sessionIds: targets };
		}
		for (const [index, id] of targets.entries()) {
			if (index > 0) options.onProgress?.(index, total);
			try {
				if (await this.delete(workspace, id)) result.sessionIds.push(id);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const conflict = error instanceof PierProtocolError && error.code === "CONFLICT";
				result.skipped.push({
					sessionId: id,
					reason: conflict ? (/another Pier host/.test(message) ? "locked" : "running") : "error",
					message,
				});
			}
		}
		if (total) options.onProgress?.(total, total);
		return result;
	}

	async close(sessionId: string, force = false, reason: "closed" | "idle" | "deleted" = "closed"): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		if (session.state !== "idle" && !force) {
			throw new PierProtocolError("CONFLICT", "Session is running; abort it first or pass force");
		}
		this.sessions.delete(sessionId);
		await session.dispose(reason);
		this.options.onSessionClosed?.(session);
		return true;
	}

	startSweeper(): void {
		if (this.sweeper) return;
		const interval = this.options.sweepIntervalMs ?? 60_000;
		this.sweeper = setInterval(() => void this.sweep(), interval);
		this.sweeper.unref?.();
	}

	/** Dispose sessions with no subscribers, no running work, and no activity for the idle timeout. */
	async sweep(now = Date.now()): Promise<string[]> {
		const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		const evicted: string[] = [];
		for (const session of this.all()) {
			if (session.subscriberCount > 0 || session.busy) continue;
			if (now - session.lastActivity < timeout) continue;
			const id = session.id;
			await this.close(id, false, "idle").catch(() => false);
			evicted.push(id);
		}
		return evicted;
	}

	async disposeAll(timeoutMs = 5000): Promise<void> {
		if (this.sweeper) clearInterval(this.sweeper);
		this.sweeper = undefined;
		const sessions = this.all();
		this.sessions.clear();
		// An extension's session_shutdown handler must not be able to block host shutdown.
		await Promise.allSettled(
			sessions.map((s) =>
				Promise.race([
					s.dispose("host_shutdown"),
					new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
				]),
			),
		);
		await Promise.allSettled(this.options.runtimes.map((runtime) => runtime.dispose()));
	}
}

/** Move a session file into `trashDir` under a unique name (copying across file systems). */
function moveToTrash(file: string, trashDir: string): string {
	mkdirSync(trashDir, { recursive: true, mode: 0o700 });
	const target = join(trashDir, `${Date.now()}-${basename(file)}`);
	try {
		renameSync(file, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		copyFileSync(file, target, constants.COPYFILE_EXCL);
		rmSync(file);
	}
	return target;
}
