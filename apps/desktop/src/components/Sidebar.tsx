import { agentRuntimeLabel } from "@pier/chat-state";
import type { ApprovalPolicy, PeerInfo, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { DEFAULT_AGENT_RUNTIME } from "@pier/protocol";
import { type DragEvent, useEffect, useState } from "react";
import { POLICY_DESCRIPTION, POLICY_LABEL, relativeTime, sessionTitle } from "../lib/format.ts";
import {
	type ComputerInfo,
	LOCAL_NODE,
	type PierStore,
	useAppState,
	useCanArchiveSessions,
	useCanManageWorkspace,
	useComputers,
	useStore,
} from "../lib/store.tsx";
import { useHostStatus } from "./HostPanels.tsx";
import {
	IconArchive,
	IconArchiveRestore,
	IconBroom,
	IconChevronRight,
	IconFolder,
	IconFolderPlus,
	IconMonitor,
	IconPanelLeft,
	IconPlus,
	IconSettings,
	IconSquarePen,
	IconTrash,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { platformName } from "./RemotePanel.tsx";
import { SessionCleanupDialog } from "./SessionCleanup.tsx";
import { useOutsideClick } from "./SessionControls.tsx";

const SESSION_PAGE = 30;

export const SIDEBAR_SHORTCUT = "Ctrl/⌘+B";

/**
 * Header button that brings a collapsed sidebar back. Renders nothing while the sidebar is
 * shown (it has its own collapse button then).
 */
export function SidebarToggle({ floating = false }: { floating?: boolean }) {
	const store = useStore();
	const open = useAppState((s) => s.sidebar);
	if (open) return null;
	const button = (
		<button
			type="button"
			className="chip icon-chip sidebar-open-button"
			title={`显示侧边栏（${SIDEBAR_SHORTCUT}）`}
			aria-label="显示侧边栏"
			onClick={() => store.toggleSidebar(true)}
		>
			<IconPanelLeft size={15} />
		</button>
	);
	return floating ? <div className="home-toolbar left">{button}</div> : button;
}

/**
 * Pick a directory and add it as a workspace on a computer (this one by default, browsing a
 * paired computer's directories when needed).
 */
export function useAddWorkspace(node = LOCAL_NODE): () => Promise<void> {
	const store = useStore();
	return () => store.pickAndAddWorkspace(node);
}

/** Why workspaces cannot be added on a computer right now, if they cannot. */
export function addWorkspaceBlocker(computer: ComputerInfo): string | undefined {
	if (computer.state.revoked) return "已移除这台电脑，需要重新配对";
	if (!computer.online) return computer.local ? "Pier Host 未连接" : "未连接";
	if (!computer.canManage) return "Pier 版本较旧，请在那台电脑上添加";
	return undefined;
}

/** Status line of a computer in menus: platform / address for paired ones, and why it is unusable. */
function computerDetail(computer: ComputerInfo, peers: PeerInfo[]): string {
	const blocker = addWorkspaceBlocker(computer);
	if (computer.local) return blocker ?? "本机";
	const peer = peers.find((p) => p.id === computer.id);
	return (
		blocker ?? [peer?.platform ? platformName(peer.platform) : "", peer?.addresses[0] ?? ""].filter(Boolean).join(" · ")
	);
}

/**
 * Menu entries that add a workspace on one of the computers (this one, or a paired one), plus
 * pairing another computer. `onDone` closes the surrounding menu.
 */
export function AddWorkspaceItems({ onDone }: { onDone: () => void }) {
	const store = useStore();
	const computers = useComputers();
	const peers = useAppState((s) => s.peers);
	return (
		<>
			<div className="dropdown-group-title no-caps">在哪台电脑上添加工作区？</div>
			{computers.map((computer) => {
				const blocked = addWorkspaceBlocker(computer) !== undefined;
				return (
					<button
						type="button"
						key={computer.id}
						className="dropdown-item"
						disabled={blocked}
						onClick={() => {
							onDone();
							void store.pickAndAddWorkspace(computer.id);
						}}
					>
						<span className="node-item-text">
							<span className="node-item-name">
								<IconMonitor size={14} />
								{computer.name}
							</span>
							<span className="muted">{computerDetail(computer, peers)}</span>
						</span>
					</button>
				);
			})}
			<div className="dropdown-separator" />
			<button
				type="button"
				className="dropdown-item"
				onClick={() => {
					onDone();
					store.openAddPeer();
				}}
			>
				<span className="menu-label">
					<IconPlus size={14} />
					添加电脑…
				</span>
			</button>
		</>
	);
}

/**
 * The "add workspace" button of the sidebar: straight to the directory dialog while this is
 * the only computer, else a menu of the computers to add it on.
 */
function AddWorkspaceButton() {
	const store = useStore();
	const hasPeers = useAppState((s) => s.peers.length > 0);
	const [open, setOpen] = useState(false);
	const ref = useOutsideClick(open, () => setOpen(false));
	return (
		<div className="dropdown" ref={ref}>
			<button
				type="button"
				className="ghost icon"
				title="添加工作区"
				onClick={() => (hasPeers ? setOpen(!open) : void store.pickAndAddWorkspace())}
			>
				<IconPlus size={14} />
			</button>
			{open ? (
				<div className="dropdown-menu node-menu add-workspace-menu">
					<AddWorkspaceItems onDone={() => setOpen(false)} />
				</div>
			) : null}
		</div>
	);
}

function SessionBadge({ session }: { session: SessionSummary }) {
	const store = useStore();
	useAppState((s) => s.chatsVersion);
	const { running, pending } = sessionActivity(store, session);
	if (pending) return <span className="badge-dot attention" title={`${pending} 个待处理请求`} />;
	if (running) {
		return <span className="badge-dot running" title="运行中" />;
	}
	return null;
}

function isRunning(state: SessionSummary["state"]): boolean {
	return state === "streaming" || state === "retrying" || state === "compacting";
}

function sessionActivity(store: PierStore, session: SessionSummary) {
	const live = store.liveChat(session.id)?.chat;
	const state = live?.loaded ? live.runState : session.state;
	const pending = live?.loaded ? live.pendingUi.length : (session.pendingUi ?? 0);
	const running = isRunning(state);
	return { running, pending, active: running || pending > 0 };
}

function RunningAgents() {
	const store = useStore();
	const workspaces = useAppState((s) => s.workspaces);
	const sessions = useAppState((s) => s.sessions);
	const nodes = useAppState((s) => s.nodes);
	const workspaceNodes = useAppState((s) => s.workspaceNodes);
	const selectedSessionId = useAppState((s) => s.selectedSessionId);
	useAppState((s) => s.chatsVersion);
	const [expanded, setExpanded] = useState(true);
	const agents = workspaces.flatMap((workspace) => {
		const node = workspaceNodes[workspace.id] ?? LOCAL_NODE;
		if (nodes[node]?.connection !== "open") return [];
		return (sessions[workspace.id] ?? []).flatMap((session) => {
			const activity = sessionActivity(store, session);
			return activity.active ? [{ session, workspace, node, pending: activity.pending }] : [];
		});
	});
	if (!workspaces.length) return null;
	return (
		<section className="running-agents" aria-label="运行中的 Agent">
			<button
				type="button"
				className={`running-agents-toggle${expanded ? " open" : ""}`}
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				aria-controls="running-agent-list"
			>
				<IconChevronRight size={13} className="running-agents-chevron" />
				<span className="running-agents-label">运行中的 Agent</span>
				<span className={`running-count${agents.length ? "" : " idle"}`}>
					{agents.length ? <span className="badge-dot running" aria-hidden="true" /> : null}
					{agents.length}
				</span>
			</button>
			<div id="running-agent-list" className="running-agent-list" hidden={!expanded}>
				{agents.length ? (
					agents.map(({ session, workspace, node, pending }) => {
						const runtime = session.runtime ?? DEFAULT_AGENT_RUNTIME;
						const location = node === LOCAL_NODE ? workspace.name : `${workspace.name} · ${store.nodeName(node)}`;
						return (
							<button
								type="button"
								key={session.id}
								className={`running-agent-row${session.id === selectedSessionId ? " selected" : ""}`}
								onClick={() => store.selectSession(session)}
								title={`${sessionTitle(session)} · ${location}${pending ? ` · ${pending} 个待处理请求` : ""}`}
							>
								<span className="running-agent-text">
									<span className="running-agent-title">{sessionTitle(session)}</span>
									<span className="running-agent-location">{location}</span>
								</span>
								<span className="running-agent-meta">
									<span className={`session-agent agent-${runtime}`}>{agentRuntimeLabel(runtime)}</span>
									<span className={`running-agent-status${pending ? " attention" : ""}`}>
										{pending ? "待处理" : "运行中"}
									</span>
								</span>
							</button>
						);
					})
				) : (
					<div className="session-empty">暂无运行中的 Agent</div>
				)}
			</div>
		</section>
	);
}

function SessionItem({
	session,
	selected,
	canArchive,
}: {
	session: SessionSummary;
	selected: boolean;
	canArchive: boolean;
}) {
	const store = useStore();
	useAppState((s) => s.chatsVersion);
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const running = sessionActivity(store, session).active;
	const archived = !!session.archived;
	const runtime = session.runtime ?? DEFAULT_AGENT_RUNTIME;
	return (
		<div className={`session-item${confirm ? " confirming" : ""}${archived ? " archived" : ""}`}>
			<button
				type="button"
				className={`session-row${selected ? " selected" : ""}`}
				onClick={() => store.selectSession(session)}
				title={session.firstMessage || session.name || session.id}
			>
				<span className="session-row-title">{sessionTitle(session)}</span>
				<span className={`session-agent agent-${runtime}`} title={`由 ${agentRuntimeLabel(runtime)} 运行`}>
					{agentRuntimeLabel(runtime)}
				</span>
				<SessionBadge session={session} />
				<span className="session-row-time">{relativeTime(session.modifiedAt)}</span>
			</button>
			<span className="session-actions">
				{canArchive && !confirm ? (
					<button
						type="button"
						className="session-action"
						disabled={busy}
						title={archived ? "取消归档" : "归档会话"}
						aria-label={archived ? "取消归档" : "归档会话"}
						onClick={async () => {
							setBusy(true);
							await store.archiveSession(session, !archived);
							setBusy(false);
						}}
					>
						{archived ? <IconArchiveRestore size={13} /> : <IconArchive size={13} />}
					</button>
				) : null}
				<button
					type="button"
					className={`session-action delete${confirm ? " confirm" : ""}`}
					disabled={busy}
					title={confirm ? undefined : "删除会话"}
					aria-label={confirm ? "确认删除会话" : "删除会话"}
					onBlur={() => setConfirm(false)}
					onMouseLeave={() => setConfirm(false)}
					onClick={async () => {
						if (!confirm) {
							setConfirm(true);
							return;
						}
						setBusy(true);
						const deleted = await store.deleteSession(session, running);
						if (!deleted) {
							setBusy(false);
							setConfirm(false);
						}
					}}
				>
					{confirm ? running ? "中止并删除" : "删除" : <IconTrash size={13} />}
				</button>
			</span>
		</div>
	);
}

type WorkspaceDropPosition = "before" | "after";

interface WorkspaceDrag {
	workspaceId?: string;
	target?: { id: string; position: WorkspaceDropPosition };
	start: (event: DragEvent<HTMLButtonElement>, workspaceId: string) => void;
	over: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void;
	drop: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void;
	end: () => void;
}

/** The header's midpoint chooses the insertion side; expanded sessions move with it. */
function workspaceDropPosition(event: DragEvent<HTMLDivElement>): WorkspaceDropPosition {
	const row = event.currentTarget.firstElementChild?.getBoundingClientRect();
	return row && event.clientY < row.top + row.height / 2 ? "before" : "after";
}

function WorkspaceGroup({
	workspace,
	onSettings,
	drag,
}: {
	workspace: WorkspaceInfo;
	onSettings: () => void;
	drag: WorkspaceDrag;
}) {
	const store = useStore();
	// Workspaces of every computer are listed together; paired computers' ones show its name.
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const revoked = useAppState((s) => !!s.nodes[node]?.revoked);
	useAppState((s) => s.peers);
	const canManage = useCanManageWorkspace(workspace.id);
	const local = node === LOCAL_NODE;
	const nodeName = store.nodeName(node);
	const expanded = useAppState((s) => !!s.expanded[workspace.id]);
	const sessions = useAppState((s) => s.sessions[workspace.id]);
	useAppState((s) => s.chatsVersion);
	const runningCount = online ? (sessions?.filter((session) => sessionActivity(store, session).active).length ?? 0) : 0;
	const selectedSessionId = useAppState((s) => s.selectedSessionId);
	const selectedWorkspaceId = useAppState((s) => s.selectedWorkspaceId);
	const newChat = useAppState((s) => !!s.newChat);
	const canArchive = useCanArchiveSessions(workspace.id);
	const [limit, setLimit] = useState(SESSION_PAGE);
	const [archivedLimit, setArchivedLimit] = useState(SESSION_PAGE);
	const [showArchived, setShowArchived] = useState(false);
	const [cleanup, setCleanup] = useState(false);
	const selected = selectedWorkspaceId === workspace.id && !selectedSessionId && !newChat;
	const current = sessions?.filter((s) => !s.archived);
	const archived = sessions?.filter((s) => s.archived) ?? [];
	// An archived session that is open keeps the archive expanded, so it stays visible.
	const archivedOpen = showArchived || archived.some((s) => s.id === selectedSessionId);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Drop target for the group; its name button also supports Alt+ArrowUp/Down.
		<div
			className={`workspace-group${drag.workspaceId === workspace.id ? " dragging" : ""}`}
			data-drop-position={drag.target?.id === workspace.id ? drag.target.position : undefined}
			onDragOver={(event) => drag.over(event, workspace.id)}
			onDrop={(event) => drag.drop(event, workspace.id)}
		>
			<div className={`workspace-row${selected ? " selected" : ""}${online ? "" : " offline"}`}>
				<button
					type="button"
					className={`chevron-button${expanded ? " open" : ""}`}
					onClick={() => store.toggleExpanded(workspace.id)}
					title={expanded ? "收起" : "展开"}
					aria-label={`${expanded ? "收起" : "展开"}「${workspace.name}」`}
					aria-expanded={expanded}
				>
					<IconChevronRight size={14} />
				</button>
				<button
					type="button"
					className="workspace-name"
					title={`${local ? workspace.path : `${nodeName}：${workspace.path}`}\n拖动调整顺序 · Alt+↑/↓`}
					draggable
					onDragStart={(event) => drag.start(event, workspace.id)}
					onDragEnd={drag.end}
					aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
					onKeyDown={(event) => {
						if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
						event.preventDefault();
						const workspaces = store.getState().workspaces;
						const up = event.key === "ArrowUp";
						const target = workspaces[workspaces.findIndex((w) => w.id === workspace.id) + (up ? -1 : 1)];
						if (target) store.moveWorkspace(workspace.id, target.id, up ? "before" : "after");
					}}
					onClick={() => store.selectWorkspace(workspace.id)}
				>
					<IconFolder size={15} className="workspace-icon" />
					<span className="workspace-label">{workspace.name}</span>
					{workspace.policy !== "smart" ? (
						<span className={`policy-tag ${workspace.policy}`}>{POLICY_LABEL[workspace.policy]}</span>
					) : null}
					{local ? null : (
						<span
							className={`workspace-node${online ? "" : " offline"}`}
							title={online ? `在 ${nodeName} 上` : revoked ? `${nodeName} 已移除这台电脑` : `${nodeName} 未连接`}
						>
							<IconMonitor size={11} />
							<span className="workspace-node-name">{nodeName}</span>
						</span>
					)}
				</button>
				{runningCount ? (
					<span className="running-count workspace-running-count" title={`${runningCount} 个 Agent 正在运行或等待处理`}>
						<span className="badge-dot running" aria-hidden="true" />
						{runningCount}
					</span>
				) : null}
				<div className="workspace-actions">
					{canArchive && online && sessions?.length ? (
						<button type="button" className="ghost icon" title="清理会话…" onClick={() => setCleanup(true)}>
							<IconBroom size={14} />
						</button>
					) : null}
					{canManage && online ? (
						<button type="button" className="ghost icon" title="工作区设置" onClick={onSettings}>
							<IconSettings size={14} />
						</button>
					) : null}
					<button
						type="button"
						className="ghost icon"
						title={`在「${workspace.name}」中新建会话`}
						onClick={() => store.startNewChat(workspace.id)}
					>
						<IconPlus size={15} />
					</button>
				</div>
			</div>
			{expanded ? (
				<div className="session-list">
					{!sessions ? (
						<div className="session-empty">{online || local ? "加载中…" : `${nodeName} 未连接，连接后显示会话`}</div>
					) : null}
					{sessions && !sessions.length ? <div className="session-empty">还没有会话</div> : null}
					{sessions?.length && !current?.length ? <div className="session-empty">没有未归档的会话</div> : null}
					{current?.slice(0, limit).map((session) => (
						<SessionItem
							key={session.id}
							session={session}
							selected={session.id === selectedSessionId}
							canArchive={canArchive}
						/>
					))}
					{current && current.length > limit ? (
						<button type="button" className="session-more" onClick={() => setLimit(limit + SESSION_PAGE)}>
							显示更多（还有 {current.length - limit} 个）
						</button>
					) : null}
					{archived.length ? (
						<>
							<button
								type="button"
								className={`session-archived-toggle${archivedOpen ? " open" : ""}`}
								onClick={() => setShowArchived(!archivedOpen)}
								aria-expanded={archivedOpen}
							>
								<IconChevronRight size={12} />
								<IconArchive size={12} />
								<span>已归档（{archived.length}）</span>
							</button>
							{archivedOpen ? (
								<div className="session-archived-list">
									{archived.slice(0, archivedLimit).map((session) => (
										<SessionItem
											key={session.id}
											session={session}
											selected={session.id === selectedSessionId}
											canArchive={canArchive}
										/>
									))}
									{archived.length > archivedLimit ? (
										<button
											type="button"
											className="session-more"
											onClick={() => setArchivedLimit(archivedLimit + SESSION_PAGE)}
										>
											显示更多（还有 {archived.length - archivedLimit} 个）
										</button>
									) : null}
								</div>
							) : null}
						</>
					) : null}
				</div>
			) : null}
			{cleanup ? <SessionCleanupDialog workspace={workspace} onClose={() => setCleanup(false)} /> : null}
		</div>
	);
}

export function WorkspaceSettings({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
	const store = useStore();
	const [confirmRemove, setConfirmRemove] = useState(false);
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? LOCAL_NODE);
	return (
		<Modal title={`工作区设置 · ${workspace.name}`} onClose={onClose}>
			<div className="field">
				<div className="field-label">目录</div>
				<code className="path">{workspace.path}</code>
				{node === LOCAL_NODE ? null : (
					<div className="muted small">在 {store.nodeName(node)} 上，Agent 在那台电脑上运行</div>
				)}
			</div>
			<div className="field">
				<div className="field-label">工具审批策略</div>
				{(["ask", "smart", "auto"] as ApprovalPolicy[]).map((policy) => (
					<label key={policy} className={`policy-option${workspace.policy === policy ? " selected" : ""}`}>
						<input
							type="radio"
							name="policy"
							checked={workspace.policy === policy}
							onChange={() => void store.setPolicy(workspace.id, policy)}
						/>
						<div>
							<div className="policy-title">
								{POLICY_LABEL[policy]}
								{policy === "smart" ? <span className="muted">（默认）</span> : null}
							</div>
							<div className={`muted${policy === "auto" ? " warning-text" : ""}`}>{POLICY_DESCRIPTION[policy]}</div>
						</div>
					</label>
				))}
				<p className="muted small">
					危险命令（rm -r、sudo、git push --force 等）在“逐项审批”和“智能”策略下总是需要批准。
				</p>
			</div>
			<div className="modal-actions spread">
				<button
					type="button"
					className="danger"
					onClick={() => {
						if (!confirmRemove) {
							setConfirmRemove(true);
							return;
						}
						onClose();
						void store.removeWorkspace(workspace.id);
					}}
				>
					{confirmRemove ? "再次点击确认移除（不会删除任何文件）" : "从 Pier 移除工作区"}
				</button>
				<button type="button" className="primary" onClick={onClose}>
					完成
				</button>
			</div>
		</Modal>
	);
}

export function Sidebar({ open = true }: { open?: boolean }) {
	const store = useStore();
	const workspaces = useAppState((s) => s.workspaces);
	const addWorkspace = useAddWorkspace();
	const [settingsFor, setSettingsFor] = useState<string | undefined>();
	const [draggingWorkspace, setDraggingWorkspace] = useState<string>();
	const [dropTarget, setDropTarget] = useState<WorkspaceDrag["target"]>();
	const endDrag = () => {
		setDraggingWorkspace(undefined);
		setDropTarget(undefined);
	};
	const drag: WorkspaceDrag = {
		workspaceId: draggingWorkspace,
		target: dropTarget,
		start: (event, workspaceId) => {
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("application/x-pier-workspace", workspaceId);
			setDraggingWorkspace(workspaceId);
		},
		over: (event, id) => {
			if (!draggingWorkspace) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			const position = workspaceDropPosition(event);
			setDropTarget((target) =>
				id === draggingWorkspace
					? undefined
					: target?.id === id && target.position === position
						? target
						: { id, position },
			);
		},
		drop: (event, id) => {
			if (!draggingWorkspace) return;
			event.preventDefault();
			store.moveWorkspace(draggingWorkspace, id, workspaceDropPosition(event));
			endDrag();
		},
		end: endDrag,
	};
	// The source can disappear when another device removes a workspace during the drag.
	useEffect(() => {
		if (draggingWorkspace && !workspaces.some((workspace) => workspace.id === draggingWorkspace)) {
			setDraggingWorkspace(undefined);
			setDropTarget(undefined);
		}
	}, [draggingWorkspace, workspaces]);
	const settingsWorkspace = workspaces.find((w) => w.id === settingsFor);
	// Collapsing the sidebar dismisses its workspace-settings dialog instead of hiding it.
	useEffect(() => {
		if (!open) {
			setSettingsFor(undefined);
			setDraggingWorkspace(undefined);
			setDropTarget(undefined);
		}
	}, [open]);
	const newChat = useAppState((s) => !!s.newChat);
	const status = useHostStatus();
	const online = status.online;

	return (
		<aside id="workspace-sidebar" className="sidebar">
			<div className="brand">
				<span className="brand-name">Pier</span>
				<button
					type="button"
					className="ghost icon sidebar-collapse"
					title={`收起侧边栏（${SIDEBAR_SHORTCUT}）`}
					aria-label="收起侧边栏"
					onClick={() => store.toggleSidebar(false)}
				>
					<IconPanelLeft size={16} />
				</button>
			</div>
			<div className="sidebar-actions">
				<button
					type="button"
					className={`new-session-button${newChat ? " selected" : ""}`}
					disabled={!online}
					title="新建会话：选择工作区后发送第一条消息"
					onClick={() => store.startNewChat()}
				>
					<IconSquarePen size={17} />
					<span>新建会话</span>
				</button>
			</div>
			<RunningAgents />
			<div className="sidebar-section-title">
				<span>工作区</span>
				{online ? <AddWorkspaceButton /> : null}
			</div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Drag-leave only clears the visual insertion marker. */}
			<div
				className="workspace-list"
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined);
				}}
			>
				{workspaces.map((workspace) => (
					<WorkspaceGroup
						key={workspace.id}
						workspace={workspace}
						onSettings={() => setSettingsFor(workspace.id)}
						drag={drag}
					/>
				))}
				{online && !workspaces.length ? (
					<button type="button" className="add-first" onClick={() => void addWorkspace()}>
						<IconFolderPlus size={16} />
						添加第一个工作区
					</button>
				) : null}
			</div>
			{settingsWorkspace ? (
				<WorkspaceSettings workspace={settingsWorkspace} onClose={() => setSettingsFor(undefined)} />
			) : null}
		</aside>
	);
}
