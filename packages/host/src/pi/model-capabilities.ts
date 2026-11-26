/**
 * Capabilities of models listed by relays and custom endpoints.
 *
 * `GET /models` only returns ids, so a custom endpoint's models would all look like plain text
 * models without thinking levels. pi ships a catalog of the models its built-in providers offer;
 * relays usually use the same ids (sometimes with a vendor prefix or a date suffix), so the
 * catalog tells whether a model reasons, accepts images, and how large its context is. Ids the
 * catalog does not know fall back to name patterns for the reasoning and image flags only.
 *
 * The catalog also says which thinking levels a model officially offers (`thinkingLevelMap`,
 * e.g. `xhigh` / `max`, or no `off`) and, for Claude, whether it uses adaptive thinking. Those
 * values are wire values of an API family, so they are only taken from the model vendor's own
 * catalog entries (not gateways') that speak the same family as the custom endpoint.
 */

/** What is known about a model. Absent fields are unknown. */
export interface ModelCapabilities {
	reasoning?: boolean;
	images?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

/** pi's per-level thinking values (`null` = the level is not offered). */
export type ThinkingLevelMap = Readonly<Record<string, string | null | undefined>>;

/** A catalog model (pi's `Model`, reduced to what is needed here). */
export interface CatalogModel {
	provider: string;
	id: string;
	api?: string;
	reasoning?: boolean;
	input?: readonly string[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: unknown;
}

/** How a model thinks, per its catalog entry for the same API family. */
export interface ThinkingSettings {
	thinkingLevelMap?: Record<string, string | null>;
	/** Claude models that only accept adaptive thinking (`compat.forceAdaptiveThinking`). */
	forceAdaptiveThinking?: boolean;
}

/**
 * APIs whose thinking values mean the same thing. OpenAI's Responses and Chat Completions both
 * take `reasoning_effort` strings; Anthropic takes `effort`; Google takes Gemini levels.
 */
const API_FAMILY: Record<string, string> = {
	"openai-completions": "openai",
	"openai-responses": "openai",
	"azure-openai-responses": "openai",
	"anthropic-messages": "anthropic",
	"google-generative-ai": "google",
	"google-vertex": "google",
};

function apiFamily(api: unknown): string | undefined {
	return typeof api === "string" ? API_FAMILY[api] : undefined;
}

/** Whether thinking values written for API `a` mean the same for API `b`. */
export function sameThinkingFamily(a: unknown, b: unknown): boolean {
	return a === b || (apiFamily(a) !== undefined && apiFamily(a) === apiFamily(b));
}

/** Providers whose catalog entry for a model is the most authoritative, best first. */
const PROVIDER_RANK = [
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"xai",
	"mistral",
	"moonshotai",
	"zai",
	"minimax",
	"xiaomi",
	"openrouter",
	"vercel-ai-gateway",
];

/** How authoritative a provider's catalog entry for a model is; lower is better. */
export function providerRank(provider: string): number {
	const index = PROVIDER_RANK.indexOf(provider);
	return index === -1 ? PROVIDER_RANK.length : index;
}

/**
 * Model vendors' own APIs. Gateways (OpenRouter, Vercel, OpenCode, ...) map thinking levels to
 * their own wire values (e.g. `off` → `none`) and set their own prices, so only vendors' entries
 * count as official.
 */
export function firstParty(provider: string): boolean {
	return providerRank(provider) < PROVIDER_RANK.indexOf("openrouter");
}

/** Lowercase id without a vendor path (`anthropic/…`, `models/…`) or a `:variant` tag. */
export function baseId(id: string): string {
	let value = id.trim().toLowerCase();
	const slash = value.lastIndexOf("/");
	if (slash !== -1) value = value.slice(slash + 1);
	const colon = value.indexOf(":");
	if (colon !== -1) value = value.slice(0, colon);
	return value;
}

const DATE_SUFFIX = /(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2}|-\d{4}|-latest)$/;
const THINKING_SUFFIX = /[-_](?:thinking|think|reasoning)$/;
const NO_THINKING_SUFFIX = /[-_](?:no-?thinking|non-?thinking|nothink)$/;

/** Catalog ids (see {@link baseId}) to look up for `id`, most specific first. */
export function candidates(id: string): string[] {
	const out: string[] = [];
	const add = (value: string) => {
		if (value && !out.includes(value)) out.push(value);
	};
	const base = baseId(id);
	for (const variant of [base, base.replace(THINKING_SUFFIX, "").replace(NO_THINKING_SUFFIX, "")]) {
		for (const value of [variant, variant.replace(DATE_SUFFIX, "")]) {
			add(value);
			// `claude-sonnet-4.5` and `claude-sonnet-4-5` name the same model.
			add(value.replace(/(\d)\.(\d)/g, "$1-$2"));
			add(value.replace(/(\d)-(\d)(?!\d)/g, "$1.$2"));
		}
	}
	return out;
}

/**
 * Reasoning by name, for ids the catalog does not know. Only well-known reasoning families;
 * anything else stays unknown.
 */
const REASONING_NAME =
	/(?:^|[-_.])(?:thinking|reasoner|reasoning|r1)(?:$|[-_.])|^o[1-9](?:$|-)|^gpt-5|^gpt-oss|^claude-(?:opus|sonnet|haiku)-(?:4|[5-9])|^claude-[a-z]+-(?:[5-9])|^claude-3-7|^gemini-(?:2\.5|[3-9])|^qwq|^glm-(?:4\.[5-9]|[5-9])|^grok-(?:3-mini|[4-9])|^deepseek-(?:v3\.[1-9]|v[4-9])|^minimax-m[1-9]|^kimi-k2[.-]?(?:5|thinking)/;
const NOT_REASONING_NAME = /(?:no-?thinking|non-?thinking|nothink|instruct|embedding|tts|whisper|image|audio)/;
const IMAGES_NAME =
	/^claude-|^gpt-4o|^gpt-4\.1|^gpt-5|^o[34](?:$|-)|^gemini-|^grok-(?:[4-9]|vision)|vision|[-_]vl(?:$|[-_])/;
const NOT_IMAGES_NAME = /(?:embedding|tts|whisper|audio|codex-mini)/;

function byName(id: string): ModelCapabilities {
	const base = baseId(id);
	const out: ModelCapabilities = {};
	if (NO_THINKING_SUFFIX.test(base)) out.reasoning = false;
	else if (REASONING_NAME.test(base) && !NOT_REASONING_NAME.test(base)) out.reasoning = true;
	if (IMAGES_NAME.test(base) && !NOT_IMAGES_NAME.test(base)) out.images = true;
	return out;
}

/** Looks up model capabilities in a catalog of known models. */
export class ModelCapabilityIndex {
	private readonly byId = new Map<string, CatalogModel>();
	/** Catalog models with a thinking level map, by `family:id`. */
	private readonly thinkingById = new Map<string, CatalogModel>();

	constructor(models: Iterable<CatalogModel>) {
		for (const model of models) {
			const key = baseId(model.id);
			const current = this.byId.get(key);
			if (!current || providerRank(model.provider) < providerRank(current.provider)) this.byId.set(key, model);
			const family = apiFamily(model.api);
			if (family && model.reasoning === true && isObject(model.thinkingLevelMap) && firstParty(model.provider)) {
				const thinkingKey = `${family}:${key}`;
				const known = this.thinkingById.get(thinkingKey);
				if (!known || providerRank(model.provider) < providerRank(known.provider))
					this.thinkingById.set(thinkingKey, model);
			}
		}
	}

	/**
	 * The official thinking settings of `id` when called with `api`, from the best catalog entry
	 * of the same API family. Undefined when the catalog does not know the model for that family.
	 */
	thinking(id: string, api: unknown): ThinkingSettings | undefined {
		const family = apiFamily(api);
		if (!family) return undefined;
		const model = candidates(id)
			.map((key) => this.thinkingById.get(`${family}:${key}`))
			.find(Boolean);
		if (!model?.thinkingLevelMap) return undefined;
		const map: Record<string, string | null> = {};
		for (const [level, value] of Object.entries(model.thinkingLevelMap)) {
			if (typeof value === "string" || value === null) map[level] = value;
		}
		const out: ThinkingSettings = {};
		if (Object.keys(map).length) out.thinkingLevelMap = map;
		if (family === "anthropic" && isObject(model.compat) && model.compat.forceAdaptiveThinking === true) {
			out.forceAdaptiveThinking = true;
		}
		return out.thinkingLevelMap || out.forceAdaptiveThinking ? out : undefined;
	}

	get size(): number {
		return this.byId.size;
	}

	/** Capabilities of `id`, from the catalog or, failing that, from its name. */
	lookup(id: string): ModelCapabilities {
		const base = baseId(id);
		const model = candidates(id)
			.map((key) => this.byId.get(key))
			.find(Boolean);
		if (!model) return byName(id);
		const out: ModelCapabilities = {
			reasoning: model.reasoning === true,
			images: (model.input ?? []).includes("image"),
			...(typeof model.contextWindow === "number" && model.contextWindow > 0
				? { contextWindow: model.contextWindow }
				: {}),
			...(typeof model.maxTokens === "number" && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
		};
		// Relays expose thinking and non-thinking variants of one model under suffixed ids.
		if (THINKING_SUFFIX.test(base)) out.reasoning = true;
		else if (NO_THINKING_SUFFIX.test(base)) out.reasoning = false;
		return out;
	}

	/** `model` with its unknown (undefined) capability fields filled in. */
	fill<T extends { id: string } & ModelCapabilities>(model: T): T {
		const known = this.lookup(model.id);
		const out = { ...model };
		if (out.reasoning === undefined && known.reasoning !== undefined) out.reasoning = known.reasoning;
		if (out.images === undefined && known.images !== undefined) out.images = known.images;
		if (out.contextWindow === undefined && known.contextWindow !== undefined) out.contextWindow = known.contextWindow;
		if (out.maxTokens === undefined && known.maxTokens !== undefined) out.maxTokens = known.maxTokens;
		return out;
	}
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill the capability fields a models.json model entry leaves out (`reasoning`, `input`,
 * `contextWindow`, `maxTokens`) and, for reasoning models called with `api` (the model's own
 * `api`, else the provider's), the official thinking levels (`thinkingLevelMap`) and
 * `compat.forceAdaptiveThinking`. Fields that are present, including `reasoning: false` and a
 * hand-written `thinkingLevelMap`, are kept. Returns the entry unchanged (same object) when
 * nothing is known to add.
 */
export function fillModelEntry(index: ModelCapabilityIndex, entry: Json, providerApi?: unknown): Json {
	if (typeof entry.id !== "string" || !entry.id) return entry;
	const known = index.lookup(entry.id);
	const next: Json = { ...entry };
	let changed = false;
	if (entry.reasoning === undefined && known.reasoning === true) {
		next.reasoning = true;
		changed = true;
	}
	if (entry.input === undefined && known.images === true) {
		next.input = ["text", "image"];
		changed = true;
	}
	if (entry.contextWindow === undefined && known.contextWindow !== undefined) {
		next.contextWindow = known.contextWindow;
		changed = true;
	}
	if (entry.maxTokens === undefined && known.maxTokens !== undefined) {
		next.maxTokens = known.maxTokens;
		changed = true;
	}
	const thinking = next.reasoning === true ? index.thinking(entry.id, entry.api ?? providerApi) : undefined;
	if (thinking?.thinkingLevelMap && entry.thinkingLevelMap === undefined) {
		next.thinkingLevelMap = thinking.thinkingLevelMap;
		changed = true;
	}
	if (thinking?.forceAdaptiveThinking && (entry.compat === undefined || isObject(entry.compat))) {
		const compat = (entry.compat ?? {}) as Json;
		if (compat.forceAdaptiveThinking === undefined) {
			next.compat = { ...compat, forceAdaptiveThinking: true };
			changed = true;
		}
	}
	return changed ? next : entry;
}

/**
 * models.json providers with unknown capability fields of their models filled in. Built-in
 * provider overrides (`skip`) and entries without a model list are left alone. Returns undefined
 * when nothing changed.
 */
export function fillModelsJsonProviders(
	index: ModelCapabilityIndex,
	providers: Record<string, Json>,
	skip: ReadonlySet<string>,
): { providers: Record<string, Json>; filled: number } | undefined {
	let filled = 0;
	const next: Record<string, Json> = { ...providers };
	for (const [id, provider] of Object.entries(providers)) {
		if (skip.has(id) || !isObject(provider) || !Array.isArray(provider.models)) continue;
		let changed = false;
		const models = provider.models.map((model) => {
			if (!isObject(model)) return model;
			const out = fillModelEntry(index, model, provider.api);
			if (out !== model) {
				changed = true;
				filled++;
			}
			return out;
		});
		if (changed) next[id] = { ...provider, models };
	}
	return filled ? { providers: next, filled } : undefined;
}
