import {
	agentRuntimeLabel,
	summarizeUsage,
	USAGE_ESTIMATE_HINT,
	type UsageBucket,
	type UsageGroup,
	type UsageSessionGroup,
	type UsageSource,
	type UsageTotals,
	usageCostNote,
	usageCostText,
	usageSince,
} from "@pier/chat-state";
import type { AgentRuntimeId } from "@pier/protocol";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { formatCost, formatPercent, formatTokens, relativeTime } from "../lib/format.ts";
import {
	type ComputerInfo,
	USAGE_RANGE_DAYS,
	type UsageNodeData,
	type UsageRange,
	useAppState,
	useComputers,
	useStore,
} from "../lib/store.tsx";
import { AgentIcon } from "./AgentIcons.tsx";
import { IconChartColumn, IconLoader, IconRefresh } from "./Icons.tsx";
import { Select } from "./Select.tsx";

const RANGES: { value: UsageRange; label: string }[] = [
	{ value: "today", label: "今天" },
	{ value: "7d", label: "近 7 天" },
	{ value: "30d", label: "近 30 天" },
	{ value: "all", label: "全部" },
];

/** Agents in their fixed colour order: a filter never repaints the ones that stay. */
const RUNTIMES: AgentRuntimeId[] = ["pi", "claude-code", "codex", "opencode", "hermes"];

type Dimension = "runtime" | "model" | "workspace" | "node";

const ALL = "*";

function runtimeColor(runtime: string): string {
	return RUNTIMES.includes(runtime) ? `var(--usage-${runtime})` : "var(--usage-other)";
}

function exact(n: number): string {
	return n.toLocaleString();
}

/** Cost of the counted requests; “—” when none has one, “≈” when it includes estimates. */
function costText(totals: UsageTotals): string {
	return usageCostText(totals, formatCost);
}

/** A table cell with a cost; hovering it says what the cost estimates or leaves out. */
function CostCell({ totals }: { totals: UsageTotals }) {
	const note = usageCostNote(totals);
	return (
		<td className="num" {...(note ? { title: note } : {})}>
			{costText(totals)}
		</td>
	);
}

function nodeNotice(computer: ComputerInfo, data: UsageNodeData | undefined): string | undefined {
	switch (data?.state) {
		case "offline":
			return `${computer.name} 未连接，没有计入`;
		case "unsupported":
			return `${computer.name} 上的 Pier 版本较旧，不能统计用量，更新后再试`;
		case "error":
			return `${computer.name} 的用量读取失败：${data.error ?? "未知错误"}`;
		default:
			return undefined;
	}
}

export function UsagePage({ footer }: { footer?: ReactNode } = {}) {
	const store = useStore();
	const computers = useComputers();
	const range = useAppState((s) => s.usageRange);
	const data = useAppState((s) => s.usageData);
	const [node, setNode] = useState<string>(ALL);
	const [runtime, setRuntime] = useState<string>(ALL);
	const [dimension, setDimension] = useState<Dimension>("runtime");

	// A computer that connects while the page is open is read then.
	useEffect(() => {
		for (const computer of computers) {
			if (computer.online && data[computer.id]?.state === "offline") void store.loadUsageOf(computer.id);
		}
	}, [store, computers, data]);

	const sources = useMemo<UsageSource[]>(
		() =>
			computers.flatMap((computer) => {
				const entry = data[computer.id];
				if (!entry?.stats || entry.range !== range) return [];
				return [
					{
						node: computer.id,
						nodeName: computer.name,
						stats: entry.stats,
						workspaceNames: Object.fromEntries(computer.state.workspaces.map((w) => [w.id, w.name])),
					},
				];
			}),
		[computers, data, range],
	);
	const since = range === "all" ? undefined : usageSince(USAGE_RANGE_DAYS[range]);
	const summary = useMemo(
		() =>
			summarizeUsage(sources, {
				...(since ? { since } : {}),
				...(node !== ALL ? { node } : {}),
				...(runtime !== ALL ? { runtime } : {}),
			}),
		[sources, since, node, runtime],
	);
	const loading = computers.some((c) => data[c.id]?.state === "loading");
	const loaded = computers.some((c) => data[c.id]?.range === range && data[c.id]?.state !== "loading");
	const runtimesSeen = useMemo(() => {
		const seen = new Set<string>();
		for (const source of sources) for (const session of source.stats.sessions) seen.add(session.runtime);
		return [...RUNTIMES.filter((r) => seen.has(r)), ...[...seen].filter((r) => !RUNTIMES.includes(r))];
	}, [sources]);
	const notices = computers.flatMap((computer) => {
		if (node !== ALL && node !== computer.id) return [];
		const entry = data[computer.id];
		const notice = nodeNotice(computer, entry);
		const partial = entry?.stats?.errors?.length
			? `${computer.name} 有 ${entry.stats.errors.length} 处用量没能读取：${entry.stats.errors[0]?.message ?? ""}`
			: undefined;
		return [notice, partial].filter((text): text is string => !!text);
	});
	const groups =
		dimension === "runtime"
			? summary.byRuntime
			: dimension === "model"
				? summary.byModel
				: dimension === "workspace"
					? summary.byWorkspace
					: summary.byNode;
	const { totals } = summary;

	return (
		<div className="usage-page">
			<div className="usage-scroll">
				<div className="usage-content">
					<header className="usage-header">
						<div className="usage-heading">
							<h2>用量统计</h2>
							<p>各电脑 Pier 工作区中 Agent 会话的 token 用量，含 Subagent</p>
						</div>
						<div className="usage-controls">
							<div className="segmented" role="tablist" aria-label="时间范围">
								{RANGES.map((item) => (
									<button
										type="button"
										key={item.value}
										role="tab"
										aria-selected={range === item.value}
										className={range === item.value ? "active" : ""}
										onClick={() => store.setUsageRange(item.value)}
									>
										{item.label}
									</button>
								))}
							</div>
							{computers.length > 1 ? (
								<Select
									ariaLabel="电脑"
									value={node}
									onChange={setNode}
									options={[
										{ value: ALL, label: "全部电脑" },
										...computers.map((c) => ({ value: c.id, label: c.name })),
									]}
								/>
							) : null}
							<Select
								ariaLabel="Agent"
								value={runtime}
								onChange={setRuntime}
								options={[
									{ value: ALL, label: "全部 Agent" },
									...(runtime !== ALL && !runtimesSeen.includes(runtime) ? [runtime] : [])
										.concat(runtimesSeen)
										.map((r) => ({ value: r, label: agentRuntimeLabel(r) })),
								]}
							/>
							<button
								type="button"
								className="ghost icon"
								title="重新统计"
								aria-label="重新统计"
								disabled={loading}
								onClick={() => store.loadUsage()}
							>
								{loading ? <IconLoader size={15} className="spin" /> : <IconRefresh size={15} />}
							</button>
						</div>
					</header>

					{notices.length ? (
						<div className="usage-notices">
							{notices.map((text) => (
								<p key={text}>{text}</p>
							))}
						</div>
					) : null}

					{!loaded && loading ? (
						<div className="usage-empty">
							<IconLoader size={18} className="spin" />
							<span>正在读取会话记录…</span>
						</div>
					) : totals.requests === 0 ? (
						<div className="usage-empty">
							<IconChartColumn size={22} />
							<span>{loading ? "正在读取会话记录…" : "这段时间没有用量"}</span>
						</div>
					) : (
						<>
							<UsageTiles totals={totals} cacheHitRate={summary.cacheHitRate} />
							<section className="usage-card">
								<div className="usage-card-heading">
									<h3>{summary.granularity === "month" ? "每月用量" : "每日用量"}</h3>
									<UsageLegend runtimes={runtime === ALL ? runtimesSeen : [runtime]} />
								</div>
								<UsageChart buckets={summary.buckets} granularity={summary.granularity} />
							</section>
							<section className="usage-card">
								<div className="usage-card-heading">
									<h3>用量构成</h3>
									<div className="segmented" role="tablist" aria-label="分组">
										{(
											[
												["runtime", "按 Agent"],
												["model", "按模型"],
												["workspace", "按工作区"],
												...(computers.length > 1 ? [["node", "按电脑"]] : []),
											] as [Dimension, string][]
										).map(([value, label]) => (
											<button
												type="button"
												key={value}
												role="tab"
												aria-selected={dimension === value}
												className={dimension === value ? "active" : ""}
												onClick={() => setDimension(value)}
											>
												{label}
											</button>
										))}
									</div>
								</div>
								<UsageTable groups={groups} total={totals.total} dimension={dimension} />
							</section>
							<section className="usage-card">
								<div className="usage-card-heading">
									<h3>用量最多的会话</h3>
								</div>
								<SessionTable
									sessions={summary.topSessions}
									showNode={computers.length > 1}
									onOpen={(session) => {
										const summaryOf = store
											.getState()
											.sessions[session.workspaceId]?.find((s) => s.id === session.sessionId);
										if (summaryOf) store.selectSession(summaryOf);
										else store.toast("error", "会话列表中找不到这个会话，它可能已被删除或归档");
									}}
								/>
							</section>
						</>
					)}
				</div>
			</div>
			{footer}
		</div>
	);
}

function UsageTiles({ totals, cacheHitRate }: { totals: UsageTotals; cacheHitRate: number | undefined }) {
	const costNote = usageCostNote(totals) ?? `${exact(totals.requests)} 次请求`;
	return (
		<section className="usage-tiles">
			<div className="usage-tile hero">
				<span className="usage-tile-label">总 Token</span>
				<strong className="usage-tile-value" title={exact(totals.total)}>
					{formatTokens(totals.total)}
				</strong>
				<span className="usage-tile-note">
					{exact(totals.requests)} 次请求 · {exact(totals.sessions)} 个会话
				</span>
			</div>
			<div className="usage-tile">
				<span className="usage-tile-label">输入</span>
				<strong className="usage-tile-value" title={exact(totals.input)}>
					{formatTokens(totals.input)}
				</strong>
				<span className="usage-tile-note">未命中缓存的提示词</span>
			</div>
			<div className="usage-tile">
				<span className="usage-tile-label">输出</span>
				<strong className="usage-tile-value" title={exact(totals.output)}>
					{formatTokens(totals.output)}
				</strong>
				<span className="usage-tile-note">含推理</span>
			</div>
			<div className="usage-tile">
				<span className="usage-tile-label">缓存读取</span>
				<strong className="usage-tile-value" title={exact(totals.cacheRead)}>
					{formatTokens(totals.cacheRead)}
				</strong>
				<span className="usage-tile-note">
					{cacheHitRate === undefined ? "没有提示词" : `命中率 ${formatPercent(cacheHitRate)}`}
				</span>
			</div>
			<div className="usage-tile">
				<span className="usage-tile-label">缓存写入</span>
				<strong className="usage-tile-value" title={exact(totals.cacheWrite)}>
					{formatTokens(totals.cacheWrite)}
				</strong>
				<span className="usage-tile-note">写入提示词缓存</span>
			</div>
			<div className="usage-tile" {...(totals.estimatedRequests > 0 ? { title: USAGE_ESTIMATE_HINT } : {})}>
				<span className="usage-tile-label">费用</span>
				<strong className="usage-tile-value">{costText(totals)}</strong>
				<span className="usage-tile-note">{costNote}</span>
			</div>
		</section>
	);
}

function UsageLegend({ runtimes }: { runtimes: string[] }) {
	if (runtimes.length < 2) return null;
	return (
		<ul className="usage-legend">
			{runtimes.map((runtime) => (
				<li key={runtime}>
					<span className="usage-swatch" style={{ background: runtimeColor(runtime) }} />
					{agentRuntimeLabel(runtime)}
				</li>
			))}
		</ul>
	);
}

/** A rounded axis maximum and its two gridlines. */
function niceMax(max: number): number {
	if (max <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(max));
	for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * magnitude >= max) return step * magnitude;
	return 10 * magnitude;
}

function bucketLabel(key: string, granularity: "day" | "month"): string {
	if (granularity === "month") {
		const [y, m] = key.split("-");
		return `${y} 年 ${Number(m)} 月`;
	}
	const [, m, d] = key.split("-");
	return `${Number(m)} 月 ${Number(d)} 日`;
}

/** Short label under a bar: `11/25` for a day, `2026/11` for a month. */
function axisLabel(key: string, granularity: "day" | "month"): string {
	const [y, m, d] = key.split("-");
	return granularity === "month" ? `${y}/${Number(m)}` : `${Number(m)}/${Number(d)}`;
}

function UsageChart({ buckets, granularity }: { buckets: UsageBucket[]; granularity: "day" | "month" }) {
	const [hover, setHover] = useState<number>();
	const max = niceMax(Math.max(0, ...buckets.map((b) => b.total)));
	// About eight labels along the axis, always including the last bucket.
	const every = Math.max(1, Math.ceil(buckets.length / 8));
	const hovered = hover !== undefined ? buckets[hover] : undefined;
	return (
		<div className="usage-chart">
			<div className="usage-chart-axis" aria-hidden="true">
				<span>{formatTokens(max)}</span>
				<span>{formatTokens(max / 2)}</span>
				<span>0</span>
			</div>
			<div className="usage-chart-plot">
				<div className="usage-chart-grid" aria-hidden="true">
					<span />
					<span />
					<span />
				</div>
				<div className="usage-chart-bars">
					{buckets.map((bucket, index) => {
						const segments = Object.entries(bucket.byRuntime)
							.filter(([, tokens]) => (tokens ?? 0) > 0)
							.sort(([a], [b]) => runtimeOrder(a) - runtimeOrder(b));
						return (
							<div
								key={bucket.key}
								className={`usage-chart-column${hover === index ? " hovered" : ""}`}
								role="img"
								aria-label={`${bucketLabel(bucket.key, granularity)}：${exact(bucket.total)} token`}
								onMouseEnter={() => setHover(index)}
								onMouseLeave={() => setHover((current) => (current === index ? undefined : current))}
							>
								<div className="usage-chart-stack" style={{ height: `${(bucket.total / max) * 100}%` }}>
									{segments.map(([runtime, tokens]) => (
										<span key={runtime} style={{ flexGrow: tokens ?? 0, background: runtimeColor(runtime) }} />
									))}
								</div>
								<span className="usage-chart-label">
									{index % every === (buckets.length - 1) % every ? axisLabel(bucket.key, granularity) : ""}
								</span>
							</div>
						);
					})}
				</div>
				{hovered ? (
					<div
						className="usage-tooltip"
						style={{ left: `${((hover ?? 0) + 0.5) * (100 / buckets.length)}%` }}
						data-edge={
							(hover ?? 0) < buckets.length / 4 ? "start" : (hover ?? 0) > (buckets.length * 3) / 4 ? "end" : undefined
						}
					>
						<strong className="usage-tooltip-title">{bucketLabel(hovered.key, granularity)}</strong>
						{RUNTIMES.concat(Object.keys(hovered.byRuntime).filter((r) => !RUNTIMES.includes(r)))
							.filter((r) => (hovered.byRuntime[r] ?? 0) > 0)
							.map((r) => (
								<span key={r} className="usage-tooltip-row">
									<span className="usage-swatch" style={{ background: runtimeColor(r) }} />
									{agentRuntimeLabel(r)}
									<em>{exact(hovered.byRuntime[r] ?? 0)}</em>
								</span>
							))}
						<span className="usage-tooltip-row total">
							合计<em>{exact(hovered.total)}</em>
						</span>
					</div>
				) : null}
			</div>
		</div>
	);
}

function runtimeOrder(runtime: string): number {
	const index = RUNTIMES.indexOf(runtime);
	return index === -1 ? RUNTIMES.length : index;
}

function UsageTable({ groups, total, dimension }: { groups: UsageGroup[]; total: number; dimension: Dimension }) {
	return (
		<div className="usage-table-wrap">
			<table className="usage-table">
				<thead>
					<tr>
						<th>{{ runtime: "Agent", model: "模型", workspace: "工作区", node: "电脑" }[dimension]}</th>
						<th className="num">Token</th>
						<th className="share">占比</th>
						<th className="num">输入</th>
						<th className="num">输出</th>
						<th className="num">缓存读取</th>
						<th className="num">请求</th>
						<th className="num">会话</th>
						<th className="num">费用</th>
					</tr>
				</thead>
				<tbody>
					{groups.map((group) => {
						const share = total > 0 ? group.total / total : 0;
						return (
							<tr key={group.key}>
								<td>
									<span className="usage-name">
										{dimension === "runtime" ? (
											<>
												<span className="usage-swatch" style={{ background: runtimeColor(group.key) }} />
												<AgentIcon runtime={group.key} size={14} />
											</>
										) : null}
										<span className="usage-name-text" title={group.label}>
											{group.label}
										</span>
										{group.detail ? <span className="usage-name-detail">{group.detail}</span> : null}
									</span>
								</td>
								<td className="num" title={exact(group.total)}>
									{formatTokens(group.total)}
								</td>
								<td className="share">
									<span className="usage-share">
										<span className="usage-share-bar">
											<span style={{ width: `${share * 100}%` }} />
										</span>
										{formatPercent(share)}
									</span>
								</td>
								<td className="num" title={exact(group.input)}>
									{formatTokens(group.input)}
								</td>
								<td className="num" title={exact(group.output)}>
									{formatTokens(group.output)}
								</td>
								<td className="num" title={exact(group.cacheRead)}>
									{formatTokens(group.cacheRead)}
								</td>
								<td className="num">{exact(group.requests)}</td>
								<td className="num">{exact(group.sessions)}</td>
								<CostCell totals={group} />
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function SessionTable({
	sessions,
	showNode,
	onOpen,
}: {
	sessions: UsageSessionGroup[];
	showNode: boolean;
	onOpen(session: UsageSessionGroup): void;
}) {
	return (
		<div className="usage-table-wrap">
			<table className="usage-table sessions">
				<thead>
					<tr>
						<th>会话</th>
						<th>工作区</th>
						<th className="num">Token</th>
						<th className="num">请求</th>
						<th className="num">费用</th>
						<th className="num">最近活动</th>
					</tr>
				</thead>
				<tbody>
					{sessions.map((session) => (
						<tr key={`${session.node}:${session.sessionId}`}>
							<td>
								<button type="button" className="usage-session" onClick={() => onOpen(session)}>
									<AgentIcon runtime={session.runtime} size={14} />
									<span className="usage-name-text" title={session.title ?? session.sessionId}>
										{session.title || "未命名会话"}
									</span>
									{session.archived ? <span className="usage-name-detail">已归档</span> : null}
								</button>
							</td>
							<td>
								<span className="usage-name-text">
									{session.workspaceName ?? "已移除的工作区"}
									{showNode ? <span className="usage-name-detail">{session.nodeName}</span> : null}
								</span>
							</td>
							<td className="num" title={exact(session.total)}>
								{formatTokens(session.total)}
							</td>
							<td className="num">{exact(session.requests)}</td>
							<CostCell totals={session} />
							<td className="num">{relativeTime(session.modifiedAt)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
