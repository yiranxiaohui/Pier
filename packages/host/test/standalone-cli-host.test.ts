import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostRunning, startCliHost } from "../src/standalone/cli-host.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "pier-cli-host-test-"));
	roots.push(root);
	return root;
}

function writeRuntime(dir: string, runtime: object): void {
	mkdirSync(join(dir, "run"), { recursive: true });
	writeFileSync(join(dir, "run", "host.json"), JSON.stringify(runtime));
}

async function listen(): Promise<number> {
	const server = createServer((socket) => socket.end());
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as { port: number }).port;
}

/**
 * Stands in for the single-file `pier`: `run` writes the runtime file with its own pid, logs to
 * stderr, and leaves on SIGTERM. FAKE_HOST picks a misbehaviour.
 */
function fakePier(dir: string, mode: "ok" | "fail" | "crash" | "stubborn" | "silent" = "ok"): string {
	const path = join(dir, "fake-pier");
	writeFileSync(
		path,
		`#!/bin/sh
[ "$1" = run ] && [ $# -eq 1 ] || exit 2
echo "starting in $PIER_DIR" >&2
if [ "${mode}" = fail ]; then echo "boom: no resources" >&2; exit 4; fi
if [ "${mode}" = stubborn ]; then trap '' TERM; else trap 'echo stopping >&2; rm -f "$PIER_DIR/run/host.json"; exit 0' TERM; fi
mkdir -p "$PIER_DIR/run"
if [ "${mode}" != silent ]; then printf '{"pid":%s,"port":1}\\n' $$ > "$PIER_DIR/run/host.json"; fi
if [ "${mode}" = crash ]; then sleep 0.3; exit 3; fi
while :; do sleep 0.05; done
`,
	);
	chmodSync(path, 0o755);
	return path;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("CLI Host discovery", () => {
	it("finds a Host only when its runtime file names a live process that accepts connections", async () => {
		const dir = stateDir();
		expect(await hostRunning(dir)).toBe(false);
		const port = await listen();
		writeRuntime(dir, { pid: process.pid, port });
		expect(await hostRunning(dir)).toBe(true);
		// A Host that crashed, or whose pid now belongs to something else, does not count.
		writeRuntime(dir, { pid: 2 ** 22 + 1, port });
		expect(await hostRunning(dir)).toBe(false);
		const closed = await listen();
		await new Promise((resolve) => servers.pop()?.close(resolve));
		writeRuntime(dir, { pid: process.pid, port: closed });
		expect(await hostRunning(dir)).toBe(false);
		writeFileSync(join(dir, "run", "host.json"), "{");
		expect(await hostRunning(dir)).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("CLI Host", () => {
	it("starts pier run with this state directory, logs privately, and stops it gracefully", async () => {
		const dir = stateDir();
		let unexpected = false;
		const host = await startCliHost(fakePier(dir), dir, { onUnexpectedExit: () => (unexpected = true) });
		const { pid } = JSON.parse(readFileSync(join(dir, "run", "host.json"), "utf8")) as { pid: number };
		expect(alive(pid)).toBe(true);
		expect(host.log).toBe(join(dir, "logs", "cli-host.log"));
		expect(readFileSync(host.log, "utf8")).toContain(`starting in ${dir}`);
		await host.stop();
		expect(alive(pid)).toBe(false);
		expect(existsSync(join(dir, "run", "host.json"))).toBe(false);
		expect(readFileSync(host.log, "utf8")).toContain("stopping");
		expect(unexpected).toBe(false);
		await host.stop();
	});

	it("reports a Host that fails to start with the end of its log", async () => {
		const dir = stateDir();
		await expect(startCliHost(fakePier(dir, "fail"), dir)).rejects.toThrow(/code 4.*\n[\s\S]*boom: no resources/);
		await expect(startCliHost(join(dir, "missing"), dir)).rejects.toThrow(/Could not start the Pier Host/);
	});

	it("reports a Host that stops by itself after starting", async () => {
		const dir = stateDir();
		const exits: Array<[number | null, string]> = [];
		const host = await startCliHost(fakePier(dir, "crash"), dir, {
			onUnexpectedExit: (code, _signal, log) => exits.push([code, log]),
		});
		await expect.poll(() => exits).toEqual([[3, host.log]]);
	});

	it("gives up on a Host that never becomes ready, and kills one that ignores SIGTERM", async () => {
		const dir = stateDir();
		await expect(startCliHost(fakePier(dir, "silent"), dir, { readyTimeoutMs: 300 })).rejects.toThrow(/did not start/);
		const host = await startCliHost(fakePier(dir, "stubborn"), dir, { stopTimeoutMs: 300 });
		const { pid } = JSON.parse(readFileSync(join(dir, "run", "host.json"), "utf8")) as { pid: number };
		await host.stop();
		expect(alive(pid)).toBe(false);
	});
});
