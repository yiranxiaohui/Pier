import type { AgentRuntimeId, UsageEntry, UsageStats } from "@pier/protocol";
import { agentRuntimeLabel } from "./slash.ts";

/** Token usage statistics of one computer (`usage.stats`, 1.68), as a client collected them. */
export interface UsageSource {
	/** The client's id for the computer. */
	node: string;
	nodeName: string;
	stats: UsageStats;
	/** Names of the computer's workspaces by id. */
	workspaceNames?: Record<string, string>;
}

/** Which usage to count. */
export interface UsageFilter {
	/** First day (`YYYY-MM-DD`) to count. */
	since?: string;
	node?: string;
	runtime?: AgentRuntimeId;
}

export interface UsageTotals {
	/** Prompt tokens not read from or written to the cache. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `input + output + cacheRead + cacheWrite`. */
	total: number;
	requests: number;
	sessions: number;
	/** Cost of the requests whose agent recorded one, in US dollars. */
	cost: number;
	/** Requests counted without a cost (their agent records none). */
	uncostedRequests: number;
}

/** Usage of one agent, model, workspace or computer. */
export interface UsageGroup extends UsageTotals {
	key: string;
	label: string;
	/** Secondary label, e.g. the computer of a workspace or the provider of a model. */
	detail?: string;
}

/** Tokens of one day (or month), split by agent. */
export interface UsageBucket {
	/** `YYYY-MM-DD`, or `YYYY-MM` for months. */
	key: string;
	total: number;
	byRuntime: Partial<Record<AgentRuntimeId, number>>;
}

export interface UsageSessionGroup extends UsageTotals {
	node: string;
	nodeName: string;
	sessionId: string;
	workspaceId: string;
	workspaceName?: string;
	runtime: AgentRuntimeId;
	title?: string;
	archived?: boolean;
	modifiedAt: string;
}

export interface UsageSummary {
	totals: UsageTotals;
	/** Share of the prompt tokens read from the cache, when there were any. */
	cacheHitRate?: number;
	byRuntime: UsageGroup[];
	byModel: UsageGroup[];
	byWorkspace: UsageGroup[];
	byNode: UsageGroup[];
	/** Days from `since` (or the first day with usage) to `today`; months when that is over 92 days. */
	buckets: UsageBucket[];
	granularity: "day" | "month";
	/** Sessions with the most tokens, most first. */
	topSessions: UsageSessionGroup[];
}

export function emptyUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		requests: 0,
		sessions: 0,
		cost: 0,
		uncostedRequests: 0,
	};
}

function addEntry(totals: UsageTotals, entry: UsageEntry): void {
	totals.input += entry.input;
	totals.output += entry.output;
	totals.cacheRead += entry.cacheRead;
	totals.cacheWrite += entry.cacheWrite;
	totals.total += entryTokens(entry);
	totals.requests += entry.requests;
	if (entry.cost === undefined) totals.uncostedRequests += entry.requests;
	else totals.cost += entry.cost;
}

export function entryTokens(entry: Pick<UsageEntry, "input" | "output" | "cacheRead" | "cacheWrite">): number {
	return entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
}

/** `YYYY-MM-DD` of a local date. */
export function localDay(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The first day of the last `days` days up to `now` (local time), e.g. 7 → six days ago. */
export function usageSince(days: number, now = new Date()): string {
	const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
	return localDay(date);
}

/** The device's IANA time zone, when the platform reports it. */
export function localTimeZone(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
	} catch {
		return undefined;
	}
}

function nextDay(day: string): string {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return localDay(new Date(y, m - 1, d + 1));
}

function dayRange(first: string, last: string): string[] {
	const days: string[] = [];
	for (let day = first; day <= last && days.length < 4000; day = nextDay(day)) days.push(day);
	return days;
}

function monthRange(first: string, last: string): string[] {
	const months: string[] = [];
	let [y, m] = first.split("-").map(Number) as [number, number];
	const end = last.slice(0, 7);
	for (;;) {
		const key = `${y}-${String(m).padStart(2, "0")}`;
		if (key > end || months.length > 600) break;
		months.push(key);
		m++;
		if (m > 12) {
			m = 1;
			y++;
		}
	}
	return months;
}

class Groups {
	private readonly groups = new Map<string, UsageGroup & { sessionKeys: Set<string> }>();

	add(key: string, label: string, entry: UsageEntry, session: string, detail?: string): void {
		let group = this.groups.get(key);
		if (!group) {
			group = { key, label, ...(detail ? { detail } : {}), ...emptyUsageTotals(), sessionKeys: new Set() };
			this.groups.set(key, group);
		}
		addEntry(group, entry);
		group.sessionKeys.add(session);
	}

	list(): UsageGroup[] {
		return [...this.groups.values()]
			.map(({ sessionKeys, ...group }) => ({ ...group, sessions: sessionKeys.size }))
			.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
	}
}

/**
 * Sum the usage statistics of several computers. `today` (`YYYY-MM-DD`) ends the day buckets;
 * they start at `filter.since`, else at the first day with usage.
 */
export function summarizeUsage(
	sources: UsageSource[],
	filter: UsageFilter = {},
	today = localDay(new Date()),
	topSessions = 20,
): UsageSummary {
	const totals = emptyUsageTotals();
	const runtimes = new Groups();
	const models = new Groups();
	const workspaces = new Groups();
	const nodes = new Groups();
	const days = new Map<string, UsageBucket>();
	const sessions: UsageSessionGroup[] = [];
	let first: string | undefined;
	for (const source of sources) {
		if (filter.node !== undefined && source.node !== filter.node) continue;
		for (const session of source.stats.sessions) {
			if (filter.runtime !== undefined && session.runtime !== filter.runtime) continue;
			const sessionKey = `${source.node}\n${session.sessionId}`;
			const workspaceName = source.workspaceNames?.[session.workspaceId];
			const own = emptyUsageTotals();
			for (const entry of session.usage) {
				if (filter.since && entry.day < filter.since) continue;
				addEntry(own, entry);
				runtimes.add(session.runtime, agentRuntimeLabel(session.runtime), entry, sessionKey);
				const model = entry.model || "未知模型";
				models.add(
					`${entry.provider ?? ""}\n${entry.model}`,
					model,
					entry,
					sessionKey,
					entry.provider && entry.provider !== entry.model ? entry.provider : undefined,
				);
				workspaces.add(
					`${source.node}\n${session.workspaceId}`,
					workspaceName ?? "已移除的工作区",
					entry,
					sessionKey,
					sources.length > 1 ? source.nodeName : undefined,
				);
				nodes.add(source.node, source.nodeName, entry, sessionKey);
				let bucket = days.get(entry.day);
				if (!bucket) {
					bucket = { key: entry.day, total: 0, byRuntime: {} };
					days.set(entry.day, bucket);
				}
				const tokens = entryTokens(entry);
				bucket.total += tokens;
				bucket.byRuntime[session.runtime] = (bucket.byRuntime[session.runtime] ?? 0) + tokens;
				if (first === undefined || entry.day < first) first = entry.day;
			}
			if (own.requests === 0) continue;
			own.sessions = 1;
			sessions.push({
				...own,
				node: source.node,
				nodeName: source.nodeName,
				sessionId: session.sessionId,
				workspaceId: session.workspaceId,
				...(workspaceName ? { workspaceName } : {}),
				runtime: session.runtime,
				...(session.title ? { title: session.title } : {}),
				...(session.archived ? { archived: true } : {}),
				modifiedAt: session.modifiedAt,
			});
			totals.sessions++;
			totals.input += own.input;
			totals.output += own.output;
			totals.cacheRead += own.cacheRead;
			totals.cacheWrite += own.cacheWrite;
			totals.total += own.total;
			totals.requests += own.requests;
			totals.cost += own.cost;
			totals.uncostedRequests += own.uncostedRequests;
		}
	}
	const start = filter.since ?? first;
	const end = first !== undefined && first > today ? first : today;
	let buckets: UsageBucket[] = [];
	let granularity: UsageSummary["granularity"] = "day";
	if (start !== undefined) {
		const range = dayRange(start, end);
		if (range.length > 92) {
			granularity = "month";
			const months = new Map(
				monthRange(start, end).map((key) => [key, { key, total: 0, byRuntime: {} } as UsageBucket]),
			);
			for (const bucket of days.values()) {
				const month = months.get(bucket.key.slice(0, 7));
				if (!month) continue;
				month.total += bucket.total;
				for (const [runtime, tokens] of Object.entries(bucket.byRuntime)) {
					month.byRuntime[runtime] = (month.byRuntime[runtime] ?? 0) + (tokens ?? 0);
				}
			}
			buckets = [...months.values()];
		} else {
			buckets = range.map((key) => days.get(key) ?? { key, total: 0, byRuntime: {} });
		}
	}
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	return {
		totals,
		...(prompt > 0 ? { cacheHitRate: totals.cacheRead / prompt } : {}),
		byRuntime: runtimes.list(),
		byModel: models.list(),
		byWorkspace: workspaces.list(),
		byNode: nodes.list(),
		buckets,
		granularity,
		topSessions: sessions.sort((a, b) => b.total - a.total).slice(0, topSessions),
	};
}
