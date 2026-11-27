import { describe, expect, it } from "vitest";
import { editedMessagePoint, restoreToDraft } from "../src/lib/store.tsx";

describe("editedMessagePoint", () => {
	const points = [
		{ entryId: "a", text: "first" },
		{ entryId: "b", text: "second" },
		{ entryId: "c", text: "third" },
	];

	it("counts the user messages after it from the end", () => {
		expect(editedMessagePoint(points, "third", 0)?.entryId).toBe("c");
		expect(editedMessagePoint(points, "first", 2)?.entryId).toBe("a");
	});

	it("matches the text without pi's image notes", () => {
		const hinted = [
			{
				entryId: "a",
				text: "look\n\n[Image: original 1200x3200, displayed at 750x2000. Multiply coordinates by 1.60 to map to original image.]",
			},
		];
		expect(editedMessagePoint(hinted, "look", 0)?.entryId).toBe("a");
	});

	it("falls back to the last message with the same text when the count is off", () => {
		// An older pi host lists the messages of every branch.
		const branched = [...points, { entryId: "d", text: "second edited" }];
		expect(editedMessagePoint(branched, "second", 1)?.entryId).toBe("b");
		expect(editedMessagePoint(points, "missing", 0)).toBeUndefined();
	});
});

describe("restoreToDraft", () => {
	const image = { data: "AAAA", mimeType: "image/png", name: "a.png" };

	it("fills an empty composer with the message", () => {
		expect(restoreToDraft({ text: " ", images: [] }, { text: "edited", images: [image] })).toEqual({
			text: "edited",
			images: [image],
		});
	});

	it("keeps what the composer has and adds the message after it", () => {
		const draft = { text: "typed meanwhile\n", images: [image], contexts: [] };
		expect(restoreToDraft(draft, { text: "edited", images: [image] })).toEqual({
			text: "typed meanwhile\nedited",
			images: [image, image],
			contexts: [],
		});
	});
});
