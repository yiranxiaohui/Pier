#!/usr/bin/env node
/** Build unified Pier: --arch x64|arm64 --desktop <matching.AppImage> [--outdir dist]. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

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
	copyFileSync(join(repo, "scripts/install-host.sh"), join(staging, "install-host.sh"));
	writeFileSync(join(staging, "VERSION"), `v${version}\n`);
	writeFileSync(join(staging, "PLATFORM"), `linux-${values.arch}\n`);
	const outdir = resolve(values.outdir);
	mkdirSync(outdir, { recursive: true });
	const archive = join(outdir, `pier-host-v${version}-linux-${values.arch}.tar.gz`);
	execFileSync("tar", ["-czf", archive, "-C", staging, "."], { stdio: "inherit" });
	console.log(`Built ${archive}`);
	// Retain archives for existing installations; new users can download only this executable.
	const files = {};
	const excluded = new Set(["pier-host", "pier-cli", "manage.sh", "install-host.sh", "VERSION", "PLATFORM"]);
	function collect(directory, prefix = "") {
		for (const item of readdirSync(directory, { withFileTypes: true })) {
			if (!prefix && excluded.has(item.name)) continue;
			const name = prefix ? `${prefix}/${item.name}` : item.name;
			if (item.isDirectory()) collect(join(directory, item.name), name);
			else files[name] = readFileSync(join(directory, item.name)).toString("base64");
		}
	}
	collect(staging);
	writeFileSync(join(staging, "pi-resources.json.gz"), gzipSync(JSON.stringify(files)));
	copyFileSync(desktop, join(staging, "Pier.AppImage"));
	// Keep pi's worker specifier identical in the archive sidecar and the embedded executable.
	const worker = join(staging, "src/extensions/codemode/worker.ts");
	mkdirSync(join(staging, "src/extensions/codemode"), { recursive: true });
	writeFileSync(worker, `import ${JSON.stringify(join(repo, "packages/host/src/extensions/codemode/worker.ts"))};\n`);
	for (const legacy of [false, true]) {
		const name = legacy ? "pier-host" : "pier";
		const entry = join(staging, "standalone.ts");
		writeFileSync(
			entry,
			`import archive from "./pi-resources.json.gz" with { type: "file" };\n` +
				`import desktop from "./Pier.AppImage" with { type: "file" };\n` +
				`import { runStandalone } from ${JSON.stringify(join(repo, "packages/host/src/standalone/main.ts"))};\n` +
				`runStandalone(archive, ${JSON.stringify(version)}, { path: desktop, sha256: ${JSON.stringify(desktopDigest)} }, ${legacy}).catch(error => { console.error("pier: " + error.message); process.exit(1); });\n`,
		);
		const executable = join(outdir, `${name}-v${version}-linux-${values.arch}`);
		execFileSync(
			"bun",
			[
				"build",
				"--compile",
				"--no-compile-autoload-bunfig",
				"--root",
				staging,
				"--target",
				target,
				entry,
				worker,
				"--outfile",
				executable,
			],
			{ cwd: repo, stdio: "inherit" },
		);
		console.log(`Built single-file ${executable}`);
	}
} finally {
	rmSync(staging, { recursive: true, force: true });
}
