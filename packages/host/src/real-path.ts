import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

/**
 * Bun's `realpath` drops the trailing separator of a Windows drive root: `C:\` comes back as
 * `C:`, which Windows reads as the current directory of drive C. `relative`, `resolve`, `join`
 * and `readdir` would then use the Host's working directory instead of the root, so the host file
 * manager rejected every folder as outside `C:\`. Put the separator back.
 */
export function keepDriveRoot(path: string): string {
	return /^[a-zA-Z]:$/.test(path) ? `${path}\\` : path;
}

/** `realpath` that keeps a Windows drive root a root. */
export async function realPath(path: string): Promise<string> {
	return keepDriveRoot(await realpath(path));
}

/** `realpathSync` that keeps a Windows drive root a root. */
export function realPathSync(path: string): string {
	return keepDriveRoot(realpathSync(path));
}
