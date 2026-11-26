/**
 * The model price file Pier publishes (`packages/host/data/model-prices.json`), for estimating the
 * cost of requests whose agent recorded none (`usage.stats`, 1.70).
 *
 * The file holds the official prices of model vendors' own entries in the newest pi model catalog
 * on npm (`@earendil-works/pi-ai`), with `model-prices.overrides.json` adding or correcting
 * entries. A scheduled workflow regenerates it (`scripts/update-model-prices.ts`); hosts sync it
 * from the repository (`model-price-sync.ts`) and bundle the copy they were built with.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import bundledFile from "../data/model-prices.json" with { type: "json" };
import { firstParty } from "./pi/model-capabilities.ts";
import {
	compareModels,
	type ModelPrice,
	ModelPriceIndex,
	modelPrice,
	officialPrices,
	type PricedCatalogModel,
} from "./pi/model-prices.ts";

export const PRICE_CATALOG_VERSION = 1;

/** The contents of `model-prices.json`. */
export interface PriceCatalog {
	version: number;
	/** When the prices last changed (ISO 8601). */
	updatedAt: string;
	/** Where they come from, e.g. `@earendil-works/pi-ai 1.6.1`. */
	source?: string;
	/** Prices in US dollars per million tokens, sorted by vendor and id. */
	models: PricedCatalogModel[];
}

const MAX_MODELS = 10_000;
/** Higher rates (US dollars per million tokens) are taken for mistakes. */
const MAX_RATE = 10_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function plausible(price: ModelPrice): boolean {
	return [price, ...(price.tiers ?? [])].every((rates) =>
		[rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every((rate) => rate <= MAX_RATE),
	);
}

/**
 * A price file, checked: entries without a usable price are left out, and a file of another
 * version, without a time or without any price is not one. Undefined when it is not.
 */
export function parsePriceCatalog(value: unknown): PriceCatalog | undefined {
	if (!isObject(value) || value.version !== PRICE_CATALOG_VERSION) return undefined;
	const { updatedAt, source, models } = value;
	if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) return undefined;
	if (!Array.isArray(models) || models.length > MAX_MODELS) return undefined;
	const out: PricedCatalogModel[] = [];
	for (const entry of models) {
		if (!isObject(entry) || !shortText(entry.provider, 100) || !shortText(entry.id, 200)) continue;
		const cost = modelPrice(entry.cost);
		if (cost && plausible(cost)) out.push({ provider: entry.provider, id: entry.id, cost });
	}
	if (out.length === 0) return undefined;
	return {
		version: PRICE_CATALOG_VERSION,
		updatedAt,
		...(shortText(source, 200) ? { source } : {}),
		models: out,
	};
}

/** `model-prices.json` text: one model per line, so that a changed price is a one-line diff. */
export function serializePriceCatalog(catalog: PriceCatalog): string {
	const head = {
		version: catalog.version,
		updatedAt: catalog.updatedAt,
		...(catalog.source ? { source: catalog.source } : {}),
	};
	const fields = Object.entries(head).map(([key, value]) => `\t${JSON.stringify(key)}: ${JSON.stringify(value)},`);
	const models = catalog.models.map((model) => `\t\t${JSON.stringify(model)}`).join(",\n");
	return `{\n${fields.join("\n")}\n\t"models": [\n${models}\n\t]\n}\n`;
}

/** One entry of `model-prices.overrides.json`: a price to add or correct, or `null` to drop one. */
export interface PriceOverride {
	provider: string;
	id: string;
	cost: ModelPrice | null;
}

/** The entries of `model-prices.overrides.json`; throws on mistakes, so they are not missed. */
export function parsePriceOverrides(value: unknown): PriceOverride[] {
	if (!isObject(value) || !Array.isArray(value.models)) throw new Error('overrides need a "models" array');
	return value.models.map((entry, index): PriceOverride => {
		const where = `overrides.models[${index}]`;
		if (!isObject(entry) || !shortText(entry.provider, 100) || !shortText(entry.id, 200))
			throw new Error(`${where} needs "provider" and "id"`);
		if (!firstParty(entry.provider))
			throw new Error(`${where}: ${entry.provider} is not a model vendor whose prices Pier uses`);
		if (entry.cost === null) return { provider: entry.provider, id: entry.id, cost: null };
		const cost = modelPrice(entry.cost);
		if (!cost || !plausible(cost)) throw new Error(`${where} needs a "cost" with "input" and "output" (or null)`);
		return { provider: entry.provider, id: entry.id, cost };
	});
}

export interface BuildPriceCatalogOptions {
	/** Chat models of a pi model catalog, every provider's. */
	catalog: Iterable<PricedCatalogModel>;
	overrides?: readonly PriceOverride[];
	/**
	 * The current file. Its models stay when the catalog no longer lists them (old sessions still
	 * used them), and its time is kept when no price changed.
	 */
	previous?: PriceCatalog;
	source?: string;
	now?: Date;
}

/**
 * A new price file: the current one updated with a pi model catalog, then the overrides (an
 * override with `cost: null` is how a model leaves the file).
 */
export function buildPriceCatalog(options: BuildPriceCatalogOptions): PriceCatalog {
	const key = (model: { provider: string; id: string }) => `${model.provider}\n${model.id}`;
	const models = new Map((options.previous?.models ?? []).map((model) => [key(model), model]));
	for (const model of officialPrices(options.catalog)) models.set(key(model), model);
	for (const override of options.overrides ?? []) {
		if (override.cost === null) models.delete(key(override));
		else models.set(key(override), { provider: override.provider, id: override.id, cost: override.cost });
	}
	const sorted = [...models.values()].sort(compareModels);
	const previous = options.previous;
	const unchanged = previous !== undefined && JSON.stringify(previous.models) === JSON.stringify(sorted);
	return {
		version: PRICE_CATALOG_VERSION,
		updatedAt: unchanged ? previous.updatedAt : (options.now ?? new Date()).toISOString(),
		...(options.source ? { source: options.source } : {}),
		models: sorted,
	};
}

/**
 * The chat models in pi-ai's catalog data (`dist/providers/data/<provider>.json`, models by API
 * and id), read as data: no package code runs. Image and classifier models (`type`) have other
 * prices under the same ids.
 */
export function readPiCatalogData(dir: string): PricedCatalogModel[] {
	const out: PricedCatalogModel[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".json")) continue;
		const data: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
		if (!isObject(data)) continue;
		for (const models of Object.values(data)) {
			const list = Array.isArray(models) ? models : isObject(models) ? Object.values(models) : [];
			for (const model of list) {
				if (!isObject(model) || typeof model.id !== "string") continue;
				if (model.type !== undefined && model.type !== "chat") continue;
				const provider = typeof model.provider === "string" ? model.provider : name.slice(0, -".json".length);
				out.push({ provider, id: model.id, cost: model.cost });
			}
		}
	}
	return out;
}

let bundled: { catalog: PriceCatalog; index: ModelPriceIndex } | null | undefined;

/** The price file this Pier was built with. */
export function bundledPrices(): { catalog: PriceCatalog; index: ModelPriceIndex } | undefined {
	if (bundled === undefined) {
		const catalog = parsePriceCatalog(bundledFile);
		bundled = catalog ? { catalog, index: new ModelPriceIndex(catalog.models) } : null;
	}
	return bundled ?? undefined;
}
