import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRecord } from "../runtimes/types.ts";
import { type FileUsageCache, fileLines, parseLine, timeOf, tokens } from "../runtimes/usage-files.ts";

type Json = Record<string, unknown>;

/**
 * The cost pi recorded for a request. pi writes 0 when it has no prices for the model (custom
 * providers), which is not a cost: such requests count as having none.
 */
function piCost(usage: Json, tokenCount: number): number | undefined {
	const cost = usage.cost;
	const total = Number(typeof cost === "number" ? cost : (cost as Json | undefined)?.total);
	if (!Number.isFinite(total) || total < 0) return undefined;
	return total === 0 && tokenCount > 0 ? undefined : total;
}

function piRecord(usage: Json, at: number, model: string, provider: string | undefined): UsageRecord | undefined {
	const record: UsageRecord = {
		at,
		model,
		...(provider ? { provider } : {}),
		input: tokens(usage.input),
		output: tokens(usage.output),
		cacheRead: tokens(usage.cacheRead),
		cacheWrite: tokens(usage.cacheWrite),
	};
	const total = record.input + record.output + record.cacheRead + record.cacheWrite;
	// Aborted or failed requests before any reply carry no usage.
	if (total === 0) return undefined;
	const cost = piCost(usage, total);
	if (cost !== undefined) record.cost = cost;
	return record;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/**
 * The model requests of a pi session file (`usage.stats`, 1.68): replies, plus the requests pi
 * records apart from them (`usage` entries such as cache warming, and the summaries of
 * compactions and branch summaries). Every branch counts: abandoned branches were requests too.
 * A fork copies the entries before the fork point with their ids, times and `responseId`, so
 * the copies are recognised and count for the session they were made in.
 */
export async function readPiUsage(path: string): Promise<UsageRecord[]> {
	const records: UsageRecord[] = [];
	let model = "";
	let provider: string | undefined;
	for await (const line of fileLines(path)) {
		const modelChange = line.includes('"model_change"');
		if (!modelChange && !line.includes('"usage"')) continue;
		const entry = parseLine(line);
		if (!entry) continue;
		const at = timeOf(entry.timestamp) ?? 0;
		const entryKey = `${String(entry.id)}:${String(entry.timestamp)}`;
		if (entry.type === "model_change") {
			model = text(entry.modelId) ?? model;
			provider = text(entry.provider) ?? provider;
			continue;
		}
		if (entry.type === "message") {
			const message = entry.message as Json | undefined;
			const usage = message?.usage as Json | undefined;
			if (message?.role !== "assistant" || !usage || typeof usage !== "object") continue;
			model = text(message.model) ?? model;
			provider = text(message.provider) ?? provider;
			const record = piRecord(usage, timeOf(message.timestamp) ?? at, model, provider);
			if (!record) continue;
			record.key = text(message.responseId) ?? entryKey;
			records.push(record);
		} else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
			const usage = entry.usage as Json | undefined;
			if (!usage || typeof usage !== "object") continue;
			const record = piRecord(usage, at, text(entry.model) ?? model, text(entry.provider) ?? provider);
			if (!record) continue;
			record.key = entryKey;
			records.push(record);
		}
	}
	return records;
}

/** Session files of the subagents of `pi-subagents`: under `<session>/` beside the session file. */
async function childSessionFiles(dir: string, depth: number): Promise<string[]> {
	let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		else if (entry.isDirectory() && depth > 0) files.push(...(await childSessionFiles(path, depth - 1)));
	}
	return files;
}

/**
 * The requests of a pi session and of its subagents. `pi-subagents` keeps a child run's session
 * in `<session dir>/<session file name>/<run>/…/*.jsonl` (forked children copy the parent's
 * entries, which are recognised as copies).
 */
export async function piSessionUsage(path: string, cache: FileUsageCache): Promise<UsageRecord[]> {
	const records = [...(await cache.read(path, readPiUsage))];
	if (!path.endsWith(".jsonl")) return records;
	for (const file of await childSessionFiles(path.slice(0, -".jsonl".length), 4)) {
		records.push(...(await cache.read(file, readPiUsage)));
	}
	return records;
}
