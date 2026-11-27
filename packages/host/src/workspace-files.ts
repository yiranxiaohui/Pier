import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	PierProtocolError,
	type WorkspaceFileBytes,
	type WorkspaceFileContent,
	type WorkspaceFileEntry,
	type WorkspaceFilesResult,
	type WorkspaceFileWriteResult,
	type WorkspacePathDeleteResult,
} from "@pier/protocol";
import { realPath } from "./real-path.ts";

/** Most entries returned for one directory; the rest are dropped and `truncated` is set. */
export const MAX_DIRECTORY_ENTRIES = 2000;

/** Entries never listed: version-control internals that are large and not useful to browse. */
const HIDDEN_NAMES = new Set([".git", ".hg", ".svn"]);

/**
 * Normalize a client-supplied directory path relative to the workspace root.
 * Accepts "", ".", "src", "src/lib/" and backslash separators; rejects absolute
 * paths and any `..` segment. Returns the path joined with "/" ("" for the root).
 */
export function normalizeRelativePath(path: string | undefined): string {
	if (!path) return "";
	if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith("/") || path.startsWith("\\")) {
		throw new PierProtocolError("BAD_REQUEST", "Path must be relative to the workspace");
	}
	const segments = path.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
	if (segments.some((s) => s === ".." || s.includes("\0"))) {
		throw new PierProtocolError("BAD_REQUEST", "Path must stay inside the workspace");
	}
	return segments.join("/");
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function compareEntries(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
	const dirA = a.kind === "directory" ? 0 : 1;
	const dirB = b.kind === "directory" ? 0 : 1;
	if (dirA !== dirB) return dirA - dirB;
	const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	return byName || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function describe(root: string, dir: string, relDir: string, dirent: Dirent): Promise<WorkspaceFileEntry> {
	const path = relDir ? `${relDir}/${dirent.name}` : dirent.name;
	const full = join(dir, dirent.name);
	const entry: WorkspaceFileEntry = { name: dirent.name, path, kind: "other" };
	try {
		if (dirent.isSymbolicLink()) {
			entry.symlink = true;
			// Follow the link for display, but only offer to expand links that stay in the workspace.
			const target = await stat(full);
			const real = await realPath(full);
			if (target.isDirectory()) entry.kind = isInside(root, real) ? "directory" : "other";
			else if (target.isFile()) {
				entry.kind = "file";
				entry.size = target.size;
			}
			entry.modifiedAt = target.mtime.toISOString();
			return entry;
		}
		const info = await lstat(full);
		if (info.isDirectory()) entry.kind = "directory";
		else if (info.isFile()) {
			entry.kind = "file";
			entry.size = info.size;
		}
		entry.modifiedAt = info.mtime.toISOString();
	} catch {
		// Broken symlink or a file removed while listing: keep the name, without details.
	}
	return entry;
}

export async function workspaceRealRoot(workspaceRoot: string): Promise<string> {
	try {
		return await realPath(workspaceRoot);
	} catch {
		throw new PierProtocolError("NOT_FOUND", `Workspace directory is missing: ${workspaceRoot}`);
	}
}

/** Resolve a normalized relative path (following symlinks) and require it to stay inside `root`. */
export async function resolveInside(root: string, relPath: string, what: string): Promise<string> {
	const target = relPath ? join(root, ...relPath.split("/")) : root;
	let real: string;
	try {
		real = await realPath(target);
	} catch {
		throw new PierProtocolError("NOT_FOUND", `No such ${what}: ${relPath || "."}`);
	}
	if (!isInside(root, real)) {
		throw new PierProtocolError("FORBIDDEN", "Path resolves outside the workspace");
	}
	return real;
}

/**
 * List one directory of a workspace. The directory must resolve (after symlinks) to a
 * location inside the workspace root.
 */
export async function listWorkspaceDirectory(workspaceRoot: string, path?: string): Promise<WorkspaceFilesResult> {
	const relDir = normalizeRelativePath(path);
	const root = await workspaceRealRoot(workspaceRoot);
	const real = await resolveInside(root, relDir, "directory");
	let dirents: Dirent[];
	try {
		dirents = await readdir(real, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOTDIR") throw new PierProtocolError("BAD_REQUEST", `Not a directory: ${relDir}`);
		if (code === "ENOENT") throw new PierProtocolError("NOT_FOUND", `No such directory: ${relDir || "."}`);
		if (code === "EACCES" || code === "EPERM") {
			throw new PierProtocolError("FORBIDDEN", `Permission denied: ${relDir || "."}`);
		}
		throw error;
	}
	const visible = dirents.filter((d) => !HIDDEN_NAMES.has(d.name));
	const entries = await Promise.all(visible.map((d) => describe(root, real, relDir, d)));
	entries.sort(compareEntries);
	const truncated = entries.length > MAX_DIRECTORY_ENTRIES;
	return {
		path: relDir,
		entries: truncated ? entries.slice(0, MAX_DIRECTORY_ENTRIES) : entries,
		...(truncated ? { truncated: true, total: entries.length } : {}),
	};
}

/** Most bytes of a text file returned by `workspace.readFile`; longer files are truncated. */
export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
/** Largest image returned by `workspace.readFile`; larger images come back without data. */
export const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
	".svg": "image/svg+xml",
};

/** Bytes checked for NUL when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8192;

async function readHead(file: string, limit: number): Promise<Buffer> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(limit);
		let filled = 0;
		while (filled < limit) {
			const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
			if (!bytesRead) break;
			filled += bytesRead;
		}
		return buffer.subarray(0, filled);
	} finally {
		await handle.close();
	}
}

/**
 * Decode UTF-8 text, or undefined for binary data. When `cut`, the bytes are the start of a
 * longer file, so a multi-byte character split at the end is dropped instead of rejected.
 */
function decodeText(bytes: Buffer, cut: boolean): string | undefined {
	if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut });
	} catch {
		return undefined;
	}
}

/** Largest text accepted by `workspace.writeFile`, in UTF-8 bytes. */
export const MAX_TEXT_WRITE_BYTES = 4 * 1024 * 1024;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function fsError(error: unknown, relPath: string): never {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT" || code === "ENOTDIR") throw new PierProtocolError("NOT_FOUND", `No such file: ${relPath}`);
	if (code === "EACCES" || code === "EPERM")
		throw new PierProtocolError("FORBIDDEN", `Permission denied: ${relPath}`, {
			reason: "FILESYSTEM_PERMISSION_DENIED",
		});
	if (code === "EROFS" || code === "EBUSY") throw new PierProtocolError("FORBIDDEN", `Permission denied: ${relPath}`);
	if (code === "EISDIR") throw new PierProtocolError("BAD_REQUEST", `Not a file: ${relPath}`);
	throw error;
}

/** Resolve or create parent directories, following only symlinks that stay inside the workspace. */
export async function ensureWorkspaceDirectory(root: string, segments: string[]): Promise<string> {
	let dir = root;
	for (let i = 0; i < segments.length; i++) {
		const next = join(dir, segments[i] as string);
		const shown = segments.slice(0, i + 1).join("/");
		try {
			await lstat(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") fsError(error, shown);
			try {
				await mkdir(next);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") fsError(error, shown);
			}
		}
		const real = await resolveInside(root, shown, "directory");
		if (!(await stat(real)).isDirectory()) throw new PierProtocolError("BAD_REQUEST", `Not a directory: ${shown}`);
		dir = real;
	}
	return dir;
}

async function newWorkspaceTarget(workspaceRoot: string, path: string): Promise<{ path: string; target: string }> {
	const relPath = normalizeRelativePath(path);
	if (!relPath) throw new PierProtocolError("BAD_REQUEST", "Cannot create the workspace root");
	const segments = relPath.split("/");
	const name = segments.pop() as string;
	const root = await workspaceRealRoot(workspaceRoot);
	const parent = await ensureWorkspaceDirectory(root, segments);
	return { path: relPath, target: join(parent, name) };
}

function createError(error: unknown, path: string): never {
	if ((error as NodeJS.ErrnoException).code === "EEXIST") {
		throw new PierProtocolError("CONFLICT", `A file or directory already exists: ${path}`);
	}
	fsError(error, path);
}

/** Create an empty file exclusively, so existing files, directories and symlinks are never replaced. */
export async function createWorkspaceFile(workspaceRoot: string, path: string): Promise<WorkspaceFileWriteResult> {
	const destination = await newWorkspaceTarget(workspaceRoot, path);
	try {
		const handle = await open(destination.target, "wx");
		try {
			const info = await handle.stat();
			return { path: destination.path, size: info.size, modifiedAt: info.mtime.toISOString() };
		} finally {
			await handle.close();
		}
	} catch (error) {
		createError(error, destination.path);
	}
}

/** Create a directory exclusively, including an empty one, with missing parents created as needed. */
export async function createWorkspaceDirectory(workspaceRoot: string, path: string): Promise<{ path: string }> {
	const destination = await newWorkspaceTarget(workspaceRoot, path);
	try {
		await mkdir(destination.target);
		return { path: destination.path };
	} catch (error) {
		createError(error, destination.path);
	}
}

/**
 * Overwrite an existing workspace file with UTF-8 text. The file must resolve (after symlinks)
 * to a regular file inside the workspace root; new files are not created. The file is written
 * in place, so its permissions, owner and hard links are kept, and a UTF-8 byte order mark
 * the file started with is kept too (`workspace.readFile` strips it). When `expectedModifiedAt` is
 * given and the file changed since then, nothing is written and `CONFLICT` is thrown.
 */
export async function writeWorkspaceFile(
	workspaceRoot: string,
	path: string,
	text: string,
	expectedModifiedAt?: string,
): Promise<WorkspaceFileWriteResult> {
	const relPath = normalizeRelativePath(path);
	if (!relPath) throw new PierProtocolError("BAD_REQUEST", "Not a file: .");
	if (Buffer.byteLength(text) > MAX_TEXT_WRITE_BYTES) {
		throw new PierProtocolError("BAD_REQUEST", `Text is larger than ${MAX_TEXT_WRITE_BYTES} bytes`);
	}
	const root = await workspaceRealRoot(workspaceRoot);
	const real = await resolveInside(root, relPath, "file");
	try {
		const before = await stat(real);
		if (!before.isFile()) throw new PierProtocolError("BAD_REQUEST", `Not a file: ${relPath}`);
		if (expectedModifiedAt !== undefined && before.mtime.toISOString() !== expectedModifiedAt) {
			throw new PierProtocolError("CONFLICT", `File changed on disk: ${relPath}`, {
				modifiedAt: before.mtime.toISOString(),
			});
		}
		const bom = (await readHead(real, 3)).equals(UTF8_BOM) && !text.startsWith("\uFEFF");
		await writeFile(real, bom ? `\uFEFF${text}` : text, "utf8");
		const after = await stat(real);
		return { path: relPath, size: after.size, modifiedAt: after.mtime.toISOString() };
	} catch (error) {
		if (error instanceof PierProtocolError) throw error;
		fsError(error, relPath);
	}
}

/**
 * Permanently delete a file, directory (with everything in it) or symbolic link of a workspace.
 * The parent directory must resolve (after symlinks) to a location inside the workspace root;
 * the entry itself is not followed, so deleting a symlink removes only the link, never its
 * target. The workspace root itself cannot be deleted.
 */
export async function deleteWorkspacePath(
	workspaceRoot: string,
	path: string,
	expectedModifiedAt?: string,
	expectedSize?: number,
): Promise<WorkspacePathDeleteResult> {
	const relPath = normalizeRelativePath(path);
	if (!relPath) throw new PierProtocolError("BAD_REQUEST", "Cannot delete the workspace root");
	const root = await workspaceRealRoot(workspaceRoot);
	const segments = relPath.split("/");
	const name = segments.pop() as string;
	const parent = await resolveInside(root, segments.join("/"), "directory");
	const target = join(parent, name);
	try {
		const info = await lstat(target);
		if (expectedModifiedAt !== undefined || expectedSize !== undefined) {
			if (
				!info.isFile() ||
				(expectedModifiedAt !== undefined && info.mtime.toISOString() !== expectedModifiedAt) ||
				(expectedSize !== undefined && info.size !== expectedSize)
			)
				throw new PierProtocolError("CONFLICT", `Source file changed; keeping it: ${relPath}`);
		}
		const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
		await rm(target, { recursive: kind === "directory", maxRetries: 2 });
		return { path: relPath, kind };
	} catch (error) {
		fsError(error, relPath);
	}
}

/** Largest range returned by one `workspace.readBytes` call. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * Read a byte range of a resolved regular file. Returns at most `length` bytes
 * from `offset` (fewer at the end of the file), base64-encoded, with the file's current size and
 * modification time so a client can notice the file changing between chunks.
 */
async function readFileBytes(real: string, path: string, offset: number, length: number): Promise<WorkspaceFileBytes> {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new PierProtocolError("BAD_REQUEST", "Invalid offset");
	if (!Number.isSafeInteger(length) || length < 1 || length > MAX_READ_BYTES) {
		throw new PierProtocolError("BAD_REQUEST", `Length must be between 1 and ${MAX_READ_BYTES} bytes`);
	}
	try {
		if (!(await stat(real)).isFile()) throw new PierProtocolError("BAD_REQUEST", `Not a file: ${path}`);
		const handle = await open(real, "r");
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new PierProtocolError("BAD_REQUEST", `Not a file: ${path}`);
			const want = Math.max(0, Math.min(length, info.size - offset));
			const buffer = Buffer.alloc(want);
			let filled = 0;
			while (filled < want) {
				const { bytesRead } = await handle.read(buffer, filled, want - filled, offset + filled);
				if (!bytesRead) break;
				filled += bytesRead;
			}
			return {
				path,
				size: info.size,
				modifiedAt: info.mtime.toISOString(),
				offset,
				data: buffer.subarray(0, filled).toString("base64"),
				eof: offset + filled >= info.size,
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof PierProtocolError) throw error;
		fsError(error, path);
	}
}

/** Download a workspace file without relaxing its path boundary. */
export async function readWorkspaceBytes(
	workspaceRoot: string,
	path: string,
	offset: number,
	length: number,
): Promise<WorkspaceFileBytes> {
	const relPath = normalizeRelativePath(path);
	if (!relPath) throw new PierProtocolError("BAD_REQUEST", "Not a file: .");
	const root = await workspaceRealRoot(workspaceRoot);
	const real = await resolveInside(root, relPath, "file");
	return readFileBytes(real, relPath, offset, length);
}

/** Download a Markdown file reference, checking allowed roots or its confirmed target per chunk. */
export async function readPreviewBytes(
	workspaceRoot: string,
	path: string,
	offset: number,
	length: number,
	expectedRealPath?: string,
): Promise<WorkspaceFileBytes> {
	const { root, real } = await resolvePreviewPath(workspaceRoot, path);
	if (expectedRealPath !== undefined && real !== expectedRealPath) {
		throw new PierProtocolError("CONFLICT", "Preview target changed; confirm the current path again", {
			reason: "PREVIEW_TARGET_CHANGED",
		});
	}
	if (expectedRealPath === undefined) await requirePreviewRoot(root, real, path);
	return readFileBytes(real, path, offset, length);
}

/**
 * Read one file of a workspace for preview. The file must resolve (after symlinks) to a
 * regular file inside the workspace root. UTF-8 text is returned up to
 * {@link MAX_TEXT_PREVIEW_BYTES}; common image formats are returned base64-encoded up to
 * {@link MAX_IMAGE_PREVIEW_BYTES}; anything else is reported as `binary` without content.
 */
export async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<WorkspaceFileContent> {
	const relPath = normalizeRelativePath(path);
	if (!relPath) throw new PierProtocolError("BAD_REQUEST", "Not a file: .");
	const root = await workspaceRealRoot(workspaceRoot);
	const real = await resolveInside(root, relPath, "file");
	return readPreviewFile(real, relPath);
}

/**
 * Preview a file referenced in Markdown. Relative paths stay in the workspace; absolute
 * paths may also point into the host's temporary directories (where agents save screenshots).
 * This does not relax the workspace's write or directory-listing operations.
 */
export async function previewWorkspaceFile(workspaceRoot: string, path: string): Promise<WorkspaceFileContent> {
	const { root, real } = await resolvePreviewPath(workspaceRoot, path);
	await requirePreviewRoot(root, real, path);
	return readPreviewFile(real, path);
}

async function requirePreviewRoot(root: string, real: string, path: string): Promise<void> {
	if (!isInside(root, real)) {
		const directories = process.platform === "win32" ? [tmpdir()] : [tmpdir(), "/tmp", "/var/tmp"];
		const temporaryRoots = await Promise.all(directories.map((dir) => realPath(dir).catch(() => undefined)));
		if (!isAbsolute(path) || !temporaryRoots.some((dir) => dir && isInside(dir, real))) {
			throw new PierProtocolError("FORBIDDEN", "Preview path is outside the workspace and temporary directories", {
				reason: "OUTSIDE_ALLOWED_ROOTS",
				resolvedPath: real,
			});
		}
	}
}

/** One bounded read of the exact target confirmed by the user; stores no permission. */
export async function authorizeWorkspaceFilePreview(
	workspaceRoot: string,
	path: string,
	expectedRealPath: string,
): Promise<WorkspaceFileContent> {
	const { real } = await resolvePreviewPath(workspaceRoot, path);
	if (real !== expectedRealPath) {
		throw new PierProtocolError("CONFLICT", "Preview target changed; confirm the current path again", {
			reason: "PREVIEW_TARGET_CHANGED",
		});
	}
	return readPreviewFile(real, path);
}

async function resolvePreviewPath(workspaceRoot: string, path: string): Promise<{ root: string; real: string }> {
	if (!path || path.includes("\0") || path.startsWith("//") || path.startsWith("\\\\")) {
		throw new PierProtocolError("BAD_REQUEST", "Invalid preview path");
	}
	if (!isAbsolute(path) && /^[a-zA-Z][\w+.-]*:/.test(path)) {
		throw new PierProtocolError("BAD_REQUEST", "Preview path must be a local file path");
	}
	const root = await workspaceRealRoot(workspaceRoot);
	let real: string;
	try {
		real = await realPath(resolve(root, path));
	} catch (error) {
		fsError(error, path);
	}
	return { root, real };
}

async function readPreviewFile(real: string, relPath: string): Promise<WorkspaceFileContent> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(real);
	} catch (error) {
		fsError(error, relPath);
	}
	if (!info.isFile()) throw new PierProtocolError("BAD_REQUEST", `Not a file: ${relPath}`);
	const base = { path: relPath, size: info.size, modifiedAt: info.mtime.toISOString() };
	const mimeType = IMAGE_TYPES[extname(relPath).toLowerCase()];
	try {
		if (mimeType) {
			if (info.size > MAX_IMAGE_PREVIEW_BYTES) return { ...base, kind: "image", mimeType, tooLarge: true };
			const bytes = await readHead(real, MAX_IMAGE_PREVIEW_BYTES + 1);
			if (bytes.length > MAX_IMAGE_PREVIEW_BYTES) return { ...base, kind: "image", mimeType, tooLarge: true };
			return { ...base, size: bytes.length, kind: "image", mimeType, data: bytes.toString("base64") };
		}
		const bytes = await readHead(real, MAX_TEXT_PREVIEW_BYTES + 1);
		const truncated = bytes.length > MAX_TEXT_PREVIEW_BYTES;
		const text = decodeText(truncated ? bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES) : bytes, truncated);
		if (text === undefined) return { ...base, kind: "binary" };
		return { ...base, kind: "text", text, ...(truncated ? { truncated: true } : {}) };
	} catch (error) {
		fsError(error, relPath);
	}
}
