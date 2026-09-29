import type { WorkspaceInfo } from "@pier/protocol";
import { useEffect } from "react";
import { FilesPanel } from "./components/FilesPanel.tsx";
import { FilePreview } from "./components/FileViewer.tsx";
import { Welcome, WorkspaceHome } from "./components/Home.tsx";
import { HostBanner } from "./components/HostPanels.tsx";
import { IconAlert, IconInfo, IconMessage, IconX } from "./components/Icons.tsx";
import { AuthDialog, YunlianDialog } from "./components/ModelsPanel.tsx";
import { NewChatView } from "./components/NewChat.tsx";
import { PairingRequestDialog } from "./components/RemotePanel.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { SettingsPage } from "./components/Settings.tsx";
import { Sidebar, SidebarToggle } from "./components/Sidebar.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
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

function RightPanel({ workspace, composerKey }: { workspace?: WorkspaceInfo; composerKey?: string }) {
	if (!workspace) return null;
	return <FilesPanel key={workspace.id} workspace={workspace} {...(composerKey ? { composerKey } : {})} />;
}

export function App() {
	const store = useStore();
	const settings = useAppState((s) => s.settings);
	const filesPanel = useAppState((s) => s.filesPanel);
	const filesPanelWidth = useAppState((s) => s.filesPanelWidth);
	const hasWorkspace = useAppState((s) => s.workspaces.length > 0);
	const sidebar = useAppState((s) => s.sidebar);
	const terminalOpen = useTerminals((s) => s.open);
	const screen = useScreenWorkspace();
	const screenWorkspace = screen.workspace;
	const showFiles = filesPanel && hasWorkspace;
	const columns = [...(sidebar ? ["264px"] : []), "minmax(0, 1fr)", ...(showFiles ? [`${filesPanelWidth}px`] : [])];

	// Ctrl/⌘+Shift+E toggles the file panel, like the explorer in editors; Ctrl/⌘+B the sidebar;
	// Ctrl+` the terminal (Ctrl on macOS too, as in editors: ⌘+` cycles windows there).
	useEffect(() => {
		if (settings) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "`") {
				if (!terminals.supported) return;
				e.preventDefault();
				terminals.toggle(screenWorkspace ? { workspace: screenWorkspace } : {});
				return;
			}
			if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
			const key = e.key.toLowerCase();
			if (e.shiftKey && key === "e") {
				e.preventDefault();
				store.toggleFilesPanel();
			} else if (!e.shiftKey && key === "b") {
				e.preventDefault();
				store.toggleSidebar();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [store, settings, screenWorkspace]);

	return (
		<>
			{settings ? (
				<SettingsPage section={settings} />
			) : (
				<div
					className={`app${showFiles ? " with-files" : ""}${sidebar ? "" : " no-sidebar"}`}
					style={{ gridTemplateColumns: columns.join(" ") }}
				>
					{sidebar ? <Sidebar /> : null}
					<main className="main">
						<HostBanner onShowLogs={() => store.openSettings("logs")} />
						<div className="main-body">
							<Main />
						</div>
						{terminalOpen ? <TerminalPanel {...(screenWorkspace ? { workspace: screenWorkspace } : {})} /> : null}
					</main>
					{showFiles ? <RightPanel {...screen} /> : null}
				</div>
			)}
			{settings ? null : <FilePreview />}
			<Toasts />
			<AuthDialog />
			<YunlianDialog />
			<PairingRequestDialog />
		</>
	);
}
