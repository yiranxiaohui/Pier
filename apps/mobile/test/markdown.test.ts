import type { Table } from "mdast";
import { describe, expect, it } from "vitest";
import { parseMarkdown, safeUrl, tableColumnWidths, textWidth } from "../src/markdown.ts";

const REPORT = `## 合并与清理

| 项目 | 结果 |
|---|---|
| 工作目录 | \`/home/xiaohui/worktrees/Pier/mobile-thinking-slider\`，已删除 |
| 提交 | \`93b831c\`，合并提交 \`3d69506\` |

截图保留在 \`/tmp/pierui/light-slider-*.png\`。`;

describe("parseMarkdown", () => {
	it("parses GFM tables instead of leaving pipes in a paragraph", () => {
		const tree = parseMarkdown(REPORT);
		expect(tree.children.map((node) => node.type)).toEqual(["heading", "table", "paragraph"]);
		const table = tree.children[1] as Table;
		expect(table.children).toHaveLength(3);
		expect(table.children[0]?.children).toHaveLength(2);
		expect(table.children[1]?.children[1]?.children.map((node) => node.type)).toEqual(["inlineCode", "text"]);
	});

	it("understands task lists, strikethrough, emphasis, links, autolinks and rules", () => {
		const tree = parseMarkdown(
			"- [x] done\n- [ ] todo\n\n~~old~~ *new* [site](https://example.com) https://pier.dev\n\n---\n",
		);
		const [list, paragraph, rule] = tree.children;
		expect(list?.type).toBe("list");
		if (list?.type !== "list") throw new Error("expected list");
		expect(list.children.map((item) => item.checked)).toEqual([true, false]);
		expect(paragraph?.type).toBe("paragraph");
		if (paragraph?.type !== "paragraph") throw new Error("expected paragraph");
		expect(paragraph.children.map((node) => node.type)).toEqual([
			"delete",
			"text",
			"emphasis",
			"text",
			"link",
			"text",
			"link",
		]);
		expect(rule?.type).toBe("thematicBreak");
	});

	it("ends a URL at full-width punctuation instead of linking the rest of the sentence", () => {
		const paragraph = parseMarkdown("管理页是 **http://172.20.0.182:8000**，现在可以打开。").children[0];
		if (paragraph?.type !== "paragraph") throw new Error("expected paragraph");
		const [, strong, rest] = paragraph.children;
		if (strong?.type !== "strong" || strong.children[0]?.type !== "link") throw new Error("expected a bold link");
		expect(strong.children[0].url).toBe("http://172.20.0.182:8000");
		expect(rest).toMatchObject({ type: "text", value: "，现在可以打开。" });
	});

	it("never throws on half-streamed input", () => {
		for (const partial of ["| a | b |\n|--", "```ts\nconst x", "**bold", "[link](https://exa", "- [ ", "> quote\n>"]) {
			expect(() => parseMarkdown(partial)).not.toThrow();
		}
		expect(parseMarkdown("```ts\nconst x").children[0]?.type).toBe("code");
	});
});

describe("tableColumnWidths", () => {
	it("sizes columns by their longest cell, counting CJK as wide, within bounds", () => {
		const table = parseMarkdown(REPORT).children[1] as Table;
		const [first, second] = tableColumnWidths(table);
		expect(first).toBe(Math.round(textWidth("工作目录") + 28));
		expect(second).toBe(260);
		const narrow = parseMarkdown("| a |\n|---|\n| b |").children[0] as Table;
		expect(tableColumnWidths(narrow)).toEqual([56]);
	});

	it("covers ragged rows", () => {
		const table = parseMarkdown("| a | b | c |\n|---|---|---|\n| 1 |").children[0] as Table;
		expect(tableColumnWidths(table)).toHaveLength(3);
	});
});

describe("safeUrl", () => {
	it("allows only web and mail links", () => {
		expect(safeUrl("https://example.com")).toBe("https://example.com");
		expect(safeUrl(" mailto:a@b.c ")).toBe("mailto:a@b.c");
		expect(safeUrl("javascript:alert(1)")).toBeUndefined();
		expect(safeUrl("file:///etc/passwd")).toBeUndefined();
		expect(safeUrl("")).toBeUndefined();
	});
});
