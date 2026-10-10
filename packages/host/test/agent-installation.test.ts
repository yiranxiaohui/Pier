import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfigRuntime } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExecutable } from "../src/runtimes/executable.ts";
import { AgentInstaller, installationTarget } from "../src/runtimes/installation.ts";
import { configureInstallationPath } from "../src/runtimes/installation-path.ts";
import { sharedAgentPaths } from "../src/runtimes/shared-installation.ts";
import { Recorder, startTestHost } from "./helpers.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function claudeDownloads(version: string, bytes = Buffer.from("native-cli"), checksum = sha256(bytes)) {
	const download = vi.fn<typeof fetch>(async (url) => {
		if (String(url).endsWith("/latest")) return new Response(version);
		if (String(url).endsWith("/manifest.json"))
			return Response.json({
				platforms: {
					[installationTarget().claude]: { checksum },
				},
			});
		return new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } });
	});
	return download;
}

async function finished(installer: AgentInstaller, runtime: AgentConfigRuntime) {
	await vi.waitFor(() => expect(["ready", "error"]).toContain(installer.status(runtime).state), { timeout: 5_000 });
	return installer.status(runtime);
}

describe("verified native Agent installation", () => {
	let root: string;
	const installers: AgentInstaller[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-installer-"));
		vi.stubEnv("PATH", process.env.PATH ?? "");
	});
	afterEach(async () => {
		await Promise.all(installers.splice(0).map((i) => i.shutdown()));
		rmSync(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});
	const create = (options: ConstructorParameters<typeof AgentInstaller>[1]) => {
		const installer = new AgentInstaller(root, {
			homeDirectory: root,
			configurePath: (bin, options) => configureInstallationPath(bin, { ...options, platform: "linux", env: {} }),
			...options,
		});
		installers.push(installer);
		return installer;
	};

	it("installs a verified native Claude binary and persists its selection across restarts", async () => {
		const onInstalled = vi.fn();
		const probe = vi.fn(async () => "2.1.0");
		const installer = create({ fetch: claudeDownloads("2.1.0"), probe, onInstalled });
		expect(installer.start("claude-code").state).toBe("checking");
		expect(await finished(installer, "claude-code")).toMatchObject({
			state: "ready",
			version: "2.1.0",
			downloadedBytes: 10,
		});
		const executable = AgentInstaller.executable(root, "claude-code", root);
		expect(executable).toBeDefined();
		expect(readFileSync(executable ?? "", "utf8")).toBe("native-cli");
		expect(probe).toHaveBeenCalledWith(expect.any(String), 15_000);
		expect(onInstalled).toHaveBeenCalledWith("claude-code");
		const restarted = create({});
		expect(restarted.status("claude-code").state).toBe("idle");
		expect(AgentInstaller.executable(root, "claude-code", root)).toBe(executable);
		vi.stubEnv("PATH", "");
		expect(findExecutable("claude", undefined, executable)).toBe(executable);
		expect(findExecutable("claude", join(root, "missing-override"), executable)).toBeUndefined();
	});

	it("keeps the previous executable when a download fails SHA-256 verification", async () => {
		const old = create({ fetch: claudeDownloads("2.1.0"), probe: async () => "2.1.0" });
		old.start("claude-code");
		await finished(old, "claude-code");
		const previous = AgentInstaller.executable(root, "claude-code", root);
		const probe = vi.fn(async () => "2.1.0");
		const installer = create({ fetch: claudeDownloads("2.2.0", Buffer.from("corrupt"), "0".repeat(64)), probe });
		installer.start("claude-code");
		expect(await finished(installer, "claude-code")).toMatchObject({
			state: "error",
			error: expect.stringContaining("SHA-256"),
		});
		expect(probe).toHaveBeenCalledTimes(1); // Only the old selection was probed; corrupt bytes never run.
		expect(AgentInstaller.executable(root, "claude-code", root)).toBe(previous);
		await installer.shutdown();
		expect(
			readdirSync(join(root, ".local", "share", "claude", "versions")).filter((n) => n.startsWith(".install-")),
		).toEqual([]);
	});

	it("rejects a binary that does not report the expected version", async () => {
		const installer = create({ fetch: claudeDownloads("2.1.0"), probe: async () => undefined });
		installer.start("claude-code");
		expect(await finished(installer, "claude-code")).toMatchObject({
			state: "error",
			error: expect.stringContaining("版本验证失败"),
		});
		expect(AgentInstaller.executable(root, "claude-code", root)).toBeUndefined();
	});

	it("updates the public command, keeps versioned releases and skips redundant downloads", async () => {
		const first = create({ fetch: claudeDownloads("2.1.0"), probe: async () => "2.1.0" });
		first.start("claude-code");
		await finished(first, "claude-code");
		const previous = AgentInstaller.executable(root, "claude-code", root);
		const download = claudeDownloads("2.2.0", Buffer.from("new-native-cli"));
		const next = create({
			fetch: download,
			probe: async (path) => (readFileSync(path, "utf8") === "new-native-cli" ? "2.2.0" : "2.1.0"),
		});
		next.start("claude-code");
		await finished(next, "claude-code");
		if (process.platform !== "win32") expect(AgentInstaller.executable(root, "claude-code", root)).not.toBe(previous);
		expect(
			readdirSync(sharedAgentPaths("claude-code", root).versions).filter((name) => !name.startsWith(".")),
		).toHaveLength(2);
		expect(readFileSync(AgentInstaller.executable(root, "claude-code", root) ?? "", "utf8")).toBe("new-native-cli");
		download.mockClear();
		next.start("claude-code");
		expect(await finished(next, "claude-code")).toMatchObject({ state: "ready", version: "2.2.0" });
		expect(download).toHaveBeenCalledTimes(2); // Version and manifest, no binary download.
	});

	it.each(["claude-code", "codex"] as const)("migrates a latest-version Pier-only %s installation", async (runtime) => {
		const legacy = join(root, runtime, "old", ...(runtime === "codex" ? ["bin"] : []));
		mkdirSync(legacy, { recursive: true });
		const filename = `${runtime === "codex" ? "codex" : "claude"}${process.platform === "win32" ? ".exe" : ""}`;
		writeFileSync(join(legacy, filename), "verified-legacy");
		if (runtime === "codex") writeFileSync(join(legacy, "companion"), "legacy-companion");
		writeFileSync(
			join(root, runtime, "current.json"),
			JSON.stringify({ executable: join("old", ...(runtime === "codex" ? ["bin"] : []), filename) }),
		);
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (String(url).endsWith("/latest")) {
				return runtime === "claude-code"
					? new Response("2.1.0")
					: Response.json({
							tag_name: "rust-v2.1.0",
							assets: [
								{
									name: `codex-package-${installationTarget().codex}.tar.gz`,
									browser_download_url: "https://github.com/openai/codex/releases/download/rust-v2.1.0/package.tar.gz",
									digest: `sha256:${"0".repeat(64)}`,
								},
							],
						});
			}
			if (String(url).endsWith("/manifest.json"))
				return Response.json({ platforms: { [installationTarget().claude]: { checksum: "0".repeat(64) } } });
			throw new Error("Migration must reuse the verified binary without downloading it again");
		});
		const installer = create({ fetch, probe: async () => "2.1.0" });
		installer.start(runtime);
		expect(await finished(installer, runtime)).toMatchObject({ state: "ready" });
		expect(readFileSync(sharedAgentPaths(runtime, root).executable, "utf8")).toBe("verified-legacy");
		expect(readFileSync(join(legacy, filename), "utf8")).toBe("verified-legacy");
		if (runtime === "codex") {
			const executable = AgentInstaller.executable(root, runtime, root) ?? "";
			expect(readFileSync(join(executable, "..", "companion"), "utf8")).toBe("legacy-companion");
		}
	});

	it("does not replace the existing public command when PATH persistence fails", async () => {
		const paths = sharedAgentPaths("claude-code", root);
		mkdirSync(paths.bin, { recursive: true });
		writeFileSync(paths.executable, "old-native");
		const installer = create({
			fetch: claudeDownloads("2.2.0"),
			probe: async (path) => (path === paths.executable ? "2.1.0" : "2.2.0"),
			configurePath: async () => {
				throw new Error("profile not writable");
			},
		});
		installer.start("claude-code");
		expect(await finished(installer, "claude-code")).toMatchObject({ state: "error", error: "profile not writable" });
		expect(readFileSync(paths.executable, "utf8")).toBe("old-native");
	});

	it.skipIf(process.platform === "win32")(
		"runs the installed Claude from an external shell after Pier shuts down",
		async () => {
			const bytes = Buffer.from("#!/bin/sh\nprintf '2.1.0\\n'\n");
			const installer = create({ fetch: claudeDownloads("2.1.0", bytes) });
			installer.start("claude-code");
			expect(await finished(installer, "claude-code")).toMatchObject({ state: "ready" });
			await installer.shutdown();
			const output = execFileSync("/bin/sh", ["-c", '. "$HOME/.profile"; command -v claude; claude --version'], {
				env: { ...process.env, HOME: root, PATH: "/usr/bin:/bin" },
				encoding: "utf8",
			});
			expect(output.trim().split("\n")).toEqual([sharedAgentPaths("claude-code", root).executable, "2.1.0"]);
		},
	);

	it("rejects duplicate jobs and aborts downloads when the Host shuts down", async () => {
		const pending = vi.fn<typeof fetch>(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					const signal = options?.signal;
					if (signal?.aborted) reject(signal.reason);
					else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const installer = create({ fetch: pending });
		installer.start("claude-code");
		expect(() => installer.start("claude-code")).toThrow("正在安装");
		await installer.shutdown();
		expect(installer.status("claude-code").state).toBe("error");
		expect(() => installer.start("claude-code")).toThrow("正在退出");
	});

	it("reports network and malformed metadata failures without creating an executable", async () => {
		const unavailable = create({ fetch: async () => new Response("unavailable", { status: 503 }) });
		unavailable.start("claude-code");
		expect(await finished(unavailable, "claude-code")).toMatchObject({
			state: "error",
			error: expect.stringContaining("503"),
		});
		const malformed = create({ fetch: claudeDownloads("../bad-version") });
		malformed.start("claude-code");
		expect(await finished(malformed, "claude-code")).toMatchObject({
			state: "error",
			error: expect.stringContaining("无效版本"),
		});
		expect(AgentInstaller.executable(root, "claude-code", root)).toBeUndefined();
	});

	it("extracts the full Codex package, including companion executables", async () => {
		const packageDir = join(root, "fixture");
		mkdirSync(join(packageDir, "bin"), { recursive: true });
		const name = process.platform === "win32" ? "codex.exe" : "codex";
		writeFileSync(join(packageDir, "bin", name), "codex-native");
		writeFileSync(join(packageDir, "bin", "companion"), "sandbox-companion");
		const archive = join(root, "fixture.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", packageDir, "bin"]);
		const bytes = readFileSync(archive);
		const installer = create({
			probe: async () => "0.162.0",
			fetch: async (url) => {
				if (String(url).endsWith("/latest"))
					return Response.json({
						tag_name: "rust-v0.162.0",
						assets: [
							{
								name: `codex-package-${installationTarget().codex}.tar.gz`,
								browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.162.0/package.tar.gz",
								digest: `sha256:${sha256(bytes)}`,
							},
						],
					});
				return new Response(new Uint8Array(bytes));
			},
		});
		installer.start("codex");
		expect(await finished(installer, "codex")).toMatchObject({ state: "ready" });
		const path = AgentInstaller.executable(root, "codex", root) ?? "";
		expect(readFileSync(path, "utf8")).toBe("codex-native");
		expect(readFileSync(join(path, "..", "companion"), "utf8")).toBe("sandbox-companion");
	});

	it("maps native platforms and rejects unsupported architectures", () => {
		expect(installationTarget("darwin", "arm64")).toEqual({ claude: "darwin-arm64", codex: "aarch64-apple-darwin" });
		expect(installationTarget("win32", "x64")).toEqual({ claude: "win32-x64", codex: "x86_64-pc-windows-msvc" });
		expect(installationTarget("win32", "arm64").codex).toBe("aarch64-pc-windows-msvc");
		expect(() => installationTarget("linux", "ia32")).toThrow("暂不支持");
		expect(() => installationTarget("freebsd", "x64")).toThrow("暂不支持");
	});

	it("ignores invalid persisted selections that escape its installation directory", () => {
		mkdirSync(join(root, "claude-code"));
		writeFileSync(join(root, "outside"), "unrelated");
		writeFileSync(join(root, "claude-code", "current.json"), JSON.stringify({ executable: "../outside" }));
		expect(AgentInstaller.executable(root, "claude-code", root)).toBeUndefined();
	});
});

it("starts installation over the protocol, survives a disconnected client and refreshes runtime discovery", async () => {
	vi.stubEnv("PATH", process.env.PATH ?? "");
	const host = await startTestHost({
		agents: { claudeCode: {}, codex: false },
		agentInstaller: {
			fetch: claudeDownloads("2.1.0"),
			probe: async () => "2.1.0",
		},
	});
	try {
		const observer = await host.connect();
		const recorder = new Recorder();
		observer.onEvent(recorder.handler);
		const changed = recorder.waitForType("runtime.changed");
		const client = await host.connect();
		expect((await client.request("runtime.install", { runtime: "claude-code" })).installation.state).toBe("checking");
		client.close();
		await changed;
		const result = await observer.request("runtime.installStatus", { runtime: "claude-code" });
		expect(result).toMatchObject({ installation: { state: "ready" }, agent: { available: true } });
		expect(result.agent.executable).toContain(join(host.root, "home", ".local"));
		expect((await observer.request("runtime.list")).runtimes.find((r) => r.id === "claude-code")?.executable).toBe(
			result.agent.executable,
		);
		await expect(observer.request("runtime.install", { runtime: "pi" as AgentConfigRuntime })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	} finally {
		await host.close();
		vi.unstubAllEnvs();
	}
});
