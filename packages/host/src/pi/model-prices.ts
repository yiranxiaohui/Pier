/**
 * Official model prices, for the requests whose agent recorded no cost (`usage.stats`, 1.70).
 *
 * Claude Code and Codex record tokens only, and pi, Hermes and OpenCode record no cost for
 * models they have no prices for (relays and custom endpoints). pi's model catalog lists the
 * prices of its built-in providers per million tokens, and relays use the vendors' model ids, so
 * such a request is priced at its model vendor's own catalog entry (Anthropic for Claude, OpenAI
 * for GPT, ...). Gateways set their own prices, so their entries are not used. Computers without
 * pi use the prices Pier bundles (`official-prices.generated.ts`, from the pi Pier is developed
 * with), which also cover the models an older pi does not list.
 *
 * The price of a request follows pi's `calculateCost`: its prompt tokens choose the tier, and
 * cache writes with 1-hour retention cost twice the input price.
 */
import type { UsageRecord } from "../runtimes/types.ts";
import { baseId, candidates, firstParty, providerRank } from "./model-capabilities.ts";
import { OFFICIAL_PRICES } from "./official-prices.generated.ts";

/** US dollars per million tokens. */
export interface ModelRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelPrice extends ModelRates {
	/** Rates for requests with more prompt tokens than `inputTokensAbove`. */
	tiers?: (ModelRates & { inputTokensAbove: number })[];
}

/** A catalog model (pi's `Model`, reduced to what is needed here). */
export interface PricedCatalogModel {
	provider: string;
	id: string;
	cost?: unknown;
}

type Json = Record<string, unknown>;

function rate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function rates(value: Json): ModelRates | undefined {
	const input = rate(value.input);
	const output = rate(value.output);
	if (input === undefined || output === undefined) return undefined;
	return { input, output, cacheRead: rate(value.cacheRead) ?? 0, cacheWrite: rate(value.cacheWrite) ?? 0 };
}

/** The price in a catalog entry's `cost`; undefined without one (free models list zeros). */
export function modelPrice(cost: unknown): ModelPrice | undefined {
	if (typeof cost !== "object" || cost === null) return undefined;
	const base = rates(cost as Json);
	if (!base || (base.input === 0 && base.output === 0)) return undefined;
	const tiers: NonNullable<ModelPrice["tiers"]> = [];
	const listed = (cost as Json).tiers;
	for (const tier of Array.isArray(listed) ? listed : []) {
		if (typeof tier !== "object" || tier === null) continue;
		const above = rate((tier as Json).inputTokensAbove);
		const tierRates = rates(tier as Json);
		if (above !== undefined && tierRates) tiers.push({ ...tierRates, inputTokensAbove: above });
	}
	return tiers.length ? { ...base, tiers } : base;
}

/**
 * Cost in US dollars of a record at `price`. A record that sums several requests (Hermes keeps
 * totals only) picks its tier by the prompt tokens of an average request.
 */
export function requestCost(
	price: ModelPrice,
	record: Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "requests">,
): number {
	const prompt = (record.input + record.cacheRead + record.cacheWrite) / Math.max(1, record.requests ?? 1);
	let applied: ModelRates = price;
	let threshold = -1;
	for (const tier of price.tiers ?? []) {
		if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			applied = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	const longWrite = Math.min(record.cacheWrite1h ?? 0, record.cacheWrite);
	return (
		(applied.input * record.input +
			applied.output * record.output +
			applied.cacheRead * record.cacheRead +
			applied.cacheWrite * (record.cacheWrite - longWrite) +
			applied.input * 2 * longWrite) /
		1_000_000
	);
}

/** Official prices of the models in a catalog, by model id. */
export class ModelPriceIndex {
	private readonly byId = new Map<string, { provider: string; price: ModelPrice }>();

	/** `fallback` prices the models `models` do not list (an older pi's catalog). */
	constructor(
		models: Iterable<PricedCatalogModel>,
		private readonly fallback?: ModelPriceIndex,
	) {
		for (const model of models) {
			if (!firstParty(model.provider)) continue;
			const price = modelPrice(model.cost);
			if (!price) continue;
			const key = baseId(model.id);
			const current = this.byId.get(key);
			if (!current || providerRank(model.provider) < providerRank(current.provider))
				this.byId.set(key, { provider: model.provider, price });
		}
	}

	/** Models with a price, without the fallback's. */
	get size(): number {
		return this.byId.size;
	}

	/** The official price of `model` (an id as an agent or a relay names it). */
	price(model: string): ModelPrice | undefined {
		if (!model) return undefined;
		const own = candidates(model)
			.map((key) => this.byId.get(key))
			.find(Boolean)?.price;
		return own ?? this.fallback?.price(model);
	}

	/**
	 * Cost in US dollars of a request at its model's official price; undefined when the price is
	 * unknown, or the request was served in fast mode, which the catalog has no prices for.
	 */
	cost(record: UsageRecord): number | undefined {
		if (record.fast) return undefined;
		const price = this.price(record.model);
		return price ? requestCost(price, record) : undefined;
	}
}

/**
 * The official prices in a catalog, as Pier bundles them (`official-prices.generated.ts`):
 * model vendors' entries with a price, only the price fields, in a stable order.
 */
export function officialPriceSnapshot(models: Iterable<PricedCatalogModel>): PricedCatalogModel[] {
	const out: PricedCatalogModel[] = [];
	for (const model of models) {
		if (!firstParty(model.provider)) continue;
		const cost = modelPrice(model.cost);
		if (cost) out.push({ provider: model.provider, id: model.id, cost });
	}
	return out.sort(
		(a, b) => providerRank(a.provider) - providerRank(b.provider) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
}

let bundled: ModelPriceIndex | undefined;

/**
 * The official prices Pier bundles, from the pi of its development dependencies: for computers
 * without pi, and for models an older pi does not list.
 */
export function bundledPriceIndex(): ModelPriceIndex {
	bundled ??= new ModelPriceIndex(OFFICIAL_PRICES);
	return bundled;
}
