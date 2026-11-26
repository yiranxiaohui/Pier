import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRecord } from "../runtimes/types.ts";
import { type FileUsageCache, fileLines, parseLine, timeOf, tokens } from "../runtimes/usage-files.ts";

/**
 * The model replies of a Claude Code transcript (`usage.stats`, 1.68). Claude Code writes a reply
 * as several lines (one per content block) that repeat its `message.id` and usage; the last line
 * of a reply has its final usage. Sidechain lines (subagents of older versions) count too.
 */
export async function readClaudeUsage(path: string): Promise<UsageRecord[]> {
	const replies = new Map<string, UsageRecord>();
	let unnamed = 0;
	for await (const line of fileLines(path)) {
		if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
		const entry = parseLine(line);
		if (entry?.type !== "assistant") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		const usage = message?.usage as Record<string, unknown> | undefined;
		if (!message || !usage || typeof usage !== "object") continue;
		const model = typeof message.model === "string" ? message.model : "";
		// Claude Code's own notices (API errors, interruptions) are not model replies.
		if (model === "<synthetic>") continue;
		const record: UsageRecord = {
			at: timeOf(entry.timestamp) ?? 0,
			model,
			input: tokens(usage.input_tokens),
			output: tokens(usage.output_tokens),
			cacheRead: tokens(usage.cache_read_input_tokens),
			cacheWrite: tokens(usage.cache_creation_input_tokens),
		};
		if (record.input + record.output + record.cacheRead + record.cacheWrite === 0) continue;
		// Only the price of a request depends on these.
		const creation = usage.cache_creation as Record<string, unknown> | undefined;
		const longWrite = Math.min(tokens(creation?.ephemeral_1h_input_tokens), record.cacheWrite);
		if (longWrite > 0) record.cacheWrite1h = longWrite;
		if (usage.speed === "fast") record.fast = true;
		// Forks and resumed sessions copy replies with their `message.id`.
		const id = typeof message.id === "string" && message.id ? message.id : undefined;
		const key = id ?? `#${unnamed++}`;
		const earlier = replies.get(key);
		// The first line's time is when the reply started; later lines carry the complete usage.
		if (earlier) record.at = earlier.at || record.at;
		if (id) record.key = key;
		replies.set(key, record);
	}
	return [...replies.values()];
}

/**
 * The replies of a Claude Code session and of its subagents, whose transcripts Claude Code keeps
 * in `<session>/subagents/agent-*.jsonl` next to the session file.
 */
export async function claudeSessionUsage(path: string, cache: FileUsageCache): Promise<UsageRecord[]> {
	const records = [...(await cache.read(path, readClaudeUsage))];
	const subagents = join(path.replace(/\.jsonl$/, ""), "subagents");
	let names: string[] = [];
	try {
		names = await readdir(subagents);
	} catch {
		// No subagents.
	}
	for (const name of names.sort()) {
		if (name.startsWith("agent-") && name.endsWith(".jsonl"))
			records.push(...(await cache.read(join(subagents, name), readClaudeUsage)));
	}
	return records;
}
