import type { PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { clampZoom, documentLink, stepZoom, wheelZoomFactor } from "../lib/document-preview.ts";
import { documentParams, loadPdfJs, PDF_PREVIEW_CLASS } from "../lib/pdf.ts";
import { useStore } from "../lib/store.tsx";
import { DocumentToolbar, PageNavigator, ZoomControls } from "./DocumentToolbar.tsx";
import { IconAlert, IconLoader, IconLock } from "./Icons.tsx";

type PdfState =
	| { phase: "loading" }
	| { phase: "password"; incorrect: boolean }
	| { phase: "ready"; pages: number }
	| { phase: "error"; message: string };

/** pdf.js's own zoom presets the toolbar offers. */
type ScalePreset = "auto" | "page-width";

function pdfErrorText(error: unknown): string {
	const name = (error as { name?: string }).name;
	if (name === "InvalidPDFException") return "文件不是有效的 PDF，或者已经损坏";
	if (name === "PasswordException") return "PDF 的密码不正确";
	return error instanceof Error ? error.message : String(error);
}

/**
 * A PDF read into memory, shown with pdf.js: pages render as they scroll into view, their text
 * can be selected and copied, and links inside the document jump to their page while web links
 * open in the system browser. The toolbar moves between pages and zooms (also Ctrl/⌘ + wheel or
 * a pinch); "自动" fits the page to the preview's width, up to 125%. Encrypted PDFs ask for their
 * password. pdf.js loads on first use, so the app starts without it.
 */
export function PdfPreview({ data }: { data: Blob }) {
	const store = useStore();
	const container = useRef<HTMLDivElement>(null);
	const viewer = useRef<PDFViewer | undefined>(undefined);
	const submitPassword = useRef<((password: string) => void) | undefined>(undefined);
	const [state, setState] = useState<PdfState>({ phase: "loading" });
	const [page, setPage] = useState(1);
	const [scale, setScale] = useState(1);
	const [preset, setPreset] = useState<ScalePreset | undefined>("auto");
	const [password, setPassword] = useState("");

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const abort = new AbortController();
		const { signal } = abort;
		let task: PDFDocumentLoadingTask | undefined;
		setState({ phase: "loading" });

		// Links never navigate the app: pages and destinations are pdf.js's, web links open outside.
		const onLinkClick = (event: MouseEvent) => {
			const anchor = (event.target as Element | null)?.closest?.("a");
			if (!anchor || !element.contains(anchor)) return;
			const link = documentLink(anchor.getAttribute("href"), true);
			if (link.kind === "internal" && event.type === "click") return;
			event.preventDefault();
			event.stopPropagation();
			if (link.kind === "external" && event.type === "click") store.openExternal(link.url);
		};
		element.addEventListener("click", onLinkClick, { capture: true, signal });
		element.addEventListener("auxclick", onLinkClick, { capture: true, signal });
		// Ctrl/⌘ + wheel (and trackpad pinches, which arrive as Ctrl + wheel) zoom around the pointer.
		element.addEventListener(
			"wheel",
			(event) => {
				const pdfViewer = viewer.current;
				if (!(event.ctrlKey || event.metaKey) || !pdfViewer) return;
				event.preventDefault();
				const current = pdfViewer.currentScale;
				const next = clampZoom(current * wheelZoomFactor(event.deltaY, event.deltaMode));
				if (next !== current)
					pdfViewer.updateScale({
						scaleFactor: next / current,
						origin: [event.clientX, event.clientY],
						drawingDelay: 300,
					});
			},
			{ passive: false, signal },
		);

		void (async () => {
			try {
				const { pdfjs, viewer: pdfViewerModule } = await loadPdfJs();
				const bytes = new Uint8Array(await data.arrayBuffer());
				if (signal.aborted) return;
				const eventBus = new pdfViewerModule.EventBus();
				const linkService = new pdfViewerModule.PDFLinkService({
					eventBus,
					externalLinkTarget: pdfViewerModule.LinkTarget.BLANK,
					externalLinkRel: "noopener noreferrer nofollow",
				});
				const options: ConstructorParameters<typeof pdfViewerModule.PDFViewer>[0] = {
					container: element,
					eventBus,
					linkService,
					textLayerMode: 1,
					annotationMode: pdfjs.AnnotationMode.ENABLE,
					annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
				};
				// Untyped, but the viewer stops observing the container's size and scrolling on abort.
				const pdfViewer = new pdfViewerModule.PDFViewer({ ...options, abortSignal: signal } as typeof options);
				linkService.setViewer(pdfViewer);
				eventBus.on("pagesinit", () => {
					pdfViewer.currentScaleValue = "auto";
				});
				eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => setPage(pageNumber));
				eventBus.on("scalechanging", ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
					setScale(scale);
					setPreset(presetValue === "auto" || presetValue === "page-width" ? presetValue : undefined);
				});

				task = pdfjs.getDocument(documentParams(bytes));
				task.onPassword = (update: (password: string) => void, reason: number) => {
					if (signal.aborted) return;
					submitPassword.current = update;
					setState({ phase: "password", incorrect: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD });
				};
				const pdfDocument = await task.promise;
				if (signal.aborted) return;
				submitPassword.current = undefined;
				pdfViewer.setDocument(pdfDocument);
				linkService.setDocument(pdfDocument);
				viewer.current = pdfViewer;
				setPage(1);
				setState({ phase: "ready", pages: pdfDocument.numPages });
			} catch (error) {
				if (!signal.aborted) setState({ phase: "error", message: pdfErrorText(error) });
			}
		})();

		// The preset zooms follow the preview's width, e.g. when the panel is resized or shown again.
		let width = 0;
		const resize = new ResizeObserver(() => {
			const pdfViewer = viewer.current;
			const next = element.clientWidth;
			if (!pdfViewer || !next || next === width) return;
			width = next;
			const value = pdfViewer.currentScaleValue;
			if (value === "auto" || value === "page-width") pdfViewer.currentScaleValue = value;
		});
		resize.observe(element);

		return () => {
			abort.abort();
			resize.disconnect();
			viewer.current = undefined;
			submitPassword.current = undefined;
			void task?.destroy();
		};
	}, [data, store]);

	const goToPage = (target: number) => {
		const pdfViewer = viewer.current;
		if (!pdfViewer || state.phase !== "ready") return;
		pdfViewer.currentPageNumber = Math.min(state.pages, Math.max(1, Math.round(target)));
	};
	const zoom = (direction: 1 | -1) => {
		const pdfViewer = viewer.current;
		if (pdfViewer) pdfViewer.currentScale = stepZoom(pdfViewer.currentScale, direction);
	};
	const applyPreset = (value: ScalePreset) => {
		if (viewer.current) viewer.current.currentScaleValue = value;
	};
	const unlock = (event: FormEvent) => {
		event.preventDefault();
		if (!password || !submitPassword.current) return;
		submitPassword.current(password);
		setPassword("");
		setState({ phase: "loading" });
	};

	const ready = state.phase === "ready";
	return (
		<div className={`document-preview ${PDF_PREVIEW_CLASS}`}>
			<DocumentToolbar>
				<PageNavigator page={page} pages={ready ? state.pages : undefined} onGo={goToPage} />
				<ZoomControls
					scale={scale}
					disabled={!ready}
					onZoom={zoom}
					presets={[
						{
							label: "自动",
							title: "适合宽度，最大 125%",
							active: preset === "auto",
							onSelect: () => applyPreset("auto"),
						},
						{
							label: "适合宽度",
							title: "页面宽度铺满预览",
							active: preset === "page-width",
							onSelect: () => applyPreset("page-width"),
						},
					]}
				/>
			</DocumentToolbar>
			<div className="document-stage">
				{/* pdf.js requires its scrolling container to be absolutely positioned, with the pages inside. */}
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the pages scroll with the keyboard once focused. */}
				<div ref={container} className="pdf-preview-scroll" tabIndex={0}>
					<div className="pdfViewer" />
				</div>
				{state.phase === "loading" ? (
					<div className="document-overlay">
						<IconLoader size={16} className="spin" />
						正在打开 PDF…
					</div>
				) : state.phase === "password" ? (
					<form className="document-overlay document-password" onSubmit={unlock}>
						<IconLock size={22} />
						<strong>这个 PDF 受密码保护</strong>
						<span className={state.incorrect ? "error-text" : undefined}>
							{state.incorrect ? "密码不正确，请重新输入" : "请输入打开它的密码"}
						</span>
						<span className="document-password-row">
							<input
								type="password"
								aria-label="PDF 密码"
								value={password}
								autoComplete="off"
								// biome-ignore lint/a11y/noAutofocus: the password is the only thing to do here.
								autoFocus
								onChange={(event) => setPassword(event.target.value)}
							/>
							<button type="submit" className="primary small" disabled={!password}>
								打开
							</button>
						</span>
					</form>
				) : state.phase === "error" ? (
					<div className="document-overlay">
						<div className="file-viewer-notice error">
							<IconAlert size={20} />
							<div>
								<strong>无法打开这个 PDF</strong>
								<p>{state.message}</p>
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
