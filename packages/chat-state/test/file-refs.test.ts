import { describe, expect, it } from "vitest";
import {
	codeSpanPath,
	fileRefLabel,
	fileRefMarkdown,
	sessionTitle,
	splitFileRefs,
	unwrapFileRefs,
} from "../src/index.ts";

describe("file references in messages", () => {
	it("reads path-shaped inline code as files", () => {
		expect(codeSpanPath("docs/plan.md")).toBe("docs/plan.md");
		expect(codeSpanPath("src/")).toBe("src/");
		expect(codeSpanPath("a/b/.env")).toBe("a/b/.env");
		expect(codeSpanPath("/home/dev/notes.txt")).toBe("/home/dev/notes.txt");
		expect(codeSpanPath("~/.bashrc")).toBe("~/.bashrc");
		expect(codeSpanPath("C:\\Users\\dev\\a.ts")).toBe("C:\\Users\\dev\\a.ts");
		expect(codeSpanPath("./README.md")).toBe("README.md");
		expect(codeSpanPath("./docs/my notes")).toBe("docs/my notes");
		expect(codeSpanPath("../shared/a.ts")).toBe("../shared/a.ts");
	});

	it("leaves code that is not path-shaped alone", () => {
		for (const code of [
			"console.log",
			"README.md",
			"useState",
			"origin/main",
			"@pier/chat-state",
			"/api/status",
			"npm run src/a.ts",
			"https://example.com/a.html",
			"//cdn/a.js",
			"v0.3.11",
			"a/b.c()",
			"./",
			" docs/a.md",
			"docs/a.md\nmore",
		]) {
			expect(codeSpanPath(code), code).toBeUndefined();
		}
	});

	it("writes picked files so they read back", () => {
		for (const path of [
			"docs/plan.md",
			"README.md",
			"Makefile",
			"scripts/build",
			"docs/my notes.md",
			"src/",
			"/abs/file.ts",
			"we`ird/a.md",
			"`tick.md",
		]) {
			const written = fileRefMarkdown(path);
			expect(splitFileRefs(written), written).toEqual([{ type: "file", path }]);
		}
		expect(fileRefMarkdown("README.md")).toBe("`./README.md`");
		expect(fileRefMarkdown("docs/plan.md")).toBe("`docs/plan.md`");
		// An absolute path that cannot read back is still sent as it is.
		expect(fileRefMarkdown("/etc/hosts")).toBe("`/etc/hosts`");
	});

	it("splits a message into text and files", () => {
		expect(splitFileRefs("看看 `docs/a.md` 和 `console.log`，还有 `./b.ts`")).toEqual([
			{ type: "text", text: "看看 " },
			{ type: "file", path: "docs/a.md" },
			{ type: "text", text: " 和 `console.log`，还有 " },
			{ type: "file", path: "b.ts" },
		]);
		expect(splitFileRefs("plain text")).toEqual([{ type: "text", text: "plain text" }]);
		expect(splitFileRefs("")).toEqual([]);
	});

	it("follows Markdown code spans", () => {
		// An unmatched backtick is literal; a longer fence holds shorter runs.
		expect(splitFileRefs("1`` 2 `src/x.ts`")).toEqual([
			{ type: "text", text: "1`` 2 " },
			{ type: "file", path: "src/x.ts" },
		]);
		expect(splitFileRefs("``a`b/c.md``")).toEqual([{ type: "file", path: "a`b/c.md" }]);
		// Paths inside a fenced code block stay code.
		const fenced = "```\n`src/x.ts`\n```";
		expect(splitFileRefs(fenced)).toEqual([{ type: "text", text: fenced }]);
	});

	it("unwraps files for plain text and titles", () => {
		expect(unwrapFileRefs("`./README.md` 改一下 `code`")).toBe("README.md 改一下 `code`");
		expect(sessionTitle({ firstMessage: "`./README.md` 看看" })).toBe("README.md 看看");
	});

	it("labels files with the last segment", () => {
		expect(fileRefLabel("docs/plan.md")).toBe("plan.md");
		expect(fileRefLabel("src/lib/")).toBe("lib/");
		expect(fileRefLabel("C:\\a\\b.ts")).toBe("b.ts");
		expect(fileRefLabel("README.md")).toBe("README.md");
	});
});
