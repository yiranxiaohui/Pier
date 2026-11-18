import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Directories CLIs are commonly installed to that a GUI app's `PATH` may lack. */
function extraDirectories(): string[] {
	const home = homedir();
	return [
		join(home, ".local", "bin"),
		join(home, ".claude", "local"),
		join(home, ".npm-global", "bin"),
		join(home, ".bun", "bin"),
		join(home, ".volta", "bin"),
		join(home, ".cargo", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	];
}

function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Find a CLI: the path in `override` (an environment variable's value) when set, otherwise the
 * shared user-level command (or a legacy Pier installation), then `name` on `PATH` or in common install directories.
 */
export function findExecutable(name: string, override?: string, managed?: string): string | undefined {
	if (override) return isAbsolute(override) && isExecutable(override) ? override : undefined;
	if (managed && isExecutable(managed)) return managed;
	const names =
		process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`, name] : [name];
	const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...extraDirectories()];
	if (name === "opencode") dirs.push(join(homedir(), ".opencode", "bin"));
	for (const dir of dirs) {
		for (const candidate of names) {
			const path = join(dir, candidate);
			if (isExecutable(path)) return path;
		}
	}
	return undefined;
}

/** Run `<executable> --version` and return the first version-looking token of its output. */
export function probeVersion(executable: string, timeoutMs = 10_000): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile(
				executable,
				["--version"],
				{
					timeout: timeoutMs,
					windowsHide: true,
					shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
				},
				(error, stdout) => {
					if (error) return resolve(undefined);
					const match = /\d+\.\d+\.\d+[\w.+-]*/.exec(String(stdout));
					resolve(match ? match[0] : String(stdout).trim().split(/\s+/)[0] || undefined);
				},
			);
		} catch {
			// Invalid native executables can throw before the callback on macOS and Windows.
			resolve(undefined);
		}
	});
}
