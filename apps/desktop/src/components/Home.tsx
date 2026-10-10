import { POLICY_LABEL, relativeTime, sessionTitle } from "../lib/format.ts";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { BrowserButton } from "./BrowserPanel.tsx";
import { FilesPanelToggle } from "./FilesPanel.tsx";
import {
	IconChevronRight,
	IconFolder,
	IconFolderPlus,
	IconMessage,
	IconMessagePlus,
	IconMonitor,
	IconShield,
	IconSparkles,
	Logo,
} from "./Icons.tsx";
import { NoModelsBanner } from "./ModelsPanel.tsx";
import { SidebarToggle, useAddWorkspace } from "./Sidebar.tsx";
import { TerminalToggle } from "./TerminalPanel.tsx";

const STEPS = [
	{ icon: IconFolder, title: "添加工作区", text: "选择一个项目目录，Agent 只在其中读写文件、运行命令。" },
	{ icon: IconSparkles, title: "描述任务", text: "新建会话，用自然语言告诉 Agent 你想做什么。" },
	{ icon: IconShield, title: "审批操作", text: "执行命令或修改工作区外的文件前，Pier 会先征求你的同意。" },
];

export function Welcome() {
	const store = useStore();
	const addWorkspace = useAddWorkspace();
	const providers = useAppState((s) => s.localProviders);
	return (
		<div className="home">
			<SidebarToggle floating />
			<div className="home-inner">
				<div className="hero">
					<Logo size={56} />
					<h1>欢迎使用 Pier</h1>
					<p className="hero-text">
						编码 Agent 的跨设备工作台。统一使用 pi、Claude Code 与 Codex，管理多台电脑上的工作区与会话。 Agent
						常驻在电脑上运行，你可以从桌面端或手机端查看进度、发送指令和审批操作。
					</p>
				</div>
				<div className="steps">
					{STEPS.map((step, i) => (
						<div key={step.title} className="step-card">
							<div className="step-icon">
								<step.icon size={18} />
							</div>
							<div className="step-index">0{i + 1}</div>
							<div className="step-title">{step.title}</div>
							<div className="step-text">{step.text}</div>
						</div>
					))}
				</div>
				<NoModelsBanner />
				<div className="hero-actions">
					<button type="button" className="primary large" onClick={() => void addWorkspace()}>
						<IconFolderPlus size={17} />
						添加工作区
					</button>
				</div>
				{providers && providers.availableCount > 0 ? (
					<p className="muted small hero-note">
						已有 {providers.availableCount} 个可用模型
						{providers.defaultModel ? `，默认使用 ${providers.defaultModel.modelId}` : ""}。
						<button type="button" className="ghost link-button" onClick={() => store.openModels(LOCAL_NODE)}>
							管理模型与服务商
						</button>
					</p>
				) : null}
			</div>
		</div>
	);
}

export function WorkspaceHome({ workspaceId }: { workspaceId: string }) {
	const store = useStore();
	const workspace = useAppState((s) => s.workspaces).find((w) => w.id === workspaceId);
	const sessions = useAppState((s) => s.sessions[workspaceId]);
	const node = useAppState((s) => s.workspaceNodes[workspaceId] ?? LOCAL_NODE);
	const nodeOnline = useAppState((s) => node === LOCAL_NODE || s.nodes[node]?.connection === "open");
	useAppState((s) => s.peers);
	if (!workspace) return null;
	// Archived sessions are only listed in the sidebar's archive.
	const recent = sessions?.filter((s) => !s.archived);
	const archivedCount = (sessions?.length ?? 0) - (recent?.length ?? 0);
	return (
		<div className="home">
			<SidebarToggle floating />
			<div className="home-toolbar">
				<BrowserButton workspace={workspace} />
				<TerminalToggle workspace={workspace} />
				<FilesPanelToggle />
			</div>
			<div className="home-inner">
				<div className="workspace-hero">
					<div className="workspace-hero-icon">
						<IconFolder size={26} />
					</div>
					<div className="workspace-hero-text">
						<h1>{workspace.name}</h1>
						<div className="workspace-meta">
							{node === LOCAL_NODE ? null : (
								<span className="pill node-pill" title="Agent 在这台电脑上运行">
									<IconMonitor size={12} />
									{store.nodeName(node)}
								</span>
							)}
							<code title={workspace.path}>{workspace.path}</code>
							<span className={`pill policy-pill ${workspace.policy}`}>
								<IconShield size={12} />
								{POLICY_LABEL[workspace.policy]}
							</span>
						</div>
					</div>
					<button type="button" className="primary large" onClick={() => store.startNewChat(workspace.id)}>
						<IconMessagePlus size={17} />
						新建会话
					</button>
				</div>
				<NoModelsBanner />
				<div className="recent">
					<div className="section-heading">
						<h3>最近的会话</h3>
						{sessions?.length ? (
							<span className="muted small">
								共 {recent?.length ?? 0} 个{archivedCount ? `，另有 ${archivedCount} 个已归档` : ""}
							</span>
						) : null}
					</div>
					{!sessions ? (
						<div className="recent-empty">
							{nodeOnline ? "加载中…" : `${store.nodeName(node)} 未连接，连接后显示会话`}
						</div>
					) : null}
					{sessions?.length && !recent?.length ? (
						<div className="recent-empty">
							<IconMessage size={22} />
							<span>会话都已归档，可以在侧边栏的「已归档」中找到。</span>
						</div>
					) : null}
					{sessions && !sessions.length ? (
						<div className="recent-empty">
							<IconMessage size={22} />
							<span>还没有会话，点击「新建会话」开始第一个任务。</span>
						</div>
					) : null}
					{recent?.length ? (
						<div className="recent-list">
							{recent.slice(0, 10).map((session) => (
								<button
									type="button"
									key={session.id}
									className="recent-row"
									onClick={() => store.selectSession(session)}
								>
									<span className="recent-icon">
										<IconMessage size={15} />
									</span>
									<span className="recent-title">{sessionTitle(session)}</span>
									<span className="recent-meta">
										{session.messageCount} 条消息 · {relativeTime(session.modifiedAt)}
									</span>
									<IconChevronRight size={15} className="recent-chevron" />
								</button>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
