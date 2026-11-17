import { describe, expect, it } from "vitest";
import { toolOutputImages, toolOutputText } from "../src/index.ts";

describe("tool result images", () => {
	it("returns the image parts of a tool result next to its text", () => {
		const result = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/jpeg]" },
				{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
			],
			isError: false,
			timestamp: 1,
		};
		expect(toolOutputText(result)).toBe("Read image file [image/jpeg]");
		expect(toolOutputImages(result)).toEqual([{ type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
	});

	it("returns no images for text-only, missing or malformed results", () => {
		expect(toolOutputImages({ content: [{ type: "text", text: "ok" }] })).toEqual([]);
		expect(toolOutputImages(undefined)).toEqual([]);
		expect(toolOutputImages("text")).toEqual([]);
		expect(toolOutputImages({ content: "text" })).toEqual([]);
	});
});
