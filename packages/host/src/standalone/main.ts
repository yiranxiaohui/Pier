import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { beforeCliExit, exitCli } from "../../../client/src/cli-exit.ts";
import { hostRunning, startCliHost } from "./cli-host.ts";
import { shellCompletion } from "./completion.ts";
import { type DesktopImage, launchDesktop } from "./desktop.ts";
import { launchMode } from "./mode.ts";
import { prepareResources } from "./resources.ts";
import { standaloneExecutable } from "./self.ts";
import { findInstallation, installHost, serviceCommand, uninstallHost, updateHost } from "./service.ts";

export async function runStandalone(archive: string, version: string, desktop?: DesktopImage): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	if (command === "--version") {
		console.log(`pier ${version}`);
		return;
	}
	if (command === "completion") {
		if (args.length > 2) throw new Error("Usage: pier completion [bash]");
		process.stdout.write(shellCompletion(args[1]));
		return;
	}
	if (command === "--help" || command === "-h" || command === "help") {
		console.log(
			`pier ${version}\n\nUsage: pier                         Open the desktop, or the CLI in a terminal\n       pier desktop                 Open the graphical interface\n       pier run [host options]      Run without a graphical interface\n       pier cli [CLI options]       Attach the CLI to a running Host\n       pier install [--user|--system] [--no-start]\n       pier {start|stop|restart|status|logs}\n       pier update [--version vX.Y.Z] [--mirror ROUTE] [--force] [--no-start]\n       pier uninstall [--purge]\n       pier completion [bash]       Print shell completion: source <(pier completion bash)\n\nRun directly from this one executable. No installation or shell script is required.\nIn a terminal, pier opens the CLI on the running Host, or starts one until you quit.\ninstall adds a systemd service and pier command; uninstall keeps data by default.\nupdate asks for the download route in a terminal; --mirror github|ghfast|gh-proxy|ghproxy or\nan https:// prefix skips the menu, --mirror auto measures the routes. Press s to change it.\nUse run --help for Host options, or cli --help for pairing commands.`,
		);
		return;
	}
	if (command === "install") {
		await installHost(process.execPath, args.slice(1), version);
		return;
	}
	const installed = findInstallation(process.execPath);
	if (["start", "stop", "restart", "status", "logs", "update", "uninstall"].includes(command ?? "")) {
		if (!installed) throw new Error("This executable is not installed. Use pier install first");
		if (command === "update") await updateHost(installed, args.slice(1));
		else if (command === "uninstall") {
			if (args.length > 2 || (args[1] !== undefined && args[1] !== "--purge"))
				throw new Error("Usage: pier uninstall [--purge]");
			uninstallHost(installed, args[1] === "--purge");
		} else {
			if (args.length !== 1) throw new Error(`Usage: pier ${command}`);
			serviceCommand(installed, command as string);
		}
		return;
	}
	if (installed) process.env.PIER_DIR = installed.stateDir;
	else if (process.env.PIER_HOST_STATE_DIR) process.env.PIER_DIR = process.env.PIER_HOST_STATE_DIR;
	if (["cli", "run", "--headless"].includes(command ?? "")) process.argv.splice(2, 1);
	if (command === "cli") {
		await import("../../../client/src/cli.ts");
		return;
	}
	const hostArgs = process.argv.slice(2);
	const stateIndex = hostArgs.indexOf("--pier-dir");
	const stateArgument =
		stateIndex >= 0 ? hostArgs[stateIndex + 1] : hostArgs.find((arg) => arg.startsWith("--pier-dir="))?.slice(11);
	const stateDir = resolve(stateArgument ?? process.env.PIER_DIR ?? join(homedir(), ".pier"));
	const mode = launchMode(args, process.env, !!desktop, !!(process.stdin.isTTY && process.stdout.isTTY));
	if (mode === "cli") {
		await openCli(stateDir, installed !== undefined);
		return;
	}
	if (mode === "desktop") {
		if (!desktop) throw new Error("This legacy build has no desktop. Download the pier single-file release");
		if (!process.env.DISPLAY?.trim() && !process.env.WAYLAND_DISPLAY?.trim())
			throw new Error("No graphical display available. Use pier run on this computer");
		const desktopArgs = command === "--autostart" ? args : args.slice(1);
		if (desktopArgs.some((arg) => arg !== "--autostart")) throw new Error("Usage: pier desktop");
		await launchDesktop(desktop, stateDir, desktopArgs);
		return;
	}
	if (command === "--autostart") throw new Error("No graphical display available for desktop autostart");
	process.env.PI_PACKAGE_DIR = prepareResources(archive, stateDir);
	standaloneExecutable.path = process.execPath;
	standaloneExecutable.version = version;
	standaloneExecutable.installed = installed !== undefined;
	await import("../main.ts");
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;

/**
 * A bare `pier` in a terminal: the CLI on the Host running with this state directory, or on a
 * Host started for this terminal that stops when the CLI exits.
 */
async function openCli(stateDir: string, installed: boolean): Promise<void> {
	process.env.PIER_DIR = stateDir;
	if (!(await hostRunning(stateDir))) {
		// Quitting while the Host starts stops it too: exiting signals it (see startCliHost).
		process.once("SIGINT", () => void exitCli(130));
		process.once("SIGTERM", () => void exitCli(143));
		// The terminal is gone: nobody waits for the Host's shutdown or reads its messages.
		process.once("SIGHUP", () => process.exit(129));
		console.log(dim("No Pier Host is running; starting one for this terminal…"));
		let stopped = false;
		const host = await startCliHost(process.execPath, stateDir, {
			onUnexpectedExit: (code, signal, log) => {
				stopped = true;
				process.stdout.write(`\r\x1b[K${red(`The Pier Host stopped (${signal ?? `code ${code}`}); log: ${log}`)}\n`);
				void exitCli(1);
			},
		});
		beforeCliExit(async () => {
			if (stopped) return;
			process.stdout.write(`${dim("Stopping the Pier Host…")}\n`);
			await host.stop();
		});
		console.log(
			dim(
				`It stops when you quit; log: ${host.log}. To keep Pier running in the background, use ${installed ? "pier start" : "pier install (a service) or pier run"}.`,
			),
		);
	}
	await import("../../../client/src/cli.ts");
}
