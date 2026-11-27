import { useEffect, useRef, useState } from "react";
import { type ReadBytes, transferErrorMessage } from "../lib/file-transfers.ts";
import { formatBytes } from "../lib/format.ts";
import { loadMedia, MAX_MEDIA_BYTES, MEDIA_AUTOLOAD_BYTES, type MediaType } from "../lib/media-files.ts";
import { IconAlert, IconFile, IconLoader, IconMusic, IconPlay } from "./Icons.tsx";

type MediaState =
	| { phase: "idle" }
	| { phase: "loading"; done: number; total: number }
	| { phase: "ready"; url: string }
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
 * A video or audio file of the preview, played by the webview. The file is read in full first
 * (with progress); small files start loading right away, large ones on a click. Remount it (by
 * `key`) to read the file again.
 */
export function MediaPreview({
	name,
	size,
	type,
	reader,
	unavailable = "那台电脑的 Pier 版本过旧，无法在预览中播放，请先更新它",
}: {
	name: string;
	/** Size of the file on disk, from reading it for the preview. */
	size: number;
	type: MediaType;
	/** Opens a reader of the file's bytes (it may throw); undefined when the file cannot be read in chunks. */
	reader: (() => ReadBytes) | undefined;
	/** Why the file cannot be played, shown when `reader` is undefined. */
	unavailable?: string | undefined;
}) {
	const label = type.kind === "video" ? "视频" : "音频";
	const tooLarge = size > MAX_MEDIA_BYTES;
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
				url = URL.createObjectURL(blob);
				setState({ phase: "ready", url });
			} catch (error) {
				if (!controller.signal.aborted) setState({ phase: "error", message: transferErrorMessage(error) });
			}
		})();
		return () => {
			controller.abort();
			if (url) URL.revokeObjectURL(url);
		};
	}, [attempt, tooLarge, canRead, size, type.mimeType]);

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
				{unavailable}
			</div>
		);
	}
	if (tooLarge) {
		return (
			<div className="file-viewer-empty">
				<IconFile size={16} />
				{label}太大（{formatBytes(size)}），无法在预览中播放，请下载后观看
			</div>
		);
	}
	if (shown.phase === "ready") {
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
				无法播放这个{label}，格式或编码可能不受支持，可以下载后用本地播放器打开
			</div>
		);
	}
	if (shown.phase === "error") {
		return (
			<div className="file-viewer-notice error">
				<IconAlert size={20} />
				<div>
					<strong>无法加载{label}</strong>
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
					正在加载{label}… {formatBytes(shown.done)} / {formatBytes(shown.total)}
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
				{label}较大（{formatBytes(size)}），需要先完整读取才能播放
			</span>
			<button type="button" className="primary small" onClick={() => setAttempt((n) => n + 1)}>
				<IconPlay size={13} />
				加载并播放
			</button>
		</div>
	);
}
