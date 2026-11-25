import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "../runtimes/types.ts";
import { tokens } from "../runtimes/usage-files.ts";

type Row = Record<string, unknown>;
type Sqlite = typeof import("node:sqlite");

let sqlite: Promise<Sqlite | undefined> | undefined;

/** Node's (and Bun's) built-in SQLite, loaded on first use. */
function loadSqlite(): Promise<Sqlite | undefined> {
	sqlite ??= import("node:sqlite").catch(() => undefined);
	return sqlite;
}

/** Hermes' home: `HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on Windows and `~/.hermes` elsewhere. */
export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.HERMES_HOME?.trim();
	if (configured) return configured.replace(/^~(?=$|[\\/])/, homedir());
	const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
	if (process.platform === "win32") {
		const base = env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
		return join(base, `hermes${suffix}`);
	}
	return join(homedir(), `.hermes${suffix}`);
}

/** The `state.db` of Hermes' home and of each of its profiles. */
export async function hermesDatabases(home: string): Promise<string[]> {
	const databases = [join(home, "state.db")];
	try {
		for (const name of (await readdir(join(home, "profiles"))).sort()) {
			databases.push(join(home, "profiles", name, "state.db"));
		}
	} catch {
		// No profiles.
	}
	return databases.filter((path) => existsSync(path));
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const seconds = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** Hermes records 0 for models it has no prices for, which is not a cost. */
function cost(value: unknown, output: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && !(value === 0 && output > 0)
		? value
		: undefined;
}

function hermesRecord(
	row: Row,
	at: number,
	model: unknown,
	provider: unknown,
	spent: unknown,
): UsageRecord | undefined {
	const record: UsageRecord = {
		at,
		model: text(model) ?? "",
		...(text(provider) ? { provider: text(provider) as string } : {}),
		// Hermes keeps cached prompt tokens out of `input_tokens`, as pi does.
		input: tokens(row.input_tokens),
		output: tokens(row.output_tokens),
		cacheRead: tokens(row.cache_read_tokens),
		cacheWrite: tokens(row.cache_write_tokens),
		requests: Math.max(1, tokens(row.api_call_count)),
	};
	if (record.input + record.output + record.cacheRead + record.cacheWrite === 0) return undefined;
	const usd = cost(spent, record.output);
	if (usd !== undefined) record.cost = usd;
	return record;
}

/**
 * The usage of a Hermes session and of the sessions it delegated to (`parent_session_id`), from
 * Hermes' `state.db` (`usage.stats`, 1.68). Hermes keeps totals per session (and per model), not
 * per request, so a session's usage counts on the day of its last activity. Undefined when the
 * database has no such session.
 */
export async function readHermesUsage(database: string, sessionId: string): Promise<UsageRecord[] | undefined> {
	const module = await loadSqlite();
	if (!module) throw new Error("这台电脑上的 Pier 无法读取 SQLite，不能统计 Hermes 的用量");
	const db = new module.DatabaseSync(database, { readOnly: true });
	try {
		const tables = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => r.name),
		);
		if (!tables.has("sessions")) return undefined;
		const sessions = db
			.prepare(
				`WITH RECURSIVE tree(id, depth) AS (
					SELECT id, 0 FROM sessions WHERE id = ?
					UNION SELECT s.id, tree.depth + 1 FROM sessions s JOIN tree ON s.parent_session_id = tree.id WHERE tree.depth < 20
				)
				SELECT sessions.* FROM sessions JOIN tree ON sessions.id = tree.id`,
			)
			.all(sessionId) as Row[];
		if (sessions.length === 0) return undefined;
		const perModel = tables.has("session_model_usage")
			? db.prepare("SELECT * FROM session_model_usage WHERE session_id = ?")
			: undefined;
		const records: UsageRecord[] = [];
		for (const session of sessions) {
			const at =
				(seconds(session.last_activity_at) ?? seconds(session.ended_at) ?? seconds(session.started_at) ?? 0) * 1000;
			const id = String(session.id);
			const models = (perModel?.all(id) ?? []) as Row[];
			const add = (record: UsageRecord | undefined, model: string) => {
				if (!record) return;
				// A session listed on its own as well counts once.
				record.key = `${id}\n${model}`;
				records.push(record);
			};
			if (models.length > 0) {
				for (const row of models) {
					add(hermesRecord(row, at, row.model, row.billing_provider, row.estimated_cost_usd), String(row.model));
				}
			} else {
				add(
					hermesRecord(
						session,
						at,
						session.model,
						session.billing_provider,
						session.actual_cost_usd ?? session.estimated_cost_usd,
					),
					String(session.model ?? ""),
				);
			}
		}
		return records;
	} finally {
		db.close();
	}
}
