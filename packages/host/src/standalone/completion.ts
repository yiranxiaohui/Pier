/**
 * Shell completion for the `pier` single-file command (`pier completion bash`). Completes the
 * subcommands and their options; inside `pier cli`, Tab completion is the CLI's own.
 */

export const PIER_COMMANDS = [
	"desktop",
	"run",
	"cli",
	"install",
	"start",
	"stop",
	"restart",
	"status",
	"logs",
	"update",
	"uninstall",
	"completion",
	"help",
	"--help",
	"--version",
] as const;

/** Options per subcommand. `pier run`'s sidecar-only options (--watch-stdin, ...) are left out. */
export const PIER_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	run: [
		"--port",
		"--pier-dir",
		"--agent-dir",
		"--origin",
		"--no-runtime-file",
		"--no-remote",
		"--remote-port",
		"--remote-address",
		"--no-mdns",
		"--relay",
		"--no-p2p",
		"--check-images",
		"--check-p2p",
		"--help",
	],
	cli: ["--url", "--token", "--pier-dir", "--help"],
	install: ["--user", "--system", "--no-start"],
	update: ["--version", "--no-start"],
	uninstall: ["--purge"],
};

/** Options followed by a directory, and options followed by a value that cannot be completed. */
const DIRECTORY_OPTIONS = ["--pier-dir", "--agent-dir"];
const VALUE_OPTIONS = [
	"--port",
	"--remote-port",
	"--remote-address",
	"--origin",
	"--relay",
	"--url",
	"--token",
	"--version",
];

export const COMPLETION_SHELLS = ["bash"] as const;

function bash(): string {
	const cases = Object.entries(PIER_OPTIONS)
		.map(
			([command, options]) => `\t\t${command === "run" ? "run|--headless" : command}) words="${options.join(" ")}" ;;`,
		)
		.join("\n");
	return `# bash completion for pier
#
# Load it in the current shell:      source <(pier completion bash)
# Load it in every new shell:        echo 'source <(pier completion bash)' >> ~/.bashrc
# With the bash-completion package:  pier completion bash > ~/.local/share/bash-completion/completions/pier

_pier() {
	local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]} words=""
	if [[ $COMP_CWORD -eq 1 ]]; then
		COMPREPLY=($(compgen -W "${PIER_COMMANDS.join(" ")}" -- "$cur"))
		return
	fi
	case $prev in
	${DIRECTORY_OPTIONS.join("|")})
		compopt -o filenames 2>/dev/null
		local IFS=$'\\n'
		COMPREPLY=($(compgen -d -- "$cur"))
		return ;;
	${VALUE_OPTIONS.join("|")})
		COMPREPLY=()
		return ;;
	esac
	case \${COMP_WORDS[1]} in
${cases}
		completion) [[ $COMP_CWORD -eq 2 ]] && words="${COMPLETION_SHELLS.join(" ")}" ;;
	esac
	COMPREPLY=($(compgen -W "$words" -- "$cur"))
	return 0
}

complete -F _pier pier
`;
}

/** The completion script for `shell` (bash by default). */
export function shellCompletion(shell = "bash"): string {
	if (shell === "bash") return bash();
	throw new Error(`Usage: pier completion [${COMPLETION_SHELLS.join("|")}] (no completion for ${shell} yet)`);
}
