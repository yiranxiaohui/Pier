#!/usr/bin/env node
/**
 * Build `latest.json`, the static manifest the in-app updater reads from the newest GitHub
 * release (`releases/latest/download/latest.json`).
 *
 * It pairs every updater bundle in the release assets with its minisign signature (`.sig`,
 * produced by `tauri build` when `TAURI_SIGNING_PRIVATE_KEY` is set) and maps it to the
 * updater targets `{os}-{arch}-{installer}` and `{os}-{arch}`.
 *
 * Usage: node apps/desktop/scripts/updater-manifest.mjs \
 *   --assets <dir> --version <x.y.z> --tag <vX.Y.Z> --repo <owner/name> --notes <file> [--out <file>]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Release asset platform (see release.yml) → updater `{os}-{arch}`. */
const PLATFORMS = {
	"linux-x64": "linux-x86_64",
	"linux-arm64": "linux-aarch64",
	"darwin-arm64": "darwin-aarch64",
	"darwin-x64": "darwin-x86_64",
	"windows-x64": "windows-x86_64",
};

/**
 * Updater bundle suffix → installer name. The first bundle of a platform also serves the
 * plain `{os}-{arch}` target (older clients and unknown bundle types): AppImage on Linux
 * rather than deb, which needs root to install.
 */
const INSTALLERS = [
	[".AppImage", "appimage"],
	[".deb", "deb"],
	[".rpm", "rpm"],
	[".app.tar.gz", "app"],
	[".setup.exe", "nsis"],
	[".msi", "msi"],
];

/**
 * @param {{ assets: string[], signatures: Record<string, string>, version: string, tag: string,
 *   repo: string, notes: string, pubDate: string }} input
 */
export function buildManifest({ assets, signatures, version, tag, repo, notes, pubDate }) {
	const prefix = `pier-${tag}-`;
	const platforms = {};
	for (const [suffix, installer] of INSTALLERS) {
		for (const name of [...assets].sort()) {
			if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
			const platform = name.slice(prefix.length, -suffix.length);
			const target = PLATFORMS[platform];
			if (!target) throw new Error(`Unknown platform "${platform}" in ${name}`);
			const signature = signatures[`${name}.sig`];
			if (!signature) throw new Error(`Missing updater signature ${name}.sig`);
			const entry = {
				signature: signature.trim(),
				url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
			};
			platforms[`${target}-${installer}`] = entry;
			platforms[target] ??= entry;
		}
	}
	if (!Object.keys(platforms).length) throw new Error(`No updater bundles named ${prefix}* found`);
	return { version, notes: notes.trim(), pub_date: pubDate, platforms };
}

function main() {
	const { values } = parseArgs({
		options: {
			assets: { type: "string" },
			version: { type: "string" },
			tag: { type: "string" },
			repo: { type: "string" },
			notes: { type: "string" },
			out: { type: "string" },
		},
	});
	for (const key of ["assets", "version", "tag", "repo", "notes"]) {
		if (!values[key]) throw new Error(`--${key} is required`);
	}
	const assets = readdirSync(values.assets);
	const signatures = Object.fromEntries(
		assets
			.filter((name) => name.endsWith(".sig"))
			.map((name) => [name, readFileSync(join(values.assets, name), "utf8")]),
	);
	const manifest = buildManifest({
		assets: assets.filter((name) => !name.endsWith(".sig")),
		signatures,
		version: values.version,
		tag: values.tag,
		repo: values.repo,
		notes: readFileSync(values.notes, "utf8"),
		pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	});
	const out = values.out ?? join(values.assets, "latest.json");
	writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Wrote ${out}: ${Object.keys(manifest.platforms).sort().join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
