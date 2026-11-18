import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_NODE, useAppState, useSettingsTarget, useStore } from "../lib/store.tsx";
import { useHostPolling } from "../lib/use-host-polling.ts";
import { IconAlert, IconInfo, IconLoader } from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { SettingsGroup } from "./SettingsUi.tsx";

/** This computer's host connection, summarised for the settings screen. */
export function useHostStatus(): { online: boolean; dot: "ok" | "bad" | "wait"; text: string } {
	const host = useAppState((s) => s.host);
	const connection = useAppState((s) => s.localConnection);
	const hostInfo = useAppState((s) => s.localHostInfo);
	const online = host.state === "ready" && connection === "open";
	const text = online
		? hostInfo?.piVersion
			? `已连接 · pi ${hostInfo.piVersion}`
			: "已连接 · 未安装 pi"
		: connection === "reconnecting"
			? "正在重连…"
			: host.state === "failed"
				? "Host 启动失败"
				: host.state === "restarting"
					? "Host 正在重启…"
					: host.state === "stopped"
						? "未连接"
						: "正在启动…";
	return { online, dot: online ? "ok" : host.state === "failed" ? "bad" : "wait", text };
}

/** The shown computer's connection (this one's, or a paired computer's), for the main window. */
export function useNodeStatus(target?: string): { online: boolean; dot: "ok" | "bad" | "wait"; text: string } {
	const store = useStore();
	const local = useHostStatus();
	const node = useAppState((s) => target ?? s.node);
	const host = useAppState((s) => s.host);
	const connection = useAppState((s) => s.nodes[node]?.connection);
	const revoked = useAppState((s) => !!s.nodes[node]?.revoked);
	const connectError = useAppState((s) => s.nodes[node]?.connectError);
	useAppState((s) => s.peers);
	if (node === LOCAL_NODE) return local;
	const name = store.nodeName(node);
	const online = host.state === "ready" && connection === "open";
	if (online) return { online, dot: "ok", text: `已连接 ${name}` };
	if (revoked) return { online, dot: "bad", text: `${name} 已移除这台电脑` };
	return {
		online,
		dot: connectError ? "bad" : "wait",
		text: connectError ? `无法连接 ${name}` : connection === "reconnecting" ? "正在重连…" : `正在连接 ${name}…`,
	};
}

/** Why the paired computer of the workspace on screen is not connected, with what to do about it. */
function NodeBanner() {
	const store = useStore();
	const node = useAppState((s) => s.node);
	const connection = useAppState((s) => s.connection);
	const connectError = useAppState((s) => s.connectError);
	const revoked = useAppState((s) => !!s.nodeRevoked);
	useAppState((s) => s.peers);
	const name = store.nodeName(node);

	let level: "info" | "warning" | "error" = "info";
	let text: string | undefined;
	if (revoked) {
		level = "error";
		text = `${name} 已移除这台电脑（或重置了 Pier）。请在那台电脑上重新生成配对链接，再次配对。`;
	} else if (connectError) {
		level = "warning";
		text = `无法连接到 ${name}：${connectError}。这个工作区在 ${name} 上，请确认它已开机、开启了局域网访问，且两台电脑网络互通；正在自动重试…`;
	} else if (connection === "reconnecting") {
		level = "warning";
		text = `与 ${name} 的连接中断，正在重连…（那台电脑上进行中的任务不受影响）`;
	} else if (connection === "connecting" || connection === "none") text = `正在通过加密通道连接 ${name}…`;
	if (!text) return null;
	return (
		<div className={`banner host-banner ${level}`}>
			{level === "info" ? (
				<IconLoader size={15} className="spin" />
			) : level === "warning" ? (
				<IconInfo size={15} />
			) : (
				<IconAlert size={15} />
			)}
			<span>{text}</span>
			<span className="banner-actions">
				{revoked ? (
					<button type="button" onClick={() => store.openAddPeer()}>
						重新配对
					</button>
				) : level !== "info" ? (
					<button type="button" onClick={() => store.retryNode()}>
						立即重试
					</button>
				) : null}
			</span>
		</div>
	);
}

/**
 * Connection / host lifecycle banner shown above the main area when something is off.
 * `scope="node"` (the main window) also covers the connection to a shown paired computer.
 */
export function HostBanner({ onShowLogs, scope = "local" }: { onShowLogs: () => void; scope?: "local" | "node" }) {
	const store = useStore();
	const host = useAppState((s) => s.host);
	const node = useAppState((s) => s.node);
	const connection = useAppState((s) => s.localConnection);
	const connectError = useAppState((s) => s.nodes[LOCAL_NODE]?.connectError);

	let level: "info" | "warning" | "error" = "info";
	let text: string | undefined;
	if (host.state === "starting") text = "正在启动 Pier Host…";
	else if (host.state === "restarting") {
		level = "warning";
		text = `Pier Host 意外退出，正在自动重启${host.error ? `（${host.error}）` : ""}`;
	} else if (host.state === "failed") {
		level = "error";
		text = `Pier Host 无法启动：${host.error ?? "未知错误"}`;
	} else if (host.state === "stopped") {
		level = "warning";
		text = host.error ?? "Pier Host 未运行";
	} else if (connectError) {
		level = "error";
		text = `无法连接到 Pier Host：${connectError}`;
	} else if (connection === "reconnecting") {
		level = "warning";
		text = "与 Pier Host 的连接中断，正在重连…（进行中的任务不受影响）";
	} else if (connection === "connecting" || connection === "none") text = "正在连接 Pier Host…";
	if (!text) return scope === "node" && node !== LOCAL_NODE ? <NodeBanner /> : null;
	const canRestart = store.bridgeKind === "tauri" && (host.state === "failed" || host.state === "ready");
	return (
		<div className={`banner host-banner ${level}`}>
			{level === "info" ? (
				<IconLoader size={15} className="spin" />
			) : level === "warning" ? (
				<IconInfo size={15} />
			) : (
				<IconAlert size={15} />
			)}
			<span>{text}</span>
			<span className="banner-actions">
				{canRestart && level !== "info" ? (
					<button type="button" onClick={() => store.restartHost()}>
						重启 Host
					</button>
				) : null}
				<button type="button" className="ghost" onClick={onShowLogs}>
					查看日志
				</button>
			</span>
		</div>
	);
}

/** Always show the selected host; never attach the local log stream to a remote page. */
export function LogsSettings() {
	const target = useSettingsTarget();
	return target.local ? <LocalLogsSettings /> : <RemoteLogsSettings key={target.node} />;
}

function RemoteLogsSettings() {
	const store = useStore();
	const target = useSettingsTarget();
	const load = useCallback(() => store.hostLogs(target.node), [store, target.node]);
	const { value: lines, error } = useHostPolling(load, 2000);
	const scroller = useRef<HTMLPreElement>(null);
	useEffect(() => {
		if (lines && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
	}, [lines]);
	return (
		<SettingsGroup
			title={
				<span className="settings-inline-status">
					<span className={`status-dot ${error ? "bad" : target.online ? "ok" : "wait"}`} />
					{target.name} · Pier Host 日志
				</span>
			}
			description="显示该 Host 本次启动后保留的最近运行日志，每 2 秒刷新。重启 Host 请在那台电脑上操作。"
			actions={<CopyButton text={lines?.join("\n") ?? ""} label="复制日志" />}
		>
			{error ? (
				<div className="banner error inline" role="alert">
					读取日志失败：{error}（会自动重试）
				</div>
			) : null}
			<pre className="logs settings-logs" ref={scroller}>
				{lines ? lines.join("\n") || "（暂无日志）" : error ? "（日志尚未读取）" : "正在读取日志…"}
			</pre>
		</SettingsGroup>
	);
}

function LocalLogsSettings() {
	const store = useStore();
	const host = useAppState((s) => s.host);
	const [lines, setLines] = useState<string[]>([]);
	const scroller = useRef<HTMLPreElement>(null);

	useEffect(() => {
		let alive = true;
		void store
			.logs()
			.then((initial) => {
				if (alive) setLines(initial);
			})
			.catch((error) => {
				if (alive) setLines([`读取日志失败：${error instanceof Error ? error.message : String(error)}`]);
			});
		const off = store.onLog((line) => setLines((current) => [...current, line].slice(-2000)));
		return () => {
			alive = false;
			off();
		};
	}, [store]);

	useEffect(() => {
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	});

	return (
		<SettingsGroup
			title={
				<span className="settings-inline-status">
					<span className={`status-dot ${host.state === "ready" ? "ok" : host.state === "failed" ? "bad" : "wait"}`} />
					Pier Host 日志
				</span>
			}
			actions={
				<>
					<CopyButton text={lines.join("\n")} label="复制日志" />
					{store.bridgeKind === "tauri" ? (
						<button type="button" onClick={() => store.restartHost()}>
							重启 Host
						</button>
					) : null}
				</>
			}
		>
			<pre className="logs settings-logs" ref={scroller}>
				{lines.join("\n") || "（暂无日志）"}
			</pre>
		</SettingsGroup>
	);
}
