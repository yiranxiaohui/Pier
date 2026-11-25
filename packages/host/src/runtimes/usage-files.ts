import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { UsageRecord } from "./types.ts";

/** Each line of a text file, streamed (session files can be tens of megabytes). */
export async function* fileLines(path: string): AsyncGenerator<string> {
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) yield line;
	} finally {
		lines.close();
		stream.destroy();
	}
}

/** A JSON object parsed from a line, or undefined. */
export function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** A finite, non-negative token count, else 0. */
export function tokens(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/** An epoch-millisecond time from a number (ms) or an ISO string, else undefined. */
export function timeOf(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const at = Date.parse(value);
		if (Number.isFinite(at)) return at;
	}
	return undefined;
}

/**
 * What was read from session files, kept while a file's size and modification time stay the
 * same: statistics are read again and again, and most sessions do not change between them.
 */
export class FileCache<T> {
	private readonly files = new Map<string, { mtimeMs: number; size: number; value: T }>();

	constructor(private readonly missing: () => T) {}

	/** What `parse` reads from `path`; `missing()` for a file that does not exist. */
	async read(path: string, parse: (path: string) => Promise<T>): Promise<T> {
		let info: { mtimeMs: number; size: number };
		try {
			info = await stat(path);
		} catch {
			this.files.delete(path);
			return this.missing();
		}
		const cached = this.files.get(path);
		if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;
		const value = await parse(path);
		this.files.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
		return value;
	}
}

/** The usage records of session files (see {@link FileCache}). */
export class FileUsageCache extends FileCache<UsageRecord[]> {
	constructor() {
		super(() => []);
	}
}
