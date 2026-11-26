import type { AgentRuntimeId } from "./domain.ts";

/**
 * Token usage of one model on one day in a session (`usage.stats`, 1.68). Token counts follow pi:
 * `input` excludes the prompt tokens read from or written to the provider's cache, so the
 * tokens of a request are `input + output + cacheRead + cacheWrite`.
 */
export interface UsageEntry {
	/** Day in the requested time zone, `YYYY-MM-DD`. */
	day: string;
	/** Model id as the agent recorded it; `""` when unknown. */
	model: string;
	/** Provider of the model, when the agent recorded it. */
	provider?: string;
	/** Prompt tokens not read from or written to the cache. */
	input: number;
	output: number;
	/** Prompt tokens read from the provider's cache. */
	cacheRead: number;
	/** Prompt tokens written to the provider's cache. */
	cacheWrite: number;
	/** Cost in US dollars, when the agent recorded it for every request counted here. */
	cost?: number;
	/**
	 * Without `cost` (1.70): the cost in US dollars with the requests the agent recorded none for
	 * priced at the model's official price (pi's model catalog), when every one of them could be.
	 */
	estimatedCost?: number;
	/** Model requests (replies) counted. */
	requests: number;
}

/** A stored session of a workspace with its token usage (1.68). */
export interface UsageSession {
	sessionId: string;
	workspaceId: string;
	runtime: AgentRuntimeId;
	/** Session name, else the start of its first prompt. */
	title?: string;
	/** Set when the session was archived. */
	archived?: boolean;
	modifiedAt: string;
	/** Usage per day and model, including the session's subagents where the agent stores them. */
	usage: UsageEntry[];
}

/** Something that could not be read; the rest of the statistics are still valid (1.68). */
export interface UsageStatsError {
	workspaceId?: string;
	runtime?: AgentRuntimeId;
	sessionId?: string;
	message: string;
}

/** Token usage of the sessions of every workspace of a host (`usage.stats`, 1.68). */
export interface UsageStats {
	/** IANA time zone the days are in. */
	timeZone: string;
	/** When the host collected the statistics (ISO 8601). */
	generatedAt: string;
	/** Sessions with at least one request on or after `since`. */
	sessions: UsageSession[];
	/** Runtimes or sessions whose usage could not be read; omitted when everything was read. */
	errors?: UsageStatsError[];
}
