import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml, patch as patchToml, stringify as stringifyToml } from "@decimalturn/toml-patch";
import {
	type AgentConfigFile,
	type AgentConfigFormat,
	type AgentConfigRuntime,
	type AgentConfigScope,
	PierProtocolError,
} from "@pier/protocol";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { applySettingsChange, type SettingsChange } from "../pi/settings-files.ts";
import { patchJsonc } from "./jsonc-patch.ts";

type JsonObject = Record<string, unknown>;

/**
 * One scope's file: `name`, unless one of `prefer` exists. `prefer` lists the names the runtime
 * reads, the one whose settings win first, so edits land where they take effect.
 */
interface FileSpec {
	name: string;
	prefer?: readonly string[];
}

interface Layout {
	format: AgentConfigFormat;
	/** Lowest precedence first. */
	scopes: AgentConfigScope[];
	/** The user file, relative to the configuration directory. */
	user: FileSpec;
	/** Workspace files, relative to the workspace. */
	workspace: Partial<Record<AgentConfigScope, FileSpec>>;
	/** Settings a new file starts with (OpenCode's `$schema`). */
	newFile?: JsonObject;
}

/** Where Claude Code, Codex and OpenCode keep their settings (see their settings references). */
const LAYOUTS: Record<AgentConfigRuntime, Layout> = {
	"claude-code": {
		format: "json",
		scopes: ["user", "project", "local"],
		user: { name: "settings.json" },
		workspace: {
			project: { name: join(".claude", "settings.json") },
			local: { name: join(".claude", "settings.local.json") },
		},
	},
	codex: {
		format: "toml",
		scopes: ["user", "project"],
		user: { name: "config.toml" },
		workspace: { project: { name: join(".codex", "config.toml") } },
	},
	// OpenCode merges `config.json`, `opencode.json` and `opencode.jsonc` of its global directory in
	// this order, later files winning, and the project's `opencode.json` and `opencode.jsonc` alike.
	opencode: {
		format: "jsonc",
		scopes: ["user", "project"],
		user: { name: "opencode.json", prefer: ["opencode.jsonc", "opencode.json", "config.json"] },
		workspace: { project: { name: "opencode.json", prefer: ["opencode.jsonc", "opencode.json"] } },
		newFile: { $schema: "https://opencode.ai/config.json" },
	},
};

function filePath(directory: string, spec: FileSpec): string {
	const found = spec.prefer?.find((name) => existsSync(join(directory, name)));
	return join(directory, found ?? spec.name);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The parsed settings as plain JSON: TOML dates become ISO strings, big integers strings. */
function toJson(value: JsonObject): JsonObject {
	return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

/** JSON text of a value with object keys sorted, to compare settings regardless of key order. */
function canonical(value: JsonObject): string {
	return JSON.stringify(toJson(value), (_key, v: unknown) =>
		isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
	);
}

/** `line:column` (1-based) of an offset in `text`. */
function position(text: string, offset: number): string {
	const before = text.slice(0, offset).split("\n");
	return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
}

/** JSON with comments and trailing commas, as OpenCode reads it. */
function parseJsoncText(text: string): { settings?: JsonObject; error?: string } {
	const errors: ParseError[] = [];
	const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
	const first = errors[0];
	if (first) return { error: `${printParseErrorCode(first.error)} at ${position(text, first.offset)}` };
	if (!isObject(parsed)) return { error: "The settings file must contain a JSON object" };
	return { settings: parsed };
}

function parseText(format: AgentConfigFormat, text: string): { settings?: JsonObject; error?: string } {
	if (!text.trim()) return { settings: {} };
	try {
		if (format === "toml") return { settings: parseToml(text) as JsonObject };
		if (format === "jsonc") return parseJsoncText(text);
		const parsed = JSON.parse(text) as unknown;
		if (!isObject(parsed)) return { error: "The settings file must contain a JSON object" };
		return { settings: parsed };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** TOML has no null; reject values it cannot store before touching the file. */
function checkTomlValue(value: unknown, path: string[]): void {
	if (value === null) throw new PierProtocolError("BAD_REQUEST", `TOML cannot store null (${path.join(".")})`);
	if (Array.isArray(value)) for (const item of value) checkTomlValue(item, path);
	else if (isObject(value)) for (const item of Object.values(value)) checkTomlValue(item, path);
}

/** New top-level tables become `[sections]`, deeper ones inline tables. */
const PATCH_FORMAT = { inlineTableStart: 2 };

/** A TOML key, quoted unless it is a bare key. */
function tomlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** The key path of a `[table]` / `[[array]]` header line, or undefined for other lines. */
function headerPath(line: string): string[] | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[")) return undefined;
	try {
		let node: unknown = parseToml(trimmed);
		const path: string[] = [];
		while (isObject(node) && Object.keys(node).length === 1) {
			const key = Object.keys(node)[0] as string;
			path.push(key);
			node = node[key];
		}
		return path.length ? path : undefined;
	} catch {
		return undefined;
	}
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
	return prefix.length <= path.length && prefix.every((key, i) => path[i] === key);
}

/** Tables in `desired` that `original` lacks although their (non-root) parent table exists. */
function newSubtables(original: JsonObject, desired: JsonObject, path: string[] = []): string[][] {
	const found: string[][] = [];
	for (const [key, value] of Object.entries(desired)) {
		if (!isObject(value)) continue;
		const before = Object.hasOwn(original, key) ? original[key] : undefined;
		if (before === undefined) {
			if (path.length) found.push([...path, key]);
		} else if (isObject(before)) {
			found.push(...newSubtables(before, value, [...path, key]));
		}
	}
	return found;
}

/**
 * Patch `previous` to `settings`, writing tables added inside existing ones as `[a.b]` sections
 * after their siblings' sections (the library would add `a.b = { … }` lines instead). Only
 * parents that already have sections qualify: tables defined inline must stay inline.
 */
function patchWithSections(previous: string, settings: JsonObject): string | undefined {
	const original = parseText("toml", previous).settings;
	if (!original) return undefined;
	const lines = previous.split("\n");
	const headers = lines.map(headerPath);
	const added = newSubtables(original, settings).filter((path) => {
		const parent = path.slice(0, -1);
		return headers.some((header) => header && startsWith(header, parent));
	});
	// A new top-level table holding only tables (`model_providers`): its tables' sections alone.
	const newRoots = Object.keys(settings).filter((key) => {
		const value = settings[key];
		return (
			!Object.hasOwn(original, key) &&
			isObject(value) &&
			Object.keys(value).length > 0 &&
			Object.values(value).every((child) => isObject(child) && Object.keys(child).length > 0)
		);
	});
	for (const key of newRoots) added.push(...Object.keys(settings[key] as JsonObject).map((child) => [key, child]));
	if (!added.length) return undefined;
	let rest = settings;
	for (const path of added) rest = withoutPath(rest, path);
	for (const key of newRoots) rest = withoutPath(rest, [key]);
	const out = patchToml(previous, rest, PATCH_FORMAT).split("\n");
	for (const path of added) {
		const value = path.reduce<unknown>((node, key) => (node as JsonObject)[key], settings);
		const body = stringifyToml({ __pier__: value }).split("\n");
		if (body[0]?.trim() !== "[__pier__]") return undefined;
		const section = [`[${path.map(tomlKey).join(".")}]`, ...body.slice(1)];
		while (section.length && !section[section.length - 1]?.trim()) section.pop();
		// After the last section of the parent: before the next header and the comments above it.
		const parent = path.slice(0, -1);
		const outHeaders = out.map(headerPath);
		const last = outHeaders.findLastIndex((header) => header !== undefined && startsWith(header, parent));
		if (last < 0 && !(parent.length === 1 && newRoots.includes(parent[0] as string))) return undefined;
		let at = last < 0 ? out.length : outHeaders.findIndex((header, i) => i > last && header !== undefined);
		if (at < 0) at = out.length;
		while (at > last + 1 && /^\s*(#.*)?$/.test(out[at - 1] ?? "")) at--;
		const insert = at > 0 ? ["", ...section] : section;
		if (out[at]?.trim()) insert.push("");
		out.splice(at, 0, ...insert);
	}
	return out.join("\n");
}

/** A copy of `object` without the key at `path`, copying only the objects along the path. */
function withoutPath(object: JsonObject, path: readonly string[]): JsonObject {
	const [key, ...rest] = path as [string, ...string[]];
	const copy = { ...object };
	if (!rest.length) delete copy[key];
	else if (isObject(copy[key])) copy[key] = withoutPath(copy[key], rest);
	return copy;
}

/**
 * The changes that turn `before` into `after`, as `[path, value]` pairs (`undefined` removes the
 * key): objects present in both are compared key by key, anything else is replaced whole.
 */
function differences(before: JsonObject, after: JsonObject, path: string[] = []): Array<[string[], unknown]> {
	const found: Array<[string[], unknown]> = [];
	for (const key of Object.keys(before)) {
		if (!Object.hasOwn(after, key)) found.push([[...path, key], undefined]);
	}
	for (const [key, value] of Object.entries(after)) {
		const old = Object.hasOwn(before, key) ? before[key] : undefined;
		if (isObject(old) && isObject(value)) found.push(...differences(old, value, [...path, key]));
		else if (old === undefined || JSON.stringify(old) !== JSON.stringify(value)) found.push([[...path, key], value]);
	}
	return found;
}

/** Edit the JSONC document in place so comments, ordering and formatting survive. */
function patchJsoncDocument(previous: string, settings: JsonObject): string {
	const original = parseJsoncText(previous).settings ?? {};
	let text = previous;
	for (const [path, value] of differences(original, settings)) text = patchJsonc(text, path, value);
	return text;
}

function serialize(format: AgentConfigFormat, settings: JsonObject, previous: string | undefined): string {
	if (format === "jsonc") {
		// A new file is written like the JSON ones; an existing one is edited where it changes.
		if (!previous?.trim()) return `${JSON.stringify(settings, null, 2)}\n`;
		const text = patchJsoncDocument(previous, settings);
		const reparsed = parseJsoncText(text);
		if (reparsed.settings && canonical(reparsed.settings) === canonical(settings)) return text;
		throw new PierProtocolError("INTERNAL", "Could not update the JSONC file without changing other settings");
	}
	if (format === "toml") {
		// Edit the existing document so comments, ordering and formatting survive. New tables inside
		// existing ones (another `[model_providers.x]`) become sections next to their siblings; if
		// that does not reproduce the settings exactly, fall back to the library's own placement.
		for (const candidate of [
			patchWithSections(previous ?? "", settings),
			patchToml(previous ?? "", settings, PATCH_FORMAT),
		]) {
			if (candidate === undefined) continue;
			// A new file ends with a newline, like the ones Codex writes.
			const text = !previous?.trim() && candidate && !candidate.endsWith("\n") ? `${candidate}\n` : candidate;
			const reparsed = parseText("toml", text);
			if (reparsed.settings && canonical(reparsed.settings) === canonical(settings)) return text;
		}
		throw new PierProtocolError("INTERNAL", "Could not update the TOML file without changing other settings");
	}
	// Claude Code writes two-space indented JSON; keep a trailing newline the file had.
	const text = JSON.stringify(settings, null, 2);
	return previous === undefined || previous.endsWith("\n") ? `${text}\n` : text;
}

/**
 * Reads and edits Claude Code's `settings.json` files, Codex's `config.toml` files and OpenCode's
 * `opencode.json(c)` files directly, keeping keys Pier does not know about (and, for TOML and
 * JSONC, comments and formatting). None of these CLIs locks its files, so writes are plain
 * replacements.
 */
export class AgentConfigFiles {
	constructor(private readonly configDirs: Record<AgentConfigRuntime, () => string>) {}

	configDir(runtime: AgentConfigRuntime): string {
		return this.configDirs[runtime]();
	}

	format(runtime: AgentConfigRuntime): AgentConfigFormat {
		return LAYOUTS[runtime].format;
	}

	scopes(runtime: AgentConfigRuntime): AgentConfigScope[] {
		return [...LAYOUTS[runtime].scopes];
	}

	pathFor(runtime: AgentConfigRuntime, scope: AgentConfigScope, workspacePath?: string): string {
		const layout = LAYOUTS[runtime];
		if (scope === "user") return filePath(this.configDir(runtime), layout.user);
		const spec = layout.workspace[scope];
		if (!spec) throw new PierProtocolError("BAD_REQUEST", `${runtime} has no ${scope} settings`);
		if (!workspacePath) throw new PierProtocolError("BAD_REQUEST", `The ${scope} scope needs a workspaceId`);
		return filePath(workspacePath, spec);
	}

	read(runtime: AgentConfigRuntime, scope: AgentConfigScope, workspacePath?: string): AgentConfigFile {
		const path = this.pathFor(runtime, scope, workspacePath);
		return this.describe(runtime, scope, path, this.readText(path));
	}

	/** Apply `changes` to the file as it is on disk now. */
	update(
		runtime: AgentConfigRuntime,
		scope: AgentConfigScope,
		workspacePath: string | undefined,
		changes: SettingsChange[],
	): { file: AgentConfigFile; changed: boolean } {
		const format = this.format(runtime);
		const path = this.pathFor(runtime, scope, workspacePath);
		if (format === "toml") for (const change of changes) checkTomlValue(change.value, change.path);
		const current = this.readText(path);
		const { settings, error } = parseText(format, current ?? "");
		if (!settings) {
			throw new PierProtocolError("CONFLICT", `${path} cannot be parsed (${error}); fix the file first`);
		}
		const before = JSON.stringify(toJson(settings));
		for (const change of changes) applySettingsChange(settings, change);
		if (JSON.stringify(toJson(settings)) === before) {
			return { file: this.describe(runtime, scope, path, current), changed: false };
		}
		const start = LAYOUTS[runtime].newFile;
		const text = serialize(format, current?.trim() || !start ? settings : { ...start, ...settings }, current);
		this.writeText(path, text);
		return { file: this.describe(runtime, scope, path, text), changed: true };
	}

	/** Replace the file with `text`, optionally only if it was not modified since `expectedModifiedAt`. */
	write(
		runtime: AgentConfigRuntime,
		scope: AgentConfigScope,
		workspacePath: string | undefined,
		text: string,
		expectedModifiedAt?: string,
	): { file: AgentConfigFile; changed: boolean } {
		const format = this.format(runtime);
		const path = this.pathFor(runtime, scope, workspacePath);
		const content = stripBom(text);
		const { settings, error } = parseText(format, content);
		if (!settings || (format !== "toml" && !content.trim())) {
			throw new PierProtocolError("BAD_REQUEST", `Invalid settings: ${error ?? "the file must contain a JSON object"}`);
		}
		if (expectedModifiedAt !== undefined) {
			const modifiedAt = this.modifiedAt(path);
			if (modifiedAt !== expectedModifiedAt) {
				throw new PierProtocolError("CONFLICT", `${path} changed on disk`, modifiedAt ? { modifiedAt } : {});
			}
		}
		const current = this.readText(path);
		if (current === content) return { file: this.describe(runtime, scope, path, current), changed: false };
		this.writeText(path, content);
		return { file: this.describe(runtime, scope, path, content), changed: true };
	}

	private readText(path: string): string | undefined {
		try {
			return existsSync(path) ? stripBom(readFileSync(path, "utf8")) : undefined;
		} catch (error) {
			throw accessError(path, error);
		}
	}

	private writeText(path: string, text: string): void {
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text, "utf8");
		} catch (error) {
			throw accessError(path, error);
		}
	}

	private modifiedAt(path: string): string | undefined {
		try {
			return statSync(path).mtime.toISOString();
		} catch {
			return undefined;
		}
	}

	private describe(
		runtime: AgentConfigRuntime,
		scope: AgentConfigScope,
		path: string,
		text: string | undefined,
	): AgentConfigFile {
		if (text === undefined) return { scope, path, exists: false, text: "", settings: {} };
		const { settings, error } = parseText(this.format(runtime), text);
		const modifiedAt = this.modifiedAt(path);
		return {
			scope,
			path,
			exists: true,
			text,
			...(settings ? { settings: toJson(settings) } : {}),
			...(error ? { error } : {}),
			...(modifiedAt ? { modifiedAt } : {}),
		};
	}
}

function accessError(path: string, error: unknown): PierProtocolError {
	if (error instanceof PierProtocolError) return error;
	const code = (error as NodeJS.ErrnoException).code;
	return new PierProtocolError(
		code === "EACCES" || code === "EPERM" || code === "EROFS" ? "FORBIDDEN" : "INTERNAL",
		`Could not access ${path}: ${error instanceof Error ? error.message : String(error)}`,
	);
}
