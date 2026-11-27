import {
	type AssistantBlock,
	buildTranscript,
	type ChatState,
	formatThinking,
	isWaitingForModel,
	type ToolBlock,
	type TranscriptItem,
	thinkingHeadline,
	unwrapFileRefs,
	waitingForModelLabel,
} from "@pier/chat-state";
import type { UiRequest } from "@pier/protocol";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { splitMessageContexts } from "../lib/browser-context.ts";
import { clockTime, formatTokens } from "../lib/format.ts";
import { type Draft, useStore } from "../lib/store.tsx";
import { DraftAttachments, readImages } from "./Composer.tsx";
import { FileRefText } from "./FileRefText.tsx";
import {
	IconArrowDown,
	IconBrain,
	IconChevronRight,
	IconClock,
	IconImage,
	IconLayers,
	IconMousePointer,
	IconPencil,
	IconScan,
	IconSparkles,
	IconTerminal,
} from "./Icons.tsx";
import { ImageThumb } from "./ImageLightbox.tsx";
import { CopyButton, Markdown, MarkdownFiles } from "./Markdown.tsx";
import { delegates, SubagentCard, type SubagentScope, SubagentScopeContext } from "./SubagentCard.tsx";
import { ToolCard, ToolImages } from "./ToolCard.tsx";

function Thinking({ text, redacted, live }: { text: string; redacted: boolean; live: boolean }) {
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const expanded = open ?? live;
	const headline = useMemo(() => thinkingHeadline(text), [text]);
	const formatted = useMemo(() => formatThinking(text), [text]);
	return (
		<div className={`thinking${expanded ? " open" : ""}`}>
			<button
				type="button"
				className="thinking-toggle"
				onClick={() => setOpen(!expanded)}
				title={!expanded && headline ? headline : undefined}
			>
				<IconBrain size={14} className={live ? "thinking-live" : undefined} />
				<span className={live ? "shimmer" : undefined}>{live ? "思考中…" : "思考过程"}</span>
				{redacted ? "（已被隐藏）" : ""}
				{!expanded && headline ? <span className="thinking-headline">{headline}</span> : null}
				<IconChevronRight size={13} className={`chevron${expanded ? " open" : ""}`} />
			</button>
			{expanded && text ? (
				<div className="thinking-text">
					<Markdown text={formatted} />
				</div>
			) : null}
		</div>
	);
}

type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;

function blocksEqual(a: AssistantBlock[], b: AssistantBlock[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((x, i) => {
		const y = b[i];
		if (!y || x.kind !== y.kind) return false;
		if (x.kind === "tool" && y.kind === "tool") {
			return (
				x.status === y.status &&
				x.execution === y.execution &&
				x.result === y.result &&
				x.call === y.call &&
				sameItems(x.subagents, y.subagents)
			);
		}
		if (x.kind === "thinking" && y.kind === "thinking") {
			return x.text === y.text && x.redacted === y.redacted && x.live === y.live;
		}
		return x.kind !== "text" || (y.kind === "text" && x.text === y.text);
	});
}

function sameItems<T>(a: T[] | undefined, b: T[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((x, i) => x === b[i]);
}

/** Content parts to render: runs of consecutive delegating tool calls share one subagent card. */
type Part = { kind: "block"; block: AssistantBlock; index: number } | { kind: "subagents"; blocks: ToolBlock[] };

function groupParts(blocks: AssistantBlock[], approvals: Map<string, UiRequest>): Part[] {
	const parts: Part[] = [];
	for (const [index, block] of blocks.entries()) {
		if (block.kind === "tool" && delegates(block) && !approvals.has(block.call.id)) {
			const last = parts.at(-1);
			if (last?.kind === "subagents") last.blocks.push(block);
			else parts.push({ kind: "subagents", blocks: [block] });
		} else parts.push({ kind: "block", block, index });
	}
	return parts;
}

/** Whether an assistant message only delegates to subagents. */
function onlyDelegates(item: TranscriptItem, approvals: Map<string, UiRequest>): item is AssistantItem {
	return (
		item.kind === "assistant" &&
		item.blocks.length > 0 &&
		!item.message.errorMessage &&
		item.blocks.every((b) => b.kind === "tool" && delegates(b) && !approvals.has(b.call.id))
	);
}

/**
 * Consecutive assistant messages that only delegate share one subagent card: Codex starts each
 * sub-agent in a message of its own.
 */
function mergeDelegations(items: TranscriptItem[], approvals: Map<string, UiRequest>): TranscriptItem[] {
	const merged: TranscriptItem[] = [];
	for (const item of items) {
		const previous = merged.at(-1);
		if (previous && onlyDelegates(previous, approvals) && onlyDelegates(item, approvals)) {
			merged[merged.length - 1] = {
				...previous,
				message: item.message,
				blocks: [...previous.blocks, ...item.blocks],
				streaming: item.streaming,
			};
		} else merged.push(item);
	}
	return merged;
}

/**
 * Whether `items[index]` is the last assistant message of its turn, which alone carries the reply's
 * footer, as in ChatGPT and Codex: a footer under every step would keep each step apart. The last
 * message ends its turn only once the agent stops.
 */
function endsTurn(items: TranscriptItem[], index: number, running: boolean): boolean {
	const next = items[index + 1];
	return next ? next.kind !== "assistant" : !running;
}

const AssistantMessageView = memo(
	function AssistantMessageView({
		item,
		approvals,
		endsTurn,
	}: {
		item: AssistantItem;
		approvals: Map<string, UiRequest>;
		endsTurn: boolean;
	}) {
		const { message, blocks, streaming } = item;
		const text = blocks
			.filter((b): b is Extract<AssistantBlock, { kind: "text" }> => b.kind === "text")
			.map((b) => b.text)
			.join("\n\n");
		return (
			<div className={`message assistant${streaming ? " streaming" : ""}`}>
				{groupParts(blocks, approvals).map((part) => {
					if (part.kind === "subagents") {
						return <SubagentCard key={`subagents-${part.blocks[0]?.call.id}`} blocks={part.blocks} />;
					}
					const { block, index: i } = part;
					if (block.kind === "text") return <Markdown key={i} text={block.text} />;
					if (block.kind === "thinking") {
						return <Thinking key={i} text={block.text} redacted={block.redacted} live={block.live} />;
					}
					return <ToolCard key={block.call.id || i} block={block} approval={approvals.get(block.call.id)} />;
				})}
				{message.stopReason === "error" && message.errorMessage ? (
					<div className="message-error">出错了：{message.errorMessage}</div>
				) : null}
				{message.stopReason === "aborted" ? <div className="message-note">已中止</div> : null}
				{endsTurn && !streaming && text ? (
					<div className="message-footer">
						<CopyButton text={text} iconOnly label="复制回复" />
						{message.model ? (
							<span title={`模型：${message.model}`}>
								<IconSparkles size={12} />
								{message.model}
							</span>
						) : null}
						{message.usage?.output ? (
							<span title={`这条回复输出了 ${message.usage.output.toLocaleString()} tokens`}>
								<IconArrowDown size={12} />
								{formatTokens(message.usage.output)} tokens
							</span>
						) : null}
						{message.timestamp ? (
							<span title={new Date(message.timestamp).toLocaleString()}>
								<IconClock size={12} />
								{clockTime(message.timestamp)}
							</span>
						) : null}
					</div>
				) : null}
			</div>
		);
	},
	(prev, next) =>
		prev.endsTurn === next.endsTurn &&
		prev.item.message === next.item.message &&
		prev.item.streaming === next.item.streaming &&
		blocksEqual(prev.item.blocks, next.item.blocks) &&
		prev.item.blocks.every((b) => b.kind !== "tool" || prev.approvals.get(b.call.id) === next.approvals.get(b.call.id)),
);

type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/** What an edited message sends: its text and the images it keeps or gains. */
export interface EditedMessage {
	text: string;
	images: Draft["images"];
}

/**
 * Sends an edited version of a user message; `fromEnd` counts the user messages after it.
 * Resolves to whether it was sent.
 */
export type EditMessage = (item: UserItem, fromEnd: number, edit: EditedMessage) => Promise<boolean>;

/**
 * The editor a sent message turns into, as in ChatGPT: Enter sends, Shift+Enter breaks the line,
 * Esc cancels. The message's images show above the text and can be removed; more can be pasted,
 * dropped or picked.
 */
function MessageEditor({
	initial,
	inPlace,
	onCancel,
	onSend,
}: {
	initial: EditedMessage;
	/** Whether sending replaces the message in this session (`session.rewind`) rather than forking it. */
	inPlace: boolean;
	onCancel(): void;
	onSend(edit: EditedMessage): Promise<boolean>;
}) {
	const store = useStore();
	const [draft, setDraft] = useState<Draft>(initial);
	const [sending, setSending] = useState(false);
	const [dragging, setDragging] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	// Start with the caret after the text.
	useEffect(() => {
		const el = field.current;
		el?.focus();
		el?.setSelectionRange(el.value.length, el.value.length);
	}, []);
	// Grow with the text, up to the max-height in CSS.
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure again whenever the text changes.
	useLayoutEffect(() => {
		const el = field.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [draft.text]);

	const text = draft.text.trim();
	const canSend = !sending && (text.length > 0 || draft.images.length > 0);
	const send = async () => {
		if (!canSend) return;
		setSending(true);
		// Once sent, the message is replaced (or its fork opens); otherwise keep editing.
		if (await onSend({ text, images: draft.images })) onCancel();
		else setSending(false);
	};
	const addFiles = async (files: Iterable<File>) => {
		const images = await readImages(files, (message) => store.toast("warning", message));
		if (images.length) setDraft((d) => ({ ...d, images: [...d.images, ...images].slice(0, 16) }));
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target for dragged images.
		<div
			className={`message user-edit${dragging ? " dragging" : ""}`}
			onDragOver={(event) => {
				if (sending || ![...event.dataTransfer.items].some((i) => i.type.startsWith("image/"))) return;
				event.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(event) => {
				setDragging(false);
				if (sending || !event.dataTransfer.files.length) return;
				event.preventDefault();
				void addFiles(event.dataTransfer.files);
			}}
		>
			<DraftAttachments draft={draft} setDraft={setDraft} />
			<textarea
				ref={field}
				rows={1}
				value={draft.text}
				disabled={sending}
				aria-label="编辑消息"
				onChange={(event) => {
					const value = event.target.value;
					setDraft((d) => ({ ...d, text: value }));
				}}
				onPaste={(event) => {
					const files = [...event.clipboardData.files].filter((f) => f.type.startsWith("image/"));
					if (!files.length) return;
					event.preventDefault();
					void addFiles(files);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") onCancel();
					else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						void send();
					}
				}}
			/>
			<div className="user-edit-actions">
				<button
					type="button"
					className="ghost icon user-edit-attach"
					title="添加图片（也可以粘贴或拖入）"
					aria-label="添加图片"
					disabled={sending}
					onClick={() => fileInput.current?.click()}
				>
					<IconImage size={16} />
				</button>
				<input
					ref={fileInput}
					type="file"
					accept="image/*"
					multiple
					hidden
					onChange={(event) => {
						const files = [...(event.target.files ?? [])];
						event.target.value = "";
						void addFiles(files);
					}}
				/>
				<button type="button" className="user-edit-cancel" disabled={sending} onClick={onCancel}>
					取消
				</button>
				<button
					type="button"
					className="user-edit-send"
					disabled={!canSend}
					title={
						inPlace
							? "用修改后的消息替换这条消息并重新发送，之后的对话会被丢弃（Agent 改过的文件不会还原）"
							: "从这条消息分叉出新会话并发送，原会话保持不变"
					}
					onClick={() => void send()}
				>
					{sending ? "发送中…" : "发送"}
				</button>
			</div>
		</div>
	);
}

/**
 * A user message's text: picked files show as chips, and browser picks fold into a line that opens
 * to show them.
 */
function UserText({ text }: { text: string }) {
	const parts = splitMessageContexts(text);
	if (!parts.some((part) => part.type === "context")) {
		return (
			<div className="user-text">
				<FileRefText text={text} />
			</div>
		);
	}
	return (
		<div className="user-text">
			{parts.map((part, i) =>
				part.type === "text" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional parts of one message.
					<p key={i} className="user-text-part">
						<FileRefText text={part.text} />
					</p>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional parts of one message.
					<details key={i} className="user-context">
						<summary className="user-context-summary">
							{part.kind === "element" ? <IconMousePointer size={13} /> : <IconScan size={13} />}
							<span className="user-context-label">{part.label}</span>
							{part.note ? <span className="user-context-note">{part.note}</span> : null}
						</summary>
						<pre>{part.text}</pre>
					</details>
				),
			)}
		</div>
	);
}

function UserMessage({
	item,
	fromEnd,
	onEdit,
	editInPlace,
}: {
	item: UserItem;
	fromEnd: number;
	onEdit?: EditMessage;
	editInPlace: boolean;
}) {
	const [editing, setEditing] = useState(false);
	if (editing && onEdit) {
		return (
			<MessageEditor
				initial={{
					text: item.text,
					images: item.images.map((image, i) => ({
						data: image.data,
						mimeType: image.mimeType,
						name: `图片 ${i + 1}`,
					})),
				}}
				inPlace={editInPlace}
				onCancel={() => setEditing(false)}
				onSend={(edit) => onEdit(item, fromEnd, edit)}
			/>
		);
	}
	return (
		<div className="message user">
			{item.images.length ? (
				<div className="message-images">
					{item.images.map((image, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional attachments.
						<ImageThumb key={i} src={`data:${image.mimeType};base64,${image.data}`} alt="附件" />
					))}
				</div>
			) : null}
			{item.text ? <UserText text={item.text} /> : null}
			{/* Under the bubble on hover, as ChatGPT has them. */}
			<div className="user-actions">
				{item.text ? <CopyButton text={() => unwrapFileRefs(item.text)} iconOnly label="复制消息" /> : null}
				{onEdit ? (
					<button type="button" className="ghost icon" title="编辑消息" onClick={() => setEditing(true)}>
						<IconPencil size={14} />
					</button>
				) : null}
			</div>
		</div>
	);
}

const ItemView = memo(function ItemView({
	item,
	approvals,
	fromEnd,
	endsTurn,
	onEdit,
	editInPlace,
}: {
	item: TranscriptItem;
	approvals: Map<string, UiRequest>;
	fromEnd: number;
	/** Whether an assistant message is its turn's last: only that one gets the footer. */
	endsTurn: boolean;
	onEdit?: EditMessage | undefined;
	editInPlace: boolean;
}) {
	switch (item.kind) {
		case "user":
			return <UserMessage item={item} fromEnd={fromEnd} editInPlace={editInPlace} {...(onEdit ? { onEdit } : {})} />;
		case "assistant":
			return <AssistantMessageView item={item} approvals={approvals} endsTurn={endsTurn} />;
		case "bash":
			return (
				<div className="message bash tool-card">
					<div className="tool-header static">
						<span className="tool-icon">
							<IconTerminal size={16} />
						</span>
						<span className="tool-name">终端</span>
						<span className="tool-summary">{item.message.command}</span>
						{item.message.exitCode ? <span className="tool-status error">退出码 {item.message.exitCode}</span> : null}
					</div>
					<div className="tool-body">
						<pre className="tool-command">
							<span className="prompt">!</span> {item.message.command}
						</pre>
						<pre className="tool-output">{item.message.output}</pre>
					</div>
				</div>
			);
		case "custom":
			return (
				<div className="message custom">
					<div className="badge">{item.message.customType}</div>
					<Markdown text={item.text} />
				</div>
			);
		case "compaction":
			return (
				<details className="divider-block">
					<summary>
						<IconLayers size={14} />
						上下文已压缩（此前约 {formatTokens(item.message.tokensBefore)} tokens）
					</summary>
					<Markdown text={item.message.summary} />
				</details>
			);
		case "branchSummary":
			return (
				<details className="divider-block">
					<summary>
						<IconLayers size={14} />
						分支摘要
					</summary>
					<Markdown text={item.message.summary} />
				</details>
			);
		case "toolResult":
			return (
				<div className="message custom">
					<div className="badge">{item.message.toolName} 结果</div>
					<pre className="tool-output">
						{item.message.content.map((c) => (c.type === "text" ? c.text : "")).join("")}
					</pre>
					<ToolImages result={item.message} />
				</div>
			);
		default:
			return (
				<details className="divider-block">
					<summary>{String(item.message.role)} 消息</summary>
					<pre className="tool-preview">{JSON.stringify(item.message, null, 2)}</pre>
				</details>
			);
	}
});

export function Transcript({
	chat,
	workspaceId,
	scope,
	emptyText,
	onEdit,
	editInPlace = false,
}: {
	chat: ChatState;
	workspaceId: string;
	/** Session whose subagents the transcript's subagent cards open and stop. */
	scope?: SubagentScope;
	/** Shown instead of the new-chat placeholder when there are no messages. */
	emptyText?: string;
	/** Present when the user's messages can be edited and sent again. */
	onEdit?: EditMessage | undefined;
	/** Whether an edit replaces the message in the session itself (1.72) rather than forking it. */
	editInPlace?: boolean;
}) {
	const items = useMemo(() => buildTranscript(chat), [chat]);
	// How many user messages follow each one, which places it among the session's fork points.
	const userFromEnd = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of items.toReversed()) if (item.kind === "user") counts.set(item.key, counts.size);
		return counts;
	}, [items]);
	const approvals = useMemo(() => {
		const map = new Map<string, UiRequest>();
		for (const request of chat.pendingUi) {
			if (request.approval?.toolCallId) map.set(request.approval.toolCallId, request);
		}
		return map;
	}, [chat.pendingUi]);
	const shown = useMemo(() => mergeDelegations(items, approvals), [items, approvals]);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [showJump, setShowJump] = useState(false);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});

	// Start at the bottom when switching sessions.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the session changes.
	useEffect(() => {
		stick.current = true;
		setShowJump(false);
	}, [chat.sessionId]);

	const waitingForModel = isWaitingForModel(chat, items);
	const running = chat.runState !== "idle" && chat.runState !== "inactive";

	return (
		<SubagentScopeContext.Provider value={scope}>
			<MarkdownFiles workspaceId={workspaceId}>
				<div
					className="transcript"
					ref={scroller}
					onScroll={(event) => {
						const el = event.currentTarget;
						const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
						stick.current = atBottom;
						setShowJump(!atBottom);
					}}
				>
					<div className="transcript-inner">
						{!chat.loaded ? <div className="placeholder">正在加载会话…</div> : null}
						{chat.loaded && items.length === 0 && emptyText ? <div className="placeholder">{emptyText}</div> : null}
						{chat.loaded && items.length === 0 && !emptyText ? (
							<div className="placeholder new-chat">
								<div className="new-chat-icon">
									<IconSparkles size={26} />
								</div>
								<h2>开始新的对话</h2>
								<p>在下方输入任务，Agent 将在该工作区中读写文件、运行命令。高风险操作会先请求你批准。</p>
							</div>
						) : null}
						{shown.map((item, i) => (
							<ItemView
								key={item.key}
								item={item}
								approvals={approvals}
								fromEnd={userFromEnd.get(item.key) ?? 0}
								endsTurn={endsTurn(shown, i, running)}
								onEdit={onEdit}
								editInPlace={editInPlace}
							/>
						))}
						{waitingForModel ? (
							<div className="model-activity" role="status">
								<IconBrain size={14} className="thinking-live" />
								<span className="shimmer">{waitingForModelLabel(chat)}</span>
							</div>
						) : null}
					</div>
					{showJump ? (
						<button
							type="button"
							className="jump-bottom"
							onClick={() => {
								const el = scroller.current;
								if (el) el.scrollTop = el.scrollHeight;
								stick.current = true;
								setShowJump(false);
							}}
						>
							<IconArrowDown size={14} />
							回到底部
						</button>
					) : null}
				</div>
			</MarkdownFiles>
		</SubagentScopeContext.Provider>
	);
}
