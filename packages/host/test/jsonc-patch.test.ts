import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { patchJsonc } from "../src/runtimes/jsonc-patch.ts";

function patch(text: string, ...changes: Array<[string[], unknown?]>): string {
	let result = text;
	for (const [path, value] of changes) result = patchJsonc(result, path, value);
	// Every result must still parse.
	const errors: unknown[] = [];
	parse(result, errors as never, { allowTrailingComma: true });
	expect(errors).toEqual([]);
	return result;
}

describe("JSONC patches", () => {
	it("appends keys after their last sibling, keeping inline objects inline", () => {
		const text = '{\n  "model": "a/b",\n  "mcp": { "docs": { "type": "local", "command": ["npx", "docs"] } }\n}\n';
		expect(patch(text, [["small_model"], "c/d"])).toBe(
			'{\n  "model": "a/b",\n  "mcp": { "docs": { "type": "local", "command": ["npx", "docs"] } },\n  "small_model": "c/d"\n}\n',
		);
		expect(patch(text, [["mcp", "web"], { type: "remote", url: "https://x" }])).toBe(
			'{\n  "model": "a/b",\n  "mcp": { "docs": { "type": "local", "command": ["npx", "docs"] }, "web": { "type": "remote", "url": "https://x" } }\n}\n',
		);
	});

	it("follows trailing commas, comments, tabs and CRLF", () => {
		expect(patch('{\n\t"a": 1, // one\n}', [["b"], { c: [1] }])).toBe(
			'{\n\t"a": 1, // one\n\t"b": {\n\t\t"c": [\n\t\t\t1\n\t\t]\n\t},\n}',
		);
		expect(patch('{\r\n  "a": 1 // one\r\n}\r\n', [["b"], 2])).toBe('{\r\n  "a": 1, // one\r\n  "b": 2\r\n}\r\n');
		expect(patch('{ "a": 1, }', [["b"], 2])).toBe('{ "a": 1, "b": 2, }');
	});

	it("opens empty objects for objects, and the top-level one always", () => {
		expect(patch("{}", [["a"], 1])).toBe('{\n  "a": 1\n}');
		expect(patch('{\n  "p": {}\n}', [["p", "relay"], { npm: "x" }], [["q"], {}], [["q", "k"], true])).toBe(
			'{\n  "p": {\n    "relay": {\n      "npm": "x"\n    }\n  },\n  "q": { "k": true }\n}',
		);
		expect(patch('{\n  "p": {\n  }\n}', [["p", "a"], 1])).toBe('{\n  "p": {\n    "a": 1\n  }\n}');
	});

	it("replaces values in place", () => {
		expect(patch('{\n  "o": { "baseURL": "a", "apiKey": "k" }, // keep\n}', [["o", "baseURL"], "b"])).toBe(
			'{\n  "o": { "baseURL": "b", "apiKey": "k" }, // keep\n}',
		);
		expect(patch('{\n  "bash": { "git push *": "ask" }\n}', [["bash"], "allow"])).toBe('{\n  "bash": "allow"\n}');
		expect(patch('{\n  "bash": "ask"\n}', [["bash"], { "*": "ask", "ls *": "allow" }])).toBe(
			'{\n  "bash": {\n    "*": "ask",\n    "ls *": "allow"\n  }\n}',
		);
	});

	it("removes keys with their line and fixes the commas", () => {
		const text = '{\n  // the model\n  "model": "a/b",\n  "share": "auto", // mine\n  "x": { "y": 1, "z": 2 }\n}\n';
		expect(patch(text, [["share"]])).toBe('{\n  // the model\n  "model": "a/b",\n  "x": { "y": 1, "z": 2 }\n}\n');
		expect(patch(text, [["x"]])).toBe('{\n  // the model\n  "model": "a/b",\n  "share": "auto" // mine\n}\n');
		expect(patch(text, [["x", "y"]], [["x", "z"]])).toBe(
			'{\n  // the model\n  "model": "a/b",\n  "share": "auto", // mine\n  "x": { }\n}\n',
		);
		expect(patch('{\n  "a": 1,\n  "b": 2,\n}', [["b"]])).toBe('{\n  "a": 1,\n}');
		expect(patch('{ "a": 1, }', [["a"]])).toBe("{ }");
		expect(patch('{ "a": 1, "b": 2 }', [["a"]])).toBe('{ "b": 2 }');
		expect(patch('{\n  "a": 1\n}', [["a"]], [["missing"]])).toBe("{\n}");
	});
});
