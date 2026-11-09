import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareResources } from "../src/standalone/resources.ts";
import {
	findInstallation,
	type Installation,
	installHost,
	standaloneUpdateSupport,
	uninstallHost,
	updateHost,
} from "../src/standalone/service.ts";
import { applyServiceUpdate, launchUpdateWorker, readUpdateReceipt } from "../src/standalone/update-worker.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pier-native-test-"));
	roots.push(root);
	const tools = join(root, "tools");
	const prefix = join(root, "prefix with space %");
	const state = join(root, "state");
	const source = join(root, "downloaded-host");
	const configHome = join(root, "config");
	mkdirSync(tools);
	mkdirSync(state);
	writeFileSync(source, "original-binary");
	writeFileSync(
		join(tools, "systemctl"),
		`#!/bin/sh
[ "$1" != --user ] || shift
[ "$PIER_TEST_MANAGER" = 1 ] || exit 1
case "$1" in
  is-active) [ -f "$PIER_TEST_ROOT/active" ] ;;
  show) if [ -f "$PIER_TEST_ROOT/active" ]; then echo "$PIER_TEST_PID"; else echo 0; fi ;;
  enable|start)
    [ "$PIER_TEST_FAIL_START" != 1 ] || exit 1
    if [ "$PIER_TEST_FAIL_ONCE" = 1 ] && [ ! -f "$PIER_TEST_ROOT/failed-once" ]; then
      touch "$PIER_TEST_ROOT/failed-once"
      exit 1
    fi
    touch "$PIER_TEST_ROOT/active"
    mkdir -p "$PIER_HOST_STATE_DIR/run"
    printf '{"pid":%s,"version":"%s"}' "$PIER_TEST_PID" "$PIER_TEST_VERSION" > "$PIER_HOST_STATE_DIR/run/host.json"
    ;;
  stop|disable)
    rm -f "$PIER_TEST_ROOT/active" "$PIER_HOST_STATE_DIR/run/host.json"
    ;;
esac
`,
	);
	chmodSync(join(tools, "systemctl"), 0o755);
	for (const [key, value] of Object.entries({
		PATH: `${tools}:${process.env.PATH}`,
		PIER_HOST_PREFIX: prefix,
		PIER_HOST_STATE_DIR: state,
		XDG_CONFIG_HOME: configHome,
		PIER_TEST_ROOT: root,
		PIER_TEST_MANAGER: "0",
		PIER_TEST_FAIL_START: "0",
		PIER_TEST_FAIL_ONCE: "0",
		PIER_TEST_PID: String(process.pid),
		PIER_TEST_VERSION: "1.0.0",
	}))
		vi.stubEnv(key, value);
	vi.spyOn(console, "log").mockImplementation(() => {});
	return {
		root,
		prefix,
		state,
		source,
		configHome,
		binary: join(prefix, "share/pier/current/pier"),
		service: join(configHome, "systemd/user/pier.service"),
		command: join(prefix, "bin/pier"),
	};
}

function legacyFixture() {
	const f = fixture();
	const installDir = join(f.prefix, "share/pier-host");
	const binary = join(installDir, "current/pier-host");
	const command = join(f.prefix, "bin/pier-host");
	const serviceFile = join(f.configHome, "systemd/user/pier-host.service");
	const config: Installation = {
		format: 1,
		app: "pier-host",
		scope: "user",
		prefix: f.prefix,
		stateDir: f.state,
		configHome: f.configHome,
		installDir,
		binDir: join(f.prefix, "bin"),
		serviceFile,
		version: "1.0.0",
	};
	mkdirSync(join(installDir, "current"), { recursive: true });
	mkdirSync(config.binDir, { recursive: true });
	mkdirSync(join(f.configHome, "systemd/user"), { recursive: true });
	writeFileSync(binary, "old-host");
	writeFileSync(join(installDir, "installation.json"), JSON.stringify(config));
	writeFileSync(serviceFile, "old-service");
	symlinkSync(binary, command);
	return { ...f, config, legacyBinary: binary, legacyCommand: command };
}

describe.skipIf(process.platform !== "linux")("native single-file installation", () => {
	it("installs without a shell or manager, quotes the unit, and preserves data on uninstall", async () => {
		const f = fixture();
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		expect(readFileSync(f.binary, "utf8")).toBe("original-binary");
		expect(readFileSync(f.service, "utf8")).toContain('prefix with space %%/share/pier/current/pier" run');
		expect(readFileSync(f.service, "utf8")).toContain("StandardOutput=null");
		expect(readFileSync(f.service, "utf8")).not.toContain(".sh");
		expect(findInstallation(f.command)).toEqual(config);
		writeFileSync(join(f.state, "config.json"), "retained");
		uninstallHost(config);
		expect(existsSync(f.command)).toBe(false);
		expect(existsSync(f.service)).toBe(false);
		expect(existsSync(config.installDir)).toBe(false);
		expect(readFileSync(join(f.state, "config.json"), "utf8")).toBe("retained");
	});
	it("upgrades a legacy installation in place and adds pier while preserving its data and service identity", async () => {
		const f = legacyFixture();
		writeFileSync(join(f.state, "config.json"), "paired-devices");
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.1");
		expect(config).toEqual({ ...f.config, version: "1.0.1" });
		expect(findInstallation(f.command)).toEqual(config);
		expect(findInstallation(f.legacyCommand)).toEqual(config);
		expect(readFileSync(f.legacyBinary, "utf8")).toBe("original-binary");
		expect(readFileSync(config.serviceFile, "utf8")).toContain("current/pier-host");
		expect(existsSync(f.service)).toBe(false);
		uninstallHost(config);
		expect(existsSync(f.command)).toBe(false);
		expect(existsSync(f.legacyCommand)).toBe(false);
		expect(readFileSync(join(f.state, "config.json"), "utf8")).toBe("paired-devices");
	});
	it("restores the legacy service and command if migration cannot start", async () => {
		const f = legacyFixture();
		vi.stubEnv("PIER_TEST_MANAGER", "1");
		vi.stubEnv("PIER_TEST_FAIL_START", "1");
		await expect(installHost(f.source, ["--user"], "1.0.1")).rejects.toThrow("previous binary restored");
		expect(existsSync(f.command)).toBe(false);
		expect(readFileSync(f.legacyBinary, "utf8")).toBe("old-host");
		expect(readFileSync(f.config.serviceFile, "utf8")).toBe("old-service");
		expect(findInstallation(f.legacyCommand)).toEqual(f.config);
	});
	it("does not overwrite an unrelated pier command during legacy migration", async () => {
		const f = legacyFixture();
		writeFileSync(f.command, "other-tool");
		await expect(installHost(f.source, ["--user", "--no-start"], "1.0.1")).rejects.toThrow("Will not overwrite");
		expect(readFileSync(f.command, "utf8")).toBe("other-tool");
		expect(findInstallation(f.legacyCommand)).toEqual(f.config);
	});

	it("starts through systemd and verifies the Host readiness PID and version", async () => {
		const f = fixture();
		vi.stubEnv("PIER_TEST_MANAGER", "1");
		const config = await installHost(f.source, ["--user"], "1.0.0");
		expect(existsSync(join(f.root, "active"))).toBe(true);
		uninstallHost(config);
		expect(existsSync(join(f.root, "active"))).toBe(false);
	});
	it("restores the previous executable and unit after an update fails to start", async () => {
		const f = fixture();
		const old = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		const oldUnit = readFileSync(f.service, "utf8");
		writeFileSync(f.source, "new-binary");
		vi.stubEnv("PIER_TEST_MANAGER", "1");
		vi.stubEnv("PIER_TEST_FAIL_START", "1");
		await expect(installHost(f.source, ["--user"], "1.0.1")).rejects.toThrow("previous binary restored");
		expect(readFileSync(f.binary, "utf8")).toBe("original-binary");
		expect(readFileSync(f.service, "utf8")).toBe(oldUnit);
		expect(findInstallation(f.command)).toEqual(old);
	});
	it("removes a failed fresh installation and keeps its state", async () => {
		const f = fixture();
		vi.stubEnv("PIER_TEST_MANAGER", "1");
		vi.stubEnv("PIER_TEST_FAIL_START", "1");
		await expect(installHost(f.source, ["--user"], "1.0.0")).rejects.toThrow("partial installation removed");
		expect(existsSync(f.command)).toBe(false);
		expect(existsSync(f.service)).toBe(false);
		expect(existsSync(f.state)).toBe(true);
	});
	it("cleans an installation that fails before it has created a systemd unit", async () => {
		const f = fixture();
		vi.stubEnv("PIER_TEST_MANAGER", "1");
		rmSync(f.source);
		await expect(installHost(f.source, ["--user"], "1.0.0")).rejects.toThrow("partial installation removed");
		expect(existsSync(f.service)).toBe(false);
		expect(existsSync(join(f.prefix, "share/pier"))).toBe(false);
	});
	it("refuses to replace unrelated files or delete data belonging to a live Host", async () => {
		const f = fixture();
		mkdirSync(join(f.prefix, "bin"), { recursive: true });
		writeFileSync(f.command, "unrelated");
		await expect(installHost(f.source, ["--user", "--no-start"], "1.0.0")).rejects.toThrow("Will not overwrite");
		expect(readFileSync(f.command, "utf8")).toBe("unrelated");
		rmSync(f.command);
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		mkdirSync(join(f.state, "run"));
		writeFileSync(join(f.state, "run/host.json"), JSON.stringify({ pid: process.pid }));
		expect(() => uninstallHost(config, true)).toThrow("still running");
		expect(existsSync(f.binary)).toBe(true);
		expect(existsSync(f.state)).toBe(true);
	});
	it("purges the explicitly selected state while preserving other project and Agent files", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "project-and-agent-data"), "keep");
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		uninstallHost(config, true);
		expect(existsSync(f.state)).toBe(false);
		expect(readFileSync(join(f.root, "project-and-agent-data"), "utf8")).toBe("keep");
	});
	it("rejects a corrupt update before touching the installed executable or service", async () => {
		const f = fixture();
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		const unit = readFileSync(f.service, "utf8");
		vi.stubGlobal("fetch", async (url: string) => {
			const response = new Response(
				url.endsWith("SHA256SUMS.txt")
					? `${"f".repeat(64)}  pier-host-v1.0.1-linux-${process.arch}\n`
					: "corrupt download",
			);
			Object.defineProperty(response, "url", { value: url });
			return response;
		});
		await expect(updateHost(config, ["--version", "v1.0.1", "--no-start"])).rejects.toThrow("checksum mismatch");
		expect(readFileSync(f.binary, "utf8")).toBe("original-binary");
		expect(readFileSync(f.service, "utf8")).toBe(unit);
	});
	it.each([
		{ name: "pier", legacy: false },
		{ name: "pier-host", legacy: false },
		{ name: "pier", legacy: true },
	])("updates $name from legacy=$legacy in the recorded location while retaining state", async ({ name, legacy }) => {
		const old = legacy ? legacyFixture() : undefined;
		const f = old ?? fixture();
		const config = old?.config ?? (await installHost(f.source, ["--user", "--no-start"], "1.0.0"));
		writeFileSync(join(f.state, "config.json"), "retained");
		const binary = `#!/bin/sh\necho "${name} 1.0.1"\n`;
		const checksum = createHash("sha256").update(binary).digest("hex");
		vi.stubGlobal("fetch", async (url: string) => {
			const response = new Response(
				url.endsWith("SHA256SUMS.txt") ? `${checksum}  ${name}-v1.0.1-linux-${process.arch}\n` : binary,
			);
			Object.defineProperty(response, "url", { value: url });
			return response;
		});
		vi.stubEnv("PIER_HOST_PREFIX", join(f.root, "wrong-prefix"));
		await updateHost(config, ["--version", "v1.0.1", "--no-start"]);
		expect(findInstallation(f.command)?.version).toBe("1.0.1");
		expect(readFileSync(join(config.installDir, "current", config.app), "utf8")).toBe(binary);
		expect(readFileSync(join(f.state, "config.json"), "utf8")).toBe("retained");
	});
});

describe.skipIf(process.platform !== "linux")("standalone remote update worker", () => {
	it("only enables remote updates for the owning service and state directory", async () => {
		const f = fixture();
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		expect(standaloneUpdateSupport(undefined, f.state)).toContain("便携");
		expect(standaloneUpdateSupport(config, f.root)).toContain("状态目录");
		expect(standaloneUpdateSupport(config, f.state)).toContain("systemd");
		vi.stubEnv("PIER_TEST_MANAGER", "1");
		writeFileSync(join(f.root, "active"), "");
		vi.stubEnv("PIER_TEST_PID", String(process.pid + 1));
		expect(standaloneUpdateSupport(config, f.state)).toContain("systemd");
		vi.stubEnv("PIER_TEST_PID", String(process.pid));
		const runner = join(f.root, "tools/systemd-run");
		writeFileSync(runner, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		expect(standaloneUpdateSupport(config, f.state)).toBeUndefined();
	});
	it("launches the old executable in a separate unit of the same scope, without a shell", async () => {
		const f = fixture();
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		writeFileSync(
			join(f.root, "tools/systemd-run"),
			'#!/bin/sh\nprintf "%s\\n" "$@" > "$PIER_TEST_ROOT/runner-args"\n',
			{ mode: 0o755 },
		);
		const directory = join(config.installDir, "updates/update-test");
		mkdirSync(directory, { recursive: true });
		await launchUpdateWorker(config, directory, "v1.0.1", "a".repeat(64));
		const args = readFileSync(join(f.root, "runner-args"), "utf8").trim().split("\n");
		expect(args).toContain("--user");
		expect(args).toContain("--property=Type=exec");
		expect(args).not.toContain("--scope");
		expect(args).not.toContain("--wait");
		expect(args.slice(-4)).toEqual([
			"--",
			join(directory, "worker"),
			"--apply-service-update",
			join(directory, "job.json"),
		]);
		expect(readFileSync(join(directory, "worker"), "utf8")).toBe("original-binary");
		expect(readUpdateReceipt(config)).toMatchObject({ state: "installing", version: "1.0.1" });
	});
	it.each([false, true])("applies a verified staged release and rolls back on failure=%s", async (fail) => {
		const f = fixture();
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		writeFileSync(join(f.state, "config.json"), "paired-devices-kept");
		const directory = join(config.installDir, "updates/update-test");
		mkdirSync(directory, { recursive: true });
		const binary = "#!/bin/sh\necho 'pier 1.0.1'\n";
		writeFileSync(join(directory, "pier"), binary, { mode: 0o700 });
		const job = join(directory, "job.json");
		writeFileSync(
			job,
			JSON.stringify({
				executable: f.binary,
				tag: "v1.0.1",
				sha256: createHash("sha256").update(binary).digest("hex"),
			}),
		);
		vi.stubEnv("PIER_TEST_MANAGER", "1");
		vi.stubEnv("PIER_TEST_VERSION", "1.0.1");
		vi.stubEnv("PIER_TEST_FAIL_ONCE", fail ? "1" : "0");
		writeFileSync(join(f.root, "active"), "");
		if (fail) {
			await expect(applyServiceUpdate(job)).rejects.toThrow("previous binary restored");
			expect(readFileSync(f.binary, "utf8")).toBe("original-binary");
			expect(findInstallation(f.command)?.version).toBe("1.0.0");
			expect(readUpdateReceipt(config)).toMatchObject({ state: "error" });
		} else {
			await applyServiceUpdate(job);
			expect(findInstallation(f.command)?.version).toBe("1.0.1");
			expect(readUpdateReceipt(config)).toMatchObject({ state: "done" });
		}
		expect(existsSync(join(f.root, "active"))).toBe(true);
		expect(readFileSync(join(f.state, "config.json"), "utf8")).toBe("paired-devices-kept");
		expect(existsSync(directory)).toBe(false);
	});
});

describe("embedded resources", () => {
	it("unpacks binary resources once and reuses the complete immutable bundle", () => {
		const f = fixture();
		const archive = join(f.root, "resources.gz");
		writeFileSync(
			archive,
			gzipSync(
				JSON.stringify({
					"package.json": Buffer.from('{"version":"1.0.0"}').toString("base64"),
					"theme/dark.json": Buffer.from("theme").toString("base64"),
					"photon_rs_bg.wasm": Buffer.from([0, 1, 255]).toString("base64"),
				}),
			),
		);
		const directory = prepareResources(archive, f.state);
		expect(readFileSync(join(directory, "photon_rs_bg.wasm"))).toEqual(Buffer.from([0, 1, 255]));
		expect(readFileSync(join(directory, "theme/dark.json"), "utf8")).toBe("theme");
		expect(prepareResources(archive, f.state)).toBe(directory);
	});
	it("rejects an archive path that escapes the private resource directory", () => {
		const f = fixture();
		const archive = join(f.root, "resources.gz");
		writeFileSync(archive, gzipSync(JSON.stringify({ "../../outside": Buffer.from("bad").toString("base64") })));
		expect(() => prepareResources(archive, f.state)).toThrow("Invalid embedded resource path");
		expect(existsSync(join(f.state, "outside"))).toBe(false);
	});
});
