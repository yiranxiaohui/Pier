import { useCallback, useEffect, useRef, useState } from "react";
import { clampZoom, documentLink, fitWidthScale, stepZoom, wheelZoomFactor } from "../lib/document-preview.ts";
import { useStore } from "../lib/store.tsx";
import { DocumentToolbar, ZoomControls } from "./DocumentToolbar.tsx";
import { IconAlert, IconLoader } from "./Icons.tsx";

type DocxState = { phase: "loading" } | { phase: "ready" } | { phase: "error"; message: string };

/** "自动" fits the page into the preview up to its real size; "适合宽度" lets it grow to fill it. */
type ZoomMode = "auto" | "page-width" | undefined;

/** The space around the pages, inside the shadow root (see `SHADOW_STYLE`). */
const PAGE_GUTTER = 16;

/**
 * Overrides docx-preview's own wrapper style (grey, centred pages that overflow to the left when
 * zoomed in) so the pages sit on the preview's background and can always be scrolled to.
 */
const SHADOW_STYLE = `
.docx-wrapper {
	box-sizing: border-box;
	width: max-content;
	min-width: 100%;
	padding: ${PAGE_GUTTER}px ${PAGE_GUTTER}px 0;
	background: transparent;
}
.docx-wrapper > section.docx {
	margin-bottom: ${PAGE_GUTTER}px;
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(0, 0, 0, 0.06);
}
a[href] {
	cursor: pointer;
}
`;

/** docx-preview's options: pages as in Word, without anything that loads or runs other content. */
const DOCX_OPTIONS = {
	className: "docx",
	inWrapper: true,
	breakPages: true,
	renderHeaders: true,
	renderFooters: true,
	renderFootnotes: true,
	renderEndnotes: true,
	// An altChunk is arbitrary HTML, which docx-preview puts in an unsandboxed iframe.
	renderAltChunks: false,
	renderComments: false,
	renderChanges: false,
	// Embedded fonts would load as @font-face, which shadow roots ignore.
	ignoreFonts: true,
	// Images as data: URLs, not blob: URLs that docx-preview never revokes.
	useBase64URL: true,
	experimental: false,
};

/**
 * Strips what a document should never bring into the app: scripts, frames, plugins and inline
 * event handlers (the packaged app's CSP blocks them too). Links stay; clicks on them are handled.
 */
function sanitize(nodes: Node[]) {
	for (const node of nodes) {
		if (!(node instanceof Element)) continue;
		for (const element of [node, ...node.querySelectorAll("*")]) {
			if (/^(script|iframe|frame|object|embed|base|meta|link)$/i.test(element.localName)) {
				element.remove();
				continue;
			}
			for (const { name } of [...element.attributes]) {
				if (/^on/i.test(name) || name === "target" || name === "formaction") element.removeAttribute(name);
			}
		}
	}
}

/**
 * A Word document (.docx) read into memory, laid out page by page with docx-preview: text,
 * styles, numbering, tables, images, headers, footers and footnotes, with its text selectable.
 * The document lives in a shadow root, so its styles stay out of the app; links inside it jump to
 * their bookmark, web links open in the system browser. Zoom with the toolbar or Ctrl/⌘ + wheel.
 * docx-preview loads on first use, so the app starts without it.
 */
export function DocxPreview({ data }: { data: Blob }) {
	const store = useStore();
	const scroller = useRef<HTMLDivElement>(null);
	const host = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<DocxState>({ phase: "loading" });
	const [scale, setScale] = useState(1);
	const [mode, setMode] = useState<ZoomMode>("auto");
	/** The widest page with its gutters at 100%, measured once rendered; 0 while hidden. */
	const pageWidth = useRef(0);
	const scaleRef = useRef(scale);
	scaleRef.current = scale;
	const modeRef = useRef(mode);
	modeRef.current = mode;

	const measure = useCallback(() => {
		const element = host.current;
		const pages = element?.shadowRoot?.querySelectorAll<HTMLElement>("section.docx");
		if (!element || !pages?.length) return;
		// Measure at 100% so the result does not depend on how the current zoom is reported.
		const zoom = element.style.zoom;
		element.style.zoom = "1";
		const widest = Math.max(...[...pages].map((page) => page.offsetWidth));
		element.style.zoom = zoom;
		if (widest > 0) pageWidth.current = widest + 2 * PAGE_GUTTER;
	}, []);

	/** Apply a fitting mode to the preview's current width. */
	const fit = useCallback(
		(next: ZoomMode) => {
			if (!next) return;
			if (!pageWidth.current) measure();
			const available = scroller.current?.clientWidth ?? 0;
			const fitted = fitWidthScale(available, pageWidth.current, next === "auto" ? 1 : undefined);
			if (fitted !== undefined) setScale(fitted);
		},
		[measure],
	);

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
		root.replaceChildren();
		const abort = new AbortController();
		const { signal } = abort;
		setState({ phase: "loading" });
		pageWidth.current = 0;

		// Links never navigate the app: bookmarks scroll within the document, web links open outside.
		const onLinkClick = (event: Event) => {
			const anchor = (event.target as Element | null)?.closest?.("a");
			if (!anchor) return;
			event.preventDefault();
			if (event.type !== "click") return;
			const link = documentLink(anchor.getAttribute("href"));
			if (link.kind === "anchor") {
				// Scroll only the pages; scrollIntoView would also move the app's own clipped panels.
				const target = root.getElementById(link.id);
				const pages = scroller.current;
				if (target && pages)
					pages.scrollTop += target.getBoundingClientRect().top - pages.getBoundingClientRect().top - PAGE_GUTTER;
			} else if (link.kind === "external") store.openExternal(link.url);
		};
		root.addEventListener("click", onLinkClick, { signal });
		root.addEventListener("auxclick", onLinkClick, { signal });

		void (async () => {
			try {
				const { parseAsync, renderDocument } = await import("docx-preview");
				const parsed = await parseAsync(data, DOCX_OPTIONS);
				const nodes = await renderDocument(parsed, DOCX_OPTIONS);
				if (signal.aborted) return;
				sanitize(nodes);
				const style = document.createElement("style");
				style.textContent = SHADOW_STYLE;
				root.replaceChildren(...nodes, style);
				setState({ phase: "ready" });
				measure();
				fit(modeRef.current);
			} catch (error) {
				if (!signal.aborted)
					setState({
						phase: "error",
						message: error instanceof Error ? error.message : String(error),
					});
			}
		})();
		return () => abort.abort();
	}, [data, store, measure, fit]);

	// Fitting modes follow the preview's width, e.g. when the panel is resized or shown again.
	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		let width = 0;
		const resize = new ResizeObserver(() => {
			const next = element.clientWidth;
			if (!next || next === width) return;
			width = next;
			fit(modeRef.current);
		});
		resize.observe(element);
		return () => resize.disconnect();
	}, [fit]);

	// Ctrl/⌘ + wheel (and trackpad pinches) zoom around the pointer.
	useEffect(() => {
		const element = scroller.current;
		const content = host.current;
		if (!element || !content) return;
		const onWheel = (event: WheelEvent) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			const current = scaleRef.current;
			const next = clampZoom(current * wheelZoomFactor(event.deltaY, event.deltaMode));
			if (next === current) return;
			const box = element.getBoundingClientRect();
			const x = event.clientX - box.left;
			const y = event.clientY - box.top;
			const ratio = next / current;
			// Zoom now rather than on the next render, so the point under the pointer stays put.
			content.style.zoom = String(next);
			scaleRef.current = next;
			element.scrollLeft = (element.scrollLeft + x) * ratio - x;
			element.scrollTop = (element.scrollTop + y) * ratio - y;
			setScale(next);
			setMode(undefined);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, []);

	const applyMode = (next: "auto" | "page-width") => {
		setMode(next);
		fit(next);
	};
	const zoom = (direction: 1 | -1) => {
		setMode(undefined);
		setScale((current) => stepZoom(current, direction));
	};

	const ready = state.phase === "ready";
	return (
		<div className="document-preview docx-preview">
			<DocumentToolbar>
				<span className="document-toolbar-spacer" />
				<ZoomControls
					scale={scale}
					disabled={!ready}
					onZoom={zoom}
					presets={[
						{ label: "自动", title: "适合宽度，最大 100%", active: mode === "auto", onSelect: () => applyMode("auto") },
						{
							label: "适合宽度",
							title: "页面宽度铺满预览",
							active: mode === "page-width",
							onSelect: () => applyMode("page-width"),
						},
					]}
				/>
			</DocumentToolbar>
			<div className="document-stage">
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the pages scroll with the keyboard once focused. */}
				<div ref={scroller} className="docx-preview-scroll" tabIndex={0}>
					<div ref={host} className="docx-preview-pages" style={{ zoom: scale }} />
				</div>
				{state.phase === "loading" ? (
					<div className="document-overlay">
						<IconLoader size={16} className="spin" />
						正在打开 Word 文档…
					</div>
				) : state.phase === "error" ? (
					<div className="document-overlay">
						<div className="file-viewer-notice error">
							<IconAlert size={20} />
							<div>
								<strong>无法打开这个 Word 文档</strong>
								<p>文件可能已损坏，或不是 .docx 格式（旧版 .doc 不支持预览）：{state.message}</p>
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
