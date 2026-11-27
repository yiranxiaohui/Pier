/**
 * Loads pdf.js for the PDF preview, once and only when a PDF is opened: the library and its
 * viewer (the legacy build, which polyfills what older system webviews lack), its style sheet
 * scoped to the preview, and the worker that parses documents. A failed load is forgotten so the
 * next PDF tries again.
 */
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { scopeRootRules } from "./document-preview.ts";

export type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
export type PdfViewerModule = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

/** The class of the element holding a PDF preview; pdf.js's style sheet applies inside it. */
export const PDF_PREVIEW_CLASS = "pdf-preview";

let loading: Promise<{ pdfjs: PdfJs; viewer: PdfViewerModule }> | undefined;

export function loadPdfJs(): Promise<{ pdfjs: PdfJs; viewer: PdfViewerModule }> {
	loading ??= (async () => {
		// The viewer reads the library from `globalThis.pdfjsLib`, which pdf.mjs sets: load it first.
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const [viewer, css] = await Promise.all([
			import("pdfjs-dist/legacy/web/pdf_viewer.mjs"),
			import("pdfjs-dist/legacy/web/pdf_viewer.css?inline"),
		]);
		pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
		const style = document.createElement("style");
		style.dataset.pier = "pdf-viewer";
		style.textContent = scopeRootRules(css.default, `:where(.${PDF_PREVIEW_CLASS})`);
		document.head.append(style);
		return { pdfjs, viewer };
	})().catch((error: unknown) => {
		loading = undefined;
		throw error;
	});
	return loading;
}

/** Where the files of `vite.config.ts`'s `pdfjsAssets` are served, as absolute URLs for the worker. */
function assetUrl(folder: string): string {
	return new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, document.baseURI).href;
}

/**
 * Fetches CMaps, standard fonts and decoders for the worker on the main thread, the same way on
 * every webview (Tauri serves the app from `tauri://` on macOS and Linux, which pdf.js's worker
 * does not fetch from itself).
 */
class AppBinaryDataFactory {
	private readonly urls: Record<string, string | null | undefined>;

	constructor(urls: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
		this.urls = urls;
	}

	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const base = this.urls[kind];
		if (!base) throw new Error(`pdf.js asked for unknown data: ${kind}`);
		const response = await fetch(`${base}${filename}`);
		if (!response.ok) throw new Error(`Unable to load ${base}${filename}: HTTP ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}
}

/** The parameters of `getDocument` for a PDF read into memory. */
export function documentParams(data: Uint8Array) {
	return {
		data,
		cMapUrl: assetUrl("cmaps"),
		cMapPacked: true,
		standardFontDataUrl: assetUrl("standard_fonts"),
		wasmUrl: assetUrl("wasm"),
		useWorkerFetch: false,
		BinaryDataFactory: AppBinaryDataFactory,
		enableXfa: false,
	};
}
