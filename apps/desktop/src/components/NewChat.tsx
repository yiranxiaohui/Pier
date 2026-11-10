import { agentRuntimeLabel, appendDictation, parseSlash } from "@pier/chat-state";
import type { AgentRuntimeInfo, WorkspaceInfo } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { draftToPrompt } from "../lib/composer-text.ts";
import { type Draft, LOCAL_NODE, NEW_CHAT_DRAFT, useAppState, useComputers, useStore } from "../lib/store.tsx";
import { useVoiceInput } from "../lib/use-voice-input.ts";
import { AgentIcon } from "./AgentIcons.tsx";
import { readImages, useComposerInsert } from "./Composer.tsx";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput.tsx";
import { useNodeStatus } from "./HostPanels.tsx";
import {
	IconArrowUp,
	IconBraces,
	IconCheck,
	IconChevronUp,
	IconFolder,
	IconFolderPlus,
	IconImage,
	IconLoader,
	IconMonitor,
	IconSearch,
	IconWrench,
	IconX,
	PierWordmark,
} from "./Icons.tsx";
import { NewChatModelPicker } from "./ModelPicker.tsx";
import { NoModelsBanner } from "./ModelsPanel.tsx";
import { useNewChatRuntimes, useNewChatSlashMenu } from "./NewChatSlashMenu.ts";
import { PolicyPicker, useOutsideClick } from "./SessionControls.tsx";
import { AddWorkspaceItems, useAddWorkspace } from "./Sidebar.tsx";
import { SlashMenu, type SlashMenuEntry } from "./SlashMenu.tsx";
import { VoiceControls } from "./VoiceControls.tsx";
import { WorkbenchHeader } from "./WorkbenchHeader.tsx";

const STARTERS = [
	{
		icon: IconBraces,
		title: "了解这个项目",
		description: "梳理结构与关键模块",
		prompt: "帮我梳理这个项目的目录结构、技术栈和关键模块，介绍从哪里开始阅读代码。",
	},
	{
		icon: IconWrench,
		title: "排查一个问题",
		description: "定位原因，找到解决方案",
		prompt: "帮我排查一个问题，请先了解项目并询问具体的错误现象，再一起定位原因。",
	},
	{
		icon: IconSearch,
		title: "审查代码",
		description: "发现风险与改进机会",
		prompt: "请审查当前工作区的代码更改，重点关注潜在缺陷、边界情况和测试覆盖，并给出具体建议。",
	},
];

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
function AgentPicker({
	workspace,
	disabled,
	runtimes,
}: {
	workspace: WorkspaceInfo;
	disabled?: boolean;
	runtimes: AgentRuntimeInfo[];
}) {
	const store = useStore();
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? LOCAL_NODE);
	const runtime = useAppState((s) => s.newChatRuntime[node] ?? "pi");
	const [open, setOpen] = useState(false);
	const ref = useOutsideClick(open, () => setOpen(false));

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
	const voice = useVoiceInput(
		workspaceId ?? "new-chat",
		(text) => setDraft((draft) => ({ ...draft, text: appendDictation(draft.text, text) })),
		sending,
	);
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

	const prompt = draftToPrompt(draft.text);
	const runtimes = useNewChatRuntimes(workspaceId);
	const menu = useNewChatSlashMenu(workspaceId, prompt, runtimes);
	const hasContent = prompt.trim().length > 0 || draft.images.length > 0;
	const canSend = !voice.busy && online && !!workspace && !sending && hasContent;

	async function send(override?: string) {
		if (!canSend) return;
		const text = (override ?? draft.text).trim();
		const command = parseSlash(draftToPrompt(text));
		if (
			command &&
			(command.name === "new" || command.name === "clear") &&
			menu.list.commands.some((entry) => entry.name === command.name && entry.source === "builtin")
		) {
			// Already on the new-chat screen: clear the text without leaving an empty session.
			setDraft((d) => ({ ...d, text: "" }));
			input.current?.focus();
			return;
		}
		setSending(true);
		const created = await store.sendNewChat({ ...draft, text });
		// On success this view unmounts (the new session opens and sends the draft itself).
		if (!created) {
			setSending(false);
			input.current?.focus();
		}
	}

	function pick(entry: SlashMenuEntry, tab = false) {
		const next = entry.pick(tab);
		if (next.run) void send(next.text);
		else setDraft((d) => ({ ...d, text: next.text }));
		input.current?.focus();
	}

	async function addFiles(files: Iterable<File>) {
		const images = await readImages(files, (m) => store.toast("warning", m));
		if (images.length) setDraft((d) => ({ ...d, images: [...d.images, ...images].slice(0, 16) }));
	}

	return (
		<div className="workbench-page-shell">
			<WorkbenchHeader workspace={workspace} title="新建会话" />
			<div className="new-chat">
				<div className="new-chat-hero">
					<PierWordmark height={48} className="new-chat-symbol" />
					{workspace ? (
						<h1>
							让想法，<span className="new-chat-title-secondary">从这里开始。</span>
						</h1>
					) : (
						<h1>
							选一个工作区，<span className="new-chat-title-secondary">开始新的构建。</span>
						</h1>
					)}
					<p className="muted">
						{workspace
							? node && node !== LOCAL_NODE
								? `在 ${store.nodeName(node)} 的 ${workspace.name} 中，与 Agent 一起推进工作。`
								: `在 ${workspace.name} 中，把想法交给 Agent，一起推进工作。`
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
						<SlashMenu menu={menu} onPick={(entry) => pick(entry)} />
						<ComposerInput
							ref={input}
							value={draft.text}
							disabled={sending}
							placeholder={
								workspace ? "描述你的任务，也可以粘贴图片或输入 / 使用命令…" : "先选择工作区，再描述你的任务…"
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
								if (menu.open) {
									const entry = menu.entries[menu.active];
									if (e.key === "ArrowDown" || e.key === "ArrowUp") {
										if (menu.entries.length) {
											e.preventDefault();
											menu.move(e.key === "ArrowDown" ? 1 : -1);
										}
										return;
									}
									if (e.key === "Escape") {
										e.preventDefault();
										menu.dismiss();
										return;
									}
									if (entry && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.altKey))) {
										e.preventDefault();
										pick(entry, e.key === "Tab");
										return;
									}
								}
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									void send();
								}
							}}
						/>
						<div className="composer-toolbar">
							<div className="composer-toolbar-left">
								<VoiceControls voice={voice} disabled={sending} />
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
								{workspace ? (
									<AgentPicker workspace={workspace} disabled={sending || !online} runtimes={runtimes} />
								) : null}
								{workspace ? <PolicyPicker workspace={workspace} /> : null}
							</div>
							<div className="composer-actions">
								{workspace ? (
									<NewChatModelPicker workspace={workspace} runtimes={runtimes} disabled={sending || !online} />
								) : null}
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
					{workspace ? (
						<section className="prompt-starters" aria-label="任务灵感">
							{STARTERS.map((starter) => (
								<button
									type="button"
									className="prompt-starter"
									key={starter.title}
									disabled={hasContent || sending || voice.busy}
									title={hasContent ? "清空当前草稿后可使用任务灵感" : starter.prompt}
									onClick={() => {
										setDraft((current) => ({ ...current, text: starter.prompt }));
										input.current?.focus();
									}}
								>
									<starter.icon size={17} />
									<span>
										<strong>{starter.title}</strong>
										<small>{starter.description}</small>
									</span>
								</button>
							))}
						</section>
					) : null}
					<div className="new-chat-hint">
						<span>
							<kbd>Enter</kbd> 发送
						</span>
						<span>
							<kbd>Shift + Enter</kbd> 换行
						</span>
						<span>
							<kbd>/</kbd> 命令
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
