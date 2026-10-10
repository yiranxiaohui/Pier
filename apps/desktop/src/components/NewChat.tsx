import { agentRuntimeLabel } from "@pier/chat-state";
import type { AgentRuntimeInfo, WorkspaceInfo } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { draftToPrompt } from "../lib/composer-text.ts";
import { type Draft, LOCAL_NODE, NEW_CHAT_DRAFT, useAppState, useComputers, useStore } from "../lib/store.tsx";
import { AgentIcon } from "./AgentIcons.tsx";
import { BrowserButton } from "./BrowserPanel.tsx";
import { readImages, useComposerInsert } from "./Composer.tsx";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput.tsx";
import { FilesPanelToggle } from "./FilesPanel.tsx";
import { useNodeStatus } from "./HostPanels.tsx";
import {
	IconArrowUp,
	IconCheck,
	IconChevronUp,
	IconFolder,
	IconFolderPlus,
	IconImage,
	IconLoader,
	IconMonitor,
	IconX,
	Logo,
} from "./Icons.tsx";
import { NewChatModelPicker } from "./ModelPicker.tsx";
import { NoModelsBanner } from "./ModelsPanel.tsx";
import { PolicyPicker, useOutsideClick } from "./SessionControls.tsx";
import { AddWorkspaceItems, SidebarToggle, useAddWorkspace } from "./Sidebar.tsx";
import { TerminalToggle } from "./TerminalPanel.tsx";

/** Chip that picks the workspace (on any computer) the new chat will be created in. */
function WorkspacePicker({ workspace, disabled }: { workspace?: WorkspaceInfo; disabled?: boolean }) {
	const store = useStore();
	const computers = useComputers();
	const hasPeers = computers.length > 1;
	const workspaceNode = useAppState((s) => (workspace ? s.workspaceNodes[workspace.id] : undefined));
	const workspaceCount = useAppState((s) => s.workspaces.length);
	const addWorkspace = useAddWorkspace();
	const [open, setOpen] = useState(false);
	const [adding, setAdding] = useState(false);
	const ref = useOutsideClick(open, () => setOpen(false));
	const close = () => {
		setOpen(false);
		setAdding(false);
	};
	const item = (w: WorkspaceInfo) => {
		const selected = w.id === workspace?.id;
		return (
			<button
				type="button"
				key={w.id}
				className={`dropdown-item${selected ? " selected" : ""}`}
				title={w.path}
				onClick={() => {
					close();
					store.setNewChatWorkspace(w.id);
				}}
			>
				<span className="workspace-item-text">
					<span className="workspace-item-name">
						<IconFolder size={14} />
						{w.name}
					</span>
					<span className="muted">{w.path}</span>
				</span>
				{selected ? <IconCheck size={15} className="policy-check" /> : null}
			</button>
		);
	};
	const nodeLabel =
		workspace && workspaceNode && workspaceNode !== LOCAL_NODE ? store.nodeName(workspaceNode) : undefined;
	return (
		<div className="dropdown" ref={ref}>
			<button
				type="button"
				className={`chip workspace-chip${workspace ? "" : " empty"}`}
				disabled={disabled}
				onClick={() => (open ? close() : setOpen(true))}
				title={
					workspace
						? `在「${nodeLabel ? `${nodeLabel}：` : ""}${workspace.path}」中对话，点击更换工作区`
						: "选择这个对话所在的工作区"
				}
			>
				<IconFolder size={14} />
				<span className="workspace-chip-name">{workspace ? workspace.name : "选择工作区"}</span>
				{nodeLabel ? <span className="workspace-chip-node">{nodeLabel}</span> : null}
				<IconChevronUp size={13} className="chip-caret" />
			</button>
			{open ? (
				<div className="dropdown-menu up workspaces">
					{adding ? (
						<AddWorkspaceItems onDone={close} />
					) : (
						<>
							<div className="dropdown-group-title no-caps">在哪个工作区中对话？</div>
							{hasPeers
								? computers.map((computer) =>
										computer.state.workspaces.length ? (
											<div key={computer.id} className="workspace-picker-group">
												<div className="dropdown-group-title no-caps workspace-picker-node">
													<IconMonitor size={12} />
													{computer.name}
													{computer.local ? <span className="muted">本机</span> : null}
													{computer.online ? null : <span className="muted">未连接</span>}
												</div>
												{computer.state.workspaces.map(item)}
											</div>
										) : null,
									)
								: computers[0]?.state.workspaces.map(item)}
							{workspaceCount ? <div className="dropdown-separator" /> : null}
							<button
								type="button"
								className="dropdown-item"
								onClick={() => {
									if (hasPeers) {
										setAdding(true);
										return;
									}
									close();
									void addWorkspace();
								}}
							>
								<span className="menu-label">
									<IconFolderPlus size={14} />
									添加工作区…
								</span>
							</button>
						</>
					)}
				</div>
			) : null}
		</div>
	);
}

/**
 * Chip that picks the agent (pi, Claude Code, Codex) the new chat runs on. Shown when the
 * workspace's computer can run another agent than pi.
 */
function AgentPicker({ workspace, disabled }: { workspace: WorkspaceInfo; disabled?: boolean }) {
	const store = useStore();
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const hostInfo = useAppState((s) => s.nodes[node]?.hostInfo);
	const runtime = useAppState((s) => s.newChatRuntime[node] ?? "pi");
	const installationVersion = useAppState((s) => s.agentConfigVersion);
	const [runtimes, setRuntimes] = useState<AgentRuntimeInfo[]>([]);
	const [open, setOpen] = useState(false);
	const ref = useOutsideClick(open, () => setOpen(false));

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the computer (re)connects.
	useEffect(() => {
		if (!online) return;
		let live = true;
		store
			.listRuntimes(workspace.id)
			.then((list) => {
				if (live) setRuntimes(list);
			})
			.catch(() => {
				if (live) setRuntimes([]);
			});
		return () => {
			live = false;
		};
	}, [store, workspace.id, online, hostInfo, installationVersion]);

	const current = runtimes.find((r) => r.id === runtime);
	// A runtime that went away (CLI uninstalled, older host) falls back to pi.
	useEffect(() => {
		if (runtime !== "pi" && runtimes.length && !current?.available) store.setNewChatRuntime(workspace.id, "pi");
	}, [runtime, runtimes, current, store, workspace.id]);

	if (!runtimes.some((r) => r.id !== "pi" && r.available)) return null;
	return (
		<div className="dropdown" ref={ref}>
			<button
				type="button"
				className="chip agent-chip"
				disabled={disabled}
				onClick={() => setOpen(!open)}
				title="选择运行这个对话的 Agent"
			>
				<AgentIcon runtime={runtime} size={14} />
				<span>{agentRuntimeLabel(runtime)}</span>
				<IconChevronUp size={13} className="chip-caret" />
			</button>
			{open ? (
				<div className="dropdown-menu up agents">
					<div className="dropdown-group-title no-caps">由哪个 Agent 来做？</div>
					{runtimes.map((r) => {
						const selected = r.id === runtime;
						return (
							<button
								type="button"
								key={r.id}
								className={`dropdown-item${selected ? " selected" : ""}`}
								disabled={!r.available && r.id !== "claude-code" && r.id !== "codex"}
								title={r.available ? (r.executable ?? r.name) : r.reason}
								onClick={() => {
									setOpen(false);
									if (!r.available && (r.id === "claude-code" || r.id === "codex")) {
										store.openSettings(r.id === "codex" ? "codex" : "claude", node);
										return;
									}
									store.setNewChatRuntime(workspace.id, r.id);
								}}
							>
								<span className="workspace-item-text">
									<span className="workspace-item-name">
										<AgentIcon runtime={r.id} size={14} />
										{r.name}
										{r.version ? <span className="mini-tag">{r.version}</span> : null}
										{!r.available && (r.id === "claude-code" || r.id === "codex") ? (
											<span className="mini-tag">安装</span>
										) : null}
									</span>
									<span className="muted">{r.available ? agentDescription(r.id) : (r.reason ?? "不可用")}</span>
								</span>
								{selected ? <IconCheck size={15} className="policy-check" /> : null}
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

function agentDescription(id: string): string {
	switch (id) {
		case "pi":
			return "Pier 内置的 pi，使用在 Pier 中配置的模型与扩展";
		case "claude-code":
			return "这台电脑上安装的 Claude Code，使用它自己的登录与配置";
		case "codex":
			return "这台电脑上安装的 Codex，使用它自己的登录与配置";
		default:
			return "";
	}
}

/**
 * The blank screen opened by "新建会话": pick a workspace, write the first message, and send it.
 * Only then is the session created, after which the view switches to that session.
 */
export function NewChatView({ workspaceId }: { workspaceId?: string }) {
	const store = useStore();
	const workspaces = useAppState((s) => s.workspaces);
	const workspace = workspaces.find((w) => w.id === workspaceId);
	const node = useAppState((s) => (workspaceId ? s.workspaceNodes[workspaceId] : undefined));
	const online = useNodeStatus().online;
	const [draft, setDraft] = useState<Draft>(() => store.draft(NEW_CHAT_DRAFT));
	const [sending, setSending] = useState(false);
	const [dragging, setDragging] = useState(false);
	const input = useRef<ComposerInputHandle>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refocus whenever the target changes.
	useEffect(() => {
		input.current?.focus();
	}, [workspaceId]);

	useEffect(() => {
		store.saveDraft(NEW_CHAT_DRAFT, draft);
	}, [store, draft]);

	useComposerInsert(NEW_CHAT_DRAFT, input);

	const hasContent = draftToPrompt(draft.text).trim().length > 0 || draft.images.length > 0;
	const canSend = online && !!workspace && !sending && hasContent;

	async function send() {
		if (!canSend) return;
		setSending(true);
		const created = await store.sendNewChat({ ...draft, text: draft.text.trim() });
		// On success this view unmounts (the new session opens and sends the draft itself).
		if (!created) {
			setSending(false);
			input.current?.focus();
		}
	}

	async function addFiles(files: Iterable<File>) {
		const images = await readImages(files, (m) => store.toast("warning", m));
		if (images.length) setDraft((d) => ({ ...d, images: [...d.images, ...images].slice(0, 16) }));
	}

	return (
		<div className="new-chat">
			<SidebarToggle floating />
			{workspace ? (
				<div className="home-toolbar">
					<BrowserButton workspace={workspace} />
					<TerminalToggle workspace={workspace} />
					<FilesPanelToggle />
				</div>
			) : null}
			<div className="new-chat-hero">
				<Logo size={44} />
				{workspace ? (
					<h1>
						我们应该在<span className="new-chat-target">{workspace.name}</span>中做些什么？
					</h1>
				) : (
					<h1>选择一个工作区，开始新的对话</h1>
				)}
				<p className="muted">
					{workspace
						? node && node !== LOCAL_NODE
							? `这个工作区在 ${store.nodeName(node)} 上：发送第一条消息后会在那里创建会话，Agent 只在其中读写文件、运行命令。`
							: "发送第一条消息后会在这个工作区中创建会话，Agent 只在其中读写文件、运行命令。"
						: workspaces.length
							? "在输入框下方选择对话所在的工作区。"
							: "先添加一个项目目录作为工作区。"}
				</p>
				<div className="new-chat-banner">
					<NoModelsBanner />
				</div>
			</div>
			<div className="session-bottom new-chat-bottom">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for pasted/dragged images. */}
				<div
					className={`composer${dragging ? " dragging" : ""}`}
					onDragOver={(e) => {
						if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) {
							e.preventDefault();
							setDragging(true);
						}
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragging(false);
						void addFiles(e.dataTransfer.files);
					}}
				>
					{draft.images.length ? (
						<div className="composer-images">
							{draft.images.map((image, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: positional attachments.
								<div key={i} className="composer-image">
									<img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
									<button
										type="button"
										title="移除"
										onClick={() => setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))}
									>
										<IconX size={11} />
									</button>
								</div>
							))}
						</div>
					) : null}
					<ComposerInput
						ref={input}
						value={draft.text}
						disabled={sending}
						placeholder={
							workspace
								? `在「${workspace.name}」中描述你的任务…（Enter 发送，Shift+Enter 换行）`
								: "先选择工作区，再描述你的任务…"
						}
						onChange={(text) => setDraft((d) => ({ ...d, text }))}
						onOpenFile={(path) => {
							if (workspace) store.openFilePreview(workspace.id, path);
						}}
						onPaste={(e) => {
							const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
							if (files.length) {
								e.preventDefault();
								void addFiles(files);
							}
						}}
						onKeyDown={(e) => {
							if (e.nativeEvent.isComposing || e.keyCode === 229) return;
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void send();
							}
						}}
					/>
					<div className="composer-toolbar">
						<div className="composer-toolbar-left">
							<button
								type="button"
								className="ghost icon composer-attach"
								title="添加图片（也可以粘贴或拖入）"
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
								onChange={(e) => {
									const files = [...(e.target.files ?? [])];
									e.target.value = "";
									void addFiles(files);
								}}
							/>
							<WorkspacePicker workspace={workspace} disabled={sending} />
							{workspace ? <AgentPicker workspace={workspace} disabled={sending || !online} /> : null}
							{workspace ? <PolicyPicker workspace={workspace} /> : null}
						</div>
						<div className="composer-actions">
							{workspace ? <NewChatModelPicker workspace={workspace} disabled={sending || !online} /> : null}
							<button
								type="button"
								className="round-button send"
								disabled={!canSend}
								onClick={() => void send()}
								title={workspace ? "发送并创建会话（Enter）" : "请先选择工作区"}
							>
								{sending ? <IconLoader size={16} className="spin" /> : <IconArrowUp size={17} />}
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
