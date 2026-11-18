import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionScope, PierProtocolError, type PiSettingsFile } from "@pier/protocol";
import lockfile from "proper-lockfile";
import { PI_CONFIG_DIR_NAME } from "./sdk.ts";

/** One change of `settings.update`: set `value` at `path`, or remove the key when `value` is undefined. */
export interface SettingsChange {
	path: string[];
	value?: unknown;
}

type JsonObject = Record<string, unknown>;

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseSettings(text: string): { settings?: JsonObject; error?: string } {
	if (!text.trim()) return { settings: {} };
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isObject(parsed)) return { error: "The settings file must contain a JSON object" };
		return { settings: parsed };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Copy a JSON value so later edits cannot reach into the caller's objects. */
function cloneJson(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Apply one change in place. Removing a key also drops the objects it leaves empty. */
export function applySettingsChange(settings: JsonObject, change: SettingsChange): void {
	const { path } = change;
	if (!path.length || path.some((key) => !key || RESERVED_KEYS.has(key))) {
		throw new PierProtocolError("BAD_REQUEST", `Invalid settings key ${path.join(".")}`);
	}
	const parents: JsonObject[] = [settings];
	let node = settings;
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i] as string;
		const next = Object.hasOwn(node, key) ? node[key] : undefined;
		if (next === undefined) {
			if (change.value === undefined) return;
			const created: JsonObject = {};
			node[key] = created;
			node = created;
		} else if (isObject(next)) {
			node = next;
		} else {
			throw new PierProtocolError("BAD_REQUEST", `Setting ${path.slice(0, i + 1).join(".")} is not an object`);
		}
		parents.push(node);
	}
	const last = path[path.length - 1] as string;
	if (change.value !== undefined) {
		node[last] = cloneJson(change.value);
		return;
	}
	delete node[last];
	// Drop the parent objects that became empty, innermost first.
	for (let i = parents.length - 1; i > 0; i--) {
		if (Object.keys(parents[i] as JsonObject).length) break;
		delete (parents[i - 1] as JsonObject)[path[i - 1] as string];
	}
}

/** Serialize the way pi does (two-space indent), keeping a trailing newline the file had. */
function serialize(settings: JsonObject, previous: string | undefined): string {
	const text = JSON.stringify(settings, null, 2);
	return previous?.endsWith("\n") ? `${text}\n` : text;
}

/**
 * Reads and edits pi's settings files directly, keeping keys Pier does not know about. Writes
 * take pi's own file lock (`proper-lockfile` on the settings path), so they do not interleave
 * with a pi process saving its settings at the same time.
 */
export class PiSettingsFiles {
	constructor(private readonly agentDir: string) {}

	/** Path of the user settings, or of a workspace's project settings. */
	pathFor(scope: ExtensionScope, workspacePath?: string): string {
		if (scope === "user") return join(this.agentDir, "settings.json");
		if (!workspacePath) throw new PierProtocolError("BAD_REQUEST", "Project scope needs a workspaceId");
		return join(workspacePath, PI_CONFIG_DIR_NAME, "settings.json");
	}

	read(scope: ExtensionScope, workspacePath?: string): PiSettingsFile {
		const path = this.pathFor(scope, workspacePath);
		let text: string | undefined;
		this.withLock(path, (current) => {
			text = current;
			return undefined;
		});
		return this.describe(scope, path, text);
	}

	/** Apply `changes` to the file as it is on disk now. */
	update(
		scope: ExtensionScope,
		workspacePath: string | undefined,
		changes: SettingsChange[],
	): { file: PiSettingsFile; changed: boolean } {
		const path = this.pathFor(scope, workspacePath);
		let changed = false;
		let final: string | undefined;
		this.withLock(path, (current) => {
			final = current;
			const { settings, error } = parseSettings(current ?? "");
			if (!settings) {
				throw new PierProtocolError("CONFLICT", `${path} is not valid JSON (${error}); fix the file first`);
			}
			const before = JSON.stringify(settings);
			for (const change of changes) applySettingsChange(settings, change);
			if (JSON.stringify(settings) === before) return undefined;
			changed = true;
			final = serialize(settings, current);
			return final;
		});
		return { file: this.describe(scope, path, final), changed };
	}

	/** Replace the file with `text` (a JSON object), optionally only if it was not modified since `expectedModifiedAt`. */
	write(
		scope: ExtensionScope,
		workspacePath: string | undefined,
		text: string,
		expectedModifiedAt?: string,
	): { file: PiSettingsFile; changed: boolean } {
		const path = this.pathFor(scope, workspacePath);
		const content = stripBom(text);
		const { settings, error } = parseSettings(content);
		if (!settings || !content.trim()) {
			throw new PierProtocolError("BAD_REQUEST", `Invalid settings: ${error ?? "the file must contain a JSON object"}`);
		}
		let changed = false;
		let final: string | undefined;
		this.withLock(path, (current) => {
			final = current;
			if (expectedModifiedAt !== undefined) {
				const modifiedAt = this.modifiedAt(path);
				if (modifiedAt !== expectedModifiedAt) {
					throw new PierProtocolError("CONFLICT", `${path} changed on disk`, modifiedAt ? { modifiedAt } : {});
				}
			}
			if (current === content) return undefined;
			changed = true;
			final = content;
			return content;
		});
		return { file: this.describe(scope, path, final), changed };
	}

	private modifiedAt(path: string): string | undefined {
		try {
			return statSync(path).mtime.toISOString();
		} catch {
			return undefined;
		}
	}

	private describe(scope: ExtensionScope, path: string, text: string | undefined): PiSettingsFile {
		if (text === undefined) return { scope, path, exists: false, text: "", settings: {} };
		const { settings, error } = parseSettings(text);
		const modifiedAt = this.modifiedAt(path);
		return {
			scope,
			path,
			exists: true,
			text,
			...(settings ? { settings } : {}),
			...(error ? { error } : {}),
			...(modifiedAt ? { modifiedAt } : {}),
		};
	}

	/** Mirrors pi's `FileSettingsStorage.withLock`: lock only files that exist or are about to be written. */
	private withLock(path: string, fn: (current: string | undefined) => string | undefined): void {
		let release: (() => void) | undefined;
		try {
			const exists = existsSync(path);
			if (exists) release = acquireLock(path);
			const current = exists ? stripBom(readFileSync(path, "utf8")) : undefined;
			const next = fn(current);
			if (next !== undefined) {
				mkdirSync(dirname(path), { recursive: true });
				release ??= acquireLock(path);
				writeFileSync(path, next, "utf8");
			}
		} catch (error) {
			if (error instanceof PierProtocolError) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			throw new PierProtocolError(
				code === "EACCES" || code === "EPERM" || code === "EROFS" ? "FORBIDDEN" : "INTERNAL",
				`Could not access ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			release?.();
		}
	}
}

function acquireLock(path: string): () => void {
	const attempts = 10;
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= attempts) {
				if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
					throw new PierProtocolError("CONFLICT", `${path} is locked by another pi process; try again`);
				}
				throw error;
			}
			const until = Date.now() + 20;
			while (Date.now() < until) {
				// pi waits synchronously too; the lock is only held while a file is written.
			}
		}
	}
}
