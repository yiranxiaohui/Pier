#!/usr/bin/env node
/** Run under dbus-run-session -- xvfb-run: the same standalone file must open a window and its desktop Host. */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "pier-desktop-smoke-"));
const env = {
	...process.env,
	GDK_BACKEND: "x11",
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	PIER_DIR: root,
	PIER_HOST_STATE_DIR: root,
	PI_CODING_AGENT_DIR: join(root, "agent"),
	PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
};
for (const key of ["WAYLAND_DISPLAY", "PI_PACKAGE_DIR", "PIER_HOST_BIN", "PIER_LOCAL_TOKEN", "PIER_RELAY_TOKEN"])
	delete env[key];
const child = spawn(resolve(process.argv[2]), [], { detached: true, stdio: "ignore", env });
let socket;
let spawnError;
child.once("error", (error) => {
	spawnError = error;
});
const withTimeout = async (operation) => {
	let timer;
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("Desktop request timed out")), 10_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
try {
	let ready;
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		if (child.exitCode !== null) throw new Error(`Desktop exited with ${child.exitCode}`);
		try {
			ready = JSON.parse(readFileSync(join(root, "run/host.json"), "utf8"));
			break;
		} catch {
			await delay(100);
		}
	}
	if (!ready || ready.version !== process.argv[3]) throw new Error("Desktop Host did not become ready");
	socket = new WebSocket(ready.url);
	await withTimeout(
		new Promise((resolveOpen, reject) => {
			socket.onopen = resolveOpen;
			socket.onerror = reject;
		}),
	);
	let id = 0;
	const request = (method, params = {}) =>
		withTimeout(
			new Promise((resolveResponse, reject) => {
				const requestId = String(++id);
				socket.onmessage = (event) => {
					const response = JSON.parse(String(event.data));
					if (response.type !== "res" || response.id !== requestId) return;
					if (response.ok) resolveResponse(response.result);
					else reject(new Error(`Desktop request failed: ${method}`));
				};
				socket.send(JSON.stringify({ type: "req", id: requestId, method, params }));
			}),
		);
	const hello = await request("host.hello", {
		protocolVersion: ready.protocolVersion,
		token: ready.token,
		client: { name: "smoke", version: "0" },
	});
	if (!hello.host.terminals) throw new Error("The GUI did not provide desktop terminal support");
	// The Host answers before the desktop shell has sent its updater status; until then it
	// reports a bare "unsupported" without the portable guidance, so wait for the shell's.
	const portableGuidance = (status) => status.state === "unsupported" && status.error?.includes("pier update");
	let status = await request("update.status");
	while (Date.now() < deadline && !portableGuidance(status)) {
		await delay(100);
		status = await request("update.status");
	}
	if (!portableGuidance(status)) throw new Error("Portable update guidance missing");
	let windowFound = false;
	while (Date.now() < deadline && !windowFound) {
		windowFound = /"Pier"/.test(execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" }));
		if (!windowFound) await delay(100);
	}
	if (!windowFound) throw new Error("No Pier window opened");
	console.log(
		`desktop smoke OK: ${ready.version}; automatic GUI selection, Pier window, desktop Host and portable update guidance`,
	);
} finally {
	socket?.close();
	if (child.pid) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			/* Already exited. */
		}
		await delay(1_000);
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* All children stopped. */
		}
	}
	rmSync(root, { recursive: true, force: true });
}
