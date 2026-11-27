import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { opencodePaths, opencodeTarget, publishOpenCode } from "../src/opencode/installer.ts";
import { AgentInstaller } from "../src/runtimes/installation.ts";
import { configureInstallationPath } from "../src/runtimes/installation-path.ts";
import { Recorder, startTestHost } from "./helpers.ts";

const TARGET = "linux-x64";
const filename = process.platform === "win32" ? "opencode.exe" : "opencode";
const assetName = `opencode-${TARGET}${process.platform === "linux" ? ".tar.gz" : ".zip"}`;
const LATEST = "https://registry.npmjs.org/opencode-ai/latest";
const RELEASES = "https://api.github.com/repos/anomalyco/opencode/releases";
const asset = (version: string) => `https://github.com/anomalyco/opencode/releases/download/v${version}/${assetName}`;
const mirrorUrl = (version: string) =>
	`https://registry.npmmirror.com/opencode-${TARGET}/-/opencode-${TARGET}-${version}.tgz`;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function release(version: string, digest: string, extra: Record<string, unknown> = {}) {
	return {
		tag_name: `v${version}`,
		draft: false,
		prerelease: false,
		assets: [{ name: assetName, browser_download_url: asset(version), digest: `sha256:${digest}` }],
		...extra,
	};
}

describe("OpenCode installation", () => {
	let root: string;
	const installers: AgentInstaller[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-opencode-installer-"));
	});
	afterEach(async () => {
		await Promise.all(installers.splice(0).map((i) => i.shutdown()));
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	/** A release archive (GitHub, `opencode` at its root) or an npm package (`package/bin/opencode`). */
	const archive = (contents: string, layout: "github" | "npm" = "github") => {
		const dir = mkdtempSync(join(root, "fixture-"));
		const relative = layout === "npm" ? join("package", "bin", filename) : filename;
		mkdirSync(join(dir, relative, ".."), { recursive: true });
		writeFileSync(join(dir, relative), contents, { mode: 0o755 });
		if (layout === "npm") writeFileSync(join(dir, "package", "package.json"), "{}");
		const file = join(root, `fixture-${Math.random().toString(16).slice(2)}.tgz`);
		execFileSync("tar", ["-czf", file, "-C", dir, layout === "npm" ? "package" : filename]);
		rmSync(dir, { recursive: true });
		return readFileSync(file);
	};

	const create = (options: ConstructorParameters<typeof AgentInstaller>[1]) => {
		const installer = new AgentInstaller(join(root, "managed"), {
			homeDirectory: root,
			configurePath: (bin, options) => configureInstallationPath(bin, { ...options, platform: "linux", env: {} }),
			opencodeTarget: async () => TARGET,
			// The fixtures contain their version instead of a runnable program.
			probe: async (path) => readFileSync(path, "utf8"),
			...options,
		});
		installers.push(installer);
		return installer;
	};

	async function finished(installer: AgentInstaller) {
		await vi.waitFor(() => expect(["ready", "error"]).toContain(installer.status("opencode").state), {
			timeout: 5_000,
		});
		return installer.status("opencode");
	}

	const command = () => opencodePaths(root).executable;

	it("installs the latest OpenCode 1 release from GitHub into ~/.opencode/bin", async () => {
		const bytes = archive("1.19.6");
		const onInstalled = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
			if (String(url) === `${RELEASES}/tags/v1.19.6`) return Response.json(release("1.19.6", sha256(bytes)));
			if (String(url) === asset("1.19.6")) return new Response(new Uint8Array(bytes));
			throw new Error(`unexpected ${url}`);
		});
		const installer = create({ fetch, onInstalled });
		expect(installer.start("opencode")).toMatchObject({ state: "checking", source: "official" });
		expect(await finished(installer)).toMatchObject({ state: "ready", version: "1.19.6" });
		expect(readFileSync(command(), "utf8")).toBe("1.19.6");
		expect(onInstalled).toHaveBeenCalledWith("opencode");
		// New terminals find the same command; staging files are removed.
		expect(readFileSync(join(root, ".profile"), "utf8")).toContain(opencodePaths(root).bin);
		expect(readdirSync(opencodePaths(root).root).sort()).toEqual(["bin"]);
		expect(readdirSync(opencodePaths(root).bin)).toEqual([filename]);
	});

	it("relays the GitHub download through an acceleration route", async () => {
		const bytes = archive("1.19.6");
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
			if (String(url).startsWith(RELEASES)) return Response.json(release("1.19.6", sha256(bytes)));
			return new Response(new Uint8Array(bytes));
		});
		const installer = create({ fetch });
		installer.start("opencode", "gh-proxy");
		expect(await finished(installer)).toMatchObject({ state: "ready", source: "gh-proxy" });
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
			LATEST,
			`${RELEASES}/tags/v1.19.6`,
			`https://gh-proxy.com/${asset("1.19.6")}`,
		]);
	});

	it("uses the newest OpenCode 1 release with this platform's asset while GitHub is still publishing", async () => {
		const bytes = archive("1.19.5");
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
			if (String(url) === `${RELEASES}/tags/v1.19.6`) return new Response("not found", { status: 404 });
			if (String(url).startsWith(`${RELEASES}?`))
				return Response.json([
					release("2.3.2", sha256(bytes)),
					release("1.19.6", sha256(bytes), { assets: [] }),
					release("1.19.6-beta.1", sha256(bytes)),
					release("1.19.5", sha256(bytes)),
				]);
			if (String(url) === asset("1.19.5")) return new Response(new Uint8Array(bytes));
			throw new Error(`unexpected ${url}`);
		});
		const installer = create({ fetch });
		installer.start("opencode");
		expect(await finished(installer)).toMatchObject({ state: "ready", version: "1.19.5" });
		expect(readFileSync(command(), "utf8")).toBe("1.19.5");
	});

	it("downloads the npm package from npmmirror, verified against npmjs.org's SHA-512", async () => {
		const tarball = archive("1.19.6", "npm");
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
			if (String(url) === `https://registry.npmjs.org/opencode-${TARGET}/1.19.6`)
				return Response.json({ version: "1.19.6", dist: { integrity: integrity(tarball) } });
			if (String(url) === mirrorUrl("1.19.6")) return new Response(new Uint8Array(tarball));
			throw new Error(`unexpected ${url}`);
		});
		const installer = create({ fetch });
		installer.start("opencode", "npmmirror");
		expect(await finished(installer)).toMatchObject({ state: "ready", source: "npmmirror", version: "1.19.6" });
		expect(readFileSync(command(), "utf8")).toBe("1.19.6");
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
			LATEST,
			`https://registry.npmjs.org/opencode-${TARGET}/1.19.6`,
			mirrorUrl("1.19.6"),
		]);
	});

	it("rejects a mirrored package that does not match the official checksum", async () => {
		const probe = vi.fn(async () => "1.19.6");
		const installer = create({
			probe,
			fetch: async (url) => {
				if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
				if (String(url).startsWith("https://registry.npmjs.org/"))
					return Response.json({ dist: { integrity: integrity(Buffer.from("official")) } });
				return new Response(new Uint8Array(archive("1.19.6", "npm")));
			},
		});
		installer.start("opencode", "npmmirror");
		expect(await finished(installer)).toMatchObject({ state: "error", error: expect.stringContaining("SHA-512") });
		expect(probe).not.toHaveBeenCalled();
		expect(existsSync(command())).toBe(false);
		expect(readdirSync(opencodePaths(root).root)).toEqual(["bin"]);
	});

	it("replaces an older copy in ~/.opencode/bin and keeps an up-to-date one without downloading", async () => {
		mkdirSync(opencodePaths(root).bin, { recursive: true });
		writeFileSync(command(), "1.18.0");
		const bytes = archive("1.19.6");
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
			if (String(url).startsWith(RELEASES)) return Response.json(release("1.19.6", sha256(bytes)));
			return new Response(new Uint8Array(bytes));
		});
		const installer = create({ fetch });
		installer.start("opencode");
		expect(await finished(installer)).toMatchObject({ state: "ready" });
		expect(readFileSync(command(), "utf8")).toBe("1.19.6");
		fetch.mockClear();
		installer.start("opencode");
		expect(await finished(installer)).toMatchObject({ state: "ready", version: "1.19.6" });
		expect(fetch).toHaveBeenCalledTimes(2); // Version and checksum, no download.
	});

	it("keeps an up-to-date OpenCode installed elsewhere", async () => {
		const external = join(root, "npm-global", filename);
		mkdirSync(join(external, ".."), { recursive: true });
		writeFileSync(external, "1.19.6");
		const onInstalled = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
			String(url) === LATEST ? Response.json({ version: "1.19.6" }) : Response.json(release("1.19.6", "0".repeat(64))),
		);
		const installer = create({ fetch, onInstalled, currentOpenCode: () => external });
		installer.start("opencode");
		expect(await finished(installer)).toMatchObject({ state: "ready", version: "1.19.6" });
		expect(existsSync(command())).toBe(false);
		expect(onInstalled).not.toHaveBeenCalled();
	});

	it("updates the OpenCode the Host uses in the background, only to a newer OpenCode 1", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const external = join(root, "npm-global", filename);
		mkdirSync(join(external, ".."), { recursive: true });
		writeFileSync(external, "1.18.0");
		const bytes = archive("1.19.6");
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
			if (String(url).startsWith(RELEASES)) return Response.json(release("1.19.6", sha256(bytes)));
			return new Response(new Uint8Array(bytes));
		});
		const onInstalled = vi.fn();
		let enabled = true;
		const active = () => (existsSync(command()) ? command() : external);
		const installer = create({
			fetch,
			onInstalled,
			currentOpenCode: active,
			autoUpdateTarget: (runtime) =>
				runtime === "opencode" && enabled ? { executable: active(), source: "gh-proxy" } : undefined,
		});
		installer.startAutoUpdates();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await finished(installer)).toMatchObject({ state: "ready", source: "gh-proxy", version: "1.19.6" });
		expect(readFileSync(command(), "utf8")).toBe("1.19.6");
		expect(readFileSync(external, "utf8")).toBe("1.18.0");
		expect(onInstalled).toHaveBeenCalledWith("opencode");
		// The same release, a newer one installed elsewhere and OpenCode 2 stay as they are.
		for (const version of ["1.19.6", "1.20.0", "2.0.1"]) {
			writeFileSync(command(), version);
			fetch.mockClear();
			await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
			await vi.waitFor(() => expect(installer.status("opencode").state).toBe("idle"));
			expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([LATEST, `${RELEASES}/tags/v1.19.6`]);
			expect(readFileSync(command(), "utf8")).toBe(version);
		}
		expect(onInstalled).toHaveBeenCalledOnce();
		enabled = false;
		fetch.mockClear();
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not install OpenCode 2 or malformed versions", async () => {
		for (const [version, error] of [
			["2.3.2", "只能安装 OpenCode 1"],
			["../1.0.0", "无效版本"],
		] as const) {
			const installer = create({ fetch: async () => Response.json({ version }) });
			installer.start("opencode");
			expect(await finished(installer)).toMatchObject({ state: "error", error: expect.stringContaining(error) });
		}
		expect(existsSync(command())).toBe(false);
	});

	it("rejects release assets outside OpenCode's GitHub releases", async () => {
		const installer = create({
			fetch: async (url) => {
				if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
				const untrusted = release("1.19.6", "0".repeat(64), {
					assets: [
						{ name: assetName, browser_download_url: "https://example.com/opencode.tgz", digest: "0".repeat(64) },
					],
				});
				return Response.json(String(url).includes("?") ? [untrusted] : untrusted);
			},
		});
		installer.start("opencode", "ghfast");
		expect(await finished(installer)).toMatchObject({ state: "error", error: expect.stringContaining("npmmirror") });
	});

	it("moves a running Windows executable aside before replacing it", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "opencode.exe"), "old");
		writeFileSync(join(root, "new.exe"), "new");
		await publishOpenCode(join(root, "new.exe"), join(bin, "opencode.exe"), "win32");
		expect(readdirSync(bin)).toEqual(["opencode.exe"]);
		expect(readFileSync(join(bin, "opencode.exe"), "utf8")).toBe("new");
	});

	it("maps platforms to OpenCode's release names", () => {
		const cpu = { platform: "linux" as const, arch: "x64", musl: false, avx2: true };
		expect(opencodeTarget(cpu)).toBe("linux-x64");
		expect(opencodeTarget({ ...cpu, avx2: false, musl: true })).toBe("linux-x64-baseline-musl");
		expect(opencodeTarget({ ...cpu, arch: "arm64", avx2: false, musl: true })).toBe("linux-arm64-musl");
		expect(opencodeTarget({ ...cpu, platform: "darwin", avx2: false, musl: true })).toBe("darwin-x64-baseline");
		expect(opencodeTarget({ ...cpu, platform: "win32", arch: "arm64" })).toBe("windows-arm64");
		expect(() => opencodeTarget({ ...cpu, arch: "ia32" })).toThrow("暂不支持");
		expect(() => opencodeTarget({ ...cpu, platform: "freebsd" })).toThrow("暂不支持");
	});
});

it.skipIf(process.platform === "win32")(
	"installs OpenCode over the protocol and the Host uses the new command",
	async () => {
		const script = Buffer.from("#!/bin/sh\nprintf '1.19.6\\n'\n");
		const dir = mkdtempSync(join(tmpdir(), "pier-opencode-fixture-"));
		writeFileSync(join(dir, "opencode"), script, { mode: 0o755 });
		execFileSync("tar", ["-czf", join(dir, "release.tgz"), "-C", dir, "opencode"]);
		const bytes = readFileSync(join(dir, "release.tgz"));
		rmSync(dir, { recursive: true });
		vi.stubEnv("PIER_OPENCODE_PATH", "");
		const host = await startTestHost({
			agents: { opencode: {} },
			agentInstaller: {
				opencodeTarget: async () => TARGET,
				fetch: async (url) => {
					if (String(url) === LATEST) return Response.json({ version: "1.19.6" });
					if (String(url).startsWith(RELEASES)) return Response.json(release("1.19.6", sha256(bytes)));
					return new Response(new Uint8Array(bytes));
				},
			},
		});
		try {
			const client = await host.connect();
			const recorder = new Recorder();
			client.onEvent(recorder.handler);
			expect((await client.request("runtime.installStatus", { runtime: "opencode" })).autoUpdate).toBe(true);
			const changed = recorder.waitForType("runtime.changed", recorder.mark());
			expect(
				(await client.request("runtime.install", { runtime: "opencode", source: "ghproxy" })).installation,
			).toMatchObject({ state: "checking", source: "ghproxy" });
			expect((await changed).event).toMatchObject({ runtime: "opencode" });
			const result = await client.request("runtime.installStatus", { runtime: "opencode" });
			const executable = join(host.root, "home", ".opencode", "bin", "opencode");
			expect(result).toMatchObject({
				installation: { state: "ready", version: "1.19.6" },
				agent: { available: true, executable, version: "1.19.6" },
			});
			// Background updates (1.73) keep the route of the last manual installation.
			await client.request("runtime.setAutoUpdate", { runtime: "opencode", enabled: false });
			expect((await client.request("runtime.installStatus", { runtime: "opencode" })).autoUpdate).toBe(false);
			expect(new ConfigStore(join(host.root, "pier", "config.json")).agentUpdate("opencode")).toEqual({
				enabled: false,
				source: "ghproxy",
			});
		} finally {
			await host.close();
			vi.unstubAllEnvs();
		}
	},
);
