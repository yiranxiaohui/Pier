import type { ChatController } from "@pier/chat-state";
import { type ChatState, sessionUsage, userText } from "@pier/chat-state";
import type { SessionContextInfo, SessionSummary } from "@pier/protocol";
import { useCallback, useMemo, useState } from "react";
import { formatCost, formatPercent, formatTokens, RUN_STATE_LABEL, sessionTitle } from "../lib/format.ts";
import { LOCAL_NODE, useAppState, useChatView, useStore } from "../lib/store.tsx";
import { BrowserButton } from "./BrowserPanel.tsx";
import { Composer } from "./Composer.tsx";
import { FilesPanelToggle } from "./FilesPanel.tsx";
import {
	IconAlert,
	IconArrowDown,
	IconArrowUp,
	IconDatabaseZap,
	IconFolder,
	IconInfo,
	IconLoader,
	IconX,
} from "./Icons.tsx";
import { PendingRequests } from "./PendingRequests.tsx";
import { SessionMenu } from "./SessionControls.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { TerminalToggle } from "./TerminalPanel.tsx";
import { type EditMessage, Transcript } from "./Transcript.tsx";

function firstUserText(chat: ChatState): string {
	const first = chat.messages.find((m) => m.role === "user");
	return first ? userText((first as { content: unknown }).content) : "";
}

function Title({ chat, fallback }: { chat: ChatState; fallback: SessionSummary }) {
	const store = useStore();
	const session = chat.session ?? fallback;
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	if (editing) {
		return (
			<form
				className="title-form"
				onSubmit={(e) => {
					e.preventDefault();
					setEditing(false);
					const name = value.trim();
					if (name && name !== session.name) void store.renameSession(session, name);
				}}
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: entering rename mode.
					autoFocus
					value={value}
					maxLength={200}
					onChange={(e) => setValue(e.target.value)}
					onBlur={() => setEditing(false)}
					onKeyDown={(e) => {
						if (e.key === "Escape") setEditing(false);
					}}
				/>
			</form>
		);
	}
	const titleSource = {
		name: session.name ?? fallback.name,
		firstMessage: session.firstMessage || firstUserText(chat) || fallback.firstMessage,
	};
	return (
		<button
			type="button"
			className="session-title"
			title={`${sessionTitle(titleSource, { full: true })}\n点击重命名`}
			onClick={() => {
				setValue(session.name ?? "");
				setEditing(true);
			}}
		>
			{sessionTitle(titleSource)}
		</button>
	);
}

function Banners({ chat }: { chat: ChatState }) {
	return (
		<>
			{chat.retry ? (
				<div className="banner warning">
					<IconLoader size={15} className="spin" />
					正在重试（{chat.retry.attempt}/{chat.retry.maxAttempts}）：{chat.retry.errorMessage}
				</div>
			) : null}
			{chat.compacting ? (
				<div className="banner info">
					<IconLoader size={15} className="spin" />
					正在压缩上下文…
				</div>
			) : null}
			{chat.errorMessage && chat.runState === "idle" ? (
				<div className="banner error">
					<IconAlert size={15} />
					<span>上一次运行出错：{chat.errorMessage}</span>
				</div>
			) : null}
			{chat.closed ? (
				<div className="banner warning">
					<IconInfo size={15} />
					{chat.closed === "host_shutdown"
						? "Pier Host 已停止，会话已关闭。"
						: chat.closed === "deleted"
							? "会话已被删除。"
							: "会话已关闭。"}
				</div>
			) : null}
		</>
	);
}

function Notices({ chat, controller }: { chat: ChatState; controller: ChatController }) {
	if (!chat.notices.length) return null;
	return (
		<div className="notices">
			{chat.notices.slice(-3).map((notice) => (
				<div key={notice.id} className={`notice ${notice.level}`}>
					{notice.level === "info" ? <IconInfo size={14} /> : <IconAlert size={14} />}
					<span>
						{notice.kind === "extension"
							? `扩展出错（${notice.source ?? "未知"}）：`
							: notice.kind === "compaction"
								? "压缩失败："
								: ""}
						{notice.message}
					</span>
					<button type="button" className="ghost icon" title="关闭" onClick={() => controller.dismissNotice(notice.id)}>
						<IconX size={13} />
					</button>
				</div>
			))}
		</div>
	);
}

function Widgets({ chat, placement }: { chat: ChatState; placement: "aboveEditor" | "belowEditor" }) {
	const widgets = Object.entries(chat.widgets).filter(([, w]) => (w.placement ?? "aboveEditor") === placement);
	if (!widgets.length) return null;
	return (
		<div className="widgets">
			{widgets.map(([key, widget]) => (
				<pre key={key} className="widget">
					{widget.lines.join("\n")}
				</pre>
			))}
		</div>
	);
}

function Queue({ chat }: { chat: ChatState }) {
	const { steering, followUp } = chat.queue;
	if (!steering.length && !followUp.length) return null;
	return (
		<div className="queue">
			{steering.map((text, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: queue entries are positional.
				<div key={`s${i}`} className="queue-item">
					<span className="badge">引导</span>
					{text}
				</div>
			))}
			{followUp.map((text, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: queue entries are positional.
				<div key={`f${i}`} className="queue-item">
					<span className="badge">排队</span>
					{text}
				</div>
			))}
		</div>
	);
}

function contextUsageTitle(
	info: SessionContextInfo | undefined,
	lastContext: number,
	contextWindow: number | undefined,
	share: number | undefined,
): string {
	const used = share === undefined ? "" : share < 0.01 ? "，已用不到 1%" : `，已用 ${Math.round(share * 100)}%`;
	const lines = [lastContext ? `最近一次请求的上下文大小${used}` : "还没有回复，回复后显示上下文大小"];
	lines.push(contextWindow ? `窗口上限：${formatTokens(contextWindow)}` : "窗口上限：运行时未报告");
	if (!info) {
		lines.push("自动压缩：运行时未报告阈值");
	} else if (info.autoCompaction === "disabled") {
		lines.push("自动压缩：已关闭");
	} else if (info.autoCompaction === "runtime") {
		lines.push("自动压缩：由运行时决定");
	} else if (info.compactionThreshold !== undefined) {
		lines.push(`自动压缩：达到 ${formatTokens(info.compactionThreshold)} 时触发`);
	}
	if (info?.reserveTokens !== undefined) lines.push(`回复预留：${formatTokens(info.reserveTokens)}`);
	if (info?.keepRecentTokens !== undefined) lines.push(`压缩后保留最近内容：${formatTokens(info.keepRecentTokens)}`);
	return lines.join("\n");
}

/** The least of the ring a used context fills, so the first tokens of a large window show. */
const CONTEXT_RING_MIN = 0.06;

/**
 * How full the context window is: a ring that fills clockwise from the top, an empty track while the
 * share is unknown. It fills by the square root of the share, so every reply moves it on even in a
 * window of a million tokens; amber past half and red past 80% of the real share.
 */
function ContextRing({ share }: { share: number | undefined }) {
	const circumference = 2 * Math.PI * 5;
	const real = Math.min(1, share ?? 0);
	const level = real >= 0.8 ? " high" : real >= 0.5 ? " mid" : "";
	const fill = real > 0 ? Math.max(CONTEXT_RING_MIN, Math.sqrt(real)) : 0;
	return (
		<svg className={`context-ring${level}`} width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
			<circle cx="7" cy="7" r="5" />
			{fill ? (
				<circle
					cx="7"
					cy="7"
					r="5"
					strokeDasharray={`${fill * circumference} ${circumference}`}
					transform="rotate(-90 7 7)"
				/>
			) : null}
		</svg>
	);
}

function StatusBar({ chat }: { chat: ChatState }) {
	const usage = sessionUsage(chat);
	const contextWindow = chat.contextInfo?.contextWindow ?? chat.model?.contextWindow;
	const share = contextWindow && usage.lastContext ? usage.lastContext / contextWindow : undefined;
	return (
		<div className="status-bar">
			<span className={`run-state ${chat.runState}`}>
				<span className="run-dot" />
				{RUN_STATE_LABEL[chat.runState]}
			</span>
			{Object.entries(chat.statuses).map(([key, text]) => (
				<span key={key} className="ext-status">
					{text}
				</span>
			))}
			<span className="spacer" />
			<span className="status-usage">
				{/* Always there, so it does not come and go: before the first reply, or when the runtime
				    reports no window (Claude Code models without [1m]), the ring stays empty. */}
				<span title={contextUsageTitle(chat.contextInfo, usage.lastContext, contextWindow, share)}>
					<ContextRing share={share} />
					{usage.lastContext ? formatTokens(usage.lastContext) : "—"}
					{contextWindow ? ` / ${formatTokens(contextWindow)}` : ""}
				</span>
				{usage.input || usage.output ? (
					<span
						className="usage-tokens"
						title={`本会话累计：输入 ${formatTokens(usage.input)}，输出 ${formatTokens(usage.output)}${usage.cost ? `，费用 ${formatCost(usage.cost)}` : ""}`}
					>
						<span>
							<IconArrowUp size={11} />
							{formatTokens(usage.input)}
						</span>
						<span>
							<IconArrowDown size={11} />
							{formatTokens(usage.output)}
						</span>
						{usage.cost ? <span>{formatCost(usage.cost)}</span> : null}
					</span>
				) : null}
				{usage.cacheHitRate !== undefined ? (
					<span
						title={`缓存命中率\n本会话累计：缓存读取 ${formatTokens(usage.cacheRead)}，缓存写入 ${formatTokens(usage.cacheWrite)}，输入合计 ${formatTokens(usage.input)}`}
					>
						<IconDatabaseZap size={11} />
						{formatPercent(usage.cacheHitRate)}
					</span>
				) : null}
			</span>
		</div>
	);
}

export function SessionView({ session }: { session: SessionSummary }) {
	const store = useStore();
	useAppState((s) => s.connection);
	const controller = store.chat(session);
	const view = useChatView(controller);
	const scope = useMemo(() => ({ sessionId: session.id, controller }), [session.id, controller]);
	const workspace = useAppState((s) => s.workspaces).find((w) => w.id === session.workspaceId);
	const node = useAppState((s) => s.workspaceNodes[session.workspaceId] ?? LOCAL_NODE);
	const nodeOnline = useAppState((s) => s.nodes[node]?.connection === "open");
	useAppState((s) => s.peers);
	const editMessage = useCallback<EditMessage>(
		(item, fromEnd, text) => store.resendEdited(session, item, fromEnd, text),
		[store, session],
	);

	if (!controller || !view) {
		return (
			<div className="placeholder center">
				{node === LOCAL_NODE
					? "正在连接 Pier Host…"
					: nodeOnline
						? "正在打开会话…"
						: `正在连接 ${store.nodeName(node)}…`}
			</div>
		);
	}
	const { chat, error } = view;
	// Editing forks the session; offered while it is idle, so the fork has a settled history.
	const canEdit = chat.capabilities?.fork !== false && (chat.runState === "idle" || chat.runState === "inactive");
	return (
		<div className="session-view">
			<header className="session-header">
				<SidebarToggle />
				<div className="session-heading">
					<Title chat={chat} fallback={session} />
					{workspace ? (
						<span className="session-crumb" title={workspace.path}>
							<IconFolder size={12} />
							{workspace.name}
							{node === LOCAL_NODE ? null : <span className="session-crumb-node"> · {store.nodeName(node)}</span>}
						</span>
					) : null}
				</div>
				<div className="session-tools">
					<SessionMenu chat={chat} controller={controller} />
					<BrowserButton workspace={workspace} />
					<TerminalToggle workspace={workspace} />
					<FilesPanelToggle />
				</div>
			</header>
			{error ? <div className="banner error">无法打开会话：{error}</div> : null}
			<Transcript
				chat={chat}
				workspaceId={session.workspaceId}
				scope={scope}
				onEdit={canEdit ? editMessage : undefined}
			/>
			<div className="session-bottom">
				<Banners chat={chat} />
				<Notices chat={chat} controller={controller} />
				<PendingRequests requests={chat.pendingUi} respond={(id, r) => void controller.respond(id, r)} />
				<Widgets chat={chat} placement="aboveEditor" />
				<Queue chat={chat} />
				<Composer key={chat.sessionId} chat={chat} controller={controller} workspace={workspace} />
				<Widgets chat={chat} placement="belowEditor" />
				<StatusBar chat={chat} />
			</div>
		</div>
	);
}
