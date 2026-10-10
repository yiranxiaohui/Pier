import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareResources } from "../src/standalone/resources.ts";
import { findInstallation, installHost, uninstallHost, updateHost } from "../src/standalone/service.ts";

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
  show) echo "$PIER_TEST_PID" ;;
  enable|start)
    [ "$PIER_TEST_FAIL_START" != 1 ] || exit 1
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
		binary: join(prefix, "share/pier-host/current/pier-host"),
		service: join(configHome, "systemd/user/pier-host.service"),
		command: join(prefix, "bin/pier-host"),
	};
}

describe.skipIf(process.platform !== "linux")("native single-file installation", () => {
	it("installs without a shell or manager, quotes the unit, and preserves data on uninstall", async () => {
		const f = fixture();
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		expect(readFileSync(f.binary, "utf8")).toBe("original-binary");
		expect(readFileSync(f.service, "utf8")).toContain('prefix with space %%/share/pier-host/current/pier-host" run');
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
		expect(existsSync(join(f.prefix, "share/pier-host"))).toBe(false);
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
	it("updates a verified executable in the recorded location while retaining state", async () => {
		const f = fixture();
		const config = await installHost(f.source, ["--user", "--no-start"], "1.0.0");
		writeFileSync(join(f.state, "config.json"), "retained");
		const binary = '#!/bin/sh\necho "pier-host 1.0.1"\n';
		const checksum = createHash("sha256").update(binary).digest("hex");
		vi.stubGlobal("fetch", async (url: string) => {
			const response = new Response(
				url.endsWith("SHA256SUMS.txt") ? `${checksum}  pier-host-v1.0.1-linux-${process.arch}\n` : binary,
			);
			Object.defineProperty(response, "url", { value: url });
			return response;
		});
		vi.stubEnv("PIER_HOST_PREFIX", join(f.root, "wrong-prefix"));
		await updateHost(config, ["--version", "v1.0.1", "--no-start"]);
		expect(findInstallation(f.command)?.version).toBe("1.0.1");
		expect(readFileSync(f.binary, "utf8")).toBe(binary);
		expect(readFileSync(join(f.state, "config.json"), "utf8")).toBe("retained");
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
