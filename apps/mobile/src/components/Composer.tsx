import {
	appendDictation,
	type ChatController,
	resolveSlash,
	runBuiltin,
	type SlashActions,
	thinkingLabel,
	VOICE_LABELS,
} from "@pier/chat-state";
import type { ImageInput, ThinkingLevel } from "@pier/protocol";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { isBusy } from "../format.ts";
import { useStore } from "../store.ts";
import { FLOAT_SHADOW, PAGE, RADIUS, THINKING_COLOR, usePalette } from "../theme.ts";
import { useVoiceInput } from "../use-voice-input.ts";
import { type SlashEntry, SlashMenu, useSlashMenu } from "./SlashMenu.tsx";
import { SpeechSettings } from "./SpeechSettings.tsx";
import { Icon, IconButton } from "./ui.tsx";

const MAX_IMAGES = 8;

export function Composer({
	chat,
	runState,
	model,
	thinkingLevel,
	onModelPress,
}: {
	chat: ChatController;
	runState: string;
	/** Current model, shown as a chip in the toolbar. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	onModelPress?: () => void;
}) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const [text, setText] = useState(() => store.draft(chat.sessionId));
	const [images, setImages] = useState<ImageInput[]>([]);
	const [sending, setSending] = useState(false);
	const [focused, setFocused] = useState(false);
	const [speechSettings, setSpeechSettings] = useState(false);
	const latestText = useRef(text);
	latestText.current = text;
	const voice = useVoiceInput(
		store.activeClient,
		chat.sessionId,
		(value) => update(appendDictation(latestText.current, value)),
		(message) => store.toast("error", message),
	);
	useEffect(() => {
		if (sending || chat.chat.closed) voice.cancel();
	}, [sending, chat.chat.closed, voice.cancel]);
	const busy = isBusy(runState as never);
	const canSend = !voice.busy && (text.trim().length > 0 || images.length > 0) && !sending;

	const update = (value: string) => {
		setText(value);
		store.saveDraft(chat.sessionId, value);
	};
	const menu = useSlashMenu(chat, text);
	// The predicted next prompt (1.76): a tap puts it in the input.
	const suggestion =
		!busy && !sending && !voice.busy && !chat.chat.closed && text === "" && images.length === 0
			? chat.chat.suggestion
			: undefined;

	const openSession = (session: { id: string; workspaceId: string } | undefined) => {
		const hostId = store.getState().host.hostId;
		if (!session || !hostId) return false;
		router.push({
			pathname: "/host/[hostId]/session/[sessionId]",
			params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
		});
		return true;
	};
	const actions: SlashActions = {
		newSession: async () => openSession(await store.createSession(chat.workspaceId, chat.chat.session?.runtime)),
		fork: async (entryId) => openSession(await store.forkSession(chat.sessionId, entryId)),
		notify: (level, message) => store.toast(level === "error" ? "error" : "info", message),
	};

	const pickImages = async () => {
		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ["images"],
			allowsMultipleSelection: true,
			selectionLimit: MAX_IMAGES - images.length,
			base64: true,
			quality: 0.7,
		});
		if (result.canceled) return;
		const picked = result.assets
			.filter((asset) => asset.base64)
			.map((asset) => ({
				type: "image" as const,
				data: asset.base64 as string,
				mimeType: asset.mimeType?.startsWith("image/") ? asset.mimeType : "image/jpeg",
			}));
		setImages((current) => [...current, ...picked].slice(0, MAX_IMAGES));
	};

	const send = async (mode: "auto" | "steer" | "followUp", override?: string) => {
		const body = (override ?? text).trim();
		if (voice.busy || sending || (!body && !images.length)) return;
		let resolution = resolveSlash(body, menu.list.commands, menu.list.known, chat.chat.session?.runtime);
		if (resolution.kind === "unknown" || (resolution.kind === "host" && !menu.list.known)) {
			const fresh = await chat.loadCommands();
			resolution = resolveSlash(body, fresh.commands, fresh.known, chat.chat.session?.runtime);
		}
		if (resolution.kind === "unknown") {
			store.toast("error", `未知命令 /${resolution.name}，输入 / 查看可用的命令`);
			return;
		}
		setSending(true);
		if (resolution.kind === "builtin") {
			const previous = override ?? text;
			update("");
			const result = await runBuiltin(chat, resolution.name, resolution.args, actions);
			setSending(false);
			if (result.kind === "failed") update(previous);
			else if (result.kind === "complete") update(result.text);
			return;
		}
		const result =
			resolution.kind === "host" ? await chat.sendCommand(body, images, mode) : await chat.send(body, images, mode);
		setSending(false);
		if (result !== undefined) {
			update("");
			setImages([]);
		}
	};

	const pick = (entry: SlashEntry) => {
		const next = entry.pick();
		if (next.run) void send(busy ? "steer" : "auto", next.text);
		else update(next.text);
	};

	return (
		<View style={styles.root}>
			<SlashMenu menu={menu} onPick={pick} />
			{suggestion ? (
				<View style={styles.suggestionRow}>
					<Pressable
						onPress={() => update(suggestion)}
						accessibilityRole="button"
						accessibilityLabel={`填入建议：${suggestion}`}
						testID="suggestion-chip"
						style={({ pressed }) => [
							styles.suggestion,
							{ backgroundColor: p.card, borderColor: p.border },
							pressed && styles.pressed,
						]}
					>
						<Icon name="sparkles-outline" size={13} color={p.accentText} />
						<Text style={[styles.suggestionText, { color: p.text }]} numberOfLines={2}>
							{suggestion}
						</Text>
					</Pressable>
					<IconButton icon="close" label="忽略建议" size={40} onPress={() => chat.dismissSuggestion()} />
				</View>
			) : null}
			<View style={[styles.box, FLOAT_SHADOW, { backgroundColor: p.card, borderColor: focused ? p.accent : p.border }]}>
				{images.length ? (
					<ScrollView horizontal style={styles.images} contentContainerStyle={styles.imagesContent}>
						{images.map((image, index) => (
							<Pressable
								// biome-ignore lint/suspicious/noArrayIndexKey: attachments have no id.
								key={index}
								onPress={() => setImages(images.filter((_, i) => i !== index))}
								accessibilityLabel="移除图片"
							>
								<Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={styles.thumb} />
								<View style={styles.remove}>
									<Icon name="close" size={13} color="#fff" />
								</View>
							</Pressable>
						))}
					</ScrollView>
				) : null}
				<TextInput
					testID="composer-input"
					value={text}
					onChangeText={update}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					multiline
					placeholder={busy ? "引导 Agent，或排队下一条…" : "给 Agent 发消息，输入 / 使用命令"}
					placeholderTextColor={p.faint}
					selectionColor={p.accent}
					accessibilityLabel="消息输入框"
					style={[styles.input, { color: p.text }]}
				/>
				{voice.busy ? (
					<View style={styles.modes}>
						<Text accessibilityLiveRegion="polite" style={[styles.hint, styles.flex, { color: p.muted }]}>
							{VOICE_LABELS[voice.phase]}
						</Text>
						<Pressable accessibilityRole="button" accessibilityLabel="取消语音输入" onPress={voice.cancel}>
							<Text style={{ color: p.danger }}>取消</Text>
						</Pressable>
					</View>
				) : null}
				<View style={styles.toolbar}>
					<IconButton
						icon={voice.phase === "recording" ? "stop" : "mic-outline"}
						label={VOICE_LABELS[voice.phase]}
						size={44}
						tone={voice.phase === "recording" ? "danger" : "elevated"}
						disabled={sending || !!chat.chat.closed || (voice.busy && voice.phase !== "recording")}
						onPress={voice.phase === "recording" ? voice.stop : voice.start}
						testID="voice-input-button"
					/>
					<IconButton
						icon="image-outline"
						label="添加图片"
						size={44}
						tone="elevated"
						onPress={() => void pickImages()}
					/>
					{model ? (
						<Pressable
							onPress={onModelPress}
							accessibilityRole="button"
							accessibilityLabel="切换模型"
							style={({ pressed }) => [
								styles.modelChip,
								{ backgroundColor: p.accentSoft, borderColor: p.accentRing },
								pressed && styles.pressed,
							]}
						>
							<Icon name="sparkles-outline" size={13} color={p.accentText} />
							<Text style={[styles.modelText, { color: p.accentText }]} numberOfLines={1}>
								{model}
							</Text>
							{thinkingLevel ? (
								<Text style={[styles.thinkingText, { color: THINKING_COLOR }]} numberOfLines={1}>
									<Text style={{ color: p.faint }}>· </Text>
									{thinkingLabel(thinkingLevel)}
								</Text>
							) : null}
							<Icon name="chevron-down" size={13} color={p.faint} />
							{chat.chat.fastMode ? <Text style={{ color: p.accentText }}>· Fast</Text> : null}
						</Pressable>
					) : (
						<View style={styles.flex} />
					)}
					{busy && !canSend ? (
						<Pressable
							onPress={() => void chat.abort()}
							style={({ pressed }) => [styles.send, { backgroundColor: p.danger }, pressed && styles.pressed]}
							accessibilityLabel="中止"
							testID="abort-button"
						>
							<Icon name="stop" size={15} color="#fff" />
						</Pressable>
					) : (
						<Pressable
							onPress={() => void send("auto")}
							disabled={!canSend}
							style={({ pressed }) => [
								styles.send,
								{ backgroundColor: canSend ? p.accent : p.elevated },
								pressed && styles.pressed,
							]}
							accessibilityLabel={busy ? "引导" : "发送"}
							testID="send-button"
						>
							<Icon name="arrow-up" size={20} color={canSend ? p.onAccent : p.faint} />
						</Pressable>
					)}
				</View>
			</View>
			{!voice.busy ? (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="语音设置"
					onPress={() => setSpeechSettings(true)}
					style={styles.voiceSettings}
				>
					<Text style={[styles.hint, { color: p.muted }]}>语音设置</Text>
				</Pressable>
			) : null}
			{speechSettings ? <SpeechSettings client={store.activeClient} onClose={() => setSpeechSettings(false)} /> : null}
			{busy && canSend ? (
				<View style={styles.modes}>
					<Icon name="flash-outline" size={13} color={p.muted} />
					<Text style={[styles.hint, styles.flex, { color: p.muted }]}>运行中：发送即引导</Text>
					<Pressable hitSlop={6} onPress={() => void send("followUp")}>
						<Text style={[styles.link, { color: p.accentText }]}>排队到结束后</Text>
					</Pressable>
					<Pressable hitSlop={6} onPress={() => void chat.abort()}>
						<Text style={[styles.link, { color: p.danger }]}>中止</Text>
					</Pressable>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	voiceSettings: { alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6 },
	flex: { flex: 1 },
	root: { ...PAGE, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 6 },
	box: { borderRadius: RADIUS.lg, borderWidth: 1, paddingTop: 4, paddingBottom: 8, paddingHorizontal: 8 },
	input: {
		minHeight: 56,
		maxHeight: 150,
		paddingHorizontal: 8,
		paddingTop: 10,
		paddingBottom: 8,
		fontSize: 15.5,
		lineHeight: 21,
	},
	toolbar: { flexDirection: "row", alignItems: "center", gap: 8 },
	suggestionRow: { flexDirection: "row", alignItems: "center", gap: 4 },
	suggestion: {
		flex: 1,
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		minHeight: 40,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: RADIUS.md,
		borderWidth: StyleSheet.hairlineWidth,
	},
	suggestionText: { flex: 1, fontSize: 14, lineHeight: 19 },
	modelChip: {
		flexShrink: 1,
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "center",
		gap: 5,
		minHeight: 44,
		paddingHorizontal: 11,
		borderRadius: RADIUS.pill,
		borderWidth: StyleSheet.hairlineWidth,
	},
	modelText: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
	thinkingText: { fontSize: 13, fontWeight: "500", flexShrink: 0 },
	send: {
		width: 44,
		height: 44,
		borderRadius: RADIUS.md,
		alignItems: "center",
		justifyContent: "center",
		marginLeft: "auto",
	},
	pressed: { opacity: 0.75 },
	modes: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, paddingHorizontal: 12 },
	// Only row hints should flex; growing the voice-settings label vertically collapses the transcript.
	hint: { fontSize: 12 },
	link: { fontSize: 13, fontWeight: "600", marginLeft: 8 },
	images: { maxHeight: 80, marginTop: 4 },
	imagesContent: { gap: 8, paddingHorizontal: 4, paddingTop: 4 },
	thumb: { width: 64, height: 64, borderRadius: 14 },
	remove: {
		position: "absolute",
		top: 4,
		right: 4,
		width: 20,
		height: 20,
		borderRadius: 10,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(0,0,0,0.6)",
	},
});
