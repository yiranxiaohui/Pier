import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovalPolicy, ApprovalSeverity } from "@pier/protocol";

export type ApprovalVerdict =
	| { action: "allow"; reason: string }
	| {
			action: "ask";
			reason: string;
			severity: ApprovalSeverity;
			summary: string;
			/** Allowance key for "allow for this session"; absent when not offered. */
			sessionKey?: string;
			sessionScope?: string;
	  };

export interface ToolCallInput {
	toolName: string;
	input: Record<string, unknown>;
}

export interface EvaluateOptions {
	policy: ApprovalPolicy;
	/** Workspace root (the session cwd). */
	workspacePath: string;
	/** Allowance keys granted with "allow for this session". */
	allowances?: ReadonlySet<string>;
}

/** Tools that never mutate state and are always allowed. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Programs considered read-only for the `smart` policy (subject to per-program argument checks). */
export const READ_ONLY_PROGRAMS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"find",
	"fd",
	"pwd",
	"echo",
	"printf",
	"wc",
	"sort",
	"uniq",
	"cut",
	"tr",
	"diff",
	"cmp",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"which",
	"whereis",
	"type",
	"date",
	"uname",
	"whoami",
	"id",
	"hostname",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"jq",
	"true",
	"false",
	"test",
	"[",
	"cd",
	"nl",
	"column",
	"sha1sum",
	"sha256sum",
	"md5sum",
	"git",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"blame",
	"describe",
	"shortlog",
	"cat-file",
	"grep",
	"merge-base",
	"show-ref",
	"help",
	"version",
]);

const READ_ONLY_GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"]);

interface DangerousPattern {
	pattern: RegExp;
	reason: string;
}

/** Patterns that always require approval (even when the program is otherwise whitelisted). */
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
	{ pattern: /\brm\s+(-[a-z]*r[a-z]*|-[a-z]*R[a-z]*|--recursive)\b/i, reason: "recursive delete" },
	{ pattern: /\bsudo\b|\bdoas\b|(^|[;&|]\s*)su(\s|$)/, reason: "privilege escalation" },
	{ pattern: /\bgit\s+push\b.*(\s-f\b|--force)/, reason: "force push" },
	{ pattern: /\bgit\s+reset\s+.*--hard\b/, reason: "hard reset" },
	{ pattern: /\bgit\s+clean\b.*\s-[a-z]*f/, reason: "git clean" },
	{ pattern: /\bgit\s+branch\s+.*-D\b/, reason: "force branch delete" },
	{ pattern: /\bmkfs(\.\w+)?\b/, reason: "filesystem format" },
	{ pattern: /\bdd\s+.*\bof=/, reason: "raw disk write" },
	{ pattern: /\bchmod\s+(-R\s+)?[0-7]*777\b/, reason: "world-writable permissions" },
	{ pattern: /\bchown\s+-R\b/, reason: "recursive ownership change" },
	{ pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/, reason: "pipe download to shell" },
	{ pattern: />\s*\/dev\/(sd|nvme|hd|disk)/, reason: "raw device write" },
	{ pattern: /:\(\)\s*\{.*\};\s*:/, reason: "fork bomb" },
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "power management" },
	{ pattern: /\bsystemctl\s+(stop|disable|mask|kill|restart)\b/, reason: "service control" },
	{ pattern: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune))\b/, reason: "container data removal" },
	{ pattern: /\b(npm|pnpm|yarn|cargo)\s+publish\b/, reason: "package publish" },
	{ pattern: /\bkill(all)?\s+(-9\s+)?-?1\b/, reason: "kill all processes" },
];

export function findDangerousPattern(command: string): string | undefined {
	return DANGEROUS_PATTERNS.find((p) => p.pattern.test(command))?.reason;
}

export interface ShellAnalysis {
	/** Program names (basename of the first word) of each pipeline/list segment. */
	programs: string[];
	/** Whether every segment is a whitelisted read-only command without side effects. */
	readOnly: boolean;
	/** Why the command is not read-only, when it is not. */
	reason?: string;
}

/**
 * Split a shell command into words and segments, honoring quotes. This is a
 * conservative approximation of shell grammar: anything it does not understand
 * makes the command non-read-only.
 */
export function analyzeShellCommand(command: string): ShellAnalysis {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let hasWord = false;
	let quote: "'" | '"' | undefined;
	let unsafe: string | undefined;

	const endWord = () => {
		if (hasWord) words.push(word);
		word = "";
		hasWord = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		const next = command[i + 1];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else if (quote === '"' && (ch === "`" || (ch === "$" && next === "("))) {
				unsafe ??= "command substitution";
				word += ch;
			} else if (quote === '"' && ch === "\\" && next !== undefined) {
				word += next;
				i++;
			} else {
				word += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			hasWord = true;
			continue;
		}
		if (ch === "\\" && next !== undefined) {
			word += next;
			hasWord = true;
			i++;
			continue;
		}
		if (ch === "`" || (ch === "$" && next === "(") || ((ch === "<" || ch === ">") && next === "(")) {
			unsafe ??= "command substitution";
		}
		if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") {
			endSegment();
			if ((ch === "&" || ch === "|") && next === ch) i++;
			continue;
		}
		if (ch === "<") {
			// Input redirection only reads; the file name becomes an ordinary word.
			endWord();
			continue;
		}
		if (ch === ">") {
			// Allow harmless redirections: 2>&1, >&2, >/dev/null, 2>>/dev/null.
			const fdOnly = !hasWord || /^\d$/.test(word);
			let j = i + 1;
			if (command[j] === ">") j++;
			const dup = /^&\d+/.exec(command.slice(j));
			if (fdOnly && dup) {
				word = "";
				hasWord = false;
				i = j + dup[0].length - 1;
				continue;
			}
			while (command[j] === " " || command[j] === "\t") j++;
			const devNull = /^\/dev\/null(?=$|[\s;&|])/.exec(command.slice(j));
			if (fdOnly && devNull) {
				word = "";
				hasWord = false;
				i = j + devNull[0].length - 1;
				continue;
			}
			unsafe ??= "output redirection";
			endWord();
			continue;
		}
		if (ch === " " || ch === "\t") {
			endWord();
			continue;
		}
		word += ch;
		hasWord = true;
	}
	if (quote) unsafe ??= "unbalanced quotes";
	endSegment();

	const programs: string[] = [];
	let reason = unsafe;
	for (const segment of segments) {
		let index = 0;
		while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] as string)) index++;
		const program = segment[index];
		if (program === undefined) continue;
		const name = basename(program);
		programs.push(name);
		if (!reason) reason = segmentNotReadOnly(name, segment.slice(index + 1));
	}
	if (programs.length === 0 && !reason) reason = "empty command";
	return reason ? { programs, readOnly: false, reason } : { programs, readOnly: true };
}

function segmentNotReadOnly(program: string, args: string[]): string | undefined {
	if (!READ_ONLY_PROGRAMS.has(program)) return `\`${program}\` is not in the read-only list`;
	if (program === "find" && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(a))) {
		return "find with side-effect actions";
	}
	if (program === "fd" && args.some((a) => a === "-x" || a === "-X" || a.startsWith("--exec"))) {
		return "fd with exec";
	}
	if (program === "sort" && args.some((a) => a === "-o" || a.startsWith("--output"))) return "sort writing a file";
	if (program === "git") {
		const sub = args.find((a) => !a.startsWith("-"));
		if (sub === undefined) return undefined;
		if (sub === "branch") {
			const rest = args.slice(args.indexOf(sub) + 1);
			return rest.every((a) => READ_ONLY_GIT_BRANCH_FLAGS.has(a)) ? undefined : "git branch with changes";
		}
		if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return `\`git ${sub}\` is not read-only`;
		if (args.some((a) => a === "--output" || a.startsWith("--output="))) return "git writing a file";
	}
	return undefined;
}

/** Resolve a tool path against the workspace and follow symlinks of the nearest existing ancestor. */
export function resolveToolPath(workspacePath: string, path: string): string {
	const expanded = path.startsWith("~/") ? resolve(process.env.HOME ?? "", path.slice(2)) : path;
	const absolute = isAbsolute(expanded) ? expanded : resolve(workspacePath, expanded);
	return realpathOfNearestAncestor(absolute);
}

function realpathOfNearestAncestor(path: string): string {
	let current = path;
	const suffix: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return path;
		suffix.unshift(basename(current));
		current = parent;
	}
	try {
		return resolve(realpathSync(current), ...suffix);
	} catch {
		return path;
	}
}

export function isInsideDirectory(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** Decide whether a tool call may run without asking the user. */
export function evaluateToolCall(call: ToolCallInput, options: EvaluateOptions): ApprovalVerdict {
	const { policy, allowances } = options;
	if (policy === "auto") return { action: "allow", reason: "auto policy" };
	if (READ_ONLY_TOOLS.has(call.toolName)) return { action: "allow", reason: "read-only tool" };
	if (
		call.toolName.startsWith("mcp__") ||
		["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(call.toolName)
	) {
		const key = `mcp:${call.toolName}`;
		if (allowances?.has(key)) return { action: "allow", reason: "allowed for this session" };
		return {
			action: "ask",
			reason: "MCP tools can access external services or run programs",
			severity: "normal",
			summary: call.toolName,
			sessionKey: key,
			sessionScope: `${call.toolName} calls`,
		};
	}
	if (call.toolName === "pier_browser") {
		const action = stringField(call.input, "action") ?? "";
		if (["tabs", "snapshot", "screenshot"].includes(action))
			return { action: "allow", reason: "read-only browser operation" };
		if (allowances?.has("pier_browser")) return { action: "allow", reason: "allowed for this session" };
		return {
			action: "ask",
			reason: "Browser interaction can submit data or change an account",
			severity: "normal",
			summary: `Browser: ${action}`,
			sessionKey: "pier_browser",
			sessionScope: "browser interactions",
		};
	}

	if (SHELL_TOOLS.has(call.toolName)) {
		const command = stringField(call.input, "command") ?? "";
		const danger = findDangerousPattern(command);
		if (danger) {
			return { action: "ask", reason: `Dangerous command: ${danger}`, severity: "high", summary: command };
		}
		const analysis = analyzeShellCommand(command);
		if (policy === "smart" && analysis.readOnly) return { action: "allow", reason: "read-only command" };
		const programs = [...new Set(analysis.programs)].sort();
		const sessionKey = programs.length > 0 ? `${call.toolName}:${programs.join(",")}` : undefined;
		if (sessionKey && allowances?.has(sessionKey)) return { action: "allow", reason: "allowed for this session" };
		return {
			action: "ask",
			reason: policy === "ask" ? "Policy requires approval for shell commands" : (analysis.reason ?? "Shell command"),
			severity: "normal",
			summary: command,
			...(sessionKey
				? {
						sessionKey,
						sessionScope: `${call.toolName} commands running ${programs.map((p) => `\`${p}\``).join(", ")}`,
					}
				: {}),
		};
	}

	if (WRITE_TOOLS.has(call.toolName)) {
		const rawPath = stringField(call.input, "path", "file_path") ?? "";
		const workspace = realpathOfNearestAncestor(resolve(options.workspacePath));
		const target = rawPath ? resolveToolPath(workspace, rawPath) : workspace;
		const inside = rawPath !== "" && isInsideDirectory(workspace, target);
		if (policy === "smart" && inside) return { action: "allow", reason: "write inside workspace" };
		const scopeDir = inside ? workspace : dirname(target);
		const sessionKey = `${call.toolName}:${inside ? "workspace" : scopeDir}`;
		if (allowances?.has(sessionKey)) return { action: "allow", reason: "allowed for this session" };
		return {
			action: "ask",
			reason: inside ? `Policy requires approval for ${call.toolName}` : `${call.toolName} outside the workspace`,
			severity: inside ? "normal" : "high",
			summary: rawPath || "(no path)",
			sessionKey,
			sessionScope: inside ? `${call.toolName} calls inside the workspace` : `${call.toolName} calls under ${scopeDir}`,
		};
	}

	return { action: "allow", reason: "tool not governed by policy" };
}
