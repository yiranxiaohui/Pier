/**
 * The user's current `PATH` on Windows.
 *
 * A program keeps the environment it was started with, so Node.js, Git or pi installed while
 * Pier runs stay "not found" for the Host until it restarts, although a new terminal finds them.
 * Terminals build their `PATH` from the system and user variables in the registry; the Host reads
 * those again (`refreshWindowsPath`) and appends the `PATH` entries it does not have yet, keeping
 * its own entries and their order.
 */
import { execFile } from "node:child_process";

/** The `REG_SZ` / `REG_EXPAND_SZ` environment variables in the registry, not expanded. */
export interface WindowsEnvironment {
	/** `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`. */
	machine: Record<string, string>;
	/** `HKCU\Environment`. */
	user: Record<string, string>;
}

const MARKER = "__PIER_ENVIRONMENT__";
const READ_TIMEOUT_MS = 10_000;

// Only single quotes: the script travels base64-encoded (-EncodedCommand), and its output as
// base64 of UTF-8, so neither the command line nor the console code page can garble paths.
const READ_SCRIPT = `$ErrorActionPreference = 'Stop'
function Read-Environment($root, $path) {
  $values = @{}
  $key = $root.OpenSubKey($path)
  if ($null -eq $key) { return $values }
  try {
    foreach ($name in $key.GetValueNames()) {
      if (-not $name) { continue }
      $kind = $key.GetValueKind($name)
      if (($kind -ne [Microsoft.Win32.RegistryValueKind]::String) -and ($kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString)) { continue }
      $values[$name] = [string]$key.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
  } finally {
    $key.Close()
  }
  return $values
}
$environment = @{
  machine = Read-Environment ([Microsoft.Win32.Registry]::LocalMachine) 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  user = Read-Environment ([Microsoft.Win32.Registry]::CurrentUser) 'Environment'
}
$json = ConvertTo-Json -InputObject $environment -Compress -Depth 3
[Console]::Out.Write('${MARKER}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

function stringRecord(value: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (!value || typeof value !== "object") return result;
	for (const [name, entry] of Object.entries(value)) if (typeof entry === "string") result[name] = entry;
	return result;
}

/** Parse the output of the registry script; undefined when it printed something else. */
export function parseWindowsEnvironment(output: string): WindowsEnvironment | undefined {
	const match = new RegExp(`${MARKER}([A-Za-z0-9+/=]+)`).exec(output);
	if (!match?.[1]) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as {
			machine?: unknown;
			user?: unknown;
		};
		return { machine: stringRecord(parsed.machine), user: stringRecord(parsed.user) };
	} catch {
		return undefined;
	}
}

/** Read the system and user environment variables from the registry (Windows PowerShell). */
export function readWindowsEnvironment(timeoutMs = READ_TIMEOUT_MS): Promise<WindowsEnvironment | undefined> {
	const encoded = Buffer.from(READ_SCRIPT, "utf16le").toString("base64");
	return new Promise((resolve) => {
		try {
			execFile(
				"powershell.exe",
				["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
				{ timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
				(error, stdout) => resolve(error ? undefined : parseWindowsEnvironment(String(stdout))),
			);
		} catch {
			resolve(undefined);
		}
	});
}

/** Windows' `%NAME%` expansion: names are case-insensitive, unknown names stay as they are. */
export function expandWindowsVariables(value: string, lookup: (name: string) => string | undefined): string {
	return value.replace(/%([^%]+)%/g, (whole, name: string) => lookup(name) ?? whole);
}

function variableValue(variables: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(variables)) if (key.toLowerCase() === lower) return value;
	return undefined;
}

/**
 * The `PATH` a new terminal gets: the system `Path`, then the user's, with `%VARIABLES%` expanded
 * from the registry (system, then user) and otherwise from `env`.
 */
export function windowsRegistryPath(environment: WindowsEnvironment, env: NodeJS.ProcessEnv): string {
	const variables = new Map<string, string>();
	for (const [name, value] of Object.entries(env)) if (value !== undefined) variables.set(name.toLowerCase(), value);
	const lookup = (name: string) => variables.get(name.toLowerCase());
	for (const scope of [environment.machine, environment.user]) {
		for (const [name, value] of Object.entries(scope)) {
			if (name.toLowerCase() !== "path") variables.set(name.toLowerCase(), expandWindowsVariables(value, lookup));
		}
	}
	return [environment.machine, environment.user]
		.map((scope) => variableValue(scope, "Path"))
		.filter((value): value is string => !!value)
		.map((value) => expandWindowsVariables(value, lookup))
		.join(";");
}

/** How Windows compares `PATH` entries: case-insensitively, without quotes or a trailing slash. */
function entryKey(entry: string): string {
	return entry
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.replace(/[\\/]+$/, "")
		.toLowerCase();
}

/**
 * `current` with the entries of `fresh` it lacks appended. Entries still holding an unknown
 * `%VARIABLE%` are skipped: no directory has that name.
 */
export function appendWindowsPath(current: string | undefined, fresh: string): { path: string; added: string[] } {
	const entries = (current ?? "").split(";").filter((entry) => entry.trim());
	const seen = new Set(entries.map(entryKey));
	const added: string[] = [];
	for (const entry of fresh.split(";")) {
		const key = entryKey(entry);
		if (!key || seen.has(key) || /%[^%]+%/.test(entry)) continue;
		seen.add(key);
		added.push(entry.trim());
	}
	return { path: [...entries, ...added].join(";"), added };
}

export interface RefreshWindowsPathOptions {
	/** The environment to update (default `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Reads the registry (tests). */
	read?: () => Promise<WindowsEnvironment | undefined>;
}

/**
 * Append the `PATH` entries of the current system and user variables that `env` lacks, so this
 * process finds programs installed since it started. Returns the added entries, or undefined
 * when the registry could not be read.
 */
export async function refreshWindowsPath(options: RefreshWindowsPathOptions = {}): Promise<string[] | undefined> {
	const env = options.env ?? process.env;
	const environment = await (options.read ?? (() => readWindowsEnvironment()))();
	if (!environment) return undefined;
	// `process.env` ignores the case of names on Windows; a plain copy keeps `Path`.
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
	const { path, added } = appendWindowsPath(env[key], windowsRegistryPath(environment, env));
	if (added.length) env[key] = path;
	return added;
}
