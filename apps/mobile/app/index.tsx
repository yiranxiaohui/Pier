import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { UpdateBanner } from "../src/components/Update.tsx";
import {
	ActionSheet,
	Avatar,
	Button,
	HeaderAction,
	Icon,
	LargeTitle,
	Muted,
	Pill,
	PulseDot,
	Screen,
	StatusDot,
	Title,
} from "../src/components/ui.tsx";
import { relativeTime } from "../src/format.ts";
import type { PairedHost } from "../src/hosts.ts";
import { useMobileState, useStore } from "../src/store.ts";
import { MONO, PAGE, RADIUS, SHADOW, usePalette } from "../src/theme.ts";

function HostMenu({ host, onClose }: { host: PairedHost; onClose: () => void }) {
	const store = useStore();
	const router = useRouter();
	const connected = useMobileState((s) => !!s.connections[host.hostId]);
	return (
		<ActionSheet
			title={host.hostName}
			subtitle={[...host.addresses, ...(host.relays ?? []).map((r) => `中继 ${r}`)].join("\n")}
			onClose={onClose}
			actions={[
				...(connected
					? [
							{
								label: "断开连接",
								description: "关闭后台连接，打开的终端也会关闭；电脑上的会话照常运行",
								icon: "power-outline" as const,
								testID: "host-disconnect",
								onPress: () => store.disconnectHost(host.hostId),
							},
						]
					: []),
				{
					label: "修改连接地址",
					description: "电脑的 IP 变了时使用，不用重新配对",
					icon: "swap-horizontal",
					testID: "host-edit-addresses",
					onPress: () => router.push({ pathname: "/host/[hostId]/addresses", params: { hostId: host.hostId } }),
				},
				{
					label: "移除",
					description: "只删除这台手机上的配对信息",
					icon: "trash-outline",
					danger: true,
					testID: "host-forget",
					confirm: {
						title: `移除“${host.hostName}”？`,
						message: "只会删除这台手机上的配对信息。要彻底撤销访问，请在电脑的“手机与远程访问”中移除这台设备。",
						action: "移除",
					},
					onPress: () => void store.forgetHost(host.hostId),
				},
			]}
		/>
	);
}

function HostRow({ host }: { host: PairedHost }) {
	const router = useRouter();
	const p = usePalette();
	const [menu, setMenu] = useState(false);
	const active = useMobileState((s) => s.connections[host.hostId]?.connection);
	const revoked = useMobileState((s) => !!s.connections[host.hostId]?.revoked);
	const online = active === "open" && !revoked;
	const dot = revoked ? p.danger : online ? p.ok : active ? p.warning : p.faint;
	const status = revoked
		? "已被电脑移除，需要重新配对"
		: online
			? "已连接"
			: active
				? "正在连接…"
				: host.lastConnectedAt
					? `上次连接 ${relativeTime(host.lastConnectedAt)}`
					: `配对于 ${relativeTime(host.pairedAt)}`;
	return (
		<>
			<Pressable
				testID={`host-${host.hostId}`}
				onPress={() => router.push({ pathname: "/host/[hostId]", params: { hostId: host.hostId } })}
				onLongPress={() => setMenu(true)}
				style={({ pressed }) => [
					styles.hostCard,
					SHADOW,
					{ backgroundColor: p.card, borderColor: p.border },
					pressed && styles.pressed,
				]}
			>
				<Avatar name={host.hostName} size={46} icon="desktop-outline" tone="accent">
					<View style={styles.avatarDot}>
						<StatusDot color={dot} size={14} ring={p.card} />
					</View>
				</Avatar>
				<View style={styles.hostMain}>
					<Text style={[styles.hostName, { color: p.text }]} numberOfLines={1}>
						{host.hostName}
					</Text>
					<View style={styles.statusRow}>
						{online ? <PulseDot color={p.ok} size={6} /> : null}
						<Text style={[styles.status, { color: revoked ? p.danger : online ? p.ok : p.muted }]} numberOfLines={1}>
							{status}
						</Text>
					</View>
					{host.addresses[0] || host.relays?.[0] ? (
						<Text style={[styles.address, { color: p.faint }]} numberOfLines={1}>
							{host.addresses[0] ?? `中继 ${host.relays?.[0]?.replace(/^wss?:\/\//, "")}`}
							{host.addresses.length + (host.relays?.length ?? 0) > 1
								? `  +${host.addresses.length + (host.relays?.length ?? 0) - 1}`
								: ""}
						</Text>
					) : null}
				</View>
				{revoked ? <Pill text="需重新配对" tone="danger" /> : null}
				<Pressable
					hitSlop={10}
					onPress={() => setMenu(true)}
					accessibilityRole="button"
					accessibilityLabel={`${host.hostName} 的更多操作`}
					style={({ pressed }) => [styles.more, pressed && { backgroundColor: p.elevated }]}
				>
					<Icon name="ellipsis-vertical" size={18} color={p.faint} />
				</Pressable>
			</Pressable>
			{menu ? <HostMenu host={host} onClose={() => setMenu(false)} /> : null}
		</>
	);
}

const STEPS = [
	{ icon: "desktop-outline", text: "在电脑上打开 Pier，进入“手机与远程访问”" },
	{ icon: "radio-outline", text: "开启远程访问，显示配对二维码" },
	{ icon: "scan-outline", text: "点下方“添加电脑”，用手机扫码" },
] as const;

function EmptyHosts() {
	const p = usePalette();
	return (
		<View style={styles.empty}>
			<View style={[styles.hero, { backgroundColor: p.accentSoft }]}>
				<View style={[styles.heroInner, { backgroundColor: p.accent }]}>
					<Icon name="laptop-outline" size={34} color={p.onAccent} />
				</View>
			</View>
			<Title style={[styles.center, styles.emptyTitle]}>连接你的电脑</Title>
			<Muted style={styles.center}>从手机查看进度、发送指令和审批操作，Agent 持续在电脑上运行。</Muted>
			<View style={[styles.steps, { backgroundColor: p.card, borderColor: p.border }]}>
				{STEPS.map((step, index) => (
					<View key={step.text} style={styles.step}>
						<View style={[styles.stepIndex, { backgroundColor: p.accentSoft }]}>
							<Text style={[styles.stepIndexText, { color: p.accentText }]}>{index + 1}</Text>
						</View>
						<Text style={[styles.stepText, { color: p.text }]}>{step.text}</Text>
						<Icon name={step.icon} size={18} color={p.faint} />
					</View>
				))}
			</View>
			<Muted style={[styles.center, styles.hint]}>
				手机和电脑在同一局域网（或同一 Tailscale 网络）时直连；不在同一网络时，电脑开启中继服务器即可连接。
			</Muted>
		</View>
	);
}

export default function Home() {
	const router = useRouter();
	const p = usePalette();
	const ready = useMobileState((s) => s.ready);
	const hosts = useMobileState((s) => s.hosts);
	return (
		<Screen safeBottom>
			<Stack.Screen
				options={{
					headerRight: () => (
						<View style={styles.headerActions}>
							<HeaderAction label="用量统计" icon="bar-chart-outline" onPress={() => router.push("/usage")} />
							<HeaderAction label="设置" icon="settings-outline" onPress={() => router.push("/settings")} />
						</View>
					),
				}}
			/>
			{!ready ? (
				<ActivityIndicator style={styles.loading} color={p.accentText} />
			) : (
				<FlatList
					data={hosts}
					keyExtractor={(h) => h.hostId}
					contentContainerStyle={styles.list}
					renderItem={({ item }) => <HostRow host={item} />}
					ListHeaderComponent={
						<View style={styles.header}>
							<LargeTitle
								eyebrow="PIER"
								title="我的电脑"
								subtitle={hosts.length ? `${hosts.length} 台已配对 · 长按管理` : "编码 Agent 的跨设备工作台"}
							/>
							<UpdateBanner />
						</View>
					}
					ListEmptyComponent={<EmptyHosts />}
					ListFooterComponent={
						hosts.length ? (
							<Pressable
								testID="add-host"
								accessibilityRole="button"
								accessibilityLabel="添加电脑"
								onPress={() => router.push("/pair")}
								style={({ pressed }) => [
									styles.addCard,
									{ borderColor: p.accentRing, backgroundColor: p.accentSoft },
									pressed && { backgroundColor: p.elevated },
								]}
							>
								<View style={[styles.addIcon, { backgroundColor: p.accentSoft }]}>
									<Icon name="add" size={20} color={p.accentText} />
								</View>
								<View style={styles.flex}>
									<Text style={[styles.addTitle, { color: p.text }]}>添加电脑</Text>
									<Muted>扫描电脑上的配对二维码</Muted>
								</View>
								<Icon name="qr-code-outline" size={20} color={p.faint} />
							</Pressable>
						) : (
							<Button
								title="添加电脑"
								icon="scan-outline"
								variant="primary"
								onPress={() => router.push("/pair")}
								testID="add-host"
								style={styles.add}
							/>
						)
					}
				/>
			)}
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	headerActions: { flexDirection: "row", gap: 8 },
	loading: { marginTop: 48 },
	list: { ...PAGE, paddingHorizontal: 16, paddingBottom: 40, gap: 12, flexGrow: 1 },
	header: { gap: 14, marginBottom: 2 },
	pressed: { opacity: 0.85, transform: [{ scale: 0.985 }] },
	hostCard: {
		flexDirection: "row",
		alignItems: "center",
		gap: 14,
		padding: 14,
		paddingRight: 8,
		borderRadius: RADIUS.lg,
		borderWidth: StyleSheet.hairlineWidth,
	},
	avatarDot: { position: "absolute", right: -3, bottom: -3 },
	hostMain: { flex: 1, gap: 3 },
	hostName: { fontSize: 17, fontWeight: "700" },
	statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
	status: { fontSize: 13, fontWeight: "500", flexShrink: 1 },
	address: { fontSize: 11.5, fontFamily: MONO },
	more: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
	empty: { gap: 10, paddingTop: 28, paddingBottom: 20, alignItems: "center" },
	hero: { width: 104, height: 104, borderRadius: 36, alignItems: "center", justifyContent: "center", marginBottom: 10 },
	heroInner: { width: 68, height: 68, borderRadius: 24, alignItems: "center", justifyContent: "center" },
	emptyTitle: { fontSize: 22 },
	center: { textAlign: "center" },
	steps: {
		alignSelf: "stretch",
		marginTop: 14,
		borderRadius: RADIUS.lg,
		borderWidth: StyleSheet.hairlineWidth,
		paddingVertical: 6,
	},
	step: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
	stepIndex: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
	stepIndexText: { fontSize: 13, fontWeight: "800" },
	stepText: { flex: 1, fontSize: 14.5, lineHeight: 20 },
	hint: { fontSize: 12.5, marginTop: 4 },
	add: { marginTop: 4 },
	addCard: {
		flexDirection: "row",
		alignItems: "center",
		gap: 14,
		padding: 14,
		borderRadius: RADIUS.lg,
		borderWidth: 1.5,
		borderStyle: "dashed",
	},
	addIcon: { width: 50, height: 50, borderRadius: 15, alignItems: "center", justifyContent: "center" },
	addTitle: { fontSize: 16, fontWeight: "700" },
});
