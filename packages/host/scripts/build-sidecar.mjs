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
 * A Windows executable otherwise inherits bun.exe's icon and version resource (Explorer shows the
 * Bun logo, and the file properties name Oven's bun.exe), so Windows builds stamp Pier Host's own
 * name, version and, with `--windows-icon`, icon. Bun can only edit those resources when it runs on
 * Windows, so a cross-compiled Windows executable keeps Bun's; the released installer is built on
 * Windows.
 *
 * Usage: node scripts/build-sidecar.mjs [--outdir bin] [--target bun-linux-x64] [--name pier-host]
 *        [--windows-icon icon.ico]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
		"windows-icon": { type: "string" },
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
if (windows && process.platform === "win32") {
	const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	bunArgs.push(
		"--windows-title",
		"Pier Host",
		"--windows-description",
		"Pier Host",
		"--windows-publisher",
		"Pier",
		// The version resource wants four numeric parts; drop any prerelease suffix.
		"--windows-version",
		`${version.split("-")[0]}.0`,
	);
	if (values["windows-icon"]) bunArgs.push("--windows-icon", resolve(values["windows-icon"]));
} else if (windows) {
	console.warn("Cross-compiling for Windows: the executable keeps Bun's icon and version resource.");
}
execFileSync("bun", bunArgs, { stdio: "inherit", cwd: packageRoot });

console.log(`Built ${exe}`);
