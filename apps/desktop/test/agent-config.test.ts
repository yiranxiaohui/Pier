import { describe, expect, it } from "vitest";
import {
	AGENT_CONFIG_META,
	agentUnhandledKeys,
	CLAUDE_ENV_GROUP,
	CLAUDE_GROUPS,
	CODEX_GROUPS,
	codexProviderIds,
	formatJsoncText,
	OPENCODE_GROUPS,
	opencodeModelChanges,
	opencodeProviderFields,
	opencodeProviderIds,
	opencodeProviderModels,
	validateConfigText,
	validProviderId,
} from "../src/lib/agent-config.ts";
import {
	type FieldDef,
	filterGroups,
	flagOn,
	formatValue,
	isRuleObject,
	isValidValue,
	maskSecret,
} from "../src/lib/config-fields.ts";

function field(groups: typeof CLAUDE_GROUPS, path: string): FieldDef {
	const found = groups.flatMap((g) => g.fields).find((f) => f.path.join(".") === path);
	if (!found) throw new Error(`No field ${path}`);
	return found;
}

describe("Claude Code and Codex settings forms", () => {
	it("describes every key once", () => {
		for (const groups of [[...CLAUDE_GROUPS, CLAUDE_ENV_GROUP], CODEX_GROUPS, OPENCODE_GROUPS]) {
			const keys = groups.flatMap((g) => g.fields.map((f) => f.path.join(".")));
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	it("lists only the environment variables without their own field under 其他环境变量", () => {
		const kind = CLAUDE_ENV_GROUP.fields[0]?.kind;
		expect(kind?.type).toBe("map");
		const exclude = kind?.type === "map" ? kind.exclude : [];
		expect(exclude).toContain("ANTHROPIC_BASE_URL");
		expect(exclude).toContain("DISABLE_TELEMETRY");
		expect(exclude).not.toContain("BASH_DEFAULT_TIMEOUT_MS");
		expect(isValidValue(kind as FieldDef["kind"], { A: "1" })).toBe(true);
		expect(isValidValue(kind as FieldDef["kind"], { A: 1 })).toBe(false);
	});

	it("masks credentials and reads environment switches", () => {
		const token = field(CLAUDE_GROUPS, "env.ANTHROPIC_AUTH_TOKEN");
		expect(formatValue(token, "sk-1234567890abcdef")).toBe("sk-1…cdef");
		expect(maskSecret("short")).toBe("•••••");
		expect(flagOn("1")).toBe(true);
		expect(flagOn("true")).toBe(true);
		expect(flagOn("0")).toBe(false);
		expect(flagOn(undefined)).toBe(false);
		expect(formatValue(field(CLAUDE_GROUPS, "env.DISABLE_TELEMETRY"), "1")).toBe("开启");
	});

	it("finds settings the form does not show", () => {
		expect(agentUnhandledKeys("claude-code", { model: "opus", env: {}, hooks: {}, statusLine: {} })).toEqual([
			"hooks",
			"statusLine",
		]);
		expect(
			agentUnhandledKeys("codex", { model: "o3", model_providers: {}, projects: {}, mcp_servers: {}, profiles: {} }),
		).toEqual(["mcp_servers", "profiles"]);
		expect(AGENT_CONFIG_META.codex.fileName).toBe("config.toml");
	});

	it("validates the text editor for each format", () => {
		expect(validateConfigText("json", '{ "model": "opus" }')).toBeUndefined();
		expect(validateConfigText("json", "[1]")).toMatch(/JSON 对象/);
		expect(validateConfigText("json", "{")).toBeTypeOf("string");
		expect(validateConfigText("toml", 'model = "o3"\n[tui]\nnotifications = true\n')).toBeUndefined();
		expect(validateConfigText("toml", "model = ")).toBeTypeOf("string");
		expect(validateConfigText("toml", "")).toBeUndefined();
	});

	it("reads Codex providers and checks new ids", () => {
		expect(codexProviderIds({ model_providers: { relay: { name: "R" }, odd: "x" } })).toEqual(["relay"]);
		expect(codexProviderIds({})).toEqual([]);
		expect(validProviderId("my-relay_2")).toBe(true);
		expect(validProviderId("-x")).toBe(false);
		expect(validProviderId("a.b")).toBe(false);
	});

	it("searches labels, descriptions and keys", () => {
		expect(filterGroups(CODEX_GROUPS, "model_reasoning").flatMap((g) => g.fields.map((f) => f.path.join(".")))).toEqual(
			["model_reasoning_effort", "model_reasoning_summary"],
		);
		expect(filterGroups(CLAUDE_GROUPS, "中转").length).toBeGreaterThan(0);
	});
});

describe("OpenCode settings form", () => {
	it("finds settings the form does not show", () => {
		expect(
			agentUnhandledKeys("opencode", {
				$schema: "https://opencode.ai/config.json",
				model: "a/b",
				provider: {},
				permission: {},
				compaction: {},
				mcp: {},
				agent: {},
			}),
		).toEqual(["mcp", "agent"]);
		expect(AGENT_CONFIG_META.opencode).toMatchObject({ name: "OpenCode", fileName: "opencode.json" });
	});

	it("validates and formats JSON with comments", () => {
		expect(validateConfigText("jsonc", '{\n  // mine\n  "model": "a/b",\n}')).toBeUndefined();
		expect(validateConfigText("jsonc", "[1]")).toMatch(/opencode\.json.*JSON 对象/);
		expect(validateConfigText("jsonc", '{\n  "model": \n}')).toMatch(/ValueExpected（第 3 行第 1 列）/);
		expect(validateConfigText("json", '{ "a": 1, }')).toBeTypeOf("string");
		expect(formatJsoncText('{"model":"a/b", // mine\n"share":"auto"}')).toBe(
			'{\n  "model": "a/b", // mine\n  "share": "auto"\n}\n',
		);
		expect(formatJsoncText("{")).toBeUndefined();
	});

	it("shows per-pattern permission rules as set, not invalid", () => {
		const bash = field(OPENCODE_GROUPS, "permission.bash");
		expect(isValidValue(bash.kind, "ask")).toBe(true);
		expect(isRuleObject(bash, { "git push *": "ask" })).toBe(true);
		expect(isRuleObject(bash, "ask")).toBe(false);
		expect(isRuleObject(field(OPENCODE_GROUPS, "share"), { a: 1 })).toBe(false);
		expect(formatValue(field(OPENCODE_GROUPS, "autoupdate"), false)).toBe("不检查");
	});

	it("reads providers and edits their model lists", () => {
		const settings = { provider: { relay: { models: { a: { name: "A" }, b: {} } }, odd: "x" } };
		expect(opencodeProviderIds(settings)).toEqual(["relay"]);
		expect(opencodeProviderModels(settings, "relay")).toEqual(["a", "b"]);
		expect(opencodeProviderModels(settings, "missing")).toEqual([]);
		expect(opencodeModelChanges(["a", "b"], ["a", "c"], "relay")).toEqual([
			{ path: ["provider", "relay", "models", "b"] },
			{ path: ["provider", "relay", "models", "c"], value: {} },
		]);
		expect(opencodeProviderFields("relay").map((f) => f.path.join("."))).toEqual([
			"provider.relay.name",
			"provider.relay.npm",
			"provider.relay.options.baseURL",
			"provider.relay.options.apiKey",
		]);
	});
});
