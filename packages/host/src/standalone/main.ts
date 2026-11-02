import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type DesktopImage, launchDesktop } from "./desktop.ts";
import { launchMode } from "./mode.ts";
import { prepareResources } from "./resources.ts";
import { standaloneExecutable } from "./self.ts";
import { findInstallation, installHost, serviceCommand, uninstallHost, updateHost } from "./service.ts";

export async function runStandalone(
	archive: string,
	version: string,
	desktop?: DesktopImage,
	legacy = false,
): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	if (command === "--version") {
		console.log(`${legacy ? "pier-host" : "pier"} ${version}`);
		return;
	}
	if (command === "--help" || command === "-h" || command === "help") {
		console.log(
			`pier ${version}\n\nUsage: pier                         Auto-select desktop or headless mode\n       pier desktop                 Open the graphical interface\n       pier run [host options]      Run without a graphical interface\n       pier cli [CLI options]\n       pier install [--user|--system] [--no-start]\n       pier {start|stop|restart|status|logs}\n       pier update [--version vX.Y.Z] [--no-start]\n       pier uninstall [--purge]\n\nRun directly from this one executable. No installation or shell script is required.\ninstall adds a systemd service and pier command; uninstall keeps data by default.\nUse run --help for Host options, or cli --help for pairing commands.`,
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
	if (launchMode(args, process.env, !!desktop) === "desktop") {
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
	await import("../main.ts");
}
