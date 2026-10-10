import type { AccountSite, AccountUser, NewApiToken } from "@pier/protocol";
import { siteAddresses } from "./yunlian.ts";

export type AccountTokenChoice = number | "new";

/** Remember token IDs only; keys stay on the host. */
const STORAGE_KEY = "pier.accountTokens";

/** All lines of the same site share a choice, scoped to the managed computer and account. */
export function accountTokenSelectionKey(node: string, site: AccountSite, user: AccountUser, group: string): string {
	const address = siteAddresses(site.url)
		.map((url) => url.replace(/\/+$/, "").toLowerCase())
		.sort()[0];
	return JSON.stringify([node, address, user.id ?? user.username, group]);
}

function readChoices(): Record<string, AccountTokenChoice> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				([, choice]) => choice === "new" || (typeof choice === "number" && Number.isSafeInteger(choice) && choice > 0),
			),
		);
	} catch {
		return {};
	}
}

export function readAccountTokenChoice(key: string): AccountTokenChoice | undefined {
	return readChoices()[key];
}

export function saveAccountTokenChoice(key: string, choice: AccountTokenChoice): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readChoices(), [key]: choice }));
	} catch {
		// The current page still keeps its choice if storage is unavailable.
	}
}

/** Removed or disabled tokens fall back to an available token, or creation if none remain. */
export function resolveAccountTokenChoice(
	choice: AccountTokenChoice | undefined,
	tokens: ReadonlyArray<Pick<NewApiToken, "id" | "status">>,
): AccountTokenChoice {
	const usable = tokens.filter((token) => token.status === 1);
	if (choice === "new" || (choice !== undefined && usable.some((token) => token.id === choice))) return choice;
	return usable[0]?.id ?? "new";
}
