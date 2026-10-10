import { describe, expect, it } from "vitest";
import { selectByKeyboard, selectByPointer, selectionRange } from "../src/lib/file-selection.ts";

const paths = ["a", "b", "c", "d"];

describe("file list selection", () => {
	it("returns an inclusive range in either direction", () => {
		expect(selectionRange(paths, "b", "d")).toEqual(["b", "c", "d"]);
		expect(selectionRange(paths, "d", "b")).toEqual(["b", "c", "d"]);
	});

	it("uses Shift-click for a range and Ctrl/Cmd-click for additive selection", () => {
		const first = selectByPointer(paths, new Set(["b"]), "b", "d", { shiftKey: true });
		expect([...first.selected]).toEqual(["b", "c", "d"]);
		const second = selectByPointer(paths, first.selected, first.anchor, "a", { ctrlKey: true });
		expect([...second.selected]).toEqual(["b", "c", "d", "a"]);
	});

	it("extends keyboard selection from the original anchor", () => {
		const update = selectByKeyboard(paths, "b", "d", true);
		expect([...update.selected]).toEqual(["b", "c", "d"]);
		const move = selectByKeyboard(paths, update.anchor, "a", false);
		expect([...move.selected]).toEqual(["a"]);
	});

	it.each(["ctrlKey", "metaKey"] as const)(
		"toggles an entry with %s without changing the other entries",
		(modifier) => {
			const original = new Set(["a", "c"]);
			const removed = selectByPointer(paths, original, "a", "c", { [modifier]: true });
			expect([...removed.selected]).toEqual(["a"]);
			expect([...original]).toEqual(["a", "c"]);
			const restored = selectByPointer(paths, removed.selected, removed.anchor, "c", { [modifier]: true });
			expect([...restored.selected]).toEqual(["a", "c"]);
		},
	);

	it("shrinks and reverses a range around the unchanged anchor", () => {
		const extended = selectByKeyboard(paths, "c", "d", true);
		const reversed = selectByKeyboard(paths, extended.anchor, "a", true);
		expect([...reversed.selected]).toEqual(["a", "b", "c"]);
		const shrunk = selectByKeyboard(paths, reversed.anchor, "b", true);
		expect([...shrunk.selected]).toEqual(["b", "c"]);
	});

	it("adds a Shift+Cmd range to an existing non-contiguous selection", () => {
		const added = selectByPointer(paths, new Set(["a", "d"]), "d", "c", { shiftKey: true, metaKey: true });
		expect([...added.selected].sort()).toEqual(["a", "c", "d"]);
	});

	it("selects only the target when the range anchor is absent or hidden", () => {
		expect([...selectByPointer(paths, new Set(), undefined, "c", { shiftKey: true }).selected]).toEqual(["c"]);
		expect([...selectByKeyboard(paths, "removed-file", "c", true).selected]).toEqual(["c"]);
	});

	it("replaces a multi-selection with a plain click", () => {
		const selected = selectByPointer(paths, new Set(paths), "a", "c");
		expect([...selected.selected]).toEqual(["c"]);
		expect(selected.anchor).toBe("c");
	});
});
