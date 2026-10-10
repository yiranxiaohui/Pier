import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const installer = join(repo, "scripts/install-host.sh");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function script(path: string, body: string) {
	writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
	chmodSync(path, 0o755);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pier-install-test-"));
	roots.push(root);
	const mockBin = join(root, "mock-bin");
	const payload = join(root, "payload");
	const state = join(root, "pier-state");
	const config = join(root, "config");
	const prefix = join(root, "prefix with space %");
	for (const path of [mockBin, payload, state, config]) mkdirSync(path, { recursive: true });
	script(join(payload, "pier-host"), 'printf "old-host %s\\n" "$*"');
	script(join(payload, "pier-cli"), 'printf "cli-state=%s\\n" "$PIER_DIR"');
	writeFileSync(join(payload, "manage.sh"), readFileSync(join(repo, "scripts/host-manager.sh")));
	writeFileSync(join(payload, "package.json"), '{"version":"1.1.0"}');
	writeFileSync(join(payload, "photon_rs_bg.wasm"), "wasm fixture");
	writeFileSync(join(payload, "install-host.sh"), readFileSync(installer));
	writeFileSync(join(payload, "VERSION"), "v0.2.34\n");
	writeFileSync(join(payload, "PLATFORM"), "linux-x64\n");
	const asset = "pier-host-v0.2.34-linux-x64.tar.gz";
	const archive = join(root, asset);
	execFileSync("tar", ["-czf", archive, "-C", payload, "."]);
	const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
	writeFileSync(join(root, "SHA256SUMS.txt"), `${digest}  ${asset}\n`);
	writeFileSync(join(root, "release.json"), '{"tag_name": "v0.2.34"}');
	script(
		join(mockBin, "curl"),
		`url=; out=
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out=$2; shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  */releases/latest) cp "$PIER_TEST_ROOT/release.json" "$out" ;;
  */SHA256SUMS.txt) cp "$PIER_TEST_ROOT/SHA256SUMS.txt" "$out" ;;
  */pier-host-*.tar.gz) cp "$PIER_TEST_ROOT/${asset}" "$out" ;;
  *) echo "Unexpected download: $url" >&2; exit 1 ;;
esac`,
	);
	script(
		join(mockBin, "systemctl"),
		`printf '%s\\n' "$*" >> "$PIER_TEST_ROOT/systemctl.log"
[[ "$1" != --user ]] || shift
if [[ "$PIER_TEST_NO_MANAGER" == 1 ]]; then exit 1; fi
case "$1" in
  is-active) [[ -f "$PIER_TEST_ROOT/active" ]] ;;
  show) echo "$PIER_TEST_PID" ;;
  enable|start|restart)
    [[ "$1" != enable || "$PIER_TEST_FAIL_START" != 1 ]]
    touch "$PIER_TEST_ROOT/active"
    mkdir -p "$PIER_HOST_STATE_DIR/run"
    printf '{"pid":%s}\\n' "$PIER_TEST_PID" > "$PIER_HOST_STATE_DIR/run/host.json"
    ;;
  stop|disable)
    if [[ -f "$PIER_TEST_ROOT/active" ]]; then rm -f "$PIER_HOST_STATE_DIR/run/host.json"; fi
    rm -f "$PIER_TEST_ROOT/active"
    ;;
esac`,
	);
	const env = {
		...process.env,
		PATH: `${mockBin}:${process.env.PATH}`,
		PIER_TEST_ROOT: root,
		PIER_TEST_NO_MANAGER: "0",
		PIER_TEST_FAIL_START: "0",
		PIER_TEST_PID: String(process.pid),
		PIER_HOST_PREFIX: prefix,
		PIER_HOST_STATE_DIR: state,
		PIER_DIR: join(root, "wrong-state"),
		XDG_CONFIG_HOME: config,
	};
	const run = (args: string[] = ["--no-start"], extra: NodeJS.ProcessEnv = {}) =>
		spawnSync("bash", [installer, "--user", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	const manager = join(prefix, "bin/pier-host");
	const installed = join(prefix, "share/pier-host");
	const service = join(config, "systemd/user/pier-host.service");
	const manage = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
		spawnSync("bash", [manager, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	return { root, env, run, manage, installed, manager, service, state, prefix, payload };
}

describe.skipIf(process.platform !== "linux")("headless installer and uninstall", () => {
	it("starts the service and waits for its own Host readiness file", () => {
		const f = fixture();
		const result = f.run([]);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(f.root, "systemctl.log"), "utf8")).toContain("show -p MainPID --value");
		expect(f.manage(["uninstall"]).status).toBe(0);
	});
	it("installs a verified archive, quotes systemd paths, and gives both CLIs the configured state", () => {
		const f = fixture();
		const result = f.run();
		expect(result.status, result.stderr).toBe(0);
		const unit = readFileSync(f.service, "utf8");
		expect(unit).toContain('prefix with space %%/share/pier-host/manage.sh" run');
		expect(unit).toContain("StandardOutput=null");
		expect(unit).not.toContain("--watch-stdin");
		expect(f.manage(["cli"]).stdout).toContain(f.state);
		const cli = spawnSync(join(f.prefix, "bin/pier-cli"), [], { env: f.env, encoding: "utf8" });
		expect(cli.status, cli.stderr).toBe(0);
		expect(cli.stdout).toContain(f.state);
		expect(existsSync(join(f.installed, "current/.previous-control"))).toBe(false);
	});

	it("keeps the installation and service untouched when an update checksum fails", () => {
		const f = fixture();
		expect(f.run().status).toBe(0);
		const before = readFileSync(f.service, "utf8");
		writeFileSync(join(f.root, "pier-host-v0.2.34-linux-x64.tar.gz"), "corrupt archive");
		const result = f.run([]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("checksum mismatch");
		expect(readFileSync(f.service, "utf8")).toBe(before);
		expect(f.manage(["run"]).stdout).toContain("old-host");
		const calls = readFileSync(join(f.root, "systemctl.log"), "utf8");
		expect(calls).not.toContain("stop");
	});

	it("restores the previous program, manager, metadata and service when startup fails", () => {
		const f = fixture();
		expect(f.run().status).toBe(0);
		const before = readFileSync(f.service, "utf8");
		const metadata = readFileSync(join(f.installed, "install.env"), "utf8");
		writeFileSync(join(f.root, "active"), "");
		const result = f.run([], { PIER_TEST_FAIL_START: "1" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Previous binaries were restored");
		expect(readFileSync(f.service, "utf8")).toBe(before);
		expect(readFileSync(join(f.installed, "install.env"), "utf8")).toBe(metadata);
		expect(f.manage(["run"]).stdout).toContain("old-host");
		expect(existsSync(join(f.root, "active"))).toBe(true);
	});

	it("uninstalls service and binaries while preserving Pier and shared Agent data", () => {
		const f = fixture();
		expect(f.run().status).toBe(0);
		writeFileSync(join(f.state, "config.json"), "private data");
		writeFileSync(join(f.root, "shared-agent-auth"), "shared credentials");
		const result = f.manage(["uninstall"]);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(f.installed)).toBe(false);
		expect(existsSync(f.manager)).toBe(false);
		expect(existsSync(join(f.prefix, "bin/pier-cli"))).toBe(false);
		expect(existsSync(f.service)).toBe(false);
		expect(readFileSync(join(f.state, "config.json"), "utf8")).toBe("private data");
		expect(readFileSync(join(f.root, "shared-agent-auth"), "utf8")).toBe("shared credentials");
		expect(readFileSync(join(f.root, "systemctl.log"), "utf8")).toContain("disable --now");
	});

	it("purges only the configured Pier data when explicitly requested", () => {
		const f = fixture();
		expect(f.run().status).toBe(0);
		writeFileSync(join(f.root, "project-file"), "work");
		const result = f.manage(["uninstall", "--purge"]);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(f.state)).toBe(false);
		expect(readFileSync(join(f.root, "project-file"), "utf8")).toBe("work");
	});

	it("allows uninstall of a stopped --no-start install without a systemd manager", () => {
		const f = fixture();
		expect(f.run().status).toBe(0);
		const result = f.manage(["uninstall"], { PIER_TEST_NO_MANAGER: "1" });
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(f.installed)).toBe(false);
	});

	it("refuses unrelated commands and refuses deleting data belonging to a live Host", () => {
		const f = fixture();
		mkdirSync(join(f.prefix, "bin"), { recursive: true });
		writeFileSync(f.manager, "unrelated command");
		expect(f.run().stderr).toContain("Will not overwrite");
		expect(readFileSync(f.manager, "utf8")).toBe("unrelated command");
		rmSync(f.manager);
		expect(f.run().status).toBe(0);
		mkdirSync(join(f.state, "run"));
		writeFileSync(join(f.state, "run/host.json"), JSON.stringify({ pid: process.pid }));
		const result = f.manage(["uninstall", "--purge"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("still running");
		expect(existsSync(f.installed)).toBe(true);
		expect(existsSync(f.state)).toBe(true);
	});

	it("rejects missing Host archives without downloading source or changing an installation", () => {
		const f = fixture();
		expect(f.run().status).toBe(0);
		const before = readFileSync(f.service, "utf8");
		writeFileSync(join(f.root, "SHA256SUMS.txt"), "desktop-checksum  pier-desktop-v0.2.34-linux-x64.deb\n");
		const result = f.run();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("No standalone Host archive");
		expect(result.stderr).not.toContain("Unexpected download");
		expect(readFileSync(f.service, "utf8")).toBe(before);
	});

	it("installs an already downloaded bundle without network access", () => {
		const f = fixture();
		script(join(f.root, "mock-bin/curl"), "echo 'Network access forbidden' >&2; exit 1");
		const result = spawnSync("bash", [join(f.payload, "install-host.sh"), "--user", "--local", "--no-start"], {
			env: f.env,
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Installing downloaded Pier Host");
		expect(f.manage(["cli"]).stdout).toContain(f.state);
		expect(f.manage(["uninstall"]).status).toBe(0);
	});

	it("refuses a downloaded bundle for a different architecture", () => {
		const f = fixture();
		writeFileSync(join(f.payload, "PLATFORM"), "linux-arm64\n");
		const result = spawnSync("bash", [join(f.payload, "install-host.sh"), "--user", "--local", "--no-start"], {
			env: f.env,
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("architecture does not match");
		expect(existsSync(f.installed)).toBe(false);
	});
});
