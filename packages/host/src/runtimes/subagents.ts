import { PierProtocolError, type SubagentInfo, type SubagentStatus, type WireEvent } from "@pier/protocol";
import { LiveTranscript, publicMessage, type TranscriptMessage } from "./live-transcript.ts";

/** Longest task, result and error text kept in a {@link SubagentInfo}. */
export const SUBAGENT_TEXT_LIMIT = 4000;
const ACTIVITY_LIMIT = 200;
/** Progress updates of one subagent are sent at most this often (status changes go out at once). */
const UPDATE_INTERVAL_MS = 250;

/** Fields a runtime reports about a subagent; omitted fields keep their value. */
export type SubagentPatch = Partial<Omit<SubagentInfo, "id" | "revision">>;

export interface SubagentTranscript {
	subagent: SubagentInfo;
	messages: unknown[];
	from: number;
	total: number;
	streamingMessage?: unknown;
}

/** What a runtime does for the subagents of its sessions. */
export interface SubagentRuntimeHooks {
	/** The conversation of a subagent that was not recorded live (for example in a stored session). */
	load?(subagent: SubagentInfo): Promise<TranscriptMessage[] | undefined>;
	/** Ask a running subagent to stop. */
	stop?(subagent: SubagentInfo): Promise<void>;
}

interface Entry {
	info: SubagentInfo;
	/** Conversation recorded while the subagent runs. */
	live?: LiveTranscript;
	/** Tool calls the live conversation started (runtimes may report more steps). */
	toolCalls: number;
	/** Conversation loaded on demand, until the subagent changes again. */
	loaded?: { revision: number; messages: TranscriptMessage[] };
	timer?: ReturnType<typeof setTimeout>;
}

export function clip(text: string | undefined, limit = SUBAGENT_TEXT_LIMIT): string | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function oneLine(text: string, limit = ACTIVITY_LIMIT): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

/** One line describing a tool call, e.g. `bash: ls -la`. */
export function toolActivity(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const detail =
		str(a.command) ??
		str(a.path) ??
		str(a.file_path) ??
		str(a.pattern) ??
		str(a.query) ??
		str(a.url) ??
		str(a.description) ??
		Object.values(a).find((v): v is string => typeof v === "string" && v.length > 0);
	return oneLine(detail ? `${name}: ${detail}` : name);
}

function lastText(message: unknown): string | undefined {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i] as { type?: string; text?: string };
		if (part?.type === "text" && part.text?.trim()) return part.text;
	}
	return undefined;
}

/**
 * The subagents of one session: their state (sent to clients as `subagent.update` events and in
 * snapshots) and, for runtimes that report it, their conversation as pi-shaped messages.
 */
export class SubagentTracker {
	private readonly entries = new Map<string, Entry>();
	private disposed = false;
	/** Provider stamped on the assistant messages of live conversations (the runtime's). */
	provider = "subagent";

	constructor(
		private readonly emit: (event: WireEvent) => void,
		private readonly hooks: () => SubagentRuntimeHooks,
	) {}

	get size(): number {
		return this.entries.size;
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	get(id: string): SubagentInfo | undefined {
		return this.entries.get(id)?.info;
	}

	list(): SubagentInfo[] {
		return [...this.entries.values()].map((e) => ({ ...e.info }));
	}

	running(): SubagentInfo[] {
		return [...this.entries.values()].filter((e) => e.info.status === "running").map((e) => e.info);
	}

	/** Subagents started by a tool call of the parent transcript. */
	forToolCall(toolCallId: string): SubagentInfo[] {
		return [...this.entries.values()].filter((e) => e.info.toolCallId === toolCallId).map((e) => e.info);
	}

	/** Create a subagent or change some of its fields; sends `subagent.update`. */
	update(id: string, patch: SubagentPatch, options: { immediate?: boolean; changed?: boolean } = {}): SubagentInfo {
		let entry = this.entries.get(id);
		const created = !entry;
		if (!entry) {
			entry = {
				toolCalls: 0,
				info: {
					id,
					name: patch.name ?? "Subagent",
					status: "running",
					steps: 0,
					stoppable: false,
					transcript: false,
					revision: 0,
				},
			};
			this.entries.set(id, entry);
		}
		const info = entry.info;
		const statusChanged = patch.status !== undefined && patch.status !== info.status;
		for (const [key, value] of Object.entries(patch) as Array<[keyof SubagentPatch, unknown]>) {
			if (value === undefined) continue;
			(info as unknown as Record<string, unknown>)[key] = value;
		}
		if (statusChanged && info.status !== "running") info.endedAt ??= Date.now();
		if (statusChanged && info.status === "running") delete info.endedAt;
		if (options.changed) info.revision++;
		this.schedule(entry, created || statusChanged || options.immediate === true);
		return info;
	}

	/** Mark a subagent finished, closing tool calls of its conversation that never ended. */
	finish(id: string, status: Exclude<SubagentStatus, "running">, patch: SubagentPatch = {}): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		if (entry.info.status === "running" && entry.live) {
			entry.live.endRun(status === "failed" ? (patch.error ?? "The subagent failed.") : undefined);
		}
		this.update(id, { ...patch, status }, { changed: true });
	}

	/**
	 * The live conversation of a subagent, recorded with the same calls runtimes use for their
	 * own transcript. Its events update the subagent's steps, activity and revision. `seed` is the
	 * conversation so far, for a subagent first seen in a stored session.
	 */
	conversation(id: string, seed?: TranscriptMessage[]): LiveTranscript {
		if (!this.entries.has(id)) this.update(id, {});
		const entry = this.entries.get(id) as Entry;
		if (!entry.live) {
			entry.live = new LiveTranscript(
				(event) => this.onConversationEvent(id, event),
				() => ({ provider: this.provider, ...(entry.info.model ? { model: entry.info.model } : {}) }),
			);
			const messages = seed ?? entry.loaded?.messages;
			if (messages) entry.live.load(messages);
			if (!entry.info.transcript) {
				entry.info.transcript = true;
				this.schedule(entry, false);
			}
		}
		return entry.live;
	}

	private onConversationEvent(id: string, event: WireEvent): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		const patch: SubagentPatch = {};
		if (event.type === "tool_execution_start") {
			entry.toolCalls++;
			patch.steps = Math.max(entry.info.steps, entry.toolCalls);
			patch.activity = toolActivity(String(event.toolName ?? ""), event.args);
		} else if (event.type === "message_end") {
			const message = event.message as { role?: string } | undefined;
			const text = message?.role === "assistant" ? lastText(message) : undefined;
			if (text) patch.activity = oneLine(text);
		} else if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
			return;
		}
		this.update(id, patch, { changed: true });
	}

	/** Replace every subagent (after loading a stored session); sends no events. */
	load(subagents: SubagentInfo[]): void {
		this.clearTimers();
		this.entries.clear();
		for (const info of subagents) this.entries.set(info.id, { info: { ...info }, toolCalls: 0 });
	}

	/** Forget every subagent (the runtime replaced the session); sends no events. */
	reset(): void {
		this.load([]);
	}

	async transcript(id: string, from = 0): Promise<SubagentTranscript> {
		const entry = this.entries.get(id);
		if (!entry) throw new PierProtocolError("NOT_FOUND", `No subagent ${id} in this session`);
		if (!entry.info.transcript) {
			throw new PierProtocolError("UNSUPPORTED", "This subagent's conversation is not available");
		}
		let messages: TranscriptMessage[];
		let streaming: unknown;
		if (entry.live) {
			messages = entry.live.messages;
			streaming = entry.live.streaming;
		} else if (entry.loaded && entry.loaded.revision === entry.info.revision) {
			messages = entry.loaded.messages;
		} else {
			const loaded = (await this.hooks().load?.(entry.info)) ?? [];
			entry.loaded = { revision: entry.info.revision, messages: loaded };
			messages = loaded;
		}
		const total = messages.length;
		return {
			subagent: { ...entry.info },
			messages: from > total ? [] : messages.slice(from).map(publicMessage),
			from,
			total,
			...(streaming ? { streamingMessage: structuredClone(streaming) } : {}),
		};
	}

	/** Stop one running subagent, or all of them. Returns how many were asked to stop. */
	async stop(id?: string): Promise<number> {
		const stop = this.hooks().stop;
		const targets = id === undefined ? this.running().filter((s) => s.stoppable) : [this.get(id)];
		let stopped = 0;
		for (const target of targets) {
			if (!target) throw new PierProtocolError("NOT_FOUND", `No subagent ${id} in this session`);
			if (target.status !== "running") continue;
			if (!target.stoppable || !stop) throw new PierProtocolError("UNSUPPORTED", "This subagent cannot be stopped");
			await stop(target);
			stopped++;
		}
		return stopped;
	}

	private schedule(entry: Entry, immediate: boolean): void {
		if (this.disposed) return;
		if (immediate) {
			this.flush(entry);
			return;
		}
		if (entry.timer) return;
		entry.timer = setTimeout(() => this.flush(entry), UPDATE_INTERVAL_MS);
		entry.timer.unref?.();
	}

	private flush(entry: Entry): void {
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = undefined;
		if (this.disposed || this.entries.get(entry.info.id) !== entry) return;
		this.emit({ type: "subagent.update", subagent: { ...entry.info } });
	}

	private clearTimers(): void {
		for (const entry of this.entries.values()) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimers();
	}
}
