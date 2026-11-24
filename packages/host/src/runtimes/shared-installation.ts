import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { NativeAgentRuntime } from "@pier/protocol";

export function agentCommand(runtime: NativeAgentRuntime): string {
	return runtime === "codex" ? "codex" : "claude";
}

/**
 * Codex finds the rest of its package (`codex-package.json`, `codex-resources`, `codex-path`) from
 * the resolved path of `codex`; Codex 0.157 and later refuse to start their background server
 * without it. Windows has no unprivileged file symlinks, so there the command directory is the
 * selected package's own `bin`, reached through a junction, as Codex's official installer does.
 */
function packagedCommand(runtime: NativeAgentRuntime, platform: NodeJS.Platform): boolean {
	return runtime === "codex" && platform === "win32";
}

export function sharedAgentPaths(runtime: NativeAgentRuntime, home = homedir(), platform = process.platform) {
	const commands = join(home, ".local", "bin");
	const share = join(home, ".local", "share", agentCommand(runtime));
	const current = join(share, "current");
	const bin = packagedCommand(runtime, platform) ? join(current, "bin") : commands;
	return {
		/** The directory to put on `PATH`. */
		bin,
		/** The shared user-level command directory (`~/.local/bin`). */
		commands,
		versions: join(share, "versions"),
		/** Windows Codex: the junction to the selected release in `versions`. */
		current,
		executable: join(bin, `${agentCommand(runtime)}${platform === "win32" ? ".exe" : ""}`),
	};
}

export function sharedAgentExecutable(
	runtime: NativeAgentRuntime,
	home = homedir(),
	platform = process.platform,
): string | undefined {
	try {
		const path = sharedAgentPaths(runtime, home, platform).executable;
		return statSync(path).isFile() ? realpathSync(path) : undefined;
	} catch {
		return undefined;
	}
}

/** Publish verified binaries without following/replacing the targets of existing CLI symlinks. */
export async function publishAgentCommand(
	runtime: NativeAgentRuntime,
	executable: string,
	home: string,
	platform = process.platform,
): Promise<void> {
	if (packagedCommand(runtime, platform)) return publishPackagedCommand(runtime, executable, home, platform);
	const paths = sharedAgentPaths(runtime, home, platform);
	await mkdir(paths.bin, { recursive: true });
	const staging = join(paths.bin, `.pier-${runtime}-${randomUUID()}`);
	await mkdir(staging, { mode: 0o700 });
	const changed: Array<{ target: string; backup?: string; installed: boolean }> = [];
	let cleanup = true;
	try {
		const filename = basename(paths.executable);
		if (platform !== "win32") {
			// The symlink resolves to the complete versioned package, so Codex finds its companions.
			await symlink(executable, join(staging, filename));
			// POSIX rename replaces the command in one operation; running binaries stay intact.
			await rename(join(staging, filename), paths.executable);
			return;
		}
		await copyFile(executable, join(staging, filename));
		const launchers = ["cmd", "bat", "ps1"].map((ext) => `${agentCommand(runtime)}.${ext}`);
		for (const name of [...launchers, filename]) {
			const target = join(paths.bin, name);
			const entry: (typeof changed)[number] = { target, installed: false };
			try {
				const existing = await lstat(target);
				if (existing.isDirectory()) throw new Error(`命令路径是目录，无法替换：${target}`);
				entry.backup = join(staging, `${name}.previous`);
				await rename(target, entry.backup);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			changed.push(entry);
			if (name === filename) {
				await rename(join(staging, name), target);
				entry.installed = true;
			}
		}
	} catch (error) {
		try {
			for (const entry of changed.reverse()) {
				if (entry.installed) await rm(entry.target, { force: true });
				if (entry.backup) await rename(entry.backup, entry.target);
			}
		} catch (rollbackError) {
			cleanup = false;
			throw new Error(`Agent 命令恢复失败，旧程序备份保存在 ${staging}`, { cause: rollbackError });
		}
		if (platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			throw new Error("无法替换正在使用或无权限的 Agent 程序，已保留旧版。请关闭该 Agent 的会话和外部终端程序后重试");
		}
		throw error;
	} finally {
		if (cleanup) await rm(staging, { recursive: true, force: true });
	}
}

/**
 * Select `<release>/bin/<command>.exe` by pointing the `current` junction at its release. The
 * junction is replaced with two renames, so running programs keep their files and a failure leaves
 * the previous release selected.
 */
async function publishPackagedCommand(
	runtime: NativeAgentRuntime,
	executable: string,
	home: string,
	platform: NodeJS.Platform,
): Promise<void> {
	const paths = sharedAgentPaths(runtime, home, platform);
	const release = dirname(dirname(executable));
	if (basename(dirname(executable)) !== "bin" || basename(executable) !== basename(paths.executable)) {
		throw new Error(`${agentCommand(runtime)} 不在完整的发行包中：${executable}`);
	}
	await mkdir(dirname(paths.current), { recursive: true });
	const next = `${paths.current}.pier-${randomUUID()}`;
	// A junction needs no privileges on Windows; other systems (tests) create a symlink.
	await symlink(release, next, "junction");
	let previous: string | undefined;
	try {
		const existing = await lstat(paths.current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (existing) {
			// Never replace a directory or file Pier did not create.
			if (!existing.isSymbolicLink()) throw new Error(`命令路径不是 Pier 创建的链接，无法替换：${paths.current}`);
			previous = `${paths.current}.previous-${randomUUID()}`;
			await rename(paths.current, previous);
		}
		try {
			await rename(next, paths.current);
		} catch (error) {
			if (previous) await rename(previous, paths.current);
			previous = undefined;
			throw error;
		}
	} catch (error) {
		await unlink(next).catch(() => {});
		throw error;
	}
	// Removes the junction only, never the release it pointed to.
	if (previous) await unlink(previous).catch(() => {});
	await retireCopiedCommands(runtime, home, platform, await readdir(join(release, "bin")));
}

/**
 * Earlier Pier versions copied the files of Codex's `bin` into `~/.local/bin` on Windows. Remove
 * those copies, which would otherwise shadow the package command when `~/.local/bin` comes first on
 * `PATH`, together with older shell launchers. Programs still running stay in place until the next
 * publication or Host start retries. Does nothing where the command is not a package junction.
 */
export async function retireCopiedCommands(
	runtime: NativeAgentRuntime,
	home: string,
	platform = process.platform,
	companions: string[] = [],
): Promise<void> {
	if (!packagedCommand(runtime, platform)) return;
	const paths = sharedAgentPaths(runtime, home, platform);
	const command = agentCommand(runtime);
	const names = new Set([
		...["exe", "cmd", "bat", "ps1"].map((ext) => `${command}.${ext}`),
		...companions,
		...COPIED_COMPANIONS,
	]);
	const share = dirname(paths.current);
	for (const name of await readdir(share).catch(() => [])) {
		if (name.startsWith(".retired-")) await rm(join(share, name), { recursive: true, force: true }).catch(() => {});
	}
	let retired: string | undefined;
	for (const name of names) {
		const target = join(paths.commands, name);
		try {
			if ((await lstat(target)).isDirectory()) continue;
			retired ??= join(share, `.retired-${randomUUID()}`);
			await mkdir(retired, { recursive: true, mode: 0o700 });
			// Windows can rename, but not delete, a program that is running.
			await rename(target, join(retired, name));
		} catch {
			// Missing, or in use; retried later.
		}
	}
	if (retired) await rm(retired, { recursive: true, force: true }).catch(() => {});
}

/** Files of Codex's `bin` that earlier Pier versions copied next to `codex.exe`. */
const COPIED_COMPANIONS = [
	"codex-code-mode-host.exe",
	"codex-exec-server.exe",
	"codex-command-runner.exe",
	"codex-windows-sandbox-setup.exe",
];
