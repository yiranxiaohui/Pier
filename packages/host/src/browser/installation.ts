/** Installs official browser runtimes once per Host, retaining existing user installations. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { type BrowserPreparationProgress, PierProtocolError } from "@pier/protocol";
import lockfile from "proper-lockfile";
import { findExecutable, probeVersion } from "../runtimes/executable.ts";
import { findChromium } from "./chromium.ts";
import { BrowserPreparationLog } from "./preparation-log.ts";

const SELKIES_VERSION = "2.1.0";
const SELKIES_SHA256 = {
	x64: "a0147192e9d20e98c7b899411d62194a4fb4e5f19447a4e08868d61cde09c43b",
	arm64: "5573a85c1a538168d6cf04f7cc21c27ac5c9e40dab496b737d911ecf4fda8629",
};
const CHROME_MANIFEST =
	"https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const MAX_DOWNLOAD = 600 * 1024 * 1024;
export interface BrowserRuntimePaths {
	selkies: string;
	chromium: string;
	xvfb: string;
	openbox: string;
}
interface RunOptions {
	cwd?: string;
	signal?: AbortSignal;
	system?: boolean;
	onOutput?: (text: string, stream?: "stdout" | "stderr") => void;
}
export interface BrowserRuntimeInstallerOptions {
	fetch?: typeof fetch;
	find?: typeof findExecutable;
	chromium?: () => string | undefined;
	probe?: typeof probeVersion;
	run?: (file: string, args: string[], options?: RunOptions) => Promise<string>;
	platform?: NodeJS.Platform;
	arch?: string;
	uid?: number;
}
type Progress = (progress: BrowserPreparationProgress) => void;
interface Job {
	abort: AbortController;
	done: Promise<BrowserRuntimePaths>;
	listeners: Set<Progress>;
	progress: BrowserPreparationProgress;
}

export class BrowserRuntimeInstaller {
	private job?: Job;
	constructor(
		private readonly root: string,
		private readonly options: BrowserRuntimeInstallerOptions = {},
	) {}

	/** One shared download; cancelling one browser must not interrupt another waiting workspace. */
	async ensure(onProgress: Progress = () => {}, signal?: AbortSignal): Promise<BrowserRuntimePaths> {
		signal?.throwIfAborted();
		if (this.job?.abort.signal.aborted) {
			onProgress({ stage: "checking", message: "正在等待上一项准备操作结束…" });
			await this.job.done.catch(() => {});
			signal?.throwIfAborted();
		}
		if (!this.job) {
			const job: Job = {
				abort: new AbortController(),
				done: undefined as unknown as Promise<BrowserRuntimePaths>,
				listeners: new Set(),
				progress: { stage: "checking", message: "正在检查远程浏览器环境…" },
			};
			this.job = job;
			job.done = Promise.resolve()
				.then(() =>
					this.install(
						(progress) => {
							job.progress = progress;
							for (const listener of job.listeners) listener(progress);
						},
						AbortSignal.any([job.abort.signal, AbortSignal.timeout(14 * 60_000)]),
					),
				)
				.finally(() => {
					if (this.job === job) this.job = undefined;
				});
		}
		const job = this.job;
		void job.done.catch(() => {});
		const listener: Progress = (progress) => onProgress(progress);
		job.listeners.add(listener);
		listener(job.progress);
		return new Promise<BrowserRuntimePaths>((resolve, reject) => {
			const finish = () => {
				signal?.removeEventListener("abort", abort);
				job.listeners.delete(listener);
				if (!job.listeners.size) job.abort.abort();
			};
			const abort = () => {
				finish();
				reject(new Error("已取消浏览器准备"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			job.done.then(
				(paths) => {
					finish();
					resolve(paths);
				},
				(error) => {
					finish();
					reject(error);
				},
			);
		});
	}
	async shutdown(): Promise<void> {
		this.job?.abort.abort();
		await this.job?.done.catch(() => {});
	}
	private find(name: string, override?: string, managed?: string) {
		return (this.options.find ?? findExecutable)(name, override, managed);
	}
	private async run(file: string, args: string[], options: RunOptions = {}): Promise<string> {
		if (this.options.run) return this.options.run(file, args, options);
		return new Promise((resolve, reject) => {
			const child = execFile(
				file,
				args,
				{
					cwd: options.cwd,
					signal: options.system ? undefined : options.signal,
					timeout: options.system ? 600_000 : 120_000,
					maxBuffer: 8 * 1024 * 1024,
					env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
				},
				(error, stdout) =>
					error
						? reject(
								new Error(
									options.system
										? "系统依赖安装失败，请检查软件源、磁盘空间和软件包管理器状态后重试"
										: "浏览器组件解压或验证失败，请重试",
								),
							)
						: resolve(stdout),
			);
			if (options.onOutput) {
				child.stdout?.setEncoding("utf8").on("data", (text: string) => options.onOutput?.(text, "stdout"));
				child.stderr?.setEncoding("utf8").on("data", (text: string) => options.onOutput?.(text, "stderr"));
			}
		});
	}
	private async response(url: string, signal: AbortSignal, timeout = 60_000): Promise<Response> {
		const response = await (this.options.fetch ?? fetch)(url, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
			headers: { "User-Agent": "Pier-Browser-Installer" },
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`浏览器组件下载失败（HTTP ${response.status}），请检查网络后重试`);
		}
		if (response.url && new URL(response.url).protocol !== "https:") {
			await response.body?.cancel();
			throw new Error("浏览器官方下载连接不安全");
		}
		return response;
	}
	private async download(
		url: string,
		path: string,
		component: "selkies" | "chromium",
		progress: Progress,
		signal: AbortSignal,
		checksum?: string,
	): Promise<void> {
		const response = await this.response(url, signal, 600_000);
		const totalBytes = Number(response.headers.get("content-length")) || undefined;
		const md5 = /(?:^|,\s*)md5=([A-Za-z0-9+/=]+)/.exec(response.headers.get("x-goog-hash") ?? "")?.[1];
		if (!response.body || (totalBytes && totalBytes > MAX_DOWNLOAD) || (!checksum && !md5)) {
			await response.body?.cancel();
			throw new Error("浏览器下载缺少校验信息或文件大小异常");
		}
		const hash = createHash(checksum ? "sha256" : "md5");
		let downloadedBytes = 0;
		let last = 0;
		progress({
			stage: "downloading",
			component,
			downloadedBytes,
			totalBytes,
			message: component === "selkies" ? "正在下载远程画面组件…" : "正在下载浏览器…",
		});
		await pipeline(
			Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					downloadedBytes += chunk.length;
					if (downloadedBytes > MAX_DOWNLOAD) {
						callback(new Error("浏览器下载文件过大"));
						return;
					}
					hash.update(chunk);
					if (Date.now() - last >= 250) {
						last = Date.now();
						progress({
							stage: "downloading",
							component,
							downloadedBytes,
							totalBytes,
							message: component === "selkies" ? "正在下载远程画面组件…" : "正在下载浏览器…",
						});
					}
					callback(null, chunk);
				},
			}),
			createWriteStream(path, { mode: 0o700 }),
			{ signal },
		);
		progress({ stage: "verifying", component, message: "正在校验下载文件…" });
		if (
			(totalBytes && totalBytes !== downloadedBytes) ||
			hash.digest(checksum ? "hex" : "base64") !== (checksum ?? md5)
		)
			throw new Error("浏览器组件校验失败，未安装下载文件，请重试");
	}
	private discover(): Partial<BrowserRuntimePaths> {
		const selkies = this.find(
			"selkies",
			process.env.PIER_SELKIES_BIN,
			this.find("selkies", undefined, join(this.root, `selkies-${SELKIES_VERSION}`, "AppRun")) ??
				join(homedir(), `.local/share/pier/selkies-${SELKIES_VERSION}/AppRun`),
		);
		const xvfb = this.find("Xvfb", process.env.PIER_XVFB_BIN);
		const openbox = this.find("openbox", process.env.PIER_OPENBOX_BIN);
		let chromium: string | undefined;
		try {
			chromium = process.env.PIER_BROWSER_BIN
				? this.find("chrome", process.env.PIER_BROWSER_BIN)
				: this.options.chromium
					? this.options.chromium()
					: findChromium();
		} catch {
			/* Install a private copy. */
		}
		if (!chromium) {
			try {
				const relative: unknown = JSON.parse(readFileSync(join(this.root, "chrome.json"), "utf8")).executable;
				if (
					typeof relative === "string" &&
					/^chrome-\d+\.\d+\.\d+\.\d+\/chrome-linux(?:64|-arm64)\/chrome$/.test(relative)
				)
					chromium = this.find("chrome", undefined, join(this.root, relative));
			} catch {
				/* No completed private installation yet. */
			}
		}
		for (const [key, value] of [
			["PIER_SELKIES_BIN", selkies],
			["PIER_XVFB_BIN", xvfb],
			["PIER_OPENBOX_BIN", openbox],
			["PIER_BROWSER_BIN", chromium],
		])
			if (key && process.env[key] && !value) throw new Error(`${key} 指定的程序不可用，请修正路径后重试`);
		return { selkies, xvfb, chromium, openbox };
	}
	private async systemPackages(
		needs: { xvfb?: boolean; openbox?: boolean; unzip?: boolean; libraries?: boolean },
		log: BrowserPreparationLog,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const apt = this.find("apt-get");
		const dnf = this.find("dnf");
		const pacman = this.find("pacman");
		if (!apt && !dnf && !pacman)
			throw new Error(
				"这台主机的软件包管理器暂不支持自动补齐系统依赖，请安装 Xvfb、Openbox、unzip 和 Chromium 所需运行库后重试",
			);
		const root = (this.options.uid ?? process.getuid?.()) === 0;
		const sudo = root ? undefined : this.find("sudo");
		if (!root) {
			if (!sudo) throw new Error("自动安装缺少的系统依赖需要管理员权限，请为运行 Pier Host 的用户配置免密 sudo 后重试");
			try {
				await this.run(sudo, ["-n", "true"], { signal });
			} catch {
				throw new Error("自动安装缺少的系统依赖需要管理员权限，请为运行 Pier Host 的用户配置免密 sudo 后重试");
			}
		}
		const run = async (file: string, args: string[]) => {
			log.progress({
				stage: "installing",
				component: "system",
				message:
					args[0] === "update"
						? "正在更新软件源索引；取消后会完成当前软件包操作…"
						: "正在安装缺少的系统依赖；取消后会完成当前软件包操作…",
			});
			log.output(`$ ${file} ${args.join(" ")}\n`);
			try {
				return await this.run(
					sudo ?? file,
					sudo ? ["-n", "--", "env", "DEBIAN_FRONTEND=noninteractive", file, ...args] : args,
					{ system: true, onOutput: log.output },
				);
			} finally {
				log.flush();
			}
		};
		if (apt) {
			await run(apt, ["update"]);
			signal.throwIfAborted();
			const packages = [
				...(needs.xvfb ? ["xvfb"] : []),
				...(needs.openbox ? ["openbox"] : []),
				...(needs.unzip ? ["unzip"] : []),
			];
			if (needs.libraries) {
				packages.push(
					"libgbm1",
					"libegl1",
					"libnss3",
					"libnspr4",
					"libatk1.0-0",
					"libatk-bridge2.0-0",
					"libcups2",
					"libdrm2",
					"libxkbcommon0",
					"libxcomposite1",
					"libxdamage1",
					"libxfixes3",
					"libxrandr2",
					"libx11-6",
					"libxcb1",
					"libxext6",
					"libpango-1.0-0",
					"libcairo2",
					"libdbus-1-3",
					"fonts-liberation",
				);
				let asound = "libasound2";
				const cache = this.find("apt-cache");
				if (cache) {
					try {
						if ((await this.run(cache, ["show", "libasound2t64"], { signal })).includes("Package: libasound2t64"))
							asound = "libasound2t64";
					} catch {
						/* Older distributions. */
					}
				}
				packages.push(asound);
			}
			await run(apt, ["install", "-y", "--no-install-recommends", "--no-upgrade", ...packages]);
		} else if (dnf)
			await run(dnf, [
				"install",
				"-y",
				...(needs.xvfb ? ["xorg-x11-server-Xvfb"] : []),
				...(needs.openbox ? ["openbox"] : []),
				...(needs.unzip ? ["unzip"] : []),
				...(needs.libraries
					? [
							"mesa-libgbm",
							"mesa-libEGL",
							"nss",
							"nspr",
							"atk",
							"at-spi2-atk",
							"cups-libs",
							"libdrm",
							"libxkbcommon",
							"libXcomposite",
							"libXdamage",
							"libXfixes",
							"libXrandr",
							"alsa-lib",
							"cairo",
							"pango",
							"libX11",
							"libxcb",
							"libXext",
							"dbus-libs",
							"liberation-fonts",
						]
					: []),
			]);
		else if (pacman)
			await run(pacman, [
				"-S",
				"--needed",
				"--noconfirm",
				...(needs.xvfb ? ["xorg-server-xvfb"] : []),
				...(needs.openbox ? ["openbox"] : []),
				...(needs.unzip ? ["unzip"] : []),
				...(needs.libraries
					? [
							"mesa",
							"nss",
							"nspr",
							"at-spi2-core",
							"libcups",
							"libdrm",
							"libxkbcommon",
							"libxcomposite",
							"libxdamage",
							"libxfixes",
							"libxrandr",
							"alsa-lib",
							"cairo",
							"pango",
							"libx11",
							"libxcb",
							"libxext",
							"dbus",
							"ttf-liberation",
						]
					: []),
			]);
		signal.throwIfAborted();
	}
	private async install(onProgress: Progress, signal: AbortSignal): Promise<BrowserRuntimePaths> {
		const log = new BrowserPreparationLog(onProgress);
		try {
			return await this.installRuntime(log, signal);
		} finally {
			log.flush();
		}
	}
	private async installRuntime(log: BrowserPreparationLog, signal: AbortSignal): Promise<BrowserRuntimePaths> {
		const progress = log.progress;
		const platform = this.options.platform ?? process.platform;
		const arch = this.options.arch ?? process.arch;
		if (platform !== "linux" || (arch !== "x64" && arch !== "arm64"))
			throw new PierProtocolError("UNSUPPORTED", "远程浏览器自动安装目前支持 Linux x86_64 和 ARM64");
		const ready = this.discover();
		const probe = this.options.probe ?? probeVersion;
		if (ready.selkies && ready.chromium && ready.xvfb && ready.openbox) return ready as BrowserRuntimePaths;
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		let unlock: (() => Promise<void>) | undefined;
		let staging: string | undefined;
		try {
			for (;;) {
				signal.throwIfAborted();
				try {
					unlock = await lockfile.lock(this.root, { realpath: false, retries: 0, stale: 120_000, update: 10_000 });
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
					progress({ stage: "checking", message: "正在等待另一项浏览器安装完成…" });
					await delay(250, undefined, { signal });
				}
			}
			const paths = this.discover();
			if (!paths.xvfb || !paths.openbox || (!paths.chromium && !this.find("unzip")))
				await this.systemPackages(
					{
						xvfb: !paths.xvfb,
						openbox: !paths.openbox,
						unzip: !paths.chromium && !this.find("unzip"),
						libraries: !paths.chromium,
					},
					log,
					signal,
				);
			paths.xvfb = this.find("Xvfb", process.env.PIER_XVFB_BIN);
			if (!paths.xvfb) throw new Error("安装后仍未找到 Xvfb，请检查系统软件源");
			paths.openbox = this.find("openbox", process.env.PIER_OPENBOX_BIN);
			if (!paths.openbox) throw new Error("安装后仍未找到 Openbox，请检查系统软件源");
			staging = await mkdtemp(join(this.root, ".install-"));
			if (!paths.selkies) {
				const filename = `selkies-${SELKIES_VERSION}-${arch === "x64" ? "x86_64" : "aarch64"}.AppImage`;
				const archive = join(staging, filename);
				await this.download(
					`https://github.com/selkies-project/selkies/releases/download/${SELKIES_VERSION}/${filename}`,
					archive,
					"selkies",
					progress,
					signal,
					SELKIES_SHA256[arch],
				);
				progress({ stage: "installing", component: "selkies", message: "正在安装远程画面组件…" });
				await chmod(archive, 0o700);
				try {
					await this.run(archive, ["--appimage-extract"], { cwd: staging, signal, onOutput: log.output });
				} finally {
					log.flush();
				}
				const extracted = join(staging, "squashfs-root");
				if ((await probe(join(extracted, "AppRun"), 20_000)) !== SELKIES_VERSION)
					throw new Error("远程画面组件版本验证失败，请检查系统运行库");
				const destination = join(this.root, `selkies-${SELKIES_VERSION}`);
				if (existsSync(destination)) throw new Error("浏览器组件安装目录已存在但不可用，请检查安装目录后重试");
				signal.throwIfAborted();
				await rename(extracted, destination);
				paths.selkies = join(destination, "AppRun");
			}
			if (!paths.chromium) {
				const manifest = (await (await this.response(CHROME_MANIFEST, signal)).json()) as {
					channels?: { Stable?: { version?: string } };
				};
				const version = manifest.channels?.Stable?.version;
				if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error("浏览器官方下载清单无效");
				const target = arch === "x64" ? "linux64" : "linux-arm64";
				const archive = join(staging, "chrome.zip");
				await this.download(
					`https://storage.googleapis.com/chrome-for-testing-public/${version}/${target}/chrome-${target}.zip`,
					archive,
					"chromium",
					progress,
					signal,
				);
				progress({ stage: "installing", component: "chromium", message: "正在安装浏览器…" });
				const unzip = this.find("unzip");
				if (!unzip) throw new Error("未找到浏览器解压工具 unzip");
				const entries = (await this.run(unzip, ["-Z1", archive], { signal })).trim().split("\n");
				if (
					!entries.length ||
					entries.some(
						(name) =>
							!name.startsWith(`chrome-${target}/`) || name.split(/[\\/]/).includes("..") || name.includes("\\"),
					)
				)
					throw new Error("浏览器压缩包包含无效路径");
				const extracted = join(staging, "chrome");
				await mkdir(extracted);
				try {
					await this.run(unzip, ["-q", archive, "-d", extracted], { signal, onOutput: log.output });
				} finally {
					log.flush();
				}
				const executable = join(extracted, `chrome-${target}`, "chrome");
				await chmod(executable, 0o755);
				if (!(await probe(executable, 20_000))) await this.systemPackages({ libraries: true }, log, signal);
				if ((await probe(executable, 20_000)) !== version)
					throw new Error("浏览器安装后版本验证失败，请检查系统运行库");
				const destination = join(this.root, `chrome-${version}`);
				signal.throwIfAborted();
				if (existsSync(destination)) {
					if ((await probe(join(destination, `chrome-${target}`, "chrome"), 20_000)) !== version)
						throw new Error("浏览器安装目录已存在但不可用，请检查安装目录后重试");
				} else await rename(extracted, destination);
				paths.chromium = join(destination, `chrome-${target}`, "chrome");
				const pointer = join(staging, "chrome.json");
				await writeFile(pointer, JSON.stringify({ executable: `chrome-${version}/chrome-${target}/chrome` }), {
					mode: 0o600,
				});
				await rename(pointer, join(this.root, "chrome.json"));
			}
			progress({ stage: "starting", message: "准备完成，正在启动远程浏览器…" });
			return paths as BrowserRuntimePaths;
		} finally {
			if (staging) await rm(staging, { recursive: true, force: true });
			await unlock?.();
		}
	}
}
