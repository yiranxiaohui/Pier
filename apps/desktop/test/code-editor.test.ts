import { describe, expect, it } from "vitest";
import { cursorStatus, fallbackLanguage, visibleColumn } from "../src/lib/code-editor.ts";

describe("fallbackLanguage", () => {
	it("reads the language from a shebang", () => {
		expect(fallbackLanguage("deploy", "#!/usr/bin/env bash")).toBe("shell");
		expect(fallbackLanguage("run", "#!/bin/sh -e")).toBe("shell");
		expect(fallbackLanguage("cli", "#!/usr/bin/env node")).toBe("javascript");
		expect(fallbackLanguage("tool", "#!/usr/bin/python3")).toBe("python");
	});

	it("shows file types Monaco has no grammar for with a close relative", () => {
		expect(fallbackLanguage("Cargo.toml", "[package]")).toBe("ini");
		expect(fallbackLanguage(".env", "TOKEN=1")).toBe("ini");
		expect(fallbackLanguage(".zshrc", "export PATH")).toBe("shell");
		expect(fallbackLanguage("tsconfig.JSONC", "{")).toBe("json");
		expect(fallbackLanguage("App.vue", "<template>")).toBe("html");
		expect(fallbackLanguage("Makefile", "all:")).toBe("shell");
	});

	it("falls back to plain text", () => {
		expect(fallbackLanguage("id_ed25519.pub", "ssh-ed25519 AAAA")).toBe("plaintext");
		expect(fallbackLanguage("LICENSE", "MIT License")).toBe("plaintext");
		expect(fallbackLanguage(".env.local", "A=1")).toBe("plaintext");
	});
});

describe("visibleColumn", () => {
	it("expands tabs to the next tab stop", () => {
		expect(visibleColumn("\tfoo", 1, 4)).toBe(1);
		expect(visibleColumn("\tfoo", 2, 4)).toBe(5);
		expect(visibleColumn("ab\tc", 4, 4)).toBe(5);
		expect(visibleColumn("ab\tc", 4, 2)).toBe(5);
		expect(visibleColumn("a\tc", 3, 2)).toBe(3);
	});

	it("counts other characters one by one", () => {
		expect(visibleColumn("const x", 7, 4)).toBe(7);
		expect(visibleColumn("", 1, 4)).toBe(1);
	});
});

describe("cursorStatus", () => {
	it("words the cursor as VS Code's status bar", () => {
		expect(cursorStatus({ line: 3, column: 14, selections: 1, selected: 0 })).toBe("行 3，列 14");
		expect(cursorStatus({ line: 3, column: 14, selections: 1, selected: 8 })).toBe("行 3，列 14（已选择 8）");
		expect(cursorStatus({ line: 3, column: 14, selections: 3, selected: 15 })).toBe("3 个选择（已选择 15 个字符）");
	});
});
