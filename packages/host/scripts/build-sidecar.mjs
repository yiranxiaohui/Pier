#!/usr/bin/env node
/**
 * Build the Pier Host sidecar as a single executable with `bun build --compile`,
 * then copy the pi runtime assets the SDK resolves next to the executable
 * (the same layout as pi's own `build:binary`):
 *
 *   <outdir>/pier-host[.exe]
 *   <outdir>/package.json          pi's package.json (VERSION, piConfig)
 *   <outdir>/theme/*.json          built-in themes (ctx.ui.theme)
 *   <outdir>/export-html/...       HTML export templates
 *   <outdir>/assets/...            interactive assets
 *   <outdir>/docs, examples        referenced from pi's system prompt
 *   <outdir>/photon_rs_bg.wasm     image resizing
 *   <outdir>/quickjs.wasm         MCP codemode sandbox
 *
 * When the assets cannot live next to the binary (e.g. inside an app bundle), point
 * PI_PACKAGE_DIR at the directory that contains them.
 *
 * Usage: node scripts/build-sidecar.mjs [--outdir bin] [--target bun-linux-x64] [--name pier-host]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
/** Directory of an installed package, found from any file inside it (works with strict `exports`). */
function packageDirOf(name, fromFile) {
	let dir = dirname(fromFile);
	while (dir !== dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir;
		dir = dirname(dir);
	}
	throw new Error(`Could not locate package ${name}`);
}

function findInNodeModules(name, startDir) {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		dir = dirname(dir);
	}
	throw new Error(`Could not locate package ${name}`);
}

const piName = "@earendil-works/pi-coding-agent";
const piDir = packageDirOf(piName, fileURLToPath(import.meta.resolve(piName)));
const photonDir = findInNodeModules("@silvia-odwyer/photon-node", piDir);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const bunArgs = [
	"build",
	"--compile",
	"--no-compile-autoload-bunfig",
	"--root",
	packageRoot,
	join(packageRoot, "src/main.ts"),
	join(packageRoot, "src/extensions/codemode/worker.ts"),
	"--outfile",
	exe,
];
if (values.target) bunArgs.push("--target", values.target);
execFileSync("bun", bunArgs, { stdio: "inherit", cwd: packageRoot });

const copy = (from, to) => {
	if (!existsSync(from)) throw new Error(`Missing pi asset: ${from}`);
	cpSync(from, to, { recursive: true });
};
copy(join(piDir, "package.json"), join(outdir, "package.json"));
copy(join(piDir, "README.md"), join(outdir, "README.md"));
copy(join(piDir, "CHANGELOG.md"), join(outdir, "CHANGELOG.md"));
mkdirSync(join(outdir, "theme"));
for (const file of readdirSync(join(piDir, "dist/modes/interactive/theme")).filter((f) => f.endsWith(".json"))) {
	copy(join(piDir, "dist/modes/interactive/theme", file), join(outdir, "theme", file));
}
copy(join(piDir, "dist/modes/interactive/assets"), join(outdir, "assets"));
mkdirSync(join(outdir, "export-html"));
for (const file of ["template.html", "template.css", "template.js"]) {
	copy(join(piDir, "dist/core/export-html", file), join(outdir, "export-html", file));
}
copy(join(piDir, "dist/core/export-html/vendor"), join(outdir, "export-html/vendor"));
copy(join(piDir, "docs"), join(outdir, "docs"));
copy(join(piDir, "examples"), join(outdir, "examples"));
copy(join(photonDir, "photon_rs_bg.wasm"), join(outdir, "photon_rs_bg.wasm"));
copy(join(findInNodeModules("quickjs-wasi", piDir), "quickjs.wasm"), join(outdir, "quickjs.wasm"));

console.log(`Built ${exe} with pi assets in ${outdir}`);
