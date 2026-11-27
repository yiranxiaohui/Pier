import type { WorkspaceFileBytes } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	isDocument,
	loadMedia,
	MAX_DOCUMENT_BYTES,
	MAX_MEDIA_BYTES,
	MediaChangedError,
	MediaTooLargeError,
	maxPreviewBytes,
	mediaType,
	mediaWords,
	previewMediaType,
} from "../src/lib/media-files.ts";

/** A reader over `content` that records the ranges asked for. */
function reader(content: Buffer, stamp = (_offset: number) => "t1") {
	const calls: { offset: number; length: number }[] = [];
	const read = async (offset: number, length: number): Promise<WorkspaceFileBytes> => {
		calls.push({ offset, length });
		const data = content.subarray(offset, offset + length);
		return {
			path: "clip.mp4",
			size: content.length,
			modifiedAt: stamp(offset),
			offset,
			data: data.toString("base64"),
			eof: offset + data.length >= content.length,
		};
	};
	return { read, calls };
}

describe("mediaType", () => {
	it("recognizes common video and audio files by extension", () => {
		expect(mediaType("public/images/clip.mp4")).toEqual({ kind: "video", mimeType: "video/mp4" });
		expect(mediaType("C:\\Videos\\Demo.MOV")).toEqual({ kind: "video", mimeType: "video/quicktime" });
		expect(mediaType("a/b.webm")?.kind).toBe("video");
		expect(mediaType("song.mp3")).toEqual({ kind: "audio", mimeType: "audio/mpeg" });
		expect(mediaType("voice.m4a")?.kind).toBe("audio");
	});

	it("recognizes PDF and Word documents, but not old binary .doc files", () => {
		expect(mediaType("docs/手册.PDF")).toEqual({ kind: "pdf", mimeType: "application/pdf" });
		expect(mediaType("C:\\Users\\me\\报告.docx")?.kind).toBe("docx");
		expect(mediaType("old.doc")).toBeUndefined();
		expect(mediaType(".pdf")).toBeUndefined();
	});

	it("ignores other files, TypeScript and dotfiles", () => {
		for (const path of ["src/index.ts", "a.mp4/readme.md", "notes.txt", ".mp4", "dir.mp4/", "mp4"]) {
			expect(mediaType(path)).toBeUndefined();
		}
	});
});

describe("previewMediaType", () => {
	it("shows binary media and documents", () => {
		expect(previewMediaType("clip.mp4", "binary")?.kind).toBe("video");
		expect(previewMediaType("a.pdf", "binary")?.kind).toBe("pdf");
		expect(previewMediaType("a.docx", "binary")?.kind).toBe("docx");
	});

	it("opens a PDF that decoded as text as a document, but leaves other text alone", () => {
		expect(previewMediaType("plain.pdf", "text")?.kind).toBe("pdf");
		expect(previewMediaType("notes.mp3", "text")).toBeUndefined();
		expect(previewMediaType("readme.md", "text")).toBeUndefined();
		expect(previewMediaType("cover.pdf", "image")).toBeUndefined();
	});
});

describe("document limits and wording", () => {
	it("caps documents lower than media", () => {
		expect(isDocument({ kind: "pdf", mimeType: "application/pdf" })).toBe(true);
		expect(isDocument({ kind: "audio", mimeType: "audio/mpeg" })).toBe(false);
		expect(maxPreviewBytes({ kind: "docx", mimeType: "" })).toBe(MAX_DOCUMENT_BYTES);
		expect(maxPreviewBytes({ kind: "video", mimeType: "" })).toBe(MAX_MEDIA_BYTES);
		expect(MAX_DOCUMENT_BYTES).toBeLessThan(MAX_MEDIA_BYTES);
	});

	it("opens documents and plays media, spacing Latin nouns from Chinese text", () => {
		expect(mediaWords({ kind: "video", mimeType: "" })).toEqual({
			noun: "视频",
			verb: "播放",
			afterDownload: "下载后观看",
			before: "",
			after: "",
		});
		expect(mediaWords({ kind: "pdf", mimeType: "" })).toMatchObject({
			noun: "PDF",
			verb: "打开",
			before: " ",
			after: " ",
		});
		expect(mediaWords({ kind: "docx", mimeType: "" })).toMatchObject({ noun: "Word 文档", before: " ", after: "" });
	});
});

describe("loadMedia", () => {
	it("reads a file in chunks into a blob with progress", async () => {
		const content = Buffer.from("0123456789abcdefghij");
		const { read, calls } = reader(content);
		const progress: [number, number][] = [];
		const blob = await loadMedia(read, "video/mp4", (done, total) => progress.push([done, total]), undefined, 8);
		expect(blob.type).toBe("video/mp4");
		expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe("0123456789abcdefghij");
		expect(calls).toEqual([
			{ offset: 0, length: 8 },
			{ offset: 8, length: 8 },
			{ offset: 16, length: 8 },
		]);
		expect(progress).toEqual([
			[8, 20],
			[16, 20],
			[20, 20],
		]);
	});

	it("loads an empty file", async () => {
		const blob = await loadMedia(reader(Buffer.alloc(0)).read, "audio/mpeg");
		expect(blob.size).toBe(0);
	});

	it("fails when the file changes while loading", async () => {
		const { read } = reader(Buffer.from("0123456789"), (offset) => (offset ? "t2" : "t1"));
		await expect(loadMedia(read, "video/mp4", undefined, undefined, 4)).rejects.toBeInstanceOf(MediaChangedError);
	});

	it("refuses files too large to hold in memory", async () => {
		const read = async (offset: number): Promise<WorkspaceFileBytes> => ({
			path: "big.mp4",
			size: MAX_MEDIA_BYTES + 1,
			modifiedAt: "t1",
			offset,
			data: "AAAA",
			eof: false,
		});
		await expect(loadMedia(read, "video/mp4")).rejects.toBeInstanceOf(MediaTooLargeError);
	});

	it("stops when aborted", async () => {
		const controller = new AbortController();
		const { read, calls } = reader(Buffer.from("0123456789"));
		const loading = loadMedia(read, "video/mp4", () => controller.abort(), controller.signal, 4);
		await expect(loading).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
});
