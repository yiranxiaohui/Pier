import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import {
	type AuthMethod,
	type AuthNotice,
	type AuthPromptInfo,
	type CustomModel,
	type CustomProvider,
	type CustomProviderApi,
	type DefaultModelRef,
	type EventFrame,
	type PierHostEvent,
	PierProtocolError,
	type ProviderInfo,
	type ProviderListResult,
} from "@pier/protocol";
import type { PiEnvironment } from "./environment.ts";
import { fillModelsJsonProviders, ModelCapabilityIndex } from "./model-capabilities.ts";
import { ModelPriceIndex } from "./model-prices.ts";
import {
	loadModelsJson,
	mergeCustomProvider,
	restoreModelsJson,
	toCustomProvider,
	writeModelsJson,
} from "./models-json.ts";
import { detectNewApiModelApi } from "./newapi.ts";

const CANCELLED = "Login cancelled";
const CREDENTIAL_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 15_000;

/** The connection that started a sign-in (a `Connection` in the host). */
export interface AuthFlowTarget {
	readonly connectionId: string;
	readonly isClosed: boolean;
	send(frame: EventFrame): void;
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		return cause instanceof Error && cause.message && !error.message.includes(cause.message)
			? `${error.message}: ${cause.message}`
			: error.message;
	}
	return String(error);
}

function toNotice(event: AuthEvent): AuthNotice {
	switch (event.type) {
		case "info":
			return {
				type: "info",
				message: event.message,
				...(event.links?.length
					? { links: event.links.map((l) => ({ url: l.url, ...(l.label ? { label: l.label } : {}) })) }
					: {}),
			};
		case "auth_url":
			return { type: "auth_url", url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
		case "device_code":
			return {
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
			};
		default:
			return { type: "progress", message: event.message };
	}
}

function toPromptInfo(id: string, prompt: AuthPrompt): AuthPromptInfo {
	return {
		id,
		type: prompt.type,
		message: prompt.message,
		...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
		...(prompt.type === "select"
			? {
					options: prompt.options.map((o) => ({
						id: o.id,
						label: o.label,
						...(o.description ? { description: o.description } : {}),
					})),
				}
			: {}),
	};
}

interface PendingPrompt {
	resolve(value: string): void;
	reject(error: Error): void;
	cleanup(): void;
}

/** One interactive sign-in driven by a client over `auth.*` events. */
class AuthFlow {
	readonly id = randomUUID();
	readonly controller = new AbortController();
	private readonly pending = new Map<string, PendingPrompt>();

	constructor(
		readonly target: AuthFlowTarget,
		readonly providerId: string,
		readonly method: AuthMethod,
	) {}

	send(event: PierHostEvent): void {
		if (!this.target.isClosed) this.target.send({ type: "evt", event });
	}

	prompt(prompt: AuthPrompt): Promise<string> {
		if (this.controller.signal.aborted) return Promise.reject(new Error(CANCELLED));
		const promptId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			const signal = prompt.signal;
			const onAbort = () => {
				const entry = this.pending.get(promptId);
				if (!entry) return;
				this.pending.delete(promptId);
				this.send({ type: "auth.promptClosed", flowId: this.id, promptId });
				reject(new Error(CANCELLED));
			};
			this.pending.set(promptId, {
				resolve,
				reject,
				cleanup: () => signal?.removeEventListener("abort", onAbort),
			});
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.send({ type: "auth.prompt", flowId: this.id, prompt: toPromptInfo(promptId, prompt) });
		});
	}

	notify(event: AuthEvent): void {
		this.send({ type: "auth.notice", flowId: this.id, notice: toNotice(event) });
	}

	respond(promptId: string, value: string | undefined, cancelled: boolean): boolean {
		const entry = this.pending.get(promptId);
		if (!entry) return false;
		this.pending.delete(promptId);
		entry.cleanup();
		if (cancelled) entry.reject(new Error(CANCELLED));
		else entry.resolve(value ?? "");
		return true;
	}

	cancel(): void {
		this.controller.abort();
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			entry.cleanup();
			entry.reject(new Error(CANCELLED));
		}
	}
}

export interface ProviderManagerOptions {
	/** Called after providers, credentials, models.json, or the default model changed. */
	onChanged: () => void;
	log?: (message: string) => void;
}

/**
 * Model providers and credentials: sign-in / sign-out through pi's auth flows, custom
 * endpoints in models.json, and the default model for new sessions.
 */
export class ProviderManager {
	private readonly flows = new Map<string, AuthFlow>();
	private builtinCache: { sdk: object; ids: ReadonlySet<string> } | undefined;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly env: PiEnvironment,
		private readonly options: ProviderManagerOptions,
	) {}

	private get runtime() {
		return this.env.modelRuntime;
	}

	/** Providers of pi's built-in catalog (needs a loaded pi). */
	private get builtinIds(): ReadonlySet<string> {
		const sdk = this.env.sdk();
		if (this.builtinCache?.sdk !== sdk) this.builtinCache = { sdk, ids: new Set(sdk.builtinProviders()) };
		return this.builtinCache.ids;
	}

	/** Run config edits one at a time. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private changed(): void {
		try {
			this.options.onChanged();
		} catch {
			// Listeners must not break config operations.
		}
	}

	/** pi's catalog of the models its built-in providers offer. */
	private capabilityIndex(): ModelCapabilityIndex {
		const runtime = this.runtime;
		return new ModelCapabilityIndex([...this.builtinIds].flatMap((id) => runtime.getModels(id)));
	}

	/**
	 * Official prices of the models in pi's catalog (for `usage.stats`, 1.70); undefined until pi
	 * is loaded.
	 */
	priceIndex(): ModelPriceIndex | undefined {
		if (!this.env.loaded) return undefined;
		const runtime = this.runtime;
		return new ModelPriceIndex([...this.builtinIds].flatMap((id) => runtime.getModels(id)));
	}

	/**
	 * Fill in the capabilities (reasoning, image input, context window, output limit, and the
	 * official thinking levels) that custom providers in models.json leave out, from pi's model
	 * catalog. Settings that are present are kept. Returns the number of models that changed.
	 */
	fillCapabilities(): Promise<number> {
		return this.serialize(async () => {
			const path = this.env.modelsPath;
			let loaded: ReturnType<typeof loadModelsJson>;
			try {
				loaded = loadModelsJson(path);
			} catch {
				return 0;
			}
			const result = fillModelsJsonProviders(this.capabilityIndex(), loaded.doc.providers, this.builtinIds);
			if (!result) return 0;
			const errorsBefore = this.runtime.getError() ?? "";
			writeModelsJson(path, loaded, { ...loaded.doc, providers: result.providers });
			await this.runtime.refresh({ allowNetwork: false });
			if ((this.runtime.getError() ?? "") !== errorsBefore) {
				restoreModelsJson(path, loaded.raw);
				await this.runtime.refresh({ allowNetwork: false }).catch(() => undefined);
				return 0;
			}
			this.options.log?.(`Filled in the capabilities of ${result.filled} custom model(s) from pi's catalog`);
			this.changed();
			return result.filled;
		});
	}

	defaultModel(): DefaultModelRef | undefined {
		const settings = this.env.globalSettings();
		const provider = settings.getDefaultProvider();
		const modelId = settings.getDefaultModel();
		return provider && modelId ? { provider, modelId } : undefined;
	}

	async list(): Promise<ProviderListResult> {
		const runtime = this.runtime;
		const available = await runtime.getAvailable().catch(() => runtime.getAvailableSnapshot());
		let stored = new Set<string>();
		try {
			const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) });
			stored = new Set(credentials.map((c) => c.providerId));
		} catch {
			// auth.json unreadable: report providers without the stored flag.
		}
		let entries: Record<string, Record<string, unknown>> = {};
		let fileError: string | undefined;
		try {
			entries = loadModelsJson(this.env.modelsPath).doc.providers;
		} catch (error) {
			fileError = errorText(error);
		}

		const providers: ProviderInfo[] = [];
		const seen = new Set<string>();
		for (const provider of runtime.getProviders()) {
			seen.add(provider.id);
			const builtin = this.builtinIds.has(provider.id);
			const status = runtime.getProviderAuthStatus(provider.id);
			const entry = entries[provider.id];
			const custom = !builtin && entry ? toCustomProvider(provider.id, entry) : undefined;
			const { apiKey, oauth } = provider.auth;
			providers.push({
				id: provider.id,
				name: provider.name || provider.id,
				builtin,
				...(apiKey ? { apiKey: { name: apiKey.name, interactive: typeof apiKey.login === "function" } } : {}),
				...(oauth
					? {
							oauth: {
								name: oauth.name,
								...(oauth.loginLabel ? { loginLabel: oauth.loginLabel } : {}),
								subscription: oauth.isSubscription === true,
							},
						}
					: {}),
				status: {
					configured: status.configured,
					...(status.configured ? { type: runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key" } : {}),
					...(status.source ? { source: status.source } : {}),
					...(status.label ? { label: status.label } : {}),
				},
				stored: stored.has(provider.id),
				modelCount: runtime.getModels(provider.id).length,
				availableCount: available.filter((m) => m.provider === provider.id).length,
				...(custom ? { custom } : {}),
			});
		}
		// Custom entries pi could not load still show up so they can be fixed or removed.
		for (const [id, entry] of Object.entries(entries)) {
			if (seen.has(id) || this.builtinIds.has(id)) continue;
			const custom = toCustomProvider(id, entry);
			providers.push({
				id,
				name: typeof entry.name === "string" ? entry.name : id,
				builtin: false,
				status: { configured: false },
				stored: stored.has(id),
				modelCount: 0,
				availableCount: 0,
				...(custom ? { custom } : {}),
			});
		}
		providers.sort((a, b) => a.name.localeCompare(b.name));

		const defaultModel = this.defaultModel();
		const error = [fileError, runtime.getError()].filter(Boolean).join("\n\n");
		return {
			providers,
			...(defaultModel ? { defaultModel } : {}),
			defaultAvailable: Boolean(
				defaultModel && available.some((m) => m.provider === defaultModel.provider && m.id === defaultModel.modelId),
			),
			availableCount: available.length,
			agentDir: this.env.agentDir,
			...(error ? { error } : {}),
		};
	}

	/**
	 * When the default model is missing or unusable, pick an available one (from
	 * `preferProvider` first). Returns the new default, if it changed.
	 */
	async ensureDefault(preferProvider?: string): Promise<DefaultModelRef | undefined> {
		const available = await this.runtime.getAvailable().catch(() => this.runtime.getAvailableSnapshot());
		const current = this.defaultModel();
		if (current && available.some((m) => m.provider === current.provider && m.id === current.modelId)) return undefined;
		const candidate =
			(preferProvider ? available.find((m) => m.provider === preferProvider) : undefined) ?? available[0];
		if (!candidate) return undefined;
		const settings = this.env.globalSettings();
		settings.setDefaultModelAndProvider(candidate.provider, candidate.id);
		await settings.flush();
		return { provider: candidate.provider, modelId: candidate.id };
	}

	async setDefault(provider: string, modelId: string): Promise<DefaultModelRef> {
		if (!this.runtime.getModel(provider, modelId)) {
			throw new PierProtocolError("NOT_FOUND", `Model ${provider}/${modelId} not found`);
		}
		const settings = this.env.globalSettings();
		settings.setDefaultModelAndProvider(provider, modelId);
		await settings.flush();
		this.changed();
		return { provider, modelId };
	}

	// ---- interactive sign-in -------------------------------------------------------------

	/** Validate and create a sign-in; call `start()` after the response has been sent. */
	login(target: AuthFlowTarget, providerId: string, method: AuthMethod): { flowId: string; start: () => void } {
		const provider = this.runtime.getProvider(providerId);
		if (!provider) throw new PierProtocolError("NOT_FOUND", `Provider ${providerId} not found`);
		if (method === "oauth" && !provider.auth.oauth) {
			throw new PierProtocolError("BAD_REQUEST", `${provider.name} does not support account sign-in`);
		}
		if (method === "api_key" && !provider.auth.apiKey?.login) {
			throw new PierProtocolError(
				"BAD_REQUEST",
				`${provider.name} is configured through environment variables or cloud credentials`,
			);
		}
		// One sign-in per connection: a new one replaces an abandoned one.
		for (const flow of this.flows.values()) {
			if (flow.target.connectionId === target.connectionId) flow.cancel();
		}
		const flow = new AuthFlow(target, providerId, method);
		this.flows.set(flow.id, flow);
		return { flowId: flow.id, start: () => void this.runFlow(flow) };
	}

	private async runFlow(flow: AuthFlow): Promise<void> {
		const runtime = this.runtime;
		try {
			await runtime.login(flow.providerId, flow.method, {
				signal: flow.controller.signal,
				prompt: (prompt) => flow.prompt(prompt),
				notify: (event) => flow.notify(event),
			});
			const defaultModel = await this.ensureDefault(flow.providerId).catch(() => undefined);
			flow.send({
				type: "auth.done",
				flowId: flow.id,
				providerId: flow.providerId,
				ok: true,
				...(defaultModel ? { defaultModel } : {}),
			});
			// Dynamic catalogs may need an authenticated refresh (like pi's /login).
			void runtime
				.refresh({ providers: [flow.providerId], signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) })
				.catch(() => undefined)
				.then(() => this.changed());
		} catch (error) {
			const message = errorText(error);
			const cancelled = flow.controller.signal.aborted || message === CANCELLED;
			if (!cancelled) this.options.log?.(`Sign-in to ${flow.providerId} failed: ${message}`);
			flow.send({
				type: "auth.done",
				flowId: flow.id,
				providerId: flow.providerId,
				ok: false,
				...(cancelled ? { cancelled: true } : { error: message }),
			});
		} finally {
			flow.cancel();
			this.flows.delete(flow.id);
			this.changed();
		}
	}

	respond(connectionId: string, flowId: string, promptId: string, value?: string, cancelled?: boolean): boolean {
		const flow = this.flows.get(flowId);
		if (!flow || flow.target.connectionId !== connectionId) return false;
		return flow.respond(promptId, value, cancelled === true);
	}

	cancel(connectionId: string, flowId: string): boolean {
		const flow = this.flows.get(flowId);
		if (!flow || flow.target.connectionId !== connectionId) return false;
		flow.cancel();
		return true;
	}

	/** Abandon the sign-ins of a closed connection. */
	connectionClosed(connectionId: string): void {
		for (const flow of this.flows.values()) {
			if (flow.target.connectionId === connectionId) flow.cancel();
		}
	}

	/**
	 * Remove the credential pi currently uses for `providerId`: the one saved in auth.json,
	 * or, when there is none, the literal key / key command in its models.json entry.
	 * Environment variables are never touched.
	 */
	logout(providerId: string): Promise<boolean> {
		return this.serialize(async () => {
			const credentials = await this.runtime.listCredentials({ signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) });
			if (credentials.some((c) => c.providerId === providerId)) {
				await this.runtime.logout(providerId, { signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) });
			} else if (!(await this.removeConfiguredKey(providerId))) {
				return false;
			}
			await this.ensureDefault().catch(() => undefined);
			this.changed();
			return true;
		});
	}

	/** Drop the `apiKey` of a models.json entry when pi resolves the provider's key from it. */
	private async removeConfiguredKey(providerId: string): Promise<boolean> {
		const source = this.runtime.getProviderAuthStatus(providerId).source;
		if (source !== "models_json_key" && source !== "models_json_command") return false;
		const path = this.env.modelsPath;
		let loaded: ReturnType<typeof loadModelsJson>;
		try {
			loaded = loadModelsJson(path);
		} catch (error) {
			throw new PierProtocolError("CONFLICT", errorText(error));
		}
		const previous = loaded.doc.providers[providerId];
		if (!previous || previous.apiKey === undefined) return false;
		const next = { ...previous };
		delete next.apiKey;
		const providers = { ...loaded.doc.providers };
		// An override left with nothing but a display name is invalid for pi: drop it.
		if (Object.keys(next).every((key) => key === "name")) delete providers[providerId];
		else providers[providerId] = next;
		writeModelsJson(path, loaded, { ...loaded.doc, providers });
		await this.runtime.refresh({ allowNetwork: false });
		// pi only reports models_json_* while it loaded the file, so any error now is ours.
		const problem = this.providerProblem(providerId);
		if (!problem) return true;
		restoreModelsJson(path, loaded.raw);
		await this.runtime.refresh({ allowNetwork: false }).catch(() => undefined);
		throw new PierProtocolError("BAD_REQUEST", problem);
	}

	/** Save an API key non-interactively (custom providers ask for exactly one secret). */
	private async storeApiKey(providerId: string, apiKey: string): Promise<void> {
		let answered = false;
		await this.runtime.login(providerId, "api_key", {
			signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS),
			prompt: async (prompt) => {
				if (!answered && (prompt.type === "secret" || prompt.type === "text")) {
					answered = true;
					return apiKey;
				}
				throw new Error(`Unexpected sign-in question: ${prompt.message}`);
			},
			notify: () => {},
		});
	}

	// ---- custom endpoints (models.json) --------------------------------------------------

	saveCustom(
		form: CustomProvider,
		apiKey: string | undefined,
		create: boolean,
	): Promise<{ provider: ProviderInfo; defaultModel?: DefaultModelRef }> {
		return this.serialize(async () => {
			const index = this.capabilityIndex();
			// Capabilities left unset (new or never configured models) come from pi's catalog.
			const input: CustomProvider = { ...form, models: form.models.map((model) => index.fill(model)) };
			const id = input.id;
			if (this.builtinIds.has(id)) {
				throw new PierProtocolError("CONFLICT", `“${id}” 是 pi 内置服务商的 ID，请换一个`);
			}
			const path = this.env.modelsPath;
			let loaded: ReturnType<typeof loadModelsJson>;
			try {
				loaded = loadModelsJson(path);
			} catch (error) {
				throw new PierProtocolError("CONFLICT", errorText(error));
			}
			const previous = loaded.doc.providers[id];
			if (create && (previous || this.runtime.getProvider(id))) {
				throw new PierProtocolError("CONFLICT", `服务商 ID “${id}” 已存在`);
			}
			if (!create && !previous) throw new PierProtocolError("NOT_FOUND", `自定义服务商 ${id} 不存在`);
			if (!apiKey && previous?.apiKey === undefined) {
				const credentials = await this.runtime
					.listCredentials({ signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) })
					.catch(() => []);
				if (!credentials.some((c) => c.providerId === id)) {
					throw new PierProtocolError("BAD_REQUEST", "请填写 API Key");
				}
			}

			const merged = mergeCustomProvider(previous, input);
			// Official thinking levels (and adaptive thinking) of the models come from pi's catalog too.
			const entry = fillModelsJsonProviders(index, { [id]: merged }, new Set())?.providers[id] ?? merged;
			const doc = {
				...loaded.doc,
				providers: { ...loaded.doc.providers, [id]: entry },
			};
			const rollback = async () => {
				restoreModelsJson(path, loaded.raw);
				await this.runtime.refresh({ allowNetwork: false }).catch(() => undefined);
			};
			writeModelsJson(path, loaded, doc);
			await this.runtime.refresh({ allowNetwork: false });
			const problem = this.providerProblem(id);
			if (problem) {
				await rollback();
				throw new PierProtocolError("BAD_REQUEST", problem);
			}
			if (apiKey) {
				try {
					await this.storeApiKey(id, apiKey);
				} catch (error) {
					if (create) await rollback();
					throw new PierProtocolError("INTERNAL", `保存 API Key 失败：${errorText(error)}`);
				}
			}
			const defaultModel = await this.ensureDefault(id).catch(() => undefined);
			this.changed();
			const provider = (await this.list()).providers.find((p) => p.id === id);
			if (!provider) throw new PierProtocolError("INTERNAL", `Provider ${id} did not load`);
			return defaultModel ? { provider, defaultModel } : { provider };
		});
	}

	/** Why pi could not load `providerId` from models.json, if it could not. */
	private providerProblem(providerId: string): string | undefined {
		const errors = this.runtime.getError() ?? "";
		const relevant = errors
			.split("\n\n")
			.filter((e) => e.includes(`"${providerId}"`) || e.includes(`${providerId}:`) || e.includes("models.json"));
		if (relevant.length) return relevant.join("\n");
		if (!this.runtime.getProvider(providerId)) return `服务商 ${providerId} 没有加载成功`;
		return undefined;
	}

	removeCustom(providerId: string): Promise<boolean> {
		return this.serialize(async () => {
			if (this.builtinIds.has(providerId)) {
				throw new PierProtocolError("BAD_REQUEST", "内置服务商不能删除，可以移除它的凭据");
			}
			const path = this.env.modelsPath;
			let loaded: ReturnType<typeof loadModelsJson>;
			try {
				loaded = loadModelsJson(path);
			} catch (error) {
				throw new PierProtocolError("CONFLICT", errorText(error));
			}
			if (!loaded.doc.providers[providerId]) return false;
			try {
				const credentials = await this.runtime.listCredentials({ signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) });
				if (credentials.some((c) => c.providerId === providerId)) {
					await this.runtime.logout(providerId, { signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) });
				}
			} catch (error) {
				this.options.log?.(`Removing the credential of ${providerId} failed: ${errorText(error)}`);
			}
			const providers = { ...loaded.doc.providers };
			delete providers[providerId];
			writeModelsJson(path, loaded, { ...loaded.doc, providers });
			await this.runtime.refresh({ allowNetwork: false });
			await this.ensureDefault().catch(() => undefined);
			this.changed();
			return true;
		});
	}

	/** List the models an endpoint offers, with the capabilities pi's catalog knows for them. */
	async probeModels(params: {
		api: CustomProviderApi;
		baseUrl: string;
		apiKey?: string;
		providerId?: string;
	}): Promise<CustomModel[]> {
		let key = params.apiKey?.trim() || undefined;
		if (!key && params.providerId && this.runtime.getProvider(params.providerId)) {
			key = (await this.runtime.getAuth(params.providerId).catch(() => undefined))?.auth.apiKey;
		}
		const base = params.baseUrl.trim().replace(/\/+$/, "");
		if (!/^https?:\/\//i.test(base))
			throw new PierProtocolError("BAD_REQUEST", "Base URL 必须以 http:// 或 https:// 开头");
		let url: string;
		const headers: Record<string, string> = { accept: "application/json" };
		switch (params.api) {
			case "anthropic-messages":
				url = `${/\/v1$/.test(base) ? base : `${base}/v1`}/models?limit=1000`;
				headers["anthropic-version"] = "2023-06-01";
				if (key) {
					headers["x-api-key"] = key;
					headers.authorization = `Bearer ${key}`;
				}
				break;
			case "google-generative-ai":
				url = `${base}/models?pageSize=1000`;
				if (key) headers["x-goog-api-key"] = key;
				break;
			default:
				url = `${base}/models`;
				if (key) headers.authorization = `Bearer ${key}`;
		}
		const redact = (text: string) => (key ? text.split(key).join("***") : text);
		let response: Response;
		try {
			response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		} catch (error) {
			throw new PierProtocolError("BAD_REQUEST", redact(`无法连接 ${url}：${errorText(error)}`));
		}
		const text = await response.text().catch(() => "");
		if (!response.ok) {
			const snippet = text.replace(/\s+/g, " ").trim().slice(0, 300);
			throw new PierProtocolError(
				"BAD_REQUEST",
				redact(`${url} 返回 HTTP ${response.status}${snippet ? `：${snippet}` : ""}`),
			);
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new PierProtocolError("BAD_REQUEST", `${url} 返回的不是 JSON，请检查 Base URL`);
		}
		const list = Array.isArray(body)
			? body
			: Array.isArray((body as { data?: unknown }).data)
				? (body as { data: unknown[] }).data
				: Array.isArray((body as { models?: unknown }).models)
					? (body as { models: unknown[] }).models
					: undefined;
		if (!list) throw new PierProtocolError("BAD_REQUEST", `${url} 的返回中没有模型列表`);
		const models = new Map<string, CustomModel>();
		const index = this.capabilityIndex();
		for (const item of list) {
			if (typeof item === "string") {
				models.set(item, { id: item });
				continue;
			}
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			const rawId = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
			const id = params.api === "google-generative-ai" ? rawId.replace(/^models\//, "") : rawId;
			if (!id) continue;
			const name =
				typeof record.display_name === "string"
					? record.display_name
					: typeof record.displayName === "string"
						? record.displayName
						: undefined;
			// NewAPI sites list the wire APIs each model supports (e.g. Anthropic Messages for Claude).
			const api = Array.isArray(record.supported_endpoint_types)
				? detectNewApiModelApi(id, record.supported_endpoint_types)
				: undefined;
			models.set(id, {
				id,
				...(name && name !== id ? { name } : {}),
				...(api && api !== params.api ? { api } : {}),
			});
		}
		return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).map((model) => index.fill(model));
	}

	shutdown(): void {
		for (const flow of this.flows.values()) flow.cancel();
		this.flows.clear();
	}
}
