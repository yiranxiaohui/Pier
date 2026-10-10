#!/usr/bin/env node
/** Build a Linux Host + CLI archive, with pi assets and the service manager. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
	options: {
		arch: { type: "string", default: "x64" },
		outdir: { type: "string", default: "dist" },
	},
});
if (!["x64", "arm64"].includes(values.arch)) throw new Error("--arch must be x64 or arm64");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const target = values.arch === "x64" ? "bun-linux-x64-baseline" : "bun-linux-arm64";
const staging = mkdtempSync(join(tmpdir(), "pier-host-release-"));
try {
	execFileSync(
		process.execPath,
		[join(repo, "packages/host/scripts/build-sidecar.mjs"), "--outdir", staging, "--target", target],
		{ cwd: repo, stdio: "inherit" },
	);
	execFileSync(
		"bun",
		["build", "--compile", "--target", target, "packages/client/src/cli.ts", "--outfile", join(staging, "pier-cli")],
		{ cwd: repo, stdio: "inherit" },
	);
	copyFileSync(join(repo, "scripts/host-manager.sh"), join(staging, "manage.sh"));
	const outdir = resolve(values.outdir);
	mkdirSync(outdir, { recursive: true });
	const archive = join(outdir, `pier-host-v${version}-linux-${values.arch}.tar.gz`);
	execFileSync("tar", ["-czf", archive, "-C", staging, "."], { stdio: "inherit" });
	console.log(`Built ${archive}`);
} finally {
	rmSync(staging, { recursive: true, force: true });
}
