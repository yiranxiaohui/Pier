import { stripTrailingImageHints } from "@pier/chat-state";
import type {
	AgentRuntimeId,
	UsageEntry,
	UsageSession,
	UsageStats,
	UsageStatsError,
	WorkspaceInfo,
} from "@pier/protocol";
import { PierProtocolError } from "@pier/protocol";
import type { AgentRuntime, StoredSession, UsageRecord } from "./runtimes/types.ts";

export type { UsageRecord } from "./runtimes/types.ts";

/** Stored sessions are read this many at a time. */
const CONCURRENCY = 4;
/** Errors reported at most (an agent that cannot be reached fails for each of its sessions). */
const MAX_ERRORS = 50;

/** Prices requests whose agent recorded no cost (1.70). */
export interface CostEstimator {
	/** Cost in US dollars of the request at its model's official price; undefined when unknown. */
	cost(record: UsageRecord): number | undefined;
}

export interface UsageStatsSource {
	workspaces(): WorkspaceInfo[];
	/** Every stored session of the workspace with the runtime that owns it. */
	storedSessions(workspace: WorkspaceInfo): Promise<{ runtime: AgentRuntime; stored: StoredSession }[]>;
	isArchived(sessionId: string): boolean;
	/** Official model prices, when they are known (pi's model catalog). Asked once per collection. */
	prices?: () => CostEstimator | undefined;
	log?: (message: string) => void;
}

export interface UsageStatsOptions {
	/** First day to include (`YYYY-MM-DD`, in `timeZone`). */
	since?: string;
	/** IANA time zone the days are in; the host's by default. */
	timeZone?: string;
}

function hostTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** `YYYY-MM-DD` of an epoch-millisecond time in a time zone. */
export function dayFormatter(timeZone: string): (at: number) => string {
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
	} catch {
		throw new PierProtocolError("BAD_REQUEST", `Unknown time zone ${timeZone}`);
	}
	const cache = new Map<number, string>();
	return (at) => {
		// Requests come in bursts: format each hour once.
		const hour = Math.floor(at / 3_600_000);
		const minutesOff = at - hour * 3_600_000;
		let day = minutesOff < 1_800_000 ? cache.get(hour * 2) : cache.get(hour * 2 + 1);
		if (day === undefined) {
			const parts = format.formatToParts(at);
			const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
			day = `${part("year")}-${part("month")}-${part("day")}`;
			cache.set(minutesOff < 1_800_000 ? hour * 2 : hour * 2 + 1, day);
		}
		return day;
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Run `task` over `items`, `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await task(items[next++] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Sum the records into one entry per day and model. Records before `since` are left out. An
 * entry has a `cost` when every request has a recorded one, else an `estimatedCost` when
 * `prices` can price every request without one.
 */
export function usageEntries(
	records: UsageRecord[],
	dayOf: (at: number) => string,
	since?: string,
	prices?: CostEstimator,
): UsageEntry[] {
	const entries = new Map<string, UsageEntry & { usd: number; recorded: boolean; priced: boolean }>();
	for (const record of records) {
		const day = dayOf(record.at);
		if (since && day < since) continue;
		const key = `${day}\n${record.provider ?? ""}\n${record.model}`;
		let entry = entries.get(key);
		if (!entry) {
			entry = {
				day,
				model: record.model,
				...(record.provider ? { provider: record.provider } : {}),
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				requests: 0,
				usd: 0,
				recorded: true,
				priced: true,
			};
			entries.set(key, entry);
		}
		entry.input += record.input;
		entry.output += record.output;
		entry.cacheRead += record.cacheRead;
		entry.cacheWrite += record.cacheWrite;
		entry.requests += record.requests ?? 1;
		if (record.cost !== undefined) {
			entry.usd += record.cost;
			continue;
		}
		entry.recorded = false;
		const estimate = entry.priced ? prices?.cost(record) : undefined;
		if (estimate === undefined) entry.priced = false;
		else entry.usd += estimate;
	}
	return [...entries.values()]
		.map(({ usd, recorded, priced, ...entry }): UsageEntry => {
			if (recorded) return { ...entry, cost: usd };
			return priced ? { ...entry, estimatedCost: usd } : entry;
		})
		.sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}

/**
 * Token usage of the stored sessions of every workspace (`usage.stats`, 1.68). Runtimes read
 * their session files (cached by size and modification time) or ask their agent; a request
 * copied into a forked session counts once, for the session it was made in.
 */
export class UsageStatsCollector {
	private readonly pending = new Map<string, Promise<UsageStats>>();

	constructor(private readonly source: UsageStatsSource) {}

	/** The official prices, if any; statistics without estimates beat none. */
	private prices(): CostEstimator | undefined {
		try {
			return this.source.prices?.();
		} catch (error) {
			this.source.log?.(`reading model prices failed: ${message(error)}`);
			return undefined;
		}
	}

	stats(options: UsageStatsOptions = {}): Promise<UsageStats> {
		const timeZone = options.timeZone ?? hostTimeZone();
		const dayOf = dayFormatter(timeZone);
		const key = `${timeZone}\n${options.since ?? ""}`;
		let promise = this.pending.get(key);
		if (!promise) {
			promise = this.collect(timeZone, dayOf, options.since).finally(() => this.pending.delete(key));
			this.pending.set(key, promise);
		}
		return promise;
	}

	private async collect(timeZone: string, dayOf: (at: number) => string, since?: string): Promise<UsageStats> {
		const errors: UsageStatsError[] = [];
		const found: { workspace: WorkspaceInfo; runtime: AgentRuntime; stored: StoredSession }[] = [];
		await Promise.all(
			this.source.workspaces().map(async (workspace) => {
				try {
					for (const entry of await this.source.storedSessions(workspace)) found.push({ workspace, ...entry });
				} catch (error) {
					errors.push({ workspaceId: workspace.id, message: message(error) });
				}
			}),
		);
		// Older sessions first, so a request a fork copied counts for the session it was made in.
		found.sort((a, b) => a.stored.created.getTime() - b.stored.created.getTime());
		const records = new Map<(typeof found)[number], UsageRecord[]>();
		await eachLimited(found, CONCURRENCY, async (item) => {
			const { runtime, stored, workspace } = item;
			if (!runtime.usage) return;
			try {
				records.set(item, await runtime.usage(workspace, stored));
			} catch (error) {
				this.source.log?.(`reading the usage of ${runtime.id} session ${stored.id} failed: ${message(error)}`);
				errors.push({ workspaceId: workspace.id, runtime: runtime.id, sessionId: stored.id, message: message(error) });
			}
		});
		const seen = new Map<AgentRuntimeId, Set<string>>();
		const sessions: UsageSession[] = [];
		const prices = this.prices();
		for (const item of found) {
			const list = records.get(item);
			if (!list?.length) continue;
			const keys = seen.get(item.runtime.id) ?? new Set<string>();
			seen.set(item.runtime.id, keys);
			const own = list.filter((record) => {
				if (record.key === undefined) return true;
				if (keys.has(record.key)) return false;
				keys.add(record.key);
				return true;
			});
			const usage = usageEntries(own, dayOf, since, prices);
			if (usage.length === 0) continue;
			const title = (item.stored.name?.trim() || stripTrailingImageHints(item.stored.firstMessage).trim()).slice(
				0,
				120,
			);
			sessions.push({
				sessionId: item.stored.id,
				workspaceId: item.workspace.id,
				runtime: item.runtime.id,
				...(title ? { title } : {}),
				...(this.source.isArchived(item.stored.id) ? { archived: true } : {}),
				modifiedAt: item.stored.modified.toISOString(),
				usage,
			});
		}
		sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
		return {
			timeZone,
			generatedAt: new Date().toISOString(),
			sessions,
			...(errors.length ? { errors: errors.slice(0, MAX_ERRORS) } : {}),
		};
	}
}
