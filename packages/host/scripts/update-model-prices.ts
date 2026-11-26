/**
 * Update `packages/host/data/model-prices.json` (`bun run update-prices`): the official prices in
 * the newest `@earendil-works/pi-ai` on npm, plus `model-prices.overrides.json`. Only the
 * package's catalog data is read (its integrity checked against the registry); none of its code
 * runs. `--catalog <dir>` reads a pi-ai package directory, or its `dist/providers/data`, instead.
 *
 * The `Model prices` workflow runs this every day and commits the file when a price changed. The
 * lines printed after the first describe the changes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildPriceCatalog,
	type PriceCatalog,
	parsePriceCatalog,
	parsePriceOverrides,
	readPiCatalogData,
	serializePriceCatalog,
} from "../src/model-price-catalog.ts";

const PACKAGE = "@earendil-works/pi-ai";
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const target = join(dataDir, "model-prices.json");
const overridesFile = join(dataDir, "model-prices.overrides.json");

interface Catalog {
	dir: string;
	source: string;
	cleanup?: () => void;
}

function packageVersion(packageDir: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

function localCatalog(path: string): Catalog {
	const dir = resolve(path);
	const data = join(dir, "dist", "providers", "data");
	if (existsSync(data)) {
		const version = packageVersion(dir);
		return { dir: data, source: version ? `${PACKAGE} ${version}` : data };
	}
	return { dir, source: dir };
}

async function npmCatalog(): Promise<Catalog> {
	const meta = (await (
		await fetch(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/latest`, {
			signal: AbortSignal.timeout(60_000),
		})
	).json()) as { version: string; dist: { tarball: string; integrity: string } };
	const [algorithm, expected] = meta.dist.integrity.split("-", 2);
	if (algorithm !== "sha512" || !expected) throw new Error(`unexpected integrity ${meta.dist.integrity}`);
	const tarball = Buffer.from(
		await (await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(120_000) })).arrayBuffer(),
	);
	if (createHash("sha512").update(tarball).digest("base64") !== expected)
		throw new Error(`${meta.dist.tarball} does not match the registry's integrity`);
	const root = mkdtempSync(join(tmpdir(), "pier-pi-ai-"));
	const file = join(root, "package.tgz");
	writeFileSync(file, tarball);
	execFileSync("tar", ["-xzf", file, "-C", root, "package/dist/providers/data"]);
	return {
		dir: join(root, "package", "dist", "providers", "data"),
		source: `${PACKAGE} ${meta.version}`,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function readCatalogFile(): PriceCatalog | undefined {
	try {
		return parsePriceCatalog(JSON.parse(readFileSync(target, "utf8")));
	} catch {
		return undefined;
	}
}

/** Lines describing what changed between two price files. */
function changes(before: PriceCatalog | undefined, after: PriceCatalog): string[] {
	const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	const old = new Map((before?.models ?? []).map((model) => [key(model), JSON.stringify(model.cost)]));
	const lines: string[] = [];
	for (const model of after.models) {
		const cost = JSON.stringify(model.cost);
		const was = old.get(key(model));
		if (was === undefined) lines.push(`+ ${key(model)} ${cost}`);
		else if (was !== cost) lines.push(`~ ${key(model)} ${was} → ${cost}`);
		old.delete(key(model));
	}
	for (const name of old.keys()) lines.push(`- ${name}`);
	return lines;
}

const flag = process.argv.indexOf("--catalog");
const catalog = flag === -1 ? await npmCatalog() : localCatalog(process.argv[flag + 1] ?? ".");
try {
	const previous = readCatalogFile();
	const next = buildPriceCatalog({
		catalog: readPiCatalogData(catalog.dir),
		overrides: parsePriceOverrides(JSON.parse(readFileSync(overridesFile, "utf8"))),
		...(previous ? { previous } : {}),
		source: catalog.source,
	});
	const text = serializePriceCatalog(next);
	const changed = !existsSync(target) || readFileSync(target, "utf8") !== text;
	if (changed) writeFileSync(target, text);
	console.log(`${next.models.length} model prices from ${next.source}${changed ? "" : " (unchanged)"}`);
	for (const line of changes(previous, next)) console.log(line);
} finally {
	catalog.cleanup?.();
}
