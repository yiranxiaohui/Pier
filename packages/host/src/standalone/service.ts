import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

export interface Installation {
	format: 1;
	app: "pier-host";
	scope: "user" | "system";
	prefix: string;
	stateDir: string;
	configHome: string;
	installDir: string;
	binDir: string;
	serviceFile: string;
	version: string;
}

function quoteUnit(value: string): string {
	if (/[\r\n\0]/.test(value)) throw new Error("Newlines and NUL are not supported in installation paths");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function within(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function layout(scope: "user" | "system", prefix: string, configHome: string) {
	const installDir = scope === "user" ? join(prefix, "share/pier-host") : prefix;
	return {
		installDir,
		binDir: scope === "user" ? join(prefix, "bin") : "/usr/local/bin",
		serviceFile:
			scope === "user" ? join(configHome, "systemd/user/pier-host.service") : "/etc/systemd/system/pier-host.service",
	};
}

function readInstallation(directory: string): Installation | undefined {
	const file = join(directory, "installation.json");
	if (!existsSync(file)) return undefined;
	const config = JSON.parse(readFileSync(file, "utf8")) as Installation;
	if (
		config.format !== 1 ||
		config.app !== "pier-host" ||
		!["user", "system"].includes(config.scope) ||
		![config.prefix, config.stateDir, config.configHome].every((path) => typeof path === "string" && isAbsolute(path))
	) {
		throw new Error("Invalid Pier Host installation metadata");
	}
	const expected = layout(config.scope, config.prefix, config.configHome);
	if (
		config.installDir !== directory ||
		Object.entries(expected).some(([key, value]) => config[key as keyof Installation] !== value)
	) {
		throw new Error("Installation paths do not match this Pier Host");
	}
	if (["/", homedir()].includes(config.installDir)) throw new Error("Unsafe installation directory");
	return config;
}

export function findInstallation(executable: string): Installation | undefined {
	return readInstallation(dirname(dirname(realpathSync(executable))));
}

function requirePrivilege(config: Installation): void {
	if (config.scope === "system" && process.getuid?.() !== 0) throw new Error("System service management requires root");
}

function control(config: Installation, args: string[], required = true, inherit = false) {
	const result = spawnSync("systemctl", [...(config.scope === "user" ? ["--user"] : []), ...args], {
		encoding: "utf8",
		stdio: inherit ? "inherit" : "pipe",
		timeout: 30_000,
	});
	if (required && (result.error || result.status !== 0)) {
		throw new Error(`systemctl ${args[0]} failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
	}
	return result;
}

function managerAvailable(config: Installation): boolean {
	return control(config, ["show-environment"], false).status === 0;
}

function assertStopped(stateDir: string): void {
	const runtime = join(stateDir, "run/host.json");
	if (!existsSync(runtime)) return;
	const { pid } = JSON.parse(readFileSync(runtime, "utf8")) as { pid?: number };
	if (!Number.isInteger(pid) || (pid ?? 0) <= 0) throw new Error("Invalid Host runtime file; installation was kept");
	let alive = true;
	try {
		process.kill(pid as number, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
		else throw error;
	}
	if (alive)
		throw new Error("A Host is still running with this state directory. Stop it before installing or uninstalling");
}

async function waitReady(config: Installation): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const pid = Number(control(config, ["show", "-p", "MainPID", "--value", "pier-host.service"]).stdout.trim());
		try {
			const ready = JSON.parse(readFileSync(join(config.stateDir, "run/host.json"), "utf8")) as {
				pid: number;
				version: string;
			};
			if (pid > 0 && ready.pid === pid && ready.version === config.version) return;
		} catch {
			/* Wait until Host has written its readiness file. */
		}
		if (control(config, ["is-active", "--quiet", "pier-host.service"], false).status !== 0) break;
		await delay(100);
	}
	throw new Error("Pier Host service did not become ready");
}

function unit(config: Installation): string {
	const executable = quoteUnit(join(config.installDir, "current/pier-host")).replaceAll("$", "$$");
	return `[Unit]\nDescription=Pier Host\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${executable} run\nEnvironment=${quoteUnit(`PIER_DIR=${config.stateDir}`)}\nEnvironment=${quoteUnit(`HOME=${homedir()}`)}\nEnvironment=${quoteUnit(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=15\nStandardOutput=null\nStandardError=journal\nUMask=0077\n\n[Install]\nWantedBy=${config.scope === "user" ? "default.target" : "multi-user.target"}\n`;
}

function removeCommand(config: Installation): void {
	const link = join(config.binDir, "pier-host");
	try {
		if (
			lstatSync(link).isSymbolicLink() &&
			resolve(dirname(link), readlinkSync(link)) === join(config.installDir, "current/pier-host")
		)
			rmSync(link);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function installHost(executable: string, args: string[], version: string): Promise<Installation> {
	if (process.platform !== "linux") throw new Error("Service installation is supported on Linux");
	const { values } = parseArgs({
		args,
		options: { user: { type: "boolean" }, system: { type: "boolean" }, "no-start": { type: "boolean" } },
	});
	if (values.user && values.system) throw new Error("Choose --user or --system");
	const scope = values.user ? "user" : values.system || process.getuid?.() === 0 ? "system" : "user";
	const prefix = resolve(
		process.env.PIER_HOST_PREFIX ?? (scope === "user" ? join(homedir(), ".local") : "/opt/pier-host"),
	);
	const configHome = resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
	const paths = layout(scope, prefix, configHome);
	const previous = readInstallation(paths.installDir);
	const config: Installation = previous
		? { ...previous, version }
		: {
				format: 1,
				app: "pier-host",
				scope,
				prefix,
				configHome,
				...paths,
				version,
				stateDir: resolve(process.env.PIER_HOST_STATE_DIR ?? process.env.PIER_DIR ?? join(homedir(), ".pier")),
			};
	requirePrivilege(config);
	for (const path of [config.installDir, config.binDir, config.serviceFile, config.stateDir]) quoteUnit(path);
	if (
		["/", homedir()].includes(config.installDir) ||
		within(config.installDir, config.stateDir) ||
		within(config.stateDir, config.installDir)
	) {
		throw new Error("Installation and state directories must be separate and safe");
	}
	if (existsSync(config.installDir) && !previous)
		throw new Error(
			`Will not overwrite unmanaged directory ${config.installDir}. Uninstall the old service first; its data is preserved`,
		);
	if (existsSync(config.serviceFile) && !previous) throw new Error(`Will not overwrite ${config.serviceFile}`);
	const link = join(config.binDir, "pier-host");
	try {
		const stat = lstatSync(link);
		if (
			!stat.isSymbolicLink() ||
			resolve(dirname(link), readlinkSync(link)) !== join(config.installDir, "current/pier-host")
		)
			throw new Error(`Will not overwrite ${link}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const available = managerAvailable(config);
	if (!values["no-start"] && !available)
		throw new Error("No systemd manager; use install --no-start, then run pier-host directly");
	const active =
		previous && available && control(config, ["is-active", "--quiet", "pier-host.service"], false).status === 0;
	if (active) control(config, ["stop", "pier-host.service"]);
	assertStopped(config.stateDir);
	const binary = join(config.installDir, "current/pier-host");
	const backup = join(config.installDir, "previous");
	const oldUnit = previous && existsSync(config.serviceFile) ? readFileSync(config.serviceFile) : undefined;
	let backupReady = false;
	let attemptedStart = false;
	try {
		mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
		if (previous) {
			copyFileSync(binary, backup);
			backupReady = true;
		}
		copyFileSync(executable, `${binary}.new`);
		chmodSync(`${binary}.new`, 0o755);
		renameSync(`${binary}.new`, binary);
		writeFileSync(join(config.installDir, "installation.json"), `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
		});
		mkdirSync(config.binDir, { recursive: true });
		if (!existsSync(link)) symlinkSync(binary, link);
		mkdirSync(dirname(config.serviceFile), { recursive: true });
		writeFileSync(config.serviceFile, unit(config), { mode: 0o644 });
		if (available) control(config, ["daemon-reload"]);
		if (!values["no-start"]) {
			attemptedStart = true;
			control(config, ["enable", "--now", "pier-host.service"]);
			await waitReady(config);
		}
		rmSync(backup, { force: true });
	} catch (error) {
		if (available && attemptedStart) {
			// Keep the installed executable if we cannot confirm that the failed service stopped.
			control(config, ["stop", "pier-host.service"]);
		}
		assertStopped(config.stateDir);
		if (previous) {
			if (backupReady) renameSync(backup, binary);
			else rmSync(backup, { force: true });
			rmSync(`${binary}.new`, { force: true });
			writeFileSync(join(config.installDir, "installation.json"), `${JSON.stringify(previous, null, 2)}\n`, {
				mode: 0o600,
			});
			if (oldUnit) writeFileSync(config.serviceFile, oldUnit);
			else rmSync(config.serviceFile, { force: true });
		} else {
			if (available) control(config, ["disable", "pier-host.service"], false);
			removeCommand(config);
			rmSync(config.serviceFile, { force: true });
			rmSync(config.installDir, { recursive: true, force: true });
		}
		if (available) {
			control(config, ["daemon-reload"]);
			if (active) control(config, ["start", "pier-host.service"]);
		}
		throw new Error(
			`Installation failed; ${previous ? "previous binary restored" : "partial installation removed"}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	console.log(`Installed Pier Host ${version}. Commands: ${link} {cli|start|stop|status|logs|update|uninstall}`);
	if (values["no-start"]) console.log(`Service was not started. Run ${link} or enable pier-host.service.`);
	else if (scope === "user")
		console.log(`For startup before login and after SSH logout: sudo loginctl enable-linger ${userInfo().username}`);
	return config;
}

export function uninstallHost(config: Installation, purge = false): void {
	requirePrivilege(config);
	if (
		purge &&
		(["/", "/etc", "/usr", "/var", "/opt", "/tmp", "/home", "/root", "/srv"].includes(config.stateDir) ||
			within(config.stateDir, homedir()) ||
			within(config.stateDir, config.installDir))
	)
		throw new Error("Refusing to purge a system directory or a directory containing home or the installation");
	if (managerAvailable(config)) control(config, ["disable", "--now", "pier-host.service"]);
	assertStopped(config.stateDir);
	rmSync(config.serviceFile, { force: true });
	if (managerAvailable(config)) control(config, ["daemon-reload"]);
	removeCommand(config);
	rmSync(config.installDir, { recursive: true, force: true });
	if (purge) rmSync(config.stateDir, { recursive: true, force: true });
	console.log(
		`Pier Host uninstalled. ${purge ? "Removed" : "Kept"} Pier state: ${config.stateDir}. Shared Agent data and project files were kept.`,
	);
}

export function serviceCommand(config: Installation, command: string): void {
	requirePrivilege(config);
	if (command === "logs") {
		const result = spawnSync(
			"journalctl",
			[...(config.scope === "user" ? ["--user"] : []), "-u", "pier-host.service", "-f"],
			{ stdio: "inherit" },
		);
		process.exitCode = result.status ?? 1;
	} else {
		const result = control(config, [command, "pier-host.service"], false, true);
		process.exitCode = result.status ?? 1;
	}
}

export async function updateHost(config: Installation, args: string[]): Promise<void> {
	requirePrivilege(config);
	const { values } = parseArgs({ args, options: { version: { type: "string" }, "no-start": { type: "boolean" } } });
	const download = async (url: string) => {
		const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
		if (!response.ok || !response.url.startsWith("https://"))
			throw new Error(`Release download failed (${response.status})`);
		return response;
	};
	const tag =
		values.version ??
		(
			(await (await download("https://api.github.com/repos/yiranxiaohui/Pier/releases/latest")).json()) as {
				tag_name: string;
			}
		).tag_name;
	if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error("Invalid release tag");
	const name = `pier-host-${tag}-linux-${process.arch}`;
	const base = `https://github.com/yiranxiaohui/Pier/releases/download/${tag}`;
	const checksums = await (await download(`${base}/SHA256SUMS.txt`)).text();
	const checksum = checksums
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find((parts) => parts[1]?.replace(/^\*/, "") === name)?.[0];
	if (!checksum || !/^[a-f0-9]{64}$/.test(checksum))
		throw new Error("No single-binary Host for this release and architecture");
	const bytes = Buffer.from(await (await download(`${base}/${name}`)).arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== checksum)
		throw new Error("Release checksum mismatch; installation was kept");
	const directory = mkdtempSync(join(tmpdir(), "pier-host-update-"));
	try {
		const binary = join(directory, "pier-host");
		writeFileSync(binary, bytes, { mode: 0o700 });
		const check = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 });
		if (check.status !== 0 || check.stdout.trim() !== `pier-host ${tag.slice(1)}`)
			throw new Error("Downloaded Host version check failed");
		process.env.PIER_HOST_PREFIX = config.prefix;
		process.env.XDG_CONFIG_HOME = config.configHome;
		await installHost(binary, [`--${config.scope}`, ...(values["no-start"] ? ["--no-start"] : [])], tag.slice(1));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
