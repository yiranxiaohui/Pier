import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInstallSource } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CommandRun,
	PI_INSTALLER_URLS,
	PI_LATEST_VERSION_URL,
	PiInstaller,
	type PiInstallerOptions,
} from "../src/pi/installer.ts";
import type { NodeToolchain } from "../src/pi/node-requirement.ts";
import type { PiLocation } from "../src/pi/sdk.ts";

const found = (version: string, command?: string): PiLocation => ({
	state: "found",
	installation: { packageDir: "/opt/pi", version, ...(command ? { command } : {}) },
});

/** Node.js and npm as pi's installer needs them (the test machine's own do not matter). */
const readyNode = async (): Promise<NodeToolchain> => ({
	node: { path: "/usr/bin/node", version: "22.19.0" },
	npm: "/usr/bin/npm",
});

async function finished(installer: PiInstaller) {
	await vi.waitFor(() => expect(["ready", "error"]).toContain(installer.status().state), { timeout: 5_000 });
	return installer.status();
}

describe("pi installation", () => {
	const installers: PiInstaller[] = [];
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-pi-installer-"));
	});
	afterEach(async () => {
		await Promise.all(installers.splice(0).map((i) => i.shutdown()));
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});
	const create = (options: PiInstallerOptions) => {
		const installer = new PiInstaller(options);
		installers.push(installer);
		return installer;
	};

	it("updates an installed pi with `pi update --self`, without the Host's secrets", async () => {
		vi.stubEnv("PIER_LOCAL_TOKEN", "secret-token");
		vi.stubEnv("PI_PACKAGE_DIR", "/old/assets");
		let location = found("1.5.2", "/home/u/.local/bin/pi");
		const runs: CommandRun[] = [];
		const onInstalled = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>();
		const configurePath = vi.fn(async () => {});
		const findNode = vi.fn(readyNode);
		const installer = create({
			locate: () => location,
			fetch,
			onInstalled,
			configurePath,
			findNode,
			run: async (run) => {
				runs.push(run);
				run.onLine("\u001b[2mUpdating pi with npm install -g https://user:pass@registry.example/x...\u001b[0m");
				location = found("1.6.0", "/home/u/.local/bin/pi");
				return 0;
			},
		});
		expect(installer.start("npmmirror")).toMatchObject({ runtime: "pi", state: "checking", source: "npmmirror" });
		expect(await finished(installer)).toEqual({ runtime: "pi", state: "ready", source: "npmmirror", version: "1.6.0" });
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ command: "/home/u/.local/bin/pi", args: ["update", "--self"] });
		expect(runs[0]?.env.PIER_LOCAL_TOKEN).toBeUndefined();
		expect(runs[0]?.env.PI_PACKAGE_DIR).toBeUndefined();
		expect(runs[0]?.env.npm_config_registry).toBe("https://registry.npmmirror.com/");
		expect(fetch).not.toHaveBeenCalled();
		expect(configurePath).not.toHaveBeenCalled();
		// pi's own update knows how it was installed; only the installer needs the Node.js check.
		expect(findNode).not.toHaveBeenCalled();
		expect(onInstalled).toHaveBeenCalledOnce();
	});

	it("updates pi in the background only when pi.dev offers a newer stable release", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let location: PiLocation = found("1.5.2", "/home/u/.local/bin/pi");
		let latest = "1.6.0";
		let source: AgentInstallSource | undefined = "npmmirror";
		const runs: CommandRun[] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ version: latest, packageName: "@earendil-works/pi-coding-agent" }),
		);
		const onInstalled = vi.fn();
		const installer = create({
			locate: () => location,
			fetch,
			onInstalled,
			autoUpdateSource: () => source,
			run: async (run) => {
				runs.push(run);
				location = found(latest, "/home/u/.local/bin/pi");
				return 0;
			},
		});
		installer.startAutoUpdates();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await finished(installer)).toEqual({ runtime: "pi", state: "ready", source: "npmmirror", version: "1.6.0" });
		expect(fetch).toHaveBeenCalledWith(PI_LATEST_VERSION_URL, expect.anything());
		expect(runs.map((r) => r.args)).toEqual([["update", "--self"]]);
		expect(runs[0]?.env.npm_config_registry).toBe("https://registry.npmmirror.com/");
		expect(onInstalled).toHaveBeenCalledOnce();
		// Up to date, a prerelease, then a pi that is no longer installed: nothing runs.
		const changes = [
			() => {},
			() => {
				latest = "1.7.0-beta.1";
			},
			() => {
				latest = "1.7.0";
				location = { state: "missing" };
			},
		];
		for (const change of changes) {
			change();
			await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
			await vi.waitFor(() => expect(installer.status().state).toBe("idle"));
		}
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(runs).toHaveLength(1);
		source = undefined;
		location = found("1.5.2", "/home/u/.local/bin/pi");
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(installer.status().state).toBe("idle");
	});

	it("cancels a background check when turned off, but lets a running pi update finish", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let location = found("1.5.2", "/usr/bin/pi");
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		let finish: (code: number) => void = () => {};
		// Like the real command, an aborted signal stops it (and could leave pi half updated).
		const run = vi.fn(
			({ signal }: CommandRun) =>
				new Promise<number | null>((resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					finish = (code) => {
						location = found("1.6.0", "/usr/bin/pi");
						resolve(code);
					};
				}),
		);
		const installer = create({ locate: () => location, fetch, run, autoUpdateSource: () => "official" });
		installer.startAutoUpdates();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(installer.status()).toMatchObject({ state: "checking", source: "official" });
		installer.disableAutoUpdate();
		await vi.waitFor(() => expect(installer.status().state).toBe("idle"));
		expect(run).not.toHaveBeenCalled();
		fetch.mockImplementation(async () => Response.json({ version: "1.6.0" }));
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
		installer.disableAutoUpdate();
		finish(0);
		expect(await finished(installer)).toMatchObject({ state: "ready", version: "1.6.0" });
	});

	it("runs pi's official installer when pi is missing, with no terminal to ask", async () => {
		let location: PiLocation = { state: "missing" };
		const runs: Array<CommandRun & { script: string }> = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("#!/bin/sh\necho installing\n"));
		const configurePath = vi.fn(async () => {});
		const installer = create({
			locate: () => location,
			fetch,
			platform: "linux",
			home: "/home/u",
			configurePath,
			findNode: readyNode,
			run: async (run) => {
				runs.push({ ...run, script: readFileSync(run.args[0] ?? "", "utf8") });
				location = found("1.6.0", "/home/u/.local/bin/pi");
				return 0;
			},
		});
		installer.start();
		expect(await finished(installer)).toMatchObject({ state: "ready", source: "official", version: "1.6.0" });
		expect(fetch).toHaveBeenCalledWith(PI_INSTALLER_URLS.posix, expect.anything());
		expect(runs[0]).toMatchObject({ command: "sh", script: "#!/bin/sh\necho installing\n" });
		expect(runs[0]?.env.npm_config_registry).toBeUndefined();
		// The installer links pi into ~/.local/bin, which new terminals then find (as for Claude Code).
		expect(runs[0]?.env.PATH?.split(":")).toContain("/home/u/.local/bin");
		expect(configurePath).toHaveBeenCalledWith("/home/u/.local/bin");
	});

	it("uses the PowerShell installer on Windows", async () => {
		let location: PiLocation = { state: "missing" };
		const runs: CommandRun[] = [];
		const installer = create({
			locate: () => location,
			platform: "win32",
			findNode: readyNode,
			fetch: async () => new Response("Write-Host 'pi'"),
			run: async (run) => {
				runs.push(run);
				location = found("1.6.0", "C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd");
				return 0;
			},
		});
		installer.start();
		expect(await finished(installer)).toMatchObject({ state: "ready" });
		expect(runs[0]?.command).toBe("powershell.exe");
		expect(runs[0]?.args).toEqual(expect.arrayContaining(["-NonInteractive", "-File"]));
		expect(String(runs[0]?.args.at(-1))).toMatch(/install\.ps1$/);
	});

	it("reports the installer's last lines when it fails, and a pi it still cannot find", async () => {
		const installer = create({
			locate: () => found("1.5.2", "/usr/bin/pi"),
			run: async ({ onLine }) => {
				for (let i = 1; i <= 10; i++) onLine(`line ${i}`);
				onLine("npm error code EACCES");
				return 243;
			},
		});
		installer.start();
		const failed = await finished(installer);
		expect(failed.state).toBe("error");
		expect(failed.error).toContain("退出码 243");
		expect(failed.error).toContain("npm error code EACCES");
		expect(failed.error).not.toContain("line 1\n");

		const lost = create({
			locate: () => ({ state: "missing" }),
			fetch: async () => new Response("#!/bin/sh\n"),
			platform: "linux",
			findNode: readyNode,
			run: async () => 0,
		});
		lost.start();
		expect((await finished(lost)).error).toContain("找不到 pi");
	});

	it("runs one job at a time on the routes pi supports", async () => {
		let release: (() => void) | undefined;
		const installer = create({
			locate: () => found("1.5.2", "/usr/bin/pi"),
			run: () =>
				new Promise((resolve) => {
					release = () => resolve(0);
				}),
		});
		expect(() => installer.start("ghfast")).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
		installer.start();
		expect(() => installer.start()).toThrow(expect.objectContaining({ code: "CONFLICT" }));
		await vi.waitFor(() => expect(release).toBeDefined());
		release?.();
		expect((await finished(installer)).state).toBe("ready");
	});

	it("explains how to install Node.js instead of running pi's installer without it", async () => {
		let location: PiLocation = { state: "missing" };
		let toolchain: NodeToolchain = {};
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("Write-Host 'pi'"));
		const run = vi.fn(async () => {
			location = found("1.6.0", "C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd");
			return 0;
		});
		const refreshPath = vi.fn(async () => []);
		const installer = create({
			locate: () => location,
			platform: "win32",
			fetch,
			run,
			refreshPath,
			findNode: async () => toolchain,
		});
		installer.start("npmmirror");
		const failed = await finished(installer);
		expect(failed).toMatchObject({
			runtime: "pi",
			state: "error",
			source: "npmmirror",
			nodeRequirement: { minimum: "22.19.0", problem: "missing", command: "winget install OpenJS.NodeJS.LTS" },
		});
		expect(failed.nodeRequirement?.node).toBeUndefined();
		expect(failed.error).toContain("找不到 Node.js");
		expect(failed.error).toContain("winget install OpenJS.NodeJS.LTS");
		// The Host reads PATH again before the next attempt: no restart after installing Node.js.
		expect(failed.error).toContain("无需重启");
		expect(fetch).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();

		// Node.js installed meanwhile: the next attempt runs the installer, without the old hint.
		toolchain = await readyNode();
		// The failed job lets go of the installer right after reporting its error.
		await vi.waitFor(() => expect(installer.start()).toMatchObject({ state: "checking" }));
		const ready = await finished(installer);
		expect(ready).toMatchObject({ state: "ready", version: "1.6.0" });
		expect(ready.nodeRequirement).toBeUndefined();
		expect(ready.error).toBeUndefined();
		expect(run).toHaveBeenCalledOnce();
		expect(refreshPath).toHaveBeenCalledTimes(2);
	});

	it("reports an older Node.js and a missing npm, with the command that fits the computer", async () => {
		const outdated = create({
			locate: () => ({ state: "missing" }),
			platform: "darwin",
			run: async () => 0,
			findNode: async () => ({
				node: { path: "/usr/local/bin/node", version: "20.11.1" },
				npm: "/usr/local/bin/npm",
				brew: "/opt/homebrew/bin/brew",
			}),
		});
		outdated.start();
		const old = await finished(outdated);
		expect(old.nodeRequirement).toEqual({
			minimum: "22.19.0",
			problem: "outdated",
			node: "/usr/local/bin/node",
			nodeVersion: "20.11.1",
			command: "brew install node",
		});
		expect(old.error).toContain("v20.11.1（/usr/local/bin/node）");
		expect(old.error).toContain("brew install node");
		// Without a way to read PATH again, the Host may need a restart.
		expect(old.error).toContain("可能需要重启 Pier Host");

		const broken = create({
			locate: () => ({ state: "missing" }),
			platform: "darwin",
			run: async () => 0,
			findNode: async () => ({ node: { path: "/usr/local/bin/node", error: "Killed: 9" }, npm: "/usr/local/bin/npm" }),
		});
		broken.start();
		const unusable = await finished(broken);
		expect(unusable.nodeRequirement).toEqual({ minimum: "22.19.0", problem: "outdated", node: "/usr/local/bin/node" });
		expect(unusable.error).toContain("无法运行 /usr/local/bin/node（Killed: 9）");
		expect(unusable.error).toContain("nodejs.org");

		const noNpm = create({
			locate: () => ({ state: "missing" }),
			platform: "linux",
			run: async () => 0,
			findNode: async () => ({ node: { path: "/usr/bin/node", version: "24.1.0" } }),
		});
		noNpm.start();
		const npm = await finished(noNpm);
		// No single command installs a recent Node.js on every Linux distribution.
		expect(npm.nodeRequirement).toEqual({
			minimum: "22.19.0",
			problem: "npm-missing",
			node: "/usr/bin/node",
			nodeVersion: "24.1.0",
		});
		expect(npm.error).toContain("找不到 npm");
	});

	it("reads the user's PATH again before each job", async () => {
		vi.stubEnv("PATH", "/usr/bin");
		const refreshPath = vi.fn(async () => {
			process.env.PATH = "/usr/bin:/opt/node/bin";
			return ["/opt/node/bin"];
		});
		const searched: string[] = [];
		const runs: CommandRun[] = [];
		const log = vi.fn();
		let location: PiLocation = { state: "missing" };
		const installer = create({
			locate: () => location,
			platform: "linux",
			home: "/home/u",
			refreshPath,
			log,
			findNode: async (env) => {
				searched.push(env.PATH ?? "");
				return readyNode();
			},
			fetch: async () => new Response("#!/bin/sh\n"),
			run: async (run) => {
				runs.push(run);
				location = found("1.6.0", "/home/u/.local/bin/pi");
				return 0;
			},
		});
		installer.start();
		expect(await finished(installer)).toMatchObject({ state: "ready" });
		expect(searched[0]?.split(":")).toContain("/opt/node/bin");
		expect(runs[0]?.env.PATH?.split(":")).toContain("/opt/node/bin");
		expect(log).toHaveBeenCalledWith("pi: added to PATH: /opt/node/bin");

		// A PATH that cannot be read does not stop the update.
		const update = create({
			locate: () => found("1.5.2", "/usr/bin/pi"),
			refreshPath: async () => {
				throw new Error("login shell failed");
			},
			run: async () => 0,
		});
		update.start();
		expect((await finished(update)).state).toBe("ready");

		// Stopping the Host does not wait for a slow shell.
		const slow = create({
			locate: () => found("1.5.2", "/usr/bin/pi"),
			refreshPath: () => new Promise(() => {}),
			run: async () => 0,
		});
		slow.start();
		await vi.waitFor(() => expect(slow.status().state).toBe("checking"));
		await slow.shutdown();
		expect(slow.status()).toMatchObject({ state: "error", error: "Pier Host 已停止安装" });
	});

	it.runIf(process.platform !== "win32")("runs a real command without a terminal and reads its output", async () => {
		const pi = join(root, "pi");
		writeFileSync(
			pi,
			[
				"#!/bin/sh",
				'if [ -t 0 ] || ( : <>/dev/tty ) 2>/dev/null; then echo "has a terminal"; exit 3; fi',
				'[ "$*" = "update --self" ] || { echo "bad args: $*"; exit 4; }',
				'[ "$npm_config_registry" = "https://registry.npmmirror.com/" ] || { echo "no mirror"; exit 5; }',
				'[ -n "$FAIL" ] && { echo "first"; echo "boom" >&2; exit 2; }',
				"exit 0",
				"",
			].join("\n"),
		);
		chmodSync(pi, 0o755);
		const installer = create({ locate: () => found("1.5.2", pi) });
		installer.start("npmmirror");
		expect(await finished(installer)).toMatchObject({ state: "ready" });

		vi.stubEnv("FAIL", "1");
		const failing = create({ locate: () => found("1.5.2", pi) });
		failing.start("npmmirror");
		const result = await finished(failing);
		expect(result.state).toBe("error");
		expect(result.error).toContain("退出码 2");
		expect(result.error).toContain("boom");
	});
});
