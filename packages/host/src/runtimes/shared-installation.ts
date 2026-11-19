import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { NativeAgentRuntime } from "@pier/protocol";

export function agentCommand(runtime: NativeAgentRuntime): string {
	return runtime === "codex" ? "codex" : "claude";
}

export function sharedAgentPaths(runtime: NativeAgentRuntime, home = homedir(), platform = process.platform) {
	const bin = join(home, ".local", "bin");
	return {
		bin,
		versions: join(home, ".local", "share", agentCommand(runtime), "versions"),
		executable: join(bin, `${agentCommand(runtime)}${platform === "win32" ? ".exe" : ""}`),
	};
}

export function sharedAgentExecutable(runtime: NativeAgentRuntime, home = homedir()): string | undefined {
	try {
		const path = sharedAgentPaths(runtime, home).executable;
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
	const paths = sharedAgentPaths(runtime, home, platform);
	await mkdir(paths.bin, { recursive: true });
	const staging = join(paths.bin, `.pier-${runtime}-${randomUUID()}`);
	await mkdir(staging, { mode: 0o700 });
	const changed: Array<{ target: string; backup?: string; installed: boolean }> = [];
	let cleanup = true;
	try {
		const filename = basename(paths.executable);
		if (platform !== "win32") {
			await symlink(executable, join(staging, filename));
			// POSIX rename replaces the command in one operation; running binaries stay intact.
			await rename(join(staging, filename), paths.executable);
			return;
		}
		const names = runtime === "codex" ? await readdir(dirname(executable)) : [filename];
		// Keep Codex's companion executables beside codex.exe on Windows. On Unix the symlink
		// resolves to the complete versioned package, so companions remain beside the real binary.
		for (const name of names) {
			const source = name === filename ? executable : join(dirname(executable), name);
			await copyFile(source, join(staging, name));
		}
		const launchers = ["cmd", "bat", "ps1"].map((ext) => `${agentCommand(runtime)}.${ext}`);
		for (const name of [...launchers, ...names.filter((name) => name !== filename), filename]) {
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
			if (names.includes(name)) {
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
