import type { AgentRuntimeId, AgentRuntimeInfo } from "@pier/protocol";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { RADIUS, usePalette } from "../theme.ts";
import { Avatar, Button, Icon, type IconName, Muted, Sheet } from "./ui.tsx";

function agentIcon(id: AgentRuntimeId): IconName {
	switch (id) {
		case "pi":
			return "sparkles";
		case "claude-code":
			return "code-slash";
		case "codex":
		case "opencode":
			return "terminal";
		default:
			return "hardware-chip-outline";
	}
}

function agentDescription(id: AgentRuntimeId): string {
	switch (id) {
		case "pi":
			return "Pier 内置，使用在 Pier 中配置的模型与扩展";
		case "claude-code":
			return "电脑上的 Claude Code，使用它自己的登录与配置";
		case "codex":
			return "电脑上的 Codex，使用它自己的登录与配置";
		case "opencode":
			return "电脑上的 OpenCode，使用它自己的模型与配置";
		default:
			return "";
	}
}

/** Bottom sheet for choosing which agent runtime a new session uses. */
export function AgentPicker({
	runtimes,
	workspaceName,
	onPick,
	onClose,
}: {
	runtimes: AgentRuntimeInfo[];
	workspaceName?: string;
	/** Resolves once the session was created (or failed). */
	onPick: (runtime: AgentRuntimeId) => Promise<void>;
	onClose: () => void;
}) {
	const p = usePalette();
	const [creating, setCreating] = useState<AgentRuntimeId>();
	const close = () => {
		if (!creating) onClose();
	};
	return (
		<Sheet onClose={close}>
			<ScrollView contentContainerStyle={styles.content}>
				<View style={styles.head}>
					<Text style={[styles.title, { color: p.text }]}>由哪个 Agent 来做？</Text>
					{workspaceName ? <Muted>在“{workspaceName}”中新建会话</Muted> : null}
				</View>
				<View style={styles.options}>
					{runtimes.map((r) => {
						const busy = creating === r.id;
						return (
							<Pressable
								key={r.id}
								testID={`agent-${r.id}`}
								accessibilityRole="button"
								accessibilityLabel={r.name}
								disabled={creating !== undefined}
								style={({ pressed }) => [
									styles.option,
									{
										backgroundColor: pressed || busy ? p.accentSoft : p.bg,
										borderColor: busy ? p.accent : "transparent",
									},
									creating !== undefined && !busy && styles.dimmed,
								]}
								onPress={async () => {
									setCreating(r.id);
									try {
										await onPick(r.id);
									} finally {
										setCreating(undefined);
									}
								}}
							>
								<Avatar name={r.name} size={44} icon={agentIcon(r.id)} />
								<View style={styles.flex}>
									<View style={styles.nameRow}>
										<Text style={[styles.name, { color: p.text }]} numberOfLines={1}>
											{r.name}
										</Text>
										{r.version ? (
											<Text style={[styles.tag, { color: p.muted, backgroundColor: p.elevated }]} numberOfLines={1}>
												{r.version}
											</Text>
										) : null}
									</View>
									{agentDescription(r.id) ? <Muted>{agentDescription(r.id)}</Muted> : null}
								</View>
								{busy ? (
									<ActivityIndicator size="small" color={p.accent} />
								) : (
									<Icon name="chevron-forward" size={18} color={p.faint} />
								)}
							</Pressable>
						);
					})}
				</View>
				<Button title="取消" variant="secondary" disabled={creating !== undefined} onPress={close} />
			</ScrollView>
		</Sheet>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1, gap: 3 },
	content: { padding: 18, paddingTop: 14, gap: 16 },
	head: { gap: 4, paddingHorizontal: 2 },
	title: { fontSize: 20, fontWeight: "800" },
	options: { gap: 10 },
	option: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 14,
		paddingVertical: 14,
		borderRadius: RADIUS.lg,
		borderWidth: 1.5,
	},
	dimmed: { opacity: 0.5 },
	nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
	name: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
	tag: {
		fontSize: 10.5,
		fontWeight: "600",
		borderRadius: 6,
		paddingHorizontal: 6,
		paddingVertical: 1,
		maxWidth: 120,
		overflow: "hidden",
	},
});
