import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	filterPickerItems,
	fitWidth,
	initialPickerState,
	type PickerItem,
	type PickerKey,
	type PickerState,
	renderPicker,
	runTerminalPicker,
	stepPicker,
} from "../src/cli-picker.ts";
import { c, setColorLevel } from "../src/cli-style.ts";

const items: PickerItem<string>[] = [
	{ label: "anthropic/claude-opus-5-5", detail: "Claude Opus 5.5", value: "opus" },
	{ label: "anthropic/claude-sonnet-5-5", detail: "Claude Sonnet 5.5", current: true, value: "sonnet" },
	{ label: "openai/gpt-5.5", detail: "GPT-5.5", value: "gpt" },
	{ label: "faux/faux-1", detail: "Faux One", value: "faux" },
];

const key = (name: string, extra: Partial<PickerKey> = {}): PickerKey => ({ name, ...extra });
const char = (c: string): PickerKey => ({ name: c, sequence: c });

function press(state: PickerState<string>, keys: PickerKey[], rows = 10): PickerState<string> {
	for (const k of keys) {
		const step = stepPicker(state, k, rows);
		if (!("state" in step)) throw new Error("picker closed");
		state = step.state;
	}
	return state;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const plain = (lines: string[]) => lines.map((line) => line.replace(ANSI, ""));

describe("picker state", () => {
	it("starts on the current item", () => {
		expect(initialPickerState(items, 10).index).toBe(1);
		expect(
			initialPickerState(
				items.map(({ current, ...rest }) => rest),
				10,
			).index,
		).toBe(0);
	});

	it("starts at a given item when none is current, clamped to the list", () => {
		const plainItems = items.map(({ current, ...rest }) => rest);
		expect(initialPickerState(plainItems, 10, 3).index).toBe(3);
		expect(initialPickerState(plainItems, 10, 99).index).toBe(3);
		expect(initialPickerState(plainItems, 10, -1).index).toBe(0);
		expect(initialPickerState(items, 10, 3).index).toBe(1);
		expect(initialPickerState([], 10, 2).index).toBe(0);
	});

	it("moves with the arrow keys and wraps around", () => {
		const start = initialPickerState(items, 10);
		expect(press(start, [key("down")]).index).toBe(2);
		expect(press(start, [key("up"), key("up")]).index).toBe(3);
		expect(press(start, [key("down"), key("down"), key("down")]).index).toBe(0);
		expect(press(start, [key("n", { ctrl: true })]).index).toBe(2);
		expect(press(start, [key("end")]).index).toBe(3);
		expect(press(start, [key("home")]).index).toBe(0);
	});

	it("selects with Enter and cancels with Esc or Ctrl+C", () => {
		const start = initialPickerState(items, 10);
		expect(stepPicker(press(start, [key("down")]), key("return"), 10)).toEqual({ done: items[2] });
		expect(stepPicker(start, key("escape"), 10)).toEqual({ cancelled: true });
		expect(stepPicker(start, key("c", { ctrl: true }), 10)).toEqual({ cancelled: true });
	});

	it("filters by typing, matching every term in the label or detail", () => {
		const state = press(initialPickerState(items, 10), [..."gpt"].map(char));
		expect(state.filter).toBe("gpt");
		expect(filterPickerItems(items, state.filter).map((i) => i.value)).toEqual(["gpt"]);
		expect(stepPicker(state, key("return"), 10)).toEqual({ done: items[2] });
		expect(filterPickerItems(items, "claude 5.5").length).toBe(2);
		expect(filterPickerItems(items, "OPUS").map((i) => i.value)).toEqual(["opus"]);
	});

	it("keeps the cursor on the current item while it matches, and edits the filter", () => {
		let state = press(initialPickerState(items, 10), [..."claude"].map(char));
		expect(state.index).toBe(1);
		state = press(state, [key("backspace"), key("backspace")]);
		expect(state.filter).toBe("clau");
		expect(press(state, [char("😀"), key("backspace")]).filter).toBe("clau");
		state = press(state, [key("u", { ctrl: true })]);
		expect(state.filter).toBe("");
		const none = press(state, [..."zzz"].map(char));
		expect(stepPicker(none, key("return"), 10)).toEqual({ state: none });
	});

	it("ignores keys it does not use", () => {
		const start = initialPickerState(items, 10);
		expect(press(start, [key("tab", { sequence: "\t" }), key("x", { meta: true, sequence: "x" })])).toEqual(start);
	});

	it("opens with the current item in the middle of the visible rows", () => {
		const many = (current: number) =>
			Array.from({ length: 30 }, (_, i) => ({ label: `m${i}`, current: i === current, value: String(i) }));
		expect(initialPickerState(many(15), 5)).toMatchObject({ index: 15, top: 13 });
		expect(initialPickerState(many(29), 5)).toMatchObject({ index: 29, top: 25 });
		expect(initialPickerState(many(1), 5)).toMatchObject({ index: 1, top: 0 });
	});

	it("scrolls so the cursor stays visible", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ label: `m${i}`, value: String(i) }));
		let state = initialPickerState(many, 5);
		state = press(
			state,
			Array.from({ length: 7 }, () => key("down")),
			5,
		);
		expect(state).toMatchObject({ index: 7, top: 3 });
		state = press(state, [key("pagedown")], 5);
		expect(state).toMatchObject({ index: 12, top: 8 });
		state = press(state, [key("home")], 5);
		expect(state).toMatchObject({ index: 0, top: 0 });
		state = press(state, [key("up")], 5);
		expect(state).toMatchObject({ index: 29, top: 25 });
	});
});

describe("renderPicker", () => {
	it("marks the selected and current rows and fits the terminal width", () => {
		const state = press(initialPickerState(items, 10), [key("down")]);
		const lines = plain(renderPicker(state, "Select a model", 40, 10));
		expect(lines[0]).toBe("Select a model");
		expect(lines.find((l) => l.startsWith("❯"))).toContain("openai/gpt-5.5");
		expect(lines.find((l) => l.includes("sonnet"))).toContain("✓");
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(39);
	});

	it("shows the position when the list scrolls or is filtered", () => {
		const filtered = press(initialPickerState(items, 10), [char("c")]);
		expect(plain(renderPicker(filtered, "t", 80, 10)).at(-1)).toBe("2/2 of 4");
		const none = press(filtered, [char("q")]);
		expect(plain(renderPicker(none, "t", 80, 10))).toContain("  no matches");
	});

	it("names what Esc does in the key hint", () => {
		const state = initialPickerState(items, 10);
		expect(plain(renderPicker(state, "t", 80, 10))[1]).toContain("Esc cancel");
		expect(plain(renderPicker(state, "t", 80, 10, "list the agents"))[1]).toContain("Esc list the agents");
	});

	it("dims muted items but keeps them selectable", () => {
		const muted: PickerItem<string>[] = [
			{ label: "pi", value: "pi" },
			{ label: "Codex", detail: "unavailable: not installed", muted: true, value: "codex" },
		];
		const state = initialPickerState(muted, 10);
		setColorLevel(1);
		try {
			const row = renderPicker(state, "t", 80, 10).find((line) => line.includes("Codex")) ?? "";
			expect(row).toBe(`${c.gray("  Codex")}${c.gray("  unavailable: not installed")}`);
		} finally {
			setColorLevel(0);
		}
		expect(stepPicker(press(state, [key("down")]), key("return"), 10)).toEqual({ done: muted[1] });
	});

	it("cuts wide text by terminal columns", () => {
		expect(fitWidth("abcdef", 4)).toBe("abc…");
		expect(fitWidth("中文模型名称", 5)).toBe("中文…");
		expect(fitWidth("short", 10)).toBe("short");
	});
});

describe("runTerminalPicker", () => {
	it("borrows the keypress listeners, then restores them and erases the list", async () => {
		const input = new EventEmitter();
		const readlineKeys: string[] = [];
		input.on("keypress", (s: string) => readlineKeys.push(s));
		let written = "";
		const output = { columns: 80, rows: 24, write: (text: string) => (written += text) };
		const result = runTerminalPicker(input, output, { title: "Select a model", items });
		expect(written).toContain("Select a model");
		input.emit("keypress", undefined, key("down"));
		input.emit("keypress", "\r", key("return"));
		await expect(result).resolves.toBe("gpt");
		expect(readlineKeys).toEqual([]);
		expect(input.listenerCount("keypress")).toBe(1);
		input.emit("keypress", "a", char("a"));
		expect(readlineKeys).toEqual(["a"]);
		expect(written.endsWith("\r\x1b[J\x1b[?25h")).toBe(true);
	});

	it("resolves undefined when cancelled", async () => {
		const input = new EventEmitter();
		const result = runTerminalPicker(input, { write: () => true }, { title: "t", items });
		input.emit("keypress", "\x1b", key("escape"));
		await expect(result).resolves.toBeUndefined();
		expect(input.listenerCount("keypress")).toBe(0);
	});
});
