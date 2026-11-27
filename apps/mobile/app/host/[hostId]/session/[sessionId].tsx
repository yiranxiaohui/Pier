import {
	agentRuntimeLabel,
	type ChatController,
	type ChatState,
	clampThinking,
	contextBudget,
	contextLimitPresets,
	isRole,
	parseContextLimit,
	sessionUsage,
	supportedThinkingLevels,
	userText,
} from "@pier/chat-state";
import type {
	AgentRuntimeInfo,
	ApprovalPolicy,
	ForkPoint,
	ModelInfo,
	SessionContextInfo,
	SessionSummary,
} from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "../../../../src/components/Composer.tsx";
import { KeyboardAvoider } from "../../../../src/components/KeyboardAvoider.tsx";
import { PendingRequests } from "../../../../src/components/PendingRequests.tsx";
import { ThinkingSlider } from "../../../../src/components/ThinkingSlider.tsx";
import { Transcript } from "../../../../src/components/Transcript.tsx";
import {
	confirmDestructive,
	HeaderAction,
	Icon,
	type IconName,
	Muted,
	PromptSheet,
	PulseDot,
	Sheet,
	StatusDot,
} from "../../../../src/components/ui.tsx";
import {
	formatCost,
	formatPercent,
	formatTokens,
	isBusy,
	POLICY_LABEL,
	POLICY_SUMMARY,
	RUN_STATE_LABEL,
	sessionTitle,
} from "../../../../src/format.ts";
import { useChatView, useMobileState, useStore } from "../../../../src/store.ts";
import { type Palette, RADIUS, usePalette } from "../../../../src/theme.ts";
import { createTranscriptScroll } from "../../../../src/transcript-scroll.ts";

function placeholderSummary(sessionId: string, workspaceId: string): SessionSummary {
	const now = new Date().toISOString();
	return {
		id: sessionId,
		workspaceId,
		cwd: "",
		createdAt: now,
		modifiedAt: now,
		messageCount: 0,
		firstMessage: "",
		active: false,
		state: "inactive",
	};
}

const POLICIES: ApprovalPolicy[] = ["ask", "smart", "auto"];

const POLICY_ICON: Record<ApprovalPolicy, IconName> = {
	ask: "hand-left-outline",
	smart: "shield-checkmark-outline",
	auto: "flash-outline",
};

function MenuSection({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
	const p = usePalette();
	return (
		<View style={styles.menuSection}>
			<View style={styles.menuSectionHead}>
				<Icon name={icon} size={15} color={p.muted} />
				<Text style={[styles.menuSectionTitle, { color: p.muted }]}>{title}</Text>
			</View>
			{children}
		</View>
	);
}

/**
 * The status bar's approval-mode sheet for the session's workspace. The policy applies to every
 * session in it; the sheet closes once the pick is saved.
 */
function PolicySheet({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
	const store = useStore();
	const p = usePalette();
	const workspace = useMobileState((s) => s.host.workspaces?.find((w) => w.id === workspaceId));
	const online = useMobileState((s) => s.host.connection === "open");
	const [saving, setSaving] = useState<ApprovalPolicy>();
	if (!workspace) return null;
	const canManage = online && store.canManageWorkspaces();
	return (
		<Sheet onClose={onClose}>
			<ScrollView contentContainerStyle={styles.sheetContent}>
				<MenuSection icon="shield-outline" title="审批模式">
					<View style={[styles.group, { backgroundColor: p.bg }]}>
						{POLICIES.map((policy, index) => {
							const selected = workspace.policy === policy;
							const tint = policy === "auto" ? p.warning : p.accent;
							return (
								<Pressable
									key={policy}
									testID={`session-policy-${policy}`}
									accessibilityRole="radio"
									accessibilityState={{ selected, disabled: !canManage }}
									disabled={!canManage || saving !== undefined}
									style={({ pressed }) => [
										styles.option,
										index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
										pressed && { backgroundColor: p.elevated },
									]}
									onPress={async () => {
										if (selected) {
											onClose();
											return;
										}
										setSaving(policy);
										const saved = await store.setWorkspacePolicy(workspace.id, policy);
										setSaving(undefined);
										// On failure the store shows why; stay open to try again.
										if (saved) onClose();
									}}
								>
									<View
										style={[
											styles.optionIcon,
											{ backgroundColor: selected ? (policy === "auto" ? p.warningSoft : p.accentSoft) : p.elevated },
										]}
									>
										<Icon name={POLICY_ICON[policy]} size={17} color={selected ? tint : p.muted} />
									</View>
									<View style={styles.flex}>
										<Text style={[styles.optionName, { color: selected ? tint : canManage ? p.text : p.muted }]}>
											{POLICY_LABEL[policy]}
										</Text>
										<Muted style={[styles.optionText, policy === "auto" ? { color: p.warning } : undefined]}>
											{POLICY_SUMMARY[policy]}
										</Muted>
									</View>
									{saving === policy ? (
										<ActivityIndicator size="small" color={p.accent} />
									) : selected ? (
										<Icon name="checkmark-circle" size={22} color={tint} />
									) : null}
								</Pressable>
							);
						})}
					</View>
					<Muted style={styles.policyNote}>
						{!online
							? "连接到电脑后才能修改。"
							: !canManage
								? "这台电脑上的 Pier 版本较旧，请先升级，或在电脑上修改审批模式。"
								: `对工作区「${workspace.name}」的所有会话立即生效。`}
					</Muted>
				</MenuSection>
			</ScrollView>
		</Sheet>
	);
}

/**
 * The composer's model sheet, as on the desktop: the thinking-level slider on top, then the
 * models to switch to.
 */
function ModelSheet({ chat, onClose }: { chat: ChatController; onClose: () => void }) {
	const p = usePalette();
	const [models, setModels] = useState<ModelInfo[] | undefined>();
	const [sliding, setSliding] = useState(false);
	const [switching, setSwitching] = useState<string | undefined>();
	// Follow the session itself, so changes made on the computer show up here too.
	const view = useChatView(chat);
	const state = view?.chat ?? chat.chat;
	const current = state.model;
	const levels = supportedThinkingLevels(current);
	const level = clampThinking(state.thinkingLevel, levels);
	const groups = new Map<string, ModelInfo[]>();
	for (const model of models ?? []) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
	// Reload when the session's model changes (for example after models were edited on the computer).
	const modelKey = current ? JSON.stringify(current) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: modelKey only triggers a reload.
	useEffect(() => {
		let alive = true;
		chat
			.listModels()
			.then((result) => {
				if (alive) setModels(result.models);
			})
			.catch(() => {
				if (alive) setModels([]);
			});
		return () => {
			alive = false;
		};
	}, [chat, modelKey]);
	return (
		<Sheet onClose={onClose}>
			<ScrollView contentContainerStyle={styles.sheetContent} scrollEnabled={!sliding}>
				{current ? (
					<View style={[styles.thinking, { backgroundColor: p.bg }]}>
						{levels.length > 1 ? (
							<ThinkingSlider
								levels={levels}
								value={level}
								onChange={(next) => chat.setThinking(next)}
								onDragging={setSliding}
							/>
						) : (
							<Muted>这个模型不支持调节思考程度</Muted>
						)}
					</View>
				) : null}
				<MenuSection icon="sparkles-outline" title="模型">
					{!models ? <ActivityIndicator color={p.accent} /> : null}
					{models && !models.length ? <Muted>没有可用的模型，请在电脑上的 Pier 里配置模型。</Muted> : null}
					{[...groups].map(([provider, list]) => (
						<View key={provider} style={styles.providerGroup}>
							<Text style={[styles.providerTitle, { color: p.faint }]}>{list[0]?.providerName || provider}</Text>
							<View style={[styles.group, { backgroundColor: p.bg }]}>
								{list.map((model, index) => {
									const key = `${model.provider}/${model.id}`;
									const selected = current?.provider === model.provider && current.id === model.id;
									return (
										<Pressable
											key={key}
											disabled={switching !== undefined}
											style={({ pressed }) => [
												styles.option,
												index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
												selected && { backgroundColor: p.accentSoft },
												pressed && { backgroundColor: p.elevated },
											]}
											onPress={async () => {
												if (selected) return;
												setSwitching(key);
												try {
													await chat.setModel(model.provider, model.id);
												} finally {
													setSwitching(undefined);
												}
											}}
										>
											<View style={styles.flex}>
												<View style={styles.optionHead}>
													<Text style={[styles.optionName, { color: selected ? p.accent : p.text }]} numberOfLines={1}>
														{model.name || model.id}
													</Text>
													{model.reasoning ? (
														<Text style={[styles.tag, { color: p.muted, backgroundColor: p.elevated }]}>推理</Text>
													) : null}
												</View>
												{/* The description says which model it is (Claude Code's `default`, `fable`…). */}
												<Muted style={styles.optionText} numberOfLines={model.description ? 2 : 1}>
													{model.description || model.id}
												</Muted>
											</View>
											{switching === key ? (
												<ActivityIndicator size="small" color={p.accent} />
											) : selected ? (
												<Icon name="checkmark-circle" size={22} color={p.accent} />
											) : null}
										</Pressable>
									);
								})}
							</View>
						</View>
					))}
				</MenuSection>
			</ScrollView>
		</Sheet>
	);
}

/**
 * Share of the context the last request used: of the session's context limit (1.64), else of the
 * model's window, when both are known.
 */
function contextShare(chat: ChatState): { used: number; window?: number; ratio?: number } {
	const context = contextBudget(chat);
	return {
		used: context.used,
		...(context.budget ? { window: context.budget } : {}),
		...(context.share !== undefined ? { ratio: Math.min(1, context.share) } : {}),
	};
}

function contextDetails(info: SessionContextInfo | undefined): string | undefined {
	if (!info) return "自动压缩：运行时未报告阈值";
	if (info.autoCompaction === "disabled") return "自动压缩：已关闭";
	if (info.autoCompaction === "runtime") return "自动压缩：由运行时决定";
	if (info.compactionThreshold !== undefined) return `自动压缩：达到 ${formatTokens(info.compactionThreshold)} 时触发`;
	return undefined;
}

function contextColor(p: Palette, ratio: number): string {
	return ratio >= 0.8 ? p.danger : ratio >= 0.5 ? p.warning : p.accent;
}

/** Context size, token totals, cost and cache hits of the session, as on the desktop's status bar. */
function UsageCard({ chat, onLimit }: { chat: ChatState; onLimit?: () => void }) {
	const p = usePalette();
	const usage = sessionUsage(chat);
	const context = contextShare(chat);
	const limit = chat.contextInfo?.contextLimit;
	const canLimit = !!onLimit && !!chat.capabilities?.contextLimit;
	if (!usage.lastContext && !usage.input && !usage.output && !context.window && !canLimit) return null;
	const stats: [string, string][] = [];
	if (usage.input || usage.output) {
		stats.push(["输入", formatTokens(usage.input)], ["输出", formatTokens(usage.output)]);
	}
	if (usage.cost) stats.push(["费用", formatCost(usage.cost)]);
	if (usage.cacheHitRate !== undefined) stats.push(["缓存命中", formatPercent(usage.cacheHitRate)]);
	return (
		<View style={[styles.usage, { backgroundColor: p.bg }]}>
			{usage.lastContext || context.window ? (
				<View style={styles.usageContext}>
					<View style={styles.usageHead}>
						<Text style={[styles.usageLabel, { color: p.muted }]}>上下文</Text>
						<Text style={[styles.usageValue, { color: p.text }]}>
							{context.used ? formatTokens(context.used) : "—"}
							{context.window ? ` / ${formatTokens(context.window)}` : ""}
							{context.ratio !== undefined ? `（${formatPercent(context.ratio)}）` : ""}
						</Text>
					</View>
					{context.ratio !== undefined ? (
						<View style={[styles.usageTrack, { backgroundColor: p.elevated }]}>
							<View
								style={[
									styles.usageFill,
									{
										backgroundColor: contextColor(p, context.ratio),
										width: `${Math.max(2, Math.round(context.ratio * 100))}%`,
									},
								]}
							/>
						</View>
					) : null}
				</View>
			) : null}
			{canLimit ? (
				<Pressable
					testID="session-context-limit"
					accessibilityRole="button"
					onPress={onLimit}
					style={({ pressed }) => [styles.limitRow, { borderColor: p.border }, pressed && styles.pressed]}
				>
					<Text style={[styles.usageLabel, styles.flex, { color: p.muted }]}>上下文上限</Text>
					<Text style={[styles.usageValue, { color: limit !== undefined ? p.accent : p.text }]}>
						{limit !== undefined ? formatTokens(limit) : "跟随模型"}
					</Text>
					<Icon name="chevron-forward" size={15} color={p.faint} />
				</Pressable>
			) : null}
			{stats.length ? (
				<View style={styles.usageStats}>
					{stats.map(([label, value]) => (
						<View key={label} style={styles.usageStat}>
							<Text style={[styles.usageStatValue, { color: p.text }]}>{value}</Text>
							<Text style={[styles.usageStatLabel, { color: p.faint }]}>{label}</Text>
						</View>
					))}
				</View>
			) : null}
			<Muted style={styles.usageNote}>
				上下文为最近一次请求的大小，其余为本会话累计
				{contextDetails(chat.contextInfo) ? ` · ${contextDetails(chat.contextInfo)}` : ""}
			</Muted>
		</View>
	);
}

/** Pick one of your earlier messages to fork the session from, as on the desktop. */
function ForkSheet({
	chat,
	onFork,
	onClose,
}: {
	chat: ChatController;
	onFork: (entryId: string) => void;
	onClose: () => void;
}) {
	const p = usePalette();
	const [points, setPoints] = useState<ForkPoint[]>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let alive = true;
		chat
			.forkPoints()
			.then((r) => {
				if (alive) setPoints(r.points);
			})
			.catch((e: unknown) => {
				if (alive) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			alive = false;
		};
	}, [chat]);
	return (
		<Sheet onClose={onClose}>
			<ScrollView contentContainerStyle={styles.sheetContent}>
				<MenuSection icon="git-branch-outline" title="从历史消息分叉">
					<Muted style={styles.policyNote}>
						选择一条你发送过的消息：新会话保留它之前的全部上下文，并把这条消息放进输入框供你修改后重新发送。原会话保持不变。
					</Muted>
					{error ? <Text style={{ color: p.danger }}>{error}</Text> : null}
					{!points && !error ? <ActivityIndicator color={p.accent} /> : null}
					{points && !points.length ? <Muted>还没有可以分叉的消息。</Muted> : null}
					{points?.length ? (
						<View style={[styles.group, { backgroundColor: p.bg }]}>
							{[...points].reverse().map((point, index) => (
								<Pressable
									key={point.entryId}
									onPress={() => {
										onClose();
										onFork(point.entryId);
									}}
									style={({ pressed }) => [
										styles.option,
										index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
										pressed && { backgroundColor: p.elevated },
									]}
								>
									<Icon name="chatbubble-outline" size={15} color={p.muted} />
									<Text style={[styles.forkText, { color: p.text }]} numberOfLines={3}>
										{point.text.slice(0, 300) || "（空消息）"}
									</Text>
								</Pressable>
							))}
						</View>
					) : null}
				</MenuSection>
			</ScrollView>
		</Sheet>
	);
}

/**
 * Limit the session's context (1.64): the agent compacts before the context grows past the limit.
 * Presets below the model's window, a typed value, and whether new sessions of the agent start
 * with it too.
 */
function ContextLimitSheet({ chat, onClose }: { chat: ChatController; onClose: () => void }) {
	const store = useStore();
	const p = usePalette();
	const view = useChatView(chat);
	const state = view?.chat ?? chat.chat;
	const support = state.capabilities?.contextLimit;
	const runtimeId = state.session?.runtime;
	const [runtime, setRuntime] = useState<AgentRuntimeInfo>();
	const [asDefault, setAsDefault] = useState(false);
	const [custom, setCustom] = useState("");
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState<number | null | "custom">();
	useEffect(() => {
		let alive = true;
		void store.availableRuntimes().then((runtimes) => {
			if (alive) setRuntime(runtimes.find((r) => r.id === (runtimeId ?? "pi")));
		});
		return () => {
			alive = false;
		};
	}, [store, runtimeId]);
	if (!support) return null;
	const modelWindow = state.contextInfo?.contextWindow ?? state.model?.contextWindow;
	const current = state.contextInfo?.contextLimit;
	const presets = contextLimitPresets(support.min, modelWindow);
	if (current !== undefined && !presets.includes(current)) presets.push(current);
	presets.sort((a, b) => a - b);
	const agent = runtime?.name ?? agentRuntimeLabel(runtimeId);
	const defaultLimit = runtime?.contextLimitDefault;

	const apply = async (limit: number | null, key: number | null | "custom" = limit) => {
		if (limit !== null && limit < support.min) {
			setError(`${agent} 的上下文上限至少为 ${formatTokens(support.min)}`);
			return;
		}
		setSaving(key);
		const result = await chat.setContextLimit(limit, asDefault);
		setSaving(undefined);
		if (result) onClose();
	};
	const options: Array<{ limit: number | null; label: string; detail?: string }> = [
		{
			limit: null,
			label: "跟随模型",
			detail: modelWindow ? `模型窗口 ${formatTokens(modelWindow)}` : "使用模型的上下文窗口",
		},
		...presets.map((limit) => ({
			limit,
			label: formatTokens(limit),
			...(defaultLimit === limit ? { detail: `${agent} 新会话默认` } : {}),
		})),
	];
	return (
		<Sheet onClose={onClose}>
			<ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
				<MenuSection icon="layers-outline" title="上下文上限">
					<View style={[styles.group, { backgroundColor: p.bg }]}>
						{options.map((option, index) => {
							const selected = option.limit === null ? current === undefined : current === option.limit;
							return (
								<Pressable
									key={option.limit ?? "model"}
									testID={`context-limit-${option.limit ?? "model"}`}
									accessibilityRole="radio"
									accessibilityState={{ selected }}
									disabled={saving !== undefined}
									onPress={() => void apply(option.limit)}
									style={({ pressed }) => [
										styles.option,
										index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
										pressed && { backgroundColor: p.elevated },
									]}
								>
									<View style={styles.flex}>
										<Text style={[styles.optionName, { color: selected ? p.accent : p.text }]}>{option.label}</Text>
										{option.detail ? <Muted style={styles.optionText}>{option.detail}</Muted> : null}
									</View>
									{saving === option.limit ? (
										<ActivityIndicator size="small" color={p.accent} />
									) : selected ? (
										<Icon name="checkmark-circle" size={22} color={p.accent} />
									) : null}
								</Pressable>
							);
						})}
					</View>
					<View style={[styles.limitCustom, { backgroundColor: p.bg }]}>
						<TextInput
							testID="context-limit-custom"
							value={custom}
							onChangeText={(text) => {
								setCustom(text);
								setError(undefined);
							}}
							placeholder={`自定义，如 ${formatTokens(Math.max(support.min, 150_000))}`}
							placeholderTextColor={p.faint}
							autoCapitalize="none"
							autoCorrect={false}
							returnKeyType="done"
							onSubmitEditing={() => {
								const limit = parseContextLimit(custom);
								if (limit === undefined) setError("请输入 token 数，例如 200k、150000 或 1.5m");
								else void apply(limit, "custom");
							}}
							style={[styles.limitInput, { color: p.text }]}
						/>
						<Pressable
							accessibilityRole="button"
							disabled={!custom.trim() || saving !== undefined}
							onPress={() => {
								const limit = parseContextLimit(custom);
								if (limit === undefined) setError("请输入 token 数，例如 200k、150000 或 1.5m");
								else void apply(limit, "custom");
							}}
							style={({ pressed }) => [pressed && styles.pressed, !custom.trim() && styles.disabled]}
						>
							{saving === "custom" ? (
								<ActivityIndicator size="small" color={p.accent} />
							) : (
								<Text style={[styles.limitSet, { color: p.accent }]}>设置</Text>
							)}
						</Pressable>
					</View>
					{error ? <Text style={[styles.policyNote, { color: p.danger }]}>{error}</Text> : null}
					<View style={[styles.limitDefault, { backgroundColor: p.bg }]}>
						<View style={styles.flex}>
							<Text style={[styles.limitDefaultText, { color: p.text }]}>同时作为 {agent} 新会话的默认上限</Text>
							{defaultLimit !== undefined ? (
								<Muted style={styles.optionText}>当前默认：{formatTokens(defaultLimit)}</Muted>
							) : null}
						</View>
						<Switch value={asDefault} onValueChange={setAsDefault} disabled={saving !== undefined} />
					</View>
					<Muted style={styles.policyNote}>
						{support.enforcement === "turn"
							? "每轮结束后检查，超过上限就压缩上下文；一轮之内仍可能暂时超过上限。"
							: "上下文接近上限时自动压缩；正在运行时修改，最迟在这一轮结束后生效。"}
						上限不会超过模型窗口，最小 {formatTokens(support.min)}。
					</Muted>
				</MenuSection>
			</ScrollView>
		</Sheet>
	);
}

type SubSheet = "rename" | "compact" | "fork" | "contextLimit";

interface ActionItem {
	key: string;
	label: string;
	icon: IconName;
	danger?: boolean;
	disabled?: boolean;
	onPress: () => void;
}

/** The header's "…" sheet: usage of the session and actions on it. */
function ActionsSheet({
	chat,
	hostId,
	onOpen,
	onClose,
}: {
	chat: ChatController;
	hostId: string;
	onOpen: (sheet: SubSheet) => void;
	onClose: () => void;
}) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const view = useChatView(chat);
	const state = view?.chat ?? chat.chat;
	const session = state.session;
	const caps = state.capabilities;
	const workspace = useMobileState((s) => s.host.workspaces?.find((w) => w.id === chat.workspaceId));
	const archived = useMobileState((s) =>
		session
			? (s.host.sessions[session.workspaceId]?.find((x) => x.id === session.id)?.archived ?? session.archived)
			: false,
	);
	const running = isBusy(state.runState);
	const items: ActionItem[] = [];
	if (caps?.rename !== false) {
		items.push({ key: "rename", label: "重命名", icon: "pencil-outline", onPress: () => onOpen("rename") });
	}
	if (caps?.compact !== false) {
		items.push({
			key: "compact",
			label: "压缩上下文",
			icon: "contract-outline",
			disabled: state.runState !== "idle",
			onPress: () => onOpen("compact"),
		});
	}
	if (caps?.fork !== false) {
		items.push({ key: "fork", label: "从历史消息分叉", icon: "git-branch-outline", onPress: () => onOpen("fork") });
	}
	if (workspace && store.canBrowseFiles()) {
		items.push({
			key: "files",
			label: "工作区文件",
			icon: "folder-outline",
			onPress: () => {
				onClose();
				router.push({ pathname: "/host/[hostId]/files", params: { hostId, workspaceId: workspace.id } });
			},
		});
	}
	if (workspace && store.canOpenTerminal()) {
		items.push({
			key: "terminal",
			label: "在工作区打开终端",
			icon: "terminal-outline",
			onPress: () => {
				onClose();
				router.push({ pathname: "/host/[hostId]/terminal", params: { hostId, cwd: session?.cwd || workspace.path } });
			},
		});
	}
	if (session && store.canArchive()) {
		items.push({
			key: "archive",
			label: archived ? "取消归档" : "归档会话",
			icon: archived ? "arrow-undo-outline" : "archive-outline",
			onPress: async () => {
				if (!(await store.archiveSession(session, !archived))) return;
				onClose();
				store.toast("info", archived ? "已取消归档" : "已归档");
				if (!archived) router.dismissTo({ pathname: "/host/[hostId]", params: { hostId } });
			},
		});
	}
	if (session) {
		items.push({
			key: "close",
			label: "关闭会话",
			icon: "close-circle-outline",
			onPress: () => {
				const close = async () => {
					if (!(await store.closeSession(session, running))) return;
					onClose();
					if (router.canGoBack()) router.back();
				};
				if (running) {
					confirmDestructive(
						"关闭会话？",
						"Agent 正在运行，会先中止。会话记录会保留。",
						"中止并关闭",
						() => void close(),
					);
				} else void close();
			},
		});
		items.push({
			key: "delete",
			label: "删除会话",
			icon: "trash-outline",
			danger: true,
			onPress: () =>
				confirmDestructive(
					`删除“${sessionTitle(session)}”？`,
					`${running ? "Agent 正在运行，会先中止。" : ""}会话文件会移到电脑上的 Pier 回收站（~/.pier/trash/sessions）。`,
					"删除",
					async () => {
						if (!(await store.deleteSession(session, running))) return;
						onClose();
						if (router.canGoBack()) router.back();
					},
				),
		});
	}
	return (
		<Sheet onClose={onClose}>
			<ScrollView contentContainerStyle={styles.sheetContent}>
				<UsageCard chat={state} onLimit={() => onOpen("contextLimit")} />
				<View style={[styles.group, { backgroundColor: p.bg }]}>
					{items.map((item, index) => {
						const color = item.danger ? p.danger : p.text;
						return (
							<Pressable
								key={item.key}
								testID={`session-action-${item.key}`}
								accessibilityRole="button"
								disabled={item.disabled}
								onPress={item.onPress}
								style={({ pressed }) => [
									styles.option,
									index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
									pressed && { backgroundColor: p.elevated },
									item.disabled && styles.disabled,
								]}
							>
								<Icon name={item.icon} size={19} color={item.danger ? p.danger : p.muted} />
								<Text style={[styles.actionLabel, { color }]}>{item.label}</Text>
								<Icon name="chevron-forward" size={16} color={p.faint} />
							</Pressable>
						);
					})}
				</View>
			</ScrollView>
		</Sheet>
	);
}

export default function SessionScreen() {
	const { hostId, sessionId, workspaceId } = useLocalSearchParams<{
		hostId: string;
		sessionId: string;
		workspaceId: string;
	}>();
	const store = useStore();
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const connection = useMobileState((s) => (s.host.hostId === hostId ? s.host.connection : "none"));
	const revoked = useMobileState((s) => s.host.hostId === hostId && s.host.revoked);
	useMobileState((s) => s.chatsVersion);
	const [sheet, setSheet] = useState<"policy" | "model" | "actions" | SubSheet>();
	const scroller = useRef<ScrollView>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each session starts by following its latest message.
	const transcriptScroll = useMemo(
		() => createTranscriptScroll(() => scroller.current?.scrollToEnd({ animated: false })),
		[hostId, sessionId],
	);
	useEffect(() => () => transcriptScroll.dispose(), [transcriptScroll]);

	useEffect(() => {
		if (hostId) store.openHost(hostId);
	}, [hostId, store]);

	const ready = connection !== "none" && connection !== "connecting" && store.activeClient !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-create after the host connection is replaced.
	const chat = useMemo(() => {
		if (!ready || !sessionId) return undefined;
		return store.chat(store.findSession(sessionId) ?? placeholderSummary(sessionId, workspaceId ?? ""));
	}, [ready, sessionId, workspaceId, store, store.activeClient]);
	const view = useChatView(chat);
	const sessionWorkspaceId = chat?.workspaceId || workspaceId;
	const policy = useMobileState((s) =>
		s.host.hostId === hostId ? s.host.workspaces?.find((w) => w.id === sessionWorkspaceId)?.policy : undefined,
	);
	const state = view?.chat;
	const firstUser = state?.messages.find((m) => isRole(m, "user"));
	const title = state?.session
		? sessionTitle({
				name: state.session.name,
				firstMessage:
					state.session.firstMessage || (firstUser && isRole(firstUser, "user") ? userText(firstUser.content) : ""),
			})
		: "会话";
	const running = !!state && isBusy(state.runState);
	const statusColor = revoked ? p.danger : connection !== "open" ? p.warning : running ? p.accent : p.ok;
	const levels = supportedThinkingLevels(state?.model);
	const thinkingLevel = state && levels.length > 1 ? clampThinking(state.thinkingLevel, levels) : undefined;
	const context = state ? contextShare(state) : undefined;
	const router = useRouter();

	return (
		<KeyboardAvoider style={[styles.flex, { backgroundColor: p.bg }]} topOffset={insets.top + 44} contentInsetsBottom>
			<Stack.Screen
				options={{
					title,
					headerRight: () =>
						chat ? (
							<HeaderAction label="会话选项" icon="ellipsis-horizontal" onPress={() => setSheet("actions")} />
						) : null,
				}}
			/>
			<View style={[styles.statusBar, { borderColor: p.border }]}>
				<View style={[styles.chip, styles.chipShrink, { backgroundColor: p.elevated }]}>
					{running && connection === "open" ? (
						<PulseDot size={7} color={statusColor} />
					) : (
						<StatusDot size={7} color={statusColor} />
					)}
					<Text style={[styles.statusText, { color: p.muted }]} numberOfLines={1}>
						{revoked
							? "这台设备已被电脑移除，请返回重新配对"
							: connection === "open"
								? state
									? RUN_STATE_LABEL[state.runState]
									: "加载中"
								: "未连接，正在重连…"}
					</Text>
				</View>
				{context?.used ? (
					<Pressable
						testID="session-context-chip"
						onPress={() => chat && setSheet("actions")}
						style={({ pressed }) => [styles.chip, { backgroundColor: p.elevated }, pressed && styles.pressed]}
						accessibilityLabel="上下文用量，点按查看详情"
					>
						<Icon
							name="layers-outline"
							size={13}
							color={context.ratio !== undefined ? contextColor(p, context.ratio) : p.muted}
						/>
						<Text style={[styles.statusText, { color: p.text }]} numberOfLines={1}>
							{context.ratio !== undefined ? formatPercent(context.ratio) : formatTokens(context.used)}
						</Text>
					</Pressable>
				) : null}
				{policy ? (
					<Pressable
						testID="session-policy-chip"
						onPress={() => chat && setSheet("policy")}
						style={({ pressed }) => [
							styles.chip,
							{ backgroundColor: policy === "auto" ? p.warningSoft : p.elevated },
							pressed && styles.pressed,
						]}
						accessibilityLabel={`审批模式：${POLICY_LABEL[policy]}，点按切换`}
					>
						<Icon name={POLICY_ICON[policy]} size={13} color={policy === "auto" ? p.warning : p.muted} />
						<Text style={[styles.statusText, { color: policy === "auto" ? p.warning : p.text }]} numberOfLines={1}>
							{POLICY_LABEL[policy]}
						</Text>
						<Icon name="chevron-down" size={12} color={p.faint} />
					</Pressable>
				) : null}
			</View>
			<ScrollView
				key={`${hostId}/${sessionId}`}
				ref={scroller}
				style={styles.flex}
				keyboardDismissMode="interactive"
				scrollEventThrottle={100}
				{...transcriptScroll.props}
			>
				{view?.error ? (
					<View style={[styles.error, { backgroundColor: p.dangerSoft }]}>
						<Icon name="alert-circle-outline" size={18} color={p.danger} />
						<Text style={[styles.errorText, { color: p.danger }]}>无法打开会话：{view.error}</Text>
					</View>
				) : !state?.loaded ? (
					<ActivityIndicator style={styles.loading} color={p.accent} />
				) : (
					<Transcript chat={state} />
				)}
			</ScrollView>
			{chat && state ? (
				<>
					<PendingRequests requests={state.pendingUi} respond={(id, response) => void chat.respond(id, response)} />
					{state.queue.steering.length || state.queue.followUp.length ? (
						<View style={[styles.queue, { backgroundColor: p.elevated }]}>
							<Icon name="time-outline" size={14} color={p.muted} />
							<Text style={[styles.queueText, { color: p.muted }]} numberOfLines={2}>
								已排队：
								{[...state.queue.steering, ...state.queue.followUp].map((t) => `“${t.slice(0, 30)}”`).join("、")}
							</Text>
						</View>
					) : null}
					<View style={{ paddingBottom: insets.bottom }}>
						<Composer
							chat={chat}
							runState={state.runState}
							model={state.model?.name}
							thinkingLevel={thinkingLevel}
							onModelPress={() => setSheet("model")}
						/>
					</View>
				</>
			) : null}
			{chat && sheet === "policy" ? (
				<PolicySheet workspaceId={chat.workspaceId} onClose={() => setSheet(undefined)} />
			) : null}
			{chat && sheet === "model" ? <ModelSheet chat={chat} onClose={() => setSheet(undefined)} /> : null}
			{chat && sheet === "actions" ? (
				<ActionsSheet
					chat={chat}
					hostId={hostId}
					onOpen={(next) => {
						// Let iOS finish dismissing one modal before presenting the next.
						setSheet(undefined);
						setTimeout(() => setSheet(next), Platform.OS === "ios" ? 350 : 0);
					}}
					onClose={() => setSheet(undefined)}
				/>
			) : null}
			{chat && sheet === "rename" ? (
				<PromptSheet
					title="重命名会话"
					initialValue={state?.session?.name ?? ""}
					placeholder={title}
					confirm="保存"
					onClose={() => setSheet(undefined)}
					onSubmit={async (name) => {
						const ok = (await chat.rename(name.slice(0, 200))) !== undefined;
						if (ok) store.scheduleSessionsRefresh(chat.workspaceId);
						return ok;
					}}
				/>
			) : null}
			{chat && sheet === "compact" ? (
				<PromptSheet
					title="压缩上下文"
					message="让模型把此前的对话总结成摘要，释放上下文窗口。可以补充希望摘要重点保留的内容（可选）。"
					placeholder="例如：保留所有未完成的 TODO 和已修改的文件列表"
					confirm="开始压缩"
					multiline
					allowEmpty
					onClose={() => setSheet(undefined)}
					onSubmit={(instructions) => {
						void chat.compact(instructions || undefined);
						return true;
					}}
				/>
			) : null}
			{chat && sheet === "contextLimit" ? <ContextLimitSheet chat={chat} onClose={() => setSheet(undefined)} /> : null}
			{chat && sheet === "fork" ? (
				<ForkSheet
					chat={chat}
					onClose={() => setSheet(undefined)}
					onFork={async (entryId) => {
						const session = await store.forkSession(chat.sessionId, entryId);
						if (session) {
							router.push({
								pathname: "/host/[hostId]/session/[sessionId]",
								params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
							});
						}
					}}
				/>
			) : null}
		</KeyboardAvoider>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	statusBar: {
		flexDirection: "row",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 14,
		paddingVertical: 8,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 10,
		height: 28,
		borderRadius: RADIUS.pill,
		maxWidth: "65%",
	},
	chipShrink: { flexShrink: 1 },
	statusText: { fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
	pressed: { opacity: 0.7 },
	loading: { marginTop: 40 },
	error: { flexDirection: "row", gap: 8, margin: 16, padding: 14, borderRadius: RADIUS.md },
	errorText: { flex: 1, fontSize: 13.5, lineHeight: 19 },
	queue: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		marginHorizontal: 12,
		marginTop: 6,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: RADIUS.md,
	},
	queueText: { flex: 1, fontSize: 12.5 },
	sheetContent: { padding: 20, paddingTop: 14, gap: 20 },
	menuSection: { gap: 10 },
	menuSectionHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
	menuSectionTitle: { fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
	menuActions: { flexDirection: "row", gap: 10 },
	group: { borderRadius: RADIUS.lg, overflow: "hidden" },
	option: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
	optionIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
	optionName: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
	optionText: { fontSize: 12.5, lineHeight: 18 },
	policyNote: { fontSize: 12, marginHorizontal: 4 },
	thinking: { borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 12 },
	providerGroup: { gap: 6 },
	providerTitle: { fontSize: 12, fontWeight: "600", paddingHorizontal: 4 },
	disabled: { opacity: 0.4 },
	actionLabel: { flex: 1, fontSize: 15.5, fontWeight: "500" },
	forkText: { flex: 1, fontSize: 14, lineHeight: 20 },
	usage: { borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 12, gap: 12 },
	usageContext: { gap: 7 },
	usageHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
	usageLabel: { fontSize: 13, fontWeight: "600" },
	usageValue: { fontSize: 13.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
	usageTrack: { height: 6, borderRadius: RADIUS.pill, overflow: "hidden" },
	usageFill: { height: 6, borderRadius: RADIUS.pill },
	usageStats: { flexDirection: "row", justifyContent: "space-between" },
	usageStat: { alignItems: "center", flex: 1 },
	usageStatValue: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
	usageStatLabel: { fontSize: 11.5, marginTop: 2 },
	usageNote: { fontSize: 11.5, lineHeight: 16 },
	limitRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingTop: 10,
		borderTopWidth: StyleSheet.hairlineWidth,
	},
	limitCustom: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		borderRadius: RADIUS.lg,
		paddingHorizontal: 14,
		paddingVertical: 4,
	},
	limitInput: { flex: 1, fontSize: 15, paddingVertical: 8 },
	limitSet: { fontSize: 15, fontWeight: "600" },
	limitDefault: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		borderRadius: RADIUS.lg,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	limitDefaultText: { fontSize: 14.5, fontWeight: "500" },
	optionHead: { flexDirection: "row", alignItems: "center", gap: 6 },
	tag: {
		fontSize: 10.5,
		fontWeight: "700",
		borderRadius: 6,
		paddingHorizontal: 6,
		paddingVertical: 1,
		overflow: "hidden",
	},
});
