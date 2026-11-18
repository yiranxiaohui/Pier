import { useCallback } from "react";
import { useStore } from "../lib/store.tsx";
import { useHostPolling } from "../lib/use-host-polling.ts";
import { DeviceRow, PeerRow, RELAY_STATE_TEXT } from "./RemotePanel.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

/** Remote access controls remain local-only; expose their state without local mutation handlers. */
export function PairedRemoteSettings({ node, name }: { node: string; name: string }) {
	const store = useStore();
	const load = useCallback(() => store.remoteOverview(node), [store, node]);
	const { value, error } = useHostPolling(load);
	const remote = value?.remote;
	const relay = remote?.relay;
	return (
		<>
			<p className="settings-intro">
				正在查看 {name} 的连接设置，每 3 秒刷新。配对授权、设备移除和网络配置只能在那台电脑上操作，避免中断远程连接。
			</p>
			{error ? (
				<div className="banner error inline" role="alert">
					读取连接设置失败：{error}（会自动重试）
				</div>
			) : null}
			{!value || !remote ? (
				!error ? (
					<p className="muted">正在读取状态…</p>
				) : null
			) : (
				<>
					<SettingsGroup title="局域网访问">
						<SettingsCard>
							<SettingRow
								title="允许配对的手机和电脑通过局域网连接"
								description={
									remote.running ? `监听中 · 地址 ${remote.addresses.join("、") || "（未检测到局域网地址）"}` : "未监听"
								}
							>
								<Switch label="允许局域网连接" checked={remote.enabled} disabled onChange={() => {}} />
							</SettingRow>
							<SettingRow title="端口">
								<span className="mono setting-value">{remote.port}</span>
							</SettingRow>
							<SettingRow title="局域网广播">
								<span className="setting-value">{remote.mdns ? "已开启 _pier._tcp" : "未开启"}</span>
							</SettingRow>
							<SettingRow title="这台电脑的密钥指纹">
								<span className="mono setting-value">{remote.hostFingerprint}</span>
							</SettingRow>
							{remote.error ? <div className="setting-row error-text">{remote.error}</div> : null}
						</SettingsCard>
					</SettingsGroup>
					<SettingsGroup title="中继服务器">
						<SettingsCard>
							<SettingRow
								title="通过中继服务器连接"
								description={
									relay
										? `${RELAY_STATE_TEXT[relay.state]}${relay.mode ? ` · ${relay.mode === "open" ? "开放模式" : "私有模式"}` : ""}`
										: "未开启"
								}
							>
								<Switch label="通过中继服务器连接" checked={relay?.enabled ?? false} disabled onChange={() => {}} />
							</SettingRow>
							<SettingRow title="中继地址">
								<span className="mono setting-value">{relay?.url || "未配置"}</span>
							</SettingRow>
							<SettingRow title="访问令牌">
								<span className="setting-value">{relay?.hasToken ? "已保存（不显示令牌）" : "未配置"}</span>
							</SettingRow>
							<SettingRow title="优先点对点直连（P2P）">
								<Switch label="优先点对点直连" checked={remote.p2p !== false} disabled onChange={() => {}} />
							</SettingRow>
							{relay?.error ? <div className="setting-row error-text">{relay.error}</div> : null}
						</SettingsCard>
					</SettingsGroup>
					<SettingsGroup title="配对新设备">
						<SettingsCard>
							<SettingRow
								title={remote.pairingActive ? "配对码有效" : "未开启配对"}
								description="请在那台电脑上生成配对码并确认新设备；这里不显示配对链接或授权按钮。"
							/>
						</SettingsCard>
					</SettingsGroup>
					<SettingsGroup title={`已配对的设备（${value.devices.length}）`}>
						{value.devices.length ? (
							<div className="device-list">
								{value.devices.map((device) => (
									<DeviceRow key={device.id} device={device} readOnly />
								))}
							</div>
						) : (
							<SettingsCard>
								<div className="settings-empty">还没有配对的设备。</div>
							</SettingsCard>
						)}
					</SettingsGroup>
					<SettingsGroup title={`可连接的其他电脑（${value.peers.length}）`}>
						{value.peers.length ? (
							<div className="device-list">
								{value.peers.map((peer) => (
									<PeerRow key={peer.id} peer={peer} readOnly />
								))}
							</div>
						) : (
							<SettingsCard>
								<div className="settings-empty">还没有添加其他电脑。</div>
							</SettingsCard>
						)}
					</SettingsGroup>
				</>
			)}
		</>
	);
}
