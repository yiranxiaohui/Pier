import type { ModelInfo } from "@pier/protocol";
import { CODEX_PROVIDER } from "./convert.ts";

/**
 * Codex's model catalog (`model/list`) lists OpenAI's models whatever provider is configured. A
 * custom provider (`[model_providers.<id>]` with a `base_url`: a relay, a gateway, another
 * vendor) usually serves other models, so new threads would ask it for a model it does not have
 * as soon as Pier picks one from the catalog. For such a provider Pier lists the models the
 * provider itself reports (`GET <base_url>/models`, with the provider's credentials), and the
 * configured `model` always comes first, because that is what new threads use.
 */

type Json = Record<string, unknown>;

/** A custom provider's endpoint, with what authenticates a request to it. */
export interface CodexProviderEndpoint {
	id: string;
	baseUrl: string;
	headers: Record<string, string>;
	query: Record<string, string>;
}

/** The parts of Codex's effective configuration (`config/read`) that decide the model list. */
export interface CodexModelConfig {
	/** `model`: what new threads use. */
	model?: string;
	/** `model_context_window`. */
	contextWindow?: number;
	/** The current provider (`model_provider`), when it is a custom one Pier can ask for models. */
	provider?: CodexProviderEndpoint;
}

const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

/** String values of a TOML table (`http_headers`, `query_params`). */
function strings(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!isObject(value)) return out;
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
	return out;
}

/** Providers that sign in some other way than a key or fixed headers (Pier cannot ask those). */
const OTHER_AUTH = ["auth", "aws", "gateway_oauth", "credential_file"] as const;

/** Read the model settings out of `config/read`'s `config`. */
export function codexModelConfig(config: Json | undefined, env: NodeJS.ProcessEnv): CodexModelConfig {
	if (!config) return {};
	const model = text(config.model);
	const window = Number(config.model_context_window);
	const result: CodexModelConfig = {
		...(model ? { model } : {}),
		...(Number.isSafeInteger(window) && window > 0 ? { contextWindow: window } : {}),
	};
	const id = text(config.model_provider);
	const providers = isObject(config.model_providers) ? config.model_providers : {};
	const entry = id && id !== "openai" ? providers[id] : undefined;
	const baseUrl = isObject(entry) ? text(entry.base_url) : undefined;
	if (!id || !isObject(entry) || !baseUrl) return result;
	if (entry.requires_openai_auth === true || OTHER_AUTH.some((key) => entry[key] != null)) return result;
	const headers = strings(entry.http_headers);
	for (const [header, variable] of Object.entries(strings(entry.env_http_headers))) {
		const value = text(env[variable]);
		if (value) headers[header] = value;
	}
	const envKey = text(entry.env_key);
	const key = text(entry.experimental_bearer_token) ?? (envKey ? text(env[envKey]) : undefined);
	if (key) headers.Authorization = `Bearer ${key}`;
	return { ...result, provider: { id, baseUrl, headers, query: strings(entry.query_params) } };
}

/** NewAPI endpoint types of models that do not chat (images, embeddings, rerank, video). */
const NOT_CHAT = new Set(["image-generation", "embeddings", "jina-rerank", "openai-video"]);

/**
 * Whether Codex can chat with a listed model: NewAPI-style lists name each model's endpoint
 * types, and Codex needs an OpenAI one; lists without types are taken as they are.
 */
function chats(model: Json): boolean {
	const types = Array.isArray(model.supported_endpoint_types)
		? model.supported_endpoint_types.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase())
		: [];
	if (!types.length) return true;
	if (types.some((t) => NOT_CHAT.has(t))) return false;
	return types.includes("openai") || types.includes("openai-response");
}

/** The ids of the chat models a provider lists at `GET <base_url>/models` (OpenAI's format). */
export async function fetchProviderModels(
	provider: CodexProviderEndpoint,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
	const url = new URL(`${provider.baseUrl.replace(/\/+$/, "")}/models`);
	for (const [key, value] of Object.entries(provider.query)) url.searchParams.set(key, value);
	const response = await fetchImpl(url, { headers: { Accept: "application/json", ...provider.headers }, signal });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = (await response.json()) as unknown;
	const data = isObject(body) && Array.isArray(body.data) ? body.data : undefined;
	if (!data) throw new Error("not an OpenAI model list");
	const ids: string[] = [];
	for (const model of data) {
		const id = isObject(model) ? text(model.id) : undefined;
		if (id && chats(model as Json) && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** A model Codex's catalog does not describe: no thinking levels (Codex sends no effort for it). */
function customModel(id: string, contextWindow: number | undefined): ModelInfo {
	return {
		provider: CODEX_PROVIDER,
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		...(contextWindow ? { contextWindow } : {}),
		thinkingLevels: ["off"],
	};
}

/**
 * The models Pier offers for Codex, the default first: the configured `model`, else the
 * catalog's default. `providerModels` (what a custom provider lists) replaces the catalog;
 * models also in the catalog keep its description.
 */
export function codexModelList(catalog: ModelInfo[], config: CodexModelConfig, providerModels?: string[]): ModelInfo[] {
	const describe = (id: string) => catalog.find((m) => m.id === id) ?? customModel(id, config.contextWindow);
	let list = providerModels?.length ? providerModels.map(describe) : [...catalog];
	const first = config.model ?? (providerModels?.length ? catalog[0]?.id : undefined);
	if (config.model && !list.some((m) => m.id === config.model)) list = [describe(config.model), ...list];
	const index = first ? list.findIndex((m) => m.id === first) : -1;
	if (index > 0) list = [list[index] as ModelInfo, ...list.slice(0, index), ...list.slice(index + 1)];
	return list;
}
