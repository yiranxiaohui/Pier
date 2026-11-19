import type { ModelInfo } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import { codexModelConfig, codexModelList, fetchProviderModels } from "../src/codex/provider-models.ts";

const relay = (entry: Record<string, unknown>) => ({
	model_provider: "relay",
	model_providers: { relay: { base_url: "https://relay.example/v1/", ...entry } },
});

const catalogModel = (id: string): ModelInfo => ({
	provider: "codex",
	id,
	name: id.toUpperCase(),
	reasoning: true,
	input: ["text", "image"],
	thinkingLevels: ["low", "medium", "high"],
});

describe("Codex custom provider models", () => {
	it("reads the provider's endpoint and credentials from the configuration", () => {
		expect(
			codexModelConfig(
				{
					model: " deepseek-pro ",
					model_context_window: 500000,
					...relay({
						env_key: "RELAY_KEY",
						http_headers: { "X-Team": "a", Bad: 1 },
						env_http_headers: { "X-Org": "RELAY_ORG", "X-Missing": "UNSET" },
						query_params: { "api-version": "1" },
					}),
				},
				{ RELAY_KEY: "sk-env", RELAY_ORG: "org-1" },
			),
		).toEqual({
			model: "deepseek-pro",
			contextWindow: 500000,
			provider: {
				id: "relay",
				baseUrl: "https://relay.example/v1/",
				headers: { "X-Team": "a", "X-Org": "org-1", Authorization: "Bearer sk-env" },
				query: { "api-version": "1" },
			},
		});
		// The token in the file wins over the environment variable.
		expect(
			codexModelConfig(relay({ env_key: "RELAY_KEY", experimental_bearer_token: "sk-file" }), { RELAY_KEY: "x" })
				.provider?.headers,
		).toEqual({ Authorization: "Bearer sk-file" });
	});

	it("does not ask OpenAI, providers without a base URL, or ones that sign in another way", () => {
		const providers = { openai: { base_url: "https://api.openai.com/v1" } };
		expect(codexModelConfig({ model: "gpt-5", model_provider: "openai", model_providers: providers }, {})).toEqual({
			model: "gpt-5",
		});
		expect(codexModelConfig({ model_provider: "relay", model_providers: { relay: {} } }, {})).toEqual({});
		expect(codexModelConfig({ model_provider: "missing" }, {})).toEqual({});
		expect(codexModelConfig(relay({ requires_openai_auth: true }), {}).provider).toBeUndefined();
		expect(codexModelConfig(relay({ aws: { profile: "x" } }), {}).provider).toBeUndefined();
		expect(codexModelConfig(relay({ auth: null, aws: null }), {}).provider).toMatchObject({ id: "relay" });
		expect(codexModelConfig(undefined, {})).toEqual({});
	});

	it("lists the chat models a provider reports", async () => {
		const calls: Array<{ url: string; headers: unknown }> = [];
		const fetchStub = (async (url: URL, init: RequestInit) => {
			calls.push({ url: String(url), headers: init.headers });
			return Response.json({
				data: [
					{ id: "chat-a", supported_endpoint_types: ["openai"] },
					{ id: "responses-b", supported_endpoint_types: ["openai-response"] },
					{ id: "untyped-c" },
					{ id: "image-d", supported_endpoint_types: ["image-generation", "openai"] },
					{ id: "embed-e", supported_endpoint_types: ["embeddings"] },
					{ id: "claude-f", supported_endpoint_types: ["anthropic"] },
					{ id: "chat-a" },
					{ id: "" },
					"bogus",
				],
			});
		}) as unknown as typeof fetch;
		const provider = {
			id: "relay",
			baseUrl: "https://relay.example/v1/",
			headers: { Authorization: "Bearer k" },
			query: { "api-version": "1" },
		};
		expect(await fetchProviderModels(provider, AbortSignal.timeout(1000), fetchStub)).toEqual([
			"chat-a",
			"responses-b",
			"untyped-c",
		]);
		expect(calls).toEqual([
			{
				url: "https://relay.example/v1/models?api-version=1",
				headers: { Accept: "application/json", Authorization: "Bearer k" },
			},
		]);
		const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
		await expect(fetchProviderModels(provider, AbortSignal.timeout(1000), failing)).rejects.toThrow("HTTP 401");
		const notAList = (async () => Response.json({ models: [] })) as unknown as typeof fetch;
		await expect(fetchProviderModels(provider, AbortSignal.timeout(1000), notAList)).rejects.toThrow(/model list/);
	});

	it("puts the configured model first and describes models the catalog knows", () => {
		const catalog = [catalogModel("gpt-a"), catalogModel("gpt-b")];
		const ids = (list: ModelInfo[]) => list.map((m) => m.id);
		// Codex's catalog alone, the configured model moved or added first.
		expect(ids(codexModelList(catalog, {}))).toEqual(["gpt-a", "gpt-b"]);
		expect(ids(codexModelList(catalog, { model: "gpt-b" }))).toEqual(["gpt-b", "gpt-a"]);
		expect(ids(codexModelList(catalog, { model: "custom" }))).toEqual(["custom", "gpt-a", "gpt-b"]);
		// A provider's list replaces the catalog; without a configured model, Codex's default leads.
		expect(ids(codexModelList(catalog, {}, ["x", "gpt-a"]))).toEqual(["gpt-a", "x"]);
		expect(ids(codexModelList(catalog, {}, ["x", "y"]))).toEqual(["x", "y"]);
		expect(ids(codexModelList(catalog, { model: "y" }, ["x", "y"]))).toEqual(["y", "x"]);
		expect(ids(codexModelList(catalog, { model: "z" }, ["x", "y"]))).toEqual(["z", "x", "y"]);
		expect(ids(codexModelList(catalog, { model: "z" }, []))).toEqual(["z", "gpt-a", "gpt-b"]);

		const list = codexModelList(catalog, { model: "z", contextWindow: 1000 }, ["gpt-b"]);
		expect(list).toEqual([
			{
				provider: "codex",
				id: "z",
				name: "z",
				reasoning: false,
				input: ["text"],
				contextWindow: 1000,
				thinkingLevels: ["off"],
			},
			catalogModel("gpt-b"),
		]);
	});
});
