import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
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
const children: ChildProcess[] = [];
afterEach(() => {
	// A terminal session that did not finish must not keep its hanging download running.
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
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
	// GitHub, or a mirror that receives the full GitHub URL as its path. Logs "<kind> <url>"
	// (get, probe, resume). Downloads of the single file honour the per-route test switches.
	script(
		join(mockBin, "curl"),
		`out=; url=; kind=get; asset=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out=$2; shift ;;
    --range) kind=probe; shift ;;
    --continue-at) asset=true; shift ;;
    --write-out|--speed-limit|--speed-time|--connect-timeout|--max-time|--retry|--proto|--proto-redir) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
route=github; path=$url
for pair in ghfast=https://ghfast.top/ gh-proxy=https://gh-proxy.com/ ghproxy=https://ghproxy.net/ custom=https://mirror.example/sub/; do
  prefix=\${pair#*=}
  if [[ "$url" == "$prefix"* ]]; then route=\${pair%%=*}; path=\${url#"$prefix"}; fi
done
if "$asset" && [[ -s "$out" ]]; then kind=resume; fi
printf '%s %s\\n' "$kind" "$url" >> "$PIER_TEST_ROOT/curl.log"
case "$path" in
  https://github.com/yiranxiaohui/Pier/releases/latest/download/*) file=$PIER_TEST_ROOT/releases/latest/\${path##*/} ;;
  https://github.com/yiranxiaohui/Pier/releases/download/*) file=$PIER_TEST_ROOT/releases/\${path#https://github.com/yiranxiaohui/Pier/releases/download/} ;;
  *) echo "Unexpected download: $url" >&2; exit 1 ;;
esac
down=" \${PIER_TEST_GITHUB_DOWN:+github} "
if "$asset" || [[ "$kind" == probe ]]; then down+=" \${PIER_TEST_DOWN:-} "; fi
if [[ "$down" == *" $route "* ]]; then echo "curl: (7) Failed to connect" >&2; exit 7; fi
[[ -f "$file" ]] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
if [[ "$kind" == probe ]]; then
  speed=PIER_TEST_SPEED_\${route//-/_}
  # 4 MiB, the first byte at once, then the route's speed (bytes per second).
  awk -v s="\${!speed:-4000000}" 'BEGIN { printf "4194304 0 %.6f", 4194304 / s }'
  exit 0
fi
if "$asset" && [[ " \${PIER_TEST_HANG:-} " == *" $route "* ]]; then exec sleep 30; fi
if "$asset" && [[ " \${PIER_TEST_SLOW:-} " == *" $route "* ]]; then
  head -c $(( $(wc -c < "$file") / 2 )) "$file" > "$out"
  echo "curl: (28) Operation too slow" >&2
  exit 28
fi
if [[ "$kind" == resume ]]; then tail -c +$(( $(wc -c < "$out") + 1 )) "$file" >> "$out"; else cp "$file" "$out"; fi`,
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
		spawnSync(process.platform === "darwin" ? "/bin/bash" : "bash", [installer, ...args], {
			env: { ...env, ...extra },
			encoding: "utf8",
		});
	const log = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "");
	const install = (version: string) => {
		mkdirSync(join(prefix, "share/pier"), { recursive: true });
		writeFileSync(
			join(prefix, "share/pier/installation.json"),
			`${JSON.stringify({ format: 1, app: "pier", scope: "user", version }, null, 2)}\n`,
		);
	};
	return { root, env, home, prefix, mockBin, run, log, install, command: join(prefix, "bin/pier") };
}

function macFixture(arch = "arm64") {
	const f = fixture();
	const appDir = join(f.home, "My Applications");
	const app = join(appDir, "Pier.app");
	const name = `pier-v0.2.58-darwin-${arch}.dmg`;
	const dmg = join(f.root, "releases/v0.2.58", name);
	writeFileSync(dmg, "test DMG");
	const sums = `${createHash("sha256").update("test DMG").digest("hex")}  ${name}\n`;
	for (const tag of ["v0.2.58", "latest"]) writeFileSync(join(f.root, "releases", tag, "SHA256SUMS.txt"), sums);
	script(join(f.mockBin, "sysctl"), `echo "\${PIER_TEST_TRANSLATED:-0}"`);
	script(join(f.mockBin, "pgrep"), `[[ "\${PIER_TEST_RUNNING:-0}" == 1 ]]`);
	script(
		join(f.mockBin, "hdiutil"),
		`printf '%s\\n' "$*" >> "$PIER_TEST_ROOT/mount.log"
if [[ "$1" == attach ]]; then
  while [[ "$1" != -mountpoint ]]; do shift; done
  mkdir -p "$2/Pier.app/Contents"
  printf '%s\\n' "\${PIER_TEST_BUNDLE_VERSION:-0.2.58}" > "$2/Pier.app/Contents/Info.plist"
fi`,
	);
	script(
		join(f.mockBin, "plutil"),
		`if [[ "$2" == CFBundleIdentifier ]]; then echo "\${PIER_TEST_BUNDLE_ID:-dev.pier.desktop}"
else cat "\${!#}"; fi`,
	);
	script(join(f.mockBin, "codesign"), `[[ "\${PIER_TEST_BAD_SIGNATURE:-0}" != 1 ]]`);
	script(join(f.mockBin, "ditto"), `[[ "\${PIER_TEST_COPY_FAIL:-0}" != 1 ]] || exit 1; cp -R "$1" "$2"`);
	script(
		join(f.mockBin, "mv"),
		`if [[ "\${PIER_TEST_RENAME_FAIL:-0}" == 1 && "$1" == */.pier-install.*/Pier.app ]]; then exit 1; fi
exec /bin/mv "$@"`,
	);
	const run = (args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
		f.run(args, {
			PIER_PREFIX: "",
			PIER_APP_DIR: appDir,
			PIER_TEST_OS: "Darwin",
			PIER_TEST_MACHINE: arch === "arm64" ? "arm64" : "x86_64",
			...extra,
		});
	const install = (version: string) => {
		mkdirSync(join(app, "Contents"), { recursive: true });
		writeFileSync(join(app, "Contents/Info.plist"), version);
	};
	return { ...f, run, install, app, appDir, dmg, name };
}

describe.skipIf(process.platform === "win32")("macOS one-line installer", () => {
	it.skipIf(process.platform !== "darwin")(
		"installs a real ad-hoc signed DMG with native macOS tools",
		() => {
			const f = macFixture();
			for (const tool of ["hdiutil", "plutil", "codesign", "ditto", "mv"]) rmSync(join(f.mockBin, tool));
			const volume = join(f.root, "volume");
			const source = join(volume, "Pier.app");
			mkdirSync(join(source, "Contents/MacOS"), { recursive: true });
			copyFileSync("/bin/echo", join(source, "Contents/MacOS/pier"));
			writeFileSync(
				join(source, "Contents/Info.plist"),
				`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.pier.desktop</string>
<key>CFBundleShortVersionString</key><string>0.2.58</string>
<key>CFBundleExecutable</key><string>pier</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
			);
			for (const [command, args] of [
				["codesign", ["--force", "--deep", "--sign", "-", source]],
				["hdiutil", ["create", "-srcfolder", volume, "-format", "UDZO", "-ov", f.dmg]],
			] as const) {
				const result = spawnSync(command, args, { encoding: "utf8" });
				expect(result.status, result.stderr).toBe(0);
			}
			const digest = createHash("sha256").update(readFileSync(f.dmg)).digest("hex");
			writeFileSync(join(f.root, "releases/latest/SHA256SUMS.txt"), `${digest}  ${f.name}\n`);
			const result = f.run();
			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(join(f.app, "Contents/MacOS/pier"))).toBe(true);
			expect(spawnSync("codesign", ["--verify", "--deep", "--strict", f.app]).status).toBe(0);
			expect(readdirSync(f.appDir)).toEqual(["Pier.app"]);
		},
		60_000,
	);

	it.each(["x64", "arm64"])("installs the verified %s DMG without a service and cleans the mount", (arch) => {
		const f = macFixture(arch);
		const result = f.run();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(f.app, "Contents/Info.plist"), "utf8").trim()).toBe("0.2.58");
		expect(result.stdout).toContain(`open "${f.app}"`);
		expect(result.stdout).toContain("Open Anyway");
		expect(f.log("curl.log")).toContain(f.name);
		expect(f.log("pier.log")).toBe("");
		expect(f.log("systemctl.log")).toBe("");
		expect(f.log("mount.log")).toContain("detach");
		expect(readdirSync(f.appDir)).toEqual(["Pier.app"]);
		expect(readdirSync(join(f.home, "Library/Caches"))).toEqual([]);
	});

	it("selects native ARM64 under Rosetta and supports explicit versions and mirrors", () => {
		const f = macFixture();
		const result = f.run(["--version", "0.2.58", "--mirror", "ghfast"], {
			PIER_TEST_MACHINE: "x86_64",
			PIER_TEST_TRANSLATED: "1",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(f.log("curl.log")).toContain(
			`https://ghfast.top/https://github.com/yiranxiaohui/Pier/releases/download/v0.2.58/${f.name}`,
		);
	});

	it("skips an installed version, supports force and preserves user state", () => {
		const f = macFixture();
		f.install("0.2.58");
		mkdirSync(join(f.home, ".pier"));
		writeFileSync(join(f.home, ".pier/keep"), "state");
		expect(f.run().stdout).toContain("is already installed");
		expect(f.log("mount.log")).toBe("");
		expect(f.run(["--force"]).status).toBe(0);
		expect(f.log("mount.log")).toContain("attach");
		expect(readFileSync(join(f.home, ".pier/keep"), "utf8")).toBe("state");
	});

	it.each([
		{ PIER_TEST_BAD_SIGNATURE: "1" },
		{ PIER_TEST_COPY_FAIL: "1" },
		{ PIER_TEST_RENAME_FAIL: "1" },
		{ PIER_TEST_BUNDLE_VERSION: "0.2.57" },
	])("keeps the previous app on verification or replacement failure (%j)", (extra) => {
		const f = macFixture();
		f.install("0.2.57");
		const result = f.run([], extra);
		expect(result.status).not.toBe(0);
		expect(readFileSync(join(f.app, "Contents/Info.plist"), "utf8")).toBe("0.2.57");
		expect(readdirSync(f.appDir)).toEqual(["Pier.app"]);
		expect(f.log("mount.log")).toContain("detach");
	});

	it("does not mount a tampered download", () => {
		const f = macFixture();
		writeFileSync(f.dmg, "tampered");
		expect(f.run().stderr).toContain("Checksum mismatch");
		expect(f.log("mount.log")).toBe("");
		expect(existsSync(f.app)).toBe(false);
	});

	it("rejects running apps, unrelated bundles, Linux flags and relative destinations before downloading", () => {
		const f = macFixture();
		expect(f.run([], { PIER_TEST_RUNNING: "1" }).stderr).toContain("Quit Pier");
		f.install("0.2.57");
		expect(f.run([], { PIER_TEST_BUNDLE_ID: "another.app" }).stderr).toContain("unrelated Pier.app");
		for (const option of ["--service", "--portable", "--user", "--system", "--no-start"])
			expect(f.run([option]).stderr).toContain("not supported");
		expect(f.run(["--app-dir", "relative"]).stderr).toContain("absolute directory");
		expect(f.log("curl.log")).toBe("");
	});
});

const asset = (tag: string) => `https://github.com/yiranxiaohui/Pier/releases/download/${tag}/pier-${tag}-linux-x64`;
const latestSums = "https://github.com/yiranxiaohui/Pier/releases/latest/download/SHA256SUMS.txt";
/** GitHub slower than 1 MB/s, GH-Proxy fastest, then GHFast; GHProxy unreachable. */
const slowGitHub = {
	PIER_TEST_SPEED_github: "200000",
	PIER_TEST_SPEED_ghfast: "900000",
	PIER_TEST_SPEED_gh_proxy: "3000000",
	PIER_TEST_DOWN: "ghproxy",
};
const util = spawnSync("script", ["--version"], { encoding: "utf8" });
const hasScript = util.status === 0 && util.stdout.includes("util-linux");

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("one-line installer", () => {
	it("installs the latest verified single file as a user service and turns on lingering", () => {
		const f = fixture();
		const result = f.run([], { PIER_TEST_LINGER: "allow" });
		expect(result.status, result.stderr).toBe(0);
		// A fast GitHub is used without contacting any mirror.
		expect(f.log("curl.log").split("\n")).toEqual([
			`get ${latestSums}`,
			`probe ${asset("v0.2.58")}`,
			`get ${asset("v0.2.58")}`,
			"",
		]);
		expect(result.stdout).toContain("Route speed: GitHub 3.8 MB/s");
		expect(result.stdout).toContain("Downloading Pier v0.2.58 (linux-x64) from GitHub");
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

	it("stays on a chosen route and takes the checksums from GitHub when it answers", () => {
		const f = fixture();
		expect(f.run(["--mirror", "ghfast"]).status).toBe(0);
		expect(f.log("curl.log").split("\n")).toEqual([
			`get ${latestSums}`,
			`get https://ghfast.top/${asset("v0.2.58")}`,
			"",
		]);
		rmSync(join(f.root, "curl.log"));
		const down = f.run(["--force"], { PIER_MIRROR: "https://mirror.example/sub//", PIER_TEST_GITHUB_DOWN: "1" });
		expect(down.status, down.stderr).toBe(0);
		expect(down.stderr).toContain("GitHub did not answer, so the checksums came through https://mirror.example/sub/");
		expect(f.log("curl.log")).toContain(`get https://mirror.example/sub/${latestSums}`);
		expect(f.log("curl.log")).toContain(`get https://mirror.example/sub/${asset("v0.2.58")}`);
		rmSync(join(f.root, "curl.log"));
		// A chosen route that keeps failing is retried, never swapped for another one.
		const failing = f.run(["--mirror", "ghfast"], { PIER_TEST_DOWN: "ghfast" });
		expect(failing.status).not.toBe(0);
		expect(failing.stderr).toContain("GHFast failed (exit 7); retrying");
		expect(failing.stderr).toContain("through GHFast failed; nothing was changed");
		expect(
			f
				.log("curl.log")
				.split("\n")
				.filter((line) => line.endsWith("-linux-x64")),
		).toEqual(Array(3).fill(`get https://ghfast.top/${asset("v0.2.58")}`));
		for (const mirror of ["http://mirror.example/", "https://user:secret@mirror.example/", "https://m.example/?x"])
			expect(f.run(["--mirror", mirror]).stderr).toContain("Invalid mirror");
		expect(f.run(["--mirror", "example"]).stderr).toContain("Unknown mirror");
	});

	it("measures the routes when GitHub is slow and downloads through the fastest", () => {
		const f = fixture();
		const result = f.run(["--mirror", "auto"], slowGitHub);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Route speed: GitHub 196 KB/s, GHFast 879 KB/s, GH-Proxy 2.9 MB/s, GHProxy failed");
		expect(result.stdout).toContain("Downloading Pier v0.2.58 (linux-x64) through GH-Proxy");
		const downloads = f
			.log("curl.log")
			.split("\n")
			.filter((line) => line.startsWith("get") || line.startsWith("resume"));
		expect(downloads).toEqual([`get ${latestSums}`, `get https://gh-proxy.com/${asset("v0.2.58")}`]);
		expect(f.log("pier.log")).toBe("install --user\n");
	});

	it("switches to the next fastest route when one is too slow, keeping the part downloaded", () => {
		const f = fixture();
		const result = f.run([], { ...slowGitHub, PIER_TEST_SLOW: "gh-proxy" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain("GH-Proxy was too slow; continuing through GHFast, keeping");
		expect(f.log("curl.log")).toContain(`get https://gh-proxy.com/${asset("v0.2.58")}`);
		expect(f.log("curl.log")).toContain(`resume https://ghfast.top/${asset("v0.2.58")}`);
		expect(f.log("pier.log")).toBe("install --user\n");
	});

	it("gives up after trying every route twice, and falls back when GitHub does not answer", () => {
		const f = fixture();
		const result = f.run([], { PIER_TEST_DOWN: "github ghfast gh-proxy ghproxy" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("failed on every route; nothing was changed");
		expect(
			f
				.log("curl.log")
				.split("\n")
				.filter((line) => line.startsWith("get") && line.endsWith("-linux-x64")),
		).toHaveLength(8);
		expect(f.log("pier.log")).toBe("");
		rmSync(join(f.root, "curl.log"));
		// Checksums then come from the first mirror that answers, and GitHub is not measured.
		const blocked = f.run([], { ...slowGitHub, PIER_TEST_GITHUB_DOWN: "1" });
		expect(blocked.status, blocked.stderr).toBe(0);
		expect(blocked.stderr).toContain("the checksums came through GHFast");
		expect(blocked.stdout).toContain("GitHub failed, GHFast 879 KB/s, GH-Proxy 2.9 MB/s");
		expect(f.log("curl.log")).not.toContain(`probe ${asset("v0.2.58")}`);
	});

	it.skipIf(!hasScript)(
		"switches routes when s is pressed in the terminal",
		async () => {
			const f = fixture();
			const child = spawn("script", ["-qec", `bash ${installer} --portable`, "/dev/null"], {
				env: { ...f.env, SHELL: "/bin/bash", PIER_TEST_HANG: "github" },
			});
			children.push(child);
			let output = "";
			let presses = 0;
			const press = setInterval(() => {
				if (output.includes("Press s") && !output.includes("Switching to") && presses < 10) {
					presses++;
					child.stdin.write("s");
				}
			}, 300);
			child.stdout.on("data", (data) => {
				output += data;
			});
			const code = await new Promise((resolve) => child.on("close", resolve));
			clearInterval(press);
			expect(code, output).toBe(0);
			expect(output).toContain("Switching to GHFast...");
			expect(output).toContain("Installed Pier v0.2.58");
			expect(f.log("curl.log")).toContain(`get https://ghfast.top/${asset("v0.2.58")}`);
		},
		20_000,
	);

	it("rejects other systems, architectures and conflicting options", () => {
		const f = fixture();
		expect(f.run([], { PIER_TEST_OS: "FreeBSD" }).stderr).toContain("download Pier");
		expect(f.run([], { PIER_TEST_MACHINE: "riscv64" }).stderr).toContain("Unsupported architecture: riscv64");
		expect(f.run(["--portable", "--no-start"]).stderr).toContain("cannot be combined");
		expect(f.run(["--service", "--portable"]).stderr).toContain("Choose either --service or --portable");
		expect(f.run(["--system"]).stderr).toContain("--system requires root");
		expect(f.run(["--version", "latest-ish"]).stderr).toContain("Invalid version");
		expect(f.run(["--bogus"]).stderr).toContain("Unknown option: --bogus");
		expect(f.run(["--help"]).stdout).toContain("--mirror ROUTE");
		expect(f.log("curl.log")).toBe("");
	});
});
