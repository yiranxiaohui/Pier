#!/usr/bin/env node
/**
 * Smoke-test a compiled pier-host sidecar: start it with throwaway pi/Pier directories,
 * read the `pier.ready` line, speak the protocol over WebSocket (hello, workspace, session
 * through the pi SDK the binary loads from the pi installation), then close stdin and expect a
 * clean exit. Finally run `--check-pi` and expect pi to load and resize an image with its
 * Photon wasm, the same with no usable pi to fail cleanly, and `--check-p2p` and expect a local
 * WebRTC data channel (werift inside the binary) to work.
 *
 * pi is the user's own installation; the binary loads it at runtime. The test uses
 * `PIER_PI_PATH` when set, otherwise the pi of this repository's development dependencies.
 *
 * Usage: node scripts/smoke-sidecar.mjs <path-to-pier-host> [expected-version]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const exe = resolve(process.argv[2] ?? "");
const expectedVersion = process.argv[3];
if (!process.argv[2] || !existsSync(exe)) {
	console.error("Usage: smoke-sidecar.mjs <path-to-pier-host> [expected-version]");
	process.exit(2);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const piPath = resolve(process.env.PIER_PI_PATH || join(repo, "node_modules/@earendil-works/pi-coding-agent"));
const piPackage = realpathSync(existsSync(join(piPath, "package.json")) ? piPath : join(piPath, "..", ".."));
const piVersion = JSON.parse(readFileSync(join(piPackage, "package.json"), "utf8")).version;

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
		PIER_PI_PATH: piPath,
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
	if (hello.host.piVersion !== piVersion) fail(`loaded pi ${hello.host.piVersion || "(none)"}, expected ${piVersion}`);
	const { runtimes } = await request("runtime.list", {});
	const pi = runtimes.find((r) => r.id === "pi");
	if (!pi?.available) fail(`pi runtime unavailable: ${pi?.reason ?? "missing"}`);
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

	const checked = checkPi();
	checkWithoutPi();
	const p2p = checkP2P();
	console.log(
		`smoke OK: pier-host ${ready.version} (protocol ${ready.protocolVersion}, pi ${hello.host.piVersion} from ${checked.pi.packageDir}, ${hello.host.platform}; p2p data channel in ${p2p.ms} ms)`,
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

/** pi must load from its installation and resize images with its Photon wasm, or it drops every attachment. */
function checkPi() {
	let output;
	try {
		output = execFileSync(exe, ["--check-pi"], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, PIER_PI_PATH: piPath, PIER_DIR: pierDir, PI_CODING_AGENT_DIR: join(root, "agent") },
		});
	} catch (error) {
		fail(`--check-pi failed: ${error.stdout || error.message}`);
	}
	const result = JSON.parse(output.trim().split("\n").at(-1));
	if (!result.ok) fail(`pi cannot run in the binary: ${result.error}`);
	if (result.pi?.packageDir !== piPackage) fail(`pi loaded from ${result.pi?.packageDir}, expected ${piPackage}`);
	return result;
}

/** Without a usable pi the binary reports why instead of crashing. */
function checkWithoutPi() {
	const empty = join(root, "no-pi");
	mkdirSync(empty, { recursive: true });
	let output = "";
	try {
		output = execFileSync(exe, ["--check-pi"], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, PIER_PI_PATH: empty, PIER_DIR: pierDir },
		});
		fail("--check-pi succeeded without pi");
	} catch (error) {
		output = error.stdout ?? "";
	}
	const result = JSON.parse(String(output).trim().split("\n").at(-1) || "{}");
	if (result.ok !== false || !result.error) fail(`--check-pi without pi: unexpected output ${output}`);
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
