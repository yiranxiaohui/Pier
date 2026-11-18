import type {
	Event,
	OpencodeClient,
	PermissionRequest,
	PermissionRuleset,
	Session,
	SessionMessagesResponse2,
} from "@opencode-ai/sdk/v2/client";
import {
	type AgentRuntimeCapabilities,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type QueueState,
	type StreamingBehavior,
	type ThinkingLevel,
} from "@pier/protocol";
import { errorMessage, ManagedSession, type ManagedSessionOptions, type SessionContent } from "../managed-session.ts";
import { firstPromptOf, LiveTranscript } from "../runtimes/live-transcript.ts";
import type { OpenCodeRuntime } from "./opencode-runtime.ts";
import { errorText, OpenCodeTranscript } from "./transcript.ts";

export const OPENCODE_CAPABILITIES: AgentRuntimeCapabilities = {
	steer: false,
	followUp: false,
	compact: false,
	fork: false,
	rename: true,
	setModel: true,
	thinking: false,
	reload: false,
	images: true,
	piExtensions: false,
};
const strict = { throwOnError: true } as const;
const nativeAllowed = ["read", "grep", "glob", "list", "todowrite", "question"];

/** Narrow native allows in their original order. Later exceptions, including denies, still win. */
function turnPermissions(rules: PermissionRuleset): PermissionRuleset {
	return rules.flatMap((rule) => {
		if (rule.action !== "allow" || nativeAllowed.includes(rule.permission)) return [rule];
		const ask = { ...rule, action: "ask" as const };
		return rule.permission === "*" ? [ask, ...nativeAllowed.map((permission) => ({ ...rule, permission }))] : [ask];
	});
}

export class OpenCodeSession extends ManagedSession {
	readonly runtimeId = "opencode";
	readonly capabilities = OPENCODE_CAPABILITIES;
	readonly sessionFile = undefined;
	readonly id: string;
	private model?: ModelInfo;
	private readonly transcript = new LiveTranscript(
		(event) => this.emit(event),
		() => ({ provider: this.model?.provider ?? "opencode", model: this.model?.id }),
	);
	private turn?: AbortController;
	private done?: Promise<void>;

	constructor(
		options: ManagedSessionOptions,
		private readonly runtime: OpenCodeRuntime,
		private readonly native: Session,
		history: SessionMessagesResponse2,
	) {
		super(options);
		this.id = native.id;
		const lastUser = history.findLast((m) => m.info.role === "user")?.info;
		const selected = lastUser?.role === "user" ? lastUser.model : undefined;
		const id = selected?.modelID ?? native.model?.id;
		const provider = selected?.providerID ?? native.model?.providerID;
		if (id && provider) this.model = { id, provider, name: id, reasoning: false, input: ["text"] };
		new OpenCodeTranscript(this.transcript).history(history);
		this.acquireLock(`opencode-session:${this.id}`);
	}

	private get params() {
		return { directory: this.workspacePath, sessionID: this.id };
	}

	protected describe() {
		return {
			name: this.native.title,
			cwd: this.workspacePath,
			createdAt: new Date(this.native.time.created).toISOString(),
			messageCount: this.transcript.messages.filter((m) => m.role !== "toolResult").length,
			firstMessage: firstPromptOf(this.transcript.messages),
		};
	}

	protected content(): SessionContent {
		const t = this.transcript;
		return {
			messages: t.publicMessages(),
			...(t.streaming ? { streamingMessage: structuredClone(t.streaming) } : {}),
			pendingToolCalls: t.pendingToolCalls,
			thinkingLevel: "off",
			...(this.model ? { model: this.model } : {}),
			...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
		};
	}

	async prompt(text: string, images?: ImageInput[], _behavior?: StreamingBehavior): Promise<void> {
		if (this.turn) throw new PierProtocolError("CONFLICT", "OpenCode is busy");
		const turn = new AbortController();
		this.turn = turn;
		this.setRunState("streaming");
		this.transcript.startRun();
		this.transcript.addUser(images?.length ? [{ type: "text", text }, ...images] : text);
		this.done = this.run(text, images ?? [], turn)
			.catch((error) => {
				if (!turn.signal.aborted) this.transcript.endRun(errorMessage(error));
			})
			.finally(() => {
				turn.abort();
				this.bridge.cancelAll();
				this.transcript.endRun();
				this.turn = undefined;
				this.lastActivity = Date.now();
				this.setRunState("idle");
			});
	}

	private async run(text: string, images: ImageInput[], turn: AbortController): Promise<void> {
		const client = await this.runtime.server.client();
		const { directory } = this.params;
		const options = { ...strict, signal: turn.signal };
		const subscription = new AbortController();
		const { stream } = await client.event.subscribe(
			{ directory },
			{ ...options, signal: AbortSignal.any([turn.signal, subscription.signal]), sseMaxRetryAttempts: 1 },
		);
		let submitted = false;
		let restore: PermissionRuleset | undefined;
		try {
			// OpenCode sends server.connected when this workspace's subscription is ready.
			const first = await stream.next();
			if (first.done) throw new Error("OpenCode event stream unavailable");
			const { data: session } = await client.session.get(this.params, options);
			let agent = session.agent;
			if (this.options.workspace().policy !== "auto") {
				const [{ data: agents }, { data: config }] = await Promise.all([
					client.app.agents({ directory }, options),
					client.config.get({ directory }, options),
				]);
				const selected = agents.find((a) => a.name === (agent ?? config.default_agent ?? "build"));
				if (!selected) throw new Error("OpenCode default agent is unavailable");
				agent = selected.name;
				const rules = turnPermissions([...selected.permission, ...(session.permission ?? [])]);
				await client.session.update({ ...this.params, permission: rules }, strict);
				restore = session.permission ?? [];
			}
			turn.signal.throwIfAborted();
			const parts = [
				{ type: "text" as const, text },
				...images.map((im) => ({
					type: "file" as const,
					mime: im.mimeType,
					url: `data:${im.mimeType};base64,${im.data}`,
				})),
			];
			await client.session.promptAsync(
				{
					...this.params,
					parts,
					agent,
					...(this.model ? { model: { providerID: this.model.provider, modelID: this.model.id } } : {}),
				},
				strict,
			);
			submitted = true;
			turn.signal.throwIfAborted();
			const reducer = new OpenCodeTranscript(this.transcript);
			const children = new Set<string>();
			for await (const event of stream) {
				if (
					event.type === "session.created" &&
					event.properties.info.parentID &&
					(event.properties.info.parentID === this.id || children.has(event.properties.info.parentID))
				) {
					children.add(event.properties.info.id);
				}
				if (
					event.type === "session.updated" &&
					event.properties.info.id === this.id &&
					event.properties.info.title !== this.native.title
				) {
					this.native.title = event.properties.info.title;
					this.emit({ type: "session_info_changed", name: this.native.title });
				}
				const owner =
					event.type === "message.updated"
						? event.properties.info.sessionID
						: event.type === "message.part.updated"
							? event.properties.part.sessionID
							: "sessionID" in event.properties
								? event.properties.sessionID
								: undefined;
				if (typeof owner !== "string" || (owner !== this.id && !children.has(owner))) continue;
				if (event.type === "permission.asked")
					await this.permission(
						client,
						event.properties,
						turn.signal,
						reducer.toolInput(event.properties.tool?.callID),
					);
				if (event.type === "question.asked") await this.question(client, event, turn.signal);
				if (owner !== this.id) continue;
				if (event.type === "session.error") throw new Error(errorText(event.properties.error) ?? "OpenCode stopped");
				if (
					event.type === "session.idle" ||
					(event.type === "session.status" && event.properties.status.type === "idle")
				) {
					submitted = false;
					return;
				}
				reducer.event(event);
			}
			if (!turn.signal.aborted) throw new Error("OpenCode event stream disconnected");
		} finally {
			subscription.abort();
			if (submitted)
				await client.session.abort(this.params, { ...strict, signal: AbortSignal.timeout(5000) }).catch(() => {});
			if (restore)
				await client.session.update(
					{ ...this.params, permission: restore },
					{ ...strict, signal: AbortSignal.timeout(5000) },
				);
			await stream.return();
		}
	}

	private async permission(
		client: OpencodeClient,
		request: PermissionRequest,
		signal: AbortSignal,
		toolInput?: Record<string, unknown>,
	) {
		const input = {
			...request.metadata,
			...toolInput,
			patterns: request.patterns,
			...(request.permission === "edit" && request.patterns.length === 1 ? { path: request.patterns[0] } : {}),
		};
		// Patterns can omit shell redirects or cover multiple paths. Only classify a complete operation.
		const toolName =
			(request.permission === "bash" && typeof (toolInput?.command ?? request.metadata.command) !== "string") ||
			(request.permission === "edit" && request.patterns.length !== 1) ||
			nativeAllowed.includes(request.permission)
				? `opencode.${request.permission}`
				: request.permission;
		const decision = await this.approveToolCall(
			{
				toolName,
				toolCallId: request.tool?.callID ?? request.id,
				input,
				runtimeAsked: { reason: `OpenCode: ${request.patterns.join(", ")}` },
			},
			signal,
		);
		signal.throwIfAborted();
		await client.permission.reply(
			{ directory: this.workspacePath, requestID: request.id, reply: decision.allowed ? "once" : "reject" },
			{ ...strict, signal },
		);
	}

	private async question(
		client: OpencodeClient,
		event: Extract<Event, { type: "question.asked" }>,
		signal: AbortSignal,
	) {
		const { id: requestID, questions } = event.properties;
		const params = { directory: this.workspacePath, requestID };
		const answers: string[][] = [];
		for (const q of questions) {
			const labels = q.options.map((o) => o.label);
			const response = await this.bridge.request(
				labels.length && !q.multiple && q.custom === false
					? { kind: "select", title: q.header, message: q.question, options: labels }
					: { kind: "input", title: q.header, message: [q.question, ...labels].join("\n") },
				{ signal },
			);
			signal.throwIfAborted();
			if (!response?.value || response.cancelled) {
				await client.question.reject(params, { ...strict, signal });
				return;
			}
			answers.push(
				q.multiple
					? response.value
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean)
					: [response.value],
			);
		}
		await client.question.reply({ ...params, answers }, { ...strict, signal });
	}

	async abort(): Promise<void> {
		this.turn?.abort();
		this.bridge.cancelAll();
		await this.done;
	}
	protected disposeRuntime() {
		return this.abort();
	}
	queue(): QueueState {
		return { steering: [], followUp: [] };
	}
	async steer(): Promise<never> {
		throw this.unsupported("steering");
	}
	async followUp(): Promise<never> {
		throw this.unsupported("follow-up queues");
	}
	async rename(name: string) {
		const client = await this.runtime.server.client();
		await client.session.update({ ...this.params, title: name }, strict);
		this.native.title = name;
		this.emit({ type: "session_info_changed", name });
		return this.summary();
	}
	async setModel(provider: string, id: string): Promise<ModelInfo> {
		const model = (await this.runtime.listModels(this.workspacePath)).find(
			(m) => m.provider === provider && m.id === id,
		);
		if (!model) throw new PierProtocolError("NOT_FOUND", `Unknown OpenCode model ${provider}/${id}`);
		this.model = model;
		this.emit({ type: "session.model", model, thinkingLevel: "off" });
		return model;
	}
	setThinking(level: ThinkingLevel) {
		if (level !== "off") throw this.unsupported("thinking levels");
		return level;
	}
}
