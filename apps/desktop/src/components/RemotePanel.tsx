import {
	addressPort,
	type ConnectionRouteKind,
	DEFAULT_PIER_PORT,
	type DeviceInfo,
	type PairingRequest,
	type PeerInfo,
	parsePeerAddresses,
} from "@pier/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { relativeTime } from "../lib/format.ts";

import { useAppState, useStore } from "../lib/store.tsx";
import { IconLoader, IconMonitor, IconPencil, IconPlus, IconSmartphone } from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";
import { SshAddPeerForm } from "./SshAddPeer.tsx";

function useNow(intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

function countdown(expiresAt: string, now: number): string {
	const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** QR code as crisp SVG (dark modules on white, with the standard 4-module quiet zone). */
export function QrCode({ text, size = 232 }: { text: string; size?: number }) {
	const path = useMemo(() => {
		const qr = encode(text, { ecc: "M", border: 4 });
		let d = "";
		qr.data.forEach((row, y) => {
			row.forEach((dark, x) => {
				if (dark) d += `M${x} ${y}h1v1h-1z`;
			});
		});
		return { d, size: qr.size };
	}, [text]);
	return (
		<svg
			className="qr"
			width={size}
			height={size}
			viewBox={`0 0 ${path.size} ${path.size}`}
			shapeRendering="crispEdges"
			role="img"
			aria-label="配对二维码"
		>
			<rect width={path.size} height={path.size} fill="#fff" />
			<path d={path.d} fill="#000" />
		</svg>
	);
}

const COMPUTER_PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** Whether a device's platform is a computer running Pier (paired from its desktop app). */
export function isComputer(platform: string | undefined): boolean {
	return platform !== undefined && platform in COMPUTER_PLATFORMS;
}

export function platformName(platform: string | undefined): string {
	if (!platform) return "";
	if (platform === "ios") return "iOS";
	if (platform === "android") return "Android";
	return COMPUTER_PLATFORMS[platform] ?? platform;
}

function platformLabel(device: { platform?: string; model?: string; appVersion?: string }): string {
	const computer = isComputer(device.platform);
	const platform = platformName(device.platform);
	return [
		device.model,
		computer ? `${platform} 电脑` : platform,
		device.appVersion ? `${computer ? "Pier" : "App"} ${device.appVersion}` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

const ROUTE_TEXT: Record<ConnectionRouteKind, string> = {
	lan: "局域网直连",
	relay: "经中继",
	p2p: "P2P 直连",
};

/** Whether devices can reach this computer right now (LAN listener or relay). */
function remoteReachable(remote: { running: boolean; relay?: { state: string } } | undefined): boolean {
	return Boolean(remote?.running || remote?.relay?.state === "online");
}

function PairingSection() {
	const store = useStore();
	const pairing = useAppState((s) => s.pairing);
	const remote = useAppState((s) => s.remote);
	const now = useNow();
	if (!remoteReachable(remote)) return null;
	if (!pairing) {
		return (
			<SettingRow
				title="配对手机或电脑"
				description="手机用 Pier App 扫描二维码；另一台电脑在它的 Pier 中「添加电脑」并粘贴配对链接。配对码 5 分钟内有效，只能使用一次。"
			>
				<button type="button" className="primary" onClick={() => void store.startPairing()}>
					显示配对二维码
				</button>
			</SettingRow>
		);
	}
	const expired = Date.parse(pairing.expiresAt) <= now;
	return (
		<div className="setting-row">
			<div className="pairing">
				<div className={`qr-frame${expired ? " expired" : ""}`}>
					<QrCode text={pairing.uri} />
				</div>
				<div className="pairing-help">
					<ol>
						<li>手机：打开 Pier，点“添加电脑”，扫描左侧二维码。</li>
						<li>电脑：复制配对链接，在那台电脑的 Pier 中点“添加电脑”并粘贴。</li>
						<li>在这台电脑上确认允许该设备连接。</li>
					</ol>
					<p className="muted small">
						{expired ? "二维码已过期。" : `二维码 ${countdown(pairing.expiresAt, now)} 后过期。`}
						对方会依次尝试：
						{[...pairing.addresses, ...(pairing.relays ?? []).map((relay) => `中继 ${relay}`)].join("、")}
					</p>
					<div className="row-actions">
						{expired ? (
							<button type="button" className="primary" onClick={() => void store.startPairing()}>
								重新生成
							</button>
						) : (
							<CopyButton text={pairing.uri} label="复制配对链接" />
						)}
						<button type="button" className="ghost" onClick={() => void store.cancelPairing()}>
							取消
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function DeviceRow({ device }: { device: DeviceInfo }) {
	const store = useStore();
	const [confirm, setConfirm] = useState(false);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(device.name);
	const details = platformLabel(device);
	const DeviceIcon = isComputer(device.platform) ? IconMonitor : IconSmartphone;
	return (
		<div className="device-row">
			<span
				className={`status-dot ${device.connected ? "ok" : "idle"}`}
				title={device.connected ? "已连接" : "未连接"}
			/>
			<DeviceIcon size={16} className="device-kind" />
			<div className="device-main">
				{editing ? (
					<form
						className="device-rename"
						onSubmit={(e) => {
							e.preventDefault();
							const trimmed = name.trim();
							if (trimmed && trimmed !== device.name) void store.renameDevice(device.id, trimmed);
							setEditing(false);
						}}
					>
						<input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
						<button type="submit">保存</button>
					</form>
				) : (
					<div className="device-name">
						{device.name}
						<button
							type="button"
							className="ghost icon small-icon"
							title="重命名"
							onClick={() => {
								setName(device.name);
								setEditing(true);
							}}
						>
							<IconPencil size={13} />
						</button>
					</div>
				)}
				<div className="muted small">
					{details ? `${details} · ` : ""}
					{device.connected
						? `在线${device.route ? ` · ${ROUTE_TEXT[device.route]}` : ""}`
						: device.lastSeenAt
							? `最近连接 ${relativeTime(device.lastSeenAt)}`
							: `配对于 ${relativeTime(device.pairedAt)}`}
				</div>
				<div className="muted small mono" title="设备密钥指纹">
					{device.fingerprint}
				</div>
			</div>
			<button
				type="button"
				className={confirm ? "danger" : "ghost"}
				onClick={() => {
					if (!confirm) {
						setConfirm(true);
						return;
					}
					void store.revokeDevice(device.id);
				}}
				onBlur={() => setConfirm(false)}
			>
				{confirm ? "确认移除" : "移除"}
			</button>
		</div>
	);
}

function PeerRow({ peer }: { peer: PeerInfo }) {
	const store = useStore();
	const workspaces = useAppState((s) => s.nodes[peer.id]?.workspaces.length ?? 0);
	const [confirm, setConfirm] = useState(false);
	const [editing, setEditing] = useState(false);
	const details = [
		peer.platform ? `${platformName(peer.platform)} 电脑` : "",
		peer.version ? `Pier ${peer.version}` : "",
		peer.lastConnectedAt ? `最近连接 ${relativeTime(peer.lastConnectedAt)}` : `配对于 ${relativeTime(peer.pairedAt)}`,
		workspaces ? `${workspaces} 个工作区` : "",
	].filter(Boolean);
	return (
		<div className="device-row">
			<span className={`status-dot ${peer.connected ? "ok" : "idle"}`} title={peer.connected ? "已连接" : "未连接"} />
			<IconMonitor size={16} className="device-kind" />
			<div className="device-main">
				<div className="device-name">{peer.name}</div>
				<div className="muted small">{details.join(" · ")}</div>
				<div className="muted small mono" title="那台电脑的密钥指纹 · 地址">
					{peer.fingerprint} · {[...peer.addresses, ...(peer.relays ?? []).map((r) => `中继 ${r}`)].join("、")}
				</div>
			</div>
			<button
				type="button"
				className="ghost"
				title="修改连接地址（那台电脑的 IP 变了时）"
				onClick={() => setEditing(true)}
			>
				编辑
			</button>
			<button
				type="button"
				className={confirm ? "danger" : "ghost"}
				onClick={() => {
					if (!confirm) {
						setConfirm(true);
						return;
					}
					void store.removePeer(peer.id);
				}}
				onBlur={() => setConfirm(false)}
				title="只从这台电脑的列表中移除；要撤销它的访问权限，请在那台电脑的设备列表中移除本机"
			>
				{confirm ? "确认移除" : "移除"}
			</button>
			{editing ? <PeerAddressDialog peer={peer} onClose={() => setEditing(false)} /> : null}
		</div>
	);
}

/** Edit the addresses used to reach a paired computer, e.g. after its IP changed. */
function PeerAddressDialog({ peer, onClose }: { peer: PeerInfo; onClose: () => void }) {
	const store = useStore();
	const [text, setText] = useState(() => peer.addresses.join("\n"));
	const [relayText, setRelayText] = useState(() => (peer.relays ?? []).join("\n"));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const defaultPort = addressPort(peer.addresses[0]) ?? DEFAULT_PIER_PORT;
	const { addresses, invalid } = parsePeerAddresses(text, defaultPort);
	const relays = [
		...new Set(
			relayText
				.split(/[\s,，、;；]+/)
				.map((r) => r.trim())
				.filter(Boolean),
		),
	];
	const unchanged =
		addresses.join(",") === peer.addresses.join(",") && relays.join(",") === (peer.relays ?? []).join(",");
	const empty = !addresses.length && !relays.length;
	const submit = async () => {
		if (busy || invalid.length || empty) return;
		if (unchanged) {
			onClose();
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await store.updatePeerAddresses(peer.id, addresses, relays);
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	return (
		<Modal title={`编辑「${peer.name}」的连接地址`} onClose={onClose}>
			<div className="add-peer">
				<p className="muted">
					那台电脑的 IP 变了时在这里修改，无需重新配对。每行一个地址，格式为 <span className="mono">IP:端口</span>
					（省略端口时使用 {defaultPort}），连接时按顺序尝试。也可以填域名或 Tailscale 地址。
				</p>
				<textarea
					className="add-peer-link mono"
					rows={4}
					placeholder={`192.168.1.20:${defaultPort}`}
					value={text}
					disabled={busy}
					onChange={(e) => {
						setText(e.target.value);
						setError(undefined);
					}}
				/>
				<p className="muted small">中继服务器（可选，每行一个，例如 wss://relay.example.com），直连失败时使用：</p>
				<textarea
					className="add-peer-link mono"
					rows={2}
					placeholder="wss://relay.example.com"
					value={relayText}
					disabled={busy}
					onChange={(e) => {
						setRelayText(e.target.value);
						setError(undefined);
					}}
				/>
				{invalid.length ? (
					<div className="banner error inline">无法识别的地址：{invalid.join("、")}</div>
				) : empty ? (
					<p className="muted small">至少需要一个地址或中继服务器。</p>
				) : (
					<p className="muted small">
						将依次尝试：
						<span className="mono">{[...addresses, ...relays.map((r) => `中继 ${r}`)].join("、")}</span>
					</p>
				)}
				<p className="muted small">
					只会连接密钥指纹为 <span className="mono">{peer.fingerprint}</span>{" "}
					的电脑；地址上如果是另一台电脑，连接会被拒绝。
				</p>
				{error ? <div className="banner error inline">{error}</div> : null}
			</div>
			<div className="modal-actions">
				<button type="button" onClick={onClose}>
					取消
				</button>
				<button
					type="button"
					className="primary"
					disabled={busy || invalid.length > 0 || empty}
					onClick={() => void submit()}
				>
					{busy ? "保存中…" : "保存并重新连接"}
				</button>
			</div>
		</Modal>
	);
}
function PeersSection() {
	const store = useStore();
	const peers = useAppState((s) => s.peers);
	return (
		<SettingsGroup
			title={`可连接的其他电脑（${peers.length}）`}
			actions={
				<button type="button" onClick={() => store.openAddPeer()}>
					<IconPlus size={14} />
					添加电脑
				</button>
			}
		>
			{peers.length ? (
				<div className="device-list">
					{peers.map((peer) => (
						<PeerRow key={peer.id} peer={peer} />
					))}
				</div>
			) : (
				<SettingsCard>
					<div className="settings-empty">
						还没有添加其他电脑。添加后，那台电脑的工作区和会话会和本机的一起出现在左侧列表中，可以直接查看和驱动。
					</div>
				</SettingsCard>
			)}
			<p className="muted small settings-note">
				连接其他电脑不需要开启本机的局域网访问，但那台电脑需要开启局域网访问或中继。在这里移除只会忘记那台电脑；要撤销本机对它的访问，请在那台电脑的设备列表中移除本机。
			</p>
		</SettingsGroup>
	);
}

/** Add another computer: over SSH (installing Pier there when needed), or with its pairing link. */
export function AddPeerDialog() {
	const store = useStore();
	const open = useAppState((s) => s.addPeerOpen);
	const [mode, setMode] = useState<"ssh" | "link">("ssh");
	const [busy, setBusy] = useState(false);
	const onBusyChange = useCallback((value: boolean) => setBusy(value), []);
	useEffect(() => {
		if (!open) setBusy(false);
	}, [open]);
	if (!open) return null;
	const close = () => store.closeAddPeer();
	return (
		<Modal title="添加电脑" onClose={close}>
			<div className="segmented add-peer-mode" role="tablist" aria-label="添加方式">
				<button
					type="button"
					role="tab"
					aria-selected={mode === "ssh"}
					className={mode === "ssh" ? "active" : ""}
					disabled={busy}
					onClick={() => setMode("ssh")}
				>
					通过 SSH 添加
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={mode === "link"}
					className={mode === "link" ? "active" : ""}
					disabled={busy}
					onClick={() => setMode("link")}
				>
					粘贴配对链接
				</button>
			</div>
			{mode === "ssh" ? (
				<SshAddPeerForm onClose={close} onBusyChange={onBusyChange} />
			) : (
				<PairingLinkForm onClose={close} onBusyChange={onBusyChange} />
			)}
		</Modal>
	);
}

/** Pair with another computer by pasting the pairing link its Pier shows. */
function PairingLinkForm({ onClose, onBusyChange }: { onClose: () => void; onBusyChange(busy: boolean): void }) {
	const store = useStore();
	const fingerprint = useAppState((s) => s.remote?.hostFingerprint);
	const [link, setLink] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
	const trimmed = link.trim();
	const target = (() => {
		const query = /^pier:\/\/pair\/?\?(.*)$/i.exec(trimmed)?.[1];
		if (!query) return undefined;
		try {
			return new URLSearchParams(query).get("name") || "那台电脑";
		} catch {
			return undefined;
		}
	})();
	const submit = async () => {
		if (!trimmed || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await store.pairPeer(trimmed);
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	return (
		<>
			<div className="add-peer">
				<p className="muted">
					每台运行 Pier 的电脑都是一个节点。添加后，可以在这台电脑上查看、驱动那台电脑上的会话并审批命令（Agent
					仍在那台电脑上运行）；两台电脑想互相连接时，在两边各添加一次。
				</p>
				<ol className="add-peer-steps">
					<li>在那台电脑的 Pier 中打开「设置 → 设备与远程」，开启局域网访问（不在同一网络时开启中继）。</li>
					<li>点「显示配对二维码」，再点「复制配对链接」，把链接发到这台电脑。</li>
					<li>粘贴到下面并点「配对」，然后在那台电脑上确认。</li>
				</ol>
				<textarea
					className="add-peer-link mono"
					rows={3}
					placeholder="pier://pair?v=1&host=…"
					value={link}
					disabled={busy}
					onChange={(e) => {
						setLink(e.target.value);
						setError(undefined);
					}}
				/>
				{busy ? (
					<div className="add-peer-status">
						<IconLoader size={14} className="spin" />
						正在连接{target ? `「${target}」` : ""}，请在那台电脑上点「允许连接」…
					</div>
				) : null}
				{fingerprint ? (
					<p className="muted small">
						那台电脑的确认框会显示本机的设备指纹 <span className="mono">{fingerprint}</span>，可以核对。
					</p>
				) : null}
				{error ? <div className="banner error inline">{error}</div> : null}
			</div>
			<div className="modal-actions">
				<button type="button" onClick={onClose}>
					{busy ? "关闭" : "取消"}
				</button>
				<button type="button" className="primary" disabled={!target || busy} onClick={() => void submit()}>
					{busy ? "等待确认…" : "配对"}
				</button>
			</div>
		</>
	);
}

/** The “devices and remote access” settings page. */
export function RemoteSettings() {
	const store = useStore();
	const remote = useAppState((s) => s.remote);
	const devices = useAppState((s) => s.devices);
	const [port, setPort] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void store.loadRemote();
	}, [store]);

	if (!remote) return <p className="muted">正在读取状态…</p>;

	const toggle = async (enabled: boolean) => {
		setBusy(true);
		await store.configureRemote({ enabled });
		setBusy(false);
	};
	const portValue = port ?? String(remote.port);
	const portNumber = Number(portValue);
	const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

	return (
		<>
			<p className="settings-intro">
				每台运行 Pier 的电脑都是一个节点：手机（Pier
				App）和其他电脑配对后，可以查看这台电脑上的会话、继续对话和审批工具调用；这台电脑也可以添加其他电脑并切换过去。只有配对过的设备能连接，所有内容端到端加密（Noise
				协议）；同一局域网、Tailscale / WireGuard 网络内可以直连，不在同一网络时可以通过中继服务器连接（优先打洞 P2P
				直连，中继只转发密文）。
			</p>
			<SettingsGroup title="局域网访问">
				<SettingsCard>
					<SettingRow
						title="允许配对的手机和电脑通过局域网连接"
						description={
							remote.running
								? `监听中 · 地址 ${remote.addresses.join("、") || "（未检测到局域网地址）"}${remote.mdns ? " · 局域网广播 _pier._tcp" : ""}`
								: `开启后 Pier 在端口 ${remote.port} 上接受连接。`
						}
					>
						<Switch
							label="允许局域网连接"
							checked={remote.enabled}
							disabled={busy}
							onChange={(enabled) => void toggle(enabled)}
						/>
					</SettingRow>
					{remote.enabled && remote.error ? (
						<div className="setting-row">
							<div className="banner error inline">{remote.error}</div>
						</div>
					) : null}
					<SettingRow title="端口" description="范围 1024–65535，修改后会重新监听。">
						<input
							className="port-input"
							inputMode="numeric"
							value={portValue}
							onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
						/>
						<button
							type="button"
							disabled={!portValid || portNumber === remote.port || busy}
							onClick={async () => {
								setBusy(true);
								await store.configureRemote({ port: portNumber });
								setPort(undefined);
								setBusy(false);
							}}
						>
							应用
						</button>
					</SettingRow>
					<SettingRow title="这台电脑的密钥指纹" description="配对时对方会显示同样的指纹，可用来核对。">
						<span className="mono setting-value">{remote.hostFingerprint}</span>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>

			<RelaySettings />

			<SettingsGroup title="配对新设备">
				<SettingsCard>
					{remoteReachable(remote) ? (
						<PairingSection />
					) : (
						<div className="settings-empty">开启局域网访问或中继后即可配对手机或其他电脑。</div>
					)}
				</SettingsCard>
			</SettingsGroup>

			<SettingsGroup title={`已配对的设备（${devices.length}）`}>
				{devices.length ? (
					<div className="device-list">
						{devices.map((device) => (
							<DeviceRow key={device.id} device={device} />
						))}
					</div>
				) : (
					<SettingsCard>
						<div className="settings-empty">还没有配对的设备。</div>
					</SettingsCard>
				)}
				<p className="muted small settings-note">移除设备会立即断开它的连接；它需要重新配对才能再次连接。</p>
			</SettingsGroup>

			<PeersSection />
		</>
	);
}

const RELAY_STATE_TEXT = {
	off: "未开启",
	connecting: "正在连接…",
	online: "在线",
	error: "连接失败",
} as const;

/** Registration with a Pier Relay, for devices outside this network, and the P2P switch. */
function RelaySettings() {
	const store = useStore();
	const remote = useAppState((s) => s.remote);
	const relay = remote?.relay;
	const [url, setUrl] = useState<string | undefined>();
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	if (!remote || !relay) return null;
	const urlValue = url ?? relay.url ?? "";
	const dirty = (url !== undefined && url.trim() !== (relay.url ?? "")) || token.trim() !== "";

	const save = async (patch: { enabled?: boolean; url?: string; token?: string | null }) => {
		setBusy(true);
		setError(undefined);
		try {
			await store.configureRemote({ relay: patch }, { rethrow: true });
			setUrl(undefined);
			setToken("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const status =
		relay.state === "online"
			? `在线 · ${relay.mode === "open" ? "开放模式" : "私有模式"}`
			: relay.enabled
				? RELAY_STATE_TEXT[relay.state]
				: "未开启";

	return (
		<SettingsGroup title="中继服务器">
			<SettingsCard>
				<SettingRow
					title="通过中继服务器连接"
					description={
						relay.enabled
							? `${status}${relay.url ? ` · ${relay.url}` : ""}`
							: "手机和电脑都没有公网 IP 时，通过一台中继服务器连接。中继只转发端到端加密的数据，看不到内容。"
					}
				>
					<Switch
						label="通过中继服务器连接"
						checked={relay.enabled}
						disabled={busy || (!relay.enabled && !urlValue.trim())}
						onChange={(enabled) =>
							void save(
								enabled
									? {
											enabled,
											...(url !== undefined ? { url: urlValue } : {}),
											...(token.trim() ? { token: token.trim() } : {}),
										}
									: { enabled },
							)
						}
					/>
				</SettingRow>
				{relay.enabled && relay.error && relay.state !== "online" ? (
					<div className="setting-row">
						<div className="banner error inline">{relay.error}</div>
					</div>
				) : null}
				<SettingRow
					title="中继地址"
					description="自建的 Pier Relay 地址，例如 wss://relay.example.com（部署方法见 apps/relay/README.md）。"
					stack
				>
					<input
						className="mono relay-input"
						placeholder="wss://relay.example.com"
						value={urlValue}
						disabled={busy}
						onChange={(e) => setUrl(e.target.value)}
					/>
				</SettingRow>
				<SettingRow
					title="访问令牌"
					description={
						relay.hasToken
							? "已保存。私有模式的中继需要令牌；留空表示不修改。"
							: "私有模式的中继需要填写服务器上配置的令牌；开放模式留空即可。"
					}
					stack
				>
					<div className="port-row">
						<input
							className="mono relay-input"
							type="password"
							autoComplete="off"
							placeholder={relay.hasToken ? "••••••••（已保存）" : "访问令牌"}
							value={token}
							disabled={busy}
							onChange={(e) => setToken(e.target.value)}
						/>
						{relay.hasToken ? (
							<button type="button" className="ghost" disabled={busy} onClick={() => void save({ token: null })}>
								清除令牌
							</button>
						) : null}
					</div>
				</SettingRow>
				<div className="setting-row">
					<div className="row-actions">
						<button
							type="button"
							className="primary"
							disabled={busy || !dirty || !urlValue.trim()}
							onClick={() =>
								void save({
									url: urlValue,
									...(token.trim() ? { token: token.trim() } : {}),
									...(relay.enabled ? {} : { enabled: true }),
								})
							}
						>
							{relay.enabled ? "保存并重新连接" : "保存并开启"}
						</button>
					</div>
				</div>
				{error ? (
					<div className="setting-row">
						<div className="banner error inline">{error}</div>
					</div>
				) : null}
				<SettingRow
					title="优先点对点直连（P2P）"
					description="经中继连上后自动尝试打洞直连，成功后数据不再经过中继服务器；打洞失败时继续使用中继。"
				>
					<Switch
						label="优先点对点直连"
						checked={remote.p2p !== false}
						disabled={busy}
						onChange={(p2p) => void store.configureRemote({ p2p })}
					/>
				</SettingRow>
			</SettingsCard>
		</SettingsGroup>
	);
}

/** Asks the user to allow a device that presented a valid pairing code. */
export function PairingRequestDialog() {
	const store = useStore();
	const requests = useAppState((s) => s.pairingRequests);
	const now = useNow();
	const request: PairingRequest | undefined = requests[0];
	if (!request) return null;
	const details = platformLabel(request.device);
	return (
		<Modal title="允许新设备连接？" onClose={() => void store.respondPairing(request.id, false)}>
			<div className="pairing-request">
				<div className="pairing-device">{request.device.name}</div>
				{details ? <div className="muted">{details}</div> : null}
				<div className="host-facts">
					{request.address ? <span>来自 {request.address}</span> : null}
					<span>
						设备指纹 <span className="mono">{request.fingerprint}</span>
					</span>
					<span>{countdown(request.expiresAt, now)} 后自动拒绝</span>
				</div>
				<p className="warning-text small">
					允许后，这台设备可以查看你的会话，并在这台电脑上让 Agent 运行命令（仍受工作区审批策略约束）。
					如果这不是你刚刚扫码或粘贴链接的设备，请拒绝。
				</p>
			</div>
			<div className="modal-actions">
				<button type="button" onClick={() => void store.respondPairing(request.id, false)}>
					拒绝
				</button>
				<button type="button" className="primary" onClick={() => void store.respondPairing(request.id, true)}>
					允许连接
				</button>
			</div>
		</Modal>
	);
}
