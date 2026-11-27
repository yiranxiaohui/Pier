/**
 * Where the right-hand panel's file tree is rooted: the workspace (or one of its folders), or any
 * other directory of the workspace's computer (`host.*` methods, protocol 1.57). Paths of the
 * computer are absolute in its own style: POSIX (`/home/me`) or Windows (`C:\Users\me`,
 * `\\server\share`).
 */
import { joinPath } from "./format.ts";
import { type HostClipboard, hostClipboardOfWorkspace } from "./host-files.ts";
import type { WorkspaceClipboardState } from "./workspace-clipboard.ts";

export type FilesLocation =
	/** A folder of the workspace, relative to its root and joined with "/" (`""` for the root). */
	| { kind: "workspace"; dir: string }
	/** An absolute directory outside the workspace. */
	| { kind: "host"; directory: string };

export const WORKSPACE_ROOT: FilesLocation = { kind: "workspace", dir: "" };

interface ParsedPath {
	/** `/`, `C:\` or `\\server\share\`. */
	root: string;
	segments: string[];
	windows: boolean;
}

/** Split an absolute path into its root and segments, resolving `.`, `..` and repeated separators. */
function parseAbsolute(path: string): ParsedPath | undefined {
	let root: string;
	let rest: string;
	let windows = true;
	const drive = /^([a-zA-Z]):(?:[\\/]|$)/.exec(path);
	const unc = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/.exec(path);
	if (drive) {
		root = `${drive[1]}:\\`;
		rest = path.slice(2);
	} else if (unc) {
		root = `\\\\${unc[1]}\\${unc[2]}\\`;
		rest = path.slice(unc[0].length);
	} else if (path.startsWith("/")) {
		root = "/";
		rest = path;
		windows = false;
	} else return undefined;
	const segments: string[] = [];
	for (const part of rest.split(windows ? /[\\/]+/ : /\/+/)) {
		if (!part || part === ".") continue;
		if (part === "..") segments.pop();
		else segments.push(part);
	}
	return { root, segments, windows };
}

function format(parsed: Pick<ParsedPath, "root" | "windows">, segments: readonly string[]): string {
	return parsed.root + segments.join(parsed.windows ? "\\" : "/");
}

function sameName(a: string, b: string, windows: boolean): boolean {
	return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The absolute path, normalized; undefined when it is not absolute. */
export function normalizeAbsolutePath(path: string): string | undefined {
	const parsed = parseAbsolute(path.trim());
	return parsed && format(parsed, parsed.segments);
}

/** The parent of an absolute directory; undefined at a filesystem root. */
export function parentDirectory(path: string): string | undefined {
	const parsed = parseAbsolute(path);
	if (!parsed?.segments.length) return undefined;
	return format(parsed, parsed.segments.slice(0, -1));
}

/** The workspace location of an absolute directory inside the workspace, else a host location. */
export function locationForPath(workspacePath: string, absolute: string): FilesLocation {
	const target = parseAbsolute(absolute);
	const root = parseAbsolute(workspacePath);
	if (!target) return { kind: "host", directory: absolute };
	if (
		root &&
		target.windows === root.windows &&
		sameName(target.root, root.root, root.windows) &&
		target.segments.length >= root.segments.length &&
		root.segments.every((name, i) => sameName(name, target.segments[i] ?? "", root.windows))
	) {
		return { kind: "workspace", dir: target.segments.slice(root.segments.length).join("/") };
	}
	return { kind: "host", directory: format(target, target.segments) };
}

/** The absolute directory a location shows. */
export function locationDirectory(workspacePath: string, location: FilesLocation): string {
	return location.kind === "host" ? location.directory : joinPath(workspacePath, location.dir);
}

/** The location one level up; undefined at a filesystem root. */
export function locationParent(workspacePath: string, location: FilesLocation): FilesLocation | undefined {
	if (location.kind === "workspace" && location.dir) {
		const slash = location.dir.lastIndexOf("/");
		return { kind: "workspace", dir: slash < 0 ? "" : location.dir.slice(0, slash) };
	}
	const parent = parentDirectory(locationDirectory(workspacePath, location));
	return parent === undefined ? undefined : locationForPath(workspacePath, parent);
}

/** Identifies a location, e.g. to remount the tree when it changes. */
export function locationKey(location: FilesLocation): string {
	return location.kind === "workspace" ? `workspace:${location.dir}` : `host:${location.directory}`;
}

export function isWorkspaceRoot(location: FilesLocation): boolean {
	return location.kind === "workspace" && !location.dir;
}

export interface Breadcrumb {
	label: string;
	/** The absolute directory. */
	path: string;
	location: FilesLocation;
	/** The workspace's root folder. */
	workspaceRoot: boolean;
}

/** The directories from the filesystem root down to the shown one. */
export function locationBreadcrumbs(workspacePath: string, location: FilesLocation): Breadcrumb[] {
	const absolute = locationDirectory(workspacePath, location);
	const parsed = parseAbsolute(absolute);
	if (!parsed) return [{ label: absolute, path: absolute, location, workspaceRoot: isWorkspaceRoot(location) }];
	const rootLabel = parsed.windows ? parsed.root.replace(/\\$/, "") : "/";
	return [rootLabel, ...parsed.segments].map((label, index) => {
		const path = format(parsed, parsed.segments.slice(0, index));
		const crumb = locationForPath(workspacePath, path);
		return { label, path, location: crumb, workspaceRoot: isWorkspaceRoot(crumb) };
	});
}

/**
 * A path typed into the panel's address field: absolute, or relative to `base` (the shown
 * directory). `~` and `~/…` start at `home` when given. Quotes around a pasted path are dropped.
 * Undefined when nothing usable was typed.
 */
export function resolveTypedPath(input: string, base: string, home?: string): string | undefined {
	let text = input.trim();
	if (text.length > 1 && /^(["']).*\1$/.test(text)) text = text.slice(1, -1).trim();
	if (!text) return undefined;
	if (text === "~" || /^~[\\/]/.test(text)) {
		if (home === undefined) return undefined;
		text = text.length > 1 ? joinPath(home, text.slice(2)) : home;
	}
	const absolute = normalizeAbsolutePath(text);
	if (absolute !== undefined) return absolute;
	return normalizeAbsolutePath(joinPath(base, text));
}

/** Whether `input` starts at the home directory (`~`), which needs the host's answer first. */
export function typedPathNeedsHome(input: string): boolean {
	const text = input
		.trim()
		.replace(/^(["'])(.*)\1$/, "$2")
		.trim();
	return text === "~" || /^~[\\/]/.test(text);
}

/**
 * What a paste in the panel inserts. `workspace` pastes the workspace clipboard with workspace
 * methods (also between computers); `host` copies or moves on the panel's computer with
 * `host.transferPath`, from the host clipboard or from workspace entries (`fromWorkspace`).
 */
export type PanelPasteSource =
	| { kind: "workspace"; clipboard: WorkspaceClipboardState }
	| { kind: "host"; clipboard: HostClipboard; fromWorkspace?: WorkspaceClipboardState };

/**
 * The clipboard a paste at `location` uses. Inside a workspace the workspace clipboard comes
 * first; outside, the host clipboard. Either can be pasted on the other side when both are on
 * the panel's computer and its Pier manages host files (`manageHost`, protocol 1.58).
 */
export function panelPasteSource(options: {
	location: FilesLocation;
	node: string;
	manageHost: boolean;
	workspaceClipboard: WorkspaceClipboardState | undefined;
	hostClipboard: HostClipboard | undefined;
	/** The computer and root folder of a workspace. */
	workspaceOf: (workspaceId: string) => { node: string; path: string } | undefined;
}): PanelPasteSource | undefined {
	const { location, node, manageHost, workspaceClipboard, hostClipboard } = options;
	const host =
		manageHost && hostClipboard?.scope.kind === "host" && hostClipboard.scope.node === node ? hostClipboard : undefined;
	if (location.kind === "workspace") {
		if (workspaceClipboard) return { kind: "workspace", clipboard: workspaceClipboard };
		return host && { kind: "host", clipboard: host };
	}
	if (host) return { kind: "host", clipboard: host };
	if (!workspaceClipboard || !manageHost) return undefined;
	const source = options.workspaceOf(workspaceClipboard.sourceWorkspaceId);
	if (source?.node !== node) return undefined;
	return {
		kind: "host",
		clipboard: hostClipboardOfWorkspace(workspaceClipboard, node, source.path),
		fromWorkspace: workspaceClipboard,
	};
}
