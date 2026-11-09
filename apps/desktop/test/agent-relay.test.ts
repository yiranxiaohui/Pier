import { describe, expect, it } from "vitest";
import {
	claudeFamilyModel,
	claudeModels,
	claudeRelayChanges,
	claudeRelayRemovalChanges,
	claudeRelayState,
	codexModels,
	codexRelayChanges,
	codexRelayRemovalChanges,
	codexRelayState,
	type RelayGroup,
	relayModels,
	tokenRelayModels,
} from "../src/lib/agent-relay.ts";

const group: RelayGroup = {
	id: "yunlian-claude-1x2",
	name: "云链API · Claude",
	siteUrl: "https://api.example.com/",
	models: relayModels({
		api: "anthropic-messages",
		models: [
			{ id: "claude-3-opus-20240229" },
			{ id: "claude-opus-4-1-20250805" },
			{ id: "claude-opus-4-1-20250805-thinking" },
			{ id: "claude-sonnet-4-20250514" },
			{ id: "claude-sonnet-4-5-20250929" },
			{ id: "claude-3-5-haiku-20241022" },
			{ id: "gpt-5", api: "openai-completions" },
			{ id: "gpt-5-codex", api: "openai-responses" },
			{ id: "gemini-2.5-pro", api: "google-generative-ai" },
		],
	}),
};

describe("pointing Claude Code at a group", () => {
	it("offers the Anthropic models and picks the newest of each family", () => {
		const models = claudeModels(group);
		expect(models).not.toContain("gpt-5");
		expect(claudeFamilyModel(models, "opus")).toBe("claude-opus-4-1-20250805");
		expect(claudeFamilyModel(models, "sonnet")).toBe("claude-sonnet-4-5-20250929");
		expect(claudeFamilyModel(models, "haiku")).toBe("claude-3-5-haiku-20241022");
		expect(claudeFamilyModel(["claude-opus-4-5", "claude-opus-4-1-20250805"], "opus")).toBe("claude-opus-4-5");
		expect(claudeFamilyModel(["gpt-5"], "opus")).toBeUndefined();
	});

	it("sets the endpoint, the key reference and the aliases, and drops conflicting settings", () => {
		const changes = claudeRelayChanges(
			{ ...group, models: group.models.filter((m) => !m.id.includes("haiku")) },
			"ref-1",
		);
		expect(changes).toEqual([
			{ path: ["env", "ANTHROPIC_BASE_URL"], value: "https://api.example.com" },
			{ path: ["env", "ANTHROPIC_AUTH_TOKEN"], apiKeyRef: "ref-1" },
			{ path: ["env", "ANTHROPIC_API_KEY"] },
			{ path: ["apiKeyHelper"] },
			{ path: ["env", "ANTHROPIC_MODEL"] },
			{ path: ["env", "ANTHROPIC_SMALL_FAST_MODEL"] },
			{ path: ["env", "ANTHROPIC_DEFAULT_OPUS_MODEL"], value: "claude-opus-4-1-20250805" },
			{ path: ["env", "ANTHROPIC_DEFAULT_SONNET_MODEL"], value: "claude-sonnet-4-5-20250929" },
			{ path: ["env", "ANTHROPIC_DEFAULT_HAIKU_MODEL"] },
			{ path: ["model"] },
		]);
		expect(claudeRelayChanges(group, "ref-1", "claude-sonnet-4-20250514").at(-1)).toEqual({
			path: ["model"],
			value: "claude-sonnet-4-20250514",
		});
	});

	it("recognises settings pointing at the group", () => {
		const settings = {
			model: "opus",
			env: {
				ANTHROPIC_BASE_URL: "https://API.example.com/",
				ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-1-20250805",
			},
		};
		expect(claudeRelayState(settings, group)).toEqual({ site: true, group: true, model: "opus" });
		// Another group of the same site, without these models.
		expect(claudeRelayState(settings, { ...group, models: [] })).toMatchObject({ site: true, group: false });
		expect(claudeRelayState({ env: { ANTHROPIC_BASE_URL: "https://api.example.com" } }, group).group).toBe(true);
		expect(
			claudeRelayState({ model: "gpt-5", env: { ANTHROPIC_BASE_URL: "https://api.example.com" } }, group).group,
		).toBe(false);
		expect(claudeRelayState(undefined, group)).toEqual({ site: false, group: false });

		// 云链API is the same site on every line.
		const yunlian = { ...group, siteUrl: "https://api.syixn.com" };
		expect(claudeRelayState({ env: { ANTHROPIC_BASE_URL: "https://api.yunnet.top/" } }, yunlian).site).toBe(true);
	});

	it("removes only settings that identify this group", () => {
		expect(
			claudeRelayRemovalChanges(group, {
				model: "claude-sonnet-4-20250514",
				env: {
					ANTHROPIC_BASE_URL: "https://api.example.com",
					ANTHROPIC_AUTH_TOKEN: "secret",
					ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-1-20250805",
				},
			}),
		).toEqual([
			{ path: ["env", "ANTHROPIC_BASE_URL"] },
			{ path: ["env", "ANTHROPIC_AUTH_TOKEN"] },
			{ path: ["env", "ANTHROPIC_DEFAULT_OPUS_MODEL"] },
			{ path: ["model"] },
		]);
		expect(claudeRelayRemovalChanges(group, { env: { ANTHROPIC_BASE_URL: "https://api.example.com" } })).toEqual([]);
		expect(
			claudeRelayRemovalChanges(group, {
				model: "custom-model",
				env: { ANTHROPIC_BASE_URL: "https://api.example.com" },
			}),
		).toEqual([]);
		expect(
			claudeRelayRemovalChanges(group, {
				model: "claude-sonnet-4-20250514",
				env: {
					ANTHROPIC_BASE_URL: "https://api.example.com",
					ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
				},
			}),
		).toEqual([]);
	});
});

describe("pointing Codex at a group", () => {
	it("lists OpenAI-style models first", () => {
		expect(codexModels(group).slice(0, 3)).toEqual([
			{ id: "gpt-5-codex", suited: true },
			{ id: "gpt-5", suited: true },
			{ id: "claude-3-opus-20240229", suited: false },
		]);
	});

	it("adds the group as the current provider with the key reference", () => {
		expect(codexRelayChanges(group, "ref-2", "gpt-5-codex")).toEqual([
			{ path: ["model_providers", group.id, "name"], value: "云链API · Claude" },
			{ path: ["model_providers", group.id, "base_url"], value: "https://api.example.com/v1" },
			{ path: ["model_providers", group.id, "wire_api"], value: "responses" },
			{ path: ["model_providers", group.id, "experimental_bearer_token"], apiKeyRef: "ref-2" },
			{ path: ["model_providers", group.id, "env_key"] },
			{ path: ["model_providers", group.id, "requires_openai_auth"] },
			{ path: ["model_provider"], value: group.id },
			{ path: ["model"], value: "gpt-5-codex" },
		]);
	});

	it("recognises the group's provider", () => {
		const settings = { model_provider: group.id, model: "gpt-5", model_providers: { [group.id]: { name: "x" } } };
		expect(codexRelayState(settings, group)).toEqual({ current: true, defined: true, model: "gpt-5" });
		expect(codexRelayState({ model_provider: "openai" }, group)).toEqual({ current: false, defined: false });
	});

	it("removes only this group's provider and resets Codex when it was current", () => {
		expect(
			codexRelayRemovalChanges(group, {
				model_provider: group.id,
				model: "gpt-5",
				model_providers: { [group.id]: { name: group.name }, other: { name: "other" } },
			}),
		).toEqual([{ path: ["model_providers", group.id] }, { path: ["model_provider"] }, { path: ["model"] }]);
		expect(
			codexRelayRemovalChanges(group, {
				model_provider: "other",
				model_providers: { [group.id]: { name: group.name } },
			}),
		).toEqual([{ path: ["model_providers", group.id] }]);
	});
});

describe("a group not added to pi", () => {
	it("takes the token's models, with Chat Completions where the site gave no API", () => {
		const models = tokenRelayModels([
			{ id: "claude-sonnet-4-5", api: "anthropic-messages" },
			{ id: " gpt-5 " },
			{ id: "gpt-5" },
			{ id: "" },
			{ id: "gpt-5-codex", api: "openai-responses" },
		]);
		expect(models).toEqual([
			{ id: "claude-sonnet-4-5", api: "anthropic-messages" },
			{ id: "gpt-5", api: "openai-completions" },
			{ id: "gpt-5-codex", api: "openai-responses" },
		]);
		const fresh = { ...group, models };
		expect(claudeModels(fresh)).toEqual(["claude-sonnet-4-5"]);
		expect(codexModels(fresh)[0]).toEqual({ id: "gpt-5-codex", suited: true });
	});
});
