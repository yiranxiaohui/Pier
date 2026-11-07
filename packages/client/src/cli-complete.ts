/**
 * Tab completion and model matching for pier-cli. Pure logic, kept apart from the
 * interactive CLI so it can be tested without a terminal or a running host.
 */

export interface CliModelRef {
	provider: string;
	id: string;
	name: string;
}

/** The subdirectories of one directory on the host (`host.listDirectories`). */
export interface CliDirectoryListing {
	home: string;
	separator: string;
	entries: ReadonlyArray<{ name: string }>;
}

/** Lazily loaded data that some arguments complete from. */
export interface CliCompletionSource {
	models(): Promise<readonly CliModelRef[]>;
	thinkingLevels(): Promise<readonly string[]>;
	/** Ids of the agent runtimes that can create sessions (`/new -a`, `/models <agent>`). */
	agents(): Promise<readonly string[]>;
	/**
	 * Labels of the items that commands refer to by their 1-based number, in the order the
	 * command numbers them: the workspace's sessions (`/open`), workspaces (`/ws use`), paired
	 * devices (`/revoke`), the session's fork points (`/fork`) and the options of the pending
	 * select request (`/answer`).
	 */
	sessions(): Promise<readonly string[]>;
	workspaces(): Promise<readonly string[]>;
	devices(): Promise<readonly string[]>;
	forkPoints(): Promise<readonly string[]>;
	answerOptions(): Promise<readonly string[]>;
	/** Subdirectories of an absolute directory on the host (its home directory without one). */
	directories(path?: string): Promise<CliDirectoryListing | undefined>;
}

/** `[candidates, the text being completed]`, as Node's readline completer expects. */
export type CliCompletion = [string[], string];

/** Slash commands offered by completion; `args` adds a space after a unique match. */
export const CLI_COMMANDS: ReadonlyArray<{ name: string; args: boolean }> = [
	{ name: "help", args: false },
	{ name: "ws", args: true },
	{ name: "agents", args: false },
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
	{ name: "models", args: true },
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

/** Longest label shown for a numbered item; longer ones are cut with `…`. */
const LABEL_WIDTH = 80;

/** `text` on one line, cut to `width` characters. */
export function oneLine(text: string, width = LABEL_WIDTH): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

/**
 * Complete a 1-based item number. A single match completes to its number; several are offered
 * as `n. label`, which readline lists on a second Tab. Every entry starts with the typed digits
 * and the typed number's own entry continues with `.` where the others continue with a digit,
 * so their common prefix is exactly what was typed and readline leaves the line alone.
 */
export function completeNumbered(labels: readonly string[], partial: string): CliCompletion {
	if (!/^\d*$/.test(partial)) return [[], partial];
	const hits = labels.map((label, i) => ({ ref: String(i + 1), label })).filter((hit) => hit.ref.startsWith(partial));
	const only = hits.length === 1 ? hits[0] : undefined;
	if (only) return [[only.ref], partial];
	return [hits.map((hit) => `${hit.ref}. ${oneLine(hit.label)}`), partial];
}

/**
 * What a listed candidate puts in place of the text being completed: a numbered entry
 * (`3. label`, see `completeNumbered`) stands for its number.
 */
export function candidateValue(candidate: string, partial: string): string {
	const numbered = /^\d*$/.test(partial) ? /^(\d+)\. /.exec(candidate) : null;
	return numbered ? (numbered[1] as string) : candidate;
}

/**
 * Complete a directory on the host: an absolute path, or one under `~` (the host's home
 * directory). An empty argument completes to the home directory; hidden directories are
 * offered once the name starts with `.`.
 */
export async function completeDirectory(partial: string, source: CliCompletionSource): Promise<CliCompletion> {
	const none: CliCompletion = [[], partial];
	const tilde = partial === "~" || /^~[\\/]/.test(partial);
	const home = !partial || tilde ? await source.directories() : undefined;
	if (!partial) return home ? [[withSeparator(home.home, home.separator)], partial] : none;
	if (tilde && !home) return none;
	if (partial === "~" && home) return [[`~${home.separator}`], partial];
	const windows = /^[A-Za-z]:[\\/]/.test(partial) || partial.startsWith("\\\\");
	if (!tilde && !windows && !partial.startsWith("/")) return none;
	// `/` separates on every host, `\` only on Windows: POSIX names may contain it.
	const cut =
		windows || home?.separator === "\\"
			? Math.max(partial.lastIndexOf("/"), partial.lastIndexOf("\\"))
			: partial.lastIndexOf("/");
	const dir = partial.slice(0, cut + 1);
	const name = partial.slice(cut + 1);
	const listing = await source.directories(home ? home.home + dir.slice(1) : dir);
	if (!listing) return none;
	const separator = dir.at(-1) ?? listing.separator;
	const hits = listing.entries
		.filter((entry) => entry.name.startsWith(name) && (name.startsWith(".") || !entry.name.startsWith(".")))
		.map((entry) => `${dir}${entry.name}${separator}`);
	return complete(hits, partial);
}

function withSeparator(path: string, separator: string): string {
	return path.endsWith(separator) ? path : `${path}${separator}`;
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
		case "models":
			if (before.length) return [[], partial];
			return complete(await source.agents(), partial);
		case "new": {
			// `/new [-a|--agent <agent>|--agent=<agent>] [name]`: only the agent completes.
			const previous = before.at(-1);
			if (previous === "-a" || previous === "--agent") return complete(await source.agents(), partial);
			if (partial.startsWith("--agent="))
				return complete(
					(await source.agents()).map((agent) => `--agent=${agent}`),
					partial,
				);
			if (partial.startsWith("-") && !before.some((word) => word.startsWith("-")))
				return complete(["-a", "--agent"], partial, new Set(["-a", "--agent"]));
			return [[], partial];
		}
		case "thinking":
			if (before.length) return [[], partial];
			return complete(await source.thinkingLevels(), partial);
		case "open":
			return before.length ? [[], partial] : completeNumbered(await source.sessions(), partial);
		case "revoke":
			return before.length ? [[], partial] : completeNumbered(await source.devices(), partial);
		case "fork":
			return before.length ? [[], partial] : completeNumbered(await source.forkPoints(), partial);
		case "answer":
			return before.length ? [[], partial] : completeNumbered(await source.answerOptions(), partial);
		case "ws":
			if (!before.length) return complete(["add", "use", "policy"], partial, new Set(["add", "use", "policy"]));
			if (before[0] === "add" && before.length === 1) return completeDirectory(partial, source);
			if (before[0] === "use" && before.length === 1) return completeNumbered(await source.workspaces(), partial);
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
