import type { WorkspaceInfo } from "@pier/protocol";
import { type CSSProperties, useEffect, useState } from "react";
import { DirectoryPicker } from "./components/DirectoryPicker.tsx";
import { FilesPanel } from "./components/FilesPanel.tsx";
import { FilePreview } from "./components/FileViewer.tsx";
import { GitPanel } from "./components/GitPanel.tsx";
import { Welcome, WorkspaceHome } from "./components/Home.tsx";
import { HostBanner } from "./components/HostPanels.tsx";
import { IconAlert, IconInfo, IconMessage, IconX } from "./components/Icons.tsx";
import { AuthDialog } from "./components/ModelsPanel.tsx";
import { NavigationRail } from "./components/NavigationRail.tsx";
import { NewChatView } from "./components/NewChat.tsx";
import { AddPeerDialog, PairingRequestDialog } from "./components/RemotePanel.tsx";
import { ScheduledTasksPage } from "./components/ScheduledTasks.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { SettingsPage } from "./components/Settings.tsx";
import { Sidebar, SidebarToggle } from "./components/Sidebar.tsx";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { SubagentPanel } from "./components/SubagentPanel.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { useCanOpenTerminal } from "./lib/remote-terminals.ts";
import { NEW_CHAT_DRAFT, useAppState, useStore } from "./lib/store.tsx";
import { terminals, useTerminals } from "./lib/terminals.ts";

function Toasts() {
	const store = useStore();
	const toasts = useAppState((s) => s.toasts);
	if (!toasts.length) return null;
	return (
		<div className="toasts">
			{toasts.map((toast) => (
				<div key={toast.id} className={`toast ${toast.level}`}>
					<span className="toast-icon">
						{toast.level === "info" ? <IconInfo size={16} /> : <IconAlert size={16} />}
					</span>
					<span className="toast-text">{toast.message}</span>
					<button type="button" className="ghost icon" title="关闭" onClick={() => store.dismissToast(toast.id)}>
						<IconX size={14} />
					</button>
				</div>
			))}
		</div>
	);
}

function Main() {
	const store = useStore();
	const selectedSessionId = useAppState((s) => s.selectedSessionId);
	const selectedWorkspaceId = useAppState((s) => s.selectedWorkspaceId);
	const workspaces = useAppState((s) => s.workspaces);
	const workspacesLoaded = useAppState((s) => s.workspacesLoaded);
	const newChat = useAppState((s) => s.newChat);
	useAppState((s) => s.sessions);
	const session = store.findSession(selectedSessionId);

	if (session) return <SessionView key={session.id} session={session} />;
	if (!workspacesLoaded) {
		return (
			<div className="placeholder center">
				<SidebarToggle floating />
			</div>
		);
	}
	if (newChat) return <NewChatView workspaceId={newChat.workspaceId} />;
	if (!workspaces.length) return <Welcome />;
	if (selectedWorkspaceId) return <WorkspaceHome workspaceId={selectedWorkspaceId} />;
	return (
		<div className="placeholder center">
			<SidebarToggle floating />
			<div className="empty-state">
				<div className="empty-icon">
					<IconMessage size={24} />
				</div>
				<div>选择左侧的工作区或会话</div>
			</div>
		</div>
	);
}

/**
 * The workspace on screen: the open session's, else the new-chat target, else the selected
 * one (mirrors `Main`). `composerKey` is the draft key of the composer on screen, if any.
 */
function useScreenWorkspace(): { workspace?: WorkspaceInfo; composerKey?: string } {
	const store = useStore();
	const selectedSessionId = useAppState((s) => s.selectedSessionId);
	const selectedWorkspaceId = useAppState((s) => s.selectedWorkspaceId);
	const newChat = useAppState((s) => s.newChat);
	const workspaces = useAppState((s) => s.workspaces);
	useAppState((s) => s.sessions);
	const session = store.findSession(selectedSessionId);
	const workspaceId = session ? session.workspaceId : newChat ? newChat.workspaceId : selectedWorkspaceId;
	const composerKey = session ? session.id : newChat ? NEW_CHAT_DRAFT : undefined;
	const workspace = workspaces.find((w) => w.id === workspaceId);
	return { ...(workspace ? { workspace } : {}), ...(composerKey ? { composerKey } : {}) };
}

/** Matches `--sidebar-duration` in base.css, plus a little slack. */
const FILES_CLOSE_MS = 320;

function RightPanel({ workspace, composerKey }: { workspace?: WorkspaceInfo; composerKey?: string }) {
	const tab = useAppState((s) => s.rightPanelTab);
	const subagent = useAppState((s) => s.subagentView);
	if (!workspace) return null;
	if (tab === "subagent" && subagent && subagent.sessionId === composerKey) {
		return <SubagentPanel key={`${subagent.sessionId}:${subagent.subagentId}`} workspace={workspace} {...subagent} />;
	}
	if (tab === "git") {
		return <GitPanel key={workspace.id} workspace={workspace} {...(composerKey ? { composerKey } : {})} />;
	}
	return <FilesPanel key={workspace.id} workspace={workspace} {...(composerKey ? { composerKey } : {})} />;
}

export function App() {
	const store = useStore();
	const settings = useAppState((s) => s.settings);
	const scheduled = useAppState((s) => s.scheduledTasksOpen);
	const filesPanel = useAppState((s) => s.filesPanel);
	const filesPanelWidth = useAppState((s) => s.filesPanelWidth);
	const hasWorkspace = useAppState((s) => s.workspaces.length > 0);
	const sidebar = useAppState((s) => s.sidebar);
	const sidebarWidth = useAppState((s) => s.sidebarWidth);
	// Terminals run on the computer of the workspace they were opened for; the panel shows them all.
	const terminalOpen = useTerminals((s) => s.open);
	const hasTerminals = useTerminals((s) => s.tabs.length > 0);
	const screen = useScreenWorkspace();
	const screenWorkspace = screen.workspace;
	const canOpenTerminal = useCanOpenTerminal(screenWorkspace);
	const showFiles = filesPanel && hasWorkspace;
	// A subagent's conversation belongs to its session: leave it when another one is shown.
	const subagentSession = useAppState((s) => s.subagentView?.sessionId);
	useEffect(() => {
		if (subagentSession && subagentSession !== screen.composerKey) store.closeSubagent(true);
	}, [store, subagentSession, screen.composerKey]);
	// Both side panels sit in shells that animate between open and collapsed widths. The file
	// panel stays mounted only until its closing animation ends, so a hidden panel does not keep
	// reloading and closing still cancels its pending upload questions.
	const [filesMounted, setFilesMounted] = useState(showFiles);
	useEffect(() => {
		if (showFiles) {
			setFilesMounted(true);
			return;
		}
		const timer = setTimeout(() => setFilesMounted(false), FILES_CLOSE_MS);
		return () => clearTimeout(timer);
	}, [showFiles]);
	const columns = ["auto", "minmax(0, 1fr)", "auto"];

	// Ctrl/⌘+Shift+E and Ctrl/⌘+Shift+G show (or hide) the file and source control views, as in editors; Ctrl/⌘+B the sidebar;
	// Ctrl+` the terminal (Ctrl on macOS too, as in editors: ⌘+` cycles windows there).
	useEffect(() => {
		if (settings || scheduled) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "`") {
				if (!hasTerminals && !canOpenTerminal) return;
				e.preventDefault();
				terminals.toggle(screenWorkspace ? { workspace: screenWorkspace } : {});
				return;
			}
			if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
			const key = e.key.toLowerCase();
			if (e.shiftKey && (key === "e" || key === "g")) {
				e.preventDefault();
				const tab = key === "g" ? "git" : "files";
				const { filesPanel, rightPanelTab } = store.getState();
				if (filesPanel && rightPanelTab === tab) store.toggleFilesPanel(false);
				else store.showRightPanel(tab);
			} else if (!e.shiftKey && key === "b") {
				e.preventDefault();
				store.toggleSidebar();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [store, settings, scheduled, screenWorkspace, hasTerminals, canOpenTerminal]);

	return (
		<div className="window">
			<TitleBar />
			<div className="window-body">
				<NavigationRail />
				{scheduled ? (
					<ScheduledTasksPage footer={<StatusBar />} />
				) : settings ? (
					<SettingsPage section={settings} footer={<StatusBar />} />
				) : (
					<div
						className={`app with-files-shell${sidebar ? "" : " no-sidebar"}`}
						style={{ gridTemplateColumns: columns.join(" "), "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
					>
						<div className={`sidebar-shell${sidebar ? "" : " collapsed"}`} inert={!sidebar}>
							<Sidebar open={sidebar} />
							{sidebar ? <SidebarResizeHandle /> : null}
						</div>
						<main className="main">
							<HostBanner scope="node" onShowLogs={() => store.openSettings("logs")} />
							<div className="main-body">
								<Main />
							</div>
							{terminalOpen ? <TerminalPanel {...(screenWorkspace ? { workspace: screenWorkspace } : {})} /> : null}
						</main>
						<div
							className={`files-shell${showFiles ? "" : " collapsed"}`}
							style={{ "--files-width": `${filesPanelWidth}px` } as CSSProperties}
							inert={!showFiles}
						>
							{showFiles || filesMounted ? <RightPanel {...screen} /> : null}
						</div>
						<StatusBar />
					</div>
				)}
			</div>
			{settings ? null : <FilePreview />}
			<Toasts />
			<AuthDialog />
			<PairingRequestDialog />
			<AddPeerDialog />
			<DirectoryPicker />
		</div>
	);
}
