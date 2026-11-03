import { describe, expect, it } from "vitest";
import {
	baseName,
	changePaths,
	groupChanges,
	suggestWorktreePath,
	workspacePath,
	worktreeLocalBranch,
} from "../src/lib/git.ts";
import { diffStats, parseGitDiff } from "../src/lib/git-diff.ts";

describe("groupChanges", () => {
	it("sorts paths into conflicts, staged and unstaged changes", () => {
		const groups = groupChanges([
			{ path: "both.ts", index: "M", worktree: "M" },
			{ path: "staged.ts", index: "A", worktree: "." },
			{ path: "new.ts", origPath: "old.ts", index: "R", worktree: "." },
			{ path: "conflict.ts", index: "U", worktree: "U", conflict: true },
			{ path: "untracked.ts", index: "?", worktree: "?" },
			{ path: "gone.ts", index: ".", worktree: "D" },
		]);
		expect(groups.conflict.map((c) => [c.file.path, c.letter])).toEqual([["conflict.ts", "!"]]);
		expect(groups.staged.map((c) => [c.file.path, c.letter])).toEqual([
			["both.ts", "M"],
			["staged.ts", "A"],
			["new.ts", "R"],
		]);
		expect(groups.changes.map((c) => [c.file.path, c.letter])).toEqual([
			["both.ts", "M"],
			["untracked.ts", "U"],
			["gone.ts", "D"],
		]);
		// Unstaging a rename also unstages the deletion of its old path.
		expect(changePaths(groups.staged)).toEqual(["both.ts", "staged.ts", "new.ts", "old.ts"]);
		expect(changePaths(groups.changes)).toEqual(["both.ts", "untracked.ts", "gone.ts"]);
	});

	it("maps repository paths into a workspace in a subdirectory", () => {
		expect(workspacePath("src/a.ts", "")).toBe("src/a.ts");
		expect(workspacePath("src/a.ts", undefined)).toBe("src/a.ts");
		expect(workspacePath("pkg/src/a.ts", "pkg")).toBe("src/a.ts");
		expect(workspacePath("pkg2/a.ts", "pkg")).toBeUndefined();
	});
});

describe("parseGitDiff", () => {
	it("numbers lines of a unified diff and drops file headers", () => {
		const rows = parseGitDiff(
			[
				"diff --git a/src/a.ts b/src/a.ts",
				"index 111..222 100644",
				"--- a/src/a.ts",
				"+++ b/src/a.ts",
				"@@ -1,3 +1,3 @@ function f() {",
				" keep",
				"-old",
				"+new",
				"",
				"\\ No newline at end of file",
				"",
			].join("\n"),
		);
		expect(rows).toEqual([
			{ kind: "file", text: "src/a.ts" },
			{ kind: "hunk", text: "@@ -1,3 +1,3 @@ function f() {" },
			{ kind: "ctx", text: "keep", oldLine: 1, newLine: 1 },
			{ kind: "del", text: "old", oldLine: 2 },
			{ kind: "add", text: "new", newLine: 2 },
			{ kind: "ctx", text: "", oldLine: 3, newLine: 3 },
			{ kind: "meta", text: "\\ No newline at end of file" },
		]);
		expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
	});

	it("keeps commit headers and handles combined diffs", () => {
		const rows = parseGitDiff(
			[
				"commit abc",
				"Author: Ada <ada@example.com>",
				"",
				"    Subject",
				"diff --cc file.txt",
				"index 1,2..3",
				"@@@ -1,1 -1,1 +1,2 @@@",
				"++<<<<<<< HEAD",
				" -theirs",
				"  same",
			].join("\n"),
		);
		expect(rows.map((r) => r.kind)).toEqual(["meta", "meta", "meta", "meta", "file", "hunk", "add", "del", "ctx"]);
		expect(rows[4]?.text).toBe("file.txt");
		expect(rows[6]).toEqual({ kind: "add", text: "<<<<<<< HEAD", newLine: 1 });
		expect(rows[8]).toEqual({ kind: "ctx", text: "same", oldLine: 2, newLine: 2 });
	});

	it("reads paths with spaces from diff --git headers", () => {
		expect(parseGitDiff("diff --git a/my file.txt b/my file.txt\nnew file mode 100644\n")).toEqual([
			{ kind: "file", text: "my file.txt" },
			{ kind: "meta", text: "new file mode 100644" },
		]);
	});
});

describe("work tree helpers", () => {
	it("suggests a directory next to the main work tree", () => {
		expect(suggestWorktreePath("/home/me/projects/app", "feature/login")).toBe(
			"/home/me/projects/app-worktrees/feature-login",
		);
		expect(suggestWorktreePath("C:/src/app", "fix")).toBe("C:/src/app-worktrees/fix");
		expect(suggestWorktreePath("C:\\src\\app", "fix")).toBe("C:\\src\\app-worktrees\\fix");
		expect(suggestWorktreePath("/app", "")).toBe("/app-worktrees/worktree");
	});

	it("names the local branch and the last path segment", () => {
		expect(worktreeLocalBranch("origin/feature/x", ["origin"], true)).toBe("feature/x");
		expect(worktreeLocalBranch("up/stream/x", ["up", "up/stream"], true)).toBe("x");
		expect(worktreeLocalBranch("feature/x", ["origin"], false)).toBe("feature/x");
		expect(baseName("/a/b/")).toBe("b");
		expect(baseName("C:\\a\\b")).toBe("b");
	});
});
