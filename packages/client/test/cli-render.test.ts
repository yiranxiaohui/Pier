import { describe, expect, it } from "vitest";
import {
	box,
	commandSuggestions,
	commonPrefix,
	completionGrid,
	formatBlock,
	formatDuration,
	type HelpSection,
	helpRows,
	inlineMarkdown,
	keyValues,
	list,
	MessageStream,
	markdownLine,
	markdownTable,
	relativeTime,
	renderSpans,
	rule,
	span,
	toolHeader,
	toolResult,
	toolSummary,
	userMessage,
	wrapSpans,
} from "../src/cli-render.ts";
import { displayWidth } from "../src/cli-style.ts";

const text = (rows: ReturnType<typeof wrapSpans>) => rows.map((row) => row.map((s) => s.text).join(""));

describe("wrapSpans", () => {
	it("wraps at spaces and drops the spaces at a break", () => {
		expect(text(wrapSpans([span("the quick brown fox jumps")], 10))).toEqual(["the quick", "brown fox", "jumps"]);
	});

	it("breaks CJK text between characters but keeps closing punctuation on the row", () => {
		expect(text(wrapSpans([span("你好世界，再见")], 8))).toEqual(["你好世", "界，再见"]);
		expect(text(wrapSpans([span("一二三四五")], 4))).toEqual(["一二", "三四", "五"]);
	});

	it("breaks words longer than a row", () => {
		expect(text(wrapSpans([span("abcdefghij")], 4))).toEqual(["abcd", "efgh", "ij"]);
	});

	it("does not break a word where its style changes", () => {
		const rows = wrapSpans([span("run "), span("echo", (s) => `<${s}>`), span(", touch")], 8);
		expect(text(rows)).toEqual(["run", "echo,", "touch"]);
		expect(rows[1]?.[0]?.style).toBeDefined();
	});

	it("uses another width after the first row", () => {
		expect(text(wrapSpans([span("aaa bbb ccc ddd")], 7, 3))).toEqual(["aaa bbb", "ccc", "ddd"]);
	});
});

describe("formatBlock", () => {
	it("puts the marker before the first row and indents the others", () => {
		expect(formatBlock([span("one two three four")], 12, [span("● ")])).toEqual(["● one two", "  three four"]);
	});
});

describe("markdown", () => {
	const plain = (line: string, state = {}) => {
		const md = markdownLine(line, state);
		return { lead: renderSpans(md.lead), content: renderSpans(md.content), rule: md.rule };
	};

	it("renders headings, lists, quotes and rules", () => {
		expect(plain("## Title ##").content).toBe("Title");
		expect(plain("  - item")).toMatchObject({ lead: "  • ", content: "item" });
		expect(plain("12. step")).toMatchObject({ lead: "12. ", content: "step" });
		expect(plain("> quoted")).toMatchObject({ lead: "│ ", content: "quoted" });
		expect(plain("---").rule).toBe(true);
	});

	it("parses inline code, bold, italic and links", () => {
		const spans = inlineMarkdown("use `x*y*` with **bold `code`** and *it* [docs](https://e.x)");
		expect(renderSpans(spans)).toBe("use x*y* with bold code and it docs (https://e.x)");
		expect(spans.find((s) => s.text === "x*y*")?.style).toBeDefined();
		expect(renderSpans(inlineMarkdown("snake_case_name and 2*3*4"))).toBe("snake_case_name and 2*3*4");
	});

	it("leaves code blocks alone and tracks the fence across lines", () => {
		const state = {};
		expect(plain("```ts", state).content).toBe("```ts");
		expect(plain("# not a heading", state).content).toBe("# not a heading");
		expect(plain("```", state).content).toBe("```");
		expect(plain("# heading", state).content).toBe("heading");
	});
});

describe("markdownTable", () => {
	it("draws a table with aligned columns", () => {
		expect(markdownTable(["| 功能 | ok |", "|---|--:|", "| 流式输出 | ✅ |", "| x | 12 |"], 80)).toEqual([
			"┌──────────┬────┐",
			"│ 功能     │ ok │",
			"├──────────┼────┤",
			"│ 流式输出 │ ✅ │",
			"│ x        │ 12 │",
			"└──────────┴────┘",
		]);
	});

	it("declines lines without a separator row, or a table wider than the room", () => {
		expect(markdownTable(["| a | b |", "| c | d |"], 80)).toBeUndefined();
		expect(markdownTable(["| aaaaaaaa | bbbbbbbb |", "|---|---|"], 10)).toBeUndefined();
	});
});

describe("MessageStream", () => {
	const stream = (width = 40) => new MessageStream({ width: () => width, markdown: true });

	it("finishes rows line by line and previews the line being written", () => {
		const s = stream();
		expect(s.push("text", "Hello **wor")).toEqual([]);
		expect(s.live(5)).toEqual(["", "● Hello **wor"]);
		expect(s.push("text", "ld**\nsecond")).toEqual(["", "● Hello world"]);
		expect(s.live(5)).toEqual(["  second"]);
		expect(s.finish()).toEqual(["  second"]);
		expect(s.live(5)).toEqual([]);
	});

	it("starts a new block when thinking turns into text, collapsing blank lines", () => {
		const s = stream();
		const rows = [...s.push("thinking", "\n\nplan\n"), ...s.push("text", "a\n\n\n\nb\n"), ...s.finish()];
		expect(rows).toEqual(["", "✻ plan", "", "● a", "", "  b"]);
	});

	it("holds table rows until the table ends", () => {
		const s = stream();
		expect(s.push("text", "| a | b |\n|---|---|\n| 1 | 2 |\n")).toEqual([]);
		expect(s.live(10)[1]).toBe("● ┌───┬───┐");
		const rows = s.push("text", "after\n");
		expect(rows).toEqual(["", "● ┌───┬───┐", "  │ a │ b │", "  ├───┼───┤", "  │ 1 │ 2 │", "  └───┴───┘", "  after"]);
	});

	it("passes text through without markdown", () => {
		const s = new MessageStream({ width: () => Number.POSITIVE_INFINITY, markdown: false });
		expect([...s.push("text", "**raw** | x |\n"), ...s.finish()]).toEqual(["", "● **raw** | x |"]);
	});
});

describe("tool calls", () => {
	it("summarises the main argument", () => {
		expect(toolSummary({ command: "ls  -la\n| head" })).toBe("ls -la | head");
		expect(toolSummary({ pattern: "TODO", path: "src" })).toBe("TODO in src");
		expect(toolSummary({ a: 1 })).toBe('{"a":1}');
		expect(toolSummary({})).toBe("");
	});

	it("shows the call and a preview of its output", () => {
		expect(toolHeader("bash", { command: "ls" }, "ok", 40)).toEqual(["● bash(ls)"]);
		expect(toolHeader("bash", { command: "x ".repeat(100) }, "running", 20, { frame: "⠋", maxRows: 2 })).toHaveLength(
			2,
		);
		const output = { content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n" }] };
		expect(toolResult("bash", output, false, 40)).toEqual(["  ⎿  1", "     2", "     3", "     4", "     … +2 lines"]);
		expect(toolResult("bash", { content: [] }, false, 40)).toEqual(["  ⎿  (no output)"]);
		expect(toolResult("bash", { content: [{ type: "text", text: "boom" }] }, true, 40)).toEqual(["  ⎿  boom"]);
		expect(toolResult("read", output, false, 40)).toEqual(["  ⎿  Read 6 lines"]);
	});

	it("shows the changed lines of an edit", () => {
		const result = { content: [{ type: "text", text: "ok" }], details: { diff: " 1 a\n-2 b\n+2 c\n 3 d" } };
		expect(toolResult("edit", result, false, 40)).toEqual(["  ⎿  1 line added, 1 removed", "     -2 b", "     +2 c"]);
	});
});

describe("layout", () => {
	it("draws boxes and rules exactly as wide as asked", () => {
		const rows = box(["hello", "中文"], 20, { title: "Title" });
		for (const row of rows) expect(displayWidth(row)).toBe(20);
		expect(rows[0]).toBe("╭─ Title ──────────╮");
		expect(rule(30, "left", "right")).toBe(`── left ${"─".repeat(14)} right ─`);
		expect(displayWidth(rule(30, "left", "right"))).toBe(30);
		expect(displayWidth(rule(24, "a long left label", "the right label"))).toBe(24);
	});

	it("aligns list columns and marks the current row", () => {
		expect(list([{ cells: ["one", "first"] }, { cells: ["three", "third"], current: true }], 80)).toEqual([
			"  1    one    first",
			"  2  ● three  third",
		]);
		expect(
			keyValues(
				[
					["a", "1"],
					["long", "2"],
				],
				80,
			),
		).toEqual(["  a     1", "  long  2"]);
	});

	it("formats times", () => {
		expect(formatDuration(400)).toBe("<1s");
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(185_000)).toBe("3m 05s");
		const now = Date.parse("2026-11-05T12:00:00Z");
		expect(relativeTime("2026-11-05T11:59:50Z", now)).toBe("just now");
		expect(relativeTime("2026-11-05T09:00:00Z", now)).toBe("3h ago");
		expect(relativeTime("2026-10-01T00:00:00Z", now)).toBe("2026-10-01");
	});

	it("shows a sent message with its lines under the marker", () => {
		expect(userMessage("hello\nworld", 40)).toEqual(["", "❯ hello", "  world"]);
		expect(userMessage("a\nb\nc", 40, { maxRows: 2 })).toEqual(["", "❯ a", "  b", "  … +1 lines"]);
	});
});

describe("commands", () => {
	const sections: HelpSection[] = [
		{
			title: "Models",
			commands: [
				["/models", "list models"],
				["/model <n>", "switch model"],
				["/yes, /no", "answer"],
			],
		},
	];

	it("suggests commands by prefix, then the usages of the one being typed", () => {
		expect(commandSuggestions(sections, "/mo").map(([usage]) => usage)).toEqual(["/models", "/model <n>"]);
		expect(commandSuggestions(sections, "/model ").map(([usage]) => usage)).toEqual(["/model <n>"]);
		expect(commandSuggestions(sections, "/no").map(([usage]) => usage)).toEqual(["/yes, /no"]);
		expect(commandSuggestions(sections, "hello")).toEqual([]);
	});

	it("renders help with aligned usages", () => {
		expect(helpRows(sections, ["note"], 80)).toEqual([
			"",
			"  Models",
			"    /models     list models",
			"    /model <n>  switch model",
			"    /yes, /no   answer",
			"",
			"  note",
		]);
	});

	it("lists completion candidates in columns", () => {
		expect(commonPrefix(["faux/faux-1", "faux/faux-2"])).toBe("faux/faux-");
		expect(commonPrefix([])).toBe("");
		expect(completionGrid(["low", "medium", "high"], 40)).toEqual(["  low     medium  high"]);
		const many = completionGrid(
			Array.from({ length: 30 }, (_, i) => `model-${i}`),
			20,
			3,
		);
		expect(many).toEqual(["  model-0   model-1", "  model-2   model-3", "  … 26 more; type more to narrow them down"]);
	});
});
