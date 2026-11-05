/**
 * `pier` typed in a terminal opens the CLI. It attaches to the Host already running with this
 * state directory (the installed service, the desktop app's Host, or a `pier run`); when there is
 * none it starts `pier run` in the background for this terminal and stops it when the CLI exits.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

interface RuntimeFile {
	pid?: number;
	port?: number;
}

function readRuntime(stateDir: string): RuntimeFile | undefined {
	try {
		return JSON.parse(readFileSync(join(stateDir, "run", "host.json"), "utf8")) as RuntimeFile;
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function listening(port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		const done = (result: boolean) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

/**
 * Whether a Host is running with this state directory: its runtime file names a live process
 * that accepts connections (a file left behind by a Host that crashed, or whose pid was reused
 * after a reboot, does not count).
 */
export async function hostRunning(stateDir: string, timeoutMs = 1_000): Promise<boolean> {
	const runtime = readRuntime(stateDir);
	if (!Number.isInteger(runtime?.pid) || (runtime?.pid ?? 0) <= 0 || !alive(runtime?.pid as number)) return false;
	if (!Number.isInteger(runtime?.port) || (runtime?.port ?? 0) <= 0) return false;
	return listening(runtime?.port as number, timeoutMs);
}

export interface CliHost {
	/** Where the Host writes its log. */
	readonly log: string;
	/** Ask the Host to shut down and wait until it has (it disposes its sessions first). */
	stop(): Promise<void>;
}

export interface StartCliHostOptions {
	/** How long to wait for the Host to write its runtime file (resources are unpacked on first use). */
	readyTimeoutMs?: number;
	/** How long `stop` waits before killing the Host (the Host forces its own exit after 10 s). */
	stopTimeoutMs?: number;
	/** Called once if the Host exits after it started without being asked to. */
	onUnexpectedExit?: (code: number | null, signal: NodeJS.Signals | null, log: string) => void;
}

function logTail(path: string, lines = 20): string {
	try {
		return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
	} catch {
		return "";
	}
}

/**
 * Start `<executable> run` for the CLI: in its own session, so it neither shares the terminal
 * with the CLI (an agent's command cannot read the keyboard) nor receives the terminal's signals,
 * with its log in `<stateDir>/logs/cli-host.log`. Resolves once it has written its runtime file.
 */
export async function startCliHost(
	executable: string,
	stateDir: string,
	options: StartCliHostOptions = {},
): Promise<CliHost> {
	const logs = join(stateDir, "logs");
	mkdirSync(logs, { recursive: true, mode: 0o700 });
	const log = join(logs, "cli-host.log");
	const fd = openSync(log, "w", 0o600);
	let child: ChildProcess;
	try {
		child = spawn(executable, ["run"], {
			detached: true,
			stdio: ["ignore", "ignore", fd],
			env: { ...process.env, PIER_DIR: stateDir },
		});
	} finally {
		closeSync(fd);
	}
	const pid = child.pid;
	let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let ready = false;
	let stopping = false;
	const exit = new Promise<void>((resolve) => {
		child.once("exit", (code, signal) => {
			exited = { code, signal };
			if (ready && !stopping) options.onUnexpectedExit?.(code, signal, log);
			resolve();
		});
	});
	const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
	/** `group`: the Host's whole process group, including commands its agents left running. */
	const signal = (name: NodeJS.Signals, group = false) => {
		if (exited || pid === undefined) return;
		try {
			process.kill(group ? -pid : pid, name);
		} catch {
			/* Already gone. */
		}
	};
	// Whatever ends the CLI, the Host it started goes too.
	const onExit = () => signal("SIGTERM");
	process.once("exit", onExit);
	const host: CliHost = {
		log,
		async stop() {
			stopping = true;
			process.removeListener("exit", onExit);
			signal("SIGTERM");
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), options.stopTimeoutMs ?? 15_000);
			});
			const done = await Promise.race([exit.then(() => true), timeout]);
			clearTimeout(timer);
			if (!done) {
				signal("SIGKILL", true);
				await exit;
			}
		},
	};

	const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
	for (;;) {
		const failure = await Promise.race([
			spawnError,
			exit.then(() => undefined),
			new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
		]);
		if (failure) {
			stopping = true;
			process.removeListener("exit", onExit);
			throw new Error(`Could not start the Pier Host: ${failure.message}`);
		}
		if (exited) {
			process.removeListener("exit", onExit);
			const tail = logTail(log);
			throw new Error(
				`The Pier Host exited while starting (${exited.signal ?? `code ${exited.code}`}); log: ${log}${tail ? `\n${tail}` : ""}`,
			);
		}
		if (readRuntime(stateDir)?.pid === pid) {
			ready = true;
			return host;
		}
		if (Date.now() > deadline) {
			await host.stop();
			throw new Error(`The Pier Host did not start within the time limit; log: ${log}`);
		}
	}
}
