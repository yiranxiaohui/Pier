#!/usr/bin/env node
/** Verify the release executable alone, with no Node, Bun, bash, curl, tar or adjacent assets. */
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const source = resolve(process.argv[2]);
const version = process.argv[3];
const root = mkdtempSync(join(tmpdir(), "pier-single-smoke-"));
let host;
try {
	const tools = join(root, "tools");
	const state = join(root, "state");
	const prefix = join(root, "prefix with space %");
	mkdirSync(tools);
	writeFileSync(join(tools, "systemctl"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(tools, "systemctl"), 0o755);
	const executable = join(root, "pier-host");
	copyFileSync(source, executable);
	chmodSync(executable, 0o755);
	const env = {
		...process.env,
		PATH: tools,
		PIER_DIR: state,
		PIER_HOST_STATE_DIR: state,
		PIER_HOST_PREFIX: prefix,
		XDG_CONFIG_HOME: join(root, "config"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
	};
	for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "PI_PACKAGE_DIR", "PIER_LOCAL_TOKEN", "PIER_RELAY_TOKEN"])
		delete env[key];
	const run = (binary, args, input) =>
		execFileSync(binary, args, { env, input, encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
	if (run(executable, ["--version"]).trim() !== `pier-host ${version}`) throw new Error("Unexpected version");
	const image = JSON.parse(run(executable, ["--check-images"]).trim());
	if (!image.ok || !image.wasm.startsWith(state)) throw new Error("Embedded Photon failed");
	run(executable, ["install", "--user", "--no-start"]);
	const installed = join(prefix, "bin/pier-host");
	const service = join(root, "config/systemd/user/pier-host.service");
	if (readFileSync(service, "utf8").includes(".sh")) throw new Error("Service still depends on a shell script");
	host = spawn(installed, ["run", "--no-mdns", "--remote-port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise((resolveExit) => host.once("exit", (code) => resolveExit(code)));
	const lines = createInterface({ input: host.stdout });
	await new Promise((resolveReady, reject) => {
		const timer = setTimeout(() => reject(new Error("Host startup timed out")), 30_000);
		lines.once("line", (line) => {
			clearTimeout(timer);
			const ready = JSON.parse(line);
			if (ready.type !== "pier.ready" || ready.version !== version) reject(new Error("Invalid readiness"));
			else resolveReady();
		});
		host.once("exit", () => {
			clearTimeout(timer);
			reject(new Error("Host exited before readiness"));
		});
	});
	const pairing = run(installed, ["cli"], "/remote on\n/pair\n/quit\n");
	if (!pairing.includes("pier://") || pairing.toLowerCase().includes("error:"))
		throw new Error("Built-in CLI pairing failed");
	host.kill("SIGTERM");
	if ((await exited) !== 0) throw new Error("Host did not stop cleanly");
	run(installed, ["uninstall"]);
	if (existsSync(installed) || existsSync(service) || existsSync(join(prefix, "share/pier-host")))
		throw new Error("Uninstall left program or service files");
	if (!existsSync(join(state, "config.json"))) throw new Error("Uninstall removed retained state");
	run(executable, ["install", "--user", "--no-start"]);
	run(installed, ["uninstall", "--purge"]);
	if (existsSync(state)) throw new Error("Explicit purge failed");
	console.log(
		`single-file smoke OK: ${version}; embedded images, native install, headless startup, built-in CLI pairing, uninstall/data retention and explicit purge; no external runtime, scripts or assets`,
	);
} finally {
	if (host && host.exitCode === null) host.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
}
