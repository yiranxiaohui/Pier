import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prepareResources } from "./resources.ts";
import { findInstallation, installHost, serviceCommand, uninstallHost, updateHost } from "./service.ts";

export async function runStandalone(archive: string, version: string): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	if (command === "--version") {
		console.log(`pier-host ${version}`);
		return;
	}
	if (command === "--help" || command === "-h" || command === "help") {
		console.log(
			`pier-host ${version}\n\nUsage: pier-host [run] [host options]\n       pier-host cli [CLI options]\n       pier-host install [--user|--system] [--no-start]\n       pier-host {start|stop|restart|status|logs}\n       pier-host update [--version vX.Y.Z] [--no-start]\n       pier-host uninstall [--purge]\n\nRun directly from this one executable. No installation or shell script is required.\ninstall adds a systemd service and pier-host command; uninstall keeps data by default.\nUse run --help for Host options, or cli --help for pairing commands.`,
		);
		return;
	}
	if (command === "install") {
		await installHost(process.execPath, args.slice(1), version);
		return;
	}
	const installed = findInstallation(process.execPath);
	if (["start", "stop", "restart", "status", "logs", "update", "uninstall"].includes(command ?? "")) {
		if (!installed) throw new Error("This executable is not installed. Use pier-host install first");
		if (command === "update") await updateHost(installed, args.slice(1));
		else if (command === "uninstall") {
			if (args.length > 2 || (args[1] !== undefined && args[1] !== "--purge"))
				throw new Error("Usage: pier-host uninstall [--purge]");
			uninstallHost(installed, args[1] === "--purge");
		} else {
			if (args.length !== 1) throw new Error(`Usage: pier-host ${command}`);
			serviceCommand(installed, command as string);
		}
		return;
	}
	if (installed) process.env.PIER_DIR = installed.stateDir;
	else if (process.env.PIER_HOST_STATE_DIR) process.env.PIER_DIR = process.env.PIER_HOST_STATE_DIR;
	if (command === "cli" || command === "run") process.argv.splice(2, 1);
	if (command === "cli") {
		await import("../../../client/src/cli.ts");
		return;
	}
	const hostArgs = process.argv.slice(2);
	const stateIndex = hostArgs.indexOf("--pier-dir");
	const stateArgument =
		stateIndex >= 0 ? hostArgs[stateIndex + 1] : hostArgs.find((arg) => arg.startsWith("--pier-dir="))?.slice(11);
	const stateDir = resolve(stateArgument ?? process.env.PIER_DIR ?? join(homedir(), ".pier"));
	process.env.PI_PACKAGE_DIR = prepareResources(archive, stateDir);
	await import("../main.ts");
}
