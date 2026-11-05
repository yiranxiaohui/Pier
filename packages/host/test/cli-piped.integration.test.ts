import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestHost, type TestHost, TOKEN } from "./helpers.ts";

const repo = resolve(import.meta.dirname, "../../..");

/** Run `pier cli` against `host` with `input` piped to stdin, as scripts and the release smoke test do. */
function runCli(host: TestHost, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(
			join(repo, "node_modules/.bin/tsx"),
			[join(repo, "packages/client/src/cli.ts"), "--url", host.url, "--token", TOKEN],
			{ env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
		// The whole input, end of input included, arrives before the CLI has finished connecting.
		child.stdin.end(input);
	});
}

describe("pier cli with piped input", () => {
	let host: TestHost;

	beforeEach(async () => {
		host = await startTestHost({ remote: { enabled: false, port: 0, bindHost: "127.0.0.1", mdns: false } });
	});
	afterEach(async () => {
		await host.close();
	});

	it("runs every command before the end of input", async () => {
		const result = await runCli(host, "/remote on\n/pair\n");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("pier://");
		const client = await host.connect();
		expect((await client.request("remote.status")).enabled).toBe(true);
		client.close();
	}, 60_000);

	it("stops at /quit", async () => {
		const result = await runCli(host, "/remote\n/quit\n/remote on\n");
		expect(result.code).toBe(0);
		const client = await host.connect();
		expect((await client.request("remote.status")).enabled).toBe(false);
		client.close();
	}, 60_000);
});
