#!/usr/bin/env node
/**
 * Build `latest-android.json`, the static manifest the Android app's in-app updater reads from
 * the newest GitHub release (`releases/latest/download/latest-android.json`, see
 * `apps/mobile/src/updater.ts`).
 *
 * It records the download URL, size, and SHA-256 / MD5 digests of the signed release APK. The
 * app checks the size and MD5 (computed natively) after downloading; Android verifies the APK
 * signature when installing.
 *
 * Usage: node apps/mobile/scripts/android-update-manifest.mjs \
 *   --apk <file> --version <x.y.z> --tag <vX.Y.Z> --repo <owner/name> --notes <file> [--out <file>]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * @param {{ apkName: string, apk: Uint8Array, version: string, tag: string, repo: string,
 *   notes: string, pubDate: string }} input
 */
export function buildAndroidManifest({ apkName, apk, version, tag, repo, notes, pubDate }) {
	if (apkName !== `pier-${tag}-android.apk`) throw new Error(`Unexpected APK name ${apkName}`);
	if (!apk.length) throw new Error(`${apkName} is empty`);
	return {
		version,
		notes: notes.trim(),
		pub_date: pubDate,
		url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(apkName)}`,
		size: apk.length,
		sha256: createHash("sha256").update(apk).digest("hex"),
		md5: createHash("md5").update(apk).digest("hex"),
	};
}

function main() {
	const { values } = parseArgs({
		options: {
			apk: { type: "string" },
			version: { type: "string" },
			tag: { type: "string" },
			repo: { type: "string" },
			notes: { type: "string" },
			out: { type: "string" },
		},
	});
	for (const key of ["apk", "version", "tag", "repo", "notes"]) {
		if (!values[key]) throw new Error(`--${key} is required`);
	}
	const manifest = buildAndroidManifest({
		apkName: basename(values.apk),
		apk: readFileSync(values.apk),
		version: values.version,
		tag: values.tag,
		repo: values.repo,
		notes: readFileSync(values.notes, "utf8"),
		pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	});
	const out = values.out ?? join(dirname(values.apk), "latest-android.json");
	writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Wrote ${out}: ${manifest.url} (${manifest.size} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
