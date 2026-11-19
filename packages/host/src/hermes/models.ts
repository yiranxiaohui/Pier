import type { ModelInfo, ThinkingLevel } from "@pier/protocol";
import type { Json } from "./acp.ts";

/**
 * Hermes' model and reasoning pickers, read from a session's ACP `configOptions` (or the older
 * `models` state). Hermes names a model choice `provider:model` (`custom:<name>:<model>` for its
 * named endpoints); Pier shows the provider and the model apart and keeps the choice to send back.
 */

export const MODEL_CONFIG_ID = "model";
export const REASONING_CONFIG_ID = "reasoning_effort";

/** Pier's thinking levels in order; Hermes calls `off` `none`. */
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface HermesModelState {
	models: ModelInfo[];
	/** Hermes' choice of each model, by {@link modelKey}. */
	values: Map<string, string>;
	current?: ModelInfo;
	/** The thinking levels Hermes offers (`["off"]` when it offers none). */
	levels: ThinkingLevel[];
	thinking: ThinkingLevel;
	/** Hermes reported its reasoning picker. */
	hasReasoning: boolean;
}

export function modelKey(provider: string, id: string): string {
	return `${provider}\u0000${id}`;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

/** `deepseek:deepseek-chat` → `deepseek` / `deepseek-chat`; `custom:proxy:gpt-x` → `custom:proxy` / `gpt-x`. */
export function splitChoice(value: string): { provider: string; id: string } {
	if (value.startsWith("custom:")) {
		const rest = value.slice("custom:".length);
		const at = rest.indexOf(":");
		if (at > 0) return { provider: `custom:${rest.slice(0, at)}`, id: rest.slice(at + 1) };
	}
	const at = value.indexOf(":");
	if (at > 0 && at < value.length - 1) return { provider: value.slice(0, at), id: value.slice(at + 1) };
	return { provider: "hermes", id: value };
}

interface Choice {
	value: string;
	name?: string;
	description?: string;
}

/** The choices of a select option; grouped options are flattened. */
function choices(options: unknown): Choice[] {
	if (!Array.isArray(options)) return [];
	return (options as Json[]).flatMap((option) => {
		if (!option || typeof option !== "object") return [];
		if (Array.isArray(option.options)) return choices(option.options);
		const value = str(option.value) ?? str(option.modelId);
		if (!value) return [];
		return [
			{
				value,
				...(str(option.name) ? { name: option.name as string } : {}),
				...(str(option.description) ? { description: option.description as string } : {}),
			},
		];
	});
}

function selectOption(
	configOptions: unknown,
	id: string,
	category: string,
): { current?: string; choices: Choice[] } | undefined {
	if (!Array.isArray(configOptions)) return undefined;
	const option = (configOptions as Json[]).find(
		(o) => o && typeof o === "object" && o.type === "select" && (o.id === id || o.category === category),
	);
	if (!option) return undefined;
	const current = str(option.currentValue);
	return { ...(current ? { current } : {}), choices: choices(option.options) };
}

function modelInfo(choice: Choice, levels: ThinkingLevel[]): ModelInfo {
	const { provider, id } = splitChoice(choice.value);
	// Hermes labels choices `<Provider> · <model>` and describes them `Provider: <Provider>[ • current]`.
	const label = choice.name?.split(" · ");
	const described = /^Provider:\s*([^•]+?)\s*(?:•|$)/.exec(choice.description ?? "")?.[1];
	const providerName = described ?? (label && label.length > 1 ? label[0]?.trim() : undefined);
	const name = label && label.length > 1 ? label.slice(1).join(" · ").trim() : (choice.name ?? id);
	return {
		provider,
		...(providerName && providerName !== provider ? { providerName } : {}),
		id,
		name: name || id,
		reasoning: levels.length > 1,
		// Hermes accepts images with every model (it describes them for models without vision).
		input: ["text", "image"],
		thinkingLevels: levels,
	};
}

/** Hermes' reasoning effort as a Pier thinking level (`default`: the profile's, usually `medium`). */
function thinkingOf(value: string | undefined, levels: ThinkingLevel[]): ThinkingLevel {
	if (value === "none") return "off";
	if (value && (LEVELS as string[]).includes(value) && levels.includes(value as ThinkingLevel))
		return value as ThinkingLevel;
	if (levels.includes("medium")) return "medium";
	return levels.at(-1) ?? "off";
}

/** Hermes' value for a Pier thinking level. */
export function reasoningValue(level: ThinkingLevel): string {
	return level === "off" ? "none" : level;
}

/**
 * The pickers of a `session/new` / `session/load` result or of `configOptions` updates.
 * `previous` fills in what the update leaves out.
 */
export function modelState(result: Json, previous?: HermesModelState): HermesModelState {
	const configOptions = result.configOptions;
	const reasoning = selectOption(configOptions, REASONING_CONFIG_ID, "thought_level");
	const levels = reasoning
		? LEVELS.filter((level) => reasoning.choices.some((c) => c.value === reasoningValue(level)))
		: (previous?.levels ?? ["off"]);
	const offered = levels.length ? levels : (["off"] as ThinkingLevel[]);
	let picker = selectOption(configOptions, MODEL_CONFIG_ID, "model");
	const legacy = result.models && typeof result.models === "object" ? (result.models as Json) : undefined;
	if (!picker && legacy) {
		const current = str(legacy.currentModelId);
		picker = { ...(current ? { current } : {}), choices: choices(legacy.availableModels) };
	}
	let models = previous?.models ?? [];
	let values = previous?.values ?? new Map<string, string>();
	if (picker && (picker.choices.length || !previous)) {
		models = [];
		values = new Map();
		for (const choice of picker.choices) {
			const model = modelInfo(choice, offered);
			const key = modelKey(model.provider, model.id);
			if (values.has(key)) continue;
			values.set(key, choice.value);
			models.push(model);
		}
	} else if (reasoning) {
		models = models.map((m) => ({ ...m, reasoning: offered.length > 1, thinkingLevels: offered }));
	}
	const currentValue = picker?.current;
	let current = previous?.current;
	if (currentValue) {
		const { provider, id } = splitChoice(currentValue);
		current =
			models.find((m) => values.get(modelKey(m.provider, m.id)) === currentValue) ??
			modelInfo({ value: currentValue, name: id }, offered);
		if (!values.has(modelKey(provider, id))) values.set(modelKey(provider, id), currentValue);
	} else if (current && reasoning) {
		current = { ...current, reasoning: offered.length > 1, thinkingLevels: offered };
	}
	return {
		models,
		values,
		...(current ? { current } : {}),
		levels: offered,
		thinking: reasoning ? thinkingOf(reasoning.current, offered) : (previous?.thinking ?? "off"),
		hasReasoning: reasoning !== undefined || previous?.hasReasoning === true,
	};
}
