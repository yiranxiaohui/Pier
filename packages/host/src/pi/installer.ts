import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	AGENT_INSTALL_SOURCES,
	type AgentInstallationStatus,
	type AgentInstallSource,
	type NodeRequirement,
	PierProtocolError,
} from "@pier/protocol";
import { mergePath } from "../login-shell-path.ts";
import { findNodeToolchain, type NodeToolchain, nodeRequirement, nodeRequirementMessage } from "./node-requirement.ts";
import type { PiLocation } from "./sdk.ts";

/** pi's official installers (https://pi.dev, see pi's README). */
export const PI_INSTALLER_URLS = {
	posix: "https://pi.dev/install.sh",
	windows: "https://pi.dev/install.ps1",
} as const;
const NPMMIRROR_REGISTRY = "https://registry.npmmirror.com/";
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const KEPT_LINES = 40;
/** Variables of the Host that the installer and `pi update` must not see. */
const HOST_ONLY_ENV = ["PI_PACKAGE_DIR", "PIER_LOCAL_TOKEN", "PIER_RELAY_TOKEN"];

export interface CommandRun {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	/** Each line the command prints (stdout and stderr). */
	onLine: (line: string) => void;
}

export interface PiInstallerOptions {
	/** The pi installation on disk now. */
	locate: () => PiLocation;
	fetch?: typeof fetch;
	/** Runs a command and resolves to its exit code (tests). */
	run?: (run: CommandRun) => Promise<number | null>;
	platform?: NodeJS.Platform;
	/** The user's home (tests). */
	home?: string;
	/**
	 * Puts the directory of a newly installed `pi` on the user's PATH for new terminals, as for
	 * Claude Code and Codex: pi's installer only offers that when it can ask in a terminal.
	 */
	configurePath?: (bin: string) => Promise<void>;
	/** Called after a successful installation or update. */
	onInstalled?: () => Promise<void> | void;
	/**
	 * Reads the user's PATH again before each job, so a Node.js (or pi) installed while the Host
	 * runs is found without a restart: the registry on Windows, the login shell on macOS / Linux.
	 * Resolves to the entries it added, or undefined when it could not read the PATH.
	 */
	refreshPath?: () => Promise<string[] | undefined>;
	/** Finds `node` and `npm` on the installer's PATH (tests). */
	findNode?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Promise<NodeToolchain>;
	log?: (message: string) => void;
}

/** pi's installer cannot run yet: Node.js or npm is missing. */
class NodeRequirementError extends Error {
	constructor(
		readonly requirement: NodeRequirement,
		message: string,
	) {
		super(message);
	}
}

/** `promise`, or the abort reason as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("已取消"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

interface Job {
	source: AgentInstallSource;
	abort: AbortController;
	done: Promise<void>;
}

/** A printable line without terminal control sequences or credentials in URLs. */
function cleanLine(line: string): string {
	return (
		stripVTControlCharacters(line)
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal control bytes from untrusted process output.
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
			.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s@]*@/gi, "$1[redacted]@")
			.trimEnd()
	);
}

/** Runs `command` without a terminal, so pi's installers take their non-interactive defaults. */
function runCommand({ command, args, env, signal, onLine }: CommandRun): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const windows = process.platform === "win32";
		const shell = windows && /\.(cmd|bat)$/i.test(command);
		// With a shell, Node joins the command line without quoting: quote the path (it may have spaces).
		const child = spawn(shell ? `"${command}"` : command, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			// A new session has no controlling terminal: the installers cannot open /dev/tty to ask.
			detached: !windows,
			shell,
		});
		const kill = () => {
			try {
				if (!windows && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill();
			} catch {
				// Already gone.
			}
		};
		signal.addEventListener("abort", kill, { once: true });
		for (const stream of [child.stdout, child.stderr]) {
			let rest = "";
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				const lines = (rest + chunk).split("\n");
				rest = lines.pop() ?? "";
				for (const line of lines) onLine(line);
			});
			stream.on("end", () => {
				if (rest) onLine(rest);
				rest = "";
			});
		}
		child.on("error", (error) => {
			signal.removeEventListener("abort", kill);
			reject(error);
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", kill);
			if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error("已取消"));
			else resolve(code);
		});
	});
}

/**
 * Installs or updates the user's pi the way pi documents it: `pi update --self` for an existing
 * installation (pi knows whether it came from its installer, npm, bun or pnpm), otherwise pi's
 * official installer from pi.dev, once Node.js and npm are on PATH (it cannot ask to install them
 * without a terminal). Each job first reads the user's PATH again, so what the user installed while
 * the Host runs counts. Clients only choose the npm registry route; they cannot pass URLs, paths or
 * commands. Jobs survive client disconnects, like the Claude Code / Codex installer.
 */
export class PiInstaller {
	private current: AgentInstallationStatus = { runtime: "pi", state: "idle" };
	private job: Job | undefined;
	private closed = false;

	constructor(private readonly options: PiInstallerOptions) {}

	status(): AgentInstallationStatus {
		return this.current;
	}

	start(source: AgentInstallSource = "official"): AgentInstallationStatus {
		if (this.closed) throw new PierProtocolError("CONFLICT", "Pier Host 正在退出");
		if (!AGENT_INSTALL_SOURCES.pi.includes(source)) {
			throw new PierProtocolError("BAD_REQUEST", "pi 不支持所选下载线路");
		}
		if (this.job) throw new PierProtocolError("CONFLICT", "pi 正在安装或更新，请等待完成");
		const job: Job = { source, abort: new AbortController(), done: Promise.resolve() };
		this.current = { runtime: "pi", state: "checking", source };
		this.job = job;
		// Start on a later tick: the caller gets the `checking` status that was just set.
		job.done = Promise.resolve()
			.then(() => this.install(job))
			.finally(() => {
				if (this.job === job) this.job = undefined;
			});
		return this.current;
	}

	private update(fields: Partial<AgentInstallationStatus>): void {
		const next: AgentInstallationStatus = { ...this.current, ...fields };
		if (fields.state && fields.state !== "installing") delete next.detail;
		this.current = next;
	}

	/** Pick up PATH entries added since the Host started (a Node.js installed meanwhile). */
	private async refreshPath(signal: AbortSignal): Promise<void> {
		const refresh = this.options.refreshPath;
		if (!refresh) return;
		try {
			const added = await untilAborted(refresh(), signal);
			if (added === undefined) this.options.log?.("pi: could not read the user's PATH again; using the Host's");
			else if (added.length) this.options.log?.(`pi: added to PATH: ${added.join(", ")}`);
		} catch (error) {
			if (signal.aborted) throw error;
			this.options.log?.(`pi: reading the user's PATH: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** pi's installer stops without a terminal when Node.js or npm is missing: check first. */
	private async requireNode(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
		const platform = this.options.platform ?? process.platform;
		const toolchain = await untilAborted((this.options.findNode ?? findNodeToolchain)(env, platform), signal);
		const requirement = nodeRequirement(toolchain, platform);
		if (!requirement) {
			this.options.log?.(`pi: Node.js ${toolchain.node?.version} at ${toolchain.node?.path}, npm at ${toolchain.npm}`);
			return;
		}
		throw new NodeRequirementError(
			requirement,
			nodeRequirementMessage(requirement, toolchain, platform, this.options.refreshPath !== undefined),
		);
	}

	private environment(source: AgentInstallSource, installing: boolean): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
		for (const key of HOST_ONLY_ENV) delete env[key];
		const windows = (this.options.platform ?? process.platform) === "win32";
		// pi's installer links `pi` into a user directory it finds on PATH: offer the one Pier
		// shares with Claude Code and Codex.
		if (installing && !windows) {
			env.PATH = mergePath(env.PATH, posix.join(this.options.home ?? homedir(), ".local", "bin"), ":");
		}
		if (source === "npmmirror") {
			env.npm_config_registry = NPMMIRROR_REGISTRY;
			// Bun reads the upper-case name (Windows variables are case-insensitive anyway).
			if ((this.options.platform ?? process.platform) !== "win32") env.NPM_CONFIG_REGISTRY = NPMMIRROR_REGISTRY;
		}
		return env;
	}

	/** Download pi's official installer script into a private temporary directory. */
	private async installerScript(directory: string, signal: AbortSignal): Promise<{ command: string; args: string[] }> {
		const windows = (this.options.platform ?? process.platform) === "win32";
		const url = windows ? PI_INSTALLER_URLS.windows : PI_INSTALLER_URLS.posix;
		const response = await (this.options.fetch ?? fetch)(url, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
			headers: { "User-Agent": "Pier-Agent-Installer" },
		}).catch((error: unknown) => {
			if (signal.aborted) throw error;
			const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
			throw new Error(`无法连接 pi.dev（${cause instanceof Error ? cause.message : String(cause)}），请检查网络后重试`);
		});
		if (!response.ok) throw new Error(`下载 pi 安装程序失败（HTTP ${response.status}），请稍后重试`);
		const text = await response.text();
		if (text.length > MAX_SCRIPT_BYTES || (!windows && !text.startsWith("#!"))) {
			throw new Error("pi.dev 返回的安装程序无效");
		}
		const file = join(directory, windows ? "install.ps1" : "install.sh");
		await writeFile(file, text, { mode: 0o700 });
		return windows
			? {
					command: "powershell.exe",
					args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
				}
			: { command: "sh", args: [file] };
	}

	private async install(job: Job): Promise<void> {
		const { signal } = job.abort;
		const timeout = setTimeout(() => job.abort.abort(new Error("安装超过 15 分钟，请检查网络后重试")), JOB_TIMEOUT_MS);
		timeout.unref?.();
		let staging: string | undefined;
		const lines: string[] = [];
		try {
			await this.refreshPath(signal);
			const before = this.options.locate();
			const existing =
				before.state === "found"
					? before.installation.command
					: before.state === "invalid"
						? before.command
						: undefined;
			const env = this.environment(job.source, !existing);
			let step: { command: string; args: string[] };
			if (existing) {
				step = { command: existing, args: ["update", "--self"] };
			} else {
				await this.requireNode(env, signal);
				staging = await mkdtemp(join(tmpdir(), "pier-pi-install-"));
				step = await this.installerScript(staging, signal);
			}
			signal.throwIfAborted();
			this.update({ state: "installing", detail: existing ? "正在运行 pi update" : "正在运行 pi 官方安装程序" });
			this.options.log?.(`pi: running ${existing ? `${existing} update --self` : "pi's official installer"}`);
			const code = await (this.options.run ?? runCommand)({
				...step,
				env,
				signal,
				onLine: (raw) => {
					const line = cleanLine(raw);
					if (!line.trim()) return;
					lines.push(line);
					if (lines.length > KEPT_LINES) lines.shift();
					this.update({ detail: line.trim().slice(0, 200) });
				},
			});
			if (code !== 0) {
				const tail = lines.slice(-6).join("\n");
				throw new Error(
					`${existing ? "pi update" : "pi 安装程序"}失败（退出码 ${code ?? "未知"}）${tail ? `：\n${tail}` : ""}`,
				);
			}
			const after = this.options.locate();
			if (after.state !== "found") {
				throw new Error(
					after.state === "invalid"
						? after.reason
						: "安装程序已完成，但 Pier 仍找不到 pi。请确认 pi 所在目录在 PATH 中，然后重启 Pier",
				);
			}
			this.options.log?.(`pi: ${after.installation.version} at ${after.installation.packageDir}`);
			if (!existing && after.installation.command && this.options.configurePath) {
				const path = (this.options.platform ?? process.platform) === "win32" ? win32 : posix;
				await this.options.configurePath(path.dirname(after.installation.command));
			}
			this.update({ state: "ready", version: after.installation.version });
			try {
				await this.options.onInstalled?.();
			} catch (error) {
				this.options.log?.(`pi: after installing: ${error instanceof Error ? error.message : String(error)}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof NodeRequirementError) {
				this.update({ state: "error", error: message, nodeRequirement: error.requirement });
				this.options.log?.(`pi install needs Node.js first: ${error.requirement.problem}`);
				return;
			}
			const missing = /\bENOENT\b/.test(message) ? "（找不到命令；pi 需要 Node.js 22.19 或更新版本及 npm）" : "";
			this.update({ state: "error", error: `${message}${missing}` });
			this.options.log?.(`pi install failed: ${message}`);
		} finally {
			clearTimeout(timeout);
			if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
		}
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		const job = this.job;
		if (!job) return;
		job.abort.abort(new Error("Pier Host 已停止安装"));
		await job.done.catch(() => {});
	}
}
