/** Shell scripts run on the computer being added over SSH, and parsing their output. */

/** What `DETECT_SCRIPT` found out about the other computer. */
export interface RemoteFacts {
	os: string;
	/** `x64` / `arm64`, or the raw `uname -m` when unsupported. */
	arch: string;
	supportedArch: boolean;
	uid: number;
	user: string;
	home: string;
	tools: Set<string>;
	/** A systemd manager for the account's scope (system for root, user otherwise) answers. */
	systemd: boolean;
	/** Installed `pier` service executable (`<installDir>/current/pier`) and its version. */
	installed?: { path: string; version?: string };
	/** `loginctl` Linger for the account (`yes` / `no`), when installed for a user. */
	linger?: string;
	/** Pier state directory (from the installation, `PIER_DIR` or `~/.pier`). */
	stateDir: string;
	/** A Pier Host that is running with that state directory. */
	running?: { version?: string; pid: number };
	/** Free space in kB under home. */
	freeKb?: number;
}

/** Run with `sh -s`; prints `key=value` lines. */
export const DETECT_SCRIPT = String.raw`
PATH="$HOME/.local/bin:/usr/local/bin:/usr/sbin:/sbin:$PATH"
uid=$(id -u 2>/dev/null)
echo "os=$(uname -s 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "uid=$uid"
echo "user=$(id -un 2>/dev/null)"
echo "home=$HOME"
for t in curl wget sha256sum systemctl loginctl sudo setsid nohup; do
  if command -v "$t" >/dev/null 2>&1; then echo "tool=$t"; fi
done
if [ "$uid" = 0 ]; then
  bin=/usr/local/bin/pier
  systemctl show-environment >/dev/null 2>&1 && echo "systemd=1"
else
  bin="$HOME/.local/bin/pier"
  systemctl --user show-environment >/dev/null 2>&1 && echo "systemd=1"
fi
state="$HOME/.pier"
if [ -n "$PIER_DIR" ]; then state=$PIER_DIR; fi
if [ -x "$bin" ]; then
  real=$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")
  meta="$(dirname "$(dirname "$real")")/installation.json"
  if [ -f "$meta" ]; then
    echo "installed=$real"
    echo "installedVersion=$("$real" --version 2>/dev/null | head -n 1)"
    s=$(sed -n 's/.*"stateDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$meta" | head -n 1)
    if [ -n "$s" ]; then state=$s; fi
    if [ "$uid" != 0 ]; then echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"; fi
  fi
fi
echo "state=$state"
f="$state/run/host.json"
if [ -f "$f" ]; then
  pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -n 1)
  ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -n 1)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "runningPid=$pid"
    echo "runningVersion=$ver"
  fi
fi
echo "freeKb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
echo "end=1"
`;

/** `pier 0.2.57` / `pier-host 0.2.57` → `0.2.57`. */
function versionOf(text: string | undefined): string | undefined {
	const match = /(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/.exec(text?.trim() ?? "");
	return match?.[1];
}

export function parseFacts(stdout: string): RemoteFacts {
	const values = new Map<string, string>();
	const tools = new Set<string>();
	let complete = false;
	for (const line of stdout.split(/\r?\n/)) {
		const index = line.indexOf("=");
		if (index <= 0) continue;
		const key = line.slice(0, index);
		const value = line.slice(index + 1).trim();
		if (key === "tool") tools.add(value);
		else if (key === "end") complete = true;
		else values.set(key, value);
	}
	if (!complete) throw new Error("无法读取远程系统信息");
	const machine = values.get("arch") ?? "";
	const arch = /^(x86_64|amd64)$/.test(machine) ? "x64" : /^(aarch64|arm64)$/.test(machine) ? "arm64" : machine;
	const home = values.get("home") ?? "";
	const installedPath = values.get("installed");
	const pid = Number(values.get("runningPid"));
	const freeKb = Number(values.get("freeKb"));
	const installedVersion = versionOf(values.get("installedVersion"));
	const runningVersion = versionOf(values.get("runningVersion"));
	const linger = values.get("linger");
	return {
		os: values.get("os") ?? "",
		arch,
		supportedArch: arch === "x64" || arch === "arm64",
		uid: Number(values.get("uid") ?? "-1"),
		user: values.get("user") ?? "",
		home,
		tools,
		systemd: values.get("systemd") === "1",
		...(installedPath
			? { installed: { path: installedPath, ...(installedVersion ? { version: installedVersion } : {}) } }
			: {}),
		...(linger ? { linger } : {}),
		stateDir: values.get("state") || `${home}/.pier`,
		...(Number.isInteger(pid) && pid > 0
			? { running: { pid, ...(runningVersion ? { version: runningVersion } : {}) } }
			: {}),
		...(Number.isFinite(freeKb) && freeKb > 0 ? { freeKb } : {}),
	};
}

/** Compare `a.b.c[-pre]` versions; prereleases sort before their release. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core = "", pre] = v.split("-", 2);
		return { parts: core.split(".").map((n) => Number(n) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre < y.pre ? -1 : 1;
}

export type RemotePlan =
	/** Install the service (or upgrade the installed one) from a fresh executable. */
	| { kind: "install"; upgrade: boolean }
	/** Start the installed service, which is new enough. */
	| { kind: "start" }
	/** A Host is already running; only pair with it. */
	| { kind: "existing" };

/**
 * What to do on the other computer. An installed service older than this Pier is upgraded;
 * a Host running outside a service (the desktop app, an old `pier-host` install, a manual
 * `pier run`) is left alone and only paired with.
 */
export function planRemote(facts: RemoteFacts, localVersion: string): RemotePlan {
	const installed = facts.installed;
	const older = installed ? !installed.version || compareVersions(installed.version, localVersion) < 0 : false;
	if (facts.running) {
		if (installed && older && facts.systemd) return { kind: "install", upgrade: true };
		return { kind: "existing" };
	}
	if (installed && !older) return { kind: "start" };
	return { kind: "install", upgrade: Boolean(installed) };
}

/**
 * Whether the installed executable can run the pairing helper (`pier cli --ssh-pair`). The
 * helper only talks to the running Host, so a fresh executable can stand in for an old one.
 */
export function installedHelper(facts: RemoteFacts, localVersion: string): boolean {
	const version = facts.installed?.version;
	return version !== undefined && compareVersions(version, localVersion) >= 0;
}

const VERIFY_TAIL = `
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$dest.part" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$dest.part" | awk '{print $1}')
else
  actual=$sum
fi
if [ "$actual" != "$sum" ]; then rm -f "$dest.part"; echo "checksum mismatch" >&2; exit 4; fi
chmod 700 "$dest.part" && mv -f "$dest.part" "$dest" || exit 1
"$dest" --version
`;

const WAIT_READY = String.raw`
i=0
while [ "$i" -lt 60 ]; do
  f="$state/run/host.json"
  if [ -f "$f" ]; then
    pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -n 1)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "ready=$pid"; exit 0; fi
  fi
  i=$((i + 1))
  sleep 1
done
echo "Pier did not start within 60 seconds" >&2
exit 1
`;

/**
 * `sh -s -- <url> <sha256> <dest>`: download with curl or wget, verify and print its version.
 * The downloader's pid is kept in `<dest>.pid` so a cancelled download can be stopped.
 */
export const DOWNLOAD_SCRIPT = `
set -u
url=$1; sum=$2; dest=$3
umask 077
mkdir -p "$(dirname "$dest")" || exit 1
rm -f "$dest.part"
if command -v curl >/dev/null 2>&1; then
  curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --connect-timeout 20 --max-time 3600 -o "$dest.part" "$url" &
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 30 -O "$dest.part" "$url" &
else
  exit 3
fi
pid=$!
echo "$pid" > "$dest.pid"
wait "$pid"
status=$?
rm -f "$dest.pid"
if [ "$status" -ne 0 ]; then rm -f "$dest.part"; exit 2; fi
${VERIFY_TAIL}`;

/** `sh -s -- <dir>`: stop downloads that `DOWNLOAD_SCRIPT` started in that directory. */
export const STOP_DOWNLOADS_SCRIPT = `
for f in "$1"/*.pid; do
  [ -f "$f" ] || continue
  kill "$(cat "$f")" 2>/dev/null
  rm -f "$f" "\${f%.pid}.part"
done
`;

/** `sh -s -- <sha256> <dest>`: verify an uploaded `<dest>.part`, move it into place, print its version. */
export const VERIFY_SCRIPT = `
set -u
sum=$1; dest=$2
${VERIFY_TAIL}`;

/** `sh -s -- <pier> <state dir>`: start Pier without systemd, detached from the SSH session. */
export const START_DETACHED_SCRIPT = `
bin=$1; state=$2
cd "$HOME" || exit 1
if command -v setsid >/dev/null 2>&1; then
  setsid "$bin" run </dev/null >/dev/null 2>&1 &
else
  nohup "$bin" run </dev/null >/dev/null 2>&1 &
fi
${WAIT_READY}`;

/** `sh -s -- <state dir>`: wait until a Host wrote its readiness file. */
export const WAIT_READY_SCRIPT = `
state=$1
${WAIT_READY}`;

/** `sh -s -- <user>`: keep the user's services running after logout; prints `linger=yes` when on. */
export const LINGER_SCRIPT = `
user=$1
check() { [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" = yes ]; }
if check; then echo "linger=yes"; exit 0; fi
loginctl enable-linger "$user" >/dev/null 2>&1
if check; then echo "linger=yes"; exit 0; fi
if command -v sudo >/dev/null 2>&1; then sudo -n loginctl enable-linger "$user" >/dev/null 2>&1; fi
if check; then echo "linger=yes"; exit 0; fi
echo "linger=no"
`;

/** `sh -s -- <user>` with the password on stdin's first line: `sudo -S` for lingering. */
export const SUDO_LINGER_SCRIPT = String.raw`
user=$1
IFS= read -r password
printf '%s\n' "$password" | sudo -S -p '' loginctl enable-linger "$user" >/dev/null 2>&1
if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" = yes ]; then echo "linger=yes"; else echo "linger=no"; fi
`;
