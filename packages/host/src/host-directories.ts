import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type HostDirectoryEntry, type HostDirectoryListing, PierProtocolError } from "@pier/protocol";

/** Most subdirectories returned for one directory; the rest are dropped and `truncated` is set. */
export const MAX_HOST_DIRECTORY_ENTRIES = 2000;

function compareNames(a: HostDirectoryEntry, b: HostDirectoryEntry): number {
	const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	return byName || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function toEntry(dir: string, dirent: Dirent): Promise<HostDirectoryEntry | undefined> {
	const path = join(dir, dirent.name);
	if (dirent.isDirectory()) return { name: dirent.name, path };
	if (!dirent.isSymbolicLink()) return undefined;
	try {
		return (await stat(path)).isDirectory() ? { name: dirent.name, path, symlink: true } : undefined;
	} catch {
		return undefined; // Broken link.
	}
}

export function absoluteHostDirectory(path?: string): string {
	if (path !== undefined && !isAbsolute(path)) {
		throw new PierProtocolError("BAD_REQUEST", "Directory path must be absolute");
	}
	return resolve(path ?? homedir());
}

/** List subdirectories for the remote workspace picker. */
export async function listHostDirectories(path?: string): Promise<HostDirectoryListing> {
	const dir = absoluteHostDirectory(path);
	let dirents: Dirent[];
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOTDIR") throw new PierProtocolError("BAD_REQUEST", `Not a directory: ${dir}`);
		if (code === "ENOENT") throw new PierProtocolError("NOT_FOUND", `No such directory: ${dir}`);
		if (code === "EACCES" || code === "EPERM") throw new PierProtocolError("FORBIDDEN", `Permission denied: ${dir}`);
		throw error;
	}
	const entries = (await Promise.all(dirents.map((d) => toEntry(dir, d)))).filter(
		(e): e is HostDirectoryEntry => e !== undefined,
	);
	entries.sort(compareNames);
	const parent = dirname(dir);
	const total = entries.length;
	return {
		path: dir,
		...(parent !== dir ? { parent } : {}),
		home: homedir(),
		separator: sep,
		entries: entries.slice(0, MAX_HOST_DIRECTORY_ENTRIES),
		...(total > MAX_HOST_DIRECTORY_ENTRIES ? { truncated: true, total } : {}),
	};
}
