import {
	type AssistantBlock,
	buildTranscript,
	type ChatState,
	contentText,
	editDiff,
	editReplacements,
	isWaitingForModel,
	summarizeToolCall,
	type ToolBlock,
	type TranscriptItem,
	toolOutputText,
	waitingForModelLabel,
} from "@pier/chat-state";
import type { SubagentInfo, SubagentStatus } from "@pier/protocol";
import { memo, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { isBusy, truncate } from "../format.ts";
import { MONO, PAGE, type Palette, RADIUS, usePalette } from "../theme.ts";
import { Markdown } from "./Markdown.tsx";
import { Icon, type IconName } from "./ui.tsx";

const STATUS_LABEL: Record<ToolBlock["status"], string> = {
	generating: "生成中",
	pending: "等待执行",
	running: "执行中",
	done: "完成",
	error: "失败",
	interrupted: "已中断",
};

const TOOL_LABEL: Record<string, string> = {
	bash: "终端",
	powershell: "PowerShell",
	read: "读取",
	write: "写入",
	edit: "编辑",
	grep: "搜索",
	find: "查找",
	ls: "列目录",
	Agent: "Subagent",
	Task: "Subagent",
	subagent: "Subagent",
	spawn_agent: "派出 Subagent",
	wait_agent: "等待 Subagent",
};

const TOOL_ICON: Record<string, IconName> = {
	bash: "terminal-outline",
	powershell: "terminal-outline",
	read: "document-text-outline",
	write: "create-outline",
	edit: "pencil-outline",
	grep: "search-outline",
	find: "search-outline",
	ls: "folder-outline",
	Agent: "git-network-outline",
	Task: "git-network-outline",
	subagent: "git-network-outline",
	spawn_agent: "git-network-outline",
	wait_agent: "time-outline",
};

const SUBAGENT_STATUS: Record<SubagentStatus, string> = {
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	stopped: "已停止",
};

const SUBAGENT_ICON: Record<Exclude<SubagentStatus, "running">, IconName> = {
	completed: "checkmark-circle",
	failed: "close-circle",
	stopped: "remove-circle-outline",
};

function subagentColor(p: Palette, status: SubagentStatus): string {
	if (status === "failed") return p.danger;
	if (status === "completed") return p.ok;
	if (status === "running") return p.accent;
	return p.warning;
}

/** The subagents a tool call started: name, model, state, steps and what each is doing. */
function SubagentList({ subagents }: { subagents: SubagentInfo[] }) {
	const p = usePalette();
	return (
		<View style={styles.subagents}>
			{subagents.map((s) => {
				const summary = (s.description ?? s.task)?.split("\n").find((line) => line.trim());
				const detail = s.status === "running" ? s.activity : s.status === "failed" ? s.error : undefined;
				return (
					<View key={s.id} style={[styles.subagent, { borderColor: p.border, backgroundColor: p.elevated }]}>
						<View style={styles.subagentHead}>
							<Icon name="hardware-chip-outline" size={14} color={p.muted} />
							<Text style={[styles.subagentName, { color: p.text }]} numberOfLines={1}>
								{s.name}
							</Text>
							{s.model ? (
								<Text style={[styles.subagentModel, { color: p.faint }]} numberOfLines={1}>
									{[s.model, s.thinkingLevel].filter(Boolean).join(" ")}
								</Text>
							) : (
								<View style={styles.subagentModel} />
							)}
							{s.status === "running" ? (
								<ActivityIndicator size="small" color={p.accentText} />
							) : (
								<Icon name={SUBAGENT_ICON[s.status]} size={16} color={subagentColor(p, s.status)} />
							)}
						</View>
						<Text style={[styles.subagentMeta, { color: p.muted }]} numberOfLines={1}>
							{SUBAGENT_STATUS[s.status]} · {s.steps} 个步骤
						</Text>
						{summary ? (
							<Text style={[styles.subagentText, { color: p.text }]} numberOfLines={2}>
								{summary}
							</Text>
						) : null}
						{detail ? (
							<Text
								style={[styles.subagentDetail, { color: s.status === "failed" ? p.danger : p.faint }]}
								numberOfLines={1}
							>
								{detail}
							</Text>
						) : null}
					</View>
				);
			})}
		</View>
	);
}

const STATUS_ICON: Partial<Record<ToolBlock["status"], IconName>> = {
	done: "checkmark-circle",
	error: "close-circle",
	pending: "time-outline",
	interrupted: "remove-circle-outline",
};

/** Keep very long outputs cheap to render on a phone. */
const MAX_OUTPUT_CHARS = 20_000;

function statusColor(p: Palette, status: ToolBlock["status"]): string {
	if (status === "error") return p.danger;
	if (status === "done") return p.ok;
	if (status === "running" || status === "generating") return p.accent;
	if (status === "pending") return p.warning;
	return p.faint;
}

function DiffView({ diff }: { diff: string }) {
	const p = usePalette();
	const lines = truncate(diff, MAX_OUTPUT_CHARS).split("\n");
	return (
		<ScrollView horizontal style={[styles.output, { backgroundColor: p.code }]}>
			<View>
				{lines.map((line, i) => {
					const color = line.startsWith("+") ? p.add : line.startsWith("-") ? p.del : p.codeText;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: static diff lines.
						<Text key={i} style={[styles.mono, { color }]}>
							{line || " "}
						</Text>
					);
				})}
			</View>
		</ScrollView>
	);
}

export const ToolCard = memo(function ToolCard({ block }: { block: ToolBlock }) {
	const p = usePalette();
	const { call, status } = block;
	const [openOverride, setOpen] = useState<boolean | undefined>(undefined);
	const open = openOverride ?? (status === "running" || status === "error");
	const summary = summarizeToolCall(call.name, call.arguments);
	const result = block.result ?? block.execution?.result;
	const output = toolOutputText(result ?? block.execution?.partialResult);
	const diff = call.name === "edit" ? editDiff(result) : undefined;
	const replacements = call.name === "edit" && !diff ? editReplacements(call.arguments) : [];
	const writeContent =
		call.name === "write" && typeof (call.arguments as { content?: unknown })?.content === "string"
			? String((call.arguments as { content: string }).content)
			: undefined;

	return (
		<View style={[styles.tool, { borderColor: p.border, backgroundColor: p.card }]}>
			<Pressable
				style={({ pressed }) => [styles.toolHeader, pressed && { backgroundColor: p.elevated }]}
				onPress={() => setOpen(!open)}
				accessibilityRole="button"
				accessibilityLabel={`${TOOL_LABEL[call.name] ?? call.name}：${STATUS_LABEL[status]}`}
			>
				<View style={[styles.toolIcon, { backgroundColor: p.accentSoft }]}>
					<Icon name={TOOL_ICON[call.name] ?? "construct-outline"} size={14} color={p.accentText} />
				</View>
				<View style={styles.toolMain}>
					<Text style={[styles.toolName, { color: p.muted }]}>{TOOL_LABEL[call.name] ?? call.name}</Text>
					<Text style={[styles.toolSummary, { color: p.text }]} numberOfLines={open ? 6 : 1}>
						{summary}
					</Text>
				</View>
				{status === "running" || status === "generating" ? (
					<ActivityIndicator size="small" color={p.accentText} />
				) : STATUS_ICON[status] ? (
					<Icon name={STATUS_ICON[status] ?? "ellipse-outline"} size={18} color={statusColor(p, status)} />
				) : (
					<Text style={[styles.toolStatus, { color: statusColor(p, status) }]}>{STATUS_LABEL[status]}</Text>
				)}
				<Icon name={open ? "chevron-up" : "chevron-down"} size={14} color={p.faint} />
			</Pressable>
			{block.subagents?.length ? <SubagentList subagents={block.subagents} /> : null}
			{open ? (
				<View style={styles.toolBody}>
					{diff ? <DiffView diff={diff} /> : null}
					{replacements.map((r, i) => (
						<DiffView
							// biome-ignore lint/suspicious/noArrayIndexKey: replacements have no id.
							key={i}
							diff={[...r.oldText.split("\n").map((l) => `-${l}`), ...r.newText.split("\n").map((l) => `+${l}`)].join(
								"\n",
							)}
						/>
					))}
					{writeContent !== undefined && !output ? (
						<ScrollView horizontal style={[styles.output, { backgroundColor: p.code }]}>
							<Text style={[styles.mono, { color: p.codeText }]}>{truncate(writeContent, MAX_OUTPUT_CHARS)}</Text>
						</ScrollView>
					) : null}
					{output && !diff ? (
						<ScrollView horizontal style={[styles.output, { backgroundColor: p.code }]}>
							<Text selectable style={[styles.mono, { color: status === "error" ? p.del : p.codeText }]}>
								{output.length > MAX_OUTPUT_CHARS ? `…${output.slice(-MAX_OUTPUT_CHARS)}` : output}
							</Text>
						</ScrollView>
					) : null}
				</View>
			) : null}
		</View>
	);
});

function Thinking({ text, redacted, live }: { text: string; redacted: boolean; live: boolean }) {
	const p = usePalette();
	const [open, setOpen] = useState(false);
	return (
		<Pressable onPress={() => setOpen(!open)} style={[styles.thinking, { backgroundColor: p.elevated }]}>
			<View style={styles.thinkingHead}>
				<Icon name={redacted ? "eye-off-outline" : "bulb-outline"} size={14} color={p.muted} />
				<Text style={[styles.thinkingLabel, { color: p.muted }]}>
					{redacted ? "思考内容已隐藏" : live ? "思考中…" : "思考过程"}
				</Text>
				{redacted ? null : <Icon name={open ? "chevron-up" : "chevron-down"} size={13} color={p.faint} />}
			</View>
			{open && !redacted ? <Text style={[styles.thinkingText, { color: p.muted }]}>{text}</Text> : null}
		</Pressable>
	);
}

function AssistantItem({ blocks }: { blocks: AssistantBlock[] }) {
	return (
		<View style={styles.assistant}>
			{blocks.map((block, index) => {
				const key = `${block.kind}-${index}`;
				if (block.kind === "text") return <Markdown key={key} text={block.text} />;
				if (block.kind === "thinking") {
					return <Thinking key={key} text={block.text} redacted={block.redacted} live={block.live} />;
				}
				return <ToolCard key={block.call.id} block={block} />;
			})}
		</View>
	);
}

function Divider({ icon, text }: { icon: IconName; text: string }) {
	const p = usePalette();
	return (
		<View style={styles.divider}>
			<View style={[styles.dividerLine, { backgroundColor: p.border }]} />
			<Icon name={icon} size={13} color={p.faint} />
			<Text style={[styles.notice, { color: p.muted }]}>{text}</Text>
			<View style={[styles.dividerLine, { backgroundColor: p.border }]} />
		</View>
	);
}

const TranscriptRow = memo(function TranscriptRow({ item }: { item: TranscriptItem }) {
	const p = usePalette();
	switch (item.kind) {
		case "user":
			return (
				<View style={[styles.user, { backgroundColor: p.userBubble }]}>
					{item.images.map((image, i) => (
						<Image
							// biome-ignore lint/suspicious/noArrayIndexKey: images have no id.
							key={i}
							source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
							style={styles.userImage}
							resizeMode="cover"
						/>
					))}
					{item.text ? (
						<Text selectable style={[styles.userText, { color: p.text }]}>
							{item.text}
						</Text>
					) : null}
				</View>
			);
		case "assistant":
			return <AssistantItem blocks={item.blocks} />;
		case "bash":
			return (
				<View style={[styles.tool, { borderColor: p.border, backgroundColor: p.card }]}>
					<View style={styles.toolHeader}>
						<View style={[styles.toolIcon, { backgroundColor: p.accentSoft }]}>
							<Icon name="terminal-outline" size={14} color={p.accentText} />
						</View>
						<Text style={[styles.toolSummary, styles.flex, { color: p.text }]}>$ {item.message.command}</Text>
					</View>
					<ScrollView horizontal style={[styles.output, styles.bashOutput, { backgroundColor: p.code }]}>
						<Text style={[styles.mono, { color: p.codeText }]}>
							{truncate(item.message.output ?? "", MAX_OUTPUT_CHARS)}
						</Text>
					</ScrollView>
				</View>
			);
		case "compaction":
			return <Divider icon="contract-outline" text="上下文已压缩" />;
		case "branchSummary":
			return <Divider icon="git-branch-outline" text="分支摘要" />;
		case "custom":
			return item.text ? <Markdown text={item.text} /> : null;
		case "toolResult":
			return (
				<Text style={[styles.notice, { color: p.muted }]} numberOfLines={3}>
					{contentText(item.message.content)}
				</Text>
			);
		default:
			return null;
	}
});

export function Transcript({ chat }: { chat: ChatState }) {
	const p = usePalette();
	const items = useMemo(() => buildTranscript(chat), [chat]);
	const waiting = isWaitingForModel(chat, items);
	return (
		<View style={styles.transcript}>
			{items.map((item) => (
				<TranscriptRow key={item.key} item={item} />
			))}
			{waiting ? (
				<View style={[styles.waiting, { backgroundColor: p.accentSoft }]}>
					<ActivityIndicator size="small" color={p.accentText} />
					<Text style={[styles.waitingText, { color: p.accentText }]}>{waitingForModelLabel(chat)}</Text>
				</View>
			) : null}
			{chat.errorMessage && !isBusy(chat.runState) ? (
				<View style={[styles.error, { backgroundColor: p.dangerSoft }]}>
					<Icon name="alert-circle-outline" size={17} color={p.danger} />
					<Text selectable style={[styles.errorText, { color: p.danger }]}>
						{chat.errorMessage}
					</Text>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	transcript: { ...PAGE, gap: 16, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 },
	flex: { flex: 1 },
	user: {
		alignSelf: "flex-end",
		maxWidth: "86%",
		borderRadius: RADIUS.lg,
		borderBottomRightRadius: 6,
		paddingHorizontal: 15,
		paddingVertical: 10,
		gap: 6,
	},
	userText: { fontSize: 15.5, lineHeight: 22 },
	userImage: { width: 160, height: 120, borderRadius: 12 },
	assistant: { gap: 10 },
	tool: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md + 2, overflow: "hidden" },
	toolHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 9 },
	toolIcon: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center" },
	toolMain: { flex: 1, gap: 1 },
	toolName: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
	toolSummary: { fontFamily: MONO, fontSize: 12.5 },
	toolStatus: { fontSize: 12, fontWeight: "500" },
	toolBody: { gap: 6, paddingHorizontal: 8, paddingBottom: 8 },
	subagents: { gap: 6, paddingHorizontal: 8, paddingBottom: 8 },
	subagent: { gap: 2, padding: 9, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md },
	subagentHead: { flexDirection: "row", alignItems: "center", gap: 6 },
	subagentName: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
	subagentModel: { flex: 1, fontSize: 11, fontFamily: MONO, textAlign: "right" },
	subagentMeta: { fontSize: 12 },
	subagentText: { fontSize: 13 },
	subagentDetail: { fontSize: 11, fontFamily: MONO },
	output: { borderRadius: 10, padding: 10, maxHeight: 280 },
	bashOutput: { marginHorizontal: 8, marginBottom: 8 },
	mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
	thinking: { alignSelf: "flex-start", maxWidth: "100%", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
	thinkingHead: { flexDirection: "row", alignItems: "center", gap: 6 },
	thinkingLabel: { fontSize: 13, fontWeight: "600" },
	thinkingText: { fontSize: 13, lineHeight: 19, marginTop: 6 },
	notice: { textAlign: "center", fontSize: 12 },
	divider: { flexDirection: "row", alignItems: "center", gap: 6 },
	dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
	waiting: {
		alignSelf: "flex-start",
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 12,
		paddingVertical: 7,
		borderRadius: 999,
	},
	waitingText: { fontSize: 13, fontWeight: "600" },
	error: { flexDirection: "row", gap: 8, padding: 12, borderRadius: RADIUS.md },
	errorText: { flex: 1, fontSize: 13, lineHeight: 19 },
});
