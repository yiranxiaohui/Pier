import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UPDATE_ROUTES, updateDownloadUrl } from "@pier/client";
import { type AgentInstallSource, PierProtocolError } from "@pier/protocol";

/** OpenCode 1 is published to npm as `opencode-ai`; OpenCode 2 ships separately as `@opencode/cli`. */
const NPM_REGISTRY = "https://registry.npmjs.org";
const NPMMIRROR = "https://registry.npmmirror.com";
const RELEASES = "https://api.github.com/repos/anomalyco/opencode/releases";
const DOWNLOADS = "https://github.com/anomalyco/opencode/releases/download/";
const VERSION = /^1\.\d+\.\d+$/;
const CHECKSUM = /^[a-f0-9]{64}$/i;
/** A Windows executable replaced while it runs is renamed to this prefix and removed later. */
const OLD_PREFIX = ".pier-old-";

/**
 * Where OpenCode's own installer (`https://opencode.ai/install`) puts the CLI. Pier installs there
 * too, so `opencode upgrade` keeps working and terminals find the same program.
 */
export function opencodePaths(home = homedir(), platform = process.platform) {
	const root = join(home, ".opencode");
	const bin = join(root, "bin");
	return { root, bin, executable: join(bin, platform === "win32" ? "opencode.exe" : "opencode") };
}

export interface OpenCodeCpu {
	platform: NodeJS.Platform;
	arch: string;
	musl: boolean;
	/** x64 only: whether the CPU has AVX2; older CPUs need the `baseline` build. */
	avx2: boolean;
}

/** The release name of a platform: `<os>-<arch>[-baseline][-musl]`, chosen as OpenCode's installer does. */
export function opencodeTarget(cpu: OpenCodeCpu): string {
	const os = { linux: "linux", darwin: "darwin", win32: "windows" }[cpu.platform as string];
	if (!os || !["x64", "arm64"].includes(cpu.arch)) {
		throw new PierProtocolError("UNSUPPORTED", `暂不支持在 ${cpu.platform}/${cpu.arch} 上自动安装 OpenCode`);
	}
	const baseline = cpu.arch === "x64" && !cpu.avx2;
	const musl = os === "linux" && cpu.musl;
	return `${os}-${cpu.arch}${baseline ? "-baseline" : ""}${musl ? "-musl" : ""}`;
}

function output(command: string, args: string[]): Promise<string> {
	return new Promise((resolve) =>
		execFile(command, args, { timeout: 15_000, windowsHide: true }, (error, stdout) =>
			resolve(error ? "" : String(stdout).trim()),
		),
	);
}

/** Detects this computer's OpenCode build. Without a positive AVX2 check it picks the baseline build. */
export async function detectOpenCodeTarget(): Promise<string> {
	const platform = process.platform;
	let arch: string = process.arch;
	// An x64 process translated by Rosetta runs on Apple silicon, which has its own build.
	if (platform === "darwin" && arch === "x64" && (await output("sysctl", ["-n", "sysctl.proc_translated"])) === "1")
		arch = "arm64";
	let avx2 = true;
	if (arch === "x64") {
		if (platform === "linux") avx2 = /\bavx2\b/i.test(await readFile("/proc/cpuinfo", "utf8").catch(() => ""));
		else if (platform === "darwin") avx2 = (await output("sysctl", ["-n", "hw.optional.avx2_0"])) === "1";
		else if (platform === "win32")
			avx2 = /^(true|1)$/i.test(
				await output("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					// PF_AVX2_INSTRUCTIONS_AVAILABLE
					`(Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int f);' -Name Kernel32 -Namespace PierCpu -PassThru)::IsProcessorFeaturePresent(40)`,
				]),
			);
	}
	const musl =
		platform === "linux" &&
		["/etc/alpine-release", "/lib/libc.musl-x86_64.so.1", "/lib/libc.musl-aarch64.so.1"].some((path) =>
			existsSync(path),
		);
	return opencodeTarget({ platform, arch, musl, avx2 });
}

export interface OpenCodeRelease {
	version: string;
	url: string;
	/** Hex digest of the whole download. */
	checksum: string;
	algorithm: "sha256" | "sha512";
	/** The executable's path inside the archive. */
	member: string;
	/** Gzipped tarball (Linux releases, npm packages); otherwise a zip archive. */
	gzip: boolean;
}

interface GitHubRelease {
	tag_name?: unknown;
	draft?: unknown;
	prerelease?: unknown;
	assets?: Array<{ name?: unknown; browser_download_url?: unknown; digest?: unknown }>;
}

/** This platform's verified asset of an OpenCode 1 release, if it has one. */
function releaseAsset(release: GitHubRelease | undefined, name: string) {
	const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
	if (!VERSION.test(tag.replace(/^v/, "")) || release?.draft || release?.prerelease) return undefined;
	const asset = release?.assets?.find((a) => a.name === name);
	const checksum = typeof asset?.digest === "string" ? asset.digest.replace(/^sha256:/, "") : "";
	const url = typeof asset?.browser_download_url === "string" ? asset.browser_download_url : "";
	// Only official release assets may be downloaded; no URLs or commands supplied by clients.
	if (!CHECKSUM.test(checksum) || !url.startsWith(DOWNLOADS)) return undefined;
	return { version: tag.replace(/^v/, ""), url, checksum };
}

/**
 * The latest OpenCode 1 release, as OpenCode's installer finds it: the version of the npm
 * package `opencode-ai`. Versions and checksums always come from npmjs.org and GitHub; only the
 * download follows `source`.
 */
export async function opencodeRelease(
	source: AgentInstallSource,
	target: string,
	get: (url: string) => Promise<Response>,
	signal: AbortSignal,
	platform = process.platform,
): Promise<OpenCodeRelease> {
	const latest = (await (await get(`${NPM_REGISTRY}/opencode-ai/latest`)).json()) as { version?: unknown };
	const version = typeof latest.version === "string" ? latest.version : "";
	if (/^\d+\.\d+\.\d+/.test(version) && !version.startsWith("1."))
		throw new Error(`npm 上 OpenCode 的最新版本是 ${version}，Pier 目前只能安装 OpenCode 1`);
	if (!VERSION.test(version)) throw new Error("OpenCode 官方服务返回了无效版本");
	const filename = platform === "win32" ? "opencode.exe" : "opencode";
	if (source === "npmmirror") {
		const name = `opencode-${target}`;
		const manifest = (await (await get(`${NPM_REGISTRY}/${name}/${version}`)).json()) as {
			dist?: { integrity?: unknown };
		};
		const integrity = typeof manifest.dist?.integrity === "string" ? manifest.dist.integrity : "";
		const sha512 = integrity
			.split(/\s+/)
			.map((entry) => /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(entry)?.[1])
			.find((digest) => digest !== undefined);
		if (!sha512) throw new Error("OpenCode 官方 npm 包缺少当前平台的 SHA-512 校验值");
		return {
			version,
			url: `${NPMMIRROR}/${name}/-/${name}-${version}.tgz`,
			checksum: Buffer.from(sha512, "base64").toString("hex"),
			algorithm: "sha512",
			member: `package/bin/${filename}`,
			gzip: true,
		};
	}
	const name = `opencode-${target}${platform === "linux" ? ".tar.gz" : ".zip"}`;
	const tagged = await get(`${RELEASES}/tags/v${version}`)
		.then((response) => response.json() as Promise<GitHubRelease>)
		.catch((error: unknown) => {
			if (signal.aborted) throw error;
			return undefined;
		});
	let asset = releaseAsset(tagged, name);
	if (!asset) {
		// npm is published before the GitHub release has its assets: use the newest OpenCode 1
		// release that has this platform's asset.
		const releases = (await (await get(`${RELEASES}?per_page=30`)).json()) as unknown;
		for (const release of Array.isArray(releases) ? (releases as GitHubRelease[]) : []) {
			asset = releaseAsset(release, name);
			if (asset) break;
		}
	}
	if (!asset) throw new Error("GitHub 上暂时没有当前平台的 OpenCode 发行包，请稍后重试或切换到 npmmirror 线路");
	const mirror = UPDATE_ROUTES.find((route) => route.id === source)?.prefix ?? "";
	return {
		version: asset.version,
		url: updateDownloadUrl(asset.url, mirror),
		checksum: asset.checksum,
		algorithm: "sha256",
		member: filename,
		gzip: platform === "linux",
	};
}

/** Removes executables left behind by earlier Windows updates once nothing runs them. */
export async function removeReplacedOpenCode(bin: string): Promise<void> {
	const names = await readdir(bin).catch(() => [] as string[]);
	await Promise.all(
		names
			.filter((name) => name.startsWith(OLD_PREFIX))
			.map((name) => rm(join(bin, name), { force: true }).catch(() => {})),
	);
}

/**
 * Replaces the OpenCode command with a verified executable. POSIX renames over the command in one
 * step (running processes keep the old file). Windows cannot replace a running executable but
 * can rename it, so the old one moves aside and is removed once it is no longer running.
 */
export async function publishOpenCode(executable: string, command: string, platform = process.platform): Promise<void> {
	if (platform !== "win32") {
		await rename(executable, command);
		return;
	}
	let previous: string | undefined;
	try {
		if ((await lstat(command)).isDirectory()) throw new Error(`命令路径是目录，无法替换：${command}`);
		previous = join(dirname(command), `${OLD_PREFIX}${randomUUID()}.exe`);
		await rename(command, previous);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			if (["EPERM", "EACCES", "EBUSY"].includes(code ?? ""))
				throw new Error("无法替换正在使用或无权限的 OpenCode 程序，已保留旧版。请关闭终端中的 opencode 后重试");
			throw error;
		}
		previous = undefined;
	}
	try {
		await rename(executable, command);
	} catch (error) {
		if (previous) await rename(previous, command).catch(() => {});
		throw error;
	}
	if (previous) await rm(previous, { force: true }).catch(() => {});
}
