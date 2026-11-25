import { requireSpeechClient } from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import { SpeechMethodSchemas, type SpeechStatus } from "@pier/protocol";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useStore } from "../store.ts";
import {
	refreshSystemSpeechSupport,
	type SpeechProvider,
	SYSTEM_SPEECH_LANGUAGES,
	setSpeechProvider,
	setSystemSpeechLanguage,
	speechProvider,
	useSpeechSettings,
} from "../system-speech.ts";
import { RADIUS, usePalette } from "../theme.ts";
import { Button, CardHeader, Icon, Muted, Sheet } from "./ui.tsx";

export function SpeechSettings({ client, onClose }: { client: PierClient | undefined; onClose: () => void }) {
	const store = useStore();
	const settings = useSpeechSettings();
	const provider = speechProvider(settings);
	const { support } = settings;
	useEffect(() => {
		refreshSystemSpeechSupport();
	}, []);
	const choose = (next: SpeechProvider) => {
		void setSpeechProvider(next).catch(() => store.toast("error", "无法保存语音设置，请重试"));
	};
	return (
		<Sheet onClose={onClose}>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
				<CardHeader icon="mic-outline" title="语音输入" subtitle="选择这台手机的语音识别方式" />
				<View accessibilityRole="radiogroup" accessibilityLabel="语音识别方式" style={styles.options}>
					<ProviderOption
						value="system"
						title="手机系统识别"
						detail={
							support.available
								? "使用手机自带的语音识别，无需连接电脑或配置服务"
								: `${support.reason}，请使用电脑语音服务`
						}
						selected={provider === "system"}
						disabled={!support.available}
						onPress={choose}
					/>
					<ProviderOption
						value="service"
						title="电脑语音服务"
						detail="录音发送到当前连接的电脑上配置的语音转文字服务"
						selected={provider === "service"}
						onPress={choose}
					/>
				</View>
				{provider === "system" ? (
					<SystemSpeechOptions
						language={settings.language}
						servicePackage={support.available ? support.servicePackage : undefined}
					/>
				) : (
					<ServiceSpeechSettings client={client} />
				)}
				<Button title="关闭" variant="ghost" onPress={onClose} />
			</ScrollView>
		</Sheet>
	);
}

function ProviderOption({
	value,
	title,
	detail,
	selected,
	disabled,
	onPress,
}: {
	value: SpeechProvider;
	title: string;
	detail: string;
	selected: boolean;
	disabled?: boolean;
	onPress: (value: SpeechProvider) => void;
}) {
	const p = usePalette();
	return (
		<Pressable
			testID={`speech-provider-${value}`}
			accessibilityRole="radio"
			accessibilityLabel={title}
			accessibilityHint={detail}
			accessibilityState={{ checked: selected, disabled }}
			aria-checked={selected}
			disabled={disabled}
			onPress={() => onPress(value)}
			style={({ pressed }) => [
				styles.option,
				{ backgroundColor: selected ? p.accentSoft : p.elevated, borderColor: selected ? p.accent : p.border },
				disabled && styles.disabled,
				pressed && styles.pressed,
			]}
		>
			<Icon
				name={selected ? "radio-button-on" : "radio-button-off"}
				size={20}
				color={selected ? p.accentText : p.muted}
			/>
			<View style={styles.optionText}>
				<Text style={[styles.optionTitle, { color: selected ? p.accentText : p.text }]}>{title}</Text>
				<Muted>{detail}</Muted>
			</View>
		</Pressable>
	);
}

function SystemSpeechOptions({ language, servicePackage }: { language: string; servicePackage?: string }) {
	const p = usePalette();
	const store = useStore();
	return (
		<>
			<View style={styles.field}>
				<Text style={{ color: p.text }}>识别语言</Text>
				<View accessibilityRole="radiogroup" accessibilityLabel="系统语音识别语言" style={styles.chips}>
					{SYSTEM_SPEECH_LANGUAGES.map((option) => {
						const selected = language === option.value;
						return (
							<Pressable
								key={option.value || "system"}
								accessibilityRole="radio"
								accessibilityLabel={option.label}
								accessibilityState={{ checked: selected }}
								aria-checked={selected}
								onPress={() => {
									void setSystemSpeechLanguage(option.value).catch(() =>
										store.toast("error", "无法保存语音设置，请重试"),
									);
								}}
								style={({ pressed }) => [
									styles.chip,
									{
										backgroundColor: selected ? p.accentSoft : p.elevated,
										borderColor: selected ? p.accent : p.border,
									},
									pressed && styles.pressed,
								]}
							>
								<Text style={[styles.chipText, { color: selected ? p.accentText : p.text }]}>{option.label}</Text>
							</Pressable>
						);
					})}
				</View>
			</View>
			<Muted>
				说话时由手机系统的语音识别服务转成文字，中途停顿会继续听，点击停止后填入输入框。可能需要联网；每次最多 2
				分钟，识别后可编辑再发送。设置只保存在这台手机。
			</Muted>
			{Platform.OS === "android" && servicePackage ? <Muted>识别服务：{servicePackage}</Muted> : null}
		</>
	);
}

function ServiceSpeechSettings({ client }: { client: PierClient | undefined }) {
	const p = usePalette();
	const [settings, setSettings] = useState<SpeechStatus>();
	const [key, setKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				const result = await requireSpeechClient(client).request("speech.status");
				if (active) setSettings(result);
			} catch (error) {
				if (active) setMessage(error instanceof Error ? error.message : "读取失败");
			}
		})();
		return () => {
			active = false;
		};
	}, [client]);
	return (
		<>
			<Muted>录音发送到你配置的语音转文字服务，设置保存在当前连接的电脑。每次最多 2 分钟，识别后可编辑再发送。</Muted>
			{settings ? (
				<>
					{(
						[
							{ key: "url", label: "接口地址", placeholder: "https://example.com/v1/audio/transcriptions" },
							{ key: "model", label: "模型", placeholder: "whisper-1" },
							{ key: "language", label: "识别语言", placeholder: "自动检测（或 zh / en）" },
						] as const
					).map((field) => (
						<View key={field.key} style={styles.field}>
							<Text style={{ color: p.text }}>{field.label}</Text>
							<TextInput
								accessibilityLabel={field.label}
								value={settings[field.key]}
								placeholder={field.placeholder}
								placeholderTextColor={p.faint}
								autoCapitalize="none"
								autoCorrect={false}
								editable={!pending}
								style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.elevated }]}
								onChangeText={(value) => setSettings({ ...settings, [field.key]: value })}
							/>
						</View>
					))}
					<Muted>填写完整的 OpenAI 兼容转写地址；更换地址时请重新填写 API Key。地址留空可停用。</Muted>
					<Text style={{ color: p.text }}>API Key</Text>
					<TextInput
						accessibilityLabel="语音 API Key"
						value={key}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						editable={!pending && !removeKey}
						placeholder={settings.hasApiKey ? "已保存，留空保留" : "本地服务可留空"}
						placeholderTextColor={p.faint}
						style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.elevated }]}
						onChangeText={setKey}
					/>
					{settings.hasApiKey ? (
						<View style={styles.row}>
							<Text style={{ color: p.text }}>移除已保存的 API Key</Text>
							<Switch
								accessibilityLabel="移除已保存的 API Key"
								value={removeKey}
								disabled={pending}
								onValueChange={setRemoveKey}
							/>
						</View>
					) : null}
					<Button
						title="保存语音设置"
						variant="primary"
						loading={pending}
						onPress={async () => {
							setPending(true);
							setMessage("");
							try {
								const parsed = SpeechMethodSchemas["speech.configure"].safeParse({
									...settings,
									apiKey: removeKey ? "" : key || undefined,
								});
								if (!parsed.success)
									throw new Error("请检查接口地址、模型和语言代码（留空或填写 zh、en 等两字母代码）");
								const result = await requireSpeechClient(client).request("speech.configure", parsed.data);
								setSettings(result);
								setKey("");
								setRemoveKey(false);
								setMessage("语音设置已保存");
							} catch (error) {
								setMessage(error instanceof Error ? error.message : "保存失败");
							} finally {
								setPending(false);
							}
						}}
					/>
				</>
			) : null}
			{message ? (
				<Text accessibilityLiveRegion="polite" style={{ color: p.text }}>
					{message}
				</Text>
			) : null}
		</>
	);
}

const styles = StyleSheet.create({
	form: { padding: 24, gap: 18 },
	field: { gap: 8 },
	input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
	row: { flexDirection: "row", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "center" },
	options: { gap: 10 },
	option: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 12,
		padding: 14,
		borderWidth: 1,
		borderRadius: RADIUS.md,
	},
	optionText: { flex: 1, gap: 4 },
	optionTitle: { fontSize: 15, fontWeight: "600" },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	chip: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: 12, paddingVertical: 8 },
	chipText: { fontSize: 13, fontWeight: "600" },
	disabled: { opacity: 0.55 },
	pressed: { opacity: 0.7 },
});
