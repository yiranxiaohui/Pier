/**
 * Agent runtime selection for pier-cli: parsing `/new [--agent <agent>] [name]` and resolving
 * what the user typed to one of the runtimes the host reports. Pure logic, testable without a
 * terminal or a running host.
 */
import type { AgentRuntimeId, AgentRuntimeInfo } from "@pier/protocol";

/** Display names for the built-in runtimes, used until `runtime.list` has been fetched. */
const KNOWN_NAMES: Record<string, string> = { pi: "pi", "claude-code": "Claude Code", codex: "Codex" };

export type CliRuntimeRef = Pick<AgentRuntimeInfo, "id" | "name">;

/** Display name of a runtime id; sessions from hosts older than 1.22 have none and are pi. */
export function runtimeName(id: AgentRuntimeId | undefined, runtimes: readonly CliRuntimeRef[] = []): string {
	const runtime = id ?? "pi";
	return runtimes.find((r) => r.id === runtime)?.name ?? KNOWN_NAMES[runtime] ?? runtime;
}

/** Arguments of `/new`: an optional `--agent <agent>` / `-a <agent>` / `--agent=<agent>` and a name. */
export function parseNewArgs(arg: string): { agent?: string; name?: string } {
	const words = arg.split(/\s+/).filter(Boolean);
	let agent: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (word === "--agent" || word === "-a") {
			const value = words[++i];
			if (!value) throw new Error("Usage: /new [--agent <agent>] [name]");
			agent = value;
		} else if (word.startsWith("--agent=")) {
			agent = word.slice("--agent=".length);
			if (!agent) throw new Error("Usage: /new [--agent <agent>] [name]");
		} else rest.push(word);
	}
	const name = rest.join(" ");
	return { ...(agent ? { agent } : {}), ...(name ? { name } : {}) };
}

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Resolve an agent reference: a number from `/agents`, a runtime id, a display name (case and
 * spacing ignored, so `claude code` / `ClaudeCode` work), or a prefix of exactly one of them
 * (`claude`, `cod`).
 */
export function resolveRuntime<T extends CliRuntimeRef>(runtimes: readonly T[], ref: string): T {
	const usage = `Choose one of: ${runtimes.map((r) => r.id).join(", ")} (see /agents)`;
	const index = Number(ref);
	if (/^\d+$/.test(ref)) {
		const runtime = runtimes[index - 1];
		if (!runtime) throw new Error(`No agent ${ref}. ${usage}`);
		return runtime;
	}
	const wanted = squash(ref);
	if (!wanted) throw new Error(usage);
	const exact = runtimes.find((r) => squash(r.id) === wanted || squash(r.name) === wanted);
	if (exact) return exact;
	const prefixed = runtimes.filter((r) => squash(r.id).startsWith(wanted) || squash(r.name).startsWith(wanted));
	if (prefixed.length === 1) return prefixed[0] as T;
	if (prefixed.length > 1)
		throw new Error(`"${ref}" matches ${prefixed.map((r) => r.id).join(", ")}. Be more specific.`);
	throw new Error(`Unknown agent "${ref}". ${usage}`);
}

/** Refuse a runtime that cannot create sessions, saying why (e.g. its CLI is not installed). */
export function requireAvailable<T extends AgentRuntimeInfo>(runtime: T): T {
	if (runtime.available) return runtime;
	throw new Error(`${runtime.name} is not available on this computer${runtime.reason ? `: ${runtime.reason}` : ""}`);
}
