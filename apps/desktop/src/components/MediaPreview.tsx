import { useEffect, useRef, useState } from "react";
import { type ReadBytes, transferErrorMessage } from "../lib/file-transfers.ts";
import { formatBytes } from "../lib/format.ts";
import {
	isDocument,
	loadMedia,
	MEDIA_AUTOLOAD_BYTES,
	type MediaType,
	maxPreviewBytes,
	mediaWords,
} from "../lib/media-files.ts";
import { DocxPreview } from "./DocxPreview.tsx";
import { IconAlert, IconFile, IconLoader, IconMusic, IconPlay } from "./Icons.tsx";
import { PdfPreview } from "./PdfPreview.tsx";

type MediaState =
	| { phase: "idle" }
	| { phase: "loading"; done: number; total: number }
	/** `url` (an object URL of `blob`) only for video and audio. */
	| { phase: "ready"; blob: Blob; url?: string | undefined }
	| { phase: "error"; message: string }
	| { phase: "unplayable" };

/**
 * Pauses a player once it is no longer on screen: previews stay mounted in hidden tabs and
 * panels, where it would otherwise keep playing unseen. A callback ref.
 */
function pauseWhenHidden(element: HTMLMediaElement | null): (() => void) | undefined {
	if (!element || typeof IntersectionObserver === "undefined") return undefined;
	const observer = new IntersectionObserver((entries) => {
		if (entries.some((entry) => !entry.isIntersecting)) element.pause();
	});
	observer.observe(element);
	return () => observer.disconnect();
}

/**
 * A video, audio file, PDF or Word document of the preview: media play in the webview, documents
 * show in `PdfPreview` / `DocxPreview`. The file is read in full first (with progress); small files
 * start loading right away, large ones on a click. Remount it (by `key`) to read the file again.
 */
export function MediaPreview({
	name,
	size,
	type,
	reader,
	unavailable,
}: {
	name: string;
	/** Size of the file on disk, from reading it for the preview. */
	size: number;
	type: MediaType;
	/** Opens a reader of the file's bytes (it may throw); undefined when the file cannot be read in chunks. */
	reader: (() => ReadBytes) | undefined;
	/** Why the file cannot be shown, when `reader` is undefined. */
	unavailable?: string | undefined;
}) {
	const words = mediaWords(type);
	const { noun, verb, before, after } = words;
	const document = isDocument(type);
	const tooLarge = size > maxPreviewBytes(type);
	/** Bumped to (re)start loading; 0 waits for a click. */
	const [attempt, setAttempt] = useState(() => (size <= MEDIA_AUTOLOAD_BYTES ? 1 : 0));
	const [state, setState] = useState<MediaState>({ phase: "idle" });
	const readerRef = useRef(reader);
	readerRef.current = reader;
	const canRead = !!reader;

	useEffect(() => {
		if (!attempt || tooLarge || !canRead) return;
		const open = readerRef.current;
		if (!open) return;
		const controller = new AbortController();
		let url: string | undefined;
		setState({ phase: "loading", done: 0, total: size });
		void (async () => {
			try {
				const blob = await loadMedia(
					open(),
					type.mimeType,
					(done, total) => {
						if (!controller.signal.aborted) setState({ phase: "loading", done, total });
					},
					controller.signal,
				);
				if (controller.signal.aborted) return;
				if (!document) url = URL.createObjectURL(blob);
				setState({ phase: "ready", blob, url });
			} catch (error) {
				if (!controller.signal.aborted) setState({ phase: "error", message: transferErrorMessage(error) });
			}
		})();
		return () => {
			controller.abort();
			if (url) URL.revokeObjectURL(url);
		};
	}, [attempt, tooLarge, canRead, size, type.mimeType, document]);

	const cancel = () => {
		setAttempt(0);
		setState({ phase: "idle" });
	};
	// Until the effect reports progress, a requested load already shows as loading.
	const shown: MediaState = state.phase === "idle" && attempt ? { phase: "loading", done: 0, total: size } : state;

	if (!reader) {
		return (
			<div className="file-viewer-empty">
				<IconFile size={16} />
				{unavailable ?? `那台电脑的 Pier 版本过旧，无法在预览中${verb}，请先更新它`}
			</div>
		);
	}
	if (tooLarge) {
		return (
			<div className="file-viewer-empty">
				<IconFile size={16} />
				{noun}
				{after}太大（{formatBytes(size)}），无法在预览中{verb}，请{words.afterDownload}
			</div>
		);
	}
	if (shown.phase === "ready") {
		if (type.kind === "pdf") return <PdfPreview data={shown.blob} />;
		if (type.kind === "docx") return <DocxPreview data={shown.blob} />;
		return type.kind === "video" ? (
			<div className="file-viewer-media">
				{/* biome-ignore lint/a11y/useMediaCaption: workspace videos come without caption tracks. */}
				<video
					ref={pauseWhenHidden}
					src={shown.url}
					controls
					preload="metadata"
					playsInline
					aria-label={name}
					onError={() => setState({ phase: "unplayable" })}
				/>
			</div>
		) : (
			<div className="file-viewer-media audio">
				<IconMusic size={36} />
				<span className="file-viewer-media-name">{name}</span>
				{/* biome-ignore lint/a11y/useMediaCaption: workspace audio comes without caption tracks. */}
				<audio
					ref={pauseWhenHidden}
					src={shown.url}
					controls
					preload="metadata"
					aria-label={name}
					onError={() => setState({ phase: "unplayable" })}
				/>
			</div>
		);
	}
	if (shown.phase === "unplayable") {
		return (
			<div className="file-viewer-empty">
				<IconAlert size={16} />
				无法播放这个{noun}，格式或编码可能不受支持，可以下载后用本地播放器打开
			</div>
		);
	}
	if (shown.phase === "error") {
		return (
			<div className="file-viewer-notice error">
				<IconAlert size={20} />
				<div>
					<strong>
						无法加载{before}
						{noun}
					</strong>
					<p>{shown.message}</p>
				</div>
				<button type="button" className="subtle" onClick={() => setAttempt((n) => n + 1)}>
					重试
				</button>
			</div>
		);
	}
	if (shown.phase === "loading") {
		const percent = shown.total > 0 ? Math.min(100, (shown.done / shown.total) * 100) : undefined;
		return (
			<div className="file-viewer-media-loading">
				<span className="file-viewer-media-status">
					<IconLoader size={14} className="spin" />
					正在加载{before}
					{noun}… {formatBytes(shown.done)} / {formatBytes(shown.total)}
				</span>
				<div className="update-progress-track">
					<div
						className={`update-progress-bar${percent === undefined ? " indeterminate" : ""}`}
						style={percent === undefined ? undefined : { width: `${percent}%` }}
					/>
				</div>
				{size > MEDIA_AUTOLOAD_BYTES ? (
					<button type="button" className="ghost small" onClick={cancel}>
						取消
					</button>
				) : null}
			</div>
		);
	}
	return (
		<div className="file-viewer-media-loading">
			<span className="file-viewer-media-status">
				{noun}
				{after}较大（{formatBytes(size)}），需要先完整读取才能{verb}
			</span>
			<button type="button" className="primary small" onClick={() => setAttempt((n) => n + 1)}>
				{document ? <IconFile size={13} /> : <IconPlay size={13} />}
				加载并{verb}
			</button>
		</div>
	);
}
