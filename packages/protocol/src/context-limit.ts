import { MAX_CONTEXT_LIMIT } from "./domain.ts";

/**
 * Parse a context limit (1.64) typed by a user: a number of tokens, optionally with `k`, `m` or
 * `万` (`200k`, `1.5m`, `20万`, `200000`, `200,000`). Returns undefined when it is not one, or
 * above {@link MAX_CONTEXT_LIMIT}.
 */
export function parseContextLimit(text: string): number | undefined {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([km万]?)\s*$/i.exec(text.replace(/[,_，\s](?=\d)/g, ""));
	if (!match) return undefined;
	const unit = (match[2] ?? "").toLowerCase();
	const scale = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : unit === "万" ? 10_000 : 1;
	const value = Math.round(Number(match[1]) * scale);
	return Number.isSafeInteger(value) && value > 0 && value <= MAX_CONTEXT_LIMIT ? value : undefined;
}
