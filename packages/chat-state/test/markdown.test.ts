import type { PhrasingContent, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { remarkGfmCjk } from "../src/markdown.ts";

const processor = unified().use(remarkParse).use(remarkGfmCjk).freeze();
const gfm = unified().use(remarkParse).use(remarkGfm).freeze();

/** The first paragraph as compact `[type, text-or-url]` pairs, nested for emphasis. */
function inline(text: string): unknown[] {
	const tree = processor.parse(text) as Root;
	const paragraph = tree.children[0];
	if (paragraph?.type !== "paragraph") throw new Error(`expected a paragraph: ${text}`);
	return paragraph.children.map(simplify);
}

function simplify(node: PhrasingContent): unknown {
	if (node.type === "text") return node.value;
	if (node.type === "link") return ["link", node.url];
	if ("children" in node) return [node.type, ...node.children.map(simplify)];
	return [node.type];
}

describe("remarkGfmCjk", () => {
	it("ends a URL at full-width punctuation, keeping the bold around it", () => {
		expect(inline("管理页是 **http://172.20.0.182:8000**，现在可以打开使用。但它目前只能处理约 3.4 帧/秒")).toEqual([
			"管理页是 ",
			["strong", ["link", "http://172.20.0.182:8000"]],
			"，现在可以打开使用。但它目前只能处理约 3.4 帧/秒",
		]);
		expect(inline("**www.example.com**，好")).toEqual([["strong", ["link", "http://www.example.com"]], "，好"]);
	});

	it("ends URLs at CJK punctuation, brackets and quotes", () => {
		expect(inline("访问 http://172.20.0.182:8000，现在可以打开")).toEqual([
			"访问 ",
			["link", "http://172.20.0.182:8000"],
			"，现在可以打开",
		]);
		expect(inline("文档在 https://example.com/docs/a.html。")).toEqual([
			"文档在 ",
			["link", "https://example.com/docs/a.html"],
			"。",
		]);
		expect(inline("见（https://example.com/a?b=1）和「https://example.com/b」")).toEqual([
			"见（",
			["link", "https://example.com/a?b=1"],
			"）和「",
			["link", "https://example.com/b"],
			"」",
		]);
		expect(inline("打开“https://example.com/x”…")).toEqual(["打开“", ["link", "https://example.com/x"], "”…"]);
		expect(inline("地址：https://example.com/a）")).toEqual(["地址：", ["link", "https://example.com/a"], "）"]);
	});

	it("drops ASCII trailing punctuation before full-width punctuation", () => {
		expect(inline("看 https://example.com/a.，以及 https://example.com/b)。")).toEqual([
			"看 ",
			["link", "https://example.com/a"],
			".，以及 ",
			["link", "https://example.com/b"],
			")。",
		]);
		expect(inline("*https://example.com/a*；")).toEqual([["emphasis", ["link", "https://example.com/a"]], "；"]);
		expect(inline("~~https://example.com/old~~，")).toEqual([["delete", ["link", "https://example.com/old"]], "，"]);
	});

	it("keeps letters of any script and ASCII punctuation inside a URL", () => {
		expect(inline("https://zh.wikipedia.org/wiki/中文 页面")).toEqual([
			["link", "https://zh.wikipedia.org/wiki/中文"],
			" 页面",
		]);
		expect(inline("https://github.com/x/y/blob/main/pkg/__init__.py?q=*a*&b=(c)#d 好")).toEqual([
			["link", "https://github.com/x/y/blob/main/pkg/__init__.py?q=*a*&b=(c)#d"],
			" 好",
		]);
		expect(inline("www.點看.com，好")).toEqual([["link", "http://www.點看.com"], "，好"]);
	});

	it("keeps code, explicit links and other literals", () => {
		expect(inline("[站点](https://example.com/中文，x) 和 <https://example.com/a，b>")).toEqual([
			["link", "https://example.com/中文，x"],
			" 和 ",
			["link", "https://example.com/a，b"],
		]);
		expect(inline("邮件 a.b@example.com，或 ahttp://example.com 与 `http://example.com，`")).toEqual([
			"邮件 ",
			["link", "mailto:a.b@example.com"],
			"，或 ahttp://example.com 与 ",
			["inlineCode"],
		]);
		expect(inline("https://example.com&amp;，")).toEqual([["link", "https://example.com"], "&，"]);
	});

	it("parses like remark-gfm without non-ASCII punctuation", () => {
		const samples = [
			// GFM spec, autolinks (extension).
			"www.commonmark.org",
			"Visit www.commonmark.org/help for more information.",
			"Visit www.commonmark.org.\n\nVisit www.commonmark.org/a.b.",
			"www.google.com/search?q=Markup+(business)\n\nwww.google.com/search?q=Markup+(business)))",
			"(www.google.com/search?q=Markup+(business))\n\n(www.google.com/search?q=Markup+(business)",
			"www.google.com/search?q=(business))+ok",
			"www.google.com/search?q=commonmark&hl=en\n\nwww.google.com/search?q=commonmark&hl;",
			"www.commonmark.org/he<lp",
			"http://commonmark.org\n\n(Visit https://encrypted.google.com/search?q=Markup+(business))",
			"foo@bar.baz\n\nhello@mail+xyz.example isn't valid, but hello+xyz@mail.example is.",
			"a.b-c_d@a.b\n\na.b-c_d@a.b.\n\na.b-c_d@a.b-\n\na.b-c_d@a.b_",
			// Emphasis, links, code and escapes around and inside literals.
			"**https://example.com/a**, _www.example.com_ and ~~http://example.com~~.",
			"https://github.com/x/y/blob/main/pkg/__init__.py and https://example.com/~a/~b",
			"[https://example.com](https://example.org) [x https://example.com] ![https://example.com](a.png)",
			"`https://example.com` <https://example.com> https://example.com\\*x\\* https://example.com&amp;.",
			'"https://example.com/a" \'www.example.com\' https://example.com/a?b="c"&d=e#f!?',
			"ahttp://example.com xwww.example.com https://a_b.example.com https://example.c_m www.example",
			"- https://example.com/1\n- [ ] www.example.com\n\n| a | https://example.com/b |\n|---|---|\n| www.x.com | c |",
			"https://example.com/路径/中文 www.點看.com https://例子.测试/a",
		];
		const strip = (tree: Root) => JSON.parse(JSON.stringify(tree));
		for (const sample of samples) expect(strip(processor.parse(sample)), sample).toEqual(strip(gfm.parse(sample)));
	});

	it("ends URLs at full-width punctuation where the tokenizer leaves them as text", () => {
		// An unclosed `[` keeps the tokenizer out; the mdast transform links these.
		expect(inline("[见 http://example.com/a，中文")).toEqual(["[见 ", ["link", "http://example.com/a"], "，中文"]);
		expect(inline("[见 www.example.com。")).toEqual(["[见 ", ["link", "http://www.example.com"], "。"]);
	});

	it("keeps the rest of GFM", () => {
		const tree = processor.parse("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n脚注[^1]\n\n[^1]: 说明") as Root;
		expect(tree.children.map((node) => node.type)).toEqual(["table", "list", "paragraph", "footnoteDefinition"]);
	});
});
