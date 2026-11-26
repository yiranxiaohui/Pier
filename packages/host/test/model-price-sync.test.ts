import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildPriceCatalog,
	bundledPrices,
	type PriceCatalog,
	parsePriceCatalog,
	parsePriceOverrides,
	serializePriceCatalog,
} from "../src/model-price-catalog.ts";
import { MODEL_PRICES_URL, ModelPriceSync } from "../src/model-price-sync.ts";
import type { PricedCatalogModel } from "../src/pi/model-prices.ts";

const OPUS = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const T = Date.UTC(2026, 10, 26, 8);

const catalog = (updatedAt: string, models: PricedCatalogModel[]): PriceCatalog => ({
	version: 1,
	updatedAt,
	source: "test",
	models,
});

describe("model price file", () => {
	it("keeps only usable, plausible prices", () => {
		const parsed = parsePriceCatalog({
			version: 1,
			updatedAt: "2026-11-26T00:00:00.000Z",
			source: "pi-ai",
			models: [
				{ provider: "anthropic", id: "claude-opus-5-5", cost: OPUS, note: "ignored" },
				{ provider: "anthropic", id: "free", cost: { input: 0, output: 0 } },
				{ provider: "anthropic", id: "absurd", cost: { input: 1, output: 1e9 } },
				{ provider: "", id: "x", cost: OPUS },
				"junk",
			],
		});
		expect(parsed).toEqual({
			version: 1,
			updatedAt: "2026-11-26T00:00:00.000Z",
			source: "pi-ai",
			models: [{ provider: "anthropic", id: "claude-opus-5-5", cost: OPUS }],
		});
		for (const bad of [
			null,
			[],
			{ version: 2, updatedAt: "2026-11-26T00:00:00Z", models: [{ provider: "a", id: "b", cost: OPUS }] },
			{ version: 1, updatedAt: "soon", models: [{ provider: "a", id: "b", cost: OPUS }] },
			{ version: 1, updatedAt: "2026-11-26T00:00:00Z", models: [] },
			{ version: 1, updatedAt: "2026-11-26T00:00:00Z", models: "many" },
		])
			expect(parsePriceCatalog(bad)).toBeUndefined();
	});

	it("writes one model per line and reads back what it wrote", () => {
		const file = catalog("2026-11-26T00:00:00.000Z", [
			{ provider: "anthropic", id: "claude-opus-5-5", cost: OPUS },
			{ provider: "openai", id: "gpt-6.1-sol", cost: { ...OPUS, tiers: [{ ...OPUS, inputTokensAbove: 272_000 }] } },
		]);
		const text = serializePriceCatalog(file);
		expect(text.split("\n").filter((line) => line.includes('"provider"'))).toHaveLength(2);
		expect(parsePriceCatalog(JSON.parse(text))).toEqual(file);
	});

	it("updates the file from a catalog, keeps models the catalog dropped, and applies overrides", () => {
		const previous = catalog("2026-11-01T00:00:00.000Z", [
			{ provider: "anthropic", id: "claude-opus-5-5", cost: OPUS },
			{ provider: "openai", id: "gpt-4", cost: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 } },
			{ provider: "openai", id: "wrong", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
		]);
		const now = new Date(T);
		const next = buildPriceCatalog({
			catalog: [
				{ provider: "anthropic", id: "claude-opus-5-5", cost: { ...OPUS, input: 3 } },
				{ provider: "openrouter", id: "anthropic/claude-opus-5-5", cost: OPUS },
				{ provider: "deepseek", id: "deepseek-v4-pro", cost: { input: 1.32, output: 3.96 } },
			],
			overrides: parsePriceOverrides({
				models: [
					{ provider: "openai", id: "gpt-6.2-astra", cost: { input: 8, output: 40 } },
					{ provider: "openai", id: "wrong", cost: null },
				],
			}),
			previous,
			source: "pi-ai 9",
			now,
		});
		expect(next.updatedAt).toBe(now.toISOString());
		expect(next.source).toBe("pi-ai 9");
		expect(next.models.map((m) => `${m.provider}/${m.id}`)).toEqual([
			"anthropic/claude-opus-5-5",
			"openai/gpt-4",
			"openai/gpt-6.2-astra",
			"deepseek/deepseek-v4-pro",
		]);
		expect(next.models[0]?.cost).toMatchObject({ input: 3 });
		// The same prices again keep the file's time.
		const again = buildPriceCatalog({ catalog: [], previous: next, source: "pi-ai 10", now: new Date(T + 1000) });
		expect(again.updatedAt).toBe(next.updatedAt);
	});

	it("rejects overrides it could not use", () => {
		expect(() => parsePriceOverrides({})).toThrow(/models/);
		expect(() => parsePriceOverrides({ models: [{ provider: "openai" }] })).toThrow(/provider" and "id/);
		expect(() => parsePriceOverrides({ models: [{ provider: "openrouter", id: "x", cost: OPUS }] })).toThrow(
			/not a model vendor/,
		);
		expect(() => parsePriceOverrides({ models: [{ provider: "openai", id: "x", cost: { input: 1 } }] })).toThrow(
			/cost/,
		);
	});

	it("bundles the published file", () => {
		const bundled = bundledPrices();
		if (!bundled) throw new Error("data/model-prices.json is not a price file");
		expect(bundled.catalog.models.length).toBeGreaterThan(100);
		expect(bundled.index.price("claude-opus-5-5")).toEqual(OPUS);
		expect(bundled.index.price("gpt-6.2-astra")).toMatchObject({ input: 8, output: 40 });
		const text = readFileSync(new URL("../data/model-prices.json", import.meta.url), "utf8");
		// The file is written by `bun run update-prices`; edits go to model-prices.overrides.json.
		expect(serializePriceCatalog(bundled.catalog)).toBe(text);
		expect(
			parsePriceOverrides(
				JSON.parse(readFileSync(new URL("../data/model-prices.overrides.json", import.meta.url), "utf8")),
			),
		).toBeDefined();
	});
});

describe("model price sync", () => {
	let dir: string;
	let now: number;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pier-price-sync-"));
		now = T;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const published = catalog("2099-01-01T00:00:00.000Z", [
		{ provider: "anthropic", id: "claude-next", cost: { input: 9, output: 99, cacheRead: 0, cacheWrite: 0 } },
	]);
	const routes = [
		{ id: "github", name: "GitHub", prefix: "" },
		{ id: "mirror", name: "Mirror", prefix: "https://mirror.test/" },
	];
	const response = (body: string, init: ResponseInit = {}) => new Response(body, init);

	function sync(fetcher: typeof fetch, url?: string) {
		return new ModelPriceSync({
			file: join(dir, "model-prices.json"),
			...(url ? { url } : { url: MODEL_PRICES_URL }),
			routes,
			fetch: fetcher,
			now: () => now,
		});
	}

	it("fetches through the next route when one fails, and keeps what it fetched", async () => {
		const fetcher = vi.fn(async (url: string | URL | Request) =>
			String(url).startsWith("https://mirror.test/")
				? response(serializePriceCatalog(published))
				: Promise.reject(new Error("blocked")),
		);
		const prices = sync(fetcher as typeof fetch);
		expect(prices.indexes()).toHaveLength(1);
		expect(await prices.refresh()).toBe(true);
		expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
			MODEL_PRICES_URL,
			`https://mirror.test/${MODEL_PRICES_URL}`,
		]);
		// The newer synced file comes before the bundled one.
		expect(prices.indexes()[0]?.price("claude-next")).toMatchObject({ output: 99 });
		const reloaded = sync(vi.fn() as unknown as typeof fetch);
		expect(reloaded.indexes()).toHaveLength(2);
		expect(reloaded.indexes()[0]?.price("claude-next")).toMatchObject({ output: 99 });
	});

	it("ignores what is not a price file", async () => {
		const logs: string[] = [];
		const prices = new ModelPriceSync({
			file: join(dir, "model-prices.json"),
			url: MODEL_PRICES_URL,
			routes,
			fetch: (async () => response("<html>blocked</html>")) as unknown as typeof fetch,
			log: (line) => logs.push(line),
		});
		expect(await prices.refresh()).toBe(false);
		expect(logs[0]).toMatch(/GitHub: .*; Mirror: /);
		expect(() => statSync(join(dir, "model-prices.json"))).toThrow();
		const failing = sync((async () => response("", { status: 404 })) as unknown as typeof fetch);
		expect(await failing.refresh()).toBe(false);
	});

	it("syncs at most once a day, and an hour after a failure", async () => {
		let ok = false;
		const fetcher = vi.fn(async () =>
			ok ? response(serializePriceCatalog(published)) : response("", { status: 500 }),
		);
		const prices = sync(fetcher as unknown as typeof fetch);
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		prices.refreshIfStale();
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		await settle();
		fetcher.mockClear();
		now += 30 * 60_000;
		prices.refreshIfStale();
		expect(fetcher).not.toHaveBeenCalled();
		ok = true;
		now += 31 * 60_000;
		prices.refreshIfStale();
		await vi.waitFor(() => expect(prices.indexes()[0]?.price("claude-next")).toBeDefined());
		await settle();
		fetcher.mockClear();
		now += 23 * 3_600_000;
		prices.refreshIfStale();
		expect(fetcher).not.toHaveBeenCalled();
		now += 2 * 3_600_000;
		prices.refreshIfStale();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("goes by the time of a file synced earlier, and prefers the more recently updated prices", () => {
		const file = join(dir, "model-prices.json");
		const old = catalog("2000-01-01T00:00:00.000Z", [
			{ provider: "anthropic", id: "claude-opus-5-5", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
		]);
		writeFileSync(file, serializePriceCatalog(old));
		utimesSync(file, new Date(now), new Date(now - 3_600_000));
		const fetcher = vi.fn(async () => response(""));
		const prices = sync(fetcher as unknown as typeof fetch);
		prices.refreshIfStale();
		expect(fetcher).not.toHaveBeenCalled();
		// The bundled prices were updated after this old file, so they come first.
		expect(prices.indexes()[0]?.price("claude-opus-5-5")).toEqual(OPUS);
		expect(prices.indexes()).toHaveLength(2);
	});

	it("never fetches when turned off", async () => {
		const fetcher = vi.fn();
		const prices = sync(fetcher as unknown as typeof fetch, "off");
		expect(prices.enabled).toBe(false);
		prices.refreshIfStale();
		expect(await prices.refresh()).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
		expect(prices.indexes()).toHaveLength(1);
	});

	it("fetches other addresses directly, not through GitHub mirrors", async () => {
		const fetcher = vi.fn(async (_url: string | URL | Request) => response(serializePriceCatalog(published)));
		const prices = new ModelPriceSync({
			file: join(dir, "model-prices.json"),
			url: "https://prices.example.com/model-prices.json",
			fetch: fetcher as unknown as typeof fetch,
		});
		expect(await prices.refresh()).toBe(true);
		expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://prices.example.com/model-prices.json"]);
	});
});
