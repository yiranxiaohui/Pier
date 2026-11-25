import { Pressable, StyleSheet, Text, View } from "react-native";
import { useStore } from "../store.ts";
import { PALETTES, RADIUS, usePalette } from "../theme.ts";
import { setThemePreference, type ThemePreference, useThemePreference } from "../theme-preference.ts";
import { Card, CardHeader, Icon, type IconName, Muted } from "./ui.tsx";

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: IconName }> = [
	{ value: "system", label: "跟随系统", icon: "phone-portrait-outline" },
	{ value: "light", label: "浅色", icon: "sunny-outline" },
	{ value: "dark", label: "深色", icon: "moon-outline" },
];

export function AppearanceSettings() {
	const p = usePalette();
	const store = useStore();
	const preference = useThemePreference();
	return (
		<Card style={styles.card}>
			<CardHeader icon="color-palette-outline" title="外观" subtitle="选择这台设备的界面主题" />
			<View accessibilityRole="radiogroup" accessibilityLabel="界面主题" style={styles.options}>
				{OPTIONS.map((option) => {
					const selected = preference === option.value;
					const preview =
						option.value === "dark" || (option.value === "system" && p.dark) ? PALETTES.dark : PALETTES.light;
					return (
						<Pressable
							key={option.value}
							testID={`theme-${option.value}`}
							accessibilityRole="radio"
							accessibilityLabel={option.label}
							accessibilityState={{ checked: selected }}
							aria-checked={selected}
							onPress={() => {
								void setThemePreference(option.value).catch(() => store.toast("error", "无法保存主题，请重试"));
							}}
							style={({ pressed }) => [
								styles.option,
								{
									backgroundColor: selected ? p.accentSoft : p.elevated,
									borderColor: selected ? p.accent : p.border,
								},
								pressed && { opacity: 0.7 },
							]}
						>
							<View style={[styles.preview, { backgroundColor: preview.bg }]}>
								<View style={[styles.previewSidebar, { backgroundColor: preview.elevated }]}>
									<View style={[styles.previewDot, { backgroundColor: preview.accent }]} />
								</View>
								<View style={styles.previewContent}>
									<View style={[styles.previewLine, { backgroundColor: preview.muted }]} />
									<View style={[styles.previewBubble, { backgroundColor: preview.card }]} />
									<View style={[styles.previewButton, { backgroundColor: preview.accent }]} />
								</View>
							</View>
							<View style={styles.optionLabel}>
								<Icon name={option.icon} size={15} color={selected ? p.accentText : p.muted} />
								<Text style={[styles.label, { color: selected ? p.accentText : p.text }]}>{option.label}</Text>
							</View>
						</Pressable>
					);
				})}
			</View>
			<View style={[styles.brand, { borderColor: p.border }]}>
				<View style={[styles.swatch, { backgroundColor: p.accent }]} />
				<View style={styles.brandText}>
					<Text style={[styles.brandTitle, { color: p.text }]}>Pier 暖墨</Text>
					<Muted>与桌面端一致的主题色</Muted>
				</View>
				<Icon name="checkmark-circle" size={22} color={p.accentText} />
			</View>
		</Card>
	);
}

const styles = StyleSheet.create({
	card: { gap: 16 },
	options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	option: { flex: 1, minWidth: 76, padding: 8, borderWidth: 1, borderRadius: RADIUS.md, gap: 10 },
	preview: { height: 66, borderRadius: RADIUS.sm, flexDirection: "row", overflow: "hidden" },
	previewSidebar: { width: 18, paddingTop: 9, alignItems: "center" },
	previewDot: { width: 6, height: 6, borderRadius: 2 },
	previewContent: { flex: 1, padding: 8, gap: 7 },
	previewLine: { width: "70%", height: 3, borderRadius: 2 },
	previewBubble: { width: "100%", height: 15, borderRadius: 3 },
	previewButton: { width: 16, height: 8, borderRadius: 3, alignSelf: "flex-end" },
	optionLabel: { alignItems: "center", justifyContent: "center", flexDirection: "row", flexWrap: "wrap", gap: 4 },
	label: { fontSize: 12, fontWeight: "600" },
	brand: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		borderTopWidth: StyleSheet.hairlineWidth,
		paddingTop: 14,
	},
	swatch: { width: 34, height: 34, borderRadius: RADIUS.md },
	brandText: { flex: 1 },
	brandTitle: { fontSize: 14, fontWeight: "600" },
});
