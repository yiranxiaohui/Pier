import { agentRuntimeLabel } from "@pier/chat-state";
import { POLICY_LABEL, relativeTime, sessionTitle } from "../lib/format.ts";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { AgentIcon } from "./AgentIcons.tsx";
import {
	IconArrowUp,
	IconBraces,
	IconChevronRight,
	IconFolder,
	IconFolderPlus,
	IconGitBranch,
	IconMessage,
	IconMessagePlus,
	IconMonitor,
	IconShield,
	IconSparkles,
	Logo,
} from "./Icons.tsx";
import { NoModelsBanner } from "./ModelsPanel.tsx";
import { useAddWorkspace } from "./Sidebar.tsx";
import { WorkbenchHeader } from "./WorkbenchHeader.tsx";

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
		<div className="workbench-page-shell">
			<WorkbenchHeader title="欢迎使用 Pier" />
			<div className="home welcome-home">
				<div className="home-inner">
					<div className="hero">
						<Logo size={56} />
						<div className="home-eyebrow">你的 Agent 工作台</div>
						<h1>从一个想法，开始构建。</h1>
						<p className="hero-text">
							在一个地方使用 pi、Claude Code 与 Codex。连接项目，让想法落地，再从任意设备继续。
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
		<div className="workbench-page-shell">
			<WorkbenchHeader workspace={workspace} title="概览" />
			<div className="home workspace-home">
				<div className="home-inner">
					<div className="home-eyebrow">
						<span className="eyebrow-line" />
						你的工作空间
					</div>
					<div className="workspace-hero">
						<div className="workspace-hero-icon">
							<IconFolder size={26} />
						</div>
						<div className="workspace-hero-text">
							<h1>{workspace.name}</h1>
							<div className="workspace-meta">
								<code title={workspace.path}>{workspace.path}</code>
							</div>
							<div className="workspace-badges">
								<span className="pill node-pill" title="Agent 在这台电脑上运行">
									<IconMonitor size={12} />
									{node === LOCAL_NODE ? "本机工作区" : store.nodeName(node)}
								</span>
								<span className={`pill policy-pill ${workspace.policy}`}>
									<IconShield size={12} />
									{POLICY_LABEL[workspace.policy]}
								</span>
							</div>
						</div>
						{recent?.length ? (
							<div className="workspace-session-total">
								<strong>{recent.length.toString().padStart(2, "0")}</strong>
								<span>个会话</span>
							</div>
						) : null}
					</div>
					<NoModelsBanner />
					<section className="workspace-shortcuts" aria-label="工作区快捷操作">
						<button
							type="button"
							className="workspace-shortcut featured"
							aria-label="新建会话"
							onClick={() => store.startNewChat(workspace.id)}
						>
							<span className="featured-copy">
								<span className="featured-eyebrow">
									<IconSparkles size={14} /> 下一步，从一个想法开始
								</span>
								<strong>开始你的下一次构建。</strong>
								<small>
									编写功能、排查问题，或一起打磨细节。
									<br />让 Agent 和你一起，把任务往前推进。
								</small>
								<span className="featured-action">
									<IconMessagePlus size={16} />
									新建会话
									<IconArrowUp size={15} />
								</span>
							</span>
							<span className="featured-art" aria-hidden="true">
								<IconBraces size={48} />
							</span>
						</button>
						<button type="button" className="workspace-shortcut" onClick={() => store.showRightPanel("files")}>
							<IconFolder size={20} />
							<span>
								<strong>浏览文件</strong>
								<small>查看项目目录与源码</small>
							</span>
							<IconChevronRight size={15} />
						</button>
						<button type="button" className="workspace-shortcut" onClick={() => store.showRightPanel("git")}>
							<IconGitBranch size={20} />
							<span>
								<strong>查看更改</strong>
								<small>检查差异与提交记录</small>
							</span>
							<IconChevronRight size={15} />
						</button>
					</section>
					<div className="recent">
						<div className="section-heading">
							<div>
								<h3>最近会话</h3>
								<p>从上次停下的地方继续。</p>
							</div>
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
								<strong>准备好开始第一个任务了</strong>
								<span>新建会话，描述你想实现的功能或要解决的问题。</span>
							</div>
						) : null}
						{recent?.length ? (
							<div className="recent-list">
								{recent.slice(0, 10).map((session) => (
									<button
										type="button"
										key={session.id}
										className="recent-row"
										title={sessionTitle(session, { full: true })}
										onClick={() => store.selectSession(session)}
									>
										<span className="recent-icon">
											<AgentIcon runtime={session.runtime ?? "pi"} size={18} />
										</span>
										<span className="recent-content">
											<span className="recent-title">{sessionTitle(session)}</span>
											<span className="recent-meta">
												{agentRuntimeLabel(session.runtime ?? "pi")} · {session.messageCount} 条消息
											</span>
										</span>
										<span className="recent-time">{relativeTime(session.modifiedAt)}</span>
										<IconChevronRight size={15} className="recent-chevron" />
									</button>
								))}
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
