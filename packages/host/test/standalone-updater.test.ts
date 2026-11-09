import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Installation } from "../src/standalone/service.ts";
import { downloadStandaloneRelease, latestStandaloneRelease } from "../src/standalone/update-release.ts";
import { writeUpdateReceipt } from "../src/standalone/update-worker.ts";
import { StandaloneUpdater } from "../src/standalone/updater.ts";

const roots: string[] = [];
const updaters: StandaloneUpdater[] = [];
afterEach(() => {
	for (const updater of updaters.splice(0)) updater.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pier-updater-test-"));
	roots.push(root);
	const config: Installation = {
		format: 1,
		app: "pier",
		scope: "user",
		prefix: root,
		stateDir: join(root, "state"),
		configHome: join(root, "config"),
		installDir: join(root, "share/pier"),
		binDir: join(root, "bin"),
		serviceFile: join(root, "config/systemd/user/pier.service"),
		version: "1.0.0",
	};
	mkdirSync(config.installDir, { recursive: true });
	return { root, config };
}
function updater(options: ConstructorParameters<typeof StandaloneUpdater>[0]) {
	const value = new StandaloneUpdater(options);
	updaters.push(value);
	return value;
}
function response(url: string, body: string, status = 200) {
	const result = new Response(body, { status });
	Object.defineProperty(result, "url", { value: url });
	return result;
}

describe("standalone updater", () => {
	it("explains unsupported installations and never fetches", async () => {
		const latest = vi.fn();
		const value = updater({ version: "1.0.0", unsupported: "请先安装服务", latest });
		expect(value.updateStatus).toMatchObject({ state: "unsupported", error: "请先安装服务" });
		await expect(value.request("update.install")).rejects.toThrow("请先安装服务");
		expect(latest).not.toHaveBeenCalled();
	});
	it.each(["v1.0.0", "v0.9.0"])("does not reinstall or downgrade to %s", async (tag) => {
		const value = updater({ version: "1.0.0", latest: async () => ({ tag }) });
		expect(await value.request("update.install")).toMatchObject({ state: "upToDate" });
		expect(value.updateStatus.version).toBeUndefined();
	});
	it("coalesces checks and starts just one background installer with progress", async () => {
		const { config } = fixture();
		let finish!: (release: { tag: string }) => void;
		const latest = vi.fn(
			() =>
				new Promise<{ tag: string }>((resolve) => {
					finish = resolve;
				}),
		);
		const download = vi.fn(async (_tag, binary, options) => {
			writeFileSync(binary, "new binary");
			options?.onProgress?.(10, 20);
			return "a".repeat(64);
		});
		const launch = vi.fn(async () => {});
		const value = updater({ version: "1.0.0", config, latest, download, launch });
		const states: string[] = [];
		value.onUpdateStatus((status) => states.push(`${status.state}:${status.downloaded}`));
		const a = value.request("update.install");
		const b = value.request("update.install");
		finish({ tag: "v1.0.1" });
		expect(await a).toMatchObject({ state: "downloading", version: "1.0.1" });
		expect(await b).toMatchObject({ state: "downloading" });
		await expect.poll(() => launch.mock.calls.length).toBe(1);
		expect(latest).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledTimes(1);
		expect(states).toContain("downloading:10");
		expect(value.updateStatus.state).toBe("installing");
		expect(await value.request("update.install")).toMatchObject({ state: "installing" });
		value.close();
		// Ownership was handed off: Host shutdown must not delete the helper's release.
		expect(existsSync(download.mock.calls[0]?.[1] ?? "")).toBe(true);
	});
	it("does not delete staging when shutdown interrupts the launcher after handoff", async () => {
		const { config } = fixture();
		let rejectLaunch: ((error: Error) => void) | undefined;
		let binary = "";
		const value = updater({
			version: "1.0.0",
			config,
			latest: async () => ({ tag: "v1.0.1" }),
			download: async (_tag, path) => {
				binary = path;
				writeFileSync(path, "staged");
				return "a".repeat(64);
			},
			launch: () =>
				new Promise<void>((_resolve, reject) => {
					rejectLaunch = reject;
				}),
		});
		await value.request("update.install");
		await expect.poll(() => rejectLaunch !== undefined).toBe(true);
		value.close();
		rejectLaunch?.(new Error("systemd-run terminated with the old Host"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(binary)).toBe(true);
	});
	it("keeps release information on check failure and retries the check before installing", async () => {
		const latest = vi
			.fn()
			.mockResolvedValueOnce({ tag: "v1.0.1", notes: "fix" })
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue({ tag: "v1.0.2" });
		const value = updater({ version: "1.0.0", latest });
		await value.request("update.check");
		expect(await value.request("update.check")).toMatchObject({
			state: "error",
			version: "1.0.1",
			notes: "fix",
			error: "offline",
		});
		expect(await value.request("update.install")).toMatchObject({ state: "downloading", version: "1.0.2" });
		value.close();
	});
	it.each(["download", "launch"])(
		"reports %s failure without losing the original installation; retry works",
		async (step) => {
			const { config } = fixture();
			const download = vi.fn(async () => "a".repeat(64));
			const launch = vi.fn(async () => {});
			(step === "download" ? download : launch).mockRejectedValueOnce(new Error("failed safely"));
			const value = updater({ version: "1.0.0", config, latest: async () => ({ tag: "v1.0.1" }), download, launch });
			await value.request("update.install");
			await expect.poll(() => value.updateStatus.state).toBe("error");
			expect(value.updateStatus.error).toBe("failed safely");
			if (step === "download") expect(launch).not.toHaveBeenCalled();
			expect(await value.request("update.install")).toMatchObject({ state: "downloading" });
			value.close();
		},
	);
	it("reads a durable rollback failure, then allows a new check", async () => {
		const { config } = fixture();
		writeUpdateReceipt(config, {
			version: "1.0.1",
			pid: process.pid + 1,
			state: "error",
			error: "previous binary restored",
		});
		const value = updater({ version: "1.0.0", config, latest: async () => ({ tag: "v1.0.1" }) });
		expect(value.updateStatus).toMatchObject({ state: "error", error: "previous binary restored" });
		expect(await value.request("update.check")).toMatchObject({ state: "available" });
		expect(existsSync(join(config.installDir, "remote-update.json"))).toBe(false);
	});
	it("reports a successful restart and rejects requests after shutdown", async () => {
		const { config } = fixture();
		writeUpdateReceipt(config, { version: "1.0.1", pid: process.pid + 1, state: "done" });
		const value = updater({ version: "1.0.1", config });
		expect(value.updateStatus.state).toBe("upToDate");
		value.close();
		await expect(value.request("update.check")).rejects.toThrow("closed");
	});
});

describe("standalone Release trust boundary", () => {
	it("accepts only official stable metadata and ignores arbitrary asset URLs", async () => {
		const fetch = vi.fn(async (url: string) =>
			response(
				url,
				JSON.stringify({
					tag_name: "v1.0.1",
					body: "notes",
					assets: [{ browser_download_url: "https://evil.test/pier" }],
				}),
			),
		);
		vi.stubGlobal("fetch", fetch);
		expect(await latestStandaloneRelease()).toEqual({ tag: "v1.0.1", notes: "notes" });
		expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/yiranxiaohui/Pier/releases/latest");
	});
	it.each(["../../bad", "v1.0.0-beta.1"])("rejects an invalid latest tag %s", async (tag) => {
		vi.stubGlobal("fetch", async (url: string) => response(url, JSON.stringify({ tag_name: tag })));
		await expect(latestStandaloneRelease()).rejects.toThrow();
	});
	it.skipIf(process.platform === "win32")("checks SHA-256 and executable version before handoff", async () => {
		const { root } = fixture();
		const binary = "#!/bin/sh\necho 'pier 1.0.1'\n";
		const checksum = createHash("sha256").update(binary).digest("hex");
		vi.stubGlobal("fetch", async (url: string) =>
			response(url, url.endsWith("SHA256SUMS.txt") ? `${checksum}  pier-v1.0.1-linux-${process.arch}\n` : binary),
		);
		const progress = vi.fn();
		expect(await downloadStandaloneRelease("v1.0.1", join(root, "pier"), { onProgress: progress })).toBe(checksum);
		expect(readFileSync(join(root, "pier"), "utf8")).toBe(binary);
		expect(progress).toHaveBeenLastCalledWith(Buffer.byteLength(binary), Buffer.byteLength(binary));
	});
	it("rejects a checksum mismatch without executing the downloaded file", async () => {
		const { root } = fixture();
		const marker = join(root, "executed");
		vi.stubGlobal("fetch", async (url: string) =>
			response(
				url,
				url.endsWith("SHA256SUMS.txt")
					? `${"a".repeat(64)}  pier-v1.0.1-linux-${process.arch}\n`
					: `#!/bin/sh\ntouch '${marker}'\n`,
			),
		);
		await expect(downloadStandaloneRelease("v1.0.1", join(root, "pier"))).rejects.toThrow("checksum mismatch");
		expect(existsSync(marker)).toBe(false);
	});
	it.skipIf(process.platform === "win32")(
		"rejects a checksum-valid executable reporting the wrong version",
		async () => {
			const { root } = fixture();
			const binary = "#!/bin/sh\necho 'pier 1.0.0'\n";
			const sum = createHash("sha256").update(binary).digest("hex");
			vi.stubGlobal("fetch", async (url: string) =>
				response(url, url.endsWith("SHA256SUMS.txt") ? `${sum}  pier-v1.0.1-linux-${process.arch}\n` : binary),
			);
			await expect(downloadStandaloneRelease("v1.0.1", join(root, "pier"))).rejects.toThrow("version check failed");
		},
	);
	it("rejects an HTTPS downgrade", async () => {
		vi.stubGlobal("fetch", async () => response("http://bad.test", "{}"));
		await expect(latestStandaloneRelease()).rejects.toThrow("download failed");
	});
});
