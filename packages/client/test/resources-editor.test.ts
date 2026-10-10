import { describe, expect, it } from "vitest";
import { mcpConfig, mcpDraft } from "../src/resources-editor.ts";

describe("unified MCP forms", () => {
	it("retains native advanced settings and maps HTTP headers between agents", () => {
		const draft = mcpDraft({
			name: "docs",
			runtime: "codex",
			scope: "user",
			path: "/config",
			enabled: true,
			revision: "x",
			config: {
				url: "https://example.com/mcp",
				http_headers: { Authorization: "sample" },
				bearer_token_env_var: "TOKEN",
				enabled_tools: ["search"],
			},
		});
		expect(mcpConfig(draft, "codex")).toEqual({
			url: "https://example.com/mcp",
			http_headers: { Authorization: "sample" },
			bearer_token_env_var: "TOKEN",
			enabled_tools: ["search"],
		});
		expect(mcpConfig(draft, "claude-code")).toMatchObject({ type: "http", headers: { Authorization: "sample" } });
	});
	it("keeps arguments with spaces intact and removes HTTP fields when switching to stdio", () => {
		const draft = {
			...mcpDraft(),
			transport: "stdio" as const,
			command: "npx",
			args: "-y\n/path/with spaces",
			advanced: '{"url":"old","startup_timeout_sec":30}',
		};
		expect(mcpConfig(draft, "pi")).toEqual({
			command: "npx",
			type: "stdio",
			args: ["-y", "/path/with spaces"],
			startup_timeout_sec: 30,
		});
	});
	it("rejects malformed JSON and non-string environment values", () => {
		expect(() => mcpConfig({ ...mcpDraft(), command: "node", transport: "stdio", env: '{"TOKEN":3}' }, "pi")).toThrow(
			"字符串键值表",
		);
		expect(() => mcpConfig({ ...mcpDraft(), advanced: "invalid" }, "pi")).toThrow("有效的 JSON");
	});
	it("edits pi project overrides without inventing or copying connection credentials", () => {
		const draft = mcpDraft({
			name: "docs",
			runtime: "pi",
			scope: "project",
			path: "/project/.pi/mcp.json",
			enabled: false,
			revision: "x",
			config: { enabled: false, exposure: "direct" },
		});
		expect(draft.transport).toBe("inherit");
		expect(mcpConfig(draft, "pi")).toEqual({ exposure: "direct" });
	});
});
