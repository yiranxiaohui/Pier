import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostFileTarget } from "../src/host-files.ts";
import { keepDriveRoot, realPath, realPathSync } from "../src/real-path.ts";
import { listWorkspaceDirectory, workspaceRealRoot } from "../src/workspace-files.ts";

/** `realpath` answers set per path, or Bun's answers for every path. */
const bun = vi.hoisted(() => ({ results: new Map<string, string>(), dropRootSeparator: false }));

/** Bun's `realpath` drops a trailing separator, which only a drive root (`C:\`) still has. */
function likeBun(real: string): string {
	return bun.dropRootSeparator && real.endsWith("\\") ? real.slice(0, -1) : real;
}

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fs, realpath: async (path: string) => bun.results.get(path) ?? likeBun(await fs.realpath(path)) };
});

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const realpathSync = (path: string) => bun.results.get(path) ?? likeBun(fs.realpathSync(path));
	return { ...fs, realpathSync: Object.assign(realpathSync, { native: fs.realpathSync.native }) };
});

afterEach(() => {
	bun.results.clear();
	bun.dropRootSeparator = false;
});

describe("realpath of a Windows drive root", () => {
	it("puts the separator back on a bare drive", () => {
		expect(keepDriveRoot("C:")).toBe("C:\\");
		expect(keepDriveRoot("d:")).toBe("d:\\");
		expect(keepDriveRoot("C:\\")).toBe("C:\\");
		expect(keepDriveRoot("C:\\Users")).toBe("C:\\Users");
		expect(keepDriveRoot("/")).toBe("/");
		expect(keepDriveRoot("/home/C:")).toBe("/home/C:");
		expect(keepDriveRoot("\\\\server\\share")).toBe("\\\\server\\share");
	});

	it("keeps the root a root in the workspace file functions", async () => {
		bun.results.set("C:\\", "C:");
		await expect(realPath("C:\\")).resolves.toBe("C:\\");
		expect(realPathSync("C:\\")).toBe("C:\\");
		await expect(workspaceRealRoot("C:\\")).resolves.toBe("C:\\");
	});

	// Reproduces the host file manager on Windows: Bun's realpath turned the drive root into the
	// drive's current directory, so every folder of it resolved "outside the workspace".
	it.runIf(process.platform === "win32")("lists a folder of the drive and the drive root itself", async () => {
		bun.dropRootSeparator = true;
		const folder = mkdtempSync(join(tmpdir(), "pier-drive-root-"));
		const inner = join(folder, "inner");
		mkdirSync(inner);
		const previous = process.cwd();
		// The drive's current directory is a folder below the listed one, not the root.
		process.chdir(inner);
		try {
			const target = hostFileTarget(folder);
			const listing = await listWorkspaceDirectory(target.root, target.path);
			expect(listing.entries.map((entry) => entry.name)).toEqual(["inner"]);

			const top = relative(target.root, folder).split(sep)[0]?.toLowerCase();
			const root = hostFileTarget(target.root);
			const rootListing = await listWorkspaceDirectory(root.root, root.path);
			expect(rootListing.entries.map((entry) => entry.name.toLowerCase())).toContain(top);
		} finally {
			process.chdir(previous);
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
