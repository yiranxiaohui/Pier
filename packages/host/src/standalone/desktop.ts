import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DesktopImage {
	path: string;
	sha256: string;
}

/** The AppImage carries GTK/WebKit; the outer executable can still run on a bare server. */
export function prepareDesktop(image: DesktopImage, stateDir: string): string {
	if (!/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error("Invalid desktop checksum");
	const root = join(stateDir, "runtime", "desktop");
	const destination = join(root, image.sha256);
	const executable = join(destination, "Pier.AppImage");
	if (existsSync(executable)) return executable;
	const bytes = readFileSync(image.path);
	if (createHash("sha256").update(bytes).digest("hex") !== image.sha256)
		throw new Error("Embedded desktop checksum mismatch");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const temporary = mkdtempSync(join(root, ".prepare-"));
	try {
		writeFileSync(join(temporary, "Pier.AppImage"), bytes, { mode: 0o700 });
		try {
			renameSync(temporary, destination);
		} catch (error) {
			if (!existsSync(executable)) throw error;
		}
		return executable;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export async function launchDesktop(image: DesktopImage, stateDir: string, args: string[]): Promise<void> {
	const executable = prepareDesktop(image, stateDir);
	const child = spawn(executable, ["--appimage-extract-and-run", ...args], {
		stdio: "inherit",
		env: { ...process.env, PIER_DIR: stateDir, PIER_PORTABLE_EXECUTABLE: resolve(process.execPath) },
	});
	const interrupt = () => child.kill("SIGINT");
	const terminate = () => child.kill("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	try {
		process.exitCode = await new Promise<number>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 143)));
		});
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
	}
}
