import { describe, expect, it } from "vitest";
import {
	type CliCompletionSource,
	type CliDirectoryListing,
	candidateValue,
	completeCliLine,
	completeNumbered,
	matchModel,
	modelCandidates,
	oneLine,
} from "../src/cli-complete.ts";

const models = [
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
	{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
	{ provider: "openrouter", id: "openai/gpt-5.5", name: "GPT-5.5" },
];

const sessions = Array.from({ length: 12 }, (_, i) => `session ${i + 1}`);

/** A host whose home directory is /home/me, recording the directories it was asked for. */
function posixHost(listed: string[] = []): (path?: string) => Promise<CliDirectoryListing | undefined> {
	const tree: Record<string, string[]> = {
		"/": ["etc", "home"],
		"/home/me": [".config", "code", "Documents", "projects"],
		"/home/me/code": ["pi", "pier"],
	};
	return async (path) => {
		listed.push(path ?? "(home)");
		const dir = path === undefined ? "/home/me" : path.length > 1 ? path.replace(/\/$/, "") : path;
		const names = tree[dir];
		return names ? { home: "/home/me", separator: "/", entries: names.map((name) => ({ name })) } : undefined;
	};
}

const empty: CliCompletionSource = {
	models: async () => [],
	thinkingLevels: async () => [],
	agents: async () => [],
	sessions: async () => [],
	workspaces: async () => [],
	devices: async () => [],
	forkPoints: async () => [],
	answerOptions: async () => [],
	directories: async () => undefined,
};

const source: CliCompletionSource = {
	models: async () => models,
	thinkingLevels: async () => ["off", "low", "medium", "high"],
	agents: async () => ["pi", "claude-code", "codex"],
	sessions: async () => sessions,
	workspaces: async () => ["pier /home/me/code/pier [ask]", "pi /home/me/code/pi [auto]"],
	devices: async () => ["Pixel android online"],
	forkPoints: async () => ["first prompt", "second prompt"],
	answerOptions: async () => ["Yes", "No"],
	directories: posixHost(),
};

/** readline inserts the common prefix of the candidates: it must never drop typed text. */
function commonPrefix(words: string[]): string {
	return words.reduce((prefix, word) => {
		let i = 0;
		while (i < prefix.length && prefix[i] === word[i]) i++;
		return prefix.slice(0, i);
	}, words[0] ?? "");
}

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
			...empty,
			models: async () => {
				loads++;
				return models;
			},
		};
		await completeCliLine("/mod", counting);
		await completeCliLine("/ws ", counting);
		await completeCliLine("/models ", counting);
		await completeCliLine("/new -a ", counting);
		await completeCliLine("/open ", counting);
		await completeCliLine("/ws add /", counting);
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

describe("numbered completion", () => {
	it("completes a unique number and lists several with their labels", async () => {
		expect(await completeCliLine("/open 3", source)).toEqual([["3"], "3"]);
		expect(await completeCliLine("/open 1", source)).toEqual([
			["1. session 1", "10. session 10", "11. session 11", "12. session 12"],
			"1",
		]);
		const [all] = await completeCliLine("/open ", source);
		expect(all).toHaveLength(12);
		expect(all[1]).toBe("2. session 2");
		expect(await completeCliLine("/open 13", source)).toEqual([[], "13"]);
		expect(await completeCliLine("/open fix", source)).toEqual([[], "fix"]);
		expect(await completeCliLine("/open 1 2", source)).toEqual([[], "2"]);
	});

	it("keeps the common prefix of listed candidates equal to the typed number", () => {
		const labels = Array.from({ length: 150 }, (_, i) => `item ${i + 1}`);
		for (const partial of ["", "1", "2", "12", "15"]) {
			const [hits] = completeNumbered(labels, partial);
			expect(hits.length).toBeGreaterThan(1);
			expect(commonPrefix(hits)).toBe(partial);
		}
	});

	it("numbers workspaces, devices, fork points and the options of /answer", async () => {
		expect(await completeCliLine("/ws use ", source)).toEqual([
			["1. pier /home/me/code/pier [ask]", "2. pi /home/me/code/pi [auto]"],
			"",
		]);
		expect(await completeCliLine("/ws use 2", source)).toEqual([["2"], "2"]);
		expect(await completeCliLine("/revoke ", source)).toEqual([["1"], ""]);
		expect(await completeCliLine("/fork ", source)).toEqual([["1. first prompt", "2. second prompt"], ""]);
		expect(await completeCliLine("/answer 2", source)).toEqual([["2"], "2"]);
		expect(await completeCliLine("/answer ", empty)).toEqual([[], ""]);
	});

	it("shows labels on one line and cuts long ones", () => {
		expect(oneLine("fix\n  the   login")).toBe("fix the login");
		const long = oneLine("x".repeat(200));
		expect(long).toHaveLength(80);
		expect(long.endsWith("…")).toBe(true);
		expect(completeNumbered(["a\nb", "c"], "")[0]).toEqual(["1. a b", "2. c"]);
	});
});

describe("directory completion", () => {
	it("starts at the home directory and completes absolute paths", async () => {
		expect(await completeCliLine("/ws add ", source)).toEqual([["/home/me/"], ""]);
		expect(await completeCliLine("/ws add /", source)).toEqual([["/etc/", "/home/"], "/"]);
		expect(await completeCliLine("/ws add /home/me/c", source)).toEqual([["/home/me/code/"], "/home/me/c"]);
		expect(await completeCliLine("/ws add /home/me/code/p", source)).toEqual([
			["/home/me/code/pi/", "/home/me/code/pier/"],
			"/home/me/code/p",
		]);
	});

	it("expands ~ to the host's home directory but keeps it in the line", async () => {
		const listed: string[] = [];
		const host = { ...source, directories: posixHost(listed) };
		expect(await completeCliLine("/ws add ~", host)).toEqual([["~/"], "~"]);
		expect(await completeCliLine("/ws add ~/co", host)).toEqual([["~/code/"], "~/co"]);
		expect(await completeCliLine("/ws add ~/code/pie", host)).toEqual([["~/code/pier/"], "~/code/pie"]);
		expect(listed).toEqual(["(home)", "(home)", "/home/me/", "(home)", "/home/me/code/"]);
	});

	it("hides dot directories until the name starts with a dot", async () => {
		expect((await completeCliLine("/ws add /home/me/", source))[0]).toEqual([
			"/home/me/code/",
			"/home/me/Documents/",
			"/home/me/projects/",
		]);
		expect(await completeCliLine("/ws add /home/me/.", source)).toEqual([["/home/me/.config/"], "/home/me/."]);
	});

	it("offers nothing for relative paths, unknown directories or a failed lookup", async () => {
		expect(await completeCliLine("/ws add code", source)).toEqual([[], "code"]);
		expect(await completeCliLine("/ws add /nope/x", source)).toEqual([[], "/nope/x"]);
		expect(await completeCliLine("/ws add ~/x", empty)).toEqual([[], "~/x"]);
		expect(await completeCliLine("/ws add ", empty)).toEqual([[], ""]);
	});

	it("splits Windows paths on either separator", async () => {
		const listed: string[] = [];
		const windows: CliCompletionSource = {
			...empty,
			directories: async (path) => {
				listed.push(path ?? "(home)");
				return { home: "C:\\Users\\me", separator: "\\", entries: [{ name: "code" }, { name: "Desktop" }] };
			},
		};
		expect(await completeCliLine("/ws add ", windows)).toEqual([["C:\\Users\\me\\"], ""]);
		expect(await completeCliLine("/ws add C:\\Users\\me\\co", windows)).toEqual([
			["C:\\Users\\me\\code\\"],
			"C:\\Users\\me\\co",
		]);
		expect(await completeCliLine("/ws add C:/Users/me/De", windows)).toEqual([
			["C:/Users/me/Desktop/"],
			"C:/Users/me/De",
		]);
		expect(await completeCliLine("/ws add ~\\co", windows)).toEqual([["~\\code\\"], "~\\co"]);
		expect(listed).toEqual(["(home)", "C:\\Users\\me\\", "C:/Users/me/", "(home)", "C:\\Users\\me\\"]);
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

describe("candidateValue", () => {
	it("takes the number of a numbered entry and the others as they are", () => {
		expect(candidateValue("3. fix the tests · 2h ago", "")).toBe("3");
		expect(candidateValue("12. x", "1")).toBe("12");
		expect(candidateValue("faux/faux-1", "faux")).toBe("faux/faux-1");
		expect(candidateValue("/home/dev/", "/home/d")).toBe("/home/dev/");
	});
});
