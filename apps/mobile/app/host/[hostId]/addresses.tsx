import { fromBase64Url, keyFingerprint, normalizeRelayUrl } from "@pier/crypto";
import { addressPort, DEFAULT_PIER_PORT, parsePeerAddresses } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoider } from "../../../src/components/KeyboardAvoider.tsx";
import { Button, Card, CardHeader, Icon, Muted, Screen } from "../../../src/components/ui.tsx";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, RADIUS, usePalette } from "../../../src/theme.ts";

function fingerprintOf(publicKey: string | undefined): string {
	if (!publicKey) return "";
	try {
		return keyFingerprint(fromBase64Url(publicKey));
	} catch {
		return "";
	}
}

/** Edit the addresses used to reach a paired computer, e.g. after its IP changed. */
export default function HostAddresses() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const { hostId } = useLocalSearchParams<{ hostId: string }>();
	const host = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId));
	const [text, setText] = useState(() => host?.addresses.join("\n") ?? "");
	const [relayText, setRelayText] = useState(() => (host?.relays ?? []).join("\n"));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const fingerprint = useMemo(() => fingerprintOf(host?.hostPublicKey), [host?.hostPublicKey]);

	if (!host) {
		return (
			<Screen>
				<Stack.Screen options={{ title: "连接地址" }} />
				<Muted style={styles.missing}>这台电脑已不在列表中。</Muted>
			</Screen>
		);
	}

	const defaultPort = addressPort(host.addresses[0]) ?? DEFAULT_PIER_PORT;
	const { addresses, invalid } = parsePeerAddresses(text, defaultPort);
	const relays: string[] = [];
	const invalidRelays: string[] = [];
	for (const item of relayText.split(/[\s,，、;；]+/)) {
		if (!item.trim()) continue;
		try {
			const url = normalizeRelayUrl(item);
			if (!relays.includes(url)) relays.push(url);
		} catch {
			invalidRelays.push(item.trim());
		}
	}
	const unchanged =
		addresses.join(",") === host.addresses.join(",") && relays.join(",") === (host.relays ?? []).join(",");
	const empty = !addresses.length && !relays.length;
	const blocked = invalid.length > 0 || invalidRelays.length > 0 || empty;
	const save = async () => {
		if (busy || blocked) return;
		if (unchanged) {
			router.back();
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await store.setHostAddresses(host.hostId, addresses, relays);
			store.toast("info", "已保存，正在用新地址连接");
			router.back();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};

	return (
		<Screen>
			<Stack.Screen options={{ title: `${host.hostName} 的地址` }} />
			<KeyboardAvoider style={styles.flex}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<Card style={styles.card}>
						<CardHeader icon="swap-horizontal" title="连接地址" subtitle="电脑的 IP 变了时在这里修改，不用重新配对" />
						<Muted>
							每行一个地址，格式为 IP:端口（省略端口时使用 {defaultPort}
							），连接时按顺序尝试；也可以填域名或 Tailscale 地址。电脑上的地址可以在 Pier 的「远程主机 → 本机 →
							连接管理」中看到。
						</Muted>
						<TextInput
							testID="host-addresses-input"
							value={text}
							onChangeText={(value) => {
								setText(value);
								setError(undefined);
							}}
							multiline
							editable={!busy}
							placeholder={`192.168.1.20:${defaultPort}`}
							placeholderTextColor={p.faint}
							autoCapitalize="none"
							autoCorrect={false}
							textAlignVertical="top"
							style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
						/>
						<Muted>中继服务器（可选）：手机与电脑不在同一网络时，经电脑上配置的 Pier Relay 连接。</Muted>
						<TextInput
							testID="host-relays-input"
							value={relayText}
							onChangeText={(value) => {
								setRelayText(value);
								setError(undefined);
							}}
							multiline
							editable={!busy}
							placeholder="wss://relay.example.com"
							placeholderTextColor={p.faint}
							autoCapitalize="none"
							autoCorrect={false}
							textAlignVertical="top"
							style={[styles.input, styles.relayInput, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
						/>
						{invalid.length || invalidRelays.length ? (
							<Text style={[styles.small, { color: p.danger }]}>
								无法识别的地址：{[...invalid, ...invalidRelays].join("、")}
							</Text>
						) : empty ? (
							<Muted>至少需要一个地址或中继服务器。</Muted>
						) : (
							<Muted>
								将依次尝试：
								<Text style={styles.mono}>{[...addresses, ...relays.map((r) => `中继 ${r}`)].join("、")}</Text>
							</Muted>
						)}
						{fingerprint ? (
							<View style={[styles.secure, { backgroundColor: p.okSoft }]}>
								<Icon name="shield-checkmark-outline" size={18} color={p.ok} />
								<Muted style={styles.flex}>
									只会连接密钥指纹为 <Text style={[styles.mono, { color: p.text }]}>{fingerprint}</Text>{" "}
									的电脑；地址上如果是另一台电脑，连接会被拒绝。
								</Muted>
							</View>
						) : null}
						{error ? <Text style={[styles.small, { color: p.danger }]}>{error}</Text> : null}
						<Button
							title="保存并重新连接"
							icon="refresh"
							variant="primary"
							loading={busy}
							disabled={blocked}
							onPress={() => void save()}
							testID="host-addresses-save"
						/>
					</Card>
				</ScrollView>
			</KeyboardAvoider>
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	content: { padding: 16, gap: 14 },
	card: { gap: 12 },
	secure: { flexDirection: "row", gap: 10, padding: 12, borderRadius: RADIUS.md },
	missing: { padding: 24, textAlign: "center" },
	input: {
		borderWidth: 1,
		borderRadius: RADIUS.md,
		paddingHorizontal: 14,
		paddingVertical: 11,
		fontSize: 14,
		fontFamily: MONO,
		minHeight: 110,
	},
	relayInput: { minHeight: 60 },
	small: { fontSize: 13 },
	mono: { fontFamily: MONO },
});
