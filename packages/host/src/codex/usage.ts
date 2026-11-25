import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import type { UsageRecord } from "../runtimes/types.ts";
import { FileCache, fileLines, parseLine, timeOf, tokens } from "../runtimes/usage-files.ts";

/** What a rollout file tells about usage. */
export interface CodexRollout {
	records: UsageRecord[];
	/** Threads of sub-agents the thread started. */
	children: string[];
	/** The rollout is a sub-agent's. */
	subagent: boolean;
}

type Json = Record<string, unknown>;

const THREAD_ID = /"(?:agent_thread_id|receiver_thread_id)":"([0-9a-f-]{36})"/g;
const THREAD_IDS = /"receiver_thread_ids":\[([^\]]*)\]/g;

/** Codex counts cached prompt tokens in `input_tokens`; pi's `input` leaves them out. */
function codexRecord(usage: Json, at: number, model: string, provider: string | undefined): UsageRecord | undefined {
	const cacheRead = tokens(usage.cached_input_tokens);
	const cacheWrite = tokens(usage.cache_write_input_tokens);
	const record: UsageRecord = {
		at,
		model,
		...(provider ? { provider } : {}),
		input: Math.max(0, tokens(usage.input_tokens) - cacheRead - cacheWrite),
		output: tokens(usage.output_tokens),
		cacheRead,
		cacheWrite,
	};
	return record.input + record.output + record.cacheRead + record.cacheWrite > 0 ? record : undefined;
}

/**
 * The model requests of a Codex rollout file (`usage.stats`, 1.68). Newer Codex writes a
 * `token_usage_record` per response, with its `response_id`; older rollouts only have
 * `token_count` events, whose `last_token_usage` is the latest request (repeated when Codex
 * replays the usage of a resumed thread, which leaves the cumulative total unchanged). A
 * sub-agent's rollout starts with a copy of its parent's history, which is skipped.
 */
export async function readCodexRollout(path: string): Promise<CodexRollout> {
	const records: UsageRecord[] = [];
	const counted: UsageRecord[] = [];
	const children = new Set<string>();
	const models = new Map<string, string>();
	let model = "";
	let provider: string | undefined;
	let threadId: string | undefined;
	let historyStart = 0;
	let subagent = false;
	let lastTotal: number | undefined;
	let first = true;
	for await (const line of fileLines(path)) {
		const isFirst = first;
		first = false;
		if (line.includes("_thread_id")) {
			for (const match of line.matchAll(THREAD_ID)) children.add(match[1] as string);
			for (const match of line.matchAll(THREAD_IDS))
				for (const id of (match[1] as string).matchAll(/"([0-9a-f-]{36})"/g)) children.add(id[1] as string);
		}
		if (
			!isFirst &&
			!line.includes('"token_usage_record"') &&
			!line.includes('"token_count"') &&
			!line.includes('"turn_context"')
		)
			continue;
		const entry = parseLine(line);
		if (!entry) continue;
		const payload = (entry.payload ?? {}) as Json;
		if (isFirst && entry.type === "session_meta") {
			threadId = typeof payload.id === "string" ? payload.id : undefined;
			provider =
				typeof payload.model_provider === "string" && payload.model_provider ? payload.model_provider : undefined;
			historyStart = Number(payload.subagent_history_start_ordinal) || 0;
			const source = payload.source as Json | string | undefined;
			subagent = payload.thread_source === "subagent" || (typeof source === "object" && !!source?.subagent);
			continue;
		}
		// A sub-agent's copy of its parent's history.
		if (historyStart && Number(entry.ordinal) < historyStart) continue;
		const at = timeOf(entry.timestamp) ?? 0;
		if (entry.type === "turn_context") {
			if (typeof payload.model === "string" && payload.model) {
				model = payload.model;
				if (typeof payload.turn_id === "string") models.set(payload.turn_id, model);
			}
		} else if (entry.type === "token_usage_record") {
			if (threadId && typeof payload.thread_id === "string" && payload.thread_id !== threadId) continue;
			const usage = payload.usage as Json | undefined;
			if (!usage) continue;
			const turn = typeof payload.turn_id === "string" ? models.get(payload.turn_id) : undefined;
			const record = codexRecord(usage, at, turn ?? model, provider);
			if (!record) continue;
			if (typeof payload.response_id === "string" && payload.response_id) record.key = payload.response_id;
			records.push(record);
		} else if (entry.type === "event_msg" && payload.type === "token_count") {
			const info = payload.info as Json | null | undefined;
			const total = Number((info?.total_token_usage as Json | undefined)?.total_tokens);
			const last = info?.last_token_usage as Json | undefined;
			if (!last || !Number.isFinite(total) || total === lastTotal) continue;
			lastTotal = total;
			const record = codexRecord(last, at, model, provider);
			if (record) counted.push(record);
		}
	}
	if (threadId) children.delete(threadId);
	return { records: records.length > 0 ? records : counted, children: [...children], subagent };
}

/** Rollout files by thread id, from the names Codex gives them (`rollout-<time>-<thread id>.jsonl`). */
async function indexRollouts(root: string): Promise<Map<string, string>> {
	const index = new Map<string, string>();
	const walk = async (dir: string, depth: number): Promise<void> => {
		let names: { name: string; isDirectory(): boolean }[];
		try {
			names = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of names) {
			if (entry.isDirectory()) {
				if (depth < 3) await walk(join(dir, entry.name), depth + 1);
				continue;
			}
			const id = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(entry.name)?.[1];
			if (id) index.set(id, join(dir, entry.name));
		}
	};
	await walk(root, 0);
	return index;
}

/** How long an index of rollout files is trusted before a missing thread makes it read again. */
const INDEX_TTL_MS = 30_000;

/** Reads Codex rollouts with the rollouts of their sub-agents, cached by file. */
export class CodexUsageReader {
	private readonly files = new FileCache<CodexRollout>(() => ({ records: [], children: [], subagent: false }));
	private readonly indexes = new Map<string, { at: number; index: Promise<Map<string, string>> }>();

	/** `~/.codex/sessions` (or `archived_sessions`) of a rollout path, when it lies in one. */
	private static root(path: string): string | undefined {
		const match = new RegExp(`^(.*\\${sep}(?:sessions|archived_sessions))\\${sep}\\d{4}\\${sep}`).exec(path);
		return match?.[1];
	}

	private async locate(root: string, threadId: string): Promise<string | undefined> {
		let cached = this.indexes.get(root);
		if (!cached || Date.now() - cached.at > INDEX_TTL_MS) {
			cached = { at: Date.now(), index: indexRollouts(root) };
			this.indexes.set(root, cached);
		}
		const found = (await cached.index).get(threadId);
		if (found || Date.now() - cached.at < 1000) return found;
		// Started since the index was read.
		cached = { at: Date.now(), index: indexRollouts(root) };
		this.indexes.set(root, cached);
		return (await cached.index).get(threadId);
	}

	/** The requests of the thread at `path` and of the sub-agents it started, recursively. */
	async usage(path: string): Promise<UsageRecord[]> {
		const root = CodexUsageReader.root(path);
		const records: UsageRecord[] = [];
		const seen = new Set<string>([path]);
		const queue = [path];
		while (queue.length > 0 && seen.size <= 500) {
			const file = queue.shift() as string;
			const rollout = await this.files.read(file, readCodexRollout);
			// Threads it only talked to are sessions of their own.
			if (file !== path && !rollout.subagent) continue;
			records.push(...rollout.records);
			if (!root) continue;
			for (const child of rollout.children) {
				const childPath = await this.locate(root, child);
				if (childPath && !seen.has(childPath)) {
					seen.add(childPath);
					queue.push(childPath);
				}
			}
		}
		return records;
	}
}
