import { spawnSync } from "node:child_process";
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fileSha256, parseChecksums, RELEASE_REPOSITORY, singleFileNames } from "../peers/ssh/release.ts";
import {
	BUILTIN_ROUTES,
	chooseRoute,
	downloadWithRoutes,
	fetchChecksums,
	type Output,
	parseMirror,
	type Route,
	rankRoutes,
	routeOrder,
	routeWhere,
	terminalKeys,
} from "./update-download.ts";

export interface Installation {
	format: 1;
	app: "pier" | "pier-host";
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

function layout(scope: "user" | "system", prefix: string, configHome: string, app: Installation["app"] = "pier") {
	const installDir = scope === "user" ? join(prefix, "share", app) : prefix;
	return {
		installDir,
		binDir: scope === "user" ? join(prefix, "bin") : "/usr/local/bin",
		serviceFile:
			scope === "user" ? join(configHome, `systemd/user/${app}.service`) : `/etc/systemd/system/${app}.service`,
	};
}

function readInstallation(directory: string): Installation | undefined {
	const file = join(directory, "installation.json");
	if (!existsSync(file)) return undefined;
	const config = JSON.parse(readFileSync(file, "utf8")) as Installation;
	if (
		config.format !== 1 ||
		!["pier", "pier-host"].includes(config.app) ||
		!["user", "system"].includes(config.scope) ||
		![config.prefix, config.stateDir, config.configHome].every((path) => typeof path === "string" && isAbsolute(path))
	) {
		throw new Error("Invalid Pier Host installation metadata");
	}
	const expected = layout(config.scope, config.prefix, config.configHome, config.app);
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
		const pid = Number(
			control(config, ["show", "-p", "MainPID", "--value", basename(config.serviceFile)]).stdout.trim(),
		);
		try {
			const ready = JSON.parse(readFileSync(join(config.stateDir, "run/host.json"), "utf8")) as {
				pid: number;
				version: string;
			};
			if (pid > 0 && ready.pid === pid && ready.version === config.version) return;
		} catch {
			/* Wait until Host has written its readiness file. */
		}
		if (control(config, ["is-active", "--quiet", basename(config.serviceFile)], false).status !== 0) break;
		await delay(100);
	}
	throw new Error("Pier Host service did not become ready");
}

function unit(config: Installation): string {
	const executable = quoteUnit(join(config.installDir, "current", config.app)).replaceAll("$", "$$");
	return `[Unit]\nDescription=Pier\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${executable} run\nEnvironment=${quoteUnit(`PIER_DIR=${config.stateDir}`)}\nEnvironment=${quoteUnit(`HOME=${homedir()}`)}\nEnvironment=${quoteUnit(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=15\nStandardOutput=null\nStandardError=journal\nUMask=0077\n\n[Install]\nWantedBy=${config.scope === "user" ? "default.target" : "multi-user.target"}\n`;
}

function commandLinks(config: Installation): string[] {
	return [...new Set(["pier", config.app])].map((name) => join(config.binDir, name));
}

function removeCommand(config: Installation, links = commandLinks(config)): void {
	for (const link of links) {
		try {
			if (
				lstatSync(link).isSymbolicLink() &&
				resolve(dirname(link), readlinkSync(link)) === join(config.installDir, "current", config.app)
			)
				rmSync(link);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export async function installHost(
	executable: string,
	args: string[],
	version: string,
	existing?: Installation,
): Promise<Installation> {
	if (process.platform !== "linux") throw new Error("Service installation is supported on Linux");
	const { values } = parseArgs({
		args,
		options: { user: { type: "boolean" }, system: { type: "boolean" }, "no-start": { type: "boolean" } },
	});
	if (values.user && values.system) throw new Error("Choose --user or --system");
	const scope = values.user ? "user" : values.system || process.getuid?.() === 0 ? "system" : "user";
	const prefix = resolve(
		process.env.PIER_PREFIX ??
			process.env.PIER_HOST_PREFIX ??
			(scope === "user" ? join(homedir(), ".local") : "/opt/pier"),
	);
	const configHome = resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
	const paths = layout(scope, prefix, configHome);
	const legacyPrefix = resolve(
		process.env.PIER_PREFIX ?? process.env.PIER_HOST_PREFIX ?? (scope === "user" ? prefix : "/opt/pier-host"),
	);
	const previous =
		existing ??
		readInstallation(paths.installDir) ??
		readInstallation(layout(scope, legacyPrefix, configHome, "pier-host").installDir);
	const config: Installation = previous
		? { ...previous, version }
		: {
				format: 1,
				app: "pier",
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
	const links = commandLinks(config);
	const newLinks: string[] = [];
	for (const link of links) {
		try {
			const stat = lstatSync(link);
			if (
				!stat.isSymbolicLink() ||
				resolve(dirname(link), readlinkSync(link)) !== join(config.installDir, "current", config.app)
			)
				throw new Error(`Will not overwrite ${link}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			newLinks.push(link);
		}
	}
	const link = links[0];
	const available = managerAvailable(config);
	if (!values["no-start"] && !available)
		throw new Error("No systemd manager; use install --no-start, then run pier directly");
	const active =
		previous &&
		available &&
		control(config, ["is-active", "--quiet", basename(config.serviceFile)], false).status === 0;
	if (active) control(config, ["stop", basename(config.serviceFile)]);
	assertStopped(config.stateDir);
	const binary = join(config.installDir, "current", config.app);
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
		for (const newLink of newLinks) symlinkSync(binary, newLink);
		mkdirSync(dirname(config.serviceFile), { recursive: true });
		writeFileSync(config.serviceFile, unit(config), { mode: 0o644 });
		if (available) control(config, ["daemon-reload"]);
		if (!values["no-start"]) {
			attemptedStart = true;
			control(config, ["enable", "--now", basename(config.serviceFile)]);
			await waitReady(config);
		}
		rmSync(backup, { force: true });
	} catch (error) {
		if (available && attemptedStart) {
			// Keep the installed executable if we cannot confirm that the failed service stopped.
			control(config, ["stop", basename(config.serviceFile)]);
		}
		assertStopped(config.stateDir);
		if (previous) {
			removeCommand(config, newLinks);
			if (backupReady) renameSync(backup, binary);
			else rmSync(backup, { force: true });
			rmSync(`${binary}.new`, { force: true });
			writeFileSync(join(config.installDir, "installation.json"), `${JSON.stringify(previous, null, 2)}\n`, {
				mode: 0o600,
			});
			if (oldUnit) writeFileSync(config.serviceFile, oldUnit);
			else rmSync(config.serviceFile, { force: true });
		} else {
			if (available) control(config, ["disable", basename(config.serviceFile)], false);
			removeCommand(config);
			rmSync(config.serviceFile, { force: true });
			rmSync(config.installDir, { recursive: true, force: true });
		}
		if (available) {
			control(config, ["daemon-reload"]);
			if (active) control(config, ["start", basename(config.serviceFile)]);
		}
		throw new Error(
			`Installation failed; ${previous ? "previous binary restored" : "partial installation removed"}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	console.log(`Installed Pier ${version}. Commands: ${link} {cli|start|stop|status|logs|update|uninstall}`);
	if (values["no-start"])
		console.log(`Service was not started. Run ${link} or enable ${basename(config.serviceFile)}.`);
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
	if (managerAvailable(config)) control(config, ["disable", "--now", basename(config.serviceFile)]);
	assertStopped(config.stateDir);
	rmSync(config.serviceFile, { force: true });
	if (managerAvailable(config)) control(config, ["daemon-reload"]);
	removeCommand(config);
	rmSync(config.installDir, { recursive: true, force: true });
	if (purge) rmSync(config.stateDir, { recursive: true, force: true });
	console.log(
		`Pier uninstalled. ${purge ? "Removed" : "Kept"} Pier state: ${config.stateDir}. Shared Agent data and project files were kept.`,
	);
}

export function serviceCommand(config: Installation, command: string): void {
	requirePrivilege(config);
	if (command === "logs") {
		const result = spawnSync(
			"journalctl",
			[...(config.scope === "user" ? ["--user"] : []), "-u", basename(config.serviceFile), "-f"],
			{ stdio: "inherit" },
		);
		process.exitCode = result.status ?? 1;
	} else {
		const result = control(config, [command, basename(config.serviceFile)], false, true);
		process.exitCode = result.status ?? 1;
	}
}

const RELEASES = `https://github.com/${RELEASE_REPOSITORY}/releases`;

function terminalOutput(): Output {
	const tty = process.stderr.isTTY;
	let shown = false;
	const clear = () => {
		if (shown) process.stderr.write("\r\x1b[K");
		shown = false;
	};
	return {
		say(text) {
			clear();
			process.stderr.write(`${text}\n`);
		},
		warn(text) {
			clear();
			process.stderr.write(`${tty ? "\x1b[33mwarning:\x1b[0m" : "warning:"} ${text}\n`);
		},
		...(tty
			? {
					progress(text: string) {
						process.stderr.write(`\r\x1b[K${text}`);
						shown = true;
					},
				}
			: {}),
	};
}

/** A same-user cache directory rather than /tmp, which is often a small tmpfs or noexec. */
function stagingDirectory(): string {
	const configured = process.env.XDG_CACHE_HOME;
	const cache = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
	try {
		mkdirSync(cache, { recursive: true, mode: 0o700 });
		return mkdtempSync(join(cache, "pier-update-"));
	} catch {
		return mkdtempSync(join(tmpdir(), "pier-update-"));
	}
}

export async function updateHost(config: Installation, args: string[]): Promise<void> {
	requirePrivilege(config);
	const { values } = parseArgs({
		args,
		options: {
			version: { type: "string" },
			mirror: { type: "string" },
			force: { type: "boolean" },
			"no-start": { type: "boolean" },
		},
	});
	const mirror = values.mirror ?? process.env.PIER_MIRROR ?? "";
	// Without --mirror, a terminal asks for the route; `auto` and no terminal measure them.
	let pinned = parseMirror(mirror);
	const askRoute = mirror.trim() === "";
	let version = values.version ?? process.env.PIER_VERSION ?? "latest";
	if (version !== "latest" && !version.startsWith("v")) version = `v${version}`;
	if (version !== "latest" && !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
		throw new Error(`Invalid version: ${version} (expected vX.Y.Z)`);
	const output = terminalOutput();
	const release = version === "latest" ? "the latest release" : version;
	output.say(`Checking ${release} of Pier${pinned ? ` (route: ${pinned.name})` : ""}…`);
	const sumsUrl =
		version === "latest"
			? `${RELEASES}/latest/download/SHA256SUMS.txt`
			: `${RELEASES}/download/${version}/SHA256SUMS.txt`;
	const sums = await fetchChecksums(sumsUrl, pinned, output, release);
	const checksums = parseChecksums(sums.text);
	let tag = version;
	if (version === "latest") {
		const suffix = `-linux-${process.arch}`;
		const tags = [...checksums.keys()]
			.filter((file) => file.endsWith(suffix))
			.map((file) => /^pier(?:-host)?-(v\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(file.slice(0, -suffix.length))?.[1])
			.filter((found): found is string => !!found);
		if (tags.length === 0 || new Set(tags).size !== 1)
			throw new Error(`The latest release has no single-file Pier for linux-${process.arch}`);
		tag = tags[0] as string;
	}
	const name = singleFileNames(tag, process.arch).find((candidate) => checksums.has(candidate));
	const checksum = name ? checksums.get(name) : undefined;
	if (!name || !checksum)
		throw new Error(`Pier ${tag} has no single file for linux-${process.arch}; choose another version`);
	const target = tag.slice(1);
	if (!values.force && config.version === target) {
		output.say(`Pier ${tag} is already installed. Check it with: pier status (--force reinstalls)`);
		return;
	}

	const assetUrl = `${RELEASES}/download/${tag}/${name}`;
	const directory = stagingDirectory();
	const keys = terminalKeys();
	try {
		const binary = join(directory, "pier");
		const ask = keys.ask;
		if (askRoute && ask) {
			const suggested = BUILTIN_ROUTES[sums.from.id === "github" ? 0 : 1] as Route;
			const choice = await chooseRoute(ask, suggested, true, output);
			if (choice && choice !== "auto") pinned = choice;
		}
		let routes = routeOrder(pinned);
		if (!pinned) routes = await rankRoutes(routes, assetUrl, sums.from.id === "github", output);
		output.say(
			`Updating Pier ${config.version} to ${target} (linux-${process.arch}) ${routeWhere(routes[0] as Route)}…`,
		);
		if (ask) output.say("  Press s to choose another route; the part already downloaded is kept.");
		try {
			keys.listen?.();
			await downloadWithRoutes({
				url: assetUrl,
				file: binary,
				routes,
				pinned: !!pinned,
				keys,
				output,
				asset: name,
				...(ask
					? {
							choose: async (next: Route) => {
								const choice = await chooseRoute(ask, next, false, output);
								return choice === "auto" ? undefined : choice;
							},
						}
					: {}),
			});
		} finally {
			keys.close();
		}
		output.say(`Downloaded ${name}; verifying…`);
		if ((await fileSha256(binary)) !== checksum) throw new Error("Release checksum mismatch; installation was kept");
		chmodSync(binary, 0o700);
		const check = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 });
		if (check.status !== 0 || ![`pier ${target}`, `pier-host ${target}`].includes(check.stdout.trim()))
			throw new Error(
				`Downloaded Host version check failed${check.error ? ` (${check.error.message}); if ${directory} is mounted noexec, set XDG_CACHE_HOME to another directory` : ""}`,
			);
		process.env.PIER_HOST_PREFIX = config.prefix;
		process.env.XDG_CONFIG_HOME = config.configHome;
		await installHost(binary, [`--${config.scope}`, ...(values["no-start"] ? ["--no-start"] : [])], target, config);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
