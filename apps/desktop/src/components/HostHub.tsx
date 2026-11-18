import type { ReactNode } from "react";
import { remotePageBlocker } from "../lib/settings-target.ts";
import { LOCAL_NODE, useAppState, useComputers, useStore } from "../lib/store.tsx";
import { HostFiles } from "./HostFiles.tsx";
import { IconFolder, IconLink, IconMonitor, IconPlus, IconServer, IconTerminal } from "./Icons.tsx";
import { PairedRemoteSettings } from "./RemoteOverview.tsx";
import { LocalRemoteSettings, PeerRow, platformName } from "./RemotePanel.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";

const TABS = [
	{ id: "shell", label: "Shell 终端", icon: IconTerminal },
	{ id: "files", label: "文件", icon: IconFolder },
	{ id: "connection", label: "连接管理", icon: IconLink },
] as const;

export function HostHub({ footer }: { footer?: ReactNode }) {
	const store = useStore();
	const computers = useComputers();
	const peers = useAppState((s) => s.peers);
	const view = useAppState((s) => s.hostHubView);
	const computer = computers.find((item) => item.id === view?.node) ?? computers[0];
	if (!computer) return null;
	const node = computer.id;
	const peer = peers.find((p) => p.id === node);
	const tab = view?.tab ?? "shell";
	const blocker = remotePageBlocker("remote", computer.name, computer.state.hostInfo);
	return (
		<div className="host-hub">
			<aside className="host-sidebar">
				<div className="host-sidebar-heading">
					<h2>远程主机</h2>
					<button
						type="button"
						className="ghost icon"
						title="添加主机"
						aria-label="添加主机"
						onClick={() => store.openAddPeer()}
					>
						<IconPlus size={18} />
					</button>
				</div>
				{computers.map((item) => (
					<button
						type="button"
						key={item.id}
						className={`host-choice${item.id === node ? " selected" : ""}`}
						aria-pressed={item.id === node}
						onClick={() => store.selectHostView(item.id, tab)}
					>
						{item.local ? <IconMonitor size={17} /> : <IconServer size={17} />}
						<span className="host-choice-name">
							<strong>{item.name}</strong>
							<small>{item.local ? "本机" : peers.find((p) => p.id === item.id)?.addresses[0] || "通过中继连接"}</small>
						</span>
						<span className={`status-dot ${item.online ? "ok" : "idle"}`} title={item.online ? "已连接" : "未连接"} />
					</button>
				))}
			</aside>
			<main className="host-detail">
				<header className="host-heading">
					<div>
						<h1>{computer.name}</h1>
						<p>
							{[
								node === LOCAL_NODE ? "本机" : "远程主机",
								platformName(computer.state.hostInfo?.platform ?? peer?.platform),
								computer.online ? "已连接" : "未连接",
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					</div>
					{!computer.online && peer && (
						<button type="button" onClick={() => store.retryNode(node)}>
							重新连接
						</button>
					)}
				</header>
				<nav className="host-tabs" aria-label="主机工具">
					{TABS.map((item) => (
						<button
							type="button"
							key={item.id}
							aria-pressed={tab === item.id}
							onClick={() => store.selectHostView(node, item.id)}
						>
							<item.icon size={15} />
							{item.label}
						</button>
					))}
				</nav>
				{tab === "shell" ? (
					<TerminalPanel key={node} node={node} />
				) : tab === "files" ? (
					computer.online ? (
						<HostFiles key={node} computer={computer} />
					) : (
						<p className="host-notice">连接主机后可管理文件。</p>
					)
				) : (
					<div className="host-connections" key={node}>
						{peer && <PeerRow peer={peer} />}
						{!computer.online ? (
							<p className="host-notice">主机未连接。</p>
						) : computer.local ? (
							<LocalRemoteSettings />
						) : blocker ? (
							<p className="host-notice">{blocker}</p>
						) : (
							<PairedRemoteSettings node={node} name={computer.name} />
						)}
					</div>
				)}
			</main>
			{footer}
		</div>
	);
}
