import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	type GitBranchInfo,
	type GitCommandResult,
	type GitCommitInfo,
	type GitCommitResult,
	type GitDiffResult,
	type GitFileStatus,
	type GitOperation,
	type GitStatus,
	type GitWorktreeAddResult,
	type GitWorktreeInfo,
	PierProtocolError,
} from "@pier/protocol";
import { findExecutable } from "./runtimes/executable.ts";
import { normalizeRelativePath } from "./workspace-files.ts";

/** Most changed paths `git.status` returns. */
export const MAX_STATUS_FILES = 5000;
/** Longest diff `git.diff` / `git.show` returns, in bytes. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** Longest command output returned to clients, in characters. */
const MAX_OUTPUT_CHARS = 8000;

/** For commands whose output is parsed or matched. */
const C_LOCALE = { LC_ALL: "C", LANGUAGE: "C" };
/** For commands given user paths: match them literally, never as globs. */
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };

const LOCAL_TIMEOUT_MS = 60_000;
/** Commits run hooks, and network commands wait for the remote. */
const LONG_TIMEOUT_MS = 5 * 60_000;

interface RunOptions {
	cwd: string;
	input?: string;
	timeoutMs?: number;
	/** Bytes of stdout kept; the rest is dropped and `truncated` is set. */
	maxBytes?: number;
	/** Exit codes that are not errors (besides 0). */
	okCodes?: number[];
	env?: Record<string, string>;
}

interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
	truncated: boolean;
}

/** Variables that would point Git at another repository than the workspace's. */
const REPOSITORY_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
];

function inheritedEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of REPOSITORY_VARIABLES) delete env[name];
	return env;
}

function clip(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > MAX_OUTPUT_CHARS ? `…${trimmed.slice(-MAX_OUTPUT_CHARS)}` : trimmed;
}

/** Git's messages for a command that failed, without its `hint:` lines. */
function failureMessage(result: RunResult): string {
	const text = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.filter((line) => !line.startsWith("hint:"))
		.join("\n");
	return clip(text) || `git exited with code ${result.code}`;
}

/** NUL-separated pathspecs for `--pathspec-from-file=- --pathspec-file-nul`. */
function pathspecInput(paths: string[]): string {
	return paths.map((p) => `${p}\0`).join("");
}

function parseCount(value: string | undefined): number {
	const n = Number(value);
	return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parsePorcelainStatus(output: string): Omit<GitStatus, "repository" | "root" | "prefix" | "remotes"> {
	const status: Omit<GitStatus, "repository" | "root" | "prefix" | "remotes"> = {};
	const files: GitFileStatus[] = [];
	const tokens = output.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (!token) continue;
		if (token.startsWith("# ")) {
			const [, key, ...rest] = token.split(" ");
			const value = rest.join(" ");
			if (key === "branch.oid" && value !== "(initial)") status.head = value;
			else if (key === "branch.head" && value !== "(detached)") status.branch = value;
			else if (key === "branch.upstream") status.upstream = value;
			else if (key === "branch.ab") {
				const [ahead, behind] = value.split(" ");
				status.ahead = parseCount(ahead);
				status.behind = parseCount(behind);
			}
			continue;
		}
		const fields = token.split(" ");
		const kind = fields[0];
		let file: GitFileStatus | undefined;
		if (kind === "1" || kind === "2" || kind === "u") {
			const xy = fields[1] ?? "..";
			const pathStart = kind === "1" ? 8 : kind === "2" ? 9 : 10;
			file = { path: fields.slice(pathStart).join(" "), index: xy[0] ?? ".", worktree: xy[1] ?? "." };
			if (kind === "2") {
				const orig = tokens[++i];
				if (orig) file.origPath = orig;
			}
			if (kind === "u") file.conflict = true;
			if (fields[2]?.startsWith("S")) file.submodule = true;
		} else if (kind === "?") {
			file = { path: token.slice(2), index: "?", worktree: "?" };
		}
		if (file) files.push(file);
	}
	if (files.length > MAX_STATUS_FILES) {
		status.files = files.slice(0, MAX_STATUS_FILES);
		status.truncated = true;
	} else status.files = files;
	return status;
}

const RECORD = "\x1e";
const FIELD = "\x1f";

export function parseLog(output: string): GitCommitInfo[] {
	const commits: GitCommitInfo[] = [];
	for (const record of output.split(RECORD)) {
		const text = record.replace(/^\n/, "");
		if (!text) continue;
		const [hash, shortHash, parents, authorName, authorEmail, date, refs, subject] = text.split(FIELD);
		if (!hash || !shortHash) continue;
		commits.push({
			hash,
			shortHash,
			subject: subject ?? "",
			authorName: authorName ?? "",
			authorEmail: authorEmail ?? "",
			date: date ?? "",
			...(refs ? { refs } : {}),
			parents: parents ? parents.split(" ").filter(Boolean) : [],
		});
	}
	return commits;
}

/** Parse `git for-each-ref` output in the `branches` format (run with `LC_ALL=C`). */
export function parseBranches(output: string): GitBranchInfo[] {
	const branches: GitBranchInfo[] = [];
	for (const line of output.split("\n")) {
		if (!line) continue;
		const [refname, name, upstream, track, shortHash, date, head, subject] = line.split(FIELD);
		if (!refname || !name) continue;
		const remote = refname.startsWith("refs/remotes/");
		// `origin/HEAD` is an alias of a real remote branch.
		if (remote && refname.endsWith("/HEAD")) continue;
		const branch: GitBranchInfo = {
			name,
			remote,
			shortHash: shortHash ?? "",
			subject: subject ?? "",
			date: date ?? "",
		};
		if (head === "*") branch.current = true;
		if (upstream) branch.upstream = upstream;
		if (track?.includes("gone")) branch.upstreamGone = true;
		const ahead = /ahead (\d+)/.exec(track ?? "");
		const behind = /behind (\d+)/.exec(track ?? "");
		if (ahead) branch.ahead = Number(ahead[1]);
		if (behind) branch.behind = Number(behind[1]);
		branches.push(branch);
	}
	return branches;
}

interface Repository {
	root: string;
	prefix: string;
}

/** Parse `git worktree list --porcelain` output (run with `LC_ALL=C`); the main work tree is first. */
export function parseWorktrees(output: string): GitWorktreeInfo[] {
	const worktrees: GitWorktreeInfo[] = [];
	let current: GitWorktreeInfo | undefined;
	for (const line of output.replace(/\r/g, "").split("\n")) {
		if (!line) {
			current = undefined;
			continue;
		}
		const space = line.indexOf(" ");
		const key = space < 0 ? line : line.slice(0, space);
		const value = space < 0 ? "" : line.slice(space + 1);
		if (key === "worktree") {
			current = { path: value };
			if (!worktrees.length) current.main = true;
			worktrees.push(current);
			continue;
		}
		if (!current) continue;
		if (key === "HEAD") {
			if (!/^0+$/.test(value)) current.head = value;
		} else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
		else if (key === "detached") current.detached = true;
		else if (key === "bare") current.bare = true;
		else if (key === "locked") {
			current.locked = true;
			if (value) current.lockReason = value;
		} else if (key === "prunable") {
			current.prunable = true;
			if (value) current.prunableReason = value;
		}
	}
	return worktrees;
}

/** Compare paths the way the file system of this computer does. */
export function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		const resolved = resolve(p);
		return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
	};
	return norm(a) === norm(b);
}

/**
 * Git source control for workspaces (`git.*`, 1.28). Every command runs the `git` CLI with
 * arguments (never a shell) in the root of the repository the workspace is in, without a
 * terminal so credential and host-key prompts fail instead of waiting. Commands that change
 * a repository run one at a time per repository.
 */
export class GitService {
	private executable: string | null | undefined;
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(private readonly gitPath: string | undefined = process.env.PIER_GIT) {}

	private git(): string | undefined {
		if (this.executable === undefined) this.executable = findExecutable("git", this.gitPath) ?? null;
		return this.executable ?? undefined;
	}

	private requireGit(): string {
		const git = this.git();
		if (!git) {
			// Look again next time: the user may install Git while Pier runs.
			this.executable = undefined;
			throw new PierProtocolError("UNSUPPORTED", "Git is not installed on this computer");
		}
		return git;
	}

	private run(args: string[], options: RunOptions): Promise<RunResult> {
		const git = this.requireGit();
		const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
		return new Promise((resolvePromise, reject) => {
			const child = spawn(git, args, {
				cwd: options.cwd,
				env: {
					...inheritedEnv(),
					GIT_TERMINAL_PROMPT: "0",
					GIT_MERGE_AUTOEDIT: "no",
					GCM_INTERACTIVE: "never",
					...options.env,
				},
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				// A new session has no controlling terminal, so ssh cannot prompt on it.
				detached: process.platform !== "win32",
			});
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let outBytes = 0;
			let errBytes = 0;
			let truncated = false;
			child.stdout.on("data", (chunk: Buffer) => {
				if (outBytes >= maxBytes) {
					truncated = true;
					return;
				}
				const room = maxBytes - outBytes;
				if (chunk.length > room) truncated = true;
				const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
				out.push(kept);
				outBytes += kept.length;
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (errBytes > 256 * 1024) return;
				err.push(chunk);
				errBytes += chunk.length;
			});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, options.timeoutMs ?? LOCAL_TIMEOUT_MS);
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (timedOut) {
					reject(new PierProtocolError("CONFLICT", `git ${args[0]} took too long and was stopped`));
					return;
				}
				resolvePromise({
					stdout: Buffer.concat(out).toString("utf8"),
					stderr: Buffer.concat(err).toString("utf8"),
					code: code ?? 1,
					truncated,
				});
			});
			child.stdin.on("error", () => {
				// The command exited without reading its input; its exit code tells what happened.
			});
			child.stdin.end(options.input ?? "");
		});
	}

	/** Run git and throw `CONFLICT` with Git's message when it fails. */
	private async exec(args: string[], options: RunOptions): Promise<RunResult> {
		const result = await this.run(args, options);
		if (result.code !== 0 && !options.okCodes?.includes(result.code)) {
			throw new PierProtocolError("CONFLICT", failureMessage(result), { exitCode: result.code });
		}
		return result;
	}

	/** The repository a workspace is in, or undefined when it is not in a work tree. */
	private async repository(workspaceRoot: string): Promise<Repository | undefined> {
		if (!existsSync(workspaceRoot)) {
			throw new PierProtocolError("NOT_FOUND", `Workspace directory is missing: ${workspaceRoot}`);
		}
		const result = await this.run(["rev-parse", "--show-toplevel", "--show-prefix"], {
			cwd: workspaceRoot,
			env: C_LOCALE,
		});
		if (result.code !== 0) {
			if (/not a git repository|not a work tree/i.test(result.stderr)) return undefined;
			if (/must be run in a work tree/i.test(result.stderr)) return undefined;
			throw new PierProtocolError("CONFLICT", failureMessage(result), { exitCode: result.code });
		}
		const [root, prefix = ""] = result.stdout.replace(/\r/g, "").split("\n");
		if (!root) return undefined;
		return { root, prefix: prefix.replace(/\/$/, "") };
	}

	private async requireRepository(workspaceRoot: string): Promise<Repository> {
		const repo = await this.repository(workspaceRoot);
		if (!repo) throw new PierProtocolError("NOT_FOUND", "The workspace is not in a Git repository");
		return repo;
	}

	/** Run `fn` after every earlier change of the same repository finished. */
	private exclusive<T>(root: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(root) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(root, settled);
		void settled.then(() => {
			if (this.queues.get(root) === settled) this.queues.delete(root);
		});
		return next;
	}

	private async change(
		workspaceRoot: string,
		fn: (repo: Repository) => Promise<GitCommandResult>,
	): Promise<GitCommandResult> {
		const repo = await this.requireRepository(workspaceRoot);
		return this.exclusive(repo.root, () => fn(repo));
	}

	private async hasHead(root: string): Promise<boolean> {
		const result = await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root });
		return result.code === 0;
	}

	private async operation(root: string): Promise<GitOperation | undefined> {
		const names: Array<[string, GitOperation]> = [
			["rebase-merge", "rebase"],
			["rebase-apply", "rebase"],
			["MERGE_HEAD", "merge"],
			["CHERRY_PICK_HEAD", "cherry-pick"],
			["REVERT_HEAD", "revert"],
			["BISECT_LOG", "bisect"],
		];
		const result = await this.run(["rev-parse", ...names.flatMap(([name]) => ["--git-path", name])], { cwd: root });
		if (result.code !== 0) return undefined;
		const paths = result.stdout.replace(/\r/g, "").split("\n");
		for (const [index, [, operation]] of names.entries()) {
			const path = paths[index];
			if (path && existsSync(isAbsolute(path) ? path : resolve(root, path))) return operation;
		}
		return undefined;
	}

	private async remotes(root: string): Promise<string[]> {
		const result = await this.run(["remote"], { cwd: root });
		return result.code === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
	}

	private async rawStatus(root: string) {
		const result = await this.exec(
			["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
			{ cwd: root },
		);
		return parsePorcelainStatus(result.stdout);
	}

	async status(workspaceRoot: string): Promise<GitStatus> {
		if (!this.git()) {
			this.executable = undefined;
			return { repository: false, gitMissing: true };
		}
		const repo = await this.repository(workspaceRoot);
		if (!repo) return { repository: false };
		const [status, operation, remotes] = await Promise.all([
			this.rawStatus(repo.root),
			this.operation(repo.root),
			this.remotes(repo.root),
		]);
		return {
			repository: true,
			root: repo.root,
			prefix: repo.prefix,
			...status,
			remotes,
			...(operation ? { operation } : {}),
		};
	}

	async diff(workspaceRoot: string, path: string, staged: boolean, origPath?: string): Promise<GitDiffResult> {
		const repo = await this.requireRepository(workspaceRoot);
		const rel = normalizeRelativePath(path);
		if (!rel) throw new PierProtocolError("BAD_REQUEST", "Path is required");
		const orig = origPath ? normalizeRelativePath(origPath) : undefined;
		const base = ["diff", "--no-color", "--no-ext-diff", "--find-renames"];
		const paths = orig && orig !== rel ? [orig, rel] : [rel];
		const result = await this.exec([...base, ...(staged ? ["--cached"] : []), "--", ...paths], {
			cwd: repo.root,
			env: LITERAL,
			maxBytes: MAX_DIFF_BYTES,
		});
		if (result.stdout || staged) return { diff: result.stdout, ...(result.truncated ? { truncated: true } : {}) };
		// Untracked files have no diff against the index: show them as entirely added.
		const listed = await this.exec(["ls-files", "--others", "--exclude-standard", "-z", "--", rel], {
			cwd: repo.root,
			env: LITERAL,
		});
		if (!listed.stdout.split("\0").includes(rel)) return { diff: "" };
		const untracked = await this.exec(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", rel], {
			cwd: repo.root,
			maxBytes: MAX_DIFF_BYTES,
			okCodes: [1],
		});
		return { diff: untracked.stdout, ...(untracked.truncated ? { truncated: true } : {}) };
	}

	async log(workspaceRoot: string, limit = 50, skip = 0): Promise<{ commits: GitCommitInfo[] }> {
		const repo = await this.requireRepository(workspaceRoot);
		if (!(await this.hasHead(repo.root))) return { commits: [] };
		const format = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%D", "%s"].join("%x1f");
		const result = await this.exec(
			["log", `--max-count=${limit}`, `--skip=${skip}`, `--format=${format}%x1e`, "HEAD", "--"],
			{ cwd: repo.root },
		);
		return { commits: parseLog(result.stdout) };
	}

	async show(workspaceRoot: string, commit: string): Promise<GitDiffResult> {
		const repo = await this.requireRepository(workspaceRoot);
		if (!/^[0-9a-fA-F]{4,64}$/.test(commit)) throw new PierProtocolError("BAD_REQUEST", "Invalid commit");
		const found = await this.run(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd: repo.root });
		const hash = found.stdout.trim();
		if (found.code !== 0 || !hash) throw new PierProtocolError("NOT_FOUND", `No such commit: ${commit}`);
		const result = await this.exec(
			["show", "--no-color", "--no-ext-diff", "--stat", "--patch", "--format=fuller", hash, "--"],
			{ cwd: repo.root, maxBytes: MAX_DIFF_BYTES },
		);
		return { diff: result.stdout, ...(result.truncated ? { truncated: true } : {}) };
	}

	async branches(workspaceRoot: string): Promise<{ branches: GitBranchInfo[] }> {
		const repo = await this.requireRepository(workspaceRoot);
		const format = [
			"%(refname)",
			"%(refname:short)",
			"%(upstream:short)",
			"%(upstream:track)",
			"%(objectname:short)",
			"%(committerdate:iso-strict)",
			"%(HEAD)",
			"%(contents:subject)",
		].join("%1f");
		const result = await this.exec(
			["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads", "refs/remotes"],
			// `upstream:track` is translated; read it in English.
			{ cwd: repo.root, env: C_LOCALE },
		);
		return { branches: parseBranches(result.stdout) };
	}

	private validPaths(paths: string[]): string[] {
		const out = new Set<string>();
		for (const path of paths) {
			const rel = normalizeRelativePath(path);
			if (!rel) throw new PierProtocolError("BAD_REQUEST", "Paths must name files in the repository");
			out.add(rel);
		}
		return [...out];
	}

	async stage(workspaceRoot: string, paths?: string[]): Promise<GitCommandResult> {
		const list = paths ? this.validPaths(paths) : undefined;
		return this.change(workspaceRoot, async ({ root }) => {
			const result = list
				? await this.exec(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
						cwd: root,
						input: pathspecInput(list),
						env: LITERAL,
					})
				: await this.exec(["add", "-A"], { cwd: root });
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async unstage(workspaceRoot: string, paths?: string[]): Promise<GitCommandResult> {
		const list = paths ? this.validPaths(paths) : undefined;
		return this.change(workspaceRoot, async ({ root }) => {
			const head = await this.hasHead(root);
			let result: RunResult;
			if (head) {
				result = list
					? await this.exec(["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"], {
							cwd: root,
							input: pathspecInput(list),
							env: LITERAL,
						})
					: await this.exec(["reset", "-q", "HEAD"], { cwd: root });
			} else {
				// Before the first commit there is no HEAD to reset to: drop the paths from the index.
				result = list
					? await this.exec(
							["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
							{ cwd: root, input: pathspecInput(list), env: LITERAL },
						)
					: await this.exec(["read-tree", "--empty"], { cwd: root });
			}
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async discard(workspaceRoot: string, paths: string[]): Promise<GitCommandResult> {
		const list = this.validPaths(paths);
		return this.change(workspaceRoot, async ({ root }) => {
			const { files = [] } = await this.rawStatus(root);
			const byPath = new Map(files.map((f) => [f.path, f]));
			const untracked: string[] = [];
			const tracked: string[] = [];
			for (const path of list) {
				const file = byPath.get(path);
				if (!file) continue;
				if (file.index === "?") untracked.push(path);
				else if (file.worktree !== ".") tracked.push(path);
			}
			const output: string[] = [];
			if (tracked.length) {
				const result = await this.exec(["restore", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
					cwd: root,
					input: pathspecInput(tracked),
					env: LITERAL,
				});
				output.push(result.stdout + result.stderr);
			}
			for (let i = 0; i < untracked.length; i += 200) {
				const batch = untracked.slice(i, i + 200);
				const result = await this.exec(["clean", "-f", "-q", "--", ...batch], { cwd: root, env: LITERAL });
				output.push(result.stdout + result.stderr);
			}
			return { output: clip(output.join("\n")) };
		});
	}

	async commit(workspaceRoot: string, message: string, amend = false, all = false): Promise<GitCommitResult> {
		const text = message.trim();
		if (!text && !amend) throw new PierProtocolError("BAD_REQUEST", "Commit message is empty");
		const repo = await this.requireRepository(workspaceRoot);
		return this.exclusive(repo.root, async () => {
			const args = ["commit", ...(all ? ["-a"] : []), ...(amend ? ["--amend"] : [])];
			const result = await this.exec(text ? [...args, "-F", "-"] : [...args, "--no-edit"], {
				cwd: repo.root,
				input: text ? `${text}\n` : "",
				timeoutMs: LONG_TIMEOUT_MS,
			});
			const head = await this.exec(["rev-parse", "HEAD"], { cwd: repo.root });
			return { hash: head.stdout.trim(), output: clip(result.stdout + result.stderr) };
		});
	}

	private async refExists(root: string, ref: string): Promise<boolean> {
		const result = await this.run(["show-ref", "--verify", "--quiet", ref], { cwd: root });
		return result.code === 0;
	}

	private async checkBranchName(root: string, name: string): Promise<void> {
		if (name.startsWith("-")) throw new PierProtocolError("BAD_REQUEST", `Invalid branch name: ${name}`);
		const result = await this.run(["check-ref-format", "--branch", name], { cwd: root });
		if (result.code !== 0) throw new PierProtocolError("BAD_REQUEST", `Invalid branch name: ${name}`);
	}

	async checkout(
		workspaceRoot: string,
		branch: string,
		create = false,
		startPoint?: string,
	): Promise<GitCommandResult> {
		return this.change(workspaceRoot, async ({ root }) => {
			await this.checkBranchName(root, branch);
			let args: string[];
			if (create) {
				if (startPoint?.startsWith("-")) throw new PierProtocolError("BAD_REQUEST", "Invalid start point");
				args = ["switch", "-c", branch, ...(startPoint ? [startPoint] : [])];
			} else if (await this.refExists(root, `refs/heads/${branch}`)) {
				args = ["switch", branch];
			} else if (await this.refExists(root, `refs/remotes/${branch}`)) {
				const remotes = await this.remotes(root);
				const remote = remotes.filter((r) => branch.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
				const local = remote ? branch.slice(remote.length + 1) : branch.slice(branch.indexOf("/") + 1);
				args =
					local && (await this.refExists(root, `refs/heads/${local}`))
						? ["switch", local]
						: ["switch", "--track", branch];
			} else {
				throw new PierProtocolError("NOT_FOUND", `No such branch: ${branch}`);
			}
			const result = await this.exec(args, { cwd: root });
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async deleteBranch(workspaceRoot: string, branch: string, force = false): Promise<GitCommandResult> {
		return this.change(workspaceRoot, async ({ root }) => {
			await this.checkBranchName(root, branch);
			if (!(await this.refExists(root, `refs/heads/${branch}`))) {
				throw new PierProtocolError("NOT_FOUND", `No such branch: ${branch}`);
			}
			const result = await this.exec(["branch", force ? "-D" : "-d", branch], { cwd: root });
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async fetch(workspaceRoot: string): Promise<GitCommandResult> {
		return this.change(workspaceRoot, async ({ root }) => {
			const result = await this.exec(["fetch", "--all", "--prune"], { cwd: root, timeoutMs: LONG_TIMEOUT_MS });
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async pull(workspaceRoot: string, rebase = false): Promise<GitCommandResult> {
		return this.change(workspaceRoot, async ({ root }) => {
			const result = await this.exec(["pull", "--no-edit", ...(rebase ? ["--rebase"] : [])], {
				cwd: root,
				timeoutMs: LONG_TIMEOUT_MS,
			});
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async push(workspaceRoot: string, force = false): Promise<GitCommandResult> {
		return this.change(workspaceRoot, async ({ root }) => {
			const status = await this.rawStatus(root);
			if (!status.branch) throw new PierProtocolError("CONFLICT", "HEAD is detached; switch to a branch to push");
			const args = ["push", ...(force ? ["--force-with-lease"] : [])];
			if (!status.upstream) {
				const remotes = await this.remotes(root);
				const remote = remotes.includes("origin") ? "origin" : remotes[0];
				if (!remote) throw new PierProtocolError("CONFLICT", "The repository has no remote to push to");
				args.push("--set-upstream", remote, "HEAD");
			}
			const result = await this.exec(args, { cwd: root, timeoutMs: LONG_TIMEOUT_MS });
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async stash(workspaceRoot: string, action: "push" | "pop", message?: string): Promise<GitCommandResult> {
		return this.change(workspaceRoot, async ({ root }) => {
			const args =
				action === "push"
					? ["stash", "push", "--include-untracked", ...(message?.trim() ? ["-m", message.trim()] : [])]
					: ["stash", "pop"];
			const result = await this.exec(args, { cwd: root });
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async init(workspaceRoot: string): Promise<GitCommandResult> {
		if (await this.repository(workspaceRoot)) {
			throw new PierProtocolError("CONFLICT", "The workspace is already in a Git repository");
		}
		const result = await this.exec(["init"], { cwd: workspaceRoot });
		return { output: clip(result.stdout + result.stderr) };
	}

	/** The directory work trees of a repository share; changes of work trees are queued on it. */
	private async commonDir(root: string): Promise<string> {
		const result = await this.exec(["rev-parse", "--git-common-dir"], { cwd: root });
		return resolve(root, result.stdout.trim());
	}

	private async changeWorktrees<T>(workspaceRoot: string, fn: (repo: Repository) => Promise<T>): Promise<T> {
		const repo = await this.requireRepository(workspaceRoot);
		const common = await this.commonDir(repo.root);
		return this.exclusive(`worktrees:${common}`, () => fn(repo));
	}

	private async listWorktrees(repo: Repository): Promise<GitWorktreeInfo[]> {
		const result = await this.exec(["worktree", "list", "--porcelain"], { cwd: repo.root, env: C_LOCALE });
		const worktrees = parseWorktrees(result.stdout);
		for (const worktree of worktrees) {
			if (samePath(worktree.path, repo.root)) worktree.current = true;
		}
		return worktrees;
	}

	async worktrees(workspaceRoot: string): Promise<{ worktrees: GitWorktreeInfo[] }> {
		const repo = await this.requireRepository(workspaceRoot);
		return { worktrees: await this.listWorktrees(repo) };
	}

	async addWorktree(
		workspaceRoot: string,
		path: string,
		options: { branch?: string | undefined; create?: boolean | undefined; startPoint?: string | undefined } = {},
	): Promise<GitWorktreeAddResult> {
		const target = path.trim();
		if (!isAbsolute(target)) throw new PierProtocolError("BAD_REQUEST", "Work tree path must be absolute");
		const dir = resolve(target);
		const { branch, create = false, startPoint } = options;
		if (create && !branch) throw new PierProtocolError("BAD_REQUEST", "A new branch needs a name");
		if (startPoint?.startsWith("-")) throw new PierProtocolError("BAD_REQUEST", "Invalid start point");
		return this.changeWorktrees(workspaceRoot, async ({ root }) => {
			let args: string[];
			let checkedOut: string | undefined;
			if (branch) await this.checkBranchName(root, branch);
			if (!branch) {
				args = ["worktree", "add", "--detach", dir, ...(startPoint ? [startPoint] : [])];
			} else if (create) {
				args = ["worktree", "add", "-b", branch, dir, ...(startPoint ? [startPoint] : [])];
				checkedOut = branch;
			} else if (await this.refExists(root, `refs/heads/${branch}`)) {
				args = ["worktree", "add", dir, branch];
				checkedOut = branch;
			} else if (await this.refExists(root, `refs/remotes/${branch}`)) {
				const remotes = await this.remotes(root);
				const remote = remotes.filter((r) => branch.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
				const local = remote ? branch.slice(remote.length + 1) : branch.slice(branch.indexOf("/") + 1);
				if (!local) throw new PierProtocolError("BAD_REQUEST", `Invalid branch name: ${branch}`);
				args = (await this.refExists(root, `refs/heads/${local}`))
					? ["worktree", "add", dir, local]
					: ["worktree", "add", "--track", "-b", local, dir, branch];
				checkedOut = local;
			} else {
				throw new PierProtocolError("NOT_FOUND", `No such branch: ${branch}`);
			}
			// Checking out a large tree and its hooks can take a while.
			const result = await this.exec(args, { cwd: root, timeoutMs: LONG_TIMEOUT_MS });
			let real = dir;
			try {
				real = realpathSync(dir);
			} catch {
				// Git reported success; keep the requested path.
			}
			return { path: real, ...(checkedOut ? { branch: checkedOut } : {}), output: clip(result.stdout + result.stderr) };
		});
	}

	async removeWorktree(workspaceRoot: string, path: string, force = false): Promise<GitCommandResult> {
		return this.changeWorktrees(workspaceRoot, async (repo) => {
			const worktrees = await this.listWorktrees(repo);
			const worktree = worktrees.find((w) => samePath(w.path, path));
			if (!worktree) throw new PierProtocolError("NOT_FOUND", `Not a work tree of this repository: ${path}`);
			if (worktree.main) throw new PierProtocolError("CONFLICT", "The main work tree cannot be removed");
			if (worktree.current) {
				throw new PierProtocolError("CONFLICT", "The workspace is in this work tree; open another one to remove it");
			}
			// A locked work tree needs `--force` twice.
			const forceArgs = force ? (worktree.locked ? ["--force", "--force"] : ["--force"]) : [];
			const result = await this.exec(["worktree", "remove", ...forceArgs, worktree.path], { cwd: repo.root });
			return { output: clip(result.stdout + result.stderr) };
		});
	}

	async pruneWorktrees(workspaceRoot: string): Promise<GitCommandResult> {
		return this.changeWorktrees(workspaceRoot, async ({ root }) => {
			const result = await this.exec(["worktree", "prune", "--verbose"], { cwd: root });
			return { output: clip(result.stdout + result.stderr) };
		});
	}
}
