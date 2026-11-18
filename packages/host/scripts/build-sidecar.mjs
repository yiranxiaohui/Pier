#!/usr/bin/env node
/**
 * Build the Pier Host sidecar as a single executable with `bun build --compile`:
 *
 *   <outdir>/pier-host[.exe]
 *
 * pi is not part of the build. The Host loads the user's own pi installation at runtime (see
 * src/pi/sdk.ts), so the executable resolves pi's packages from disk: that needs
 * `--compile-autoload-package-json`.
 *
 * Usage: node scripts/build-sidecar.mjs [--outdir bin] [--target bun-linux-x64] [--name pier-host]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const { values } = parseArgs({
	// Tolerate a forwarded `--` from package-manager script invocations.
	args: process.argv.slice(2).filter((arg) => arg !== "--"),
	options: {
		outdir: { type: "string", default: join(packageRoot, "bin") },
		target: { type: "string" },
		name: { type: "string", default: "pier-host" },
	},
});

const outdir = resolve(values.outdir);
const windows = values.target ? values.target.includes("windows") : process.platform === "win32";
const exe = join(outdir, `${values.name}${windows ? ".exe" : ""}`);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const bunArgs = [
	"build",
	"--compile",
	"--no-compile-autoload-bunfig",
	"--compile-autoload-package-json",
	"--root",
	packageRoot,
	join(packageRoot, "src/main.ts"),
	"--outfile",
	exe,
];
if (values.target) bunArgs.push("--target", values.target);
execFileSync("bun", bunArgs, { stdio: "inherit", cwd: packageRoot });

console.log(`Built ${exe}`);
