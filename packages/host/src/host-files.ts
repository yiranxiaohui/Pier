import { parse, relative, sep } from "node:path";
import { PierProtocolError } from "@pier/protocol";
import { absoluteHostDirectory } from "./host-directories.ts";
import { normalizeRelativePath } from "./workspace-files.ts";

/**
 * Where a host directory method (`host.*`, 1.57 / 1.58) runs the workspace file functions.
 *
 * Unlike a workspace root, a host directory is no boundary: an authenticated client may already
 * open any directory, so paths are resolved from the filesystem root and symlinks may point
 * anywhere (a linked dotfile or folder in the home directory opens like any other entry).
 * Results report their paths relative to the requested directory again with {@link local}.
 */
export interface HostFileTarget {
	/** The absolute directory, resolved but not following symlinks. */
	directory: string;
	/** The filesystem root of `directory`, used as the workspace root. */
	root: string;
	/** The requested path relative to `root`, joined with "/". */
	path: string;
	/** Map a path relative to `root` back to one relative to `directory`. */
	local(path: string): string;
}

/**
 * Resolve `path` (relative to the absolute `directory`; omitted for the directory itself). A
 * given path must name an entry inside the directory: `""` or `"."` would be the directory.
 */
export function hostFileTarget(directory: string | undefined, path?: string): HostFileTarget {
	const dir = absoluteHostDirectory(directory);
	const root = parse(dir).root;
	const prefix = relative(root, dir).split(sep).filter(Boolean).join("/");
	const relPath = normalizeRelativePath(path);
	if (path !== undefined && !relPath) {
		throw new PierProtocolError("BAD_REQUEST", "Path must name an entry inside the directory");
	}
	return {
		directory: dir,
		root,
		path: prefix && relPath ? `${prefix}/${relPath}` : prefix || relPath,
		local: (value) => {
			if (!prefix) return value;
			if (value === prefix) return "";
			return value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : value;
		},
	};
}
