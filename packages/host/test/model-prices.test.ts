import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Api, calculateCost, InMemoryCredentialStore, type Model, type Usage } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { readPiCatalogData } from "../src/model-price-catalog.ts";
import { PiEnvironment } from "../src/pi/environment.ts";
import {
	ModelPriceIndex,
	ModelPrices,
	modelPrice,
	officialPrices,
	type PricedCatalogModel,
	requestCost,
} from "../src/pi/model-prices.ts";
import { ProviderManager } from "../src/pi/providers.ts";
import { PiLoader } from "../src/pi/sdk.ts";
import type { UsageRecord } from "../src/runtimes/types.ts";
import { testPiLoader } from "./helpers.ts";

const OPUS = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const CATALOG: PricedCatalogModel[] = [
	{ provider: "openrouter", id: "anthropic/claude-opus-5-5", cost: { ...OPUS, input: 3 } },
	{ provider: "anthropic", id: "claude-opus-5-5", cost: OPUS },
	{ provider: "opencode", id: "deepseek-v4-pro", cost: { input: 1.74, output: 3.48 } },
	{ provider: "deepseek", id: "deepseek-v4-pro", cost: { input: 1.32, output: 3.96, cacheRead: 0.044 } },
	{ provider: "vercel-ai-gateway", id: "only-at-a-gateway", cost: { input: 1, output: 1 } },
	{ provider: "qwen-token-plan", id: "qwen-max", cost: { input: 0, output: 0 } },
	{ provider: "google", id: "gemini-free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "openai", id: "no-price" },
	{
		provider: "openai",
		id: "gpt-6.1-sol",
		cost: {
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheWrite: 2.5,
			tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
		},
	},
];

const record = (extra: Partial<UsageRecord>): UsageRecord => ({
	at: 0,
	model: "claude-opus-5-5",
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	...extra,
});

describe("official model prices", () => {
	const index = new ModelPriceIndex(CATALOG);

	it("takes the model vendor's price, not a gateway's, and matches the ids relays use", () => {
		expect(index.price("claude-opus-5-5")).toEqual(OPUS);
		for (const id of [
			"anthropic/claude-opus-5-5",
			"Claude-Opus-5-5-thinking",
			"claude-opus-5.5",
			"claude-opus-5-5-20261101",
		])
			expect(index.price(id), id).toEqual(OPUS);
		expect(index.price("deepseek-v4-pro")).toEqual({ input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 });
		// Gateways' own models, free models and models without prices have no official price.
		for (const id of ["only-at-a-gateway", "qwen-max", "gemini-free", "no-price", "unknown", ""])
			expect(index.price(id), id).toBeUndefined();
		expect(index.size).toBe(3);
	});

	it("prices a request per million tokens, with 1-hour cache writes at twice the input price", () => {
		expect(
			index.cost(record({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })),
		).toBeCloseTo(4 + 20 + 0.2 + 5);
		expect(index.cost(record({ cacheWrite: 1_000_000, cacheWrite1h: 400_000 }))).toBeCloseTo(0.6 * 5 + 0.4 * 8);
		expect(index.cost(record({ output: 1000, fast: true }))).toBeUndefined();
		expect(index.cost(record({ model: "unknown", output: 1000 }))).toBeUndefined();
	});

	it("picks the tier by the prompt of a request, or of an average request of a total", () => {
		const price = index.price("gpt-6.1-sol");
		if (!price) throw new Error("no price");
		expect(requestCost(price, { input: 272_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.544);
		expect(requestCost(price, { input: 100_000, output: 0, cacheRead: 200_000, cacheWrite: 0 })).toBeCloseTo(
			0.4 + 0.04,
		);
		// Ten requests of 30k prompt tokens each stay below the tier.
		expect(requestCost(price, { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 10 })).toBeCloseTo(
			0.6,
		);
	});

	it("reads only usable prices from a catalog entry", () => {
		expect(modelPrice(undefined)).toBeUndefined();
		expect(modelPrice({ input: -1, output: 2 })).toBeUndefined();
		expect(modelPrice({ input: 1, output: 2, tiers: [{ inputTokensAbove: 10 }, "x"] })).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("matches pi's calculateCost on pi's own catalog", async () => {
		const root = mkdtempSync(join(tmpdir(), "pier-prices-"));
		try {
			const runtime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: join(root, "models.json"),
				refreshOnCreate: false,
			});
			const models = getBuiltinProviders().flatMap((id) => runtime.getModels(id));
			const real = new ModelPriceIndex(models);
			expect(real.size).toBeGreaterThan(50);
			expect(real.price("claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
			const usages: Omit<Usage, "cost" | "totalTokens">[] = [
				{ input: 1200, output: 3400, cacheRead: 250_000, cacheWrite: 6000, cacheWrite1h: 2000 },
				{ input: 150_000, output: 900, cacheRead: 200_000, cacheWrite: 0 },
				{ input: 3, output: 1, cacheRead: 0, cacheWrite: 90_000 },
			];
			const vendors = {
				"claude-opus-5-5": "anthropic",
				"claude-haiku-5-5": "anthropic",
				"gpt-6.1-sol": "openai",
				"deepseek-v4-pro": "deepseek",
			};
			for (const [id, provider] of Object.entries(vendors)) {
				const model = runtime.getModels(provider).find((m: Model<Api>) => m.id === id);
				const price = real.price(id);
				if (!model || !price) throw new Error(`${provider}/${id} is not in pi's catalog`);
				for (const usage of usages) {
					const expected = calculateCost(model, {
						...usage,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					}).total;
					expect(requestCost(price, usage), `${id} ${JSON.stringify(usage)}`).toBeCloseTo(expected, 10);
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("asks several catalogs in order", () => {
		const later = new ModelPriceIndex([
			{ provider: "anthropic", id: "claude-opus-5-5", cost: { input: 1, output: 1 } },
			{ provider: "anthropic", id: "claude-next", cost: { input: 9, output: 99 } },
		]);
		const prices = new ModelPrices([index, undefined, later]);
		expect(prices.price("claude-opus-5-5")).toEqual(OPUS);
		expect(prices.price("anthropic/claude-next")).toMatchObject({ input: 9, output: 99 });
		expect(prices.price("unknown")).toBeUndefined();
		expect(prices.cost(record({ model: "claude-next", output: 1_000_000 }))).toBeCloseTo(99);
		expect(prices.cost(record({ model: "claude-next", output: 1, fast: true }))).toBeUndefined();
	});

	it("reads pi's catalog data the way pi's own catalog API lists it", () => {
		const viaApi = officialPrices(
			getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider) as readonly PricedCatalogModel[]),
		);
		const dir = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "providers", "data");
		// The data also has image and classifier models, priced differently under the same ids.
		expect(officialPrices(readPiCatalogData(dir))).toEqual(viaApi);
		expect(viaApi.length).toBeGreaterThan(100);
		expect(viaApi.every((m) => m.provider !== "openrouter" && m.provider !== "opencode")).toBe(true);
	});

	it("adds the installed pi's catalog when pi is loaded", async () => {
		const root = mkdtempSync(join(tmpdir(), "pier-prices-"));
		try {
			const withoutPi = await PiEnvironment.create({
				agentDir: join(root, "agent"),
				loader: new PiLoader({ locate: () => ({ state: "missing" }) }),
			});
			expect(withoutPi.loaded).toBe(false);
			expect(new ProviderManager(withoutPi, { onChanged: () => {} }).catalogPriceIndex()).toBeUndefined();

			const modelsPath = join(root, "models.json");
			const withPi = await PiEnvironment.create({
				agentDir: join(root, "agent"),
				loader: testPiLoader(),
				modelsPath,
				modelRuntime: await ModelRuntime.create({
					credentials: new InMemoryCredentialStore(),
					modelsPath,
					refreshOnCreate: false,
				}),
			});
			expect(withPi.loaded).toBe(true);
			const fromPi = new ProviderManager(withPi, { onChanged: () => {} }).catalogPriceIndex();
			expect(fromPi?.size).toBeGreaterThan(50);
			expect(fromPi?.cost(record({ output: 1_000_000 }))).toBeCloseTo(20);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
