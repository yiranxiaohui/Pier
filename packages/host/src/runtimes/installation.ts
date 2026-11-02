import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UPDATE_ROUTES, updateDownloadUrl } from "@pier/client";
import {
	AGENT_INSTALL_SOURCES,
	type AgentConfigRuntime,
	type AgentInstallationStatus,
	type AgentInstallSource,
	PierProtocolError,
} from "@pier/protocol";
import { probeVersion } from "./executable.ts";
import { configureInstallationPath } from "./installation-path.ts";
import { publishAgentCommand, sharedAgentExecutable, sharedAgentPaths } from "./shared-installation.ts";

const CLAUDE_DOWNLOADS = "https://downloads.claude.ai/claude-code-releases";
/** Claude Code publishes the same native executables as per-platform npm packages. */
const CLAUDE_NPMMIRROR = "https://registry.npmmirror.com/@anthropic-ai";
const CODEX_RELEASE = "https://api.github.com/repos/openai/codex/releases/latest";
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const CHECKSUM = /^[a-f0-9]{64}$/i;
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

export function installationTarget(
	platform = process.platform,
	arch = process.arch,
): {
	claude: string;
	codex: string;
} {
	if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
		throw new PierProtocolError("UNSUPPORTED", `暂不支持在 ${platform}/${arch} 上自动安装 Agent`);
	}
	const musl =
		platform === "linux" && (existsSync("/lib/libc.musl-x86_64.so.1") || existsSync("/lib/libc.musl-aarch64.so.1"));
	return {
		claude: `${platform}-${arch}${musl ? "-musl" : ""}`,
		codex: `${arch === "arm64" ? "aarch64" : "x86_64"}-${
			platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"
		}`,
	};
}

export interface AgentInstallerOptions {
	/** Defaults to the OS user's home; tests use a separate temporary home. */
	homeDirectory?: string;
	configurePath?: typeof configureInstallationPath;
	fetch?: typeof fetch;
	probe?: typeof probeVersion;
	onInstalled?: (runtime: AgentConfigRuntime) => Promise<void> | void;
}

interface Release {
	version: string;
	url: string;
	checksum: string;
	/**
	 * `binary`: the executable itself. `package`: Codex's archive, checksummed as a whole. `npm`: a
	 * package tarball whose `package/<executable>` carries the official checksum.
	 */
	format: "binary" | "package" | "npm";
}

interface Job {
	runtime: AgentConfigRuntime;
	source: AgentInstallSource;
	abort: AbortController;
	done: Promise<void>;
}

function sourceName(source: AgentInstallSource): string {
	if (source === "official") return "官方";
	if (source === "npmmirror") return "npmmirror 镜像";
	return `${UPDATE_ROUTES.find((route) => route.id === source)?.label ?? source} 加速线路`;
}

function verifyChecksum(actual: string, expected: string): void {
	if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error("SHA-256 校验失败，下载文件未安装，请重试");
}

async function fileChecksum(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** Extracts the whole archive, or only `member` so other entries of a mirrored package never land on disk. */
function extract(
	name: string,
	archive: string,
	directory: string,
	signal: AbortSignal,
	member?: string,
): Promise<void> {
	return new Promise<void>((resolve, reject) =>
		execFile(
			"tar",
			["-xzf", archive, "-C", directory, ...(member ? [member] : [])],
			{ signal, timeout: 120_000, windowsHide: true },
			(error) => (error ? reject(new Error(`解压 ${name} 失败，请确认系统已安装 tar：${error.message}`)) : resolve()),
		),
	);
}

/** Verified native releases, with public user-level commands shared by Pier and external terminals. */
export class AgentInstaller {
	private readonly statuses = new Map<AgentConfigRuntime, AgentInstallationStatus>();
	private readonly jobs = new Map<AgentConfigRuntime, Job>();
	private closed = false;

	constructor(
		private readonly directory: string,
		private readonly options: AgentInstallerOptions = {},
	) {}

	/** Prefer the shared command; retain old Pier-only installations until the next install/update. */
	static executable(directory: string, runtime: AgentConfigRuntime, homeDirectory = homedir()): string | undefined {
		const shared = sharedAgentExecutable(runtime, homeDirectory);
		if (shared) return shared;
		try {
			// Reading is deliberately synchronous: executable discovery is synchronous too.
			const text = readFileSync(join(directory, runtime, "current.json"), "utf8");
			const relative: unknown = JSON.parse(text).executable;
			if (typeof relative !== "string") return undefined;
			const root = resolve(directory, runtime);
			const path = resolve(root, relative);
			return path.startsWith(`${root}${sep}`) && existsSync(path) ? path : undefined;
		} catch {
			return undefined;
		}
	}

	status(runtime: AgentConfigRuntime): AgentInstallationStatus {
		return this.statuses.get(runtime) ?? { runtime, state: "idle" };
	}

	/** Choosing another route while a job still fetches metadata or downloads restarts it on that route. */
	start(runtime: AgentConfigRuntime, source: AgentInstallSource = "official"): AgentInstallationStatus {
		if (this.closed) throw new PierProtocolError("CONFLICT", "Pier Host 正在退出");
		if (!AGENT_INSTALL_SOURCES[runtime].includes(source)) {
			throw new PierProtocolError("BAD_REQUEST", "这个 Agent 不支持所选下载线路");
		}
		const previous = this.jobs.get(runtime);
		if (previous && (previous.source === source || !["checking", "downloading"].includes(this.status(runtime).state))) {
			throw new PierProtocolError("CONFLICT", "这个 Agent 正在安装，请等待完成");
		}
		installationTarget();
		previous?.abort.abort(new Error("已切换下载线路"));
		const job: Job = { runtime, source, abort: new AbortController(), done: Promise.resolve() };
		this.statuses.set(runtime, { runtime, state: "checking", source });
		// Queue the job so it is registered before any asynchronous work can finish. A replaced job
		// removes its staging files first, so two jobs never write the same installation.
		job.done = (previous?.done ?? Promise.resolve())
			.then(() => this.install(job))
			.finally(() => {
				if (this.jobs.get(runtime) === job) this.jobs.delete(runtime);
			});
		this.jobs.set(runtime, job);
		return this.status(runtime);
	}

	/** A replaced job finishes in the background without overwriting the progress of its replacement. */
	private update(job: Job, fields: Partial<AgentInstallationStatus>): void {
		if (this.jobs.get(job.runtime) === job) this.statuses.set(job.runtime, { ...this.status(job.runtime), ...fields });
	}

	private async response(
		url: string,
		signal: AbortSignal,
		timeoutMs = 60_000,
		source: AgentInstallSource = "official",
	): Promise<Response> {
		const response = await (this.options.fetch ?? fetch)(url, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
			headers: { "User-Agent": "Pier-Agent-Installer", Accept: "application/json" },
		}).catch((error: unknown) => {
			// Cancellation keeps its own reason; network failures name the route to switch away from.
			if (signal.aborted) throw error;
			const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
			throw new Error(
				`${sourceName(source)}连接失败（${cause instanceof Error ? cause.message : String(cause)}），${
					source === "official" ? "请检查网络后重试" : "请稍后重试或切换下载线路"
				}`,
			);
		});
		if (!response.ok) {
			const hint =
				source === "official"
					? "请检查网络后重试"
					: source === "npmmirror" && response.status === 404
						? "镜像可能尚未同步此版本，请稍后重试或切换下载线路"
						: "请稍后重试或切换下载线路";
			throw new Error(`${sourceName(source)}下载失败（HTTP ${response.status}），${hint}`);
		}
		return response;
	}

	/** Versions and checksums always come from the official services; only downloads follow `source`. */
	private async release(
		runtime: AgentConfigRuntime,
		source: AgentInstallSource,
		signal: AbortSignal,
	): Promise<Release> {
		const target = installationTarget();
		if (runtime === "claude-code") {
			const version = (await (await this.response(`${CLAUDE_DOWNLOADS}/latest`, signal)).text()).trim();
			if (!VERSION.test(version)) throw new Error("Claude Code 官方服务返回了无效版本");
			const manifest = (await (await this.response(`${CLAUDE_DOWNLOADS}/${version}/manifest.json`, signal)).json()) as {
				platforms?: Record<string, { checksum?: string }>;
			};
			const checksum = manifest.platforms?.[target.claude]?.checksum;
			if (!checksum || !CHECKSUM.test(checksum)) throw new Error("Claude Code 官方清单缺少当前平台的 SHA-256 校验值");
			return source === "npmmirror"
				? {
						version,
						checksum,
						format: "npm",
						url: `${CLAUDE_NPMMIRROR}/claude-code-${target.claude}/-/claude-code-${target.claude}-${version}.tgz`,
					}
				: {
						version,
						checksum,
						format: "binary",
						url: `${CLAUDE_DOWNLOADS}/${version}/${target.claude}/claude${process.platform === "win32" ? ".exe" : ""}`,
					};
		}
		const release = (await (await this.response(CODEX_RELEASE, signal)).json()) as {
			tag_name?: string;
			assets?: Array<{ name: string; browser_download_url: string; digest?: string }>;
		};
		const version = release.tag_name?.replace(/^rust-v/, "") ?? "";
		if (!VERSION.test(version)) throw new Error("Codex 官方服务返回了无效版本");
		const asset = release.assets?.find((a) => a.name === `codex-package-${target.codex}.tar.gz`);
		const checksum = asset?.digest?.replace(/^sha256:/, "");
		if (!asset || !checksum || !CHECKSUM.test(checksum))
			throw new Error("Codex 官方发行包缺少当前平台的 SHA-256 校验值");
		// Only official release assets may be downloaded; no URLs or commands supplied by clients.
		if (!asset.browser_download_url.startsWith("https://github.com/openai/codex/releases/download/")) {
			throw new Error("Codex 官方发行包地址无效");
		}
		const mirror = UPDATE_ROUTES.find((route) => route.id === source)?.prefix ?? "";
		return { version, checksum, format: "package", url: updateDownloadUrl(asset.browser_download_url, mirror) };
	}

	/** Downloads `release` to `path` and returns its SHA-256. */
	private async download(job: Job, release: Release, path: string, signal: AbortSignal): Promise<string> {
		const response = await this.response(release.url, signal, 600_000, job.source);
		if (!response.body) throw new Error("下载内容为空");
		const total = Number(response.headers.get("content-length")) || undefined;
		if (total && total > MAX_DOWNLOAD_BYTES) throw new Error("下载文件过大");
		this.update(job, { state: "downloading", downloadedBytes: 0, ...(total ? { totalBytes: total } : {}) });
		const hash = createHash("sha256");
		let bytes = 0;
		const progress = new Transform({
			transform: (chunk: Buffer, _encoding, callback) => {
				bytes += chunk.length;
				if (bytes > MAX_DOWNLOAD_BYTES) return callback(new Error("下载文件过大"));
				hash.update(chunk);
				this.update(job, { downloadedBytes: bytes });
				callback(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
			progress,
			createWriteStream(path, { mode: 0o700 }),
			{ signal },
		);
		return hash.digest("hex");
	}

	private async install(job: Job): Promise<void> {
		const { runtime } = job;
		const { signal } = job.abort;
		let staging: string | undefined;
		const timeout = setTimeout(() => job.abort.abort(new Error("安装超过 10 分钟，请检查网络后重试")), 600_000);
		timeout.unref?.();
		try {
			signal.throwIfAborted();
			const home = this.options.homeDirectory ?? homedir();
			const paths = sharedAgentPaths(runtime, home);
			const release = await this.release(runtime, job.source, signal);
			this.update(job, { version: release.version });
			const current = AgentInstaller.executable(this.directory, runtime, home);
			const upToDate = current && (await (this.options.probe ?? probeVersion)(current)) === release.version;
			if (upToDate && sharedAgentExecutable(runtime, home)) {
				signal.throwIfAborted();
				await (this.options.configurePath ?? configureInstallationPath)(paths.bin, { home });
				await this.options.onInstalled?.(runtime);
				this.update(job, { state: "ready" });
				return;
			}
			const root = paths.versions;
			await mkdir(root, { recursive: true, mode: 0o700 });
			staging = await mkdtemp(join(root, ".install-"));
			const name = runtime === "codex" ? "Codex" : "Claude Code";
			const filename = `${runtime === "codex" ? "codex" : "claude"}${process.platform === "win32" ? ".exe" : ""}`;
			const executable = join(staging, ...(release.format === "package" ? ["bin", filename] : [filename]));
			if (upToDate && current) {
				// Migrate an already verified Pier-only installation even when its version is latest.
				if (release.format === "package") await cp(dirname(current), join(staging, "bin"), { recursive: true });
				else await cp(current, executable);
				this.update(job, { state: "installing" });
			} else {
				const downloaded = release.format === "binary" ? executable : join(staging, "download.tar.gz");
				const checksum = await this.download(job, release, downloaded, signal);
				this.update(job, { state: "verifying" });
				if (release.format === "npm") {
					// The official manifest checksums the executable inside the package, not the tarball.
					await extract(name, downloaded, staging, signal, `package/${filename}`);
					const extracted = join(staging, "package", filename);
					if (!(await lstat(extracted)).isFile()) throw new Error(`${sourceName(job.source)}返回的安装包无效`);
					verifyChecksum(await fileChecksum(extracted), release.checksum);
					await rename(extracted, executable);
					await rm(join(staging, "package"), { recursive: true, force: true });
				} else {
					verifyChecksum(checksum, release.checksum);
				}
				this.update(job, { state: "installing" });
				if (release.format === "package") await extract(name, downloaded, staging, signal);
				if (downloaded !== executable) await rm(downloaded);
			}
			await chmod(executable, 0o755);
			signal.throwIfAborted();
			const version = await (this.options.probe ?? probeVersion)(executable, 15_000);
			if (version !== release.version) throw new Error("安装后版本验证失败，已保留之前的 Agent，请重试");
			signal.throwIfAborted();
			const destination = join(root, `${release.version}-${randomUUID()}`);
			await rename(staging, destination);
			staging = destination;
			await (this.options.configurePath ?? configureInstallationPath)(paths.bin, { home });
			signal.throwIfAborted();
			// Retain this verified release if publication/rollback encounters a filesystem error.
			staging = undefined;
			await publishAgentCommand(
				runtime,
				join(destination, ...(release.format === "package" ? ["bin", filename] : [filename])),
				home,
			);
			await this.options.onInstalled?.(runtime);
			this.update(job, { state: "ready" });
		} catch (error) {
			this.update(job, { state: "error", error: error instanceof Error ? error.message : String(error) });
		} finally {
			clearTimeout(timeout);
			if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
		}
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		for (const job of this.jobs.values()) job.abort.abort(new Error("Pier Host 已停止安装"));
		await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
	}
}
