import type { HostStats } from "@pier/protocol";
import { useCallback, useEffect, useState } from "react";
import { formatPercent, formatRate, formatSize, formatUptime } from "../lib/format.ts";
import { type HostStatsEntry, LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { HostPortsPanel } from "./HostPortsPanel.tsx";
import {
	IconActivity,
	IconArrowDown,
	IconArrowUp,
	IconLink,
	IconMonitor,
	IconPlus,
	IconServer,
	IconSettings,
} from "./Icons.tsx";
import { platformName } from "./RemotePanel.tsx";
import { useOutsideClick } from "./SessionControls.tsx";

function ratio(used: number, total: number): number {
	return total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
}

/** `ok` / `warn` / `high` by how full a resource is. */
function level(value: number): "ok" | "warn" | "high" {
	return value >= 0.9 ? "high" : value >= 0.75 ? "warn" : "ok";
}

function diskRatio(disk: NonNullable<HostStats["disk"]>): number {
	// Like `df`: the share of the space usable by the user that is taken.
	return ratio(disk.used, disk.used + disk.available);
}

const ENTRY_TEXT: Record<Exclude<HostStatsEntry["state"], "ok">, string> = {
	loading: "正在读取…",
	offline: "离线",
	unsupported: "需要升级 Pier",
	error: "读取失败",
};

/** Why a computer's usage is not shown, as a short phrase. */
function entryText(entry: HostStatsEntry | undefined): string {
	if (!entry) return ENTRY_TEXT.loading;
	return entry.state === "ok" ? "" : ENTRY_TEXT[entry.state];
}

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
	return (
		<div className="host-meter">
			<span className="host-meter-label">{label}</span>
			<span className="host-meter-track">
				<span className={`host-meter-fill ${level(value)}`} style={{ width: `${Math.round(value * 100)}%` }} />
			</span>
			<span className={`host-meter-value ${level(value)}`}>{formatPercent(value)}</span>
			<span className="host-meter-detail">{detail}</span>
		</div>
	);
}

function HostStatsBody({ entry }: { entry: HostStatsEntry | undefined }) {
	const stats = entry?.stats;
	if (!stats || entry?.state !== "ok") {
		const hint =
			entry?.state === "unsupported"
				? "这台电脑的 Pier 版本较旧，升级后即可查看资源占用。"
				: entry?.state === "offline"
					? "无法连接到这台电脑，它可能已关机、休眠或不在同一网络。"
					: entry?.state === "error"
						? `读取资源占用失败：${entry.error ?? "未知错误"}`
						: "正在读取资源占用…";
		return <div className="host-card-hint">{hint}</div>;
	}
	const cpuDetail = [
		`${stats.cpu.cores} 核`,
		stats.cpu.loadAverage ? `负载 ${stats.cpu.loadAverage[0].toFixed(2)}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<>
			<Meter label="CPU" value={stats.cpu.usage} detail={cpuDetail} />
			<Meter
				label="内存"
				value={ratio(stats.memory.used, stats.memory.total)}
				detail={`${formatSize(stats.memory.used)} / ${formatSize(stats.memory.total)}`}
			/>
			{stats.disk ? (
				<Meter
					label="磁盘"
					value={diskRatio(stats.disk)}
					detail={`${formatSize(stats.disk.used)} / ${formatSize(stats.disk.used + stats.disk.available)}`}
				/>
			) : null}
			{stats.network ? (
				<div
					className="host-meter host-network"
					title={`累计接收 ${formatSize(stats.network.rxTotal)}，累计发送 ${formatSize(stats.network.txTotal)}`}
				>
					<span className="host-meter-label">网络</span>
					<span className="host-net">
						<IconArrowDown size={12} />
						{formatRate(stats.network.rxRate)}
					</span>
					<span className="host-net">
						<IconArrowUp size={12} />
						{formatRate(stats.network.txRate)}
					</span>
				</div>
			) : null}
			<div className="host-card-foot">
				已运行 {formatUptime(stats.uptime)} · Pier 占用 {formatSize(stats.hostRss)}
			</div>
		</>
	);
}

function HostCard({
	node,
	name,
	subtitle,
	current,
	onPorts,
}: {
	node: string;
	name: string;
	subtitle: string;
	current: boolean;
	onPorts(node: string): void;
}) {
	const store = useStore();
	const entry = useAppState((s) => s.hostStats[node]);
	const connection = useAppState((s) => s.nodes[node]?.connection);
	const dot = entry?.state === "ok" ? "ok" : entry?.state === "offline" || entry?.state === "error" ? "bad" : "wait";
	const canRetry = node !== LOCAL_NODE && entry?.state === "offline" && connection !== "connecting";
	return (
		<div className={`host-card${current ? " current" : ""}`}>
			<div className="host-card-head">
				<span className={`status-dot ${dot}`} title={entry?.error ?? entryText(entry)} />
				<span className="host-card-title">
					<span className="host-card-name">{name}</span>
					<span className="host-card-sub">{subtitle}</span>
				</span>
				{canRetry ? (
					<button type="button" className="ghost host-card-action" onClick={() => store.retryNode(node)}>
						重新连接
					</button>
				) : current ? (
					<span className="host-card-badge" title="当前打开的工作区在这台电脑上">
						当前
					</span>
				) : null}
			</div>
			<HostStatsBody entry={entry} />
			<button type="button" className="ghost host-card-action" onClick={() => onPorts(node)}>
				<IconLink size={13} /> 查看端口与映射
			</button>
		</div>
	);
}

/** Usage of this computer and every paired computer, sampled while open. */
function HostStatusPopover({ onClose, onPorts }: { onClose(): void; onPorts(node: string): void }) {
	const store = useStore();
	const node = useAppState((s) => s.node);
	const peers = useAppState((s) => s.peers);
	const localInfo = useAppState((s) => s.localHostInfo);
	useEffect(() => store.watchHostStats(true), [store]);
	return (
		<div className="dropdown-menu up host-status-menu">
			<div className="dropdown-group-title no-caps">主机状态</div>
			<div className="host-cards">
				<HostCard
					node={LOCAL_NODE}
					name={localInfo?.hostName ?? "本机"}
					subtitle={["本机", platformName(localInfo?.platform)].filter(Boolean).join(" · ")}
					current={node === LOCAL_NODE}
					onPorts={onPorts}
				/>
				{peers.length ? <div className="dropdown-group-title no-caps">远程主机</div> : null}
				{peers.map((peer) => (
					<HostCard
						key={peer.id}
						node={peer.id}
						name={peer.name}
						subtitle={["远程", platformName(peer.platform), peer.addresses[0] ?? ""].filter(Boolean).join(" · ")}
						current={node === peer.id}
						onPorts={onPorts}
					/>
				))}
			</div>
			{peers.length ? null : (
				<div className="host-status-empty">还没有添加其他电脑。添加后可以在这里查看它们的资源占用。</div>
			)}
			<div className="dropdown-separator" />
			<button
				type="button"
				className="dropdown-item"
				onClick={() => {
					onClose();
					store.openAddPeer();
				}}
			>
				<span className="menu-label">
					<IconPlus size={14} />
					添加电脑…
				</span>
			</button>
			<button
				type="button"
				className="dropdown-item"
				onClick={() => {
					onClose();
					store.openSettings("remote");
				}}
			>
				<span className="menu-label">
					<IconSettings size={14} />
					管理远程主机
				</span>
			</button>
		</div>
	);
}

/**
 * The status bar's host status: usage of the computer of the workspace on screen; opens the
 * usage of this and every paired computer.
 */
function HostStatus() {
	const store = useStore();
	const node = useAppState((s) => s.node);
	const entry = useAppState((s) => s.hostStats[s.node]);
	const peerCount = useAppState((s) => s.peers.length);
	useAppState((s) => s.peers);
	useAppState((s) => s.localHostInfo);
	const [open, setOpen] = useState(false);
	const [portsNode, setPortsNode] = useState<string>();
	const close = useCallback(() => setOpen(false), []);
	const openPorts = (target: string) => {
		setOpen(false);
		setPortsNode(target);
	};
	const ref = useOutsideClick(open, close);
	useEffect(() => store.watchHostStats(false), [store]);
	const local = node === LOCAL_NODE;
	const name = local ? "本机" : store.nodeName(node);
	const stats = entry?.state === "ok" ? entry.stats : undefined;
	const title = stats
		? `${local ? "本机" : name}：CPU ${formatPercent(stats.cpu.usage)}，内存 ${formatSize(stats.memory.used)} / ${formatSize(stats.memory.total)}${
				stats.disk ? `，磁盘 ${formatPercent(diskRatio(stats.disk))}` : ""
			}。点击查看所有主机`
		: "主机状态：点击查看本机和远程主机的资源占用";
	return (
		<>
			<div className="dropdown host-status" ref={ref}>
				<button
					type="button"
					className={`statusbar-item${open ? " active" : ""}`}
					title={open ? undefined : title}
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				>
					{stats ? (
						<>
							<span className="statusbar-stat">
								<IconActivity size={12} />
								CPU <b className={level(stats.cpu.usage)}>{formatPercent(stats.cpu.usage)}</b>
							</span>
							<span className="statusbar-stat">
								内存{" "}
								<b className={level(ratio(stats.memory.used, stats.memory.total))}>
									{formatPercent(ratio(stats.memory.used, stats.memory.total))}
								</b>
							</span>
							{stats.disk ? (
								<span className="statusbar-stat">
									磁盘 <b className={level(diskRatio(stats.disk))}>{formatPercent(diskRatio(stats.disk))}</b>
								</span>
							) : null}
							{stats.network ? (
								<span className="statusbar-stat statusbar-net">
									<IconArrowDown size={11} />
									<span className="statusbar-rate">{formatRate(stats.network.rxRate)}</span>
									<IconArrowUp size={11} />
									<span className="statusbar-rate">{formatRate(stats.network.txRate)}</span>
								</span>
							) : null}
						</>
					) : (
						<span className="statusbar-stat">
							<IconActivity size={12} />
							{entryText(entry)}
						</span>
					)}
					<span className="statusbar-host">
						<IconMonitor size={12} />
						{name}
					</span>
					{peerCount ? (
						<span className="statusbar-host">
							<IconServer size={12} />
							{peerCount} 台远程主机
						</span>
					) : null}
				</button>
				{open ? <HostStatusPopover onClose={close} onPorts={openPorts} /> : null}
			</div>
			<button
				type="button"
				className="statusbar-item"
				title={`查看 ${name} 的监听端口与映射`}
				onClick={() => openPorts(node)}
			>
				<IconLink size={12} /> 端口
			</button>
			{portsNode ? <HostPortsPanel initialNode={portsNode} onClose={() => setPortsNode(undefined)} /> : null}
		</>
	);
}

/** The bar along the bottom of the window. */
export function StatusBar() {
	return (
		<footer className="statusbar">
			<div className="statusbar-left" />
			<div className="statusbar-right">
				<HostStatus />
			</div>
		</footer>
	);
}
