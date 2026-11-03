import { describe, expect, it } from "vitest";
import { cleanupPercent, cleanupRequest } from "../src/components/SessionCleanup.tsx";

describe("cleanupRequest", () => {
	const now = Date.parse("2026-09-30T12:00:00.000Z");

	it("selects sessions older than the chosen number of days", () => {
		expect(cleanupRequest("archive", 7, false, now)).toEqual({
			action: "archive",
			modifiedBefore: "2026-09-23T12:00:00.000Z",
		});
	});

	it("selects every session for 0 days", () => {
		expect(cleanupRequest("delete", 0, false, now)).toEqual({ action: "delete" });
	});

	it("limits deleting to archived sessions only when asked", () => {
		expect(cleanupRequest("delete", 1, true, now)).toEqual({
			action: "delete",
			modifiedBefore: "2026-09-29T12:00:00.000Z",
			scope: "archived",
		});
		// Archiving ignores the archived-only option.
		expect(cleanupRequest("archive", 0, true, now)).toEqual({ action: "archive" });
	});
});

describe("cleanupPercent", () => {
	it("is unknown until the host reports a total", () => {
		expect(cleanupPercent(undefined)).toBeUndefined();
		expect(cleanupPercent({ done: 0, total: 0 })).toBeUndefined();
	});

	it("rounds the share of sessions handled", () => {
		expect(cleanupPercent({ done: 0, total: 48 })).toBe(0);
		expect(cleanupPercent({ done: 12, total: 48 })).toBe(25);
		expect(cleanupPercent({ done: 1, total: 3 })).toBe(33);
		expect(cleanupPercent({ done: 48, total: 48 })).toBe(100);
	});
});
