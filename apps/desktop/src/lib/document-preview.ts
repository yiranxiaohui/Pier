/**
 * Pure helpers of the PDF and Word previews (components/PdfPreview.tsx, DocxPreview.tsx): links
 * inside documents, zoom steps, and keeping pdf.js's style sheet out of the rest of the app.
 */

/** What clicking a link inside a document does. */
export type DocumentLink =
	| { kind: "anchor"; id: string }
	| { kind: "external"; url: string }
	/** Left to the viewer: pdf.js handles its own `#…` links to pages and destinations. */
	| { kind: "internal" }
	| { kind: "ignore" };

/**
 * Sort a link found in a document. `#name` jumps within it (a Word bookmark, or a pdf.js internal
 * link when `viewerAnchors`); web and mail links open in the system browser; anything else — an
 * empty `href` reloading the app, `javascript:`, `file:` or relative paths — must not navigate the
 * webview and is ignored.
 */
export function documentLink(href: string | null | undefined, viewerAnchors = false): DocumentLink {
	const value = href?.trim() ?? "";
	if (value.startsWith("#")) {
		if (viewerAnchors) return { kind: "internal" };
		let id = value.slice(1);
		try {
			id = decodeURIComponent(id);
		} catch {}
		return id ? { kind: "anchor", id } : { kind: "ignore" };
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { kind: "ignore" };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password)
		return { kind: "external", url: url.href };
	if (url.protocol === "mailto:") return { kind: "external", url: url.href };
	return { kind: "ignore" };
}

/** Zoom levels the − / + buttons step through, as in pdf.js's own viewer. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
export const MIN_ZOOM = ZOOM_STEPS[0] as number;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;

/** The next zoom step above (`direction` 1) or below (-1) `scale`, staying within the steps. */
export function stepZoom(scale: number, direction: 1 | -1): number {
	if (direction > 0) return ZOOM_STEPS.find((step) => step > scale * 1.01) ?? MAX_ZOOM;
	return [...ZOOM_STEPS].reverse().find((step) => step < scale * 0.99) ?? MIN_ZOOM;
}

export function clampZoom(scale: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** A zoom level as the toolbar shows it. */
export function zoomLabel(scale: number): string {
	return `${Math.round(scale * 100)}%`;
}

/**
 * The scale that fits a page `pageWidth` wide into `available` pixels, at most `max` (so that
 * "自动" keeps small pages at their size in a wide panel), and undefined before the preview has
 * been laid out.
 */
export function fitWidthScale(available: number, pageWidth: number, max = MAX_ZOOM): number | undefined {
	if (available <= 0 || pageWidth <= 0) return undefined;
	return clampZoom(Math.min(max, available / pageWidth));
}

/** How much one Ctrl/⌘ + wheel event zooms: smooth for trackpad pinches, ±20% for a wheel notch. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaY * (deltaMode === 1 ? 30 : deltaMode === 2 ? 300 : 1);
	return Math.min(1.25, Math.max(0.8, Math.exp(-pixels / 300)));
}

/**
 * pdf.js's viewer style sheet declares its variables (and `color-scheme: light dark`) on `:root`,
 * which would restyle the whole app; scope them to the preview's own element instead.
 */
export function scopeRootRules(css: string, selector: string): string {
	return css.replace(/:root\b/g, selector);
}
