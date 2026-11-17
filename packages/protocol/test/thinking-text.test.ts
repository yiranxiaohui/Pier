import { describe, expect, it } from "vitest";
import {
	formatThinking,
	hasVisibleText,
	splitThinkingTags,
	thinkingHeadline,
	withoutThinkingTags,
} from "../src/thinking-text.ts";

describe("splitThinkingTags", () => {
	it("leaves text without tags unchanged", () => {
		expect(splitThinkingTags("  plain **text**\n")).toEqual([{ kind: "text", text: "  plain **text**\n" }]);
		expect(splitThinkingTags("")).toEqual([]);
	});

	it("splits closed tags out of the reply", () => {
		expect(splitThinkingTags("<thinking>**Locating the proxy code**</thinking>\nThe project already has it.")).toEqual([
			{ kind: "thinking", text: "**Locating the proxy code**", closed: true },
			{ kind: "text", text: "The project already has it." },
		]);
		expect(splitThinkingTags("Intro\n\n<think>\nstep\n</think>\n\nAnswer")).toEqual([
			{ kind: "text", text: "Intro" },
			{ kind: "thinking", text: "step", closed: true },
			{ kind: "text", text: "Answer" },
		]);
	});

	it("runs an unclosed tag to the end of the text", () => {
		expect(splitThinkingTags("<thinking>**Merging task branch into main**")).toEqual([
			{ kind: "thinking", text: "**Merging task branch into main**", closed: false },
		]);
	});

	it("keeps tags in code blocks and in the middle of a line as text", () => {
		const code = "```xml\n<thinking>kept</thinking>\n```";
		expect(splitThinkingTags(code)).toEqual([{ kind: "text", text: code }]);
		const inline = "Claude wraps it in <thinking> tags.";
		expect(splitThinkingTags(inline)).toEqual([{ kind: "text", text: inline }]);
	});

	it("holds back the start of a tag while it streams", () => {
		expect(splitThinkingTags("<thin", true)).toEqual([]);
		expect(splitThinkingTags("Done.\n<", true)).toEqual([{ kind: "text", text: "Done." }]);
		expect(splitThinkingTags("a < b", true)).toEqual([{ kind: "text", text: "a < b" }]);
		expect(splitThinkingTags("<thin")).toEqual([{ kind: "text", text: "<thin" }]);
		expect(splitThinkingTags("<thinking>**Plan**</thin", true)).toEqual([
			{ kind: "thinking", text: "**Plan**", closed: false },
		]);
		expect(splitThinkingTags("<thinking>**Plan**</thin")).toEqual([
			{ kind: "thinking", text: "**Plan**</thin", closed: false },
		]);
	});

	it("only grows its segments while the text streams", () => {
		const text =
			"\n\nIntro line\n<thinking>**Checking**</thinking>\nSome `<think>` text\n\n```\n<think>code</think>\n```\n<think>\nsecond\n</think>tail";
		const final = splitThinkingTags(text);
		for (let end = 0; end <= text.length; end++) {
			const partial = splitThinkingTags(text.slice(0, end), end < text.length);
			for (const [i, segment] of partial.entries()) {
				const next = final[i];
				expect(next?.kind).toBe(segment.kind);
				expect(next?.text.startsWith(segment.text.trimEnd())).toBe(true);
			}
		}
	});
});

describe("withoutThinkingTags", () => {
	it("keeps only the text", () => {
		expect(withoutThinkingTags("<thinking>**Plan**</thinking>\nDone.\n<think>more</think>\nBye")).toBe("Done.\n\nBye");
		expect(withoutThinkingTags("<thinking>**Unclosed**")).toBe("");
		expect(hasVisibleText("<thinking>**Unclosed**")).toBe(false);
		expect(hasVisibleText("Answer")).toBe(true);
	});
});

describe("formatThinking", () => {
	it("puts run-together summary titles on lines of their own", () => {
		expect(formatThinking("**Planning merge****Checking tests**")).toBe("**Planning merge**\n\n**Checking tests**");
		expect(formatThinking("Looked at it.**Next step**\n\nBody")).toBe("Looked at it.\n\n**Next step**\n\nBody");
		expect(formatThinking("a **bold** word\nand **end**")).toBe("a **bold** word\nand **end**");
		expect(formatThinking("**A****B**", { plain: true })).toBe("A\n\nB");
	});

	it("finds the latest headline", () => {
		expect(thinkingHeadline("**Planning merge****Checking tests**")).toBe("Checking tests");
		expect(thinkingHeadline("**Plan**\n\nSome details.\n\n**Deploy**\n\nMore.")).toBe("Deploy");
		expect(thinkingHeadline("Fetch direct remote then merge push")).toBe("Fetch direct remote then merge push");
		expect(thinkingHeadline("First line.\nSecond line.")).toBeUndefined();
		expect(thinkingHeadline("")).toBeUndefined();
	});
});
