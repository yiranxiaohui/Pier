import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PierClient } from "@pier/client";
import { runSshPair, type SshPairOutput } from "@pier/client";
import type { EventFrame, SshAddProgress } from "@pier/protocol";
import { type Connection, Server, utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PIER_HOST_VERSION } from "../src/host.ts";
import { hostKeyFingerprint } from "../src/peers/ssh/known-hosts.ts";
import { startTestHost, type TestHost, TOKEN } from "./helpers.ts";

const REMOTE = { enabled: false, port: 0, bindHost: "127.0.0.1", mdns: false } as const;
const repo = resolve(import.meta.dirname, "../../..");

async function expectFailure(promise: Promise<unknown>, reason: string): Promise<Record<string, unknown>> {
	try {
		await promise;
	} catch (error) {
		const data = (error as { data?: Record<string, unknown> }).data ?? {};
		expect(data.reason, (error as Error).message).toBe(reason);
		return data;
	}
	throw new Error(`Expected ${reason}`);
}

describe("ssh pairing helper (pier cli --ssh-pair)", () => {
	let a: TestHost;
	let b: TestHost;
	let aDesktop: PierClient;
	let bCli: PierClient;

	beforeEach(async () => {
		[a, b] = await Promise.all([
			startTestHost({ peers: { openTimeoutMs: 1000 } }),
			startTestHost({ remote: { ...REMOTE, approvalTimeoutMs: 5000 } }),
		]);
		aDesktop = await a.connect();
		bCli = await b.connect();
	});
	afterEach(async () => {
		await Promise.all([a.close(), b.close()]);
	});

	it("turns on remote access and accepts only the requested computer", async () => {
		const fingerprint = (await aDesktop.request("remote.status")).hostFingerprint;
		const outputs: SshPairOutput[] = [];
		const helper = runSshPair(bCli, { fingerprint, timeoutMs: 10_000 }, (o) => outputs.push(o));
		await expect.poll(() => outputs[0]?.type, { timeout: 10_000 }).toBe("uri");
		const first = outputs[0] as Extract<SshPairOutput, { type: "uri" }>;
		expect(first.addresses.length).toBeGreaterThan(0);
		expect((await bCli.request("remote.status")).enabled).toBe(true);
		const { peer } = await aDesktop.request("peer.pair", { uri: first.uri }, { timeoutMs: 10_000 });
		expect(await helper).toMatchObject({ type: "done" });
		const devices = (await bCli.request("device.list")).devices;
		expect(devices.map((d) => d.id)).toEqual([peer.deviceId]);
	});

	it("declines a computer with another key", async () => {
		const outputs: SshPairOutput[] = [];
		const helper = runSshPair(bCli, { fingerprint: "00:00", timeoutMs: 10_000 }, (o) => outputs.push(o));
		await expect.poll(() => outputs[0]?.type, { timeout: 10_000 }).toBe("uri");
		const uri = (outputs[0] as Extract<SshPairOutput, { type: "uri" }>).uri;
		await expect(aDesktop.request("peer.pair", { uri }, { timeoutMs: 10_000 })).rejects.toMatchObject({
			data: { reason: "PAIRING_REJECTED" },
		});
		helper.catch(() => undefined);
		expect((await bCli.request("device.list")).devices).toEqual([]);
	});
});

/** An SSH server whose sessions run `sh -c` in a sandbox home (`alice` / `secret`). */
async function startSshServer(home: string) {
	const hostKey = utils.generateKeyPairSync("ed25519");
	// Commands still running when a test ends (e.g. after a cancel) keep `home` as their working
	// directory, and Windows refuses to delete it until they exit, so close() waits for them.
	const children = new Set<Promise<void>>();
	let onHeldCommand: (() => void) | undefined;
	const server = new Server({ hostKeys: [hostKey.private] }, (client: Connection) => {
		client.on("authentication", (ctx) => {
			if (ctx.method === "password" && ctx.username === "alice" && ctx.password === "secret") ctx.accept();
			else ctx.reject(["password"]);
		});
		client.on("ready", () => {
			client.on("session", (acceptSession) => {
				const session = acceptSession();
				session.on("exec", (accept, _reject, info) => {
					const stream = accept();
					if (onHeldCommand) {
						const held = onHeldCommand;
						onHeldCommand = undefined;
						stream.resume();
						held();
						return;
					}
					const { PIER_DIR: _dir, ...env } = process.env;
					const child = spawn("sh", ["-c", info.command], { cwd: home, env: { ...env, HOME: home } });
					const exited = new Promise<void>((done) => {
						child.on("close", () => done());
						child.on("error", () => done());
					});
					children.add(exited);
					void exited.then(() => children.delete(exited));
					child.stdin.on("error", () => {});
					stream.pipe(child.stdin);
					child.stdout.pipe(stream, { end: false });
					child.stderr.pipe(stream.stderr);
					child.on("close", (code) => {
						stream.exit(code ?? 1);
						stream.end();
					});
					stream.on("close", () => child.kill());
				});
			});
		});
		client.on("error", () => {});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;
	const blob = Buffer.from(hostKey.public.trim().split(/\s+/)[1] as string, "base64");
	return {
		port,
		fingerprint: hostKeyFingerprint(blob),
		blob,
		// Keep one command pending without running platform-specific shell commands.
		holdNextCommand: () =>
			new Promise<void>((resolve) => {
				onHeldCommand = resolve;
			}),
		close: async () => {
			await new Promise<void>((done) => server.close(() => done()));
			await Promise.all(children);
		},
	};
}

describe("peer.sshAdd", () => {
	let a: TestHost;
	let b: TestHost;
	let aDesktop: PierClient;
	let ssh: Awaited<ReturnType<typeof startSshServer>>;
	let home: string;
	let knownHosts: string;

	beforeEach(async () => {
		b = await startTestHost({ remote: { ...REMOTE, approvalTimeoutMs: 5000 } });
		home = join(b.root, "home");
		knownHosts = join(b.root, "known_hosts");
		writeFileSync(knownHosts, "");
		// The "other computer": a running Pier (b) that the sandbox home points at.
		mkdirSync(join(home, ".pier", "run"), { recursive: true });
		writeFileSync(
			join(home, ".pier", "run", "host.json"),
			JSON.stringify({ url: b.url, token: TOKEN, pid: process.pid, version: PIER_HOST_VERSION }, null, 2),
		);
		// Stands in for the release executable copied there: only `--version` and `cli` are used.
		const fake = join(b.root, "pier-fake");
		writeFileSync(
			fake,
			`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pier ${PIER_HOST_VERSION}"; exit 0; fi\nif [ "$1" = cli ]; then shift; exec ${JSON.stringify(join(repo, "node_modules/.bin/tsx"))} ${JSON.stringify(join(repo, "packages/client/src/cli.ts"))} "$@"; fi\nexit 9\n`,
		);
		chmodSync(fake, 0o755);
		ssh = await startSshServer(home);
		a = await startTestHost({
			peers: { openTimeoutMs: 1000 },
			sshAdd: {
				knownHostsFiles: [knownHosts],
				executable: { path: fake, version: PIER_HOST_VERSION, arch: process.arch === "arm64" ? "arm64" : "x64" },
			},
		});
		aDesktop = await a.connect();
	});
	afterEach(async () => {
		await ssh.close();
		await Promise.all([a.close(), b.close()]);
		rmSync(home, { recursive: true, force: true });
	});

	const params = (extra: Record<string, unknown> = {}) => ({
		operationId: "op-1",
		host: "127.0.0.1",
		port: ssh.port,
		username: "alice",
		auth: { type: "password" as const, password: "secret" },
		...extra,
	});

	// The sandbox "server" runs this machine's own `sh`, which is only a Linux one on Linux.
	it.skipIf(process.platform !== "linux")(
		"asks to confirm a new server key, then copies Pier there and pairs without a confirmation",
		async () => {
			const data = await expectFailure(aDesktop.request("peer.sshAdd", params()), "HOST_KEY_UNKNOWN");
			expect(data).toMatchObject({ fingerprint: ssh.fingerprint, keyType: "ssh-ed25519" });

			const progress: SshAddProgress[] = [];
			aDesktop.onEvent((frame: EventFrame) => {
				if (frame.event.type === "peer.sshProgress") progress.push(frame.event as unknown as SshAddProgress);
			});
			const result = await aDesktop.request("peer.sshAdd", params({ hostKeyFingerprint: ssh.fingerprint }), {
				timeoutMs: 60_000,
			});
			expect(result.action).toBe("existing");
			expect(result.version).toBe(PIER_HOST_VERSION);
			expect(result.peer.addresses[0]).toMatch(/^127\.0\.0\.1:\d+$/);
			expect(new Set(progress.map((p) => p.step))).toEqual(new Set(["connect", "detect", "upload", "pair"]));
			expect(progress.every((p) => p.operationId === "op-1")).toBe(true);
			expect((await aDesktop.request("peer.list")).peers.map((p) => p.id)).toEqual([result.peer.id]);
			const bDesktop = await b.connect();
			expect((await bDesktop.request("device.list")).devices.map((d) => d.id)).toEqual([result.peer.deviceId]);
			// The copied executable was removed again; the key was remembered.
			expect(readFileSync(join(a.root, "pier", "ssh_known_hosts"), "utf8")).toContain(
				`[127.0.0.1]:${ssh.port} ssh-ed25519`,
			);
			const leftovers = spawn("sh", ["-c", `ls -A ${JSON.stringify(join(home, ".cache/pier/ssh-install"))}`]);
			let listing = "";
			leftovers.stdout.on("data", (d: Buffer) => {
				listing += d.toString();
			});
			await new Promise((done) => leftovers.on("close", done));
			expect(listing.trim()).toBe("");
		},
		90_000,
	);

	it("reports changed server keys and wrong passwords", async () => {
		const other = utils.generateKeyPairSync("ed25519").public.trim().split(/\s+/)[1];
		writeFileSync(knownHosts, `[127.0.0.1]:${ssh.port} ssh-ed25519 ${other}\n`);
		const data = await expectFailure(
			aDesktop.request("peer.sshAdd", params({ hostKeyFingerprint: ssh.fingerprint })),
			"HOST_KEY_MISMATCH",
		);
		expect(data).toMatchObject({ fingerprint: ssh.fingerprint, knownHostsFile: knownHosts });
		writeFileSync(knownHosts, "");
		await expectFailure(
			aDesktop.request(
				"peer.sshAdd",
				params({ auth: { type: "password", password: "wrong" }, hostKeyFingerprint: ssh.fingerprint }),
			),
			"SSH_AUTH_FAILED",
		);
		await expectFailure(
			aDesktop.request("peer.sshAdd", params({ auth: { type: "key", privateKey: "not a key" } })),
			"SSH_KEY_INVALID",
		);
	});

	it("can be cancelled", async () => {
		const commandStarted = ssh.holdNextCommand();
		const pending = aDesktop
			.request("peer.sshAdd", params({ hostKeyFingerprint: ssh.fingerprint }), { timeoutMs: 60_000 })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await commandStarted;
		expect(await aDesktop.request("peer.sshCancel", { operationId: "op-1" })).toEqual({ cancelled: true });
		expect(await pending).toMatchObject({ data: { reason: "CANCELLED" } });
		expect(await aDesktop.request("peer.sshCancel", { operationId: "op-1" })).toEqual({ cancelled: false });
	});
});
