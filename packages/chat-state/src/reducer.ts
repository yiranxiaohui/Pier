import type {
	AgentRuntimeCapabilities,
	EventFrame,
	ModelInfo,
	QueueState,
	SessionContextInfo,
	SessionRunState,
	SessionSnapshot,
	SessionSummary,
	SubagentInfo,
	UiRequest,
} from "@pier/protocol";
import type { AnyMessage, AssistantMessage, ThinkingPart, ToolCallPart } from "./messages.ts";

export type ToolExecutionStatus = "running" | "done" | "error";

/** Live execution state of a tool call, from `tool_execution_*` events. */
export interface ToolExecution {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	status: ToolExecutionStatus;
	/** Latest streamed partial result (e.g. bash output so far). */
	partialResult?: unknown;
	result?: unknown;
}

export type NoticeLevel = "info" | "warning" | "error";

export type NoticeKind = "notify" | "extension" | "compaction";

export interface Notice {
	id: number;
	level: NoticeLevel;
	kind: NoticeKind;
	message: string;
	/** Extension path for `extension` notices. */
	source?: string;
	at: number;
}

export interface ChatState {
	sessionId: string;
	session?: SessionSummary;
	/** Whether a snapshot has been applied (the transcript is meaningful). */
	loaded: boolean;
	seq: number;
	epoch?: string;
	/** Finalized transcript messages. */
	messages: AnyMessage[];
	/** Assistant message currently being streamed. */
	streaming?: AssistantMessage;
	tools: Record<string, ToolExecution>;
	runState: SessionRunState;
	pendingUi: UiRequest[];
	queue: QueueState;
	model?: ModelInfo;
	contextInfo?: SessionContextInfo;
	thinkingLevel: string;
	fastMode?: boolean;
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement?: string }>;
	title?: string;
	/** Error of the most recent failed run, cleared when the next run starts. */
	errorMessage?: string;
	/** Text an extension asked to place in the editor; `nonce` changes on every request. */
	editorText?: { text: string; nonce: number };
	retry?: { attempt: number; maxAttempts: number; errorMessage: string };
	compacting?: { reason: string };
	notices: Notice[];
	closed?: "idle" | "closed" | "deleted" | "host_shutdown";
	/**
	 * The transcript changed in a way the event stream does not describe (for example
	 * after compaction). The client should fetch a fresh `session.snapshot` and apply it.
	 */
	needsResync: boolean;
	nextNoticeId: number;
	/** What the session's agent runtime supports; absent until a snapshot from a 1.22 host (pi: all). */
	capabilities?: AgentRuntimeCapabilities;
	/** Subagents the session's agent started, by id (1.54; empty for older hosts). */
	subagents: Record<string, SubagentInfo>;
}

const MAX_NOTICES = 50;

export function initialChatState(sessionId: string, session?: SessionSummary): ChatState {
	return {
		sessionId,
		...(session ? { session } : {}),
		loaded: false,
		seq: 0,
		messages: [],
		tools: {},
		runState: session?.state ?? "inactive",
		pendingUi: [],
		queue: { steering: [], followUp: [] },
		thinkingLevel: "off",
		statuses: {},
		widgets: {},
		notices: [],
		needsResync: false,
		nextNoticeId: 1,
		subagents: {},
	};
}

/** Replace the state with a snapshot (keeps client-local notices). */
export function applySnapshot(state: ChatState, snapshot: SessionSnapshot): ChatState {
	// A snapshot that leaves out the transcript prefix the client said it has (1.27).
	const from = snapshot.messagesFrom ?? 0;
	if (from > state.messages.length) return { ...state, needsResync: true };
	const messages = [...state.messages.slice(0, from), ...(snapshot.messages as AnyMessage[])];
	const tools: Record<string, ToolExecution> = {};
	const streaming = snapshot.streamingMessage as AssistantMessage | undefined;
	const calls = new Map<string, ToolCallPart>();
	for (const message of [...messages, ...(streaming ? [streaming] : [])]) {
		if (message.role !== "assistant") continue;
		for (const part of (message as AssistantMessage).content ?? []) {
			if (part?.type === "toolCall") calls.set(part.id, part);
		}
	}
	for (const id of snapshot.pendingToolCalls) {
		const call = calls.get(id);
		tools[id] = { toolCallId: id, toolName: call?.name ?? "", args: call?.arguments, status: "running" };
	}
	const next: ChatState = {
		sessionId: snapshot.session.id,
		session: snapshot.session,
		loaded: true,
		seq: snapshot.seq,
		epoch: snapshot.epoch,
		messages,
		tools,
		runState: snapshot.session.state,
		pendingUi: [...snapshot.pendingUi],
		queue: snapshot.queue,
		thinkingLevel: snapshot.thinkingLevel,
		statuses: { ...snapshot.statuses },
		widgets: { ...snapshot.widgets },
		notices: state.notices,
		needsResync: false,
		nextNoticeId: state.nextNoticeId,
		subagents: Object.fromEntries((snapshot.subagents ?? []).map((s) => [s.id, s])),
	};
	if (streaming && streaming.role === "assistant") next.streaming = cloneAssistant(streaming);
	if (snapshot.model) next.model = snapshot.model;
	if (snapshot.contextInfo) next.contextInfo = snapshot.contextInfo;
	if (snapshot.title) next.title = snapshot.title;
	if (snapshot.errorMessage) next.errorMessage = snapshot.errorMessage;
	if (snapshot.capabilities) next.capabilities = snapshot.capabilities;
	if (snapshot.fastMode !== undefined) next.fastMode = snapshot.fastMode;
	return next;
}

function cloneAssistant(message: AssistantMessage): AssistantMessage {
	return { ...message, content: (message.content ?? []).map((part) => ({ ...part })) };
}

function addNotice(
	state: ChatState,
	level: NoticeLevel,
	kind: NoticeKind,
	message: string,
	source?: string,
): ChatState {
	const notice: Notice = {
		id: state.nextNoticeId,
		level,
		kind,
		message,
		...(source ? { source } : {}),
		at: Date.now(),
	};
	return {
		...state,
		notices: [...state.notices, notice].slice(-MAX_NOTICES),
		nextNoticeId: state.nextNoticeId + 1,
	};
}

export function dismissNotice(state: ChatState, id: number): ChatState {
	return { ...state, notices: state.notices.filter((n) => n.id !== id) };
}

interface AssistantEvent {
	type: string;
	contentIndex?: number;
	delta?: string;
	content?: string;
	id?: string;
	toolName?: string;
	toolCall?: ToolCallPart;
	message?: AssistantMessage;
	error?: AssistantMessage;
}

function applyAssistantEvent(draft: AssistantMessage | undefined, event: AssistantEvent): AssistantMessage {
	const message: AssistantMessage = draft
		? { ...draft, content: [...draft.content] }
		: { role: "assistant", content: [], timestamp: Date.now() };
	const index = event.contentIndex ?? -1;
	const at = index >= 0 ? message.content[index] : undefined;
	const set = (part: AssistantMessage["content"][number]) => {
		while (message.content.length < index) message.content.push({ type: "text", text: "" });
		message.content[index] = part;
	};
	switch (event.type) {
		case "text_start":
			set({ type: "text", text: "", completed: false });
			break;
		case "text_delta":
			set({ type: "text", text: (at?.type === "text" ? at.text : "") + (event.delta ?? ""), completed: false });
			break;
		case "text_end":
			set({ type: "text", text: event.content ?? (at?.type === "text" ? at.text : ""), completed: true });
			break;
		case "thinking_start":
			set({ type: "thinking", thinking: "", completed: false });
			break;
		case "thinking_delta":
			set({
				...(at?.type === "thinking" ? at : {}),
				type: "thinking",
				thinking: (at?.type === "thinking" ? at.thinking : "") + (event.delta ?? ""),
				completed: false,
			} as ThinkingPart);
			break;
		case "thinking_end":
			set({
				...(at?.type === "thinking" ? at : {}),
				type: "thinking",
				thinking: event.content ?? (at?.type === "thinking" ? at.thinking : ""),
				completed: true,
			} as ThinkingPart);
			break;
		case "toolcall_start":
			set({ type: "toolCall", id: event.id ?? "", name: event.toolName ?? "", arguments: {}, partialJson: "" });
			break;
		case "toolcall_delta": {
			const call: ToolCallPart =
				at?.type === "toolCall" ? at : { type: "toolCall", id: "", name: "", arguments: {}, partialJson: "" };
			const partialJson = (call.partialJson ?? "") + (event.delta ?? "");
			set({ ...call, partialJson, arguments: parsePartialJson(partialJson) ?? call.arguments });
			break;
		}
		case "toolcall_end":
			if (event.toolCall) set({ ...event.toolCall });
			break;
		case "done":
			if (event.message) return cloneAssistant(event.message);
			break;
		case "error":
			if (event.error) return cloneAssistant(event.error);
			break;
	}
	return message;
}

/**
 * Best-effort parse of a JSON object that is still being streamed, so tool-call
 * arguments (e.g. the file being written) can be previewed while they are generated.
 */
export function parsePartialJson(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const value = JSON.parse(trimmed);
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		// Close open strings, arrays and objects.
	}
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (const char of trimmed) {
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") stack.push("}");
		else if (char === "[") stack.push("]");
		else if (char === "}" || char === "]") stack.pop();
	}
	let open = trimmed;
	if (inString) open += escaped ? '\\"' : '"';
	const closers = stack.reverse().join("");
	const base = open.replace(/[,:]\s*$/, "");
	// Second attempt drops a dangling object key (`{"a":` or `{"a"`).
	const attempts = [base, base.replace(/[{,]\s*"(?:[^"\\]|\\.)*"$/, (m) => (m.startsWith("{") ? "{" : ""))];
	for (const candidate of attempts) {
		try {
			const value = JSON.parse(candidate + closers);
			if (value && typeof value === "object" && !Array.isArray(value)) return value;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/** Apply one event frame for this session. Returns the same object when nothing changed. */
export function reduceChat(state: ChatState, frame: EventFrame): ChatState {
	const event = frame.event;
	if (event.type === "session.snapshot") return applySnapshot(state, event.snapshot as SessionSnapshot);
	if (frame.sessionId !== undefined && frame.sessionId !== state.sessionId) return state;
	if (frame.seq !== undefined) {
		if (state.loaded && frame.seq <= state.seq) return state;
		state = { ...state, seq: frame.seq };
	}

	switch (event.type) {
		case "agent_start": {
			const { errorMessage: _e, retry: _r, ...rest } = state;
			return rest;
		}
		case "message_start": {
			const message = event.message as AnyMessage | undefined;
			if (message?.role === "assistant") return { ...state, streaming: cloneAssistant(message as AssistantMessage) };
			return state;
		}
		case "message_update":
			return {
				...state,
				streaming: applyAssistantEvent(state.streaming, event.assistantMessageEvent as AssistantEvent),
			};
		case "message_end": {
			const message = event.message as AnyMessage | undefined;
			if (!message) return state;
			if (message.role === "assistant") {
				const { streaming: _s, ...rest } = state;
				const assistant = message as AssistantMessage;
				const next: ChatState = { ...rest, messages: [...state.messages, message] };
				if (assistant.stopReason === "error" && assistant.errorMessage) next.errorMessage = assistant.errorMessage;
				return next;
			}
			return { ...state, messages: [...state.messages, message] };
		}
		case "tool_execution_start": {
			const id = String(event.toolCallId);
			return {
				...state,
				tools: {
					...state.tools,
					[id]: { toolCallId: id, toolName: String(event.toolName ?? ""), args: event.args, status: "running" },
				},
			};
		}
		case "tool_execution_update": {
			const id = String(event.toolCallId);
			const previous = state.tools[id];
			return {
				...state,
				tools: {
					...state.tools,
					[id]: {
						toolCallId: id,
						toolName: String(event.toolName ?? previous?.toolName ?? ""),
						args: event.args ?? previous?.args,
						status: "running",
						partialResult: event.partialResult,
					},
				},
			};
		}
		case "tool_execution_end": {
			const id = String(event.toolCallId);
			const previous = state.tools[id];
			return {
				...state,
				tools: {
					...state.tools,
					[id]: {
						toolCallId: id,
						toolName: String(event.toolName ?? previous?.toolName ?? ""),
						args: previous?.args,
						status: event.isError ? "error" : "done",
						result: event.result,
					},
				},
			};
		}
		case "queue_update":
			return {
				...state,
				queue: {
					steering: [...((event.steering as string[] | undefined) ?? [])],
					followUp: [...((event.followUp as string[] | undefined) ?? [])],
				},
			};
		case "session.status":
			return { ...state, runState: event.state as SessionRunState };
		case "compaction_start":
			return { ...state, compacting: { reason: String(event.reason ?? "manual") } };
		case "compaction_end": {
			const { compacting: _c, ...rest } = state;
			let next: ChatState = { ...rest, needsResync: rest.needsResync || !event.aborted };
			if (event.errorMessage) next = addNotice(next, "error", "compaction", String(event.errorMessage));
			return next;
		}
		case "auto_retry_start":
			return {
				...state,
				retry: {
					attempt: Number(event.attempt ?? 0),
					maxAttempts: Number(event.maxAttempts ?? 0),
					errorMessage: String(event.errorMessage ?? ""),
				},
			};
		case "auto_retry_end": {
			const { retry: _r, ...rest } = state;
			return rest;
		}
		case "session_info_changed":
			if (!state.session) return state;
			return {
				...state,
				session: {
					...state.session,
					...(typeof event.name === "string" ? { name: event.name } : {}),
				},
			};
		case "thinking_level_changed":
			return typeof event.level === "string" ? { ...state, thinkingLevel: event.level } : state;
		case "session.fast":
			return { ...state, fastMode: event.enabled as boolean };
		case "subagent.update": {
			const subagent = event.subagent as SubagentInfo | undefined;
			if (!subagent?.id) return state;
			return { ...state, subagents: { ...(state.subagents ?? {}), [subagent.id]: subagent } };
		}
		case "session.model": {
			const next: ChatState = { ...state, thinkingLevel: String(event.thinkingLevel ?? state.thinkingLevel) };
			if (event.model) next.model = event.model as ModelInfo;
			if (event.contextInfo) next.contextInfo = event.contextInfo as SessionContextInfo;
			return next;
		}
		case "session.replaced": {
			const session = event.session as SessionSummary;
			return { ...initialChatState(session.id, session), notices: state.notices, nextNoticeId: state.nextNoticeId };
		}
		case "session.closed":
			return {
				...state,
				closed: event.reason as ChatState["closed"],
				runState: "inactive",
				pendingUi: [],
			};
		case "ui.request": {
			const request = event.request as UiRequest;
			if (state.pendingUi.some((r) => r.id === request.id)) return state;
			return { ...state, pendingUi: [...state.pendingUi, request] };
		}
		case "ui.resolved":
			return { ...state, pendingUi: state.pendingUi.filter((r) => r.id !== event.requestId) };
		case "ui.notify":
			return addNotice(state, (event.level as NoticeLevel) ?? "info", "notify", String(event.message ?? ""));
		case "ui.status": {
			const statuses = { ...state.statuses };
			if (typeof event.text === "string" && event.text) statuses[String(event.key)] = event.text;
			else delete statuses[String(event.key)];
			return { ...state, statuses };
		}
		case "ui.widget": {
			const widgets = { ...state.widgets };
			const lines = event.lines as string[] | undefined;
			if (lines?.length) {
				widgets[String(event.key)] = {
					lines,
					...(typeof event.placement === "string" ? { placement: event.placement } : {}),
				};
			} else delete widgets[String(event.key)];
			return { ...state, widgets };
		}
		case "ui.title":
			return { ...state, title: String(event.title ?? "") };
		case "ui.editorText":
			return { ...state, editorText: { text: String(event.text ?? ""), nonce: (state.editorText?.nonce ?? 0) + 1 } };
		case "extension.error":
			return addNotice(state, "error", "extension", String(event.error), String(event.extensionPath));
		default:
			return state;
	}
}

/** Mark the state as resynced (after a snapshot request was issued). */
export function clearResync(state: ChatState): ChatState {
	return state.needsResync ? { ...state, needsResync: false } : state;
}

/**
 * The part of a session's state worth keeping on the device, to show it right away next time
 * and resume from it instead of downloading the whole transcript again. `undefined` when
 * there is nothing worth keeping (not loaded yet).
 */
export function cacheableChatState(state: ChatState): ChatState | undefined {
	if (!state.loaded || state.needsResync) return undefined;
	const { notices: _n, editorText: _e, closed: _c, ...rest } = state;
	return { ...rest, notices: [], nextNoticeId: 1 };
}

/** Subagents in the order they started (nested ones after their parent). */
export function subagentList(state: ChatState): SubagentInfo[] {
	return Object.values(state.subagents ?? {});
}

/** Subagents started by one tool call, in start order. */
export function subagentsOf(state: ChatState, toolCallId: string): SubagentInfo[] {
	return subagentList(state).filter((s) => s.toolCallId === toolCallId);
}
