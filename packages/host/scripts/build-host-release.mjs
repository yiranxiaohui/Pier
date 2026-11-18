#!/usr/bin/env node
/** Build unified Pier: --arch x64|arm64 --desktop <matching.AppImage> [--outdir dist]. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
	options: {
		arch: { type: "string", default: "x64" },
		desktop: { type: "string" },
		outdir: { type: "string", default: "dist" },
	},
});
if (!["x64", "arm64"].includes(values.arch)) throw new Error("--arch must be x64 or arm64");
if (!values.desktop) throw new Error("--desktop must name the matching Pier AppImage");
const desktop = resolve(values.desktop);
const desktopDigest = createHash("sha256").update(readFileSync(desktop)).digest("hex");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const target = values.arch === "x64" ? "bun-linux-x64-baseline" : "bun-linux-arm64";
const staging = mkdtempSync(join(tmpdir(), "pier-host-release-"));
try {
	const outdir = resolve(values.outdir);
	mkdirSync(outdir, { recursive: true });
	copyFileSync(desktop, join(staging, "Pier.AppImage"));
	const entry = join(staging, "standalone.ts");
	writeFileSync(
		entry,
		`import desktop from "./Pier.AppImage" with { type: "file" };\n` +
			`import { runStandalone } from ${JSON.stringify(join(repo, "packages/host/src/standalone/main.ts"))};\n` +
			`runStandalone(${JSON.stringify(version)}, { path: desktop, sha256: ${JSON.stringify(desktopDigest)} }).catch(error => { console.error("pier: " + error.message); process.exit(1); });\n`,
	);
	const executable = join(outdir, `pier-v${version}-linux-${values.arch}`);
	execFileSync(
		"bun",
		[
			"build",
			"--compile",
			"--no-compile-autoload-bunfig",
			// The Host loads the user's pi from disk; its packages resolve through package.json.
			"--compile-autoload-package-json",
			"--root",
			staging,
			"--target",
			target,
			entry,
			"--outfile",
			executable,
		],
		{ cwd: repo, stdio: "inherit" },
	);
	console.log(`Built single-file ${executable}`);
} finally {
	rmSync(staging, { recursive: true, force: true });
}
