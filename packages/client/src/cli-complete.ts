/**
 * Tab completion and model matching for pier-cli. Pure logic, kept apart from the
 * interactive CLI so it can be tested without a terminal or a running host.
 */

export interface CliModelRef {
	provider: string;
	id: string;
	name: string;
}

/** Lazily loaded data that some arguments complete from. */
export interface CliCompletionSource {
	models(): Promise<readonly CliModelRef[]>;
	thinkingLevels(): Promise<readonly string[]>;
}

/** `[candidates, the text being completed]`, as Node's readline completer expects. */
export type CliCompletion = [string[], string];

/** Slash commands offered by completion; `args` adds a space after a unique match. */
export const CLI_COMMANDS: ReadonlyArray<{ name: string; args: boolean }> = [
	{ name: "help", args: false },
	{ name: "ws", args: true },
	{ name: "sessions", args: false },
	{ name: "new", args: true },
	{ name: "open", args: true },
	{ name: "status", args: false },
	{ name: "rename", args: true },
	{ name: "fork", args: true },
	{ name: "steer", args: true },
	{ name: "follow", args: true },
	{ name: "abort", args: false },
	{ name: "compact", args: true },
	{ name: "models", args: false },
	{ name: "model", args: true },
	{ name: "thinking", args: true },
	{ name: "allow", args: true },
	{ name: "deny", args: true },
	{ name: "yes", args: false },
	{ name: "no", args: false },
	{ name: "answer", args: true },
	{ name: "cancel", args: false },
	{ name: "remote", args: true },
	{ name: "pair", args: true },
	{ name: "devices", args: false },
	{ name: "revoke", args: true },
	{ name: "drop", args: false },
	{ name: "quit", args: false },
];

const POLICIES = ["ask", "smart", "auto"];

/** Words that take a further argument get a trailing space when they are the only match. */
function complete(words: readonly string[], partial: string, withArgs: ReadonlySet<string> = new Set()): CliCompletion {
	const hits = [...new Set(words)].filter((word) => word.startsWith(partial));
	const only = hits.length === 1 ? hits[0] : undefined;
	if (only !== undefined && withArgs.has(only)) return [[`${only} `], partial];
	return [hits, partial];
}

/** `provider/id` references, plus bare ids once something without a `/` is typed. */
export function modelCandidates(models: readonly CliModelRef[], partial: string): string[] {
	const refs = models.map((m) => `${m.provider}/${m.id}`);
	if (!partial || partial.includes("/")) return [...new Set(refs)];
	return [...new Set([...refs, ...models.map((m) => m.id)])];
}

/** Complete a pier-cli input line (Node readline completer semantics). */
export async function completeCliLine(line: string, source: CliCompletionSource): Promise<CliCompletion> {
	const input = line.trimStart();
	if (!input)
		return complete(
			CLI_COMMANDS.map((c) => `/${c.name}`),
			"",
		);
	if (!input.startsWith("/")) return [[], line];
	const firstSpace = input.search(/\s/);
	if (firstSpace < 0) {
		const names = CLI_COMMANDS.map((c) => `/${c.name}`);
		return complete(names, input, new Set(CLI_COMMANDS.filter((c) => c.args).map((c) => `/${c.name}`)));
	}
	const command = input.slice(1, firstSpace);
	const args = input.slice(firstSpace).trimStart().split(/\s+/);
	const partial = args.pop() ?? "";
	const before = args;
	switch (command) {
		case "model":
			if (before.length) return [[], partial];
			return complete(modelCandidates(await source.models(), partial), partial);
		case "thinking":
			if (before.length) return [[], partial];
			return complete(await source.thinkingLevels(), partial);
		case "ws":
			if (!before.length) return complete(["add", "use", "policy"], partial, new Set(["add", "use", "policy"]));
			if ((before[0] === "policy" && before.length === 1) || (before[0] === "add" && before.length === 2))
				return complete(POLICIES, partial);
			return [[], partial];
		case "remote":
			return before.length ? [[], partial] : complete(["on", "off", "port"], partial, new Set(["port"]));
		case "pair":
			return before.length ? [[], partial] : complete(["yes", "no"], partial);
		case "allow":
			return before.length ? [[], partial] : complete(["session"], partial);
		default:
			return [[], partial];
	}
}

export type ModelMatch<T> = { model: T } | { error: string; none?: true };

const SHOWN_MATCHES = 8;

/**
 * Resolve the argument of `/model`: a number from the last listing, `provider/id`, an id
 * or name, or (case-insensitively) a fragment that occurs in exactly one model.
 */
export function matchModel<T extends CliModelRef>(models: readonly T[], arg: string): ModelMatch<T> {
	const ref = (m: T) => `${m.provider}/${m.id}`;
	if (/^\d+$/.test(arg)) {
		const model = models[Number(arg) - 1];
		return model ? { model } : { error: `No model #${arg}. Type /model to list the models.` };
	}
	const q = arg.toLowerCase();
	const exact = models.find((m) => ref(m).toLowerCase() === q);
	if (exact) return { model: exact };
	for (const key of ["id", "name"] as const) {
		const hits = models.filter((m) => m[key].toLowerCase() === q);
		if (hits.length === 1 && hits[0]) return { model: hits[0] };
		if (hits.length > 1)
			return { error: `Several models are called ${arg}: ${hits.map(ref).join(", ")}. Use /model <provider>/<id>.` };
	}
	const hits = models.filter((m) => ref(m).toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
	if (hits.length === 1 && hits[0]) return { model: hits[0] };
	if (hits.length > 1) {
		const shown = hits.slice(0, SHOWN_MATCHES).map(ref).join(", ");
		const more = hits.length > SHOWN_MATCHES ? ` and ${hits.length - SHOWN_MATCHES} more` : "";
		return { error: `${arg} matches ${hits.length} models: ${shown}${more}. Be more specific or press Tab.` };
	}
	return { error: `No model matches ${arg}. Type /model to list the models.`, none: true };
}
