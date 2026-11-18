/**
 * The user's own pi installation.
 *
 * Pier no longer compiles a pinned pi SDK into its Host. Like Claude Code and Codex, pi is
 * installed and updated by the user (or through Pier, which runs pi's own installer and
 * `pi update`), and the Host loads the pi SDK from that installation at runtime: the same
 * `@earendil-works/pi-coding-agent` package the `pi` command runs, with its own dependencies.
 *
 * Nothing in Pier may import pi packages by value with a static specifier, or the bundler
 * would compile a copy into the sidecar again: value access goes through the `PiSdk` loaded
 * here. Type-only imports are fine (they come from the development dependency).
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PierProtocolError } from "@pier/protocol";
import { compareVersions } from "../peers/ssh/remote.ts";
import { findExecutable } from "../runtimes/executable.ts";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_AI_PACKAGE = "@earendil-works/pi-ai";

/**
 * The oldest pi whose SDK this Pier works with. Pier is built and tested against the pi in its
 * development dependencies; raise this when Pier starts to rely on a newer pi API.
 */
export const MIN_PI_VERSION = "1.5.2";

/** pi's configuration directory name (`piConfig.configDir` in pi's package.json). */
export const PI_CONFIG_DIR_NAME = ".pi";

/** Overrides where Pier finds pi: a `pi` command, or pi's package directory. */
export const PI_PATH_OVERRIDE = "PIER_PI_PATH";

export type PiAgentModule = typeof import("@earendil-works/pi-coding-agent");
export type PiAiModule = typeof import("@earendil-works/pi-ai");
type PiProvidersModule = typeof import("@earendil-works/pi-ai/providers/all");

/** The pi SDK of one installation, loaded into this process. */
export interface PiSdk {
	version: string;
	/** pi's package directory (real path). */
	packageDir: string;
	agent: PiAgentModule;
	/** The `@earendil-works/pi-ai` instance pi itself uses. */
	ai: PiAiModule;
	/** Providers of pi's built-in model catalog. */
	builtinProviders(): readonly string[];
}

/** A pi installation on disk. */
export interface PiInstallation {
	/** pi's package directory (real path). */
	packageDir: string;
	version: string;
	/** The `pi` command that runs this installation, when one was found. */
	command?: string;
}

export type PiLocation =
	| { state: "found"; installation: PiInstallation }
	/** A `pi` (or `PIER_PI_PATH`) Pier cannot use; `command` is set when there is one. */
	| { state: "invalid"; command?: string; reason: string }
	| { state: "missing" };

export interface LocatePiOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Finds the `pi` command (tests). Defaults to `PATH` and common installation directories. */
	findCommand?: () => string | undefined;
}

/** pi's agent directory, resolved the way pi does: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (configured) {
		if (configured === "~") return home;
		if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
			return join(home, configured.slice(2));
		}
		return configured;
	}
	return join(home, PI_CONFIG_DIR_NAME, "agent");
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** `dir` as a pi installation, when it is pi's package directory. */
export function piPackageAt(dir: string): PiInstallation | undefined {
	const manifest = readJson(join(dir, "package.json"));
	if (manifest?.name !== PI_PACKAGE || typeof manifest.version !== "string") return undefined;
	if (!existsSync(join(dir, "dist", "index.js"))) return undefined;
	return { packageDir: realpath(dir), version: manifest.version };
}

/** The pi package containing `path` (a file or directory inside it). */
function enclosingPiPackage(path: string): PiInstallation | undefined {
	for (let dir = path; ; dir = dirname(dir)) {
		const found = piPackageAt(dir);
		if (found) return found;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * pi's managed installation (`pi.dev/install.sh` / `install.ps1`): `<agent dir>/bin/pi` launches
 * `<agent dir>/install/releases/<current-version>/node_modules/@earendil-works/pi-coding-agent`.
 */
function managedPiPackage(agentDir: string): PiInstallation | undefined {
	const root = join(agentDir, "install");
	let version: string;
	try {
		version = readFileSync(join(root, "current-version"), "utf8").trim();
	} catch {
		return undefined;
	}
	if (!/^[0-9A-Za-z._+-]+$/.test(version) || version === "." || version === "..") return undefined;
	return piPackageAt(join(root, "releases", version, "node_modules", ...PI_PACKAGE.split("/")));
}

/** Launchers in pi's managed `bin` directory (POSIX script or Windows shims). */
function managedLauncher(agentDir: string): string | undefined {
	const names = process.platform === "win32" ? ["pi.cmd", "pi.ps1", "pi"] : ["pi"];
	return names.map((name) => join(agentDir, "bin", name)).find((path) => existsSync(path));
}

/** Absolute paths of pi's package that a small text launcher (npm, pnpm or Nix shim) mentions. */
function packagesNamedIn(launcher: string): PiInstallation | undefined {
	try {
		if (statSync(launcher).size > 64 * 1024) return undefined;
		const text = readFileSync(launcher, "utf8");
		const pattern = /([A-Za-z]:[\\/]|\/)[^\s"'`;:*?<>|]*?[\\/]@earendil-works[\\/]pi-coding-agent(?=[\\/"'\s]|$)/g;
		for (const match of text.matchAll(pattern)) {
			const found = piPackageAt(match[0]);
			if (found) return found;
		}
	} catch {
		// Not readable.
	}
	return undefined;
}

/** The pi package a `pi` command runs. */
export function piPackageForCommand(command: string): PiInstallation | undefined {
	const real = realpath(command);
	// npm, bun and pnpm link the command to the package's own bin script.
	const enclosing = enclosingPiPackage(dirname(real));
	if (enclosing) return enclosing;
	// pi's managed launcher lives in `<agent dir>/bin`.
	const managed = managedPiPackage(dirname(dirname(real)));
	if (managed) return managed;
	// npm's Windows shims sit in the prefix, next to `node_modules`.
	for (const dir of [dirname(command), dirname(real)]) {
		const shim = piPackageAt(join(dir, "node_modules", ...PI_PACKAGE.split("/")));
		if (shim) return shim;
	}
	return packagesNamedIn(real);
}

function withCommand(installation: PiInstallation, command: string | undefined): PiInstallation {
	return command ? { ...installation, command } : installation;
}

/** Find the pi installation Pier uses: `PIER_PI_PATH`, the `pi` command, or pi's managed install. */
export function locatePi(options: LocatePiOptions = {}): PiLocation {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const agentDir = piAgentDir(env, home);
	const override = env[PI_PATH_OVERRIDE]?.trim();
	if (override) {
		if (!isAbsolute(override) || !existsSync(override)) {
			return { state: "invalid", reason: `${PI_PATH_OVERRIDE} 指向的路径不存在：${override}` };
		}
		const isDirectory = statSync(override).isDirectory();
		const found = isDirectory ? enclosingPiPackage(override) : piPackageForCommand(override);
		if (!found) {
			return {
				state: "invalid",
				...(isDirectory ? {} : { command: override }),
				reason: `${PI_PATH_OVERRIDE}（${override}）不是 pi 的 npm 安装`,
			};
		}
		// A directory has no command of its own: use the `pi` on PATH only when it runs this package.
		let command: string | undefined = override;
		if (isDirectory) {
			command = options.findCommand ? options.findCommand() : findPiCommand(env, agentDir);
			if (command && piPackageForCommand(command)?.packageDir !== found.packageDir) command = undefined;
		}
		return { state: "found", installation: withCommand(found, command) };
	}
	const command = options.findCommand ? options.findCommand() : findPiCommand(env, agentDir);
	if (command) {
		const found = piPackageForCommand(command);
		if (found) return { state: "found", installation: withCommand(found, command) };
	}
	// GUI apps may not see the directory the installer put on PATH.
	const managed = managedPiPackage(agentDir);
	if (managed) return { state: "found", installation: withCommand(managed, command ?? managedLauncher(agentDir)) };
	if (command) {
		return {
			state: "invalid",
			command,
			reason: `找到了 ${command}，但它不是 pi 的 npm 安装（Pier 需要从 npm 包加载 pi）。请用官方安装程序或 npm 重新安装 pi，或设置 ${PI_PATH_OVERRIDE} 指向 pi 的包目录`,
		};
	}
	return { state: "missing" };
}

function findPiCommand(env: NodeJS.ProcessEnv, agentDir: string): string | undefined {
	const found = findExecutable("pi");
	if (found) return found;
	const extra = [join(agentDir, "bin")];
	if (process.platform === "win32" && env.APPDATA) extra.push(join(env.APPDATA, "npm"));
	const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi.ps1", "pi"] : ["pi"];
	for (const dir of extra) {
		for (const name of names) {
			const path = join(dir, name);
			try {
				if (statSync(path).isFile()) return path;
			} catch {
				// Not there.
			}
		}
	}
	return undefined;
}

// ---- loading -------------------------------------------------------------------------------

/** Directory of `name` as Node resolves it from inside `fromDir`. */
function packageDirFrom(name: string, fromDir: string): string | undefined {
	for (let dir = fromDir; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return realpath(candidate);
		if (dirname(dir) === dir) return undefined;
	}
}

/** Conditions of the running runtime, in the order its resolver checks them. */
function activeConditions(): Set<string> {
	return new Set(process.versions.bun ? ["bun", "import", "node", "default"] : ["import", "node", "default"]);
}

function conditionalTarget(value: unknown, conditions: Set<string>): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const target = conditionalTarget(item, conditions);
			if (target) return target;
		}
		return undefined;
	}
	if (value && typeof value === "object") {
		for (const [key, nested] of Object.entries(value)) {
			if (!conditions.has(key)) continue;
			const target = conditionalTarget(nested, conditions);
			if (target) return target;
		}
	}
	return undefined;
}

/** The file a package exports for `subpath` (`.` or `./x`), following its `exports` map. */
export function exportedFile(packageDir: string, subpath: string): string {
	const manifest = readJson(join(packageDir, "package.json")) ?? {};
	const exports = manifest.exports;
	const conditions = activeConditions();
	let target: string | undefined;
	if (exports === undefined) {
		target = subpath === "." ? (typeof manifest.main === "string" ? manifest.main : "index.js") : subpath;
	} else if (typeof exports === "string" || Array.isArray(exports)) {
		target = subpath === "." ? conditionalTarget(exports, conditions) : undefined;
	} else if (exports && typeof exports === "object") {
		const map = exports as Record<string, unknown>;
		const isSubpathMap = Object.keys(map).some((key) => key.startsWith("."));
		if (!isSubpathMap) target = subpath === "." ? conditionalTarget(map, conditions) : undefined;
		else if (subpath in map) target = conditionalTarget(map[subpath], conditions);
		else {
			for (const [key, value] of Object.entries(map)) {
				const star = key.indexOf("*");
				if (star === -1) continue;
				const prefix = key.slice(0, star);
				const suffix = key.slice(star + 1);
				if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) continue;
				const match = subpath.slice(prefix.length, subpath.length - suffix.length);
				target = conditionalTarget(value, conditions)?.replaceAll("*", match);
				if (target) break;
			}
		}
	}
	if (!target) throw new Error(`${String(manifest.name ?? packageDir)} does not export ${subpath}`);
	const file = resolve(packageDir, target);
	if (!existsSync(file)) throw new Error(`Missing file ${file}`);
	return realpath(file);
}

/** Exports Pier calls; a pi that lacks one of them cannot run Pier's sessions. */
const REQUIRED_AGENT_EXPORTS = [
	"VERSION",
	"ModelRuntime",
	"SettingsManager",
	"SessionManager",
	"DefaultPackageManager",
	"createAgentSessionRuntime",
	"createAgentSessionServices",
	"createAgentSessionFromServices",
	"createCodemodeExtension",
	"createMcpExtension",
	"createToolSearchExtension",
	"initTheme",
] as const;
const REQUIRED_AI_EXPORTS = ["clampThinkingLevel", "getSupportedThinkingLevels"] as const;

function importFile<T>(file: string): Promise<T> {
	return import(pathToFileURL(file).href) as Promise<T>;
}

/** Load the pi SDK of `installation` into this process. */
export async function loadPiSdk(installation: Pick<PiInstallation, "packageDir">): Promise<PiSdk> {
	const packageDir = realpath(installation.packageDir);
	const aiDir = packageDirFrom(PI_AI_PACKAGE, packageDir);
	if (!aiDir) throw new Error(`${PI_AI_PACKAGE} is missing from the pi installation in ${packageDir}`);
	// The same files pi itself imports, so Pier and pi share one instance of each module.
	const agent = await importFile<PiAgentModule>(exportedFile(packageDir, "."));
	const ai = await importFile<PiAiModule>(exportedFile(aiDir, "."));
	const providers = await importFile<PiProvidersModule>(exportedFile(aiDir, "./providers/all"));
	const missing = [
		...REQUIRED_AGENT_EXPORTS.filter((name) => agent[name] === undefined),
		...REQUIRED_AI_EXPORTS.filter((name) => ai[name] === undefined),
		...(typeof providers.getBuiltinProviders === "function" ? [] : ["getBuiltinProviders"]),
	];
	if (missing.length) throw new Error(`pi ${agent.VERSION ?? "?"} 缺少 Pier 需要的接口：${missing.join(", ")}`);
	return {
		version: agent.VERSION,
		packageDir,
		agent,
		ai,
		builtinProviders: () => providers.getBuiltinProviders(),
	};
}

/**
 * Older Pier builds pointed `PI_PACKAGE_DIR` at the pi assets they shipped (no `dist`), and
 * shells started from them inherit it: pi would read its version, themes and docs from there.
 * Removes it from `env` unless it names pi's package (of `installation`'s version); returns the
 * dropped value. A `PI_PACKAGE_DIR` the user set for pi itself (e.g. on Nix) is kept.
 */
export function dropForeignPiPackageDir(
	env: NodeJS.ProcessEnv = process.env,
	installation?: Pick<PiInstallation, "version">,
): string | undefined {
	const dir = env.PI_PACKAGE_DIR?.trim();
	if (!dir) return undefined;
	const manifest = readJson(join(dir, "package.json"));
	const pi =
		manifest?.name === PI_PACKAGE &&
		existsSync(join(dir, "dist", "index.js")) &&
		(!installation || manifest.version === installation.version);
	if (pi) return undefined;
	delete env.PI_PACKAGE_DIR;
	return dir;
}

// ---- the process-wide pi ------------------------------------------------------------------

export interface PiLoaderOptions {
	/** An already loaded SDK (tests, tools). Pier never looks for pi on disk then. */
	sdk?: PiSdk;
	locate?: () => PiLocation;
	load?: (installation: PiInstallation) => Promise<PiSdk>;
	log?: (message: string) => void;
}

/** What Pier knows about pi: the SDK it loaded, and the installation on disk now. */
export interface PiState {
	sdk?: PiSdk;
	location: PiLocation;
	/** Why pi cannot be used, when it cannot. */
	reason?: string;
}

const INSTALL_HINT = "在「设置 → Agent 配置 → pi」中安装，或在终端运行 curl -fsSL https://pi.dev/install.sh | sh";

/**
 * Loads pi once per process. An ES module graph cannot be unloaded, so a pi updated on disk
 * after it was loaded takes effect when the Host restarts; a pi installed after the Host started
 * is picked up on the next use.
 */
export class PiLoader {
	private sdk: PiSdk | undefined;
	private loading: Promise<PiSdk> | undefined;
	/** The last failed installation (`packageDir@version`) and why; not retried until it changes. */
	private failure: { key: string; reason: string } | undefined;

	constructor(private readonly options: PiLoaderOptions = {}) {
		this.sdk = options.sdk;
	}

	get loaded(): PiSdk | undefined {
		return this.sdk;
	}

	locate(): PiLocation {
		if (this.options.locate) return this.options.locate();
		if (this.options.sdk) {
			return {
				state: "found",
				installation: { packageDir: this.options.sdk.packageDir, version: this.options.sdk.version },
			};
		}
		return locatePi();
	}

	/** Why the installation at `location` cannot be loaded, without loading it. */
	private problem(location: PiLocation): string | undefined {
		if (location.state === "missing") return `未找到 pi。${INSTALL_HINT}`;
		if (location.state === "invalid") return location.reason;
		const { installation } = location;
		if (compareVersions(installation.version, MIN_PI_VERSION) < 0) {
			return `pi ${installation.version} 版本过旧，Pier 需要 pi ${MIN_PI_VERSION} 或更新的版本。请在「设置 → Agent 配置 → pi」更新，或在终端运行 pi update`;
		}
		const key = `${installation.packageDir}@${installation.version}`;
		if (this.failure?.key === key) return this.failure.reason;
		return undefined;
	}

	state(): PiState {
		const location = this.locate();
		if (this.sdk) return { sdk: this.sdk, location };
		const reason = this.problem(location);
		return reason ? { location, reason } : { location };
	}

	/** The loaded SDK, loading pi first when it has not been loaded. Throws when pi cannot be used. */
	load(): Promise<PiSdk> {
		if (this.sdk) return Promise.resolve(this.sdk);
		this.loading ??= this.loadNow().finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}

	private async loadNow(): Promise<PiSdk> {
		const location = this.locate();
		const reason = this.problem(location);
		if (reason || location.state !== "found") throw new PierProtocolError("CONFLICT", reason ?? "pi 不可用");
		const { installation } = location;
		if (!this.options.sdk) {
			const dropped = dropForeignPiPackageDir(process.env, installation);
			if (dropped) this.options.log?.(`ignoring PI_PACKAGE_DIR=${dropped}: it is not pi ${installation.version}`);
		}
		try {
			this.sdk = await (this.options.load ?? loadPiSdk)(installation);
			this.options.log?.(`loaded pi ${this.sdk.version} from ${this.sdk.packageDir}`);
			return this.sdk;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failure = `无法加载 ${installation.packageDir} 中的 pi ${installation.version}：${message}`;
			this.failure = { key: `${installation.packageDir}@${installation.version}`, reason: failure };
			this.options.log?.(failure);
			throw new PierProtocolError("CONFLICT", failure);
		}
	}
}
