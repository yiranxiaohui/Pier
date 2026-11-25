import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { UsageRecord } from "../runtimes/types.ts";
import { tokens } from "../runtimes/usage-files.ts";

/** Sessions read for one stored session: itself and its subagents' (task) sessions. */
const MAX_SESSIONS = 200;

type Tokens = {
	input?: number;
	output?: number;
	reasoning?: number;
	total?: number;
	cache?: { read?: number; write?: number };
};

/**
 * One reply's usage. OpenCode counts reasoning apart from the output (and prices it as output);
 * when its `total` already includes the reasoning in `output`, it is not added again.
 */
export function opencodeRecord(info: {
	modelID?: string;
	providerID?: string;
	cost?: number;
	time?: { created?: number };
	tokens?: Tokens;
}): UsageRecord | undefined {
	const t = info.tokens ?? {};
	const input = tokens(t.input);
	const cacheRead = tokens(t.cache?.read);
	const cacheWrite = tokens(t.cache?.write);
	const reasoning = tokens(t.reasoning);
	let output = tokens(t.output);
	const total = tokens(t.total);
	if (!(total > 0 && total === input + output + cacheRead + cacheWrite)) output += reasoning;
	if (input + output + cacheRead + cacheWrite === 0) return undefined;
	const at = tokens(info.time?.created);
	const model = info.modelID ?? "";
	const record: UsageRecord = {
		at,
		model,
		...(info.providerID ? { provider: info.providerID } : {}),
		input,
		output,
		cacheRead,
		cacheWrite,
		// A fork copies replies; their time and usage stay the same.
		key: `${info.providerID ?? ""}/${model}:${at}:${input}:${output}:${cacheRead}:${cacheWrite}`,
	};
	if (typeof info.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0 && !(info.cost === 0 && output > 0))
		record.cost = info.cost;
	return record;
}

/** The replies of an OpenCode session and of the sessions its subagents ran in, from its server. */
export async function opencodeSessionUsage(
	client: OpencodeClient,
	directory: string,
	sessionID: string,
): Promise<UsageRecord[]> {
	const records: UsageRecord[] = [];
	const seen = new Set<string>([sessionID]);
	const queue = [sessionID];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		const [{ data: messages }, { data: children }] = await Promise.all([
			client.session.messages({ directory, sessionID: id }, { throwOnError: true }),
			client.session.children({ directory, sessionID: id }, { throwOnError: true }),
		]);
		for (const { info } of messages) {
			if (info.role !== "assistant") continue;
			const record = opencodeRecord(info);
			if (record) records.push(record);
		}
		for (const child of children) {
			if (seen.has(child.id) || seen.size >= MAX_SESSIONS) continue;
			seen.add(child.id);
			queue.push(child.id);
		}
	}
	return records;
}
