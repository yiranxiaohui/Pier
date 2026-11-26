import {
	agentRuntimeLabel,
	summarizeUsage,
	USAGE_ESTIMATE_HINT,
	type UsageBucket,
	type UsageGroup,
	type UsageSource,
	type UsageTotals,
	usageCostNote,
	usageCostText,
	usageSince,
} from "@pier/chat-state";
import type { AgentRuntimeId } from "@pier/protocol";
import { Stack, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card, Icon, Muted, Screen } from "../src/components/ui.tsx";
import { formatCost, formatPercent, formatTokens, relativeTime } from "../src/format.ts";
import { USAGE_RANGE_DAYS, type UsageRange, useMobileState, useStore } from "../src/store.ts";
import { PAGE, type Palette, RADIUS, usePalette } from "../src/theme.ts";

const RANGES: { value: UsageRange; label: string }[] = [
	{ value: "today", label: "今天" },
	{ value: "7d", label: "近 7 天" },
	{ value: "30d", label: "近 30 天" },
	{ value: "all", label: "全部" },
];

/** Agents in their fixed colour order, as on the desktop: a filter never repaints the others. */
const RUNTIMES: AgentRuntimeId[] = ["pi", "claude-code", "codex", "opencode", "hermes"];
const COLORS = {
	dark: ["#338ced", "#e76624", "#00a888", "#d28e05", "#e24d8b", "#8a867f"],
	light: ["#257de0", "#f47230", "#00b894", "#f2a600", "#ee7fac", "#9a958c"],
};

function runtimeColor(p: Palette, runtime: string): string {
	const colors = p.dark ? COLORS.dark : COLORS.light;
	const index = RUNTIMES.indexOf(runtime);
	return colors[index === -1 ? colors.length - 1 : index] as string;
}

type Dimension = "runtime" | "model" | "workspace" | "node";
const ALL = "*";

function costText(totals: UsageTotals): string {
	return usageCostText(totals, formatCost);
}

function Chips<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange(value: T): void;
}) {
	const p = usePalette();
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
			<View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.chipsRow}>
				{options.map((option) => {
					const selected = option.value === value;
					return (
						<Pressable
							key={option.value}
							accessibilityRole="radio"
							accessibilityLabel={option.label}
							accessibilityState={{ checked: selected }}
							onPress={() => onChange(option.value)}
							style={({ pressed }) => [
								styles.chip,
								{
									backgroundColor: selected ? p.accentSoft : p.elevated,
									borderColor: selected ? p.accent : p.border,
								},
								pressed && { opacity: 0.7 },
							]}
						>
							<Text style={[styles.chipText, { color: selected ? p.accentText : p.text }]}>{option.label}</Text>
						</Pressable>
					);
				})}
			</View>
		</ScrollView>
	);
}

function Stat({ label, value, note, hero }: { label: string; value: string; note?: string; hero?: boolean }) {
	const p = usePalette();
	return (
		<View style={[styles.stat, hero && styles.statHero, { backgroundColor: p.elevated, borderColor: p.border }]}>
			<Text style={[styles.statLabel, { color: p.muted }]}>{label}</Text>
			<Text style={[hero ? styles.statHeroValue : styles.statValue, { color: p.text }]}>{value}</Text>
			{note ? (
				<Text style={[styles.statNote, { color: p.faint }]} numberOfLines={1}>
					{note}
				</Text>
			) : null}
		</View>
	);
}

function bucketLabel(key: string, granularity: "day" | "month"): string {
	const [y, m, d] = key.split("-");
	return granularity === "month" ? `${y} 年 ${Number(m)} 月` : `${Number(m)} 月 ${Number(d)} 日`;
}

function UsageChart({ buckets, granularity }: { buckets: UsageBucket[]; granularity: "day" | "month" }) {
	const p = usePalette();
	const [selected, setSelected] = useState<number>();
	const max = Math.max(1, ...buckets.map((b) => b.total));
	const index = selected !== undefined && selected < buckets.length ? selected : undefined;
	const shown = index !== undefined ? buckets[index] : undefined;
	const first = buckets[0];
	const last = buckets[buckets.length - 1];
	return (
		<View>
			<View style={styles.chart}>
				{buckets.map((bucket, i) => {
					const segments = Object.entries(bucket.byRuntime)
						.filter(([, tokens]) => (tokens ?? 0) > 0)
						.sort(([a], [b]) => RUNTIMES.indexOf(b) - RUNTIMES.indexOf(a));
					return (
						<Pressable
							key={bucket.key}
							style={[styles.chartColumn, i === index && { backgroundColor: p.elevated }]}
							accessibilityLabel={`${bucketLabel(bucket.key, granularity)}：${bucket.total.toLocaleString()} token`}
							onPress={() => setSelected(i === index ? undefined : i)}
						>
							<View style={[styles.chartStack, { height: `${(bucket.total / max) * 100}%` }]}>
								{segments.map(([runtime, tokens], s) => (
									<View
										key={runtime}
										style={[
											styles.chartSegment,
											{ flexGrow: tokens ?? 0, backgroundColor: runtimeColor(p, runtime) },
											s === 0 && styles.chartTop,
										]}
									/>
								))}
							</View>
						</Pressable>
					);
				})}
			</View>
			<View style={[styles.chartAxis, { borderTopColor: p.border }]}>
				<Text style={[styles.axisText, { color: p.faint }]}>{first ? bucketLabel(first.key, granularity) : ""}</Text>
				<Text style={[styles.axisText, { color: p.faint }]}>
					{last && last !== first ? bucketLabel(last.key, granularity) : ""}
				</Text>
			</View>
			{shown ? (
				<View style={[styles.chartDetail, { borderColor: p.border }]}>
					<Text style={[styles.detailTitle, { color: p.text }]}>
						{bucketLabel(shown.key, granularity)} · {formatTokens(shown.total)}
					</Text>
					{RUNTIMES.concat(Object.keys(shown.byRuntime).filter((r) => !RUNTIMES.includes(r)))
						.filter((r) => (shown.byRuntime[r] ?? 0) > 0)
						.map((r) => (
							<View key={r} style={styles.legendRow}>
								<View style={[styles.swatch, { backgroundColor: runtimeColor(p, r) }]} />
								<Text style={[styles.legendText, { color: p.muted }]}>{agentRuntimeLabel(r)}</Text>
								<Text style={[styles.legendValue, { color: p.text }]}>
									{(shown.byRuntime[r] ?? 0).toLocaleString()}
								</Text>
							</View>
						))}
				</View>
			) : (
				<Muted style={styles.chartHint}>轻点柱子查看当天各 Agent 的用量</Muted>
			)}
		</View>
	);
}

function GroupRow({ group, total, swatch }: { group: UsageGroup; total: number; swatch?: string }) {
	const p = usePalette();
	const share = total > 0 ? group.total / total : 0;
	return (
		<View style={[styles.groupRow, { borderTopColor: p.border }]}>
			<View style={styles.groupHead}>
				{swatch ? <View style={[styles.swatch, { backgroundColor: swatch }]} /> : null}
				<Text style={[styles.groupName, { color: p.text }]} numberOfLines={1}>
					{group.label}
				</Text>
				{group.detail ? (
					<Text style={[styles.groupDetail, { color: p.faint }]} numberOfLines={1}>
						{group.detail}
					</Text>
				) : null}
				<Text style={[styles.groupValue, { color: p.text }]}>{formatTokens(group.total)}</Text>
			</View>
			<View style={styles.groupBarRow}>
				<View style={[styles.groupBar, { backgroundColor: p.elevated }]}>
					<View style={[styles.groupBarFill, { width: `${share * 100}%`, backgroundColor: p.muted }]} />
				</View>
				<Text style={[styles.groupShare, { color: p.muted }]}>{formatPercent(share)}</Text>
			</View>
			<Text style={[styles.groupNote, { color: p.faint }]} numberOfLines={1}>
				输入 {formatTokens(group.input)} · 输出 {formatTokens(group.output)} · 缓存读取 {formatTokens(group.cacheRead)}{" "}
				· {group.requests.toLocaleString()} 次请求 · {costText(group)}
			</Text>
		</View>
	);
}

export default function UsageScreen() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const hosts = useMobileState((s) => s.hosts);
	const connections = useMobileState((s) => s.connections);
	const range = useMobileState((s) => s.usageRange);
	const data = useMobileState((s) => s.usage);
	const [node, setNode] = useState<string>(ALL);
	const [runtime, setRuntime] = useState<string>(ALL);
	const [dimension, setDimension] = useState<Dimension>("runtime");

	// biome-ignore lint/correctness/useExhaustiveDependencies: read once when the screen opens.
	useEffect(() => store.loadUsage(), []);
	// Computers that connect while the screen is open are read then.
	useEffect(() => {
		for (const host of hosts) {
			const state = data[host.hostId]?.state;
			const view = connections[host.hostId];
			const ready = view?.connection === "open" && !!view.info;
			// Connected (or gave up) since it was last read.
			if (
				((state === "connecting" || state === "offline") && ready) ||
				(state === "connecting" && view?.connection === "closed")
			)
				void store.loadUsageOf(host.hostId);
		}
	}, [store, hosts, connections, data]);

	const sources = useMemo<UsageSource[]>(
		() =>
			hosts.flatMap((host) => {
				const entry = data[host.hostId];
				if (!entry?.stats || entry.range !== range) return [];
				const workspaces = connections[host.hostId]?.workspaces ?? [];
				return [
					{
						node: host.hostId,
						nodeName: host.hostName,
						stats: entry.stats,
						workspaceNames: Object.fromEntries(workspaces.map((w) => [w.id, w.name])),
					},
				];
			}),
		[hosts, data, connections, range],
	);
	const since = range === "all" ? undefined : usageSince(USAGE_RANGE_DAYS[range]);
	const summary = useMemo(
		() =>
			summarizeUsage(
				sources,
				{
					...(since ? { since } : {}),
					...(node !== ALL ? { node } : {}),
					...(runtime !== ALL ? { runtime } : {}),
				},
				undefined,
				10,
			),
		[sources, since, node, runtime],
	);
	const runtimesSeen = useMemo(() => {
		const seen = new Set<string>();
		for (const source of sources) for (const session of source.stats.sessions) seen.add(session.runtime);
		return [...RUNTIMES.filter((r) => seen.has(r)), ...[...seen].filter((r) => !RUNTIMES.includes(r))];
	}, [sources]);
	const busy = hosts.some((h) => data[h.hostId]?.state === "loading" || data[h.hostId]?.state === "connecting");
	const anyLoaded = hosts.some((h) => data[h.hostId]?.range === range && data[h.hostId]?.stats);
	const notices = hosts.flatMap((host) => {
		if (node !== ALL && node !== host.hostId) return [];
		const entry = data[host.hostId];
		const notes: string[] = [];
		if (entry?.state === "offline") notes.push(`${host.hostName} 未连接，没有计入`);
		if (entry?.state === "unsupported") notes.push(`${host.hostName} 上的 Pier 版本较旧，更新后才能统计用量`);
		if (entry?.state === "error") notes.push(`${host.hostName} 的用量读取失败：${entry.error ?? "未知错误"}`);
		if (entry?.stats?.errors?.length) notes.push(`${host.hostName} 有 ${entry.stats.errors.length} 处用量没能读取`);
		return notes;
	});
	const { totals } = summary;
	const groups = {
		runtime: summary.byRuntime,
		model: summary.byModel,
		workspace: summary.byWorkspace,
		node: summary.byNode,
	}[dimension];
	const costNote = usageCostNote(totals);

	return (
		<Screen safeBottom>
			<Stack.Screen options={{ title: "用量统计" }} />
			<ScrollView
				contentContainerStyle={styles.content}
				refreshControl={<RefreshControl refreshing={false} onRefresh={() => store.loadUsage()} />}
			>
				<Chips label="时间范围" value={range} options={RANGES} onChange={(r) => store.setUsageRange(r)} />
				{hosts.length > 1 ? (
					<Chips
						label="电脑"
						value={node}
						options={[{ value: ALL, label: "全部电脑" }, ...hosts.map((h) => ({ value: h.hostId, label: h.hostName }))]}
						onChange={setNode}
					/>
				) : null}
				{runtimesSeen.length > 1 || runtime !== ALL ? (
					<Chips
						label="Agent"
						value={runtime}
						options={[
							{ value: ALL, label: "全部 Agent" },
							...runtimesSeen.map((r) => ({ value: r, label: agentRuntimeLabel(r) })),
						]}
						onChange={setRuntime}
					/>
				) : null}

				{notices.length ? (
					<View style={[styles.notice, { backgroundColor: p.warningSoft, borderColor: p.warning }]}>
						{notices.map((text) => (
							<Text key={text} style={[styles.noticeText, { color: p.text }]}>
								{text}
							</Text>
						))}
					</View>
				) : null}

				{hosts.length === 0 ? (
					<Muted style={styles.empty}>还没有配对电脑。</Muted>
				) : !anyLoaded && busy ? (
					<View style={styles.empty}>
						<ActivityIndicator color={p.accentText} />
						<Muted>正在读取各电脑的会话记录…</Muted>
					</View>
				) : totals.requests === 0 ? (
					<View style={styles.empty}>
						<Icon name="bar-chart-outline" size={26} color={p.faint} />
						<Muted>{busy ? "正在读取…" : "这段时间没有用量"}</Muted>
					</View>
				) : (
					<>
						<View style={styles.stats}>
							<Stat
								hero
								label="总 Token"
								value={formatTokens(totals.total)}
								note={`${totals.requests.toLocaleString()} 次请求 · ${totals.sessions.toLocaleString()} 个会话${busy ? " · 更新中…" : ""}`}
							/>
							<Stat label="输入" value={formatTokens(totals.input)} note="未命中缓存" />
							<Stat label="输出" value={formatTokens(totals.output)} note="含推理" />
							<Stat
								label="缓存读取"
								value={formatTokens(totals.cacheRead)}
								{...(summary.cacheHitRate !== undefined
									? { note: `命中率 ${formatPercent(summary.cacheHitRate)}` }
									: {})}
							/>
							<Stat label="缓存写入" value={formatTokens(totals.cacheWrite)} />
							<Stat label="费用" value={costText(totals)} {...(costNote ? { note: costNote } : {})} />
						</View>

						<Card style={styles.card}>
							<Text style={[styles.cardTitle, { color: p.text }]}>
								{summary.granularity === "month" ? "每月用量" : "每日用量"}
							</Text>
							<UsageChart buckets={summary.buckets} granularity={summary.granularity} />
							{runtimesSeen.length > 1 && runtime === ALL ? (
								<View style={styles.legend}>
									{runtimesSeen.map((r) => (
										<View key={r} style={styles.legendItem}>
											<View style={[styles.swatch, { backgroundColor: runtimeColor(p, r) }]} />
											<Text style={[styles.legendText, { color: p.muted }]}>{agentRuntimeLabel(r)}</Text>
										</View>
									))}
								</View>
							) : null}
						</Card>

						<Card style={styles.card}>
							<Text style={[styles.cardTitle, { color: p.text }]}>用量构成</Text>
							<Chips<Dimension>
								label="分组"
								value={dimension}
								options={[
									{ value: "runtime", label: "按 Agent" },
									{ value: "model", label: "按模型" },
									{ value: "workspace", label: "按工作区" },
									...(hosts.length > 1 ? [{ value: "node" as const, label: "按电脑" }] : []),
								]}
								onChange={setDimension}
							/>
							{groups.slice(0, 12).map((group) => (
								<GroupRow
									key={group.key}
									group={group}
									total={totals.total}
									{...(dimension === "runtime" ? { swatch: runtimeColor(p, group.key) } : {})}
								/>
							))}
						</Card>

						<Card style={styles.card}>
							<Text style={[styles.cardTitle, { color: p.text }]}>用量最多的会话</Text>
							{summary.topSessions.map((session) => (
								<Pressable
									key={`${session.node}:${session.sessionId}`}
									style={({ pressed }) => [styles.session, { borderTopColor: p.border }, pressed && { opacity: 0.6 }]}
									onPress={() =>
										router.push({
											pathname: "/host/[hostId]/session/[sessionId]",
											params: { hostId: session.node, sessionId: session.sessionId, workspaceId: session.workspaceId },
										})
									}
								>
									<View style={[styles.swatch, { backgroundColor: runtimeColor(p, session.runtime) }]} />
									<View style={styles.sessionMain}>
										<Text style={[styles.sessionTitle, { color: p.text }]} numberOfLines={1}>
											{session.title || "未命名会话"}
										</Text>
										<Text style={[styles.sessionMeta, { color: p.faint }]} numberOfLines={1}>
											{agentRuntimeLabel(session.runtime)} · {session.workspaceName ?? "已移除的工作区"}
											{hosts.length > 1 ? ` · ${session.nodeName}` : ""} · {relativeTime(session.modifiedAt)}
											{session.archived ? " · 已归档" : ""}
										</Text>
									</View>
									<Text style={[styles.sessionValue, { color: p.text }]}>{formatTokens(session.total)}</Text>
								</Pressable>
							))}
						</Card>
						<Muted style={styles.footnote}>
							统计各电脑 Pier 工作区中的会话（含 Subagent），已删除的会话不计入。Hermes
							只记录每个会话的合计，计在最后活动的那天。
							{totals.estimatedRequests > 0 ? `“≈”表示估算：${USAGE_ESTIMATE_HINT}` : ""}
						</Muted>
					</>
				)}
			</ScrollView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	content: { ...PAGE, padding: 16, gap: 12, paddingBottom: 32 },
	chips: { flexGrow: 1 },
	chipsRow: { flexDirection: "row", gap: 8 },
	chip: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: 12, paddingVertical: 7 },
	chipText: { fontSize: 13, fontWeight: "500" },
	notice: { borderWidth: 1, borderRadius: RADIUS.md, padding: 12, gap: 4 },
	noticeText: { fontSize: 13 },
	empty: { alignItems: "center", gap: 10, paddingVertical: 48 },
	stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	stat: { flexBasis: "47%", flexGrow: 1, borderWidth: 1, borderRadius: RADIUS.lg, padding: 12, gap: 4 },
	statHero: { flexBasis: "100%" },
	statLabel: { fontSize: 12 },
	statValue: { fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] },
	statHeroValue: { fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
	statNote: { fontSize: 11.5 },
	card: { gap: 12 },
	cardTitle: { fontSize: 15, fontWeight: "600" },
	chart: { flexDirection: "row", alignItems: "flex-end", height: 140 },
	chartColumn: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center", borderRadius: 4 },
	chartStack: { width: "70%", maxWidth: 22, gap: 2, overflow: "hidden" },
	chartSegment: { flexBasis: 0, minHeight: 2 },
	chartTop: { borderTopLeftRadius: 4, borderTopRightRadius: 4 },
	chartAxis: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, paddingTop: 6 },
	axisText: { fontSize: 11, fontVariant: ["tabular-nums"] },
	chartHint: { marginTop: 8, fontSize: 12 },
	chartDetail: { marginTop: 10, borderTopWidth: 1, paddingTop: 10, gap: 6 },
	detailTitle: { fontSize: 13, fontWeight: "600" },
	legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
	legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
	legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	legendText: { fontSize: 12 },
	legendValue: { marginLeft: "auto", fontSize: 12, fontVariant: ["tabular-nums"] },
	swatch: { width: 9, height: 9, borderRadius: 3 },
	groupRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 6 },
	groupHead: { flexDirection: "row", alignItems: "center", gap: 8 },
	groupName: { flexShrink: 1, fontSize: 14, fontWeight: "500" },
	groupDetail: { flexShrink: 1, fontSize: 12 },
	groupValue: { marginLeft: "auto", fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
	groupBarRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	groupBar: { flex: 1, height: 5, borderRadius: RADIUS.pill, overflow: "hidden" },
	groupBarFill: { height: "100%", borderRadius: RADIUS.pill },
	groupShare: { width: 44, textAlign: "right", fontSize: 12, fontVariant: ["tabular-nums"] },
	groupNote: { fontSize: 11.5 },
	session: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		borderTopWidth: StyleSheet.hairlineWidth,
		paddingTop: 10,
	},
	sessionMain: { flex: 1, gap: 3 },
	sessionTitle: { fontSize: 14, fontWeight: "500" },
	sessionMeta: { fontSize: 12 },
	sessionValue: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
	footnote: { fontSize: 12, textAlign: "center", paddingHorizontal: 8 },
});
