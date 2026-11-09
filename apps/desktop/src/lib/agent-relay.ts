/**
 * Point Claude Code and Codex at a 云链API group from the personal center: the changes to their
 * user configuration files (`~/.claude/settings.json`, `~/.codex/config.toml`), and how to tell
 * which group they use now. The token key is never seen here: the changes carry the key
 * reference from `account.useToken`, which the host replaces with the key (protocol 1.25).
 */

import type { CustomProvider, CustomProviderApi, NewApiModel } from "@pier/protocol";
import type { SettingsObject } from "./config-fields.ts";
import { newApiBaseUrl, siteAddresses } from "./yunlian.ts";

/** One change for `agentConfig.update`: set `value`, set the key behind `apiKeyRef`, or remove. */
export interface AgentConfigEdit {
	path: string[];
	value?: unknown;
	apiKeyRef?: string;
}

/** A group configured in the personal center, as Claude Code and Codex use it. */
export interface RelayGroup {
	/** The group's pi provider id (`yunlian-…`), also its Codex provider id. */
	id: string;
	/** Shown name, e.g. `云链API · Claude`. */
	name: string;
	siteUrl: string;
	models: Array<{ id: string; api: CustomProviderApi }>;
}

/** The models of a group's pi provider, each with the wire API it is called with. */
export function relayModels(provider: Pick<CustomProvider, "api" | "models">): RelayGroup["models"] {
	return provider.models.map((m) => ({ id: m.id, api: m.api ?? provider.api }));
}

/**
 * The models a token lists (`account.useToken`), for a group not added to pi: each with the API
 * the site detected for it, Chat Completions when it gave none (as `relayProvider` does).
 */
export function tokenRelayModels(models: ReadonlyArray<NewApiModel>): RelayGroup["models"] {
	const seen = new Set<string>();
	const list: RelayGroup["models"] = [];
	for (const model of models) {
		const id = model.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		list.push({ id, api: model.api ?? "openai-completions" });
	}
	return list;
}

function isObject(value: unknown): value is SettingsObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameUrl(a: string | undefined, b: string): boolean {
	const norm = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
	return a !== undefined && norm(a) === norm(b);
}

// ---- Claude Code -------------------------------------------------------------------------

/** Claude Code's model aliases that `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` maps to a model id. */
export const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku"] as const;
export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];

const familyEnv = (family: ClaudeFamily) => `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;

/** Models Claude Code can call: the ones served over Anthropic Messages. */
export function claudeModels(group: Pick<RelayGroup, "models">): string[] {
	return group.models.filter((m) => m.api === "anthropic-messages").map((m) => m.id);
}

/** The words of a model id: `claude-opus-4-1` → claude, opus, 4, 1. */
function idParts(id: string): string[] {
	return id.toLowerCase().split(/[-_.:/@\s]+/);
}

/** Sort key of a Claude model id: version numbers, then plain ids, then the newest snapshot date. */
function claudeRank(id: string): { version: number[]; plain: boolean; date: number } {
	const parts = idParts(id);
	const version: number[] = [];
	let date = 0;
	let plain = true;
	for (const part of parts) {
		if (/^\d{8}$/.test(part)) date = Number(part);
		else if (/^\d{1,3}$/.test(part)) version.push(Number(part));
		else if (part !== "claude" && part !== "latest" && !(CLAUDE_FAMILIES as readonly string[]).includes(part))
			plain = false;
	}
	return { version, plain, date };
}

function compareRank(a: ReturnType<typeof claudeRank>, b: ReturnType<typeof claudeRank>): number {
	for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
		const diff = (a.version[i] ?? 0) - (b.version[i] ?? 0);
		if (diff) return diff;
	}
	if (a.plain !== b.plain) return a.plain ? 1 : -1;
	return a.date - b.date;
}

/** The newest model of a family (`claude-opus-4-1` over `claude-3-opus`), if the group has one. */
export function claudeFamilyModel(models: ReadonlyArray<string>, family: ClaudeFamily): string | undefined {
	let best: { id: string; rank: ReturnType<typeof claudeRank> } | undefined;
	for (const id of models) {
		if (!idParts(id).includes(family)) continue;
		const rank = claudeRank(id);
		if (!best || compareRank(rank, best.rank) > 0) best = { id, rank };
	}
	return best?.id;
}

/**
 * Point Claude Code at a group: the site's Anthropic endpoint with the token (as a bearer
 * token, the way relays expect it), each alias mapped to the group's newest model of that
 * family, and `model` set to `model` (or removed to use Claude Code's default alias). Settings
 * that would send other credentials or models to the relay are removed.
 */
export function claudeRelayChanges(group: RelayGroup, apiKeyRef: string, model?: string): AgentConfigEdit[] {
	const models = claudeModels(group);
	const changes: AgentConfigEdit[] = [
		{ path: ["env", "ANTHROPIC_BASE_URL"], value: newApiBaseUrl(group.siteUrl, "anthropic-messages") },
		{ path: ["env", "ANTHROPIC_AUTH_TOKEN"], apiKeyRef },
		{ path: ["env", "ANTHROPIC_API_KEY"] },
		{ path: ["apiKeyHelper"] },
		{ path: ["env", "ANTHROPIC_MODEL"] },
		{ path: ["env", "ANTHROPIC_SMALL_FAST_MODEL"] },
	];
	for (const family of CLAUDE_FAMILIES) {
		const id = claudeFamilyModel(models, family);
		changes.push(id ? { path: ["env", familyEnv(family)], value: id } : { path: ["env", familyEnv(family)] });
	}
	changes.push(model ? { path: ["model"], value: model } : { path: ["model"] });
	return changes;
}

/** Aliases and other values of `model` that are not model ids. */
function isClaudeAlias(value: string): boolean {
	return /^(default|best|opus|sonnet|haiku|opusplan)(\[1m\])?$/i.test(value);
}

export interface ClaudeRelayState {
	/** `ANTHROPIC_BASE_URL` is the site's (on any of its lines). */
	site: boolean;
	/**
	 * Also every model id Claude Code is set to use (main model and aliases) is among the group's
	 * (with none set, any group of the site matches).
	 */
	group: boolean;
	model?: string;
}

/** How Claude Code's user settings relate to a group of the site. */
export function claudeRelayState(settings: SettingsObject | undefined, group: RelayGroup): ClaudeRelayState {
	const env = isObject(settings?.env) ? settings.env : {};
	const baseUrl = text(env.ANTHROPIC_BASE_URL);
	const site = siteAddresses(group.siteUrl).some((url) => sameUrl(baseUrl, newApiBaseUrl(url, "anthropic-messages")));
	const model = text(settings?.model);
	const ids = [model, ...CLAUDE_FAMILIES.map((f) => text(env[familyEnv(f)]))].filter(
		(id): id is string => id !== undefined && !isClaudeAlias(id),
	);
	const known = new Set(claudeModels(group));
	return {
		site,
		group: site && ids.every((id) => known.has(id)),
		...(model ? { model } : {}),
	};
}

/** Remove the Claude Code settings written for this group, preserving unrelated model choices. */
export function claudeRelayRemovalChanges(group: RelayGroup, settings: SettingsObject | undefined): AgentConfigEdit[] {
	const state = claudeRelayState(settings, group);
	if (!state.group) return [];
	const env = isObject(settings?.env) ? settings.env : {};
	const models = new Set(claudeModels(group));
	const configuredModels = [state.model, ...CLAUDE_FAMILIES.map((family) => text(env[familyEnv(family)]))].filter(
		(id): id is string => id !== undefined && !isClaudeAlias(id),
	);
	// A site URL alone is shared by all groups; without a model id we cannot safely identify one.
	if (!configuredModels.length || !configuredModels.every((id) => models.has(id))) return [];
	const changes: AgentConfigEdit[] = [
		{ path: ["env", "ANTHROPIC_BASE_URL"] },
		{ path: ["env", "ANTHROPIC_AUTH_TOKEN"] },
	];
	for (const family of CLAUDE_FAMILIES) {
		const key = familyEnv(family);
		if (models.has(String(env[key] ?? ""))) changes.push({ path: ["env", key] });
	}
	if (state.model && models.has(state.model)) changes.push({ path: ["model"] });
	return changes;
}

// ---- Codex -------------------------------------------------------------------------------

const RANK: Partial<Record<CustomProviderApi, number>> = { "openai-responses": 0, "openai-completions": 1 };

/**
 * The group's models for Codex, OpenAI-style ones first: Codex calls them with the Responses
 * API, which NewAPI serves for OpenAI channels.
 */
export function codexModels(group: Pick<RelayGroup, "models">): Array<{ id: string; suited: boolean }> {
	return group.models
		.map((m, i) => ({ id: m.id, rank: RANK[m.api] ?? 2, i }))
		.sort((a, b) => a.rank - b.rank || a.i - b.i)
		.map((m) => ({ id: m.id, suited: m.rank < 2 }));
}

/**
 * Point Codex at a group: a `[model_providers.<group id>]` entry for the site's Responses API
 * with the token, made the current provider, and `model`. Keys of the entry that would use
 * other credentials are removed; anything else in it is kept.
 */
export function codexRelayChanges(group: RelayGroup, apiKeyRef: string, model: string): AgentConfigEdit[] {
	const base = ["model_providers", group.id];
	return [
		{ path: [...base, "name"], value: group.name },
		{ path: [...base, "base_url"], value: newApiBaseUrl(group.siteUrl, "openai-responses") },
		{ path: [...base, "wire_api"], value: "responses" },
		{ path: [...base, "experimental_bearer_token"], apiKeyRef },
		{ path: [...base, "env_key"] },
		{ path: [...base, "requires_openai_auth"] },
		{ path: ["model_provider"], value: group.id },
		{ path: ["model"], value: model },
	];
}

export interface CodexRelayState {
	/** The group's provider is Codex's current provider. */
	current: boolean;
	/** The group's provider is defined. */
	defined: boolean;
	model?: string;
}

/** How Codex's user config relates to a group. */
export function codexRelayState(settings: SettingsObject | undefined, group: RelayGroup): CodexRelayState {
	const providers = isObject(settings?.model_providers) ? settings.model_providers : {};
	const model = text(settings?.model);
	return {
		current: text(settings?.model_provider) === group.id,
		defined: isObject(providers[group.id]),
		...(model ? { model } : {}),
	};
}

/** Remove this group's Codex provider and, when current, its active model selection. */
export function codexRelayRemovalChanges(group: RelayGroup, settings: SettingsObject | undefined): AgentConfigEdit[] {
	const state = codexRelayState(settings, group);
	if (!state.defined) return [];
	return [
		{ path: ["model_providers", group.id] },
		...(state.current ? [{ path: ["model_provider"] }, { path: ["model"] }] : []),
	];
}
