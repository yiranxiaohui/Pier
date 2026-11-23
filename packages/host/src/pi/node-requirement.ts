/**
 * What pi's official installers need before they install pi: Node.js 22.19 or newer and npm on
 * `PATH` (`run_preflight_checks` in pi.dev/install.sh, `Invoke-PreflightChecks` in install.ps1).
 * Without a terminal, they cannot offer to install Node.js and only print "No terminal detected",
 * so the Host checks first and explains how to install Node.js on this computer.
 */
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { NodeRequirement } from "@pier/protocol";
import { readVersion } from "../package-managers.ts";

/** The oldest Node.js pi's installers accept. */
export const PI_NODE_MINIMUM = "22.19.0";
export const NODE_DOWNLOAD_URL = "https://nodejs.org/zh-cn/download";

export interface NodeToolchain {
	/** The `node` on PATH, with its version or why `node --version` failed. */
	node?: { path: string; version?: string; error?: string };
	/** The `npm` on PATH. */
	npm?: string;
	/** Homebrew's `brew` on PATH (macOS), to suggest `brew install node`. */
	brew?: string;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The first of `names` in the directories of `env`'s PATH, as a shell would run it. */
export function findOnPath(names: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
	const windows = platform === "win32";
	const key = Object.keys(env).find((name) => (windows ? name.toUpperCase() === "PATH" : name === "PATH"));
	const dirs = (key ? (env[key] ?? "") : "")
		.split(windows ? ";" : ":")
		.map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
		.filter(Boolean);
	const path = windows ? win32 : posix;
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (isExecutable(candidate, platform)) return candidate;
		}
	}
	return undefined;
}

/** Find `node` and `npm` the way pi's installers do, and read the version of `node`. */
export async function findNodeToolchain(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): Promise<NodeToolchain> {
	const windows = platform === "win32";
	// install.ps1 runs `Get-Command node`, then prefers npm.cmd (npm.ps1 may be blocked by policy).
	const node = findOnPath(windows ? ["node.exe", "node.cmd", "node.bat"] : ["node"], env, platform);
	const npm = findOnPath(windows ? ["npm.cmd", "npm.exe"] : ["npm"], env, platform);
	const brew = platform === "darwin" ? findOnPath(["brew"], env, platform) : undefined;
	const toolchain: NodeToolchain = {
		...(npm ? { npm } : {}),
		...(brew ? { brew } : {}),
	};
	if (node) toolchain.node = { path: node, ...(await readVersion(node, { env })) };
	return toolchain;
}

/** Whether `version` ("22.19.0", "v24.1.0") is at least `minimum`. */
export function isNodeVersionAtLeast(version: string, minimum = PI_NODE_MINIMUM): boolean {
	const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())?.slice(1).map(Number);
	const have = parse(version);
	const need = parse(minimum);
	if (!have || !need) return false;
	for (let i = 0; i < 3; i++) {
		if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
	}
	return true;
}

/** A command that installs a current Node.js with npm, when there is one for this computer. */
export function nodeInstallCommand(platform: NodeJS.Platform, toolchain: NodeToolchain): string | undefined {
	if (platform === "win32") return "winget install OpenJS.NodeJS.LTS";
	if (platform === "darwin" && toolchain.brew) return "brew install node";
	// Linux distributions often package an older Node.js (or none of npm): no single command fits.
	return undefined;
}

/** What is missing for pi's installer, or undefined when Node.js and npm are ready. */
export function nodeRequirement(toolchain: NodeToolchain, platform: NodeJS.Platform): NodeRequirement | undefined {
	const { node } = toolchain;
	const problem: NodeRequirement["problem"] | undefined = !node
		? "missing"
		: !node.version || !isNodeVersionAtLeast(node.version)
			? "outdated"
			: !toolchain.npm
				? "npm-missing"
				: undefined;
	if (!problem) return undefined;
	const command = nodeInstallCommand(platform, toolchain);
	return {
		minimum: PI_NODE_MINIMUM,
		problem,
		...(node ? { node: node.path } : {}),
		...(node?.version ? { nodeVersion: node.version } : {}),
		...(command ? { command } : {}),
	};
}

/**
 * Explain what is missing and how to install it on this computer. `refreshesPath`: the Host reads
 * the user's PATH again before each installation, so no restart is needed after installing.
 */
export function nodeRequirementMessage(
	requirement: NodeRequirement,
	toolchain: NodeToolchain,
	platform: NodeJS.Platform,
	refreshesPath: boolean,
): string {
	const minimum = requirement.minimum.replace(/\.0$/, "");
	const node = toolchain.node;
	const problem =
		requirement.problem === "missing"
			? `pi 的安装程序需要 Node.js ${minimum} 或更新版本及 npm，但在这台电脑的 PATH 中找不到 Node.js。`
			: requirement.problem === "outdated"
				? node?.version
					? `pi 的安装程序需要 Node.js ${minimum} 或更新版本，这台电脑上的 Node.js 是 v${node.version.replace(/^v/, "")}（${node.path}）。`
					: `pi 的安装程序需要 Node.js ${minimum} 或更新版本，但无法运行 ${node?.path ?? "node"}${node?.error ? `（${node.error}）` : ""}。`
				: `pi 的安装程序需要 npm，但在这台电脑的 PATH 中找不到 npm（已找到 Node.js v${(node?.version ?? "").replace(/^v/, "")}）。`;
	const install =
		platform === "win32"
			? `请先安装 Node.js LTS：在 PowerShell 中运行 ${requirement.command}，或从 ${NODE_DOWNLOAD_URL} 下载安装包。`
			: platform === "darwin"
				? requirement.command
					? `请先安装 Node.js：运行 ${requirement.command}，或从 ${NODE_DOWNLOAD_URL} 下载安装包。`
					: `请先从 ${NODE_DOWNLOAD_URL} 下载安装 Node.js，或用 nvm、fnm 等工具安装。`
				: requirement.problem === "npm-missing"
					? "请用发行版的软件包（例如 npm）或 Node.js 官方发行版补上 npm。"
					: `请先安装 Node.js ${minimum.split(".")[0]} 或更新版本：用 nvm、fnm 或 Node.js 官方发行版（${NODE_DOWNLOAD_URL}），发行版自带的 Node.js 可能过旧。`;
	const after = refreshesPath
		? "装好后重新安装 pi 即可，Pier 会重新读取 PATH，无需重启。"
		: "装好后确认 Pier Host 的 PATH 中能找到 node 和 npm（可能需要重启 Pier Host），再重新安装 pi。";
	return `${problem}${install}${after}`;
}
