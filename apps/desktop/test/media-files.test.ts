import type { WorkspaceFileBytes } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	loadMedia,
	MAX_MEDIA_BYTES,
	MediaChangedError,
	MediaTooLargeError,
	mediaType,
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

	it("ignores other files, TypeScript and dotfiles", () => {
		for (const path of ["src/index.ts", "a.mp4/readme.md", "notes.txt", ".mp4", "dir.mp4/", "mp4"]) {
			expect(mediaType(path)).toBeUndefined();
		}
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
