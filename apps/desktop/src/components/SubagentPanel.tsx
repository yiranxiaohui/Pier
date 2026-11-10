import {
	type AnyMessage,
	type AssistantMessage,
	type ChatController,
	type ChatState,
	initialChatState,
	type ToolExecution,
} from "@pier/chat-state";
import type { SubagentInfo, WorkspaceInfo } from "@pier/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, formatTokens } from "../lib/format.ts";
import { useAppState, useChatView, useStore } from "../lib/store.tsx";
import { IconBot, IconChevronRight, IconInfo, IconLoader, IconStop, IconX } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { PanelHeading, ResizeHandle } from "./PanelChrome.tsx";
import {
	SUBAGENT_STATUS_LABEL,
	type SubagentScope,
	subagentElapsed,
	subagentModel,
	subagentSummary,
	useNow,
} from "./SubagentCard.tsx";
import { Transcript } from "./Transcript.tsx";

/** Fetching subagent conversations again waits at least this long between requests. */
const REFRESH_MS = 500;

interface Conversation {
	id: string;
	messages: AnyMessage[];
	streaming?: AssistantMessage;
	loaded: boolean;
	error?: string;
}

/**
 * A subagent's conversation, fetched when the panel opens and again (incrementally, from the
 * last message it has) whenever the subagent reports a change.
 */
function useConversation(controller: ChatController | undefined, subagent: SubagentInfo | undefined): Conversation {
	const id = subagent?.id ?? "";
	const [conversation, setConversation] = useState<Conversation>({ id, messages: [], loaded: false });
	const state = useRef(conversation);
	state.current = conversation.id === id ? conversation : { id, messages: [], loaded: false };
	const inflight = useRef(false);
	const again = useRef(false);
	const last = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const available = subagent?.transcript === true;

	const fetchConversation = useCallback(async () => {
		if (!controller || !id || !available) return;
		if (inflight.current) {
			again.current = true;
			return;
		}
		inflight.current = true;
		last.current = Date.now();
		try {
			const current = state.current;
			let from = current.id === id ? current.messages.length : 0;
			let result = await controller.subagentTranscript(id, from);
			if (result.from > result.total) {
				from = 0;
				result = await controller.subagentTranscript(id, 0);
			}
			const base = state.current.id === id ? state.current.messages.slice(0, from) : [];
			const next: Conversation = {
				id,
				messages: [...base, ...(result.messages as AnyMessage[])],
				loaded: true,
				...(result.streamingMessage ? { streaming: result.streamingMessage as AssistantMessage } : {}),
			};
			state.current = next;
			setConversation(next);
		} catch (error) {
			const next: Conversation = {
				...state.current,
				id,
				loaded: true,
				error: error instanceof Error ? error.message : String(error),
			};
			state.current = next;
			setConversation(next);
		} finally {
			inflight.current = false;
			if (again.current) {
				again.current = false;
				timer.current = setTimeout(() => void fetchConversation(), REFRESH_MS);
			}
		}
	}, [controller, id, available]);

	const revision = subagent?.revision;
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetch again whenever the subagent's conversation changes.
	useEffect(() => {
		if (timer.current) clearTimeout(timer.current);
		const wait = Math.max(0, REFRESH_MS - (Date.now() - last.current));
		timer.current = setTimeout(() => void fetchConversation(), wait);
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, [fetchConversation, revision]);

	return conversation.id === id ? conversation : { id, messages: [], loaded: false };
}

/** A read-only chat state for the subagent's conversation, so the session transcript can render it. */
function conversationChat(conversation: Conversation, subagent: SubagentInfo, parent: ChatState): ChatState {
	const running = subagent.status === "running";
	const tools: Record<string, ToolExecution> = {};
	if (running) {
		const finished = new Set(
			conversation.messages
				.filter((m) => m.role === "toolResult")
				.map((m) => String((m as { toolCallId?: unknown }).toolCallId)),
		);
		for (const message of conversation.messages) {
			if (message.role !== "assistant") continue;
			for (const part of (message as AssistantMessage).content ?? []) {
				if (part?.type === "toolCall" && !finished.has(part.id)) {
					tools[part.id] = { toolCallId: part.id, toolName: part.name, args: part.arguments, status: "running" };
				}
			}
		}
	}
	return {
		...initialChatState(`subagent:${subagent.id}`),
		loaded: conversation.loaded,
		messages: conversation.messages,
		...(conversation.streaming ? { streaming: conversation.streaming } : {}),
		tools,
		runState: running ? "streaming" : "idle",
		subagents: parent.subagents,
	};
}

function Task({ subagent }: { subagent: SubagentInfo }) {
	const [open, setOpen] = useState(false);
	if (!subagent.task) return null;
	return (
		<div className={`subagent-task${open ? " open" : ""}`}>
			<button type="button" className="subagent-task-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
				<IconChevronRight size={13} className={`chevron${open ? " open" : ""}`} />
				委派的任务
			</button>
			{open ? (
				<div className="subagent-task-text">
					<Markdown text={subagent.task} />
				</div>
			) : (
				<div className="subagent-task-preview">{subagent.task}</div>
			)}
		</div>
	);
}

/** The right-hand panel's view of one subagent: its state and (read-only) conversation. */
export function SubagentPanel({
	workspace,
	sessionId,
	subagentId,
}: {
	workspace: WorkspaceInfo;
	sessionId: string;
	subagentId: string;
}) {
	const store = useStore();
	useAppState((s) => s.sessions);
	const session = store.findSession(sessionId);
	const controller = session ? store.chat(session) : undefined;
	const view = useChatView(controller);
	const subagent = view?.chat.subagents?.[subagentId];
	const conversation = useConversation(controller, subagent);
	const running = subagent?.status === "running";
	const now = useNow(running);
	const scope = useMemo<SubagentScope>(() => ({ sessionId, controller }), [sessionId, controller]);
	const chat = useMemo(
		() => (subagent && view ? conversationChat(conversation, subagent, view.chat) : undefined),
		[conversation, subagent, view],
	);
	const elapsed = subagent ? subagentElapsed(subagent, now) : undefined;
	const model = subagent ? subagentModel(subagent) : "";
	const summary = subagent ? subagentSummary(subagent) : undefined;

	return (
		<aside className="files-panel subagent-panel" aria-label="Subagent 的对话">
			<ResizeHandle />
			<header className="files-header">
				<PanelHeading workspaceId={workspace.id} name={workspace.name} title={workspace.path} />
				<div className="subagent-panel-actions">
					{running && subagent?.stoppable && controller ? (
						<button
							type="button"
							className="ghost subagent-panel-stop"
							title="停止这个 Subagent"
							onClick={() => void controller.stopSubagent(subagentId)}
						>
							<IconStop size={11} />
							停止
						</button>
					) : null}
					<button type="button" className="ghost icon" title="关闭" onClick={() => store.closeSubagent()}>
						<IconX size={14} />
					</button>
				</div>
			</header>
			{subagent && chat ? (
				<>
					<div className={`subagent-panel-summary status-${subagent.status}`}>
						<div className="subagent-panel-title">
							<span className="subagent-avatar">
								<IconBot size={15} />
								<span className="subagent-dot" />
							</span>
							<span className="subagent-name">{subagent.name}</span>
							{model ? <span className="subagent-model">{model}</span> : null}
							{running ? <IconLoader size={14} className="spin subagent-mark" /> : null}
						</div>
						<div className="subagent-panel-meta">
							{SUBAGENT_STATUS_LABEL[subagent.status]}
							{elapsed !== undefined ? ` · ${formatDuration(elapsed)}` : ""}
							{` · ${subagent.steps} 个步骤`}
							{subagent.tokens ? ` · ${formatTokens(subagent.tokens)} tokens` : ""}
						</div>
						{summary && summary !== subagent.task ? <div className="subagent-panel-desc">{summary}</div> : null}
						<Task subagent={subagent} />
						{subagent.error ? <div className="subagent-panel-error">{subagent.error}</div> : null}
					</div>
					{subagent.transcript ? (
						<>
							{conversation.error ? <div className="banner error">无法读取对话：{conversation.error}</div> : null}
							<Transcript
								chat={chat}
								workspaceId={workspace.id}
								scope={scope}
								emptyText={conversation.loaded ? "还没有对话内容" : "正在加载对话…"}
							/>
						</>
					) : (
						<div className="subagent-panel-unavailable">
							<IconInfo size={14} />
							<span>这个 Subagent 的对话无法查看。</span>
							{subagent.result ? <Markdown text={subagent.result} /> : null}
						</div>
					)}
					<footer className="subagent-panel-foot">Subagent 由主 Agent 驱动，无法直接输入。</footer>
				</>
			) : (
				<div className="placeholder center">{view ? "找不到这个 Subagent" : "正在连接…"}</div>
			)}
		</aside>
	);
}
