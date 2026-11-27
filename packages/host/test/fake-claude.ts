import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectKey } from "../src/claude/claude-runtime.ts";
import type { ClaudeSdk } from "../src/claude/claude-session.ts";
import { InputQueue } from "../src/runtimes/input-queue.ts";

type Json = Record<string, unknown>;

export interface FakeTurnContext {
	text: string;
	sessionId: string;
	canUseTool: (name: string, input: Json, toolUseID: string) => Promise<{ behavior: string; message?: string }>;
	signal: AbortSignal;
}

/** Scripted reply of the fake Claude Code: yields SDK messages (without `session_id`). */
export type FakeResponder = (ctx: FakeTurnContext) => AsyncIterable<Json>;

interface StoredEntry {
	type: string;
	uuid: string;
	message: unknown;
	parent_tool_use_id: string | null;
}

interface FakeSession {
	id: string;
	cwd: string;
	title?: string;
	entries: StoredEntry[];
	/** Subagent conversations by the `Agent` tool call that started them. */
	agents: Map<string, StoredEntry[]>;
	/** Claude Code agent id (the task id) of each `Agent` tool call. */
	agentIds: Map<string, string>;
	createdAt: number;
	modifiedAt: number;
}

/**
 * In-memory stand-in for the Claude Agent SDK: `query()` answers each streamed user message
 * with the current responder and records the conversation, which `getSessionMessages()` and
 * `listSessions()` read back. Session files are created so the runtime sees them as stored.
 */
export class FakeClaude {
	readonly sessions = new Map<string, FakeSession>();
	readonly options: Json[] = [];
	readonly calls: string[] = [];
	/** Task ids passed to `stopTask`. */
	readonly stoppedTasks: string[] = [];
	/** `modelUsage` of each successful result. */
	modelUsage: Record<string, Json> = {};
	/** How many times the runtime stopped a Claude Code process (`close()`). */
	closes = 0;
	/** Messages of the latest process, pushed outside a turn by `emit`. */
	private live: { id: string; output: InputQueue<Json> } | undefined;
	/**
	 * When set, a closed `query()` ends its messages only once this settles, like the real SDK
	 * whose iteration ends after the Claude Code process exits.
	 */
	closeDelay: Promise<void> | undefined;
	responder: FakeResponder = async function* () {
		yield { type: "assistant", message: { id: "msg_default", content: [{ type: "text", text: "ok" }] } };
	};

	constructor(private readonly configDir: string) {}

	private file(session: Pick<FakeSession, "id" | "cwd">): string {
		const dir = join(this.configDir, "projects", claudeProjectKey(session.cwd));
		mkdirSync(dir, { recursive: true });
		return join(dir, `${session.id}.jsonl`);
	}

	private persist(session: FakeSession): void {
		session.modifiedAt = Date.now();
		writeFileSync(this.file(session), `${session.entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}

	readonly sdk: ClaudeSdk = {
		query: ((params: { prompt: AsyncIterable<Json>; options: Json }) => this.query(params)) as never,
		listSessions: (async (options: { dir?: string }) =>
			[...this.sessions.values()]
				.filter((s) => s.cwd === options.dir && s.entries.length > 0)
				.map((s) => ({
					sessionId: s.id,
					summary: s.title ?? "",
					lastModified: s.modifiedAt,
					...(s.title ? { customTitle: s.title } : {}),
					firstPrompt: String((s.entries[0]?.message as Json | undefined)?.content ?? ""),
					cwd: s.cwd,
					createdAt: s.createdAt,
				}))) as never,
		getSessionMessages: (async (id: string) => this.sessions.get(id)?.entries ?? []) as never,
		listSubagents: (async (id: string) => {
			const session = this.sessions.get(id);
			return [...(session?.agents.keys() ?? [])].map((toolUseId) => session?.agentIds.get(toolUseId) ?? toolUseId);
		}) as never,
		getSubagentMessages: (async (id: string, agentId: string, options?: { limit?: number }) => {
			const session = this.sessions.get(id);
			const toolUseId = [...(session?.agentIds.entries() ?? [])].find(([, a]) => a === agentId)?.[0] ?? agentId;
			const entries = session?.agents.get(toolUseId) ?? [];
			return options?.limit ? entries.slice(0, options.limit) : entries;
		}) as never,
		renameSession: (async (id: string, title: string) => {
			const session = this.sessions.get(id);
			if (session) session.title = title;
		}) as never,
		forkSession: (async (id: string, options: { upToMessageId?: string }) => {
			const source = this.sessions.get(id);
			if (!source) throw new Error("no such session");
			const end = options.upToMessageId ? source.entries.findIndex((e) => e.uuid === options.upToMessageId) : -1;
			const fork: FakeSession = {
				id: crypto.randomUUID(),
				cwd: source.cwd,
				agents: new Map(),
				agentIds: new Map(),
				entries: source.entries.slice(0, end === -1 ? undefined : end + 1),
				createdAt: Date.now(),
				modifiedAt: Date.now(),
			};
			this.sessions.set(fork.id, fork);
			this.persist(fork);
			return { sessionId: fork.id };
		}) as never,
	};

	private query(params: { prompt: AsyncIterable<Json>; options: Json }) {
		const options = params.options;
		this.options.push(options);
		const output = new InputQueue<Json>();
		const cwd = String(options.cwd);
		const id = String(options.resume ?? options.sessionId ?? crypto.randomUUID());
		this.live = { id, output };
		const canUseTool = options.canUseTool as (n: string, i: Json, o: Json) => Promise<{ behavior: string }>;
		let abort = new AbortController();
		// Like Claude Code: a new session cannot take the id of a stored one, and starts empty.
		const fresh = options.resume === undefined;
		const inUse = fresh && existsSync(this.file({ id, cwd }));
		if (fresh && !inUse) this.sessions.delete(id);
		// `resumeSessionAt`: the prompt continues after that entry, the ones after it leave the chain.
		let resumeAt = typeof options.resumeSessionAt === "string" ? options.resumeSessionAt : undefined;
		const run = async () => {
			if (inUse) {
				output.push({
					type: "result",
					subtype: "error_during_execution",
					errors: [`Session ID ${id} is already in use.`],
				});
				output.close();
				return;
			}
			for await (const input of params.prompt) {
				const resumed = this.sessions.get(id);
				if (resumed && resumeAt !== undefined) {
					const end = resumed.entries.findIndex((e) => e.uuid === resumeAt);
					if (end !== -1) resumed.entries = resumed.entries.slice(0, end + 1);
					resumeAt = undefined;
				}
				let session = this.sessions.get(id);
				if (!session) {
					session = {
						id,
						cwd,
						entries: [],
						agents: new Map(),
						agentIds: new Map(),
						createdAt: Date.now(),
						modifiedAt: Date.now(),
					};
					this.sessions.set(id, session);
				}
				const message = input.message as Json;
				session.entries.push({ type: "user", uuid: String(input.uuid), message, parent_tool_use_id: null });
				this.persist(session);
				const text = typeof message.content === "string" ? message.content : "";
				this.calls.push(text);
				output.push({ type: "command_lifecycle", command_uuid: input.uuid, state: "started" });
				abort = new AbortController();
				let interrupted = false;
				try {
					for await (const reply of this.responder({
						text,
						sessionId: id,
						signal: abort.signal,
						canUseTool: (name, toolInput, toolUseID) =>
							canUseTool(name, toolInput, { signal: abort.signal, toolUseID, suggestions: [] }),
					})) {
						if (abort.signal.aborted) {
							interrupted = true;
							break;
						}
						const parent = typeof reply.parent_tool_use_id === "string" ? reply.parent_tool_use_id : null;
						if (reply.subtype === "task_started") {
							session.agentIds.set(String(reply.tool_use_id), String(reply.task_id));
						}
						output.push({ ...reply, parent_tool_use_id: parent, session_id: id, uuid: crypto.randomUUID() });
						if (reply.type === "assistant" || reply.type === "user") {
							const entry = {
								type: String(reply.type),
								uuid: crypto.randomUUID(),
								message: reply.message,
								parent_tool_use_id: parent,
							};
							if (parent) {
								const agent = session.agents.get(parent) ?? [];
								agent.push(entry);
								session.agents.set(parent, agent);
							} else session.entries.push(entry);
						}
					}
				} catch {
					interrupted = true;
				}
				this.persist(session);
				output.push(
					interrupted
						? { type: "result", subtype: "error_during_execution", errors: ["interrupted"], is_error: true }
						: { type: "result", subtype: "success", is_error: false, result: "", modelUsage: this.modelUsage },
				);
			}
			// The input closed (the runtime stops the process): its messages end once it exits.
			if (this.closeDelay) await this.closeDelay;
			output.close();
		};
		void run();
		const iterator = output[Symbol.asyncIterator]();
		return {
			next: () => iterator.next(),
			return: () => {
				output.close();
				return Promise.resolve({ value: undefined, done: true });
			},
			[Symbol.asyncIterator]() {
				return this;
			},
			interrupt: async () => {
				abort.abort();
			},
			stopTask: async (taskId: string) => {
				this.stoppedTasks.push(taskId);
			},
			setModel: async (model?: string) => {
				this.calls.push(`setModel:${model ?? "default"}`);
			},
			setMaxThinkingTokens: async (tokens: number | null) => {
				this.calls.push(`thinkingTokens:${tokens}`);
			},
			applyFlagSettings: async (settings: Json) => {
				this.calls.push(`flags:${JSON.stringify(settings)}`);
			},
			supportedCommands: async () => [{ name: "review", description: "Review code", argumentHint: "" }],
			initializationResult: async () => ({ commands: [], models: [], agents: [] }),
			close: () => {
				this.closes++;
				if (this.closeDelay) void this.closeDelay.then(() => output.close());
				else output.close();
			},
		};
	}
	/**
	 * Send messages from the running process between turns, as Claude Code does when a background
	 * task changes or reports back in a turn of its own.
	 */
	emit(...messages: Json[]): void {
		const live = this.live;
		if (!live) throw new Error("Claude Code is not running");
		for (const message of messages) {
			live.output.push({ parent_tool_use_id: null, ...message, session_id: live.id, uuid: crypto.randomUUID() });
		}
	}
}

/** Stream events of one assistant text reply. */
export function* streamText(id: string, text: string): Generator<Json> {
	yield { type: "stream_event", event: { type: "message_start", message: { id, model: "claude-test", usage: {} } } };
	yield {
		type: "stream_event",
		event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	};
	for (const chunk of text.match(/.{1,4}/gs) ?? []) {
		yield {
			type: "stream_event",
			event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } },
		};
	}
	yield { type: "assistant", message: { id, model: "claude-test", content: [{ type: "text", text }] } };
	yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
	yield {
		type: "stream_event",
		event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5, input_tokens: 10 } },
	};
	yield { type: "stream_event", event: { type: "message_stop" } };
}
