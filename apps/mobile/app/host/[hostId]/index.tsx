import { agentRuntimeLabel } from "@pier/chat-state";
import type { AgentRuntimeId, AgentRuntimeInfo, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { AgentPicker } from "../../../src/components/AgentPicker.tsx";
import { HostStatsCard } from "../../../src/components/HostStatsCard.tsx";
import {
	ActionSheet,
	Avatar,
	Button,
	Card,
	CardHeader,
	HeaderAction,
	Icon,
	IconButton,
	Muted,
	Pill,
	PulseDot,
	Screen,
	type SheetAction,
	StatusDot,
} from "../../../src/components/ui.tsx";
import { isBusy, RUN_STATE_LABEL, relativeTime, sessionTitle, shortPath } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, PAGE, RADIUS, usePalette } from "../../../src/theme.ts";

const SESSIONS_PER_WORKSPACE = 15;

/** Connection state of the computer, with the way out when it is not connected. */
function ConnectionCard({ hostId }: { hostId: string }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const view = useMobileState((s) => s.host);
	const saved = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId));
	const route = view.route;
	const address =
		view.connection === "open" && route
			? route.kind === "direct"
				? `直连 · ${route.address}`
				: route.kind === "p2p"
					? "P2P 直连（经中继建立）"
					: `经中继 · ${route.relay.replace(/^wss?:\/\//, "")}`
			: (saved?.addresses[0] ?? (saved?.relays?.[0] ? `中继 ${saved.relays[0].replace(/^wss?:\/\//, "")}` : undefined));
	const openAddresses = () => router.push({ pathname: "/host/[hostId]/addresses", params: { hostId } });
	if (view.revoked) {
		return (
			<Card flat style={[styles.banner, { borderColor: p.danger, backgroundColor: p.dangerSoft }]}>
				<CardHeader icon="lock-closed-outline" tone="danger" title="无法连接" subtitle={view.error} />
				<Button
					title="重新配对"
					icon="scan-outline"
					variant="primary"
					onPress={() => router.push({ pathname: "/pair", params: { from: hostId } })}
				/>
				<Button
					title="从手机移除这台电脑"
					variant="danger"
					onPress={async () => {
						await store.forgetHost(hostId);
						router.back();
					}}
				/>
			</Card>
		);
	}
	const open = view.connection === "open";
	const reconnecting = view.connection === "reconnecting";
	return (
		<Card flat style={styles.connection}>
			<View style={styles.connectionRow}>
				{open ? (
					<PulseDot color={p.ok} size={8} />
				) : reconnecting ? (
					<StatusDot color={p.warning} size={8} />
				) : (
					<ActivityIndicator size="small" color={p.accentText} />
				)}
				<View style={styles.flex}>
					<Text style={[styles.connectionTitle, { color: open ? p.text : reconnecting ? p.warning : p.text }]}>
						{open ? "已连接" : reconnecting ? "连接中断，正在重连…" : "正在连接…"}
					</Text>
					{address ? (
						<Text style={[styles.connectionAddress, { color: p.faint }]} numberOfLines={1}>
							{address}
						</Text>
					) : null}
				</View>
				{open ? (
					<IconButton icon="swap-horizontal" label="修改连接地址" size={34} tone="elevated" onPress={openAddresses} />
				) : (
					<Button title="重试" icon="refresh" small variant="tonal" onPress={() => store.retryNow()} />
				)}
			</View>
			{!open && view.error ? <Muted style={styles.connectionError}>{view.error}</Muted> : null}
			{reconnecting ? (
				<Pressable
					onPress={openAddresses}
					style={({ pressed }) => [styles.hintRow, { backgroundColor: p.elevated }, pressed && styles.pressed]}
				>
					<Icon name="swap-horizontal" size={16} color={p.accentText} />
					<Text style={[styles.hintText, { color: p.muted }]}>电脑的 IP 变了？修改地址即可，不用重新配对</Text>
					<Icon name="chevron-forward" size={16} color={p.faint} />
				</Pressable>
			) : null}
		</Card>
	);
}

/** Shortcuts to the computer itself: a terminal, pi extensions, and the terminals already open. */
function ToolsCard({ hostId }: { hostId: string }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const online = useMobileState((s) => s.host.connection === "open");
	const terminals = useMobileState((s) => s.host.terminals);
	useMobileState((s) => s.host.info);
	if (!online && !terminals.length) return null;
	const canTerminal = store.canOpenTerminal();
	const canExtensions = store.canManageExtensions();
	if (!canTerminal && !canExtensions && !terminals.length) return null;
	const openTerminal = (id?: number) =>
		router.push({ pathname: "/host/[hostId]/terminal", params: { hostId, ...(id ? { id: String(id) } : {}) } });
	return (
		<Card flat style={styles.tools}>
			<View style={styles.toolRow}>
				{online ? (
					<Pressable
						testID="open-resources"
						onPress={() => router.push({ pathname: "/host/[hostId]/resources", params: { hostId } })}
						style={({ pressed }) => [styles.tool, { backgroundColor: p.elevated }, pressed && styles.pressed]}
					>
						<Icon name="school-outline" size={18} color={p.accentText} />
						<Text style={[styles.toolText, { color: p.text }]}>Skills 与 MCP</Text>
					</Pressable>
				) : null}
				{canTerminal ? (
					<Pressable
						testID="open-terminal"
						disabled={!online}
						onPress={() => openTerminal()}
						style={({ pressed }) => [styles.tool, { backgroundColor: p.elevated }, pressed && styles.pressed]}
					>
						<Icon name="terminal-outline" size={18} color={p.accentText} />
						<Text style={[styles.toolText, { color: p.text }]}>终端</Text>
					</Pressable>
				) : null}
				{canExtensions ? (
					<Pressable
						testID="open-extensions"
						disabled={!online}
						onPress={() => router.push({ pathname: "/host/[hostId]/extensions", params: { hostId } })}
						style={({ pressed }) => [styles.tool, { backgroundColor: p.elevated }, pressed && styles.pressed]}
					>
						<Icon name="extension-puzzle-outline" size={18} color={p.accentText} />
						<Text style={[styles.toolText, { color: p.text }]}>pi 扩展</Text>
					</Pressable>
				) : null}
			</View>
			{terminals.map((terminal) => (
				<Pressable
					key={terminal.id}
					onPress={() => openTerminal(terminal.id)}
					style={({ pressed }) => [styles.terminalRow, { borderColor: p.border }, pressed && styles.pressed]}
				>
					{terminal.status === "running" ? (
						<PulseDot color={p.ok} size={7} />
					) : (
						<StatusDot color={terminal.status === "exited" ? p.faint : p.warning} size={7} />
					)}
					<Text style={[styles.terminalTitle, { color: p.text }]} numberOfLines={1}>
						{terminal.title}
					</Text>
					<Text style={[styles.terminalCwd, { color: p.faint }]} numberOfLines={1} ellipsizeMode="head">
						{terminal.status === "exited" ? "已结束" : shortPath(terminal.cwd)}
					</Text>
					<IconButton icon="close" label="关闭终端" size={28} onPress={() => void store.removeTerminal(terminal.id)} />
				</Pressable>
			))}
		</Card>
	);
}

function SessionMenu({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
	const store = useStore();
	const running = isBusy(session.state);
	const title = sessionTitle(session);
	const actions: SheetAction[] = [];
	// Older computers cannot archive.
	if (store.canArchive()) {
		actions.push(
			session.archived
				? {
						label: "取消归档",
						description: "放回会话列表",
						icon: "arrow-undo-outline",
						testID: "session-unarchive",
						onPress: () => void store.archiveSession(session, false),
					}
				: {
						label: "归档",
						description: "从列表中收起，可随时在“已归档”中找回",
						icon: "archive-outline",
						testID: "session-archive",
						onPress: () => void store.archiveSession(session, true),
					},
		);
	}
	actions.push({
		label: "删除",
		description: running ? "Agent 正在运行，会先中止" : "移到电脑上的 Pier 回收站",
		icon: "trash-outline",
		danger: true,
		testID: "session-delete",
		confirm: {
			title: `删除“${title.length > 40 ? `${title.slice(0, 40)}…` : title}”？`,
			message: `${running ? "Agent 正在运行，会先中止。" : ""}会话文件会移到电脑上的 Pier 回收站（~/.pier/trash/sessions）。`,
			action: "删除",
		},
		onPress: () => void store.deleteSession(session, running),
	});
	return (
		<ActionSheet
			title={title}
			subtitle={[
				session.archived ? "已归档" : running ? RUN_STATE_LABEL[session.state] : "",
				relativeTime(session.modifiedAt),
				`${session.messageCount} 条消息`,
			]
				.filter(Boolean)
				.join(" · ")}
			actions={actions}
			onClose={onClose}
		/>
	);
}

function SessionRow({
	session,
	hostId,
	first,
	onMenu,
}: {
	session: SessionSummary;
	hostId: string;
	first: boolean;
	onMenu: (session: SessionSummary) => void;
}) {
	const router = useRouter();
	const p = usePalette();
	const pending = session.pendingUi ?? 0;
	const busy = isBusy(session.state);
	const runtime = agentRuntimeLabel(session.runtime);
	return (
		<Pressable
			testID={`session-${session.id}`}
			style={({ pressed }) => [
				styles.session,
				{ backgroundColor: pressed ? p.elevated : p.card, borderColor: p.border },
			]}
			onPress={() =>
				router.push({
					pathname: "/host/[hostId]/session/[sessionId]",
					params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
				})
			}
			onLongPress={() => onMenu(session)}
		>
			<View style={[styles.separator, first && styles.separatorFull, { backgroundColor: p.border }]} />
			<View style={styles.indicator}>
				{pending ? <StatusDot color={p.warning} size={8} /> : busy ? <PulseDot color={p.accentText} size={8} /> : null}
			</View>
			<View style={styles.sessionMain}>
				<Text style={[styles.sessionTitle, { color: session.archived ? p.muted : p.text }]} numberOfLines={2}>
					{sessionTitle(session)}
				</Text>
				<View style={styles.metaRow}>
					{session.archived ? (
						<Text style={[styles.badge, { color: p.muted, backgroundColor: p.elevated }]}>已归档</Text>
					) : null}
					<Text style={[styles.badge, { color: p.accentText, backgroundColor: p.accentSoft }]}>{runtime}</Text>
					{pending ? (
						<Pill text={`待批准 ${pending}`} tone="warning" icon="hand-left-outline" />
					) : busy ? (
						<Pill text={RUN_STATE_LABEL[session.state]} tone="accent" />
					) : null}
				</View>
				<View style={styles.metaRow}>
					<Icon name="time-outline" size={12} color={p.faint} />
					<Text style={[styles.sessionMeta, { color: p.faint }]}>{relativeTime(session.modifiedAt)}</Text>
					<Icon name="chatbubble-outline" size={11.5} color={p.faint} style={styles.metaGap} />
					<Text style={[styles.sessionMeta, { color: p.faint }]}>{session.messageCount}</Text>
				</View>
			</View>
			<Icon name="chevron-forward" size={17} color={p.faint} />
		</Pressable>
	);
}

export default function HostScreen() {
	const { hostId } = useLocalSearchParams<{ hostId: string }>();
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const host = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId));
	const view = useMobileState((s) => s.host);
	const [limits, setLimits] = useState<Record<string, number>>({});
	const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
	const [refreshing, setRefreshing] = useState(false);
	const [picker, setPicker] = useState<{ workspace: WorkspaceInfo; runtimes: AgentRuntimeInfo[] }>();
	const [menu, setMenu] = useState<SessionSummary>();

	const createSession = async (workspaceId: string, runtime?: AgentRuntimeId) => {
		const session = await store.createSession(workspaceId, runtime);
		if (session) {
			setPicker(undefined);
			router.push({
				pathname: "/host/[hostId]/session/[sessionId]",
				params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
			});
		}
	};
	const newSession = async (workspace: WorkspaceInfo) => {
		// Let the user pick the agent when the computer can run more than pi.
		const runtimes = await store.availableRuntimes();
		if (runtimes.length < 2) {
			await createSession(workspace.id);
			return;
		}
		setPicker({ workspace, runtimes });
	};

	useEffect(() => {
		if (hostId) store.openHost(hostId);
	}, [hostId, store]);

	const sections = useMemo(
		() =>
			(view.hostId === hostId ? (view.workspaces ?? []) : []).map((workspace: WorkspaceInfo) => {
				const all = view.sessions[workspace.id] ?? [];
				const archived = all.filter((s) => s.archived).length;
				const withArchived = !!showArchived[workspace.id];
				// Archived sessions are listed after the others once shown.
				const sessions = withArchived
					? [...all.filter((s) => !s.archived), ...all.filter((s) => s.archived)]
					: all.filter((s) => !s.archived);
				const limit = limits[workspace.id] ?? SESSIONS_PER_WORKSPACE;
				return {
					workspace,
					total: sessions.length,
					archived,
					withArchived,
					limit,
					running: all.filter((s) => isBusy(s.state)).length,
					data: sessions.slice(0, limit),
				};
			}),
		[view, hostId, limits, showArchived],
	);

	const pendingTotal = sections.reduce(
		(sum, s) => sum + (view.sessions[s.workspace.id] ?? []).reduce((n, x) => n + (x.pendingUi ?? 0), 0),
		0,
	);
	const online = view.hostId === hostId && view.connection === "open";
	const addWorkspace = () => {
		if (!store.canAddWorkspace()) {
			store.toast("error", "这台电脑上的 Pier 版本较旧，请先升级，或在电脑上添加工作区");
			return;
		}
		router.push({ pathname: "/host/[hostId]/add-workspace", params: { hostId } });
	};
	const openWorkspace = (workspaceId: string) =>
		router.push({ pathname: "/host/[hostId]/workspace/[workspaceId]", params: { hostId, workspaceId } });
	const openFiles = (workspaceId: string) =>
		router.push({ pathname: "/host/[hostId]/files", params: { hostId, workspaceId } });
	const canBrowseFiles = online && store.canBrowseFiles();

	return (
		<Screen safeBottom>
			<Stack.Screen
				options={{
					title: host?.hostName ?? "电脑",
					headerRight: () =>
						online ? <HeaderAction label="添加工作区" icon="add" text="工作区" onPress={addWorkspace} /> : null,
				}}
			/>
			<SectionList
				sections={sections}
				keyExtractor={(item) => item.id}
				contentContainerStyle={styles.list}
				stickySectionHeadersEnabled={false}
				// Android defaults this to true, and with the new architecture removing a whole section (a
				// workspace) while cells are clipped crashes natively ("Cannot remove child at index").
				removeClippedSubviews={false}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						tintColor={p.accent}
						colors={[p.accent]}
						onRefresh={async () => {
							setRefreshing(true);
							await store.loadWorkspaces();
							setRefreshing(false);
						}}
					/>
				}
				ListHeaderComponent={
					<View style={styles.header}>
						{hostId ? <ConnectionCard hostId={hostId} /> : null}
						{view.hostId === hostId ? <HostStatsCard /> : null}
						{hostId && view.hostId === hostId ? <ToolsCard hostId={hostId} /> : null}
						{pendingTotal ? (
							<Card flat style={[styles.pending, { borderColor: p.warningSoft, backgroundColor: p.warningSoft }]}>
								<Icon name="hand-left" size={18} color={p.warning} />
								<Text style={[styles.pendingText, { color: p.warning }]}>有 {pendingTotal} 个请求等待你批准</Text>
							</Card>
						) : null}
						{view.connection === "open" && view.workspaces && !view.workspaces.length ? (
							<Card style={styles.emptyWorkspaces}>
								<View style={[styles.emptyIcon, { backgroundColor: p.accentSoft }]}>
									<Icon name="folder-open-outline" size={30} color={p.accentText} />
								</View>
								<Text style={[styles.emptyTitle, { color: p.text }]}>还没有工作区</Text>
								<Muted style={styles.centerText}>
									{store.canAddWorkspace()
										? "选择电脑上的一个目录作为工作区，Agent 会在其中运行。"
										: "这台电脑上的 Pier 版本较旧，请先在电脑的 Pier 中添加一个工作区目录。"}
								</Muted>
								{store.canAddWorkspace() ? (
									<Button
										title="添加工作区"
										icon="add"
										variant="primary"
										onPress={addWorkspace}
										testID="add-workspace-empty"
										style={styles.stretch}
									/>
								) : null}
							</Card>
						) : null}
					</View>
				}
				renderSectionHeader={({ section }) => (
					<View style={[styles.sectionHeader, { backgroundColor: p.card, borderColor: p.border }]}>
						<Pressable
							testID={`workspace-${section.workspace.id}`}
							accessibilityRole="button"
							accessibilityLabel={`工作区设置：${section.workspace.name}`}
							onPress={() => openWorkspace(section.workspace.id)}
							style={({ pressed }) => [styles.sectionInfo, pressed && styles.pressed]}
						>
							<Avatar name={section.workspace.name} size={36} icon="folder-open" tone="accent" />
							<View style={styles.flex}>
								<View style={styles.nameRow}>
									<Text style={[styles.workspaceName, { color: p.text }]} numberOfLines={1}>
										{section.workspace.name}
									</Text>
									{section.running ? <PulseDot color={p.accentText} size={7} /> : null}
								</View>
								<Text style={[styles.path, { color: p.faint }]} numberOfLines={1} ellipsizeMode="head">
									{shortPath(section.workspace.path)}
								</Text>
							</View>
						</Pressable>
						<View style={styles.workspaceActions}>
							<Text style={[styles.workspaceCount, { color: p.muted }]}>
								{section.total} 个会话{section.running ? ` · ${section.running} 运行中` : ""}
							</Text>
							{canBrowseFiles ? (
								<IconButton
									icon="folder-outline"
									label={`浏览文件：${section.workspace.name}`}
									size={44}
									testID={`files-${section.workspace.id}`}
									onPress={() => openFiles(section.workspace.id)}
								/>
							) : null}
							<IconButton
								icon="options-outline"
								label={`工作区设置：${section.workspace.name}`}
								size={44}
								onPress={() => openWorkspace(section.workspace.id)}
							/>
							<Button
								icon="add"
								title="新建会话"
								variant="primary"
								small
								disabled={view.connection !== "open"}
								testID={`new-session-${section.workspace.id}`}
								onPress={() => void newSession(section.workspace)}
							/>
						</View>
					</View>
				)}
				renderItem={({ item, index }) => (
					<SessionRow session={item} hostId={hostId} first={index === 0} onMenu={setMenu} />
				)}
				renderSectionFooter={({ section }) => (
					<View style={[styles.sectionFooter, { backgroundColor: p.card, borderColor: p.border }]}>
						{section.total > section.limit ? (
							<Pressable
								style={({ pressed }) => [styles.footerRow, { borderColor: p.border }, pressed && styles.pressed]}
								onPress={() => setLimits({ ...limits, [section.workspace.id]: section.limit + SESSIONS_PER_WORKSPACE })}
							>
								<Text style={[styles.footerText, { color: p.accentText }]}>
									显示更多（还有 {section.total - section.limit} 个）
								</Text>
								<Icon name="chevron-down" size={15} color={p.accentText} />
							</Pressable>
						) : section.total === 0 ? (
							<View style={[styles.none, { borderColor: p.border }]}>
								<Icon name={section.archived ? "archive-outline" : "chatbubbles-outline"} size={22} color={p.faint} />
								<Muted>{section.archived ? "会话都已归档" : "还没有会话，点「新建会话」开始"}</Muted>
							</View>
						) : null}
						{section.archived ? (
							<Pressable
								accessibilityRole="button"
								style={({ pressed }) => [styles.footerRow, { borderColor: p.border }, pressed && styles.pressed]}
								onPress={() => setShowArchived({ ...showArchived, [section.workspace.id]: !section.withArchived })}
							>
								<Icon name="archive-outline" size={15} color={p.muted} />
								<Text style={[styles.footerText, { color: p.muted }]}>
									{section.withArchived ? "收起已归档" : `已归档 ${section.archived} 个`}
								</Text>
								<Icon name={section.withArchived ? "chevron-up" : "chevron-down"} size={15} color={p.faint} />
							</Pressable>
						) : null}
					</View>
				)}
			/>
			{menu ? <SessionMenu session={menu} onClose={() => setMenu(undefined)} /> : null}
			{picker ? (
				<AgentPicker
					runtimes={picker.runtimes}
					workspaceName={picker.workspace.name}
					onPick={(runtime) => createSession(picker.workspace.id, runtime)}
					onClose={() => setPicker(undefined)}
				/>
			) : null}
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	centerText: { textAlign: "center" },
	stretch: { alignSelf: "stretch", marginTop: 6 },
	list: { ...PAGE, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 48 },
	header: { gap: 10, marginBottom: 6 },
	banner: { gap: 12 },
	connection: { gap: 10, paddingVertical: 12, paddingHorizontal: 14 },
	connectionRow: { flexDirection: "row", alignItems: "center", gap: 12 },
	connectionTitle: { fontSize: 14.5, fontWeight: "600" },
	connectionAddress: { fontSize: 11.5, fontFamily: MONO, marginTop: 1 },
	connectionError: { fontSize: 12.5, lineHeight: 18 },
	hintRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderRadius: RADIUS.md,
	},
	hintText: { flex: 1, fontSize: 12.5 },
	pending: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12 },
	tools: { gap: 8, paddingVertical: 10, paddingHorizontal: 10 },
	toolRow: { flexDirection: "row", gap: 8 },
	tool: {
		flex: 1,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 7,
		height: 42,
		borderRadius: RADIUS.md,
	},
	toolText: { fontSize: 14.5, fontWeight: "600" },
	terminalRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingLeft: 6,
		paddingTop: 6,
		borderTopWidth: StyleSheet.hairlineWidth,
	},
	terminalTitle: { fontSize: 14, fontWeight: "600", maxWidth: "40%" },
	terminalCwd: { flex: 1, fontSize: 11.5, fontFamily: MONO },
	pendingText: { fontSize: 14, fontWeight: "600", flex: 1 },
	emptyWorkspaces: { alignItems: "center", gap: 8, paddingVertical: 28 },
	emptyIcon: {
		width: 64,
		height: 64,
		borderRadius: 22,
		alignItems: "center",
		justifyContent: "center",
		marginBottom: 6,
	},
	emptyTitle: { fontSize: 18, fontWeight: "700" },
	sectionHeader: {
		gap: 10,
		marginTop: 14,
		paddingLeft: 14,
		paddingRight: 10,
		paddingVertical: 12,
		borderTopLeftRadius: RADIUS.lg,
		borderTopRightRadius: RADIUS.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderBottomWidth: 0,
	},
	sectionInfo: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
	workspaceActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
	workspaceCount: { flex: 1, fontSize: 12, marginRight: 4 },
	nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	workspaceName: { fontSize: 16.5, fontWeight: "700", flexShrink: 1 },
	path: { fontSize: 11.5, fontFamily: MONO, marginTop: 3 },
	pressed: { opacity: 0.6 },
	session: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 13,
		paddingLeft: 10,
		paddingRight: 14,
		borderLeftWidth: StyleSheet.hairlineWidth,
		borderRightWidth: StyleSheet.hairlineWidth,
	},
	separator: { position: "absolute", top: 0, left: 28, right: 0, height: StyleSheet.hairlineWidth },
	separatorFull: { left: 0 },
	indicator: { width: 8, alignItems: "center", alignSelf: "flex-start", marginTop: 8 },
	sessionMain: { flex: 1, gap: 6 },
	sessionTitle: { fontSize: 15, lineHeight: 21, fontWeight: "500" },
	metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
	metaGap: { marginLeft: 8 },
	sessionMeta: { fontSize: 12 },
	badge: {
		fontSize: 11,
		fontWeight: "600",
		paddingHorizontal: 6,
		paddingVertical: 1,
		borderRadius: 6,
		overflow: "hidden",
		marginRight: 4,
	},
	sectionFooter: {
		minHeight: 8,
		borderBottomLeftRadius: RADIUS.lg,
		borderBottomRightRadius: RADIUS.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderTopWidth: 0,
		overflow: "hidden",
	},
	footerRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		paddingVertical: 12,
		borderTopWidth: StyleSheet.hairlineWidth,
	},
	footerText: { fontSize: 13.5, fontWeight: "600" },
	none: {
		alignItems: "center",
		gap: 6,
		paddingVertical: 20,
		paddingHorizontal: 16,
		borderTopWidth: StyleSheet.hairlineWidth,
	},
});
