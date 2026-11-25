import Ionicons from "@expo/vector-icons/Ionicons";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Animated,
	Easing,
	Keyboard,
	Modal,
	Platform,
	Pressable,
	type StyleProp,
	StyleSheet,
	Text,
	TextInput,
	type TextStyle,
	View,
	type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileState, useStore } from "../store.ts";
import { FLOAT_SHADOW, MONO, type Palette, RADIUS, SHADOW, tileColors, usePalette } from "../theme.ts";

export type IconName = ComponentProps<typeof Ionicons>["name"];

export function Icon({
	name,
	size = 20,
	color,
	style,
}: {
	name: IconName;
	size?: number;
	color: string;
	style?: StyleProp<TextStyle>;
}) {
	return <Ionicons name={name} size={size} color={color} style={style} />;
}

/** Ask before a destructive action (`window.confirm` on web). */
export function confirmDestructive(title: string, message: string, action: string, onConfirm: () => void): void {
	if (Platform.OS === "web") {
		if (globalThis.confirm?.(`${title}\n\n${message}`)) onConfirm();
		return;
	}
	Alert.alert(title, message, [
		{ text: "取消", style: "cancel" },
		{ text: action, style: "destructive", onPress: onConfirm },
	]);
}

type Variant = "primary" | "secondary" | "tonal" | "danger" | "destructive" | "ghost" | "outline";

function variantStyle(p: Palette, variant: Variant): { box: ViewStyle; color: string } {
	switch (variant) {
		case "primary":
			return { box: { backgroundColor: p.accent }, color: p.onAccent };
		case "tonal":
			return { box: { backgroundColor: p.accentSoft }, color: p.accentText };
		case "danger":
			return { box: { backgroundColor: p.dangerSoft }, color: p.danger };
		case "destructive":
			return { box: { backgroundColor: p.danger }, color: "#fff" };
		case "ghost":
			return { box: { backgroundColor: "transparent" }, color: p.accentText };
		case "outline":
			return {
				box: { backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border },
				color: p.text,
			};
		default:
			return { box: { backgroundColor: p.elevated }, color: p.text };
	}
}

export function Button({
	title,
	onPress,
	variant = "secondary",
	disabled,
	loading,
	style,
	small,
	icon,
	testID,
}: {
	title: string;
	onPress: () => void;
	variant?: Variant;
	disabled?: boolean;
	loading?: boolean;
	style?: StyleProp<ViewStyle>;
	small?: boolean;
	/** Icon shown before the title. */
	icon?: IconName;
	testID?: string;
}) {
	const p = usePalette();
	const v = variantStyle(p, variant);
	return (
		<Pressable
			testID={testID}
			accessibilityRole="button"
			accessibilityLabel={title}
			disabled={disabled || loading}
			onPress={onPress}
			style={({ pressed }) => [
				styles.button,
				small && styles.buttonSmall,
				v.box,
				(disabled || loading) && styles.disabled,
				pressed && styles.pressed,
				style,
			]}
		>
			{loading ? <ActivityIndicator size="small" color={v.color} /> : null}
			{icon && !loading ? <Icon name={icon} size={small ? 16 : 19} color={v.color} /> : null}
			<Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: v.color }]} numberOfLines={1}>
				{title}
			</Text>
		</Pressable>
	);
}

/** Round icon-only button. */
export function IconButton({
	icon,
	label,
	onPress,
	size = 38,
	tone = "plain",
	disabled,
	testID,
	style,
}: {
	icon: IconName;
	/** Accessibility label. */
	label: string;
	onPress?: () => void;
	size?: number;
	tone?: "plain" | "elevated" | "accent" | "tonal" | "danger";
	disabled?: boolean;
	testID?: string;
	style?: StyleProp<ViewStyle>;
}) {
	const p = usePalette();
	const [bg, fg] = {
		plain: ["transparent", p.text],
		elevated: [p.elevated, p.text],
		accent: [p.accent, p.onAccent],
		tonal: [p.accentSoft, p.accentText],
		danger: [p.dangerSoft, p.danger],
	}[tone] as [string, string];
	return (
		<Pressable
			testID={testID}
			hitSlop={6}
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			style={({ pressed }) => [
				{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
				styles.iconButton,
				pressed && { backgroundColor: tone === "plain" ? p.elevated : bg, opacity: tone === "plain" ? 1 : 0.7 },
				disabled && styles.disabled,
				style,
			]}
		>
			<Icon name={icon} size={Math.round(size * 0.52)} color={fg} />
		</Pressable>
	);
}

/**
 * Navigation-header action: an icon button, or a compact pill with `text` (and the icon, if any)
 * when the action needs words.
 */
export function HeaderAction({
	label,
	icon,
	text,
	onPress,
}: {
	label: string;
	icon?: IconName;
	/** Visible text; without it an icon-only button is shown. */
	text?: string;
	onPress?: () => void;
}) {
	const p = usePalette();
	if (icon && !text) return <IconButton icon={icon} label={label} onPress={onPress} size={38} tone="elevated" />;
	return (
		<Pressable
			hitSlop={8}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			style={({ pressed }) => [styles.headerAction, { backgroundColor: p.elevated }, pressed && styles.pressed]}
		>
			{icon ? <Icon name={icon} size={17} color={p.text} /> : null}
			<Text style={[styles.headerActionText, { color: p.text }]}>{text ?? label}</Text>
		</Pressable>
	);
}

export function Card({
	children,
	style,
	flat,
}: {
	children: ReactNode;
	style?: StyleProp<ViewStyle>;
	/** No shadow, e.g. for nested or banner cards. */
	flat?: boolean;
}) {
	const p = usePalette();
	return (
		<View style={[styles.card, !flat && SHADOW, { backgroundColor: p.card, borderColor: p.border }, style]}>
			{children}
		</View>
	);
}

/** Icon tile, title and optional subtitle at the top of a card. */
export function CardHeader({
	icon,
	title,
	subtitle,
	tone = "accent",
	right,
}: {
	icon: IconName;
	title: string;
	subtitle?: string;
	tone?: "accent" | "warning" | "danger" | "muted";
	right?: ReactNode;
}) {
	const p = usePalette();
	const [bg, fg] = {
		accent: [p.accentSoft, p.accentText],
		warning: [p.warningSoft, p.warning],
		danger: [p.dangerSoft, p.danger],
		muted: [p.elevated, p.muted],
	}[tone] as [string, string];
	return (
		<View style={styles.cardHeader}>
			<View style={[styles.cardHeaderIcon, { backgroundColor: bg }]}>
				<Icon name={icon} size={19} color={fg} />
			</View>
			<View style={styles.flex}>
				<Text style={[styles.cardHeaderTitle, { color: p.text }]} numberOfLines={1}>
					{title}
				</Text>
				{subtitle ? (
					<Text style={[styles.cardHeaderSubtitle, { color: p.muted }]} numberOfLines={2}>
						{subtitle}
					</Text>
				) : null}
			</View>
			{right}
		</View>
	);
}

export function StatusDot({ color, size = 8, ring }: { color: string; size?: number; ring?: string }) {
	return (
		<View
			style={{
				width: size,
				height: size,
				borderRadius: size / 2,
				backgroundColor: color,
				...(ring ? { borderWidth: 2, borderColor: ring } : {}),
			}}
		/>
	);
}

/** A dot with a soft, pulsing halo, for things that are running right now. */
export function PulseDot({ color, size = 8 }: { color: string; size?: number }) {
	const pulse = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		const loop = Animated.loop(
			Animated.timing(pulse, {
				toValue: 1,
				duration: 1400,
				easing: Easing.out(Easing.quad),
				useNativeDriver: Platform.OS !== "web",
			}),
		);
		loop.start();
		return () => loop.stop();
	}, [pulse]);
	return (
		<View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
			<Animated.View
				style={{
					position: "absolute",
					width: size,
					height: size,
					borderRadius: size / 2,
					backgroundColor: color,
					opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
					transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
				}}
			/>
			<StatusDot color={color} size={size} />
		</View>
	);
}

/** Rounded tile used as an icon for hosts, workspaces and agents; colored from the name. */
export function Avatar({
	name,
	size = 40,
	icon,
	tone = "auto",
	children,
}: {
	name: string;
	size?: number;
	/** Show this icon instead of the name's first letter. */
	icon?: IconName;
	tone?: "auto" | "accent" | "muted";
	children?: ReactNode;
}) {
	const p = usePalette();
	const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
	const colors =
		tone === "accent"
			? { bg: p.accentSoft, fg: p.accentText }
			: tone === "muted"
				? { bg: p.elevated, fg: p.muted }
				: tileColors(p, name);
	return (
		<View
			style={{
				width: size,
				height: size,
				borderRadius: size * 0.3,
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: colors.bg,
			}}
		>
			{icon ? (
				<Icon name={icon} size={Math.round(size * 0.5)} color={colors.fg} />
			) : (
				<Text style={{ color: colors.fg, fontSize: size * 0.42, fontWeight: "700" }}>{letter}</Text>
			)}
			{children}
		</View>
	);
}

export function Pill({
	text,
	tone = "muted",
	dot,
	pulse,
	icon,
}: {
	text: string;
	tone?: "muted" | "accent" | "warning" | "danger" | "ok";
	dot?: boolean;
	/** Animated dot for live states. */
	pulse?: boolean;
	icon?: IconName;
}) {
	const p = usePalette();
	const colors = {
		muted: [p.elevated, p.muted],
		accent: [p.accentSoft, p.accentText],
		warning: [p.warningSoft, p.warning],
		danger: [p.dangerSoft, p.danger],
		ok: [p.okSoft, p.ok],
	}[tone] as [string, string];
	return (
		<View style={[styles.pill, { backgroundColor: colors[0] }]}>
			{pulse ? <PulseDot color={colors[1]} size={6} /> : dot ? <StatusDot color={colors[1]} size={6} /> : null}
			{icon ? <Icon name={icon} size={12} color={colors[1]} /> : null}
			<Text style={[styles.pillText, { color: colors[1] }]} numberOfLines={1}>
				{text}
			</Text>
		</View>
	);
}

/** Height of the soft keyboard while it is shown (0 when hidden), on iOS and Android. */
export function useKeyboardHeight(): number {
	const [height, setHeight] = useState(0);
	useEffect(() => {
		if (Platform.OS === "web") return;
		const ios = Platform.OS === "ios";
		const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) =>
			setHeight(Math.max(0, e.endCoordinates.height)),
		);
		const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setHeight(0));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return height;
}

/** Modal panel that slides up from the bottom of the screen over a fading scrim; stays above the keyboard. */
export function Sheet({
	children,
	onClose,
	style,
}: {
	children: ReactNode;
	onClose: () => void;
	style?: StyleProp<ViewStyle>;
}) {
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const keyboard = useKeyboardHeight();
	const enter = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		Animated.timing(enter, {
			toValue: 1,
			duration: 260,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: Platform.OS !== "web",
		}).start();
	}, [enter]);
	// Android reports the keyboard above the navigation bar, which the sheet still has to clear.
	const paddingBottom = keyboard ? 12 + (Platform.OS === "android" ? insets.bottom : 0) : insets.bottom + 12;
	return (
		<Modal transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
			<Pressable style={[styles.backdrop, { backgroundColor: p.scrim }]} onPress={onClose} accessibilityLabel="关闭" />
			<Animated.View
				style={[
					styles.sheet,
					{
						backgroundColor: p.card,
						bottom: keyboard,
						maxHeight: keyboard ? "70%" : "86%",
						paddingBottom,
						transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [360, 0] }) }],
					},
					style,
				]}
			>
				<View style={[styles.grabber, { backgroundColor: p.border }]} />
				{children}
			</Animated.View>
		</Modal>
	);
}

/**
 * A sheet asking for one line (or a few lines) of text, e.g. a new name. `onSubmit` resolves to
 * whether the sheet may close; on failure it stays open with the text kept.
 */
export function PromptSheet({
	title,
	message,
	initialValue = "",
	placeholder,
	confirm = "确定",
	multiline,
	allowEmpty,
	mono,
	onSubmit,
	onClose,
}: {
	title: string;
	message?: string;
	initialValue?: string;
	placeholder?: string;
	confirm?: string;
	multiline?: boolean;
	/** Allow submitting an empty value (for optional input). */
	allowEmpty?: boolean;
	/** Monospace input, for paths and package sources. */
	mono?: boolean;
	onSubmit: (value: string) => Promise<boolean> | boolean;
	onClose: () => void;
}) {
	const p = usePalette();
	const [value, setValue] = useState(initialValue);
	const [busy, setBusy] = useState(false);
	const trimmed = value.trim();
	const submit = async () => {
		if (busy || (!trimmed && !allowEmpty)) return;
		setBusy(true);
		let done = false;
		try {
			done = await onSubmit(trimmed);
		} finally {
			setBusy(false);
		}
		if (done) onClose();
	};
	return (
		<Sheet onClose={onClose}>
			<View style={styles.sheetContent}>
				<View style={styles.sheetHead}>
					<Text style={[styles.sheetTitle, { color: p.text }]}>{title}</Text>
					{message ? <Muted>{message}</Muted> : null}
				</View>
				<TextInput
					testID="prompt-input"
					autoFocus
					value={value}
					onChangeText={setValue}
					placeholder={placeholder}
					placeholderTextColor={p.faint}
					multiline={multiline}
					autoCapitalize="none"
					autoCorrect={!mono}
					spellCheck={!mono}
					returnKeyType={multiline ? "default" : "done"}
					onSubmitEditing={multiline ? undefined : () => void submit()}
					style={[
						styles.promptInput,
						multiline && styles.promptMultiline,
						mono && { fontFamily: MONO, fontSize: 14 },
						{ color: p.text, borderColor: p.border, backgroundColor: p.bg },
					]}
				/>
				<View style={styles.sheetButtons}>
					<Button title="取消" onPress={onClose} style={styles.flex} />
					<Button
						title={confirm}
						variant="primary"
						loading={busy}
						disabled={!trimmed && !allowEmpty}
						onPress={() => void submit()}
						style={styles.flex}
						testID="prompt-confirm"
					/>
				</View>
			</View>
		</Sheet>
	);
}

export interface SheetAction {
	label: string;
	/** One line under the label explaining the effect. */
	description?: string;
	icon?: IconName;
	danger?: boolean;
	testID?: string;
	onPress: () => void;
	/** Ask inside the sheet before running the action. */
	confirm?: { title: string; message: string; action: string };
}

/** Bottom sheet with a short header and a list of actions, replacing the native alert menu. */
export function ActionSheet({
	title,
	subtitle,
	actions,
	onClose,
}: {
	title: string;
	subtitle?: string;
	actions: SheetAction[];
	onClose: () => void;
}) {
	const p = usePalette();
	const [confirming, setConfirming] = useState<SheetAction>();
	const run = (action: SheetAction) => {
		onClose();
		action.onPress();
	};
	if (confirming?.confirm) {
		const { confirm } = confirming;
		return (
			<Sheet onClose={onClose}>
				<View style={styles.sheetContent}>
					<View style={[styles.confirmIcon, { backgroundColor: p.dangerSoft }]}>
						<Icon name={confirming.icon ?? "warning-outline"} size={24} color={p.danger} />
					</View>
					<View style={[styles.sheetHead, styles.center]}>
						<Text style={[styles.sheetTitle, styles.centerText, { color: p.text }]}>{confirm.title}</Text>
						<Muted style={[styles.sheetMessage, styles.centerText]}>{confirm.message}</Muted>
					</View>
					<View style={styles.sheetButtons}>
						<Button title="取消" onPress={onClose} style={styles.flex} />
						<Button
							title={confirm.action}
							variant="destructive"
							onPress={() => run(confirming)}
							style={styles.flex}
							testID={confirming.testID ? `${confirming.testID}-confirm` : undefined}
						/>
					</View>
				</View>
			</Sheet>
		);
	}
	return (
		<Sheet onClose={onClose}>
			<View style={styles.sheetContent}>
				<View style={styles.sheetHead}>
					<Text style={[styles.sheetTitle, { color: p.text }]} numberOfLines={2}>
						{title}
					</Text>
					{subtitle ? <Muted numberOfLines={3}>{subtitle}</Muted> : null}
				</View>
				<View style={[styles.sheetGroup, { backgroundColor: p.bg }]}>
					{actions.map((action, index) => {
						const color = action.danger ? p.danger : p.text;
						return (
							<Pressable
								key={action.label}
								testID={action.testID}
								accessibilityRole="button"
								accessibilityLabel={action.label}
								onPress={() => (action.confirm ? setConfirming(action) : run(action))}
								style={({ pressed }) => [
									styles.sheetAction,
									index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
									pressed && { backgroundColor: p.elevated },
								]}
							>
								{action.icon ? (
									<View
										style={[styles.sheetActionIcon, { backgroundColor: action.danger ? p.dangerSoft : p.accentSoft }]}
									>
										<Icon name={action.icon} size={18} color={action.danger ? p.danger : p.accent} />
									</View>
								) : null}
								<View style={styles.flex}>
									<Text style={[styles.sheetActionLabel, { color }]}>{action.label}</Text>
									{action.description ? (
										<Text style={[styles.sheetActionText, { color: p.muted }]}>{action.description}</Text>
									) : null}
								</View>
								<Icon name="chevron-forward" size={16} color={p.faint} />
							</Pressable>
						);
					})}
				</View>
				<Button title="取消" onPress={onClose} />
			</View>
		</Sheet>
	);
}

export function Muted({
	children,
	style,
	numberOfLines,
}: {
	children: ReactNode;
	style?: StyleProp<TextStyle>;
	numberOfLines?: number;
}) {
	const p = usePalette();
	return (
		<Text numberOfLines={numberOfLines} style={[styles.muted, { color: p.muted }, style]}>
			{children}
		</Text>
	);
}

export function Title({
	children,
	style,
	numberOfLines,
}: {
	children: ReactNode;
	style?: StyleProp<TextStyle>;
	numberOfLines?: number;
}) {
	const p = usePalette();
	return (
		<Text numberOfLines={numberOfLines} style={[styles.title, { color: p.text }, style]}>
			{children}
		</Text>
	);
}

/** Large in-page title with an optional eyebrow and subtitle, for top-level screens. */
export function LargeTitle({ title, eyebrow, subtitle }: { title: string; eyebrow?: string; subtitle?: string }) {
	const p = usePalette();
	return (
		<View style={styles.largeTitle}>
			{eyebrow ? <Text style={[styles.eyebrow, { color: p.accentText }]}>{eyebrow}</Text> : null}
			<Text style={[styles.largeTitleText, { color: p.text }]}>{title}</Text>
			{subtitle ? <Text style={[styles.largeTitleSubtitle, { color: p.muted }]}>{subtitle}</Text> : null}
		</View>
	);
}

/** Small label above a group of cards. */
export function SectionLabel({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
	const p = usePalette();
	return <Text style={[styles.sectionLabel, { color: p.muted }, style]}>{children}</Text>;
}

export function Screen({
	children,
	style,
	safeBottom = false,
}: {
	children: ReactNode;
	style?: StyleProp<ViewStyle>;
	/** Reserve the home indicator / navigation bar on pages without their own keyboard insets. */
	safeBottom?: boolean;
}) {
	const p = usePalette();
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.screen, { backgroundColor: p.bg, paddingBottom: safeBottom ? insets.bottom : 0 }, style]}>
			{children}
		</View>
	);
}

/** Transient message at the top of the screen. */
export function ToastHost() {
	const store = useStore();
	const toast = useMobileState((s) => s.toast);
	const p = usePalette();
	const insets = useSafeAreaInsets();
	if (!toast) return null;
	const error = toast.level === "error";
	const bg = error ? p.danger : p.dark ? p.elevated : "#1c1b19";
	return (
		<Pressable
			onPress={() => store.dismissToast()}
			style={[styles.toast, FLOAT_SHADOW, { top: insets.top + 60, backgroundColor: bg }]}
		>
			<Icon name={error ? "alert-circle" : "checkmark-circle"} size={18} color={error ? "#fff" : p.accent} />
			<Text style={[styles.toastText, { color: "#fff" }]}>{toast.message}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	center: { alignItems: "center" },
	centerText: { textAlign: "center" },
	screen: { flex: 1 },
	button: {
		minHeight: 48,
		paddingHorizontal: 20,
		borderRadius: RADIUS.md,
		alignItems: "center",
		justifyContent: "center",
		flexDirection: "row",
		gap: 7,
	},
	buttonSmall: { minHeight: 44, paddingHorizontal: 14, borderRadius: RADIUS.md, gap: 5 },
	buttonText: { fontSize: 15.5, fontWeight: "600", flexShrink: 1 },
	buttonTextSmall: { fontSize: 14 },
	disabled: { opacity: 0.4 },
	pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
	iconButton: { alignItems: "center", justifyContent: "center" },
	headerAction: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		paddingHorizontal: 13,
		height: 36,
		borderRadius: RADIUS.pill,
	},
	headerActionText: { fontSize: 14, fontWeight: "600" },
	card: { borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
	cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
	cardHeaderIcon: { width: 38, height: 38, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center" },
	cardHeaderTitle: { fontSize: 16.5, fontWeight: "700" },
	cardHeaderSubtitle: { fontSize: 13, lineHeight: 18, marginTop: 1 },
	pill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		paddingHorizontal: 9,
		paddingVertical: 4,
		borderRadius: RADIUS.pill,
		alignSelf: "flex-start",
	},
	pillText: { fontSize: 12, fontWeight: "600" },
	muted: { fontSize: 13.5, lineHeight: 20 },
	title: { fontSize: 17, fontWeight: "700" },
	largeTitle: { gap: 4, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 6 },
	eyebrow: { fontSize: 12.5, fontWeight: "700", letterSpacing: 1.6 },
	largeTitleText: { fontSize: 27, lineHeight: 34, fontWeight: "700", letterSpacing: -0.4 },
	largeTitleSubtitle: { fontSize: 14, lineHeight: 20 },
	sectionLabel: { fontSize: 13, fontWeight: "600", letterSpacing: 0.3, marginLeft: 4 },
	toast: {
		position: "absolute",
		alignSelf: "center",
		maxWidth: "90%",
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderRadius: RADIUS.pill,
	},
	toastText: { fontSize: 14, fontWeight: "500", flexShrink: 1 },
	backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
	sheet: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: 0,
		maxHeight: "86%",
		borderTopLeftRadius: RADIUS.xl,
		borderTopRightRadius: RADIUS.xl,
	},
	grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, marginTop: 10 },
	sheetContent: { padding: 20, paddingTop: 16, gap: 16 },
	sheetHead: { gap: 6, paddingHorizontal: 2 },
	sheetTitle: { fontSize: 18, lineHeight: 25, fontWeight: "700" },
	sheetMessage: { fontSize: 14, lineHeight: 21 },
	confirmIcon: {
		alignSelf: "center",
		width: 52,
		height: 52,
		borderRadius: 26,
		alignItems: "center",
		justifyContent: "center",
	},
	sheetGroup: { borderRadius: RADIUS.lg, overflow: "hidden" },
	sheetAction: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
	sheetActionIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
	sheetActionLabel: { fontSize: 15.5, fontWeight: "600" },
	sheetActionText: { fontSize: 12.5, lineHeight: 18, marginTop: 2 },
	sheetButtons: { flexDirection: "row", gap: 10 },
	promptInput: {
		borderWidth: 1,
		borderRadius: RADIUS.md,
		paddingHorizontal: 14,
		paddingVertical: 11,
		fontSize: 15.5,
	},
	promptMultiline: { minHeight: 96, maxHeight: 200, textAlignVertical: "top" },
});
