import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PIER_OPTIONS, shellCompletion } from "../src/standalone/completion.ts";

const root = mkdtempSync(join(tmpdir(), "pier-completion-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = join(root, "pier.bash");
writeFileSync(script, shellCompletion("bash"));

const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

/** COMPREPLY of the completion function for `words`, completing the last one. */
function complete(...words: string[]): string[] {
	const result = spawnSync(
		"bash",
		[
			"--norc",
			"--noprofile",
			"-c",
			`source "$1" && COMP_WORDS=("\${@:3}") && COMP_CWORD=$2 && _pier && printf "%s\\n" "\${COMPREPLY[@]}"`,
			"_",
			script,
			String(words.length - 1),
			...words,
		],
		{ encoding: "utf8" },
	);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	return result.stdout.split("\n").filter(Boolean);
}

describe("pier completion", () => {
	it("offers the options pier run and pier cli document", () => {
		const host = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
		const help = host.slice(host.indexOf("Options:"), host.indexOf("Environment:"));
		const documented = [...help.matchAll(/^ {2}(--[a-z0-9-]+)/gm)].map((match) => match[1]);
		const sidecarOnly = ["--watch-stdin", "--shell-terminals", "--no-login-shell-path"];
		expect(documented.length).toBeGreaterThan(10);
		expect(documented.filter((option) => !sidecarOnly.includes(option as string)).sort()).toEqual(
			PIER_OPTIONS.run?.filter((option) => option !== "--help").sort(),
		);
		// pier cli: the options its parseArgs accepts, but not the internal --ssh-pair.
		const cli = readFileSync(join(import.meta.dirname, "../../client/src/cli.ts"), "utf8");
		const parsed = [...cli.matchAll(/^\s+"?([a-z-]+)"?: \{ type: "(?:string|boolean)"/gm)].map((m) => `--${m[1]}`);
		expect(parsed.filter((option) => option !== "--ssh-pair").sort()).toEqual([...(PIER_OPTIONS.cli ?? [])].sort());
	});

	it("only knows bash", () => {
		expect(() => shellCompletion("zsh")).toThrow(/Usage: pier completion \[bash\]/);
	});

	it.runIf(hasBash)("completes subcommands and their options in bash", () => {
		expect(complete("pier", "ru")).toEqual(["run"]);
		expect(complete("pier", "")).toContain("completion");
		expect(complete("pier", "install", "--")).toEqual(["--user", "--system", "--no-start"]);
		expect(complete("pier", "--headless", "--no-")).toEqual([
			"--no-runtime-file",
			"--no-remote",
			"--no-mdns",
			"--no-p2p",
		]);
		expect(complete("pier", "cli", "--t")).toEqual(["--token"]);
		expect(complete("pier", "completion", "")).toEqual(["bash"]);
		expect(complete("pier", "completion", "bash", "")).toEqual([]);
		expect(complete("pier", "status", "")).toEqual([]);
	});

	it.runIf(hasBash)("completes directories after --pier-dir and nothing after value options", () => {
		mkdirSync(join(root, "state", "alpha"), { recursive: true });
		mkdirSync(join(root, "state", "beta dir"));
		writeFileSync(join(root, "state", "gamma.txt"), "");
		expect(complete("pier", "run", "--pier-dir", `${root}/state/`).sort()).toEqual([
			`${root}/state/alpha`,
			`${root}/state/beta dir`,
		]);
		expect(complete("pier", "update", "--version", "")).toEqual([]);
		expect(complete("pier", "update", "--mirror", "gh")).toEqual(["ghfast", "gh-proxy", "ghproxy"]);
		expect(complete("pier", "update", "--m")).toEqual(["--mirror"]);
		expect(complete("pier", "run", "--port", "")).toEqual([]);
	});
});
