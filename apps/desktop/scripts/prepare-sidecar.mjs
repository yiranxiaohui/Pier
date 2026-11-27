#!/usr/bin/env node
/**
 * Build the Pier Host sidecar for the desktop app.
 *
 *   src-tauri/binaries/pier-host-<target-triple>[.exe]   Tauri `externalBin`
 *
 * pi is not bundled: the Host loads the user's own pi installation at runtime.
 *
 * Usage: node scripts/prepare-sidecar.mjs [--target <rust-target-triple>]
 * The triple defaults to $TAURI_ENV_TARGET_TRIPLE, then to the host triple from `rustc -vV`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../..");
const tauriDir = join(appRoot, "src-tauri");

const BUN_TARGETS = {
	"x86_64-unknown-linux-gnu": "bun-linux-x64",
	"aarch64-unknown-linux-gnu": "bun-linux-arm64",
	"x86_64-apple-darwin": "bun-darwin-x64",
	"aarch64-apple-darwin": "bun-darwin-arm64",
	"x86_64-pc-windows-msvc": "bun-windows-x64",
};

const { values } = parseArgs({
	args: process.argv.slice(2).filter((arg) => arg !== "--"),
	options: { target: { type: "string" } },
});

function hostTriple() {
	const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
	const line = output.split("\n").find((l) => l.startsWith("host:"));
	if (!line) throw new Error("Could not determine the Rust host triple from `rustc -vV`");
	return line.slice("host:".length).trim();
}

const triple = values.target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const bunTarget = BUN_TARGETS[triple];
if (!bunTarget) throw new Error(`Unsupported target triple ${triple}; known: ${Object.keys(BUN_TARGETS).join(", ")}`);
const windows = triple.includes("windows");
const exeName = `pier-host${windows ? ".exe" : ""}`;

// Stage next to the outputs so the final moves are same-filesystem renames.
const staging = join(tauriDir, ".sidecar-staging");
rmSync(staging, { recursive: true, force: true });
try {
	execFileSync(
		process.execPath,
		[
			join(repoRoot, "packages/host/scripts/build-sidecar.mjs"),
			"--outdir",
			staging,
			"--target",
			bunTarget,
			// Give the Windows sidecar the app's icon instead of Bun's.
			"--windows-icon",
			join(tauriDir, "icons/icon.ico"),
		],
		{ stdio: "inherit" },
	);

	const binaries = join(tauriDir, "binaries");
	rmSync(binaries, { recursive: true, force: true });
	// Builds before pi became the user's own installation also staged pi's assets here.
	rmSync(join(tauriDir, "pi-assets"), { recursive: true, force: true });
	mkdirSync(binaries, { recursive: true });

	renameSync(join(staging, exeName), join(binaries, `pier-host-${triple}${windows ? ".exe" : ""}`));
	console.log(`Prepared sidecar pier-host-${triple} in ${tauriDir}`);
} finally {
	rmSync(staging, { recursive: true, force: true });
}
