import type { UsageEntry, UsageStats } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	emptyUsageTotals,
	localDay,
	summarizeUsage,
	type UsageSource,
	type UsageTotals,
	usageCostNote,
	usageCostText,
	usageSince,
} from "../src/usage-stats.ts";

const entry = (day: string, model: string, tokens: number, extra: Partial<UsageEntry> = {}): UsageEntry => ({
	day,
	model,
	input: tokens,
	output: tokens,
	cacheRead: tokens * 8,
	cacheWrite: 0,
	requests: 1,
	...extra,
});

function source(node: string, sessions: UsageStats["sessions"]): UsageSource {
	return {
		node,
		nodeName: node === "local" ? "本机" : "服务器",
		stats: { timeZone: "UTC", generatedAt: "", sessions },
		workspaceNames: { w1: "Pier", w2: "Docs" },
	};
}

const sources = [
	source("local", [
		{
			sessionId: "s1",
			workspaceId: "w1",
			runtime: "pi",
			title: "Refactor",
			modifiedAt: "2026-11-25T10:00:00Z",
			usage: [
				entry("2026-11-20", "claude-opus-5-5", 10, { provider: "claude", cost: 0.5 }),
				entry("2026-11-25", "claude-opus-5-5", 100, { provider: "claude", cost: 2, requests: 3 }),
			],
		},
		{
			sessionId: "s2",
			workspaceId: "w2",
			runtime: "claude-code",
			modifiedAt: "2026-11-24T10:00:00Z",
			usage: [entry("2026-11-24", "claude-opus-5-5", 50)],
		},
	]),
	source("peer", [
		{
			sessionId: "s3",
			workspaceId: "w9",
			runtime: "codex",
			archived: true,
			modifiedAt: "2026-11-23T10:00:00Z",
			usage: [entry("2026-11-23", "gpt-6.1-sol", 20, { provider: "openai", estimatedCost: 0.75 })],
		},
	]),
];

describe("summarizeUsage", () => {
	it("sums every computer by agent, model, workspace and computer", () => {
		const summary = summarizeUsage(sources, {}, "2026-11-25");
		expect(summary.totals).toEqual({
			input: 180,
			output: 180,
			cacheRead: 1440,
			cacheWrite: 0,
			total: 1800,
			requests: 6,
			sessions: 3,
			// Codex's estimate counts towards the cost; Claude Code's request has none.
			cost: 3.25,
			estimatedCost: 0.75,
			estimatedRequests: 1,
			uncostedRequests: 1,
		});
		expect(summary.cacheHitRate).toBeCloseTo(1440 / 1620);
		expect(summary.byRuntime.map((g) => [g.key, g.label, g.total, g.sessions])).toEqual([
			["pi", "PI", 1100, 1],
			["claude-code", "Claude Code", 500, 1],
			["codex", "Codex", 200, 1],
		]);
		// The same model id from another provider is another model.
		expect(summary.byModel.map((g) => [g.label, g.detail, g.total, g.sessions])).toEqual([
			["claude-opus-5-5", "claude", 1100, 1],
			["claude-opus-5-5", undefined, 500, 1],
			["gpt-6.1-sol", "openai", 200, 1],
		]);
		expect(summary.byWorkspace.map((g) => [g.label, g.detail])).toEqual([
			["Pier", "本机"],
			["Docs", "本机"],
			["已移除的工作区", "服务器"],
		]);
		expect(summary.byNode.map((g) => [g.key, g.total])).toEqual([
			["local", 1600],
			["peer", 200],
		]);
		expect(summary.topSessions.map((s) => [s.sessionId, s.total, s.workspaceName])).toEqual([
			["s1", 1100, "Pier"],
			["s2", 500, "Docs"],
			["s3", 200, undefined],
		]);
		expect(summary.topSessions[2]).toMatchObject({ archived: true, nodeName: "服务器" });
		expect(summary.granularity).toBe("day");
		expect(summary.buckets.map((b) => b.key)).toEqual([
			"2026-11-20",
			"2026-11-21",
			"2026-11-22",
			"2026-11-23",
			"2026-11-24",
			"2026-11-25",
		]);
		expect(summary.buckets[3]).toEqual({ key: "2026-11-23", total: 200, byRuntime: { codex: 200 } });
	});

	it("filters by day, computer and agent", () => {
		const recent = summarizeUsage(sources, { since: "2026-11-24" }, "2026-11-25");
		expect(recent.totals).toMatchObject({ total: 1500, sessions: 2, requests: 4 });
		expect(recent.buckets.map((b) => [b.key, b.total])).toEqual([
			["2026-11-24", 500],
			["2026-11-25", 1000],
		]);
		expect(summarizeUsage(sources, { node: "peer" }, "2026-11-25").totals.total).toBe(200);
		const pi = summarizeUsage(sources, { runtime: "pi" }, "2026-11-25");
		expect(pi.totals).toMatchObject({ total: 1100, sessions: 1, uncostedRequests: 0, cost: 2.5 });
		expect(pi.byRuntime.map((g) => g.key)).toEqual(["pi"]);
	});

	it("groups long ranges by month and handles no usage", () => {
		const long = summarizeUsage(
			[
				source("local", [
					{
						...(sources[0]?.stats.sessions[0] as UsageStats["sessions"][number]),
						usage: [entry("2026-01-15", "m", 1), entry("2026-11-02", "m", 2)],
					},
				]),
			],
			{},
			"2026-11-25",
		);
		expect(long.granularity).toBe("month");
		expect(long.buckets).toHaveLength(11);
		expect(long.buckets[0]).toMatchObject({ key: "2026-01", total: 10 });
		expect(long.buckets[10]).toMatchObject({ key: "2026-11", total: 20 });

		const none = summarizeUsage([], { since: "2026-11-25" }, "2026-11-25");
		expect(none.totals.total).toBe(0);
		expect(none.cacheHitRate).toBeUndefined();
		expect(none.buckets).toEqual([{ key: "2026-11-25", total: 0, byRuntime: {} }]);
	});

	it("counts back whole local days", () => {
		const now = new Date(2026, 10, 25, 0, 30);
		expect(localDay(now)).toBe("2026-11-25");
		expect(usageSince(1, now)).toBe("2026-11-25");
		expect(usageSince(7, now)).toBe("2026-11-19");
		expect(usageSince(30, now)).toBe("2026-10-27");
	});
});

describe("usage cost text", () => {
	const totals = (extra: Partial<UsageTotals>): UsageTotals => ({ ...emptyUsageTotals(), requests: 4, ...extra });
	const usd = (n: number) => `$${n.toFixed(2)}`;

	it("marks estimates and says what is left out", () => {
		expect(usageCostText(totals({ cost: 1 }), usd)).toBe("$1.00");
		expect(usageCostNote(totals({ cost: 1 }))).toBeUndefined();
		expect(usageCostText(totals({ uncostedRequests: 4 }), usd)).toBe("—");
		expect(usageCostNote(totals({ uncostedRequests: 4 }))).toBe("没有记录费用，也查不到官方价格");
		const estimated = totals({ cost: 2, estimatedCost: 2, estimatedRequests: 4 });
		expect(usageCostText(estimated, usd)).toBe("≈$2.00");
		expect(usageCostNote(estimated)).toBe("按模型官方价格估算");
		expect(usageCostNote(totals({ cost: 2, estimatedCost: 1, estimatedRequests: 3 }))).toBe(
			"其中 3 次请求按官方价格估算",
		);
		expect(usageCostNote(totals({ cost: 2, estimatedCost: 1, estimatedRequests: 1, uncostedRequests: 2 }))).toBe(
			"另有 2 次请求没有价格",
		);
		expect(usageCostText(emptyUsageTotals(), usd)).toBe("$0.00");
		expect(usageCostNote(emptyUsageTotals())).toBeUndefined();
	});
});
