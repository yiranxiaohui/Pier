/**
 * Videos and audio in the file preview. Hosts return these files as `binary` without content, so
 * the preview reads them in chunks (like a download), keeps them in memory as a Blob and plays it
 * in the webview's own `<video>` / `<audio>`; the file then works the same on this computer and
 * paired ones, and the player can seek anywhere once it is loaded.
 */
import { base64ToBytes, type ReadBytes, TRANSFER_CHUNK_BYTES } from "./file-transfers.ts";

export type MediaKind = "video" | "audio";

export interface MediaType {
	kind: MediaKind;
	mimeType: string;
}

/** By extension, the formats webviews commonly play; MPEG-TS is left out, `.ts` is TypeScript. */
const MEDIA_TYPES: Record<string, MediaType> = {
	mp4: { kind: "video", mimeType: "video/mp4" },
	m4v: { kind: "video", mimeType: "video/mp4" },
	mov: { kind: "video", mimeType: "video/quicktime" },
	webm: { kind: "video", mimeType: "video/webm" },
	ogv: { kind: "video", mimeType: "video/ogg" },
	mkv: { kind: "video", mimeType: "video/x-matroska" },
	mp3: { kind: "audio", mimeType: "audio/mpeg" },
	m4a: { kind: "audio", mimeType: "audio/mp4" },
	aac: { kind: "audio", mimeType: "audio/aac" },
	wav: { kind: "audio", mimeType: "audio/wav" },
	flac: { kind: "audio", mimeType: "audio/flac" },
	ogg: { kind: "audio", mimeType: "audio/ogg" },
	oga: { kind: "audio", mimeType: "audio/ogg" },
	opus: { kind: "audio", mimeType: "audio/ogg" },
};

/** The media type of a file by its extension, or undefined when it is no playable media. */
export function mediaType(path: string): MediaType | undefined {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return undefined;
	return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()];
}

/** Media up to this size load as soon as they are shown; larger ones wait for a click. */
export const MEDIA_AUTOLOAD_BYTES = 64 * 1024 * 1024;
/** Larger media are not held in memory; they have to be downloaded to play. */
export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;

export class MediaChangedError extends Error {
	constructor() {
		super("文件在加载过程中被修改，请重新读取");
	}
}

export class MediaTooLargeError extends Error {
	constructor() {
		super("文件太大，无法在预览中播放，请下载后观看");
	}
}

/**
 * Read a whole media file in chunks into a Blob of `mimeType`. `onProgress` reports the bytes
 * read so far and the file size; `signal` stops the reading (rejecting with its reason). Fails
 * when the file changes on disk meanwhile or grows past `MAX_MEDIA_BYTES`.
 */
export async function loadMedia(
	read: ReadBytes,
	mimeType: string,
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
	chunkBytes = TRANSFER_CHUNK_BYTES,
): Promise<Blob> {
	const parts: Uint8Array<ArrayBuffer>[] = [];
	let offset = 0;
	let version: string | undefined;
	for (;;) {
		signal?.throwIfAborted();
		const chunk = await read(offset, chunkBytes);
		signal?.throwIfAborted();
		const stamp = `${chunk.size}@${chunk.modifiedAt}`;
		if (version !== undefined && stamp !== version) throw new MediaChangedError();
		version = stamp;
		if (chunk.size > MAX_MEDIA_BYTES) throw new MediaTooLargeError();
		const bytes = chunk.data ? base64ToBytes(chunk.data) : new Uint8Array(0);
		if (bytes.length) parts.push(bytes);
		offset += bytes.length;
		onProgress?.(offset, chunk.size);
		if (chunk.eof || !bytes.length) break;
	}
	return new Blob(parts, { type: mimeType });
}
