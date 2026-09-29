import type { ChatController } from "@pier/chat-state";
import { type ChatState, contentText, sessionUsage } from "@pier/chat-state";
import type { SessionSummary } from "@pier/protocol";
import { useState } from "react";
import { formatCost, formatPercent, formatTokens, RUN_STATE_LABEL, sessionTitle } from "../lib/format.ts";
import { useAppState, useChatView, useStore } from "../lib/store.tsx";
import { Composer } from "./Composer.tsx";
import { FilesPanelToggle } from "./FilesPanel.tsx";
import { IconAlert, IconFolder, IconInfo, IconLoader, IconX } from "./Icons.tsx";
import { PendingRequests } from "./PendingRequests.tsx";
import { ModelPicker, SessionMenu } from "./SessionControls.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { TerminalToggle } from "./TerminalPanel.tsx";
import { Transcript } from "./Transcript.tsx";

function firstUserText(chat: ChatState): string {
	const first = chat.messages.find((m) => m.role === "user");
	return first ? contentText((first as { content: unknown }).content) : "";
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
	return (
		<button
			type="button"
			className="session-title"
			title="点击重命名"
			onClick={() => {
				setValue(session.name ?? "");
				setEditing(true);
			}}
		>
			{sessionTitle({
				name: session.name ?? fallback.name,
				firstMessage: session.firstMessage || firstUserText(chat) || fallback.firstMessage,
			})}
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

function StatusBar({ chat }: { chat: ChatState }) {
	const usage = sessionUsage(chat);
	const contextWindow = chat.model?.contextWindow;
	const percent =
		contextWindow && usage.lastContext ? Math.round((usage.lastContext / contextWindow) * 100) : undefined;
	return (
		<div className="status-bar">
			<span className={`run-state ${chat.runState}`}>
				<span className="run-dot" />
				{RUN_STATE_LABEL[chat.runState]}
			</span>
			{usage.lastContext ? (
				<span className="context-usage" title="最近一次请求的上下文大小">
					{percent !== undefined ? (
						<span className={`context-meter${percent >= 80 ? " high" : percent >= 50 ? " mid" : ""}`}>
							<span style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
						</span>
					) : null}
					上下文 {formatTokens(usage.lastContext)}
					{contextWindow ? ` / ${formatTokens(contextWindow)}` : ""}
					{percent !== undefined ? `（${percent}%）` : ""}
				</span>
			) : null}
			{usage.input || usage.output ? (
				<span title="本会话累计">
					↑{formatTokens(usage.input)} ↓{formatTokens(usage.output)}
					{usage.cost ? ` · ${formatCost(usage.cost)}` : ""}
				</span>
			) : null}
			{usage.cacheHitRate !== undefined ? (
				<span
					title={`本会话累计：缓存读取 ${formatTokens(usage.cacheRead)}，缓存写入 ${formatTokens(usage.cacheWrite)}，输入合计 ${formatTokens(usage.input)}`}
				>
					缓存命中 {formatPercent(usage.cacheHitRate)}
				</span>
			) : null}
			<span className="spacer" />
			{Object.entries(chat.statuses).map(([key, text]) => (
				<span key={key} className="ext-status">
					{text}
				</span>
			))}
		</div>
	);
}

export function SessionView({ session }: { session: SessionSummary }) {
	const store = useStore();
	useAppState((s) => s.connection);
	const controller = store.chat(session);
	const view = useChatView(controller);
	const workspace = useAppState((s) => s.workspaces).find((w) => w.id === session.workspaceId);

	if (!controller || !view) {
		return <div className="placeholder center">正在连接 Pier Host…</div>;
	}
	const { chat, error } = view;
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
						</span>
					) : null}
				</div>
				<div className="session-tools">
					<ModelPicker chat={chat} controller={controller} />
					<SessionMenu chat={chat} controller={controller} />
					<TerminalToggle workspace={workspace} />
					<FilesPanelToggle />
				</div>
			</header>
			{error ? <div className="banner error">无法打开会话：{error}</div> : null}
			<Transcript chat={chat} />
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
