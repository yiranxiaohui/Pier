import type { HostPort, HostPorts, PortForward } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { portAddress, portTarget, supportsPortFeature } from "../lib/host-ports.ts";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { IconCopy, IconLink, IconLoader, IconRefresh, IconTrash } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Host sockets and independent TCP mappings; no workspace or browser is required. */
export function HostPortsPanel({ initialNode, onClose }: { initialNode: string; onClose(): void }) {
	const store = useStore();
	const [node, setNode] = useState(initialNode);
	const peers = useAppState((s) => s.peers);
	const localInfo = useAppState((s) => s.localHostInfo);
	const connection = useAppState((s) => s.nodes[node]?.connection);
	const localConnection = useAppState((s) => s.nodes[LOCAL_NODE]?.connection);
	const client = store.nodeClient(node);
	const local = store.nodeClient(LOCAL_NODE);
	const localOnline = local?.state === "open" && localConnection === "open";
	const online = client?.state === "open" && (node === LOCAL_NODE || connection === "open");
	const canList = online && supportsPortFeature(client?.host, 39);
	const canForward =
		node !== LOCAL_NODE &&
		online &&
		localOnline &&
		supportsPortFeature(localInfo ?? local?.host, 39) &&
		supportsPortFeature(client?.host, 37);
	const [ports, setPorts] = useState<HostPorts>();
	const [loading, setLoading] = useState(false);
	const [listError, setListError] = useState("");
	const [forwards, setForwards] = useState<PortForward[]>([]);
	const [mappingError, setMappingError] = useState("");
	const [working, setWorking] = useState("");
	const [query, setQuery] = useState("");
	const [remoteHost, setRemoteHost] = useState("127.0.0.1");
	const [remotePort, setRemotePort] = useState("");
	const [localPort, setLocalPort] = useState("");
	const refreshActions = useRef<{ ports?: () => Promise<void>; forwards?: () => Promise<void> }>({});
	const mappingGeneration = useRef(0);
	const mappingBusy = useRef(false);
	const localPortInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		let active = true;
		let pending = false;
		setPorts(undefined);
		setListError("");
		setLoading(!!canList);
		const refresh = async () => {
			if (!canList || !client || pending) return;
			pending = true;
			try {
				const result = await client.request("host.ports", {}, { timeoutMs: 15_000 });
				if (active) {
					setPorts(result);
					setListError("");
				}
			} catch (error) {
				if (active) setListError(message(error));
			} finally {
				pending = false;
				if (active) setLoading(false);
			}
		};
		refreshActions.current.ports = refresh;
		void refresh();
		const timer = setInterval(() => void refresh(), 5000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [client, canList]);

	useEffect(() => {
		let active = true;
		let pending = false;
		const refresh = async () => {
			if (!localOnline || !local || !supportsPortFeature(local.host, 39)) {
				if (active) setForwards([]);
				return;
			}
			if (pending || mappingBusy.current) return;
			pending = true;
			const generation = mappingGeneration.current;
			try {
				const result = await local.request("portForward.list");
				if (active && generation === mappingGeneration.current) setForwards(result.forwards);
			} catch (error) {
				if (active) setMappingError(message(error));
			} finally {
				pending = false;
			}
		};
		refreshActions.current.forwards = refresh;
		void refresh();
		const timer = setInterval(() => void refresh(), 3000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [local, localOnline]);

	const selectPort = (port: HostPort) => {
		setRemoteHost(portTarget(port.address));
		setRemotePort(String(port.port));
		setLocalPort(String(port.port));
		setMappingError("");
		localPortInput.current?.focus();
		localPortInput.current?.scrollIntoView({ block: "nearest" });
	};
	const create = async () => {
		if (!local || !canForward || working) return;
		const targetHost = remoteHost.trim().replace(/^\[|\]$/g, "");
		const targetPort = Number(remotePort);
		const bindPort = localPort.trim() ? Number(localPort) : 0;
		if (
			!/^[a-z\d._:-]+$/i.test(targetHost) ||
			!Number.isInteger(targetPort) ||
			targetPort < 1 ||
			targetPort > 65535 ||
			!Number.isInteger(bindPort) ||
			bindPort < 0 ||
			bindPort > 65535
		) {
			setMappingError("请输入有效的远程地址和端口；本地端口留空或填 0 可自动分配");
			return;
		}
		setWorking("create");
		mappingGeneration.current += 1;
		mappingBusy.current = true;
		setMappingError("");
		try {
			const result = await local.request(
				"portForward.open",
				{ peerId: node, remoteHost: targetHost, remotePort: targetPort, localPort: bindPort },
				{ timeoutMs: 30_000 },
			);
			setForwards((rows) => [...rows.filter((row) => row.id !== result.id), result]);
			store.toast("info", `已映射到 ${portAddress(result.localHost, result.localPort)}`);
		} catch (error) {
			setMappingError(message(error));
		} finally {
			mappingGeneration.current += 1;
			mappingBusy.current = false;
			setWorking("");
		}
	};
	const closeForward = async (id: string) => {
		if (!local || working) return;
		setWorking(id);
		mappingGeneration.current += 1;
		mappingBusy.current = true;
		setMappingError("");
		try {
			await local.request("portForward.close", { id });
			setForwards((rows) => rows.filter((row) => row.id !== id));
		} catch (error) {
			setMappingError(message(error));
		} finally {
			mappingGeneration.current += 1;
			mappingBusy.current = false;
			setWorking("");
		}
	};
	const copy = (text: string) => {
		void navigator.clipboard.writeText(text).then(
			() => store.toast("info", "已复制本地地址"),
			() => store.toast("error", "复制失败，请手动复制地址"),
		);
	};
	const visible =
		ports?.ports.filter((port) =>
			`${port.protocol} ${port.address} ${port.port} ${port.process ?? ""} ${port.pid ?? ""}`
				.toLowerCase()
				.includes(query.toLowerCase().trim()),
		) ?? [];
	const listHint = !online
		? "这台主机当前未连接。连接后可查看监听端口。"
		: !canList
			? "这台主机需要升级 Pier（协议 1.39）后才能查看监听端口。"
			: "";
	return (
		<Modal title="主机端口与映射" onClose={onClose} wide className="host-ports-modal">
			<div className="host-ports-toolbar">
				<Select
					value={node}
					disabled={!!working}
					onChange={(value) => {
						setNode(value);
						setRemoteHost("127.0.0.1");
						setRemotePort("");
						setLocalPort("");
						setMappingError("");
					}}
					ariaLabel="查看主机"
					options={[
						{ value: LOCAL_NODE, label: `${localInfo?.hostName ?? "本机"} · 本机` },
						...peers.map((peer) => ({ value: peer.id, label: `${peer.name} · 远程` })),
					]}
				/>
				<button
					type="button"
					className="ghost"
					disabled={loading}
					onClick={() => {
						setLoading(!!canList);
						void refreshActions.current.ports?.();
						void refreshActions.current.forwards?.();
					}}
				>
					{loading ? <IconLoader size={14} className="spin" /> : <IconRefresh size={14} />} 刷新
				</button>
			</div>
			<p className="muted small">
				查看主机正在监听的端口，将远程 TCP 服务映射到当前电脑，供浏览器、数据库工具或其他程序连接。
			</p>
			<section className="host-ports-section" aria-label="监听端口">
				<div className="host-ports-heading">
					<h4>监听端口 {ports ? <span className="muted">({ports.ports.length})</span> : null}</h4>
					<input
						aria-label="筛选监听端口"
						placeholder="筛选端口、地址或进程…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
				{listHint || listError ? (
					<p className={listError ? "banner error" : "muted"} role="status">
						{listError || listHint}
					</p>
				) : loading && !ports ? (
					<p className="muted">正在读取监听端口…</p>
				) : (
					<div className="host-ports-table-wrap">
						<table className="host-ports-table">
							<thead>
								<tr>
									<th>协议</th>
									<th>监听地址</th>
									<th>进程</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{visible.map((port) => (
									<tr key={`${port.protocol}|${port.address}|${port.port}|${port.pid ?? ""}`}>
										<td>
											<span className={`port-protocol ${port.protocol}`}>{port.protocol.toUpperCase()}</span>
										</td>
										<td>
											<code>{portAddress(port.address, port.port)}</code>
										</td>
										<td title={port.process}>
											{port.process ?? "—"}
											{port.pid ? <span className="muted small"> · {port.pid}</span> : null}
										</td>
										<td>
											<button
												type="button"
												className="ghost"
												disabled={
													!canForward || port.protocol !== "tcp" || portTarget(port.address).includes("%") || !!working
												}
												title={
													port.protocol === "udp"
														? "暂不支持 UDP 映射"
														: portTarget(port.address).includes("%")
															? "暂不支持带接口范围的 IPv6 地址映射"
															: node === LOCAL_NODE
																? "选择远程主机后可映射到本地"
																: "填入下方映射表单"
												}
												onClick={() => selectPort(port)}
											>
												<IconLink size={13} /> 映射
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{visible.length ? null : (
							<p className="muted host-ports-empty">{query ? "没有匹配的监听端口" : "未发现监听端口"}</p>
						)}
					</div>
				)}
				{ports?.truncated ? <p className="muted small">端口过多，仅显示前 4096 条。</p> : null}
				<p className="muted small">
					列表按系统权限读取，进程信息可能不可见；监听端口不代表已通过防火墙开放。UDP 可查看，暂不支持映射。
				</p>
			</section>
			<section className="host-ports-section" aria-label="新建端口映射">
				<h4>新建 TCP 映射</h4>
				<form
					className="port-forward-form"
					onSubmit={(event) => {
						event.preventDefault();
						void create();
					}}
				>
					<label>
						远程地址
						<input
							aria-label="远程地址"
							value={remoteHost}
							onChange={(event) => setRemoteHost(event.target.value)}
							disabled={!canForward || !!working}
							required
						/>
					</label>
					<label>
						远程端口
						<input
							aria-label="远程端口"
							type="number"
							min="1"
							max="65535"
							value={remotePort}
							onChange={(event) => setRemotePort(event.target.value)}
							disabled={!canForward || !!working}
							required
							placeholder="3000"
						/>
					</label>
					<label>
						本地端口
						<input
							aria-label="本地端口"
							ref={localPortInput}
							type="number"
							min="0"
							max="65535"
							value={localPort}
							onChange={(event) => setLocalPort(event.target.value)}
							disabled={!canForward || !!working}
							placeholder="自动分配"
						/>
					</label>
					<button type="submit" className="primary" disabled={!canForward || !!working}>
						{working === "create" ? <IconLoader size={14} className="spin" /> : <IconLink size={14} />} 创建映射
					</button>
				</form>
				<p className="muted small">
					{node === LOCAL_NODE
						? "选择远程主机后可创建映射。"
						: !canForward
							? "创建映射需要主机在线，本机支持协议 1.39，远程支持协议 1.37。"
							: "远程地址从所选主机访问；本地仅监听 127.0.0.1，端口留空或填 0 时自动分配。"}
				</p>
			</section>
			<section className="host-ports-section" aria-label="本机已创建的映射">
				<h4>
					本机已创建的映射 <span className="muted">({forwards.length})</span>
				</h4>
				{mappingError ? (
					<p className="banner error" role="alert">
						{mappingError}
					</p>
				) : null}
				<div className="port-forward-list">
					{forwards.map((forward) => (
						<div className="port-forward-row" key={forward.id}>
							<div className="port-forward-details">
								<strong>
									<code>{portAddress(forward.localHost, forward.localPort)}</code>
									<span className="muted"> → </span>
									{store.nodeName(forward.peerId)} · <code>{portAddress(forward.remoteHost, forward.remotePort)}</code>
								</strong>
								<small className={forward.lastError ? "port-forward-error" : "muted"}>
									{forward.lastError ?? "TCP · 正在监听本地端口"}
								</small>
							</div>
							<button
								type="button"
								className="ghost icon"
								title="复制本地地址"
								onClick={() => copy(portAddress(forward.localHost, forward.localPort))}
							>
								<IconCopy size={14} />
							</button>
							<button
								type="button"
								className="ghost icon"
								title="关闭映射"
								disabled={!!working}
								onClick={() => void closeForward(forward.id)}
							>
								{working === forward.id ? <IconLoader size={14} className="spin" /> : <IconTrash size={14} />}
							</button>
						</div>
					))}
				</div>
				{forwards.length ? null : <p className="muted">尚未创建端口映射。</p>}
			</section>
			<p className="muted small">
				关闭此面板后映射继续运行；退出 Pier、主机断开连接或移除配对时映射关闭，重新连接后需重新创建。
			</p>
		</Modal>
	);
}
