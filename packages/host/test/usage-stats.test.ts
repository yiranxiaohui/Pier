import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeSessionUsage, readClaudeUsage } from "../src/claude/usage.ts";
import { CodexUsageReader, readCodexRollout } from "../src/codex/usage.ts";
import { hermesDatabases, readHermesUsage } from "../src/hermes/usage.ts";
import { opencodeRecord } from "../src/opencode/usage.ts";
import { piSessionUsage, readPiUsage } from "../src/pi/usage.ts";
import type { AgentRuntime, StoredSession, UsageRecord } from "../src/runtimes/types.ts";
import { FileUsageCache } from "../src/runtimes/usage-files.ts";
import { dayFormatter, UsageStatsCollector, usageEntries } from "../src/usage-stats.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pier-usage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function jsonl(path: string, lines: unknown[]): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return path;
}

const T0 = Date.UTC(2026, 10, 24, 15, 30); // 2026-11-24 23:30 in Shanghai

describe("pi usage", () => {
	const reply = (id: string, responseId: string | undefined, at: number, usage: Record<string, unknown>) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			provider: "claude",
			model: "claude-opus-5-5",
			usage,
			timestamp: at,
			...(responseId ? { responseId } : {}),
		},
	});

	it("reads replies, compactions and usage entries; zero costs count as unknown", async () => {
		const path = jsonl(join(dir, "s.jsonl"), [
			{ type: "session", version: 3, id: "s1", timestamp: new Date(T0).toISOString(), cwd: dir },
			{
				type: "model_change",
				id: "m1",
				timestamp: new Date(T0).toISOString(),
				provider: "claude",
				modelId: "claude-opus-5-5",
			},
			{ type: "message", id: "u1", timestamp: new Date(T0).toISOString(), message: { role: "user", content: "hi" } },
			reply("a1", "msg_1", T0, { input: 4, output: 100, cacheRead: 1000, cacheWrite: 50, cost: { total: 0.25 } }),
			reply("a2", undefined, T0 + 1000, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
			reply("a3", "msg_3", T0 + 2000, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
			{ type: "compaction", id: "c1", timestamp: new Date(T0 + 3000).toISOString(), usage: { input: 500, output: 80 } },
			{
				type: "usage",
				id: "w1",
				timestamp: new Date(T0 + 4000).toISOString(),
				kind: "cache_warm",
				provider: "x",
				model: "y",
				usage: { input: 0, output: 1, cacheRead: 900 },
			},
		]);
		const records = await readPiUsage(path);
		expect(records).toEqual([
			{
				at: T0,
				model: "claude-opus-5-5",
				provider: "claude",
				input: 4,
				output: 100,
				cacheRead: 1000,
				cacheWrite: 50,
				cost: 0.25,
				key: "msg_1",
			},
			{
				at: T0 + 1000,
				model: "claude-opus-5-5",
				provider: "claude",
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				key: `a2:${new Date(T0 + 1000).toISOString()}`,
			},
			expect.objectContaining({ at: T0 + 3000, model: "claude-opus-5-5", input: 500, output: 80 }),
			expect.objectContaining({ at: T0 + 4000, model: "y", provider: "x", output: 1, cacheRead: 900 }),
		]);
	});

	it("adds the session files of pi-subagents' child runs", async () => {
		const path = jsonl(join(dir, "2026_s1.jsonl"), [reply("a1", "msg_1", T0, { input: 1, output: 10 })]);
		// A forked child copies the parent's reply before its own.
		jsonl(join(dir, "2026_s1", "run-x", "run-0", "session.jsonl"), [
			reply("a1", "msg_1", T0, { input: 1, output: 10 }),
			reply("b1", "msg_2", T0 + 5000, { input: 2, output: 20 }),
		]);
		const records = await piSessionUsage(path, new FileUsageCache());
		expect(records.map((r) => r.key)).toEqual(["msg_1", "msg_1", "msg_2"]);
	});
});

describe("Claude Code usage", () => {
	const line = (id: string, at: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		type: "assistant",
		timestamp: new Date(at).toISOString(),
		uuid: `${id}-${at}`,
		message: { id, model: "claude-opus-5-5", usage, content: [] },
		...extra,
	});

	it("counts each reply once, even when its lines are not adjacent", async () => {
		const usage = {
			input_tokens: 2,
			output_tokens: 300,
			cache_read_input_tokens: 5000,
			cache_creation_input_tokens: 40,
		};
		const path = jsonl(join(dir, "c.jsonl"), [
			{ type: "user", message: { role: "user", content: "hi" } },
			line("msg_1", T0, usage),
			{ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } },
			line("msg_1", T0 + 900, usage),
			line("msg_err", T0 + 1000, { input_tokens: 0, output_tokens: 0 }, {}),
			{
				...line("x", T0 + 1100, { input_tokens: 9, output_tokens: 9 }),
				message: { id: "x", model: "<synthetic>", usage: { input_tokens: 9, output_tokens: 9 } },
			},
			line("msg_2", T0 + 2000, { input_tokens: 1, output_tokens: 7 }, { isSidechain: true }),
		]);
		expect(await readClaudeUsage(path)).toEqual([
			{ at: T0, model: "claude-opus-5-5", input: 2, output: 300, cacheRead: 5000, cacheWrite: 40, key: "msg_1" },
			{ at: T0 + 2000, model: "claude-opus-5-5", input: 1, output: 7, cacheRead: 0, cacheWrite: 0, key: "msg_2" },
		]);
	});

	it("notes 1-hour cache writes and fast mode, which change the price", async () => {
		const path = jsonl(join(dir, "p.jsonl"), [
			line("msg_1", T0, {
				input_tokens: 1,
				output_tokens: 2,
				cache_creation_input_tokens: 900,
				cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 600 },
				speed: "fast",
			}),
			line("msg_2", T0, {
				input_tokens: 1,
				output_tokens: 2,
				cache_creation_input_tokens: 5,
				cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 },
				speed: "standard",
			}),
		]);
		const [fast, standard] = await readClaudeUsage(path);
		expect(fast).toMatchObject({ cacheWrite: 900, cacheWrite1h: 600, fast: true });
		expect(standard).not.toHaveProperty("cacheWrite1h");
		expect(standard).not.toHaveProperty("fast");
	});

	it("adds the transcripts of the session's subagents", async () => {
		const path = jsonl(join(dir, "abc.jsonl"), [line("msg_1", T0, { input_tokens: 1, output_tokens: 1 })]);
		jsonl(join(dir, "abc", "subagents", "agent-a1.jsonl"), [line("msg_s", T0, { input_tokens: 3, output_tokens: 4 })]);
		writeFileSync(join(dir, "abc", "subagents", "agent-a1.meta.json"), "{}");
		const records = await claudeSessionUsage(path, new FileUsageCache());
		expect(records.map((r) => r.key)).toEqual(["msg_1", "msg_s"]);
	});
});

describe("Codex usage", () => {
	const ID = "01a1c36c-fbad-7af2-be24-ab44b0fb09bb";
	const CHILD = "01a1c36d-2212-70c0-8cc0-063dad2c7eea";
	const usage = (input: number, cached: number, output: number) => ({
		input_tokens: input,
		cached_input_tokens: cached,
		cache_write_input_tokens: 0,
		output_tokens: output,
		total_tokens: input + output,
	});
	const at = (s: number) => new Date(T0 + s * 1000).toISOString();

	it("reads token_usage_record lines with the model of their turn and leaves cached tokens out of input", async () => {
		const path = jsonl(join(dir, "sessions", "2026", "11", "24", `rollout-2026-11-24T23-30-00-${ID}.jsonl`), [
			{ timestamp: at(0), type: "session_meta", payload: { id: ID, model_provider: "openai" } },
			{ timestamp: at(1), type: "turn_context", payload: { turn_id: "t1", model: "gpt-6.1-sol" } },
			{
				timestamp: at(2),
				type: "token_usage_record",
				payload: { thread_id: ID, turn_id: "t1", response_id: "resp_1", usage: usage(1000, 800, 50) },
			},
			{
				timestamp: at(2),
				type: "event_msg",
				payload: {
					type: "token_count",
					info: { total_token_usage: usage(1000, 800, 50), last_token_usage: usage(1000, 800, 50) },
				},
			},
			{
				timestamp: at(3),
				type: "event_msg",
				payload: { type: "item_completed", item: { type: "SubAgentActivity", agent_thread_id: CHILD } },
			},
		]);
		const rollout = await readCodexRollout(path);
		expect(rollout).toEqual({
			records: [
				{
					at: T0 + 2000,
					model: "gpt-6.1-sol",
					provider: "openai",
					input: 200,
					output: 50,
					cacheRead: 800,
					cacheWrite: 0,
					key: "resp_1",
				},
			],
			children: [CHILD],
			subagent: false,
		});
	});

	it("falls back to token_count events, skipping replays, and adds sub-agent rollouts without their copied history", async () => {
		const root = join(dir, "sessions");
		const parent = jsonl(join(root, "2026", "11", "24", `rollout-2026-11-24T23-30-00-${ID}.jsonl`), [
			{ timestamp: at(0), type: "session_meta", payload: { id: ID } },
			{ timestamp: at(1), type: "turn_context", payload: { model: "gpt-5" } },
			{
				timestamp: at(2),
				type: "event_msg",
				payload: {
					type: "token_count",
					info: { total_token_usage: usage(100, 0, 10), last_token_usage: usage(100, 0, 10) },
				},
			},
			// Replayed when the thread was resumed: the total does not change.
			{
				timestamp: at(3),
				type: "event_msg",
				payload: {
					type: "token_count",
					info: { total_token_usage: usage(100, 0, 10), last_token_usage: usage(100, 0, 10) },
				},
			},
			{ timestamp: at(4), type: "event_msg", payload: { type: "token_count", info: null } },
			{
				timestamp: at(5),
				type: "event_msg",
				payload: {
					type: "token_count",
					info: { total_token_usage: usage(250, 0, 30), last_token_usage: usage(150, 0, 20) },
				},
			},
			{ timestamp: at(6), type: "response_item", payload: { type: "function_call", receiver_thread_ids: [CHILD] } },
		]);
		jsonl(join(root, "2026", "11", "25", `rollout-2026-11-25T00-00-00-${CHILD}.jsonl`), [
			{
				timestamp: at(7),
				type: "session_meta",
				payload: { id: CHILD, thread_source: "subagent", subagent_history_start_ordinal: 3 },
			},
			{ timestamp: at(7), ordinal: 1, type: "turn_context", payload: { model: "gpt-5" } },
			{
				timestamp: at(7),
				ordinal: 2,
				type: "event_msg",
				payload: {
					type: "token_count",
					info: { total_token_usage: usage(100, 0, 10), last_token_usage: usage(100, 0, 10) },
				},
			},
			{ timestamp: at(8), ordinal: 3, type: "turn_context", payload: { model: "gpt-5-mini" } },
			{
				timestamp: at(9),
				ordinal: 4,
				type: "event_msg",
				payload: {
					type: "token_count",
					info: { total_token_usage: usage(40, 0, 4), last_token_usage: usage(40, 0, 4) },
				},
			},
		]);
		const records = await new CodexUsageReader().usage(parent);
		expect(records.map((r) => [r.model, r.input, r.output])).toEqual([
			["gpt-5", 100, 10],
			["gpt-5", 150, 20],
			["gpt-5-mini", 40, 4],
		]);
	});
});

describe("OpenCode usage", () => {
	it("adds reasoning to the output unless the total already includes it", () => {
		const base = { modelID: "m", providerID: "p", time: { created: T0 }, cost: 0.5 };
		expect(
			opencodeRecord({ ...base, tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 100, write: 0 } } }),
		).toMatchObject({
			input: 10,
			output: 8,
			cacheRead: 100,
			cost: 0.5,
			provider: "p",
		});
		expect(
			opencodeRecord({
				...base,
				tokens: { input: 10, output: 5, reasoning: 3, total: 115, cache: { read: 100, write: 0 } },
			}),
		).toMatchObject({ output: 5 });
		expect(
			opencodeRecord({ ...base, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
		).toBeUndefined();
	});
});

describe("Hermes usage", () => {
	it("reads a session and its delegated sessions from state.db, per model when Hermes has it", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		mkdirSync(join(dir, "profiles", "work"), { recursive: true });
		const path = join(dir, "profiles", "work", "state.db");
		const db = new DatabaseSync(path);
		db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, billing_provider TEXT, parent_session_id TEXT,
			started_at REAL, ended_at REAL, last_activity_at REAL, input_tokens INTEGER, output_tokens INTEGER,
			cache_read_tokens INTEGER, cache_write_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER);
			CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, api_call_count INTEGER,
			input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, estimated_cost_usd REAL);`);
		const start = T0 / 1000;
		db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
			"root",
			"deepseek-v4",
			"deepseek",
			null,
			start,
			null,
			start + 60,
			100,
			20,
			300,
			0,
			0.01,
			null,
			3,
		);
		db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
			"child",
			"kimi",
			"moonshot",
			"root",
			start + 10,
			start + 30,
			null,
			7,
			8,
			0,
			0,
			0,
			null,
			1,
		);
		db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
			"other",
			"kimi",
			"moonshot",
			null,
			start,
			null,
			null,
			1,
			1,
			0,
			0,
			0,
			null,
			1,
		);
		db.prepare("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)").run(
			"root",
			"deepseek-v4",
			"deepseek",
			2,
			60,
			15,
			300,
			0,
			0.008,
		);
		db.prepare("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)").run(
			"root",
			"deepseek-v4-flash",
			"deepseek",
			1,
			40,
			5,
			0,
			0,
			0.002,
		);
		db.close();

		expect(await hermesDatabases(dir)).toEqual([path]);
		const records = await readHermesUsage(path, "root");
		expect(records).toEqual([
			{
				at: (start + 60) * 1000,
				model: "deepseek-v4",
				provider: "deepseek",
				input: 60,
				output: 15,
				cacheRead: 300,
				cacheWrite: 0,
				requests: 2,
				cost: 0.008,
				key: "root\ndeepseek-v4",
			},
			{
				at: (start + 60) * 1000,
				model: "deepseek-v4-flash",
				provider: "deepseek",
				input: 40,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				requests: 1,
				cost: 0.002,
				key: "root\ndeepseek-v4-flash",
			},
			{
				at: (start + 30) * 1000,
				model: "kimi",
				provider: "moonshot",
				input: 7,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				requests: 1,
				key: "child\nkimi",
			},
		]);
		expect(await readHermesUsage(path, "missing")).toBeUndefined();
	});
});

describe("usage statistics", () => {
	const workspace = (id: string): WorkspaceInfo => ({ id, name: id, path: `/w/${id}`, policy: "smart", addedAt: "" });
	const stored = (id: string, created: number, name?: string): StoredSession => ({
		id,
		cwd: "/w",
		created: new Date(created),
		modified: new Date(created + 1000),
		messageCount: 2,
		firstMessage: `first prompt of ${id}`,
		...(name ? { name } : {}),
	});
	const record = (at: number, output: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({
		at,
		model: "m1",
		input: 1,
		output,
		cacheRead: 10,
		cacheWrite: 0,
		...extra,
	});

	function runtime(id: string, usage: Record<string, UsageRecord[] | Error>): AgentRuntime {
		return {
			id,
			usage: async (_w: WorkspaceInfo, s: StoredSession) => {
				const value = usage[s.id] ?? [];
				if (value instanceof Error) throw value;
				return value;
			},
		} as unknown as AgentRuntime;
	}

	it("buckets days in the requested time zone", () => {
		expect(dayFormatter("Asia/Shanghai")(T0)).toBe("2026-11-24");
		expect(dayFormatter("Asia/Shanghai")(T0 + 30 * 60_000)).toBe("2026-11-25");
		expect(dayFormatter("UTC")(T0 + 30 * 60_000)).toBe("2026-11-24");
		expect(dayFormatter("Asia/Kolkata")(Date.UTC(2026, 10, 24, 18, 29))).toBe("2026-11-24");
		expect(dayFormatter("Asia/Kolkata")(Date.UTC(2026, 10, 24, 18, 31))).toBe("2026-11-25");
		expect(() => dayFormatter("Mars/Base")).toThrow(/time zone/);
	});

	it("sums records per day and model, and keeps costs only when every request has one", () => {
		const dayOf = dayFormatter("UTC");
		const entries = usageEntries(
			[
				record(T0, 5, { cost: 0.1 }),
				record(T0 + 1000, 7, { cost: 0.2 }),
				record(T0 + 2000, 1, { model: "m2", requests: 3 }),
				record(T0 + 2000, 1, { model: "m2", cost: 1 }),
				record(T0 - 86_400_000, 100),
			],
			dayOf,
			"2026-11-24",
		);
		expect(entries).toEqual([
			{
				day: "2026-11-24",
				model: "m1",
				input: 2,
				output: 12,
				cacheRead: 20,
				cacheWrite: 0,
				cost: expect.closeTo(0.3),
				requests: 2,
			},
			{ day: "2026-11-24", model: "m2", input: 2, output: 2, cacheRead: 20, cacheWrite: 0, requests: 4 },
		]);
	});

	it("estimates the cost of requests without one when every one of them has a price", () => {
		const dayOf = dayFormatter("UTC");
		const prices = { cost: (r: UsageRecord) => (r.model === "unpriced" || r.fast ? undefined : r.output / 100) };
		const entries = usageEntries(
			[
				record(T0, 5, { cost: 0.1 }),
				record(T0, 7),
				record(T0, 50, { model: "m2", cost: 1 }),
				record(T0, 3, { model: "unpriced" }),
				record(T0, 4, { model: "m3" }),
				record(T0, 4, { model: "m3", fast: true }),
			],
			dayOf,
			undefined,
			prices,
		);
		const byModel = Object.fromEntries(
			entries.map(({ model, cost, estimatedCost }) => [model, { cost, estimatedCost }]),
		);
		expect(byModel).toEqual({
			// Recorded costs count as they are, the rest at the official price.
			m1: { cost: undefined, estimatedCost: expect.closeTo(0.17) },
			m2: { cost: 1, estimatedCost: undefined },
			// One request without a price leaves the whole entry without a cost.
			unpriced: { cost: undefined, estimatedCost: undefined },
			m3: { cost: undefined, estimatedCost: undefined },
		});
	});

	it("collects every workspace, counts copied requests once and reports what failed", async () => {
		const pi = runtime("pi", {
			old: [record(T0, 5, { key: "r1" }), record(T0 + 1000, 6, { key: "r2" })],
			fork: [record(T0, 5, { key: "r1" }), record(T0 + 5000, 9, { key: "r3" })],
			empty: [],
		});
		const claude = runtime("claude-code", { c1: [record(T0, 4, { key: "r1" })], broken: new Error("bad file") });
		const sessions: Record<string, { runtime: AgentRuntime; stored: StoredSession }[]> = {
			a: [
				{ runtime: pi, stored: stored("fork", T0 + 4000) },
				{ runtime: pi, stored: stored("old", T0 - 1000, "Old one") },
				{ runtime: pi, stored: stored("empty", T0) },
			],
			b: [
				{ runtime: claude, stored: stored("c1", T0) },
				{ runtime: claude, stored: stored("broken", T0) },
			],
		};
		const collector = new UsageStatsCollector({
			workspaces: () => [workspace("a"), workspace("b"), workspace("gone")],
			storedSessions: async (w) => {
				if (w.id === "gone") throw new Error("listing failed");
				return sessions[w.id] ?? [];
			},
			isArchived: (id) => id === "old",
		});
		const stats = await collector.stats({ timeZone: "UTC" });
		expect(stats.timeZone).toBe("UTC");
		const byId = Object.fromEntries(stats.sessions.map((s) => [s.sessionId, s]));
		expect(Object.keys(byId).sort()).toEqual(["c1", "fork", "old"]);
		expect(byId.old).toMatchObject({ workspaceId: "a", runtime: "pi", title: "Old one", archived: true });
		expect(byId.old?.usage).toEqual([expect.objectContaining({ day: "2026-11-24", output: 11, requests: 2 })]);
		// The fork's copy of r1 counts for the older session only; Claude Code's r1 is another runtime's.
		expect(byId.fork).toMatchObject({ title: "first prompt of fork" });
		expect(byId.fork?.usage).toEqual([expect.objectContaining({ output: 9, requests: 1 })]);
		expect(byId.c1?.usage).toEqual([expect.objectContaining({ output: 4, requests: 1 })]);
		expect(stats.errors).toEqual(
			expect.arrayContaining([
				{ workspaceId: "gone", message: "listing failed" },
				{ workspaceId: "b", runtime: "claude-code", sessionId: "broken", message: "bad file" },
			]),
		);

		const later = await collector.stats({ timeZone: "UTC", since: "2026-11-25" });
		expect(later.sessions).toEqual([]);
	});

	it("prices requests with the source's prices, and without them when they cannot be read", async () => {
		const pi = runtime("pi", { s: [record(T0, 5)] });
		const source = {
			workspaces: () => [workspace("a")],
			storedSessions: async () => [{ runtime: pi, stored: stored("s", T0) }],
			isArchived: () => false,
		};
		const priced = await new UsageStatsCollector({ ...source, prices: () => ({ cost: () => 0.25 }) }).stats({
			timeZone: "UTC",
		});
		expect(priced.sessions[0]?.usage).toEqual([expect.objectContaining({ estimatedCost: 0.25 })]);
		const logs: string[] = [];
		const broken = await new UsageStatsCollector({
			...source,
			prices: () => {
				throw new Error("no catalog");
			},
			log: (line) => logs.push(line),
		}).stats({ timeZone: "UTC" });
		expect(broken.sessions[0]?.usage[0]).not.toHaveProperty("estimatedCost");
		expect(logs).toEqual(["reading model prices failed: no catalog"]);
	});

	it("reads changed files again and unchanged ones from the cache", async () => {
		const path = jsonl(join(dir, "s.jsonl"), [
			{
				type: "message",
				id: "a",
				timestamp: "",
				message: { role: "assistant", model: "m", usage: { output: 1 }, timestamp: T0 },
			},
		]);
		const cache = new FileUsageCache();
		let reads = 0;
		const parse = async (p: string) => {
			reads++;
			return readPiUsage(p);
		};
		expect(await cache.read(path, parse)).toHaveLength(1);
		expect(await cache.read(path, parse)).toHaveLength(1);
		expect(reads).toBe(1);
		jsonl(path, [
			{
				type: "message",
				id: "a",
				timestamp: "",
				message: { role: "assistant", model: "m", usage: { output: 1 }, timestamp: T0 },
			},
			{
				type: "message",
				id: "b",
				timestamp: "",
				message: { role: "assistant", model: "m", usage: { output: 2 }, timestamp: T0 },
			},
		]);
		utimesSync(path, new Date(T0 + 60_000), new Date(T0 + 60_000));
		expect(await cache.read(path, parse)).toHaveLength(2);
		expect(reads).toBe(2);
		expect(await cache.read(join(dir, "missing.jsonl"), parse)).toEqual([]);
	});
});
