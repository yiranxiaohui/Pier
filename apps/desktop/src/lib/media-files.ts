/**
 * Videos, audio, PDF and Word documents in the file preview. Hosts return these files as `binary`
 * without content, so the preview reads them in chunks (like a download), keeps them in memory as a
 * Blob and shows it in the webview: media in its own `<video>` / `<audio>`, documents with pdf.js
 * and docx-preview. The file then works the same on this computer and paired ones, and the player
 * can seek anywhere once it is loaded.
 */
import { base64ToBytes, type ReadBytes, TRANSFER_CHUNK_BYTES } from "./file-transfers.ts";

export type MediaKind = "video" | "audio" | "pdf" | "docx";

export interface MediaType {
	kind: MediaKind;
	mimeType: string;
}

/**
 * By extension, the formats webviews commonly play and the documents the preview renders; MPEG-TS
 * is left out, `.ts` is TypeScript. Old binary `.doc` files have no renderer here.
 */
const MEDIA_TYPES: Record<string, MediaType> = {
	pdf: { kind: "pdf", mimeType: "application/pdf" },
	docx: { kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
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

/** The media type of a file by its extension, or undefined when the preview cannot show it so. */
export function mediaType(path: string): MediaType | undefined {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return undefined;
	return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()];
}

/** Whether the type is a document (PDF, Word) rather than something to play. */
export function isDocument(type: MediaType): boolean {
	return type.kind === "pdf" || type.kind === "docx";
}

/**
 * The media type to show a file read for the preview with. Media are binary; a PDF without binary
 * bytes may also come back decoded as text, but still opens as a document.
 */
export function previewMediaType(path: string, fileKind: string): MediaType | undefined {
	const type = mediaType(path);
	if (!type) return undefined;
	return fileKind === "binary" || (fileKind === "text" && isDocument(type)) ? type : undefined;
}

/** Media up to this size load as soon as they are shown; larger ones wait for a click. */
export const MEDIA_AUTOLOAD_BYTES = 64 * 1024 * 1024;
/** Larger media are not held in memory; they have to be downloaded to play. */
export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;
/** Larger documents are not opened in the preview; rendering them would exhaust the webview. */
export const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;

/** The largest file of this type the preview loads. */
export function maxPreviewBytes(type: MediaType): number {
	return isDocument(type) ? MAX_DOCUMENT_BYTES : MAX_MEDIA_BYTES;
}

/** How the preview talks about a file of this type. */
export interface MediaWords {
	/** The kind of file, e.g. 视频 or PDF. */
	noun: string;
	/** What showing it is called: 播放 or 打开. */
	verb: string;
	/** What to do with it instead, once downloaded. */
	afterDownload: string;
	/** A space between Chinese text and the noun when the noun starts with Latin letters… */
	before: string;
	/** …and after it when it ends with them. */
	after: string;
}

export function mediaWords(type: MediaType): MediaWords {
	const noun = { video: "视频", audio: "音频", pdf: "PDF", docx: "Word 文档" }[type.kind];
	const document = isDocument(type);
	return {
		noun,
		verb: document ? "打开" : "播放",
		afterDownload: document ? "下载后查看" : "下载后观看",
		before: /^[A-Za-z]/.test(noun) ? " " : "",
		after: /[A-Za-z]$/.test(noun) ? " " : "",
	};
}

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
