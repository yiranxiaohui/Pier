import {
	type AssistantBlock,
	buildTranscript,
	type ChatState,
	isWaitingForModel,
	type ToolBlock,
	type TranscriptItem,
	waitingForModelLabel,
} from "@pier/chat-state";
import type { UiRequest } from "@pier/protocol";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clockTime, formatTokens } from "../lib/format.ts";
import { IconArrowDown, IconBrain, IconChevronRight, IconLayers, IconSparkles, IconTerminal } from "./Icons.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { CopyButton, Markdown, MarkdownFiles } from "./Markdown.tsx";
import { delegates, SubagentCard, type SubagentScope, SubagentScopeContext } from "./SubagentCard.tsx";
import { ToolCard } from "./ToolCard.tsx";

function Thinking({ text, redacted, live }: { text: string; redacted: boolean; live: boolean }) {
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const expanded = open ?? live;
	return (
		<div className={`thinking${expanded ? " open" : ""}`}>
			<button type="button" className="thinking-toggle" onClick={() => setOpen(!expanded)}>
				<IconBrain size={14} className={live ? "thinking-live" : undefined} />
				<span className={live ? "shimmer" : undefined}>{live ? "思考中…" : "思考过程"}</span>
				{redacted ? "（已被隐藏）" : ""}
				<IconChevronRight size={13} className={`chevron${expanded ? " open" : ""}`} />
			</button>
			{expanded && text ? <div className="thinking-text">{text}</div> : null}
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

const AssistantMessageView = memo(
	function AssistantMessageView({ item, approvals }: { item: AssistantItem; approvals: Map<string, UiRequest> }) {
		const { message, blocks, streaming } = item;
		const text = blocks
			.filter((b): b is Extract<AssistantBlock, { kind: "text" }> => b.kind === "text")
			.map((b) => b.text)
			.join("\n\n");
		return (
			<div className={`message assistant${streaming ? " streaming" : ""}`}>
				<div className="assistant-label">
					<span>
						<IconSparkles size={15} />
					</span>
					Agent
				</div>
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
				{!streaming && text ? (
					<div className="message-footer">
						<CopyButton text={text} iconOnly label="复制回复" />
						{message.model ? <span>{message.model}</span> : null}
						{message.usage?.output ? <span>{formatTokens(message.usage.output)} tokens</span> : null}
						{message.timestamp ? <span>{clockTime(message.timestamp)}</span> : null}
					</div>
				) : null}
			</div>
		);
	},
	(prev, next) =>
		prev.item.message === next.item.message &&
		prev.item.streaming === next.item.streaming &&
		blocksEqual(prev.item.blocks, next.item.blocks) &&
		prev.item.blocks.every((b) => b.kind !== "tool" || prev.approvals.get(b.call.id) === next.approvals.get(b.call.id)),
);

function MessageImage({ src }: { src: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" className="message-image" onClick={() => setOpen(true)} title="查看大图">
				<img src={src} alt="附件" />
			</button>
			{open ? <ImageLightbox src={src} alt="附件" onClose={() => setOpen(false)} /> : null}
		</>
	);
}

const ItemView = memo(function ItemView({
	item,
	approvals,
}: {
	item: TranscriptItem;
	approvals: Map<string, UiRequest>;
}) {
	switch (item.kind) {
		case "user":
			return (
				<div className="message user">
					{item.images.length ? (
						<div className="message-images">
							{item.images.map((image, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: positional attachments.
								<MessageImage key={i} src={`data:${image.mimeType};base64,${image.data}`} />
							))}
						</div>
					) : null}
					{item.text ? <div className="user-text">{item.text}</div> : null}
				</div>
			);
		case "assistant":
			return <AssistantMessageView item={item} approvals={approvals} />;
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
}: {
	chat: ChatState;
	workspaceId: string;
	/** Session whose subagents the transcript's subagent cards open and stop. */
	scope?: SubagentScope;
	/** Shown instead of the new-chat placeholder when there are no messages. */
	emptyText?: string;
}) {
	const items = useMemo(() => buildTranscript(chat), [chat]);
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
						{shown.map((item) => (
							<ItemView key={item.key} item={item} approvals={approvals} />
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
