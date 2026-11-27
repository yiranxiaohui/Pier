import { describe, expect, it } from "vitest";
import {
	type FilesLocation,
	locationBreadcrumbs,
	locationDirectory,
	locationForPath,
	locationKey,
	locationParent,
	normalizeAbsolutePath,
	panelPasteSource,
	parentDirectory,
	resolveTypedPath,
	typedPathNeedsHome,
	WORKSPACE_ROOT,
} from "../src/lib/files-location.ts";
import { type HostClipboard, hostClipboardOfWorkspace, isCutInDirectory } from "../src/lib/host-files.ts";
import type { WorkspaceClipboardState } from "../src/lib/workspace-clipboard.ts";

const ws = "/home/me/projects/Pier";
const win = "C:\\Users\\me\\Pier";

describe("absolute paths", () => {
	it("normalizes POSIX, Windows and UNC paths", () => {
		expect(normalizeAbsolutePath("/home//me/./projects/../docs/")).toBe("/home/me/docs");
		expect(normalizeAbsolutePath("/..")).toBe("/");
		expect(normalizeAbsolutePath("C:/Users\\me\\..\\Public")).toBe("C:\\Users\\Public");
		expect(normalizeAbsolutePath("d:")).toBe("d:\\");
		expect(normalizeAbsolutePath("\\\\server\\share\\a\\..\\b")).toBe("\\\\server\\share\\b");
		expect(normalizeAbsolutePath("relative/path")).toBeUndefined();
		expect(normalizeAbsolutePath("C:relative")).toBeUndefined();
	});

	it("keeps backslashes in POSIX names", () => {
		expect(normalizeAbsolutePath("/tmp/a\\b")).toBe("/tmp/a\\b");
	});

	it("finds parents up to the filesystem root", () => {
		expect(parentDirectory("/home/me")).toBe("/home");
		expect(parentDirectory("/home")).toBe("/");
		expect(parentDirectory("/")).toBeUndefined();
		expect(parentDirectory("C:\\Users")).toBe("C:\\");
		expect(parentDirectory("C:\\")).toBeUndefined();
		expect(parentDirectory("\\\\server\\share\\dir")).toBe("\\\\server\\share\\");
		expect(parentDirectory("\\\\server\\share")).toBeUndefined();
	});
});

describe("panel locations", () => {
	it("maps directories inside the workspace to workspace folders", () => {
		expect(locationForPath(ws, ws)).toEqual(WORKSPACE_ROOT);
		expect(locationForPath(ws, `${ws}/apps/desktop/`)).toEqual({ kind: "workspace", dir: "apps/desktop" });
		expect(locationForPath(ws, "/home/me/projects/Pier-2")).toEqual({
			kind: "host",
			directory: "/home/me/projects/Pier-2",
		});
		expect(locationForPath(ws, "/home/me/projects")).toEqual({ kind: "host", directory: "/home/me/projects" });
	});

	it("compares Windows paths without case and with either separator", () => {
		expect(locationForPath(win, "c:/users/ME/pier/src")).toEqual({ kind: "workspace", dir: "src" });
		expect(locationForPath(win, "C:\\Users\\me")).toEqual({ kind: "host", directory: "C:\\Users\\me" });
		expect(locationDirectory(win, { kind: "workspace", dir: "src/lib" })).toBe("C:\\Users\\me\\Pier\\src\\lib");
	});

	it("goes up through workspace folders, then above the workspace", () => {
		const steps: FilesLocation[] = [];
		let location: FilesLocation | undefined = { kind: "workspace", dir: "apps/desktop" };
		while (location) {
			steps.push(location);
			location = locationParent(ws, location);
		}
		expect(steps).toEqual([
			{ kind: "workspace", dir: "apps/desktop" },
			{ kind: "workspace", dir: "apps" },
			WORKSPACE_ROOT,
			{ kind: "host", directory: "/home/me/projects" },
			{ kind: "host", directory: "/home/me" },
			{ kind: "host", directory: "/home" },
			{ kind: "host", directory: "/" },
		]);
	});

	it("keys locations by kind and folder", () => {
		expect(locationKey(WORKSPACE_ROOT)).not.toBe(locationKey({ kind: "host", directory: "" }));
		expect(locationKey({ kind: "workspace", dir: "a" })).toBe("workspace:a");
	});

	it("lists breadcrumbs from the root and marks the workspace root", () => {
		const crumbs = locationBreadcrumbs(ws, { kind: "workspace", dir: "apps" });
		expect(crumbs.map((crumb) => crumb.label)).toEqual(["/", "home", "me", "projects", "Pier", "apps"]);
		expect(crumbs.map((crumb) => crumb.workspaceRoot)).toEqual([false, false, false, false, true, false]);
		expect(crumbs[3]?.location).toEqual({ kind: "host", directory: "/home/me/projects" });
		expect(crumbs[5]?.location).toEqual({ kind: "workspace", dir: "apps" });
		expect(locationBreadcrumbs(win, WORKSPACE_ROOT).map((crumb) => [crumb.label, crumb.path])).toEqual([
			["C:", "C:\\"],
			["Users", "C:\\Users"],
			["me", "C:\\Users\\me"],
			["Pier", "C:\\Users\\me\\Pier"],
		]);
	});
});

describe("typed paths", () => {
	it("resolves absolute, relative, quoted and home paths", () => {
		expect(resolveTypedPath("/etc/", ws)).toBe("/etc");
		expect(resolveTypedPath("../docs", ws)).toBe("/home/me/projects/docs");
		expect(resolveTypedPath("apps/desktop", ws)).toBe(`${ws}/apps/desktop`);
		expect(resolveTypedPath(' "/tmp/with space" ', ws)).toBe("/tmp/with space");
		expect(resolveTypedPath("..\\Public", "C:\\Users\\me")).toBe("C:\\Users\\Public");
		expect(resolveTypedPath("~", ws, "/home/me")).toBe("/home/me");
		expect(resolveTypedPath("~/Downloads", ws, "/home/me")).toBe("/home/me/Downloads");
		expect(resolveTypedPath("~/Downloads", ws)).toBeUndefined();
		expect(resolveTypedPath("   ", ws)).toBeUndefined();
	});

	it("knows which inputs need the home directory", () => {
		expect(typedPathNeedsHome("~")).toBe(true);
		expect(typedPathNeedsHome(" '~/x' ")).toBe(true);
		expect(typedPathNeedsHome("~user")).toBe(false);
		expect(typedPathNeedsHome("/home/~")).toBe(false);
	});
});

describe("pasting in the panel", () => {
	const workspaceClipboard: WorkspaceClipboardState = {
		mode: "move",
		sourceWorkspaceId: "w1",
		entries: [{ path: "src/a.ts", name: "a.ts", kind: "file" }],
	};
	const hostClipboard: HostClipboard = {
		mode: "copy",
		scope: { kind: "host", node: "local", directory: "/home/me" },
		entries: [{ path: "notes.md", name: "notes.md", kind: "file" }],
	};
	const workspaceOf = (id: string) =>
		id === "w1" ? { node: "local", path: ws } : id === "w2" ? { node: "peer", path: "/srv/w2" } : undefined;
	const outside: FilesLocation = { kind: "host", directory: "/tmp" };

	it("prefers the workspace clipboard inside a workspace and the host clipboard outside", () => {
		const both = { node: "local", manageHost: true, workspaceClipboard, hostClipboard, workspaceOf };
		expect(panelPasteSource({ ...both, location: WORKSPACE_ROOT })).toEqual({
			kind: "workspace",
			clipboard: workspaceClipboard,
		});
		expect(panelPasteSource({ ...both, location: outside })).toEqual({ kind: "host", clipboard: hostClipboard });
	});

	it("pastes host entries into a workspace of the same computer", () => {
		const options = { node: "local", workspaceClipboard: undefined, hostClipboard, workspaceOf };
		expect(panelPasteSource({ ...options, location: WORKSPACE_ROOT, manageHost: true })?.kind).toBe("host");
		expect(panelPasteSource({ ...options, location: WORKSPACE_ROOT, manageHost: false })).toBeUndefined();
		expect(panelPasteSource({ ...options, node: "peer", location: WORKSPACE_ROOT, manageHost: true })).toBeUndefined();
	});

	it("pastes workspace entries outside the workspace through host paths", () => {
		const options = { location: outside, manageHost: true, workspaceClipboard, hostClipboard: undefined, workspaceOf };
		expect(panelPasteSource({ ...options, node: "local" })).toEqual({
			kind: "host",
			clipboard: {
				mode: "move",
				scope: { kind: "host", node: "local", directory: ws },
				entries: workspaceClipboard.entries,
			},
			fromWorkspace: workspaceClipboard,
		});
		// Another computer's workspace, or an old Host, cannot be pasted outside workspaces.
		expect(panelPasteSource({ ...options, node: "peer" })).toBeUndefined();
		expect(panelPasteSource({ ...options, node: "local", manageHost: false })).toBeUndefined();
		const unknown = { ...workspaceClipboard, sourceWorkspaceId: "gone" };
		expect(panelPasteSource({ ...options, node: "local", workspaceClipboard: unknown })).toBeUndefined();
	});

	it("converts workspace entries without sharing them", () => {
		const converted = hostClipboardOfWorkspace(workspaceClipboard, "local", ws);
		expect(converted.entries).toEqual(workspaceClipboard.entries);
		expect(converted.entries[0]).not.toBe(workspaceClipboard.entries[0]);
	});

	it("dims cut entries and their contents only in their own directory", () => {
		const cut: HostClipboard = {
			mode: "move",
			scope: { kind: "host", node: "local", directory: "/tmp" },
			entries: [{ path: "build", name: "build", kind: "directory" }],
		};
		expect(isCutInDirectory(cut, "local", "/tmp", "build")).toBe(true);
		expect(isCutInDirectory(cut, "local", "/tmp", "build/out.js")).toBe(true);
		expect(isCutInDirectory(cut, "local", "/tmp", "builder")).toBe(false);
		expect(isCutInDirectory(cut, "local", "/var", "build")).toBe(false);
		expect(isCutInDirectory(cut, "peer", "/tmp", "build")).toBe(false);
		expect(isCutInDirectory({ ...cut, mode: "copy" }, "local", "/tmp", "build")).toBe(false);
	});
});
