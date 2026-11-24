import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureInstallationPath } from "../src/runtimes/installation-path.ts";
import { publishAgentCommand, sharedAgentExecutable, sharedAgentPaths } from "../src/runtimes/shared-installation.ts";

describe("shared Agent commands", () => {
	let root: string;
	let home: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-shared-"));
		home = root;
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")("replaces an old CLI symlink without overwriting its package", async () => {
		const paths = sharedAgentPaths("claude-code", home);
		mkdirSync(paths.bin, { recursive: true });
		const old = join(home, "npm-claude");
		writeFileSync(old, "old-npm-package");
		symlinkSync(old, paths.executable);
		const next = join(home, "new-claude");
		writeFileSync(next, "new-native");
		await publishAgentCommand("claude-code", next, home);
		expect(readFileSync(paths.executable, "utf8")).toBe("new-native");
		expect(readFileSync(old, "utf8")).toBe("old-npm-package");
	});

	it("publishes Windows native commands, replacing older shell launchers", async () => {
		const paths = sharedAgentPaths("claude-code", home, "win32");
		mkdirSync(paths.bin, { recursive: true });
		for (const ext of ["exe", "cmd", "bat", "ps1"]) writeFileSync(join(paths.bin, `claude.${ext}`), "old-launcher");
		const next = join(home, "claude.exe");
		writeFileSync(next, "native-claude");
		await publishAgentCommand("claude-code", next, home, "win32");
		expect(readFileSync(paths.executable, "utf8")).toBe("native-claude");
		expect(readdirSync(paths.bin)).toEqual(["claude.exe"]);
	});

	it("restores launchers if Windows publication fails partway through", async () => {
		const paths = sharedAgentPaths("claude-code", home, "win32");
		mkdirSync(paths.executable, { recursive: true }); // Main entry cannot be replaced.
		writeFileSync(join(paths.bin, "claude.cmd"), "old-command");
		const next = join(home, "claude.exe");
		writeFileSync(next, "new-claude");
		await expect(publishAgentCommand("claude-code", next, home, "win32")).rejects.toThrow("命令路径是目录");
		expect(readFileSync(join(paths.bin, "claude.cmd"), "utf8")).toBe("old-command");
		expect(readdirSync(paths.bin).sort()).toEqual(["claude.cmd", "claude.exe"]);
	});

	/** A complete Codex package like the official `codex-package-<target>.tar.gz`, kept by version. */
	const codexRelease = (version: string) => {
		const release = join(sharedAgentPaths("codex", home, "win32").versions, `${version}-id`);
		mkdirSync(join(release, "bin"), { recursive: true });
		mkdirSync(join(release, "codex-resources"));
		writeFileSync(join(release, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version }));
		writeFileSync(join(release, "bin", "codex.exe"), `codex ${version}`);
		writeFileSync(join(release, "bin", "codex-code-mode-host.exe"), "code-mode-host");
		writeFileSync(join(release, "codex-resources", "codex-command-runner.exe"), "command-runner");
		return join(release, "bin", "codex.exe");
	};

	it("runs Windows Codex from its complete package through a junction, removing copied commands", async () => {
		const paths = sharedAgentPaths("codex", home, "win32");
		expect(paths.bin).toBe(join(home, ".local", "share", "codex", "current", "bin"));
		// Earlier versions copied the package's `bin` here, where Codex cannot find the rest of it.
		mkdirSync(paths.commands, { recursive: true });
		const copied = ["codex.exe", "codex-code-mode-host.exe", "codex-exec-server.exe", "codex.cmd"];
		for (const name of [...copied, "claude.exe", "codex-notes.txt"]) writeFileSync(join(paths.commands, name), name);
		const first = codexRelease("1.0.0");
		await publishAgentCommand("codex", first, home, "win32");
		expect(sharedAgentExecutable("codex", home, "win32")).toBe(realpathSync(first));
		// Codex resolves the junction and finds its package metadata and resources next to `bin`.
		expect(readFileSync(join(paths.current, "codex-resources", "codex-command-runner.exe"), "utf8")).toBe(
			"command-runner",
		);
		expect(readdirSync(paths.commands).sort()).toEqual(["claude.exe", "codex-notes.txt"]);

		const second = codexRelease("1.1.0");
		await publishAgentCommand("codex", second, home, "win32");
		expect(sharedAgentExecutable("codex", home, "win32")).toBe(realpathSync(second));
		expect(readFileSync(paths.executable, "utf8")).toBe("codex 1.1.0");
		expect(readFileSync(first, "utf8")).toBe("codex 1.0.0"); // Running programs keep their release.
		expect(readdirSync(dirname(paths.current)).sort()).toEqual(["current", "versions"]);
	});

	it("keeps a Windows Codex directory that Pier did not create", async () => {
		const paths = sharedAgentPaths("codex", home, "win32");
		mkdirSync(paths.bin, { recursive: true });
		writeFileSync(paths.executable, "user-codex");
		mkdirSync(paths.commands, { recursive: true });
		writeFileSync(join(paths.commands, "codex.exe"), "copied");
		await expect(publishAgentCommand("codex", codexRelease("1.0.0"), home, "win32")).rejects.toThrow(
			"不是 Pier 创建的链接",
		);
		await expect(publishAgentCommand("codex", join(home, "codex.exe"), home, "win32")).rejects.toThrow(
			"不在完整的发行包中",
		);
		expect(readFileSync(paths.executable, "utf8")).toBe("user-codex");
		expect(readFileSync(join(paths.commands, "codex.exe"), "utf8")).toBe("copied");
		expect(readdirSync(dirname(paths.current)).sort()).toEqual(["current", "versions"]);
	});

	it.skipIf(process.platform === "win32")(
		"preserves shell setup and makes new terminals choose the shared CLI over an older CLI",
		async () => {
			home = join(home, "home with ' and $ characters");
			mkdirSync(home);
			const paths = sharedAgentPaths("claude-code", home);
			mkdirSync(paths.bin, { recursive: true });
			const previous = join(home, "old-bin");
			mkdirSync(previous);
			writeFileSync(join(previous, "claude"), "#!/bin/sh\necho old\n", { mode: 0o755 });
			writeFileSync(paths.executable, "#!/bin/sh\necho new\n", { mode: 0o755 });
			const original = "# User configuration\nexport KEEP_THIS=yes\n";
			for (const name of [".profile", ".bashrc", ".bash_profile", ".zshrc"]) writeFileSync(join(home, name), original);
			const env = { PATH: `${previous}:/usr/bin:/bin` };
			await configureInstallationPath(paths.bin, { home, platform: "linux", env });
			const first = readFileSync(join(home, ".bash_profile"), "utf8");
			await configureInstallationPath(paths.bin, { home, platform: "linux", env });
			expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe(first);
			expect(first.startsWith(original)).toBe(true);
			const output = execFileSync(
				"/bin/sh",
				["-c", '. "$HOME/.bash_profile"; . "$HOME/.profile"; claude; echo "$KEEP_THIS"; echo "$PATH"'],
				{
					env: { HOME: home, PATH: `${previous}:/usr/bin:/bin` },
					encoding: "utf8",
				},
			);
			expect(output.trim().split("\n")).toEqual(["new", "yes", `${paths.bin}:${previous}:/usr/bin:/bin`]);
			expect(env.PATH).toBe(`${paths.bin}:${previous}:/usr/bin:/bin`);
		},
	);

	it("persists Windows user PATH through PowerShell and updates the Host's case-insensitive Path", async () => {
		const bin = String.raw`C:\Users\Someone's home\.local\bin`;
		const env = { Path: String.raw`C:\Windows;C:\old-cli` };
		const runPowerShell = vi.fn<(script: string, env: NodeJS.ProcessEnv) => Promise<void>>(async () => {});
		await configureInstallationPath(bin, { home, platform: "win32", env, runPowerShell });
		expect(runPowerShell).toHaveBeenCalledWith(expect.stringContaining("SetEnvironmentVariable"), {
			Path: String.raw`C:\Windows;C:\old-cli`,
			PIER_AGENT_COMMAND_DIRECTORY: bin,
		});
		expect(runPowerShell.mock.calls[0]?.[0]).not.toContain(bin); // Path is data, not PowerShell source.
		expect(env.Path).toBe(`${bin};C:\\Windows;C:\\old-cli`);
	});

	it("does not report successful PATH setup when Windows cannot persist it", async () => {
		const env = { Path: "old-path" };
		await expect(
			configureInstallationPath("new-bin", {
				home,
				platform: "win32",
				env,
				runPowerShell: async () => {
					throw new Error("registry denied");
				},
			}),
		).rejects.toThrow("registry denied");
		expect(env.Path).toBe("old-path");
		expect(existsSync(join(home, ".profile"))).toBe(false);
	});
});
