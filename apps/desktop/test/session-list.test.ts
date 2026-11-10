import { describe, expect, it } from "vitest";
import { SESSION_PAGE, SESSION_PREVIEW, sessionWindow } from "../src/lib/session-list.ts";

describe("sessionWindow", () => {
	it("lists a short list whole, with nothing to show or fold", () => {
		expect(sessionWindow(0, SESSION_PREVIEW, -1)).toEqual({ shown: 0, more: 0, collapsible: false });
		expect(sessionWindow(4, SESSION_PREVIEW, -1)).toEqual({ shown: 4, more: 0, collapsible: false });
		expect(sessionWindow(SESSION_PREVIEW, SESSION_PREVIEW, -1)).toEqual({
			shown: SESSION_PREVIEW,
			more: 0,
			collapsible: false,
		});
	});

	it("previews the first sessions of a long list", () => {
		expect(sessionWindow(100, SESSION_PREVIEW, -1)).toEqual({ shown: SESSION_PREVIEW, more: 94, collapsible: false });
		expect(sessionWindow(100, SESSION_PREVIEW, 2)).toEqual({ shown: SESSION_PREVIEW, more: 94, collapsible: false });
	});

	it("keeps the open session listed below the preview", () => {
		expect(sessionWindow(100, SESSION_PREVIEW, 9)).toEqual({ shown: 10, more: 90, collapsible: false });
	});

	it("adds a page at a time and folds back to the preview", () => {
		const total = SESSION_PREVIEW + 2 * SESSION_PAGE + 10;
		const first = sessionWindow(total, SESSION_PREVIEW, -1);
		const second = sessionWindow(total, first.shown + SESSION_PAGE, -1);
		expect(second).toEqual({
			shown: SESSION_PREVIEW + SESSION_PAGE,
			more: SESSION_PAGE + 10,
			collapsible: true,
		});
		const third = sessionWindow(total, second.shown + SESSION_PAGE, -1);
		expect(third).toEqual({ shown: SESSION_PREVIEW + 2 * SESSION_PAGE, more: 10, collapsible: true });
		const last = sessionWindow(total, third.shown + SESSION_PAGE, -1);
		expect(last).toEqual({ shown: total, more: 0, collapsible: true });
		// 收起 sets the limit back to the preview.
		expect(sessionWindow(total, SESSION_PREVIEW, -1)).toEqual(first);
	});

	it("pages on from the open session when it lies further down", () => {
		const open = sessionWindow(100, SESSION_PREVIEW, 49);
		expect(sessionWindow(100, open.shown + SESSION_PAGE, 49)).toEqual({ shown: 80, more: 20, collapsible: true });
	});
});
