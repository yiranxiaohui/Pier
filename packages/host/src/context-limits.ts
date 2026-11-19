import { existsSync, readFileSync } from "node:fs";
import { type AgentRuntimeId, MAX_CONTEXT_LIMIT } from "@pier/protocol";
import { z } from "zod";
import { writePrivateFile } from "./config.ts";

const Limit = z.number().int().positive().max(MAX_CONTEXT_LIMIT);

const ContextLimitsFileSchema = z.object({
	version: z.literal(1),
	/** Runtime id → the limit its new sessions start with. */
	defaults: z.record(z.string(), Limit),
	/** `<runtime>:<session id>` → the session's limit. */
	sessions: z.record(z.string(), Limit),
});

function key(runtime: AgentRuntimeId, sessionId: string): string {
	return `${runtime}:${sessionId}`;
}

/**
 * Context limits (`contextLimit.set`, 1.64), in `~/.pier/context-limits.json`: each session's
 * limit, and the limit new sessions of a runtime start with. They are Pier's own settings, so
 * the agents' session files and configuration stay untouched.
 */
export class ContextLimitStore {
	private readonly defaults: Map<string, number>;
	private readonly sessions: Map<string, number>;

	constructor(
		private readonly path: string | undefined,
		private readonly log: (message: string) => void = () => {},
	) {
		const loaded = this.load();
		this.defaults = new Map(Object.entries(loaded?.defaults ?? {}));
		this.sessions = new Map(Object.entries(loaded?.sessions ?? {}));
	}

	private load(): z.infer<typeof ContextLimitsFileSchema> | undefined {
		if (!this.path || !existsSync(this.path)) return undefined;
		try {
			const parsed = ContextLimitsFileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
			if (parsed.success) return parsed.data;
			this.log(`ignoring invalid ${this.path}: ${parsed.error.message}`);
		} catch (error) {
			this.log(`ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : error}`);
		}
		return undefined;
	}

	private save(): void {
		if (!this.path) return;
		const content = {
			version: 1,
			defaults: Object.fromEntries(this.defaults),
			sessions: Object.fromEntries(this.sessions),
		};
		try {
			writePrivateFile(this.path, `${JSON.stringify(content, null, 2)}\n`);
		} catch (error) {
			this.log(`saving ${this.path} failed: ${error instanceof Error ? error.message : error}`);
		}
	}

	/** The session's limit, if it has one. */
	get(runtime: AgentRuntimeId, sessionId: string): number | undefined {
		return this.sessions.get(key(runtime, sessionId));
	}

	/** Set (or with `undefined` clear) the session's limit. */
	set(runtime: AgentRuntimeId, sessionId: string, limit: number | undefined): void {
		const k = key(runtime, sessionId);
		if (this.sessions.get(k) === limit) return;
		if (limit === undefined) this.sessions.delete(k);
		else this.sessions.set(k, limit);
		this.save();
	}

	/** The limit new sessions of `runtime` start with. */
	defaultFor(runtime: AgentRuntimeId): number | undefined {
		return this.defaults.get(runtime);
	}

	setDefault(runtime: AgentRuntimeId, limit: number | undefined): void {
		if (this.defaults.get(runtime) === limit) return;
		if (limit === undefined) this.defaults.delete(runtime);
		else this.defaults.set(runtime, limit);
		this.save();
	}
}
