import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PierClient } from "@pier/client";
import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalPath,
	GitService,
	parseBranches,
	parseLog,
	parsePorcelainStatus,
	parseWorktrees,
} from "../src/git.ts";
import { startTestHost, type TestHost } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function initRepo(dir: string): void {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Pier Test");
	git(dir, "config", "user.email", "pier@example.com");
	git(dir, "config", "commit.gpgsign", "false");
	// Windows runners default to core.autocrlf=true, which would check files out with CRLF.
	git(dir, "config", "core.autocrlf", "false");
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(PierProtocolError);
	expect((error as PierProtocolError).code).toBe(code);
}

describe("git output parsing", () => {
	it("parses porcelain v2 status", () => {
		const output = [
			"# branch.oid 0123456789abcdef0123456789abcdef01234567",
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 aaa bbb src/a file.ts",
			"1 A. N... 000000 100644 100644 000 ccc new.ts",
			"2 R. N... 100644 100644 100644 ddd ddd R100 renamed.ts",
			"old.ts",
			"u UU N... 100644 100644 100644 100644 e1 e2 e3 conflict.ts",
			"? untracked.txt",
			"",
		].join("\0");
		expect(parsePorcelainStatus(output)).toEqual({
			head: "0123456789abcdef0123456789abcdef01234567",
			branch: "main",
			upstream: "origin/main",
			ahead: 2,
			behind: 1,
			files: [
				{ path: "src/a file.ts", index: ".", worktree: "M" },
				{ path: "new.ts", index: "A", worktree: "." },
				{ path: "renamed.ts", origPath: "old.ts", index: "R", worktree: "." },
				{ path: "conflict.ts", index: "U", worktree: "U", conflict: true },
				{ path: "untracked.txt", index: "?", worktree: "?" },
			],
		});
	});

	it("leaves out the initial commit and a detached head", () => {
		const status = parsePorcelainStatus("# branch.oid (initial)\0# branch.head (detached)\0");
		expect(status.head).toBeUndefined();
		expect(status.branch).toBeUndefined();
		expect(status.files).toEqual([]);
	});

	it("parses log records and branch lists", () => {
		const log = parseLog(
			"\x1e\nabc123\x1fabc\x1fp1 p2\x1fAda\x1fada@example.com\x1f2026-01-01T00:00:00+00:00\x1fHEAD -> main\x1fSubject\x1e\n",
		);
		expect(log).toEqual([
			{
				hash: "abc123",
				shortHash: "abc",
				parents: ["p1", "p2"],
				authorName: "Ada",
				authorEmail: "ada@example.com",
				date: "2026-01-01T00:00:00+00:00",
				refs: "HEAD -> main",
				subject: "Subject",
			},
		]);
		const branches = parseBranches(
			[
				"refs/heads/main\x1fmain\x1forigin/main\x1f[ahead 1, behind 3]\x1fabc\x1f2026\x1f*\x1fTip",
				"refs/heads/old\x1fold\x1forigin/old\x1f[gone]\x1fdef\x1f2025\x1f \x1fOld",
				"refs/remotes/origin/HEAD\x1forigin\x1f\x1f\x1fabc\x1f2026\x1f \x1fTip",
				"refs/remotes/origin/main\x1forigin/main\x1f\x1f\x1fabc\x1f2026\x1f \x1fTip",
			].join("\n"),
		);
		expect(branches).toEqual([
			{
				name: "main",
				remote: false,
				current: true,
				upstream: "origin/main",
				ahead: 1,
				behind: 3,
				shortHash: "abc",
				subject: "Tip",
				date: "2026",
			},
			{
				name: "old",
				remote: false,
				upstream: "origin/old",
				upstreamGone: true,
				shortHash: "def",
				subject: "Old",
				date: "2025",
			},
			{ name: "origin/main", remote: true, shortHash: "abc", subject: "Tip", date: "2026" },
		]);
	});
});

describe("git worktree parsing", () => {
	it("parses porcelain work tree lists", () => {
		const output = [
			"worktree /src/repo",
			"HEAD 0123456789abcdef0123456789abcdef01234567",
			"branch refs/heads/main",
			"",
			"worktree /src/repo-feature",
			"HEAD 0123456789abcdef0123456789abcdef01234567",
			"branch refs/heads/feature/x",
			"locked keep it",
			"",
			"worktree /src/gone",
			"HEAD 0123456789abcdef0123456789abcdef01234567",
			"detached",
			"prunable gitdir file points to non-existent location",
			"",
			"worktree /src/empty",
			"HEAD 0000000000000000000000000000000000000000",
			"branch refs/heads/unborn",
			"locked",
			"",
		].join("\n");
		expect(parseWorktrees(output)).toEqual([
			{ path: "/src/repo", head: "0123456789abcdef0123456789abcdef01234567", branch: "main", main: true },
			{
				path: "/src/repo-feature",
				head: "0123456789abcdef0123456789abcdef01234567",
				branch: "feature/x",
				locked: true,
				lockReason: "keep it",
			},
			{
				path: "/src/gone",
				head: "0123456789abcdef0123456789abcdef01234567",
				detached: true,
				prunable: true,
				prunableReason: "gitdir file points to non-existent location",
			},
			{ path: "/src/empty", branch: "unborn", locked: true },
		]);
		expect(parseWorktrees("worktree /src/bare.git\nbare\n")).toEqual([
			{ path: "/src/bare.git", bare: true, main: true },
		]);
	});
});

describe("GitService", () => {
	let root: string;
	let repo: string;
	const service = new GitService();

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-git-"));
		repo = join(root, "repo");
		mkdirSync(repo);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reports a directory outside any repository and can initialize one", async () => {
		expect(await service.status(repo)).toEqual({ repository: false });
		await service.init(repo);
		const status = await service.status(repo);
		expect(status).toMatchObject({ repository: true, prefix: "", files: [], remotes: [] });
		expect(status.head).toBeUndefined();
		await expectCode(service.init(repo), "CONFLICT");
		expect((await service.log(repo)).commits).toEqual([]);
	});

	it("stages, unstages, commits and lists history", async () => {
		initRepo(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir", "b c.txt"), "two\n");
		let status = await service.status(repo);
		expect(status.branch).toBe("main");
		expect(status.files?.map((f) => [f.path, f.index, f.worktree])).toEqual([
			["a.txt", "?", "?"],
			["dir/b c.txt", "?", "?"],
		]);

		// Before the first commit, unstaging drops paths from the index.
		await service.stage(repo, ["a.txt"]);
		await service.unstage(repo, ["a.txt"]);
		expect((await service.status(repo)).files?.find((f) => f.path === "a.txt")?.index).toBe("?");
		await service.stage(repo);
		await service.unstage(repo);
		expect((await service.status(repo)).files?.every((f) => f.index === "?")).toBe(true);

		await service.stage(repo);
		await expectCode(service.commit(repo, "   "), "BAD_REQUEST");
		const first = await service.commit(repo, "First commit\n\nBody");
		expect(first.hash).toMatch(/^[0-9a-f]{40}$/);
		status = await service.status(repo);
		expect(status.head).toBe(first.hash);
		expect(status.files).toEqual([]);

		writeFileSync(join(repo, "a.txt"), "one\nmore\n");
		expect((await service.diff(repo, "a.txt", false)).diff).toContain("+more");
		expect((await service.diff(repo, "a.txt", true)).diff).toBe("");
		await service.stage(repo, ["a.txt"]);
		expect((await service.diff(repo, "a.txt", true)).diff).toContain("+more");
		await service.unstage(repo, ["a.txt"]);
		expect((await service.status(repo)).files).toEqual([{ path: "a.txt", index: ".", worktree: "M" }]);

		const second = await service.commit(repo, "Second", false, true);
		const log = await service.log(repo);
		expect(log.commits.map((c) => c.subject)).toEqual(["Second", "First commit"]);
		expect(log.commits[0]).toMatchObject({ hash: second.hash, authorName: "Pier Test", parents: [first.hash] });
		expect((await service.log(repo, 1, 1)).commits.map((c) => c.subject)).toEqual(["First commit"]);

		const amended = await service.commit(repo, "Second, amended", true);
		expect(amended.hash).not.toBe(second.hash);
		expect((await service.log(repo)).commits.map((c) => c.subject)).toEqual(["Second, amended", "First commit"]);
		// Amending without a message keeps the old one.
		await service.commit(repo, "", true);
		expect((await service.log(repo, 1)).commits[0]?.subject).toBe("Second, amended");

		const shown = await service.show(repo, amended.hash.slice(0, 10));
		expect(shown.diff).toContain("Second, amended");
		expect(shown.diff).toContain("+more");
		await expectCode(service.show(repo, "deadbeefdeadbeef"), "NOT_FOUND");
	});

	it("diffs untracked files and discards changes", async () => {
		initRepo(repo);
		writeFileSync(join(repo, "tracked.txt"), "keep\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
		writeFileSync(join(repo, "tracked.txt"), "changed\n");
		writeFileSync(join(repo, "[n]ew.txt"), "glob-looking name\n");
		writeFileSync(join(repo, "new.txt"), "brand new\n");

		expect((await service.diff(repo, "new.txt", false)).diff).toContain("+brand new");
		// Paths are literal: discarding "[n]ew.txt" (a valid name on Windows too) must not touch "new.txt".
		await service.discard(repo, ["[n]ew.txt"]);
		expect(existsSync(join(repo, "[n]ew.txt"))).toBe(false);
		expect(existsSync(join(repo, "new.txt"))).toBe(true);
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("changed\n");

		await service.discard(repo, ["tracked.txt", "new.txt", "not-changed.txt"]);
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("keep\n");
		expect(existsSync(join(repo, "new.txt"))).toBe(false);
		await expectCode(service.discard(repo, ["../outside"]), "BAD_REQUEST");
	});

	it("diffs a staged rename as one file", async () => {
		initRepo(repo);
		writeFileSync(join(repo, "old.txt"), "same content\nline 2\nline 3\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
		git(repo, "mv", "old.txt", "new.txt");
		const status = await service.status(repo);
		expect(status.files).toEqual([{ path: "new.txt", origPath: "old.txt", index: "R", worktree: "." }]);
		const { diff } = await service.diff(repo, "new.txt", true, "old.txt");
		expect(diff).toContain("rename from old.txt");
		await service.unstage(repo, ["new.txt", "old.txt"]);
		expect((await service.status(repo)).files?.map((f) => [f.path, f.index, f.worktree])).toEqual([
			["old.txt", ".", "D"],
			["new.txt", "?", "?"],
		]);
	});

	it("creates, switches and deletes branches, and stashes", async () => {
		initRepo(repo);
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
		await service.checkout(repo, "feature/x", true);
		expect((await service.status(repo)).branch).toBe("feature/x");
		await expectCode(service.checkout(repo, "bad..name", true), "BAD_REQUEST");
		await expectCode(service.checkout(repo, "missing"), "NOT_FOUND");
		await service.checkout(repo, "main");
		const { branches } = await service.branches(repo);
		expect(branches.map((b) => [b.name, b.remote, b.current ?? false]).sort()).toEqual([
			["feature/x", false, false],
			["main", false, true],
		]);
		await service.deleteBranch(repo, "feature/x");
		expect((await service.branches(repo)).branches.map((b) => b.name)).toEqual(["main"]);

		writeFileSync(join(repo, "a.txt"), "changed\n");
		writeFileSync(join(repo, "u.txt"), "untracked\n");
		await service.stash(repo, "push", "wip");
		expect((await service.status(repo)).files).toEqual([]);
		await service.stash(repo, "pop");
		expect((await service.status(repo)).files?.map((f) => f.path).sort()).toEqual(["a.txt", "u.txt"]);
	});

	it("pushes a new branch to origin, tracks it and pulls", async () => {
		const remote = join(root, "remote.git");
		git(root, "init", "-q", "--bare", "-b", "main", remote);
		initRepo(repo);
		git(repo, "remote", "add", "origin", remote);
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
		await service.push(repo);
		let status = await service.status(repo);
		expect(status).toMatchObject({ upstream: "origin/main", ahead: 0, behind: 0, remotes: ["origin"] });

		const other = join(root, "other");
		git(root, "clone", "-q", remote, other);
		initRepo(other);
		writeFileSync(join(other, "b.txt"), "b\n");
		git(other, "add", ".");
		git(other, "commit", "-q", "-m", "from other");
		git(other, "push", "-q");

		await service.fetch(repo);
		status = await service.status(repo);
		expect(status.behind).toBe(1);
		await service.pull(repo);
		expect(existsSync(join(repo, "b.txt"))).toBe(true);

		// Switching to a remote-tracking branch creates the local branch.
		git(other, "switch", "-q", "-c", "topic");
		git(other, "push", "-q", "-u", "origin", "topic");
		await service.fetch(repo);
		await service.checkout(repo, "origin/topic");
		expect((await service.status(repo)).upstream).toBe("origin/topic");
	});

	it("adds, lists and removes work trees", async () => {
		initRepo(repo);
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
		// Git prints real paths (`/private/var` on macOS, long names and `/` on Windows).
		const base = canonicalPath(root);
		const feature = join(base, "wt", "feature");
		const added = await service.addWorktree(repo, feature, { branch: "feature/x", create: true });
		expect(added).toMatchObject({ path: feature, branch: "feature/x" });
		expect(readFileSync(join(feature, "a.txt"), "utf8")).toBe("a\n");

		// An existing branch, a detached HEAD and a remote-tracking branch.
		git(repo, "branch", "topic");
		const topic = join(base, "wt", "topic");
		expect(await service.addWorktree(repo, topic, { branch: "topic" })).toMatchObject({ branch: "topic" });
		const detached = join(base, "wt", "detached");
		const result = await service.addWorktree(repo, detached);
		expect(result.branch).toBeUndefined();
		await expectCode(service.addWorktree(repo, join(base, "wt", "again"), { branch: "topic" }), "CONFLICT");
		await expectCode(service.addWorktree(repo, join(base, "wt", "none"), { branch: "nope" }), "NOT_FOUND");
		await expectCode(service.addWorktree(repo, "relative/path", { branch: "x", create: true }), "BAD_REQUEST");
		await expectCode(service.addWorktree(repo, join(base, "wt", "bad"), { create: true }), "BAD_REQUEST");

		const { worktrees: listed } = await service.worktrees(repo);
		const worktrees = [listed[0], ...listed.slice(1)]
			.filter((w) => w !== undefined)
			.map((w) => ({ ...w, path: canonicalPath(w.path) }));
		worktrees.splice(1, worktrees.length, ...worktrees.slice(1).sort((x, y) => x.path.localeCompare(y.path)));
		expect(worktrees.map((w) => [w.path, w.branch ?? null, !!w.main, !!w.current])).toEqual([
			[canonicalPath(repo), "main", true, true],
			[detached, null, false, false],
			[feature, "feature/x", false, false],
			[topic, "topic", false, false],
		]);
		expect(worktrees[1]?.detached).toBe(true);
		// From inside a linked work tree, it is the current one.
		const inside = (await service.worktrees(feature)).worktrees;
		expect(canonicalPath(inside.find((w) => w.current)?.path ?? "")).toBe(feature);

		await expectCode(service.removeWorktree(repo, repo), "CONFLICT");
		await expectCode(service.removeWorktree(feature, feature), "CONFLICT");
		await expectCode(service.removeWorktree(repo, join(base, "elsewhere")), "NOT_FOUND");

		// Changes keep a work tree unless forced; a locked one needs force.
		writeFileSync(join(topic, "new.txt"), "x\n");
		await expectCode(service.removeWorktree(repo, topic), "CONFLICT");
		await service.removeWorktree(repo, topic, true);
		expect(existsSync(topic)).toBe(false);
		git(repo, "worktree", "lock", detached);
		await expectCode(service.removeWorktree(repo, detached), "CONFLICT");
		await service.removeWorktree(repo, detached, true);
		// A path through a link names the same work tree (a junction needs no privilege on Windows).
		const link = join(base, "link");
		symlinkSync(join(base, "wt"), link, "junction");
		await service.removeWorktree(repo, join(link, "feature"));
		expect(existsSync(feature)).toBe(false);

		// A work tree whose directory went away is pruned.
		const gone = join(base, "wt", "gone");
		await service.addWorktree(repo, gone, { branch: "gone", create: true });
		rmSync(gone, { recursive: true, force: true });
		const before = (await service.worktrees(repo)).worktrees;
		expect(before.find((w) => canonicalPath(w.path) === gone)?.prunable).toBe(true);
		await service.pruneWorktrees(repo);
		const after = (await service.worktrees(repo)).worktrees;
		expect(after.map((w) => canonicalPath(w.path))).toEqual([canonicalPath(repo)]);
	});

	it("checks out a remote-tracking branch in a new work tree", async () => {
		const remote = join(root, "remote.git");
		git(root, "init", "-q", "--bare", "-b", "main", remote);
		initRepo(repo);
		git(repo, "commit", "-q", "--allow-empty", "-m", "init");
		git(repo, "remote", "add", "origin", remote);
		git(repo, "push", "-q", "origin", "main:main", "main:topic");
		git(repo, "fetch", "-q", "origin");
		const dir = join(canonicalPath(root), "topic");
		expect(await service.addWorktree(repo, dir, { branch: "origin/topic" })).toMatchObject({ branch: "topic" });
		expect((await service.status(dir)).upstream).toBe("origin/topic");
	});

	it("uses the enclosing repository for a workspace in a subdirectory", async () => {
		initRepo(repo);
		mkdirSync(join(repo, "pkg"));
		writeFileSync(join(repo, "pkg", "x.txt"), "x\n");
		const status = await service.status(join(repo, "pkg"));
		expect(status).toMatchObject({ repository: true, prefix: "pkg" });
		expect(status.files?.map((f) => f.path)).toEqual(["pkg/x.txt"]);
	});
});

describe("git.* methods", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost();
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	it("initializes a repository, commits and reads it back", async () => {
		expect(await client.request("git.status", { workspaceId: workspace.id })).toEqual({ repository: false });
		await expectCode(client.request("git.log", { workspaceId: workspace.id }), "NOT_FOUND");
		await client.request("git.init", { workspaceId: workspace.id });
		git(t.workspaceDir, "config", "user.name", "Pier Test");
		git(t.workspaceDir, "config", "user.email", "pier@example.com");
		git(t.workspaceDir, "config", "commit.gpgsign", "false");
		writeFileSync(join(t.workspaceDir, "readme.md"), "# Hi\n");
		await client.request("git.stage", { workspaceId: workspace.id, paths: ["readme.md"] });
		const commit = await client.request("git.commit", { workspaceId: workspace.id, message: "Add readme" });
		const { commits } = await client.request("git.log", { workspaceId: workspace.id });
		expect(commits).toMatchObject([{ hash: commit.hash, subject: "Add readme" }]);
		await expectCode(
			client.request("git.stage", { workspaceId: workspace.id, paths: ["../etc/passwd"] }),
			"BAD_REQUEST",
		);
		await expectCode(client.request("git.checkout", { workspaceId: workspace.id, branch: "--orphan" }), "BAD_REQUEST");
		await expectCode(client.request("git.status", { workspaceId: "nope" }), "NOT_FOUND");
	});

	it("manages work trees and names their workspaces", async () => {
		initRepo(t.workspaceDir);
		git(t.workspaceDir, "commit", "-q", "--allow-empty", "-m", "init");
		const dir = join(canonicalPath(mkdtempSync(join(tmpdir(), "pier-wt-"))), "feature");
		try {
			const added = await client.request("git.addWorktree", {
				workspaceId: workspace.id,
				path: dir,
				branch: "feature",
				create: true,
			});
			expect(added).toMatchObject({ path: dir, branch: "feature" });
			const other = (await client.request("workspace.add", { path: dir })).workspace;
			const { worktrees } = await client.request("git.worktrees", { workspaceId: workspace.id });
			expect(worktrees.map((w) => w.workspaceId)).toEqual([workspace.id, other.id]);
			await expectCode(
				client.request("git.addWorktree", { workspaceId: workspace.id, path: `${dir}-2`, create: true }),
				"BAD_REQUEST",
			);
			await expectCode(client.request("git.removeWorktree", { workspaceId: other.id, path: dir }), "CONFLICT");
			await client.request("git.removeWorktree", { workspaceId: workspace.id, path: dir });
			expect(existsSync(dir)).toBe(false);
			await client.request("git.pruneWorktrees", { workspaceId: workspace.id });
		} finally {
			rmSync(dirname(dir), { recursive: true, force: true });
		}
	});
});
