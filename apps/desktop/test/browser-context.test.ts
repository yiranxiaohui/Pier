import type { BrowserElement } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	addressToUrl,
	displayUrl,
	promptWithContexts,
	selectionContext,
	splitMessageContexts,
} from "../src/lib/browser-context.ts";

const element: BrowserElement = {
	nodeId: 7,
	url: "http://localhost:3000/",
	title: "Home",
	label: "section#hero.hero",
	selector: "#hero",
	tag: "section",
	text: "Hello\n\n  Pier   world",
	html: '<section id="hero" class="hero"><code>```js```</code></section>',
	rect: { x: 24.4, y: 41.6, width: 468, height: 170.2 },
};

describe("the address bar", () => {
	it("adds a scheme the way a browser would, and searches anything else", () => {
		expect(addressToUrl("localhost:3000")).toBe("http://localhost:3000/");
		expect(addressToUrl(" localhost:5173/app?x=1 ")).toBe("http://localhost:5173/app?x=1");
		expect(addressToUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
		expect(addressToUrl("devbox:3000/a")).toBe("http://devbox:3000/a");
		expect(addressToUrl("[::1]:4000")).toBe("http://[::1]:4000/");
		expect(addressToUrl("example.com/docs")).toBe("https://example.com/docs");
		expect(addressToUrl("https://example.com")).toBe("https://example.com/");
		expect(addressToUrl("HTTP://Example.com")).toBe("http://example.com/");
		expect(addressToUrl("how to center a div")).toBe("https://www.bing.com/search?q=how%20to%20center%20a%20div");
		expect(addressToUrl("vite")).toBe("https://www.bing.com/search?q=vite");
		expect(addressToUrl("   ")).toBeUndefined();
		expect(addressToUrl("about:blank")).toBeUndefined();
	});

	it("shows nothing for an empty page", () => {
		expect(displayUrl("about:blank")).toBe("");
		expect(displayUrl(undefined)).toBe("");
		expect(displayUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
	});
});

describe("what a pick tells the Agent", () => {
	it("describes an element with its selector, text and HTML, and the user's note", () => {
		const context = selectionContext(
			{
				page: { url: element.url, title: element.title },
				element,
				screenshot: { size: { width: 468, height: 170 }, drawn: false, elementOnly: true },
				note: "  make it green ",
			},
			"id-1",
		);
		expect(context).toMatchObject({ id: "id-1", kind: "element", label: "section#hero.hero", note: "make it green" });
		expect(context.text).toBe(
			[
				"<browser-element>",
				"页面：Home（http://localhost:3000/）",
				"元素：section#hero.hero，468×170，位于视口 (24, 42)",
				"选择器：#hero",
				"文本：Hello Pier world",
				// A fence longer than the backticks inside the HTML.
				'HTML：\n````html\n<section id="hero" class="hero"><code>```js```</code></section>\n````',
				"截图：见附图（该元素的截图）",
				"说明：make it green",
				"</browser-element>",
			].join("\n"),
		);
	});

	it("describes a marked-up screenshot or a region of it", () => {
		const page = { url: "https://example.com/", title: "" };
		const whole = selectionContext({ page, screenshot: { size: { width: 1440, height: 900 }, drawn: true } }, "a");
		expect(whole).toMatchObject({ kind: "screenshot", label: "页面截图" });
		expect(whole.note).toBeUndefined();
		expect(whole.text).toContain("页面：https://example.com/");
		expect(whole.text).toContain("截图：见附图（页面可见区域，1440×900，红色笔迹是标注）");
		const region = selectionContext(
			{
				page,
				screenshot: {
					size: { width: 1440, height: 900 },
					region: { x: 10.2, y: 20.7, width: 300, height: 120.4 },
					drawn: false,
				},
				note: "间距太大",
			},
			"b",
		);
		expect(region.label).toBe("区域截图");
		expect(region.text).toContain("从页面可见区域的 1440×900 截图中截取的 (10, 21) 起 300×120 部分");
		expect(region.text.startsWith("<browser-screenshot>")).toBe(true);
	});

	it("sends the typed text first, then the picks; a message folds them back", () => {
		const picked = selectionContext(
			{ page: { url: element.url, title: element.title }, element, note: "这个是什么" },
			"id",
		);
		const shot = selectionContext(
			{
				page: { url: element.url, title: "" },
				screenshot: { size: { width: 800, height: 600 }, region: { x: 0, y: 0, width: 10, height: 10 }, drawn: true },
			},
			"id2",
		);
		expect(promptWithContexts("hello", undefined)).toBe("hello");
		expect(promptWithContexts("", [picked])).toBe(picked.text);
		const message = promptWithContexts("请改一下", [picked, shot]);
		expect(message).toBe(`请改一下\n\n${picked.text}\n\n${shot.text}`);
		expect(splitMessageContexts(message)).toEqual([
			{ type: "text", text: "请改一下" },
			{ type: "context", kind: "element", label: "section#hero.hero", note: "这个是什么", text: picked.text },
			{ type: "context", kind: "screenshot", label: "区域截图", text: shot.text },
		]);
		expect(splitMessageContexts("plain <browser-element> text")).toEqual([
			{ type: "text", text: "plain <browser-element> text" },
		]);
	});
});
