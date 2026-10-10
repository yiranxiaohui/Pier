#!/usr/bin/env node
/**
 * Smoke-test a compiled pier-host sidecar: start it with throwaway pi/Pier directories,
 * read the `pier.ready` line, speak the protocol over WebSocket (hello, workspace, session
 * via the pi SDK inside the binary), then close stdin and expect a clean exit. Finally run
 * `--check-images` and expect pi to resize an image with the Photon wasm shipped next to the
 * binary or in PI_PACKAGE_DIR (not the build machine's node_modules path baked into it), and
 * `--check-p2p` and expect a local WebRTC data channel (werift inside the binary) to work.
 *
 * Usage: node scripts/smoke-sidecar.mjs <path-to-pier-host> [expected-version]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const exe = resolve(process.argv[2] ?? "");
const expectedVersion = process.argv[3];
if (!process.argv[2] || !existsSync(exe)) {
	console.error("Usage: smoke-sidecar.mjs <path-to-pier-host> [expected-version]");
	process.exit(2);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "pier-smoke-")));
const pierDir = join(root, "pier");
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const fail = (message) => {
	throw new Error(message);
};
const withTimeout = (promise, ms, what) =>
	Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

const child = spawn(exe, ["--watch-stdin", "--pier-dir", pierDir], {
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
	},
});
let stderr = "";
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
const exited = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));

async function main() {
	const lines = createInterface({ input: child.stdout });
	const readyLine = await withTimeout(
		new Promise((resolveLine, reject) => {
			lines.once("line", resolveLine);
			child.once("exit", () => reject(new Error("pier-host exited before it was ready")));
		}),
		60_000,
		"pier.ready",
	);
	const ready = JSON.parse(readyLine);
	if (ready.type !== "pier.ready") fail(`unexpected first stdout line: ${readyLine}`);
	if (expectedVersion && ready.version !== expectedVersion) fail(`version ${ready.version} != ${expectedVersion}`);
	if (!existsSync(join(pierDir, "run", "host.json"))) fail("runtime file was not written");

	const socket = new WebSocket(ready.url);
	const pending = new Map();
	const events = [];
	let nextId = 1;
	socket.onmessage = (message) => {
		const frame = JSON.parse(String(message.data));
		if (frame.type === "res") {
			const entry = pending.get(frame.id);
			pending.delete(frame.id);
			if (frame.ok) entry?.resolve(frame.result);
			else entry?.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
		} else {
			events.push(frame);
		}
	};
	await withTimeout(
		new Promise((resolveOpen, reject) => {
			socket.onopen = resolveOpen;
			socket.onerror = () => reject(new Error("WebSocket connection failed"));
		}),
		10_000,
		"WebSocket open",
	);
	const request = (method, params) =>
		withTimeout(
			new Promise((resolveReq, reject) => {
				const id = `r${nextId++}`;
				pending.set(id, { resolve: resolveReq, reject });
				socket.send(JSON.stringify({ type: "req", id, method, params }));
			}),
			30_000,
			method,
		);

	const hello = await request("host.hello", {
		protocolVersion: ready.protocolVersion,
		client: { name: "smoke", version: "0" },
		token: ready.token,
	});
	if (hello.host.piVersion === "0.0.0") fail("pi assets missing next to the binary (piVersion 0.0.0)");
	const { workspace: ws } = await request("workspace.add", { path: workspace });
	const { session } = await request("session.create", { workspaceId: ws.id, name: "smoke" });
	await request("session.subscribe", { sessionId: session.id });
	await withTimeout(
		(async () => {
			while (!events.some((e) => e.event.type === "session.snapshot")) await new Promise((r) => setTimeout(r, 20));
		})(),
		10_000,
		"session snapshot",
	);
	const { sessions } = await request("session.list", { workspaceId: ws.id });
	if (!sessions.some((s) => s.id === session.id)) fail("created session missing from session.list");
	socket.close();

	child.stdin.end();
	const { code, signal } = await withTimeout(exited, 15_000, "shutdown");
	if (code !== 0) fail(`pier-host exited with code ${code} signal ${signal}`);
	if (existsSync(join(pierDir, "run", "host.json"))) fail("runtime file was not removed on shutdown");

	const images = checkImages();
	const p2p = checkP2P();
	console.log(
		`smoke OK: pier-host ${ready.version} (protocol ${ready.protocolVersion}, pi ${hello.host.piVersion}, ${hello.host.platform}; images via ${images.wasm}; p2p data channel in ${p2p.ms} ms)`,
	);
}

/** Peer-to-peer paths need WebRTC (werift) to work inside the bundled binary. */
function checkP2P() {
	let output;
	try {
		output = execFileSync(exe, ["--check-p2p"], {
			encoding: "utf8",
			timeout: 90_000,
			env: { ...process.env, PIER_DIR: pierDir },
		});
	} catch (error) {
		fail(`--check-p2p failed: ${error.stdout || error.message}`);
	}
	const result = JSON.parse(output.trim().split("\n").at(-1));
	if (!result.ok) fail(`WebRTC data channels do not work: ${result.error}`);
	return result;
}

/** pi must resize images with the bundled Photon wasm, or it silently drops every attachment. */
function checkImages() {
	let output;
	try {
		output = execFileSync(exe, ["--check-images"], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, PIER_DIR: pierDir, PI_CODING_AGENT_DIR: join(root, "agent") },
		});
	} catch (error) {
		fail(`--check-images failed: ${error.stdout || error.message}`);
	}
	const result = JSON.parse(output.trim().split("\n").at(-1));
	if (!result.ok) fail(`pi cannot resize images: ${result.error}`);
	const bundleDirs = [process.env.PI_PACKAGE_DIR, dirname(exe)].filter(Boolean).map((dir) => resolve(dir));
	const inBundle = (file) =>
		bundleDirs.some((dir) => {
			const rel = relative(dir, resolve(file));
			return rel === "photon_rs_bg.wasm";
		});
	const embedded =
		process.argv.includes("--standalone") &&
		result.wasm &&
		/^[a-f0-9]{64}\/photon_rs_bg\.wasm$/.test(
			relative(join(pierDir, "runtime/resources"), resolve(result.wasm)).replaceAll("\\", "/"),
		);
	if (!result.wasm || (!inBundle(result.wasm) && !embedded)) {
		fail(`Photon wasm was not loaded from the bundle (${result.wasm ?? "build machine path"})`);
	}
	return result;
}

main()
	.catch((error) => {
		console.error(`smoke FAILED: ${error.message}`);
		if (stderr) console.error(`--- pier-host stderr ---\n${stderr}`);
		child.kill("SIGKILL");
		process.exitCode = 1;
	})
	.finally(() => {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	});
