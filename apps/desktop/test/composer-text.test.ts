import { splitFileRefs } from "@pier/chat-state";
import { describe, expect, it } from "vitest";
import {
	draftToMessage,
	draftToPrompt,
	FILE_CLOSE,
	FILE_OPEN,
	fileChipLabel,
	fileToken,
	splitDraft,
	stripMarkers,
} from "../src/lib/composer-text.ts";

describe("composer draft encoding", () => {
	it("encodes files and directories", () => {
		expect(fileToken("src/app.ts")).toBe(`${FILE_OPEN}src/app.ts${FILE_CLOSE}`);
		expect(fileToken("src", true)).toBe(`${FILE_OPEN}src/${FILE_CLOSE}`);
		expect(fileToken("src//", true)).toBe(`${FILE_OPEN}src/${FILE_CLOSE}`);
		expect(fileToken(`a${FILE_CLOSE}b`)).toBe(`${FILE_OPEN}ab${FILE_CLOSE}`);
	});

	it("splits a draft into text and file parts", () => {
		const draft = `看看 ${fileToken("src/app.ts")} 和 ${fileToken("docs", true)}\n谢谢`;
		expect(splitDraft(draft)).toEqual([
			{ type: "text", text: "看看 " },
			{ type: "file", path: "src/app.ts" },
			{ type: "text", text: " 和 " },
			{ type: "file", path: "docs/" },
			{ type: "text", text: "\n谢谢" },
		]);
		expect(splitDraft("")).toEqual([]);
		expect(splitDraft(fileToken("a.ts"))).toEqual([{ type: "file", path: "a.ts" }]);
	});

	it("turns chips into workspace paths for the prompt", () => {
		expect(draftToPrompt(`fix ${fileToken("src/app.ts")} please`)).toBe("fix src/app.ts please");
		expect(draftToPrompt(`${fileToken("docs", true)}`)).toBe("docs/");
		expect(draftToPrompt("plain text")).toBe("plain text");
	});

	it("sends chips as inline-code paths that read back as files", () => {
		const draft = `${fileToken("docs/追分玩法与计分方式说明.md")} 帮我看看，还有 ${fileToken("README.md")} 和 ${fileToken("src", true)}`;
		const message = draftToMessage(draft);
		expect(message).toBe("`docs/追分玩法与计分方式说明.md` 帮我看看，还有 `./README.md` 和 `src/`");
		expect(splitFileRefs(message)).toEqual([
			{ type: "file", path: "docs/追分玩法与计分方式说明.md" },
			{ type: "text", text: " 帮我看看，还有 " },
			{ type: "file", path: "README.md" },
			{ type: "text", text: " 和 " },
			{ type: "file", path: "src/" },
		]);
		expect(draftToMessage("plain `code`")).toBe("plain `code`");
	});

	it("drops stray markers", () => {
		expect(stripMarkers(`a${FILE_OPEN}b${FILE_CLOSE}c`)).toBe("abc");
		expect(draftToPrompt(`a${FILE_OPEN}b`)).toBe("ab");
		expect(draftToPrompt(`${FILE_OPEN}${FILE_CLOSE}x`)).toBe("x");
	});

	it("labels chips with the last path segment", () => {
		expect(fileChipLabel("src/lib/app.ts")).toBe("app.ts");
		expect(fileChipLabel("README.md")).toBe("README.md");
		expect(fileChipLabel("src/lib/")).toBe("lib/");
	});
});
