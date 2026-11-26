/**
 * Keeps the model prices a host estimates usage costs with up to date (`usage.stats`, 1.70): the
 * price file Pier publishes in its repository, fetched at most once a day while usage statistics
 * are read, through GitHub or the GitHub mirrors `pier update` uses, and kept in
 * `~/.pier/model-prices.json`. The copy bundled with Pier is used until a newer one arrives.
 * `PIER_MODEL_PRICES_URL` names another file, or `off` to never fetch.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bundledPrices, type PriceCatalog, parsePriceCatalog, serializePriceCatalog } from "./model-price-catalog.ts";
import { ModelPriceIndex } from "./pi/model-prices.ts";
import { parseMirror, type Route, routeOrder, routeUrl } from "./standalone/update-download.ts";

export const MODEL_PRICES_URL =
	"https://raw.githubusercontent.com/yiranxiaohui/Pier/main/packages/host/data/model-prices.json";

const SYNC_EVERY_MS = 24 * 3_600_000;
/** After a failed sync, wait this long before trying again. */
const RETRY_AFTER_MS = 3_600_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;

export interface ModelPriceSyncOptions {
	/** Where synced prices are kept (`~/.pier/model-prices.json`). */
	file: string;
	/** The price file to fetch, or `off`. Defaults to `PIER_MODEL_PRICES_URL`, else Pier's repository. */
	url?: string;
	/** Routes to GitHub, in order. Defaults to `pier update`'s, with `PIER_MIRROR` first. */
	routes?: readonly Route[];
	fetch?: typeof fetch;
	now?: () => number;
	log?: (message: string) => void;
}

interface Synced {
	catalog: PriceCatalog;
	index: ModelPriceIndex;
	/** When it was fetched (epoch milliseconds). */
	at: number;
}

function defaultRoutes(): Route[] {
	try {
		return routeOrder(parseMirror(process.env.PIER_MIRROR));
	} catch {
		return routeOrder(undefined);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ModelPriceSync {
	private readonly url: string;
	private readonly now: () => number;
	/** `null` until the file has been read. */
	private synced: Synced | undefined | null = null;
	private lastAttempt = Number.NEGATIVE_INFINITY;
	private running: Promise<boolean> | undefined;

	constructor(private readonly options: ModelPriceSyncOptions) {
		this.url = (options.url ?? process.env.PIER_MODEL_PRICES_URL)?.trim() || MODEL_PRICES_URL;
		this.now = options.now ?? Date.now;
	}

	/** Whether prices are fetched at all. */
	get enabled(): boolean {
		return this.url !== "off";
	}

	private load(): Synced | undefined {
		if (this.synced !== null) return this.synced;
		this.synced = undefined;
		try {
			const catalog = parsePriceCatalog(JSON.parse(readFileSync(this.options.file, "utf8")));
			if (catalog)
				this.synced = {
					catalog,
					index: new ModelPriceIndex(catalog.models),
					at: statSync(this.options.file).mtimeMs,
				};
		} catch {
			// Nothing synced yet, or a damaged file the next sync replaces.
		}
		return this.synced;
	}

	/** The synced and the bundled prices, the more recently updated first. */
	indexes(): ModelPriceIndex[] {
		const catalogs = [this.load(), bundledPrices()].filter((item) => item !== undefined);
		return catalogs
			.sort((a, b) => Date.parse(b.catalog.updatedAt) - Date.parse(a.catalog.updatedAt))
			.map((item) => item.index);
	}

	/** Sync in the background when the synced prices are a day old (an hour after a failure). */
	refreshIfStale(): void {
		if (!this.enabled || this.running) return;
		const now = this.now();
		const synced = this.load();
		if (synced && now - synced.at < SYNC_EVERY_MS) return;
		if (now - this.lastAttempt < RETRY_AFTER_MS) return;
		void this.refresh();
	}

	/** Fetch the price file now; true when it was stored. */
	refresh(): Promise<boolean> {
		if (!this.enabled) return Promise.resolve(false);
		this.running ??= this.fetchPrices().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	private routes(): readonly Route[] {
		if (this.options.routes) return this.options.routes;
		// Mirrors relay GitHub only.
		const github = /^https:\/\/(?:raw\.githubusercontent\.com|github\.com)\//.test(this.url);
		return github ? defaultRoutes() : [{ id: "direct", name: "direct", prefix: "" }];
	}

	private async fetchPrices(): Promise<boolean> {
		this.lastAttempt = this.now();
		const fetcher = this.options.fetch ?? fetch;
		const failures: string[] = [];
		for (const route of this.routes()) {
			try {
				const url = routeUrl(route, this.url);
				const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
				if (response.url && !response.url.startsWith("https://")) throw new Error("redirected away from HTTPS");
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const length = Number(response.headers.get("content-length"));
				if (length > MAX_BYTES) throw new Error("too large");
				const text = await response.text();
				if (text.length > MAX_BYTES) throw new Error("too large");
				const catalog = parsePriceCatalog(JSON.parse(text));
				if (!catalog) throw new Error("not a price file");
				this.store(catalog);
				return true;
			} catch (error) {
				failures.push(`${route.name}: ${message(error)}`);
			}
		}
		this.options.log?.(`syncing model prices failed (${failures.join("; ")})`);
		return false;
	}

	private store(catalog: PriceCatalog): void {
		const file = this.options.file;
		mkdirSync(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, serializePriceCatalog(catalog));
		renameSync(temp, file);
		this.synced = { catalog, index: new ModelPriceIndex(catalog.models), at: this.now() };
	}
}
