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
});
