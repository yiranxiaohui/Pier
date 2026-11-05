import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const installer = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function script(path: string, body: string) {
	writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
	chmodSync(path, 0o755);
}

/** A release `tag` whose single file reports `reports` as its version and records `install`. */
function release(root: string, tag: string, reports = tag.slice(1), arch = "x64") {
	const directory = join(root, "releases", tag);
	mkdirSync(directory, { recursive: true });
	const asset = `pier-${tag}-linux-${arch}`;
	script(
		join(directory, asset),
		`case "$1" in
  --version) echo "pier ${reports}" ;;
  install) printf '%s\\n' "$*" >> "$PIER_TEST_ROOT/pier.log"; echo "Installed Pier ${reports}." ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`,
	);
	const digest = createHash("sha256")
		.update(readFileSync(join(directory, asset)))
		.digest("hex");
	writeFileSync(
		join(directory, "SHA256SUMS.txt"),
		`${"a".repeat(64)}  pier-${tag}-linux-${arch}.AppImage\n${digest}  ${asset}\n${"b".repeat(64)}  pier-${tag}-android.apk\n`,
	);
	return { directory, asset, sums: join(directory, "SHA256SUMS.txt") };
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pier-one-line-test-"));
	roots.push(root);
	const mockBin = join(root, "mock-bin");
	const home = join(root, "home");
	const prefix = join(root, "prefix");
	for (const path of [mockBin, home]) mkdirSync(path, { recursive: true });
	const latest = release(root, "v0.2.58");
	mkdirSync(join(root, "releases/latest"));
	writeFileSync(join(root, "releases/latest/SHA256SUMS.txt"), readFileSync(latest.sums));
	release(root, "v0.2.57");
	writeFileSync(join(root, "linger"), "no\n");
	// GitHub, optionally through a mirror that receives the full GitHub URL as its path.
	script(
		join(mockBin, "curl"),
		`out=; url=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out=$2; shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$PIER_TEST_ROOT/curl.log"
path=$url
for mirror in https://ghfast.top/ https://gh-proxy.com/ https://mirror.example/sub/; do path=\${path#"$mirror"}; done
if [[ "$path" == "$url" && "\${PIER_TEST_GITHUB_DOWN:-0}" == 1 ]]; then echo "curl: (7) Failed to connect" >&2; exit 7; fi
case "$path" in
  https://github.com/yiranxiaohui/Pier/releases/latest/download/*) file=$PIER_TEST_ROOT/releases/latest/\${path##*/} ;;
  https://github.com/yiranxiaohui/Pier/releases/download/*) file=$PIER_TEST_ROOT/releases/\${path#https://github.com/yiranxiaohui/Pier/releases/download/} ;;
  *) echo "Unexpected download: $url" >&2; exit 1 ;;
esac
[[ -f "$file" ]] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "$file" "$out"`,
	);
	script(
		join(mockBin, "uname"),
		`case "\${1:-}" in
  -s) echo "\${PIER_TEST_OS:-Linux}" ;;
  -m) echo "\${PIER_TEST_MACHINE:-x86_64}" ;;
  *) command -p uname "$@" ;;
esac`,
	);
	script(
		join(mockBin, "systemctl"),
		`printf '%s\\n' "$*" >> "$PIER_TEST_ROOT/systemctl.log"
[[ "\${PIER_TEST_NO_MANAGER:-0}" != 1 ]]`,
	);
	script(
		join(mockBin, "loginctl"),
		`case "$1" in
  show-user) cat "$PIER_TEST_ROOT/linger" ;;
  enable-linger) [[ "\${PIER_TEST_LINGER:-deny}" == allow ]] && echo yes > "$PIER_TEST_ROOT/linger" ;;
esac`,
	);
	script(join(mockBin, "sudo"), `printf '%s\\n' "$*" >> "$PIER_TEST_ROOT/sudo.log"; exit 1`);
	const env: NodeJS.ProcessEnv = {
		PATH: `${mockBin}:${process.env.PATH}`,
		HOME: home,
		PIER_TEST_ROOT: root,
		PIER_PREFIX: prefix,
	};
	const run = (args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
		spawnSync("bash", [installer, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	const log = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "");
	const install = (version: string) => {
		mkdirSync(join(prefix, "share/pier"), { recursive: true });
		writeFileSync(
			join(prefix, "share/pier/installation.json"),
			`${JSON.stringify({ format: 1, app: "pier", scope: "user", version }, null, 2)}\n`,
		);
	};
	return { root, home, prefix, run, log, install, command: join(prefix, "bin/pier") };
}

const asset = (tag: string) => `https://github.com/yiranxiaohui/Pier/releases/download/${tag}/pier-${tag}-linux-x64`;

describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("one-line installer", () => {
	it("installs the latest verified single file as a user service and turns on lingering", () => {
		const f = fixture();
		const result = f.run([], { PIER_TEST_LINGER: "allow" });
		expect(result.status, result.stderr).toBe(0);
		expect(f.log("curl.log").split("\n")).toEqual([
			"https://github.com/yiranxiaohui/Pier/releases/latest/download/SHA256SUMS.txt",
			asset("v0.2.58"),
			"",
		]);
		expect(f.log("pier.log")).toBe("install --user\n");
		expect(result.stdout).toContain("Pier v0.2.58 is ready.");
		expect(result.stdout).toContain("/remote on and /pair");
		expect(result.stdout).toContain("Enabled lingering");
		expect(readdirSync(join(f.home, ".cache"))).toEqual([]);
	});

	it("installs a requested version, with or without the leading v, for arm64", () => {
		const f = fixture();
		release(f.root, "v0.2.57", "0.2.57", "arm64");
		const result = f.run(["--version", "0.2.57"], { PIER_TEST_MACHINE: "aarch64" });
		expect(result.status, result.stderr).toBe(0);
		expect(f.log("curl.log")).toContain("/releases/download/v0.2.57/SHA256SUMS.txt");
		expect(f.log("curl.log")).toContain("/releases/download/v0.2.57/pier-v0.2.57-linux-arm64");
		expect(f.log("pier.log")).toBe("install --user\n");
		expect(result.stdout).not.toContain("Enabled lingering");
	});

	it("installs nothing when the checksum or the reported version does not match", () => {
		const f = fixture();
		writeFileSync(join(f.root, "releases/v0.2.58", "pier-v0.2.58-linux-x64"), "tampered");
		let result = f.run();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Checksum mismatch");
		release(f.root, "v0.2.57", "0.2.56");
		result = f.run(["--version", "v0.2.57"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Version check failed: expected pier 0.2.57, got 'pier 0.2.56'");
		expect(f.log("pier.log")).toBe("");
		expect(readdirSync(join(f.home, ".cache"))).toEqual([]);
	});

	it("reports a release without a Linux single file before downloading anything large", () => {
		const f = fixture();
		const result = f.run(["--version", "v0.2.10"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Could not download the checksums of v0.2.10");
		writeFileSync(join(f.root, "releases/v0.2.57/SHA256SUMS.txt"), `${"c".repeat(64)}  pier-v0.2.57-darwin-x64.dmg\n`);
		const missing = f.run(["--version", "v0.2.57"]);
		expect(missing.stderr).toContain("has no single file for linux-x64");
		expect(f.log("curl.log")).not.toContain("pier-v0.2.57-linux-x64");
	});

	it("installs the service without starting it when no systemd manager answers", () => {
		const f = fixture();
		const result = f.run([], { PIER_TEST_NO_MANAGER: "1" });
		expect(result.status, result.stderr).toBe(0);
		expect(f.log("pier.log")).toBe("install --user --no-start\n");
		expect(result.stderr).toContain("pier run");
		expect(f.log("sudo.log")).toBe("");
	});

	it("skips an installed version unless forced, and updates an older one", () => {
		const f = fixture();
		f.install("0.2.58");
		const current = f.run();
		expect(current.status, current.stderr).toBe(0);
		expect(current.stdout).toContain("Pier v0.2.58 is already installed (user service)");
		expect(f.log("curl.log")).not.toContain(asset("v0.2.58"));
		expect(f.run(["--force"]).status).toBe(0);
		expect(f.log("pier.log")).toBe("install --user\n");
		f.install("0.2.57");
		// An installed service stays a service on a graphical desktop.
		const update = f.run([], { DISPLAY: ":0" });
		expect(update.status, update.stderr).toBe(0);
		expect(update.stdout).toContain("Updating Pier 0.2.57 to 0.2.58");
		expect(update.stdout).toContain("run pier stop");
		expect(f.log("pier.log")).toBe("install --user\ninstall --user\n");
	});

	it("installs only the pier command on a graphical desktop and updates it in place", () => {
		const f = fixture();
		const result = f.run([], { DISPLAY: ":0" });
		expect(result.status, result.stderr).toBe(0);
		expect(f.log("pier.log")).toBe("");
		expect(statSync(f.command).mode & 0o777).toBe(0o755);
		expect(spawnSync(f.command, ["--version"], { encoding: "utf8" }).stdout).toBe("pier 0.2.58\n");
		expect(result.stdout).toContain("rerun with --service");
		expect(result.stdout).toContain(`Add ${join(f.prefix, "bin")} to PATH`);
		// Without a desktop, the existing command is still what gets updated.
		expect(f.run().stdout).toContain("is already installed");
		const downgrade = f.run(["--version", "v0.2.57"]);
		expect(downgrade.status, downgrade.stderr).toBe(0);
		expect(spawnSync(f.command, ["--version"], { encoding: "utf8" }).stdout).toBe("pier 0.2.57\n");
		expect(readdirSync(join(f.prefix, "bin"))).toEqual(["pier"]);
		expect(f.run(["--service"]).stderr).toContain("was not installed by pier install");
	});

	it("installs the service on a desktop when asked, and keeps unrelated commands", () => {
		const f = fixture();
		mkdirSync(join(f.prefix, "bin"), { recursive: true });
		script(f.command, 'echo "another tool"');
		const portable = f.run(["--portable"]);
		expect(portable.stderr).toContain("it is not a Pier executable");
		expect(readFileSync(f.command, "utf8")).toContain("another tool");
		rmSync(f.command);
		const service = f.run(["--service"], { WAYLAND_DISPLAY: "wayland-0" });
		expect(service.status, service.stderr).toBe(0);
		expect(f.log("pier.log")).toBe("install --user\n");
	});

	it("refuses an install-host.sh installation and a Host that is already running", () => {
		const f = fixture();
		mkdirSync(join(f.prefix, "share/pier-host"), { recursive: true });
		writeFileSync(join(f.prefix, "share/pier-host/install.env"), "SCOPE=user\n");
		const legacy = f.run([], { DISPLAY: ":0" });
		expect(legacy.status).not.toBe(0);
		expect(legacy.stderr).toContain("pier-host uninstall");
		rmSync(join(f.prefix, "share/pier-host"), { recursive: true });
		const state = join(f.root, "state");
		mkdirSync(join(state, "run"), { recursive: true });
		writeFileSync(join(state, "run/host.json"), `${JSON.stringify({ pid: process.pid, port: 1 }, null, 2)}\n`);
		const running = f.run([], { PIER_DIR: state });
		expect(running.status).not.toBe(0);
		expect(running.stderr).toContain(`already running with ${state}`);
		expect(f.log("curl.log")).toBe("");
	});

	it("downloads through a mirror while taking checksums from GitHub when it answers", () => {
		const f = fixture();
		expect(f.run(["--mirror", "ghfast"]).status).toBe(0);
		expect(f.log("curl.log").split("\n")).toEqual([
			"https://github.com/yiranxiaohui/Pier/releases/latest/download/SHA256SUMS.txt",
			`https://ghfast.top/${asset("v0.2.58")}`,
			"",
		]);
		rmSync(join(f.root, "curl.log"));
		const down = f.run(["--force"], { PIER_MIRROR: "https://mirror.example/sub//", PIER_TEST_GITHUB_DOWN: "1" });
		expect(down.status, down.stderr).toBe(0);
		expect(down.stderr).toContain("checksums also came through https://mirror.example/sub/");
		expect(f.log("curl.log")).toContain(
			"https://mirror.example/sub/https://github.com/yiranxiaohui/Pier/releases/latest/download/SHA256SUMS.txt",
		);
		for (const mirror of ["http://mirror.example/", "https://user:secret@mirror.example/", "https://m.example/?x"])
			expect(f.run(["--mirror", mirror]).stderr).toContain("Invalid mirror");
		expect(f.run(["--mirror", "example"]).stderr).toContain("Unknown mirror");
	});

	it("rejects other systems, architectures and conflicting options", () => {
		const f = fixture();
		expect(f.run([], { PIER_TEST_OS: "Darwin" }).stderr).toContain("On macOS, install the .dmg");
		expect(f.run([], { PIER_TEST_MACHINE: "riscv64" }).stderr).toContain("Unsupported architecture: riscv64");
		expect(f.run(["--portable", "--no-start"]).stderr).toContain("cannot be combined");
		expect(f.run(["--service", "--portable"]).stderr).toContain("Choose either --service or --portable");
		expect(f.run(["--system"]).stderr).toContain("--system requires root");
		expect(f.run(["--version", "latest-ish"]).stderr).toContain("Invalid version");
		expect(f.run(["--bogus"]).stderr).toContain("Unknown option: --bogus");
		expect(f.run(["--help"]).stdout).toContain("--mirror NAME|URL");
		expect(f.log("curl.log")).toBe("");
	});
});
