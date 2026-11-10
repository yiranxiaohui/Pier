/**
 * Run under Bun by `pty-terminals.test.ts`: open real pseudo-terminals with the host's own
 * terminals and print what happened as one JSON line.
 */
import { createPtyTerminals } from "../../src/pty-terminals.ts";
import type { ShellTerminal } from "../../src/shell.ts";

const cwd = process.argv[2] ?? "/";
const terminals = createPtyTerminals("9.9.9");
if (!terminals) {
	console.log(JSON.stringify({ supported: false }));
	process.exit(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const open = async (cols: number, rows: number) => {
	let output = "";
	let bytes = 0;
	let exit: { code: number | null } | undefined;
	const terminal: ShellTerminal = await terminals.openTerminal(
		{ cwd, cols, rows },
		{
			output: (data) => {
				const chunk = Buffer.from(data, "base64");
				bytes += chunk.length;
				output += chunk.toString();
			},
			exit: (code) => {
				exit = { code };
			},
		},
	);
	const until = async (done: () => boolean, ms = 10_000) => {
		for (let waited = 0; !done() && waited < ms; waited += 20) await sleep(20);
		return done();
	};
	return { terminal, output: () => output, bytes: () => bytes, exit: () => exit, until };
};

// A login shell in the requested directory and size, with Pier's terminal variables.
const first = await open(100, 30);
first.terminal.write('echo "[$TERM_PROGRAM $TERM_PROGRAM_VERSION $TERM]"; stty size; pwd; exit 5\r', false);
await first.until(() => first.exit() !== undefined);

// Pausing stops the output of a program in cooked mode; resuming lets it continue; kill ends it.
const second = await open(80, 24);
second.terminal.write("yes 0123456789abcdef | head -c 300000000\r", false);
await second.until(() => second.bytes() > 100_000);
second.terminal.pause(true);
await sleep(300);
const pausedAt = second.bytes();
await sleep(700);
const grewWhilePaused = second.bytes() - pausedAt;
second.terminal.pause(false);
await second.until(() => second.bytes() > pausedAt + 100_000, 5_000);
const grewAfterResume = second.bytes() - pausedAt;
second.terminal.kill();
await second.until(() => second.exit() !== undefined);

console.log(
	JSON.stringify({
		supported: true,
		shell: first.terminal.shell,
		cwd: first.terminal.cwd,
		exit: first.exit(),
		output: first.output(),
		grewWhilePaused,
		grewAfterResume,
		killed: second.exit(),
	}),
);
