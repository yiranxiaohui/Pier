import { homedir } from "node:os";
import { join } from "node:path";

/** Pier's own state directory (separate from pi's `~/.pi/agent`). Override with `PIER_DIR`. */
export function defaultPierDir(): string {
	return process.env.PIER_DIR || join(homedir(), ".pier");
}

export function configPath(pierDir: string): string {
	return join(pierDir, "config.json");
}

/** Runtime discovery file written while a host is running (port + local token). */
export function runtimeFilePath(pierDir: string): string {
	return join(pierDir, "run", "host.json");
}

export function locksDir(pierDir: string): string {
	return join(pierDir, "locks");
}

/** Deleted session files, kept so they can be restored by hand. */
export function sessionTrashDir(pierDir: string): string {
	return join(pierDir, "trash", "sessions");
}

/** Ids of archived sessions. */
export function archivedSessionsPath(pierDir: string): string {
	return join(pierDir, "archived-sessions.json");
}

/** Context limits of sessions and the defaults of each runtime (1.64). */
export function contextLimitsPath(pierDir: string): string {
	return join(pierDir, "context-limits.json");
}

/** Host static key for the remote secure channel. */
export function identityPath(pierDir: string): string {
	return join(pierDir, "identity.json");
}

/** Paired remote devices. */
export function devicesPath(pierDir: string): string {
	return join(pierDir, "devices.json");
}

/** Other computers this host paired with as a device. */
export function peersPath(pierDir: string): string {
	return join(pierDir, "peers.json");
}

/** Append-only log of actions taken by remote devices. */
export function auditLogPath(pierDir: string): string {
	return join(pierDir, "audit.log");
}

/** The saved 云链API personal-center login. */
export function accountPath(pierDir: string): string {
	return join(pierDir, "account.json");
}

/** Deleted pi extensions (files or directories), kept so they can be restored by hand. */
export function extensionTrashDir(pierDir: string): string {
	return join(pierDir, "trash", "extensions");
}
