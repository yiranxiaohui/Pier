import type { AccountSite, AccountUser } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	accountTokenSelectionKey,
	readAccountTokenChoice,
	resolveAccountTokenChoice,
	saveAccountTokenChoice,
} from "../src/lib/account-tokens.ts";

const site = { url: "https://api.yunnet.top" } as AccountSite;
const user = { id: 1, username: "xiaohui" } as AccountUser;
const key = accountTokenSelectionKey("ubuntu", site, user, "Claude");
const tokens = [
	{ id: 10, name: "Hermes", status: 1 },
	{ id: 20, name: "自用", status: 1 },
];

beforeEach(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("personal center token choices", () => {
	it("restores 自用 on a new visit even when Hermes is first or the list is reordered", () => {
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), tokens)).toBe(10);
		saveAccountTokenChoice(key, 20);
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), tokens)).toBe(20);
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), [...tokens].reverse())).toBe(20);
	});

	it("isolates hosts, accounts, sites and groups without overwriting another choice", () => {
		const otherKeys = [
			accountTokenSelectionKey("local", site, user, "Claude"),
			accountTokenSelectionKey("ubuntu", site, { ...user, id: 2 }, "Claude"),
			accountTokenSelectionKey("ubuntu", { ...site, url: "https://other.example" }, user, "Claude"),
			accountTokenSelectionKey("ubuntu", site, user, "Codex-Pro"),
		];
		saveAccountTokenChoice(key, 20);
		for (const other of otherKeys) {
			expect(readAccountTokenChoice(other)).toBeUndefined();
			saveAccountTokenChoice(other, 10);
		}
		expect(readAccountTokenChoice(key)).toBe(20);
		for (const other of otherKeys) expect(readAccountTokenChoice(other)).toBe(10);
	});

	it("keeps the choice across line switches and falls back to username for older hosts", () => {
		saveAccountTokenChoice(key, 20);
		const international = accountTokenSelectionKey(
			"ubuntu",
			{ ...site, url: "https://api.syixn.com/" },
			user,
			"Claude",
		);
		expect(readAccountTokenChoice(international)).toBe(20);
		const oldHostUser = { ...user, id: undefined };
		const oldKey = accountTokenSelectionKey("ubuntu", site, oldHostUser, "Claude");
		saveAccountTokenChoice(oldKey, 20);
		expect(
			readAccountTokenChoice(accountTokenSelectionKey("ubuntu", site, { ...oldHostUser, username: "other" }, "Claude")),
		).toBeUndefined();
	});

	it("remembers creation and then the created token ID", () => {
		saveAccountTokenChoice(key, "new");
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), tokens)).toBe("new");
		saveAccountTokenChoice(key, 30);
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), [...tokens, { id: 30, status: 1 }])).toBe(30);
	});

	it.each([2, 3, 4])("falls back if the saved token is removed or has status %s", (status) => {
		saveAccountTokenChoice(key, 20);
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), [tokens[0]])).toBe(10);
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), [tokens[0], { id: 20, status }])).toBe(10);
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), [{ id: 20, status }])).toBe("new");
		expect(resolveAccountTokenChoice(readAccountTokenChoice(key), [])).toBe("new");
	});

	it.each(["{", "null", "[]", "42", JSON.stringify({ [key]: "20" }), JSON.stringify({ [key]: -1 })])(
		"ignores invalid saved choices %s",
		(saved) => {
			localStorage.setItem("pier.accountTokens", saved);
			expect(resolveAccountTokenChoice(readAccountTokenChoice(key), tokens)).toBe(10);
			saveAccountTokenChoice(key, 20);
			expect(readAccountTokenChoice(key)).toBe(20);
		},
	);

	it("keeps the page usable when storage cannot be read or written", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("unavailable");
			},
			setItem: () => {
				throw new Error("full");
			},
		});
		expect(readAccountTokenChoice(key)).toBeUndefined();
		expect(() => saveAccountTokenChoice(key, 20)).not.toThrow();
		expect(resolveAccountTokenChoice(20, tokens)).toBe(20);
	});
});
