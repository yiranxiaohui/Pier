import { describe, expect, it } from "vitest";
import { type CliCompletionSource, completeCliLine, matchModel, modelCandidates } from "../src/cli-complete.ts";

const models = [
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
	{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
	{ provider: "openrouter", id: "openai/gpt-5.5", name: "GPT-5.5" },
];

const source: CliCompletionSource = {
	models: async () => models,
	thinkingLevels: async () => ["off", "low", "medium", "high"],
	agents: async () => ["pi", "claude-code", "codex"],
};

describe("completeCliLine", () => {
	it("lists every command on an empty line or a bare slash", async () => {
		const [all] = await completeCliLine("", source);
		expect(all).toContain("/model");
		expect(all).toContain("/quit");
		expect((await completeCliLine("/", source))[0]).toEqual(all);
	});

	it("completes command names and adds a space after a unique command that takes arguments", async () => {
		expect(await completeCliLine("/mo", source)).toEqual([["/models", "/model"], "/mo"]);
		expect(await completeCliLine("/thi", source)).toEqual([["/thinking "], "/thi"]);
		expect(await completeCliLine("/ws", source)).toEqual([["/ws "], "/ws"]);
		expect(await completeCliLine("/stat", source)).toEqual([["/status"], "/stat"]);
		expect(await completeCliLine("/nope", source)).toEqual([[], "/nope"]);
	});

	it("does not complete prompts", async () => {
		expect(await completeCliLine("hello wor", source)).toEqual([[], "hello wor"]);
	});

	it("completes models as provider/id, and bare ids once something is typed", async () => {
		expect((await completeCliLine("/model ", source))[0]).toEqual([
			"anthropic/claude-opus-5-5",
			"anthropic/claude-sonnet-5-5",
			"openai/gpt-5.5",
			"openrouter/openai/gpt-5.5",
		]);
		expect(await completeCliLine("/model anthropic/claude-s", source)).toEqual([
			["anthropic/claude-sonnet-5-5"],
			"anthropic/claude-s",
		]);
		expect(await completeCliLine("/model claude-o", source)).toEqual([["claude-opus-5-5"], "claude-o"]);
		expect(await completeCliLine("/model open", source)).toEqual([
			// openrouter's bare id equals openai's reference; it is offered once.
			["openai/gpt-5.5", "openrouter/openai/gpt-5.5"],
			"open",
		]);
		expect(await completeCliLine("/model a b", source)).toEqual([[], "b"]);
	});

	it("completes thinking levels and subcommands", async () => {
		expect(await completeCliLine("/thinking h", source)).toEqual([["high"], "h"]);
		expect(await completeCliLine("/ws ", source)).toEqual([["add", "use", "policy"], ""]);
		expect(await completeCliLine("/ws po", source)).toEqual([["policy "], "po"]);
		expect(await completeCliLine("/ws policy s", source)).toEqual([["smart"], "s"]);
		expect(await completeCliLine("/ws add ~/code a", source)).toEqual([["ask", "auto"], "a"]);
		expect(await completeCliLine("/remote o", source)).toEqual([["on", "off"], "o"]);
		expect(await completeCliLine("/pair y", source)).toEqual([["yes"], "y"]);
		expect(await completeCliLine("/allow s", source)).toEqual([["session"], "s"]);
	});

	it("only loads models when completing a model", async () => {
		let loads = 0;
		const counting: CliCompletionSource = {
			models: async () => {
				loads++;
				return models;
			},
			thinkingLevels: async () => [],
			agents: async () => [],
		};
		await completeCliLine("/mod", counting);
		await completeCliLine("/ws ", counting);
		await completeCliLine("/models ", counting);
		await completeCliLine("/new -a ", counting);
		expect(loads).toBe(0);
		await completeCliLine("/model ", counting);
		expect(loads).toBe(1);
	});

	it("completes agents for /models and /new -a, and the agent flags of /new", async () => {
		expect(await completeCliLine("/age", source)).toEqual([["/agents"], "/age"]);
		expect(await completeCliLine("/models ", source)).toEqual([["pi", "claude-code", "codex"], ""]);
		expect(await completeCliLine("/models cl", source)).toEqual([["claude-code"], "cl"]);
		expect(await completeCliLine("/models codex x", source)).toEqual([[], "x"]);
		expect(await completeCliLine("/new -a ", source)).toEqual([["pi", "claude-code", "codex"], ""]);
		expect(await completeCliLine("/new --agent co", source)).toEqual([["codex"], "co"]);
		expect(await completeCliLine("/new --agent=cl", source)).toEqual([["--agent=claude-code"], "--agent=cl"]);
		expect(await completeCliLine("/new -", source)).toEqual([["-a", "--agent"], "-"]);
		expect(await completeCliLine("/new --", source)).toEqual([["--agent "], "--"]);
		expect(await completeCliLine("/new -a codex fix the", source)).toEqual([[], "the"]);
		expect(await completeCliLine("/new -a codex -", source)).toEqual([[], "-"]);
	});
});

describe("modelCandidates", () => {
	it("dedupes references and ids", () => {
		const twice = [...models, models[0] as (typeof models)[number]];
		expect(modelCandidates(twice, "").length).toBe(4);
		expect(modelCandidates(twice, "g")).toContain("gpt-5.5");
	});
});

describe("matchModel", () => {
	it("picks by number from the listing", () => {
		expect(matchModel(models, "2")).toEqual({ model: models[1] });
		expect(matchModel(models, "9")).toHaveProperty("error");
	});

	it("matches provider/id, id and name case-insensitively", () => {
		expect(matchModel(models, "Anthropic/Claude-Opus-5-5")).toEqual({ model: models[0] });
		expect(matchModel(models, "claude-sonnet-5-5")).toEqual({ model: models[1] });
		expect(matchModel(models, "openai/gpt-5.5")).toEqual({ model: models[2] });
		expect(matchModel(models, "claude opus 5.5")).toEqual({ model: models[0] });
	});

	it("prefers an exact id over a shared name, and reports ambiguous ids instead of guessing", () => {
		expect(matchModel(models, "GPT-5.5")).toEqual({ model: models[2] });
		const withAzure = [...models, { provider: "azure", id: "gpt-5.5", name: "GPT-5.5 (Azure)" }];
		const result = matchModel(withAzure, "gpt-5.5");
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("azure/gpt-5.5");
	});

	it("accepts a fragment found in exactly one model", () => {
		expect(matchModel(models, "sonnet")).toEqual({ model: models[1] });
		const result = matchModel(models, "claude");
		expect("error" in result && result.error).toMatch(/matches 2 models/);
	});

	it("flags unknown models so an explicit provider/id can still go to the host", () => {
		expect(matchModel(models, "custom/my-model")).toMatchObject({ none: true });
		expect(matchModel(models, "claude")).not.toHaveProperty("none");
	});
});
