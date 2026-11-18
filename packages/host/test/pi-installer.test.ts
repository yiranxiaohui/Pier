import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandRun, PI_INSTALLER_URLS, PiInstaller, type PiInstallerOptions } from "../src/pi/installer.ts";
import type { PiLocation } from "../src/pi/sdk.ts";

const found = (version: string, command?: string): PiLocation => ({
	state: "found",
	installation: { packageDir: "/opt/pi", version, ...(command ? { command } : {}) },
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
		const installer = create({
			locate: () => location,
			fetch,
			onInstalled,
			configurePath,
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
		expect(onInstalled).toHaveBeenCalledOnce();
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
