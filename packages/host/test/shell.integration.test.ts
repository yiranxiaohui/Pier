import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { PierClient } from "@pier/client";
import type { AppUpdateStatus, PairingRequest, PeerInfo } from "@pier/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { PIER_HOST_VERSION } from "../src/host.ts";
import {
	parseUpdateStatus,
	SHELL_REQUEST,
	SHELL_RESPONSE,
	SHELL_UPDATE_STATUS,
	type ShellMethod,
	StdioShell,
} from "../src/shell.ts";
import { standaloneExecutable } from "../src/standalone/self.ts";
import { Recorder, startTestHost, type TestHost, TOKEN } from "./helpers.ts";

const REMOTE = { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } as const;

const IDLE = { state: "idle", currentVersion: "0.2.9", autoCheck: true, downloaded: 0 } as const;

/** The desktop app on the other end of the sidecar's stdio, with a scripted updater. */
class FakeShell {
	/** shell → host (the host's stdin). */
	readonly toHost = new PassThrough();
	/** host → shell (the host's stdout). */
	readonly fromHost = new PassThrough();
	readonly requests: string[] = [];
	answer: (method: ShellMethod) => { ok: true; result: unknown } | { ok: false; error: string } = () => ({
		ok: true,
		result: IDLE,
	});
	private buffer = "";

	constructor() {
		this.fromHost.setEncoding("utf8");
		this.fromHost.on("data", (chunk: string) => {
			this.buffer += chunk;
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf("\n");
				const message = JSON.parse(line) as { type: string; id: string; method: ShellMethod };
				if (message.type !== SHELL_REQUEST) continue;
				this.requests.push(message.method);
				this.send({ type: SHELL_RESPONSE, id: message.id, ...this.answer(message.method) });
			}
		});
	}

	send(message: unknown): void {
		this.toHost.write(`${JSON.stringify(message)}\n`);
	}

	pushStatus(status: unknown): void {
		this.send({ type: SHELL_UPDATE_STATUS, status });
	}
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ code });
}

describe("parseUpdateStatus", () => {
	it("accepts the Rust status (null for missing fields) and drops empty fields", () => {
		expect(
			parseUpdateStatus({
				state: "available",
				currentVersion: "0.2.9",
				autoCheck: true,
				version: "0.3.0",
				notes: "### Fixed",
				date: null,
				downloaded: 0,
				total: null,
				error: null,
				lastChecked: 1234,
				installNeedsAuth: false,
			}),
		).toEqual({
			state: "available",
			currentVersion: "0.2.9",
			autoCheck: true,
			version: "0.3.0",
			notes: "### Fixed",
			downloaded: 0,
			lastChecked: 1234,
		});
	});

	it("rejects unknown states and missing versions", () => {
		expect(parseUpdateStatus({ ...IDLE, state: "exploded" })).toBeUndefined();
		expect(parseUpdateStatus({ ...IDLE, currentVersion: "" })).toBeUndefined();
		expect(parseUpdateStatus(null)).toBeUndefined();
	});
});

describe("StdioShell", () => {
	it("tracks pushed statuses, answers requests, and fails pending ones when the app goes away", async () => {
		const fake = new FakeShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost, { timeoutMs: 1000 });
		expect(shell.updateStatus).toBeUndefined();
		const seen: AppUpdateStatus[] = [];
		shell.onUpdateStatus((status) => seen.push(status));
		fake.send("not json");
		fake.pushStatus({ ...IDLE, state: "nonsense" });
		fake.pushStatus(IDLE);
		await expect.poll(() => shell.updateStatus).toEqual(IDLE);
		expect(seen).toEqual([IDLE]);

		fake.answer = () => ({ ok: true, result: { ...IDLE, state: "upToDate" } });
		expect(await shell.request("update.check")).toMatchObject({ state: "upToDate" });
		fake.answer = () => ({ ok: false, error: "检查更新失败：offline" });
		await expect(shell.request("update.check")).rejects.toThrow("检查更新失败：offline");

		fake.answer = () => ({ ok: true, result: IDLE });
		fake.fromHost.removeAllListeners("data");
		const pending = shell.request("update.install");
		fake.toHost.end();
		await expect(pending).rejects.toThrow(/not reachable/);
		await expect(shell.request("update.check")).rejects.toThrow(/not reachable/);
	});

	it("times out when the app does not answer", async () => {
		const shell = new StdioShell(new PassThrough(), new PassThrough(), { timeoutMs: 50 });
		await expect(shell.request("update.check")).rejects.toThrow(/did not answer/);
		shell.close();
	});
});

describe("update.* (the desktop app's updater through the host)", () => {
	const hosts: TestHost[] = [];
	const clients: PierClient[] = [];
	afterEach(async () => {
		for (const client of clients.splice(0)) client.close();
		await Promise.all(hosts.splice(0).map((h) => h.close()));
	});

	it("is unsupported without a desktop app", async () => {
		const t = await startTestHost();
		hosts.push(t);
		const client = await t.connect();
		expect(await client.request("update.status")).toEqual({
			state: "unsupported",
			currentVersion: PIER_HOST_VERSION,
			autoCheck: false,
			downloaded: 0,
		});
		await expectCode(client.request("update.check"), "UNSUPPORTED");
		await expectCode(client.request("update.install"), "UNSUPPORTED");
	});

	it("tells paired computers how the single-file Pier updates without a desktop app", async () => {
		standaloneExecutable.path = "/opt/pier/current/pier";
		standaloneExecutable.installed = true;
		try {
			const t = await startTestHost();
			hosts.push(t);
			const client = await t.connect();
			expect(await client.request("update.status")).toMatchObject({
				state: "unsupported",
				error: expect.stringContaining("pier update"),
			});
			standaloneExecutable.installed = false;
			expect((await client.request("update.status")).error).toContain("重新运行安装脚本");
		} finally {
			delete standaloneExecutable.path;
			delete standaloneExecutable.installed;
		}
	});

	it("relays the app's status, checks and installs", async () => {
		const fake = new FakeShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		const t = await startTestHost({ shell });
		hosts.push(t);
		const client = await t.connect();
		const events = new Recorder();
		client.onEvent(events.handler);

		// An app that has not reported an updater (an older one) cannot be driven.
		expect((await client.request("update.status")).state).toBe("unsupported");
		await expectCode(client.request("update.check"), "UNSUPPORTED");
		expect(fake.requests).toEqual([]);

		fake.pushStatus(IDLE);
		expect((await events.waitForType("update.status")).event.status).toEqual(IDLE);
		expect(await client.request("update.status")).toEqual(IDLE);

		fake.answer = () => ({ ok: true, result: { ...IDLE, state: "available", version: "0.3.0" } });
		expect(await client.request("update.check")).toMatchObject({ state: "available", version: "0.3.0" });
		fake.answer = () => ({ ok: false, error: "更新已在进行中" });
		await expect(client.request("update.install")).rejects.toMatchObject({
			code: "INTERNAL",
			message: "更新已在进行中",
		});
		expect(fake.requests).toEqual(["update.check", "update.install"]);

		fake.pushStatus({ ...IDLE, state: "unsupported" });
		await events.waitFor(
			(f) => f.event.type === "update.status" && (f.event.status as AppUpdateStatus).state === "unsupported",
		);
		await expectCode(client.request("update.install"), "UNSUPPORTED");
	});

	it("lets a paired computer update Pier here, telling the local window and the audit log", async () => {
		const fake = new FakeShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		const [a, b] = await Promise.all([
			startTestHost({ peers: { openTimeoutMs: 1000 } }),
			startTestHost({ remote: { ...REMOTE, approvalTimeoutMs: 2000 }, shell }),
		]);
		hosts.push(a, b);
		const aDesktop = await a.connect();
		const bDesktop = await b.connect();
		const bEvents = new Recorder();
		bDesktop.onEvent(bEvents.handler);

		const { uri } = await bDesktop.request("pairing.start");
		void bEvents.waitForType("pairing.request").then((frame) =>
			bDesktop.request("pairing.respond", {
				requestId: (frame.event.request as PairingRequest).id,
				accept: true,
			}),
		);
		const peer: PeerInfo = (await aDesktop.request("peer.pair", { uri }, { timeoutMs: 10_000 })).peer;
		const remote = new PierClient({
			url: `${a.url}/peer/${encodeURIComponent(peer.id)}`,
			token: TOKEN,
			client: { name: "pier-desktop", version: "0.0.0" },
		});
		clients.push(remote);
		await remote.connect();
		const remoteEvents = new Recorder();
		remote.onEvent(remoteEvents.handler);

		fake.pushStatus({ ...IDLE, state: "available", version: "0.3.0" });
		// Status events reach paired computers too.
		await remoteEvents.waitFor(
			(f) => f.event.type === "update.status" && (f.event.status as AppUpdateStatus).state === "available",
		);

		const from = bEvents.mark();
		fake.answer = () => ({
			ok: true,
			result: { ...IDLE, state: "downloading", version: "0.3.0", downloaded: 0, total: 1000 },
		});
		expect(await remote.request("update.install")).toMatchObject({ state: "downloading", version: "0.3.0" });
		const notice = await bEvents.waitForType("host.notice", from);
		expect(notice.event.message).toContain(a.host.info().hostName);
		expect(notice.event.message).toContain("v0.3.0");
		// The paired computer asking gets no notice about itself.
		expect(remoteEvents.types()).not.toContain("host.notice");

		const audit = readFileSync(join(b.root, "pier", "audit.log"), "utf8");
		expect(audit).toContain('"event":"update.install"');
	});
});
