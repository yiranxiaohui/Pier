import { describe, expect, it } from "vitest";
import { imageFileName, parseDataUrl } from "../src/lib/image-clipboard.ts";

describe("chat image helpers", () => {
	it("reads the type and bytes of a base64 data URL", () => {
		expect(parseDataUrl("data:image/png;base64,iVBORw0KGgo=")).toEqual({
			mimeType: "image/png",
			base64: "iVBORw0KGgo=",
		});
		expect(parseDataUrl("data:Image/JPEG;name=a.jpg;base64,/9j/")).toEqual({
			mimeType: "image/jpeg",
			base64: "/9j/",
		});
	});

	it("rejects URLs that do not carry base64 bytes", () => {
		expect(parseDataUrl("data:image/svg+xml,%3Csvg%3E")).toBeUndefined();
		expect(parseDataUrl("blob:http://localhost/1")).toBeUndefined();
		expect(parseDataUrl("https://example.com/a.png")).toBeUndefined();
	});

	it("names saved images by type and local time", () => {
		const at = new Date(2026, 10, 5, 9, 3, 7);
		expect(imageFileName("image/jpeg", at)).toBe("image-20261105-090307.jpg");
		expect(imageFileName("image/webp", at)).toBe("image-20261105-090307.webp");
		expect(imageFileName("application/octet-stream", at)).toBe("image-20261105-090307.png");
	});
});
