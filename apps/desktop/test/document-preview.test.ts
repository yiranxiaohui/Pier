import { describe, expect, it } from "vitest";
import {
	clampZoom,
	documentLink,
	fitWidthScale,
	MAX_ZOOM,
	MIN_ZOOM,
	scopeRootRules,
	stepZoom,
	wheelZoomFactor,
	zoomLabel,
} from "../src/lib/document-preview.ts";

describe("documentLink", () => {
	it("opens web and mail links in the system browser", () => {
		expect(documentLink("https://example.com/a?b=1")).toEqual({ kind: "external", url: "https://example.com/a?b=1" });
		expect(documentLink(" http://example.com ")).toEqual({ kind: "external", url: "http://example.com/" });
		expect(documentLink("mailto:someone@example.com")).toEqual({
			kind: "external",
			url: "mailto:someone@example.com",
		});
	});

	it("jumps to bookmarks inside the document", () => {
		expect(documentLink("#_Toc123")).toEqual({ kind: "anchor", id: "_Toc123" });
		expect(documentLink("#%E7%AC%AC%E4%B8%80%E7%AB%A0")).toEqual({ kind: "anchor", id: "第一章" });
		expect(documentLink("#%E0%A4%A")).toEqual({ kind: "anchor", id: "%E0%A4%A" });
	});

	it("leaves pdf.js's own page links to the viewer", () => {
		expect(documentLink("#page=3", true)).toEqual({ kind: "internal" });
	});

	it("never navigates the app anywhere else", () => {
		for (const href of [
			"",
			null,
			undefined,
			"#",
			"javascript:alert(1)",
			" JavaScript:alert(1)",
			"file:///etc/passwd",
			"data:text/html,<script>alert(1)</script>",
			"relative/path.html",
			"/absolute/path",
			"https://user:secret@example.com/",
			"tauri://localhost/index.html",
		]) {
			expect(documentLink(href)).toEqual({ kind: "ignore" });
		}
	});
});

describe("zoom", () => {
	it("steps through the zoom levels and stops at either end", () => {
		expect(stepZoom(1, 1)).toBe(1.1);
		expect(stepZoom(1, -1)).toBe(0.9);
		expect(stepZoom(0.95, 1)).toBe(1);
		expect(stepZoom(0.95, -1)).toBe(0.9);
		// Steps a level even when the zoom sits just off one (e.g. after fitting the width).
		expect(stepZoom(1.0049, 1)).toBe(1.1);
		expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
		expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
		expect(stepZoom(9, -1)).toBe(MAX_ZOOM);
	});

	it("clamps and labels zoom levels", () => {
		expect(clampZoom(0.01)).toBe(MIN_ZOOM);
		expect(clampZoom(12)).toBe(MAX_ZOOM);
		expect(zoomLabel(1.254)).toBe("125%");
		expect(zoomLabel(0.333)).toBe("33%");
	});

	it("fits pages to the available width, up to a maximum", () => {
		expect(fitWidthScale(400, 800)).toBe(0.5);
		expect(fitWidthScale(1600, 800, 1)).toBe(1);
		expect(fitWidthScale(1600, 800)).toBe(2);
		expect(fitWidthScale(40, 800)).toBe(MIN_ZOOM);
		expect(fitWidthScale(0, 800)).toBeUndefined();
		expect(fitWidthScale(400, 0)).toBeUndefined();
	});

	it("zooms gently for trackpad pinches and by at most a fifth per wheel notch", () => {
		expect(wheelZoomFactor(-3, 0)).toBeCloseTo(1.01, 2);
		expect(wheelZoomFactor(3, 0)).toBeCloseTo(0.99, 2);
		expect(wheelZoomFactor(-100, 0)).toBe(1.25);
		expect(wheelZoomFactor(100, 0)).toBeCloseTo(0.8, 5);
		// Lines and pages (Firefox-style delta modes) count as a full notch too.
		expect(wheelZoomFactor(-3, 1)).toBe(1.25);
		expect(wheelZoomFactor(1, 2)).toBeCloseTo(0.8, 5);
	});
});

describe("scopeRootRules", () => {
	it("moves pdf.js's :root rules onto the preview element", () => {
		const css = ":root{color-scheme:light dark;--a:1}@media (forced-colors:active){:root{--a:2}}.pdfViewer{--b:1}";
		expect(scopeRootRules(css, ":where(.pdf-preview)")).toBe(
			":where(.pdf-preview){color-scheme:light dark;--a:1}@media (forced-colors:active){:where(.pdf-preview){--a:2}}.pdfViewer{--b:1}",
		);
	});
});
