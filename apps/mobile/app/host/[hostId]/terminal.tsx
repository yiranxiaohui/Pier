import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	type LayoutChangeEvent,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	type TextStyle,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoider } from "../../../src/components/KeyboardAvoider.tsx";
import { HeaderAction, Icon, IconButton, Muted, Screen } from "../../../src/components/ui.tsx";
import { shortPath } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { controlKey, type RemoteTerminal, type SpecialKey, type TerminalLine } from "../../../src/terminal.ts";
import { TERMINAL_COLORS } from "../../../src/terminal-colors.ts";
import { MONO, RADIUS } from "../../../src/theme.ts";

const FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const BACKGROUND = TERMINAL_COLORS.background;
const FOREGROUND = TERMINAL_COLORS.foreground;
const PADDING = 8;
/** Browsers collapse runs of spaces (and the blank cursor cell) unless told not to. */
const PRESERVE_SPACES = (Platform.OS === "web" ? { whiteSpace: "pre" } : null) as TextStyle | null;

const Line = memo(
	function Line({ line }: { line: TerminalLine }) {
		return (
			<Text style={[styles.line, PRESERVE_SPACES]} {...(Platform.OS === "web" ? {} : { numberOfLines: 1 })}>
				{line.spans.length
					? line.spans.map((span, i) => (
							<Text
								// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional.
								key={i}
								style={[
									span.fg ? { color: span.fg } : null,
									span.bg ? { backgroundColor: span.bg } : null,
									span.bold ? styles.bold : null,
									span.italic ? styles.italic : null,
									span.underline ? styles.underline : null,
									span.dim ? styles.dim : null,
								]}
							>
								{span.text}
							</Text>
						))
					: " "}
			</Text>
		);
	},
	(a, b) => sameLine(a.line, b.line),
);

function sameLine(a: TerminalLine, b: TerminalLine): boolean {
	if (a.spans.length !== b.spans.length) return false;
	return a.spans.every((span, i) => {
		const other = b.spans[i];
		return (
			!!other &&
			span.text === other.text &&
			span.fg === other.fg &&
			span.bg === other.bg &&
			span.bold === other.bold &&
			span.italic === other.italic &&
			span.underline === other.underline &&
			span.dim === other.dim
		);
	});
}

type KeyDef = { label: string; send?: string; key?: SpecialKey; ctrl?: boolean; icon?: string };

const KEYS: KeyDef[] = [
	{ label: "Ctrl", ctrl: true },
	{ label: "Esc", send: "\x1b" },
	{ label: "Tab", send: "\t" },
	{ label: "↑", key: "up" },
	{ label: "↓", key: "down" },
	{ label: "←", key: "left" },
	{ label: "→", key: "right" },
	{ label: "^C", send: "\x03" },
	{ label: "^D", send: "\x04" },
	{ label: "^Z", send: "\x1a" },
	{ label: "^L", send: "\x0c" },
	{ label: "^R", send: "\x12" },
	{ label: "Home", key: "home" },
	{ label: "End", key: "end" },
	{ label: "PgUp", key: "pageUp" },
	{ label: "PgDn", key: "pageDown" },
	{ label: "|", send: "|" },
	{ label: "~", send: "~" },
	{ label: "/", send: "/" },
	{ label: "-", send: "-" },
];

/** A shell on the connected computer, opened from the phone. */
export default function TerminalScreen() {
	const store = useStore();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { hostId, id, cwd } = useLocalSearchParams<{ hostId: string; id?: string; cwd?: string }>();
	const online = useMobileState((s) => s.host.hostId === hostId && s.host.connection === "open");
	useMobileState((s) => s.host.terminals);
	const [terminalId, setTerminalId] = useState<number | undefined>(id ? Number(id) : undefined);
	const terminal = terminalId !== undefined ? store.terminal(terminalId) : undefined;
	const [charWidth, setCharWidth] = useState(0);
	const [size, setSize] = useState<{ width: number; height: number }>();
	const [input, setInput] = useState("");
	const [ctrl, setCtrl] = useState(false);
	const scroller = useRef<ScrollView>(null);
	const nearBottom = useRef(true);
	const opening = useRef(false);
	const inputRef = useRef<TextInput>(null);

	const grid =
		size && charWidth
			? {
					cols: Math.floor((size.width - PADDING * 2) / charWidth),
					rows: Math.floor((size.height - PADDING * 2) / LINE_HEIGHT),
				}
			: undefined;

	// Open a new shell once the screen size is known.
	useEffect(() => {
		if (terminalId !== undefined || !grid || !online || opening.current) return;
		opening.current = true;
		try {
			const opened = store.openTerminal({
				...(cwd ? { cwd } : {}),
				cols: grid.cols,
				rows: grid.rows,
				title: cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? "终端") : "终端",
			});
			setTerminalId(opened.id);
			router.setParams({ id: String(opened.id) });
		} catch (error) {
			store.toast("error", error instanceof Error ? error.message : String(error));
		}
	}, [terminalId, grid, online, cwd, store, router]);

	// Follow the screen size (rotation, keyboard).
	useEffect(() => {
		if (terminal && grid) terminal.resize(grid.cols, grid.rows);
	}, [terminal, grid?.cols, grid?.rows, grid]);

	return (
		<Screen style={{ backgroundColor: BACKGROUND }}>
			<Stack.Screen
				options={{
					title: terminal ? terminal.title : "终端",
					headerRight: () =>
						terminal ? (
							<HeaderAction
								label={terminal.status === "running" ? "结束终端" : "关闭"}
								icon="close"
								onPress={() => {
									void store.removeTerminal(terminal.id);
									router.back();
								}}
							/>
						) : null,
				}}
			/>
			{/* Measures the width of one monospace character. */}
			<Text
				style={[styles.line, PRESERVE_SPACES, styles.measure]}
				onLayout={(e) => setCharWidth(e.nativeEvent.layout.width / 20)}
				accessible={false}
			>
				MMMMMMMMMMMMMMMMMMMM
			</Text>
			<KeyboardAvoider style={styles.flex} topOffset={insets.top + 44} contentInsetsBottom>
				<View
					style={styles.flex}
					onLayout={(e: LayoutChangeEvent) => {
						const { width, height } = e.nativeEvent.layout;
						setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
					}}
				>
					{terminal ? (
						<TerminalView
							terminal={terminal}
							scroller={scroller}
							nearBottom={nearBottom}
							onPress={() => inputRef.current?.focus()}
						/>
					) : (
						<View style={styles.center}>
							<Muted style={{ color: FOREGROUND }}>
								{terminalId !== undefined ? "这个终端已经关闭" : online ? "正在打开终端…" : "等待连接到电脑…"}
							</Muted>
						</View>
					)}
				</View>
				<View style={[styles.keys, { paddingBottom: insets.bottom ? 4 : 0 }]}>
					<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
						{KEYS.map((key) => (
							<Pressable
								key={key.label}
								disabled={terminal?.status !== "running"}
								onPress={() => {
									if (!terminal) return;
									if (key.ctrl) {
										setCtrl(!ctrl);
										return;
									}
									const data = key.key ? terminal.keySequence(key.key) : (key.send ?? "");
									void terminal.send(data);
									setCtrl(false);
								}}
								style={({ pressed }) => [
									styles.key,
									key.ctrl && ctrl ? styles.keyActive : null,
									pressed ? styles.keyPressed : null,
								]}
							>
								<Text style={[styles.keyText, key.ctrl && ctrl ? styles.keyTextActive : null]}>{key.label}</Text>
							</Pressable>
						))}
					</ScrollView>
					<View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 8) }]}>
						<TextInput
							ref={inputRef}
							testID="terminal-input"
							value={input}
							onChangeText={(text) => {
								// With Ctrl armed, the next typed character becomes a control character.
								if (ctrl && terminal && text.length === input.length + 1) {
									const control = controlKey(text.slice(-1));
									if (control) {
										void terminal.send(control);
										setCtrl(false);
										return;
									}
								}
								setInput(text);
							}}
							onKeyPress={(e) => {
								// Backspace on an empty line goes to the shell.
								if (e.nativeEvent.key === "Backspace" && !input && terminal) void terminal.send("\x7f");
							}}
							onSubmitEditing={() => {
								if (!terminal) return;
								void terminal.send(`${input}\r`);
								setInput("");
								nearBottom.current = true;
							}}
							submitBehavior="submit"
							editable={terminal?.status === "running"}
							placeholder={terminal?.status === "running" ? "输入命令，回车发送" : "终端已结束"}
							placeholderTextColor={TERMINAL_COLORS.faint}
							autoCapitalize="none"
							autoCorrect={false}
							spellCheck={false}
							autoComplete="off"
							returnKeyType="send"
							style={styles.input}
						/>
						<IconButton
							icon="return-down-back"
							label="发送"
							tone="accent"
							size={38}
							disabled={terminal?.status !== "running"}
							onPress={() => {
								if (!terminal) return;
								void terminal.send(`${input}\r`);
								setInput("");
								nearBottom.current = true;
							}}
						/>
					</View>
				</View>
			</KeyboardAvoider>
		</Screen>
	);
}

function TerminalView({
	terminal,
	scroller,
	nearBottom,
	onPress,
}: {
	terminal: RemoteTerminal;
	scroller: React.RefObject<ScrollView | null>;
	nearBottom: React.RefObject<boolean>;
	onPress: () => void;
}) {
	useSyncExternalStore(terminal.subscribe, terminal.getVersion);
	const lines = terminal.render();
	return (
		<ScrollView
			ref={scroller}
			style={styles.flex}
			contentContainerStyle={styles.screen}
			onScroll={(e) => {
				const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
				nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
			}}
			scrollEventThrottle={100}
			onContentSizeChange={() => {
				if (nearBottom.current) scroller.current?.scrollToEnd({ animated: false });
			}}
			keyboardShouldPersistTaps="handled"
		>
			<Pressable onPress={onPress}>
				{lines.map((line) => (
					<Line key={line.key} line={line} />
				))}
			</Pressable>
			{terminal.status === "exited" ? (
				<View style={styles.exit}>
					<Icon name="power" size={14} color="#eab54f" />
					<Text style={styles.exitText}>
						{terminal.error ?? `终端已结束${terminal.exitCode !== null ? `（退出码 ${terminal.exitCode}）` : ""}`}
					</Text>
				</View>
			) : null}
			{terminal.status === "running" && terminal.cwd ? (
				<Text style={styles.cwd} numberOfLines={1}>
					{terminal.shell} · {shortPath(terminal.cwd)}
				</Text>
			) : null}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	center: { flex: 1, alignItems: "center", justifyContent: "center" },
	measure: { position: "absolute", opacity: 0, left: -1000, top: 0 },
	screen: { padding: PADDING },
	line: { fontFamily: MONO, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, color: FOREGROUND },
	bold: { fontWeight: "700" },
	italic: { fontStyle: "italic" },
	underline: { textDecorationLine: "underline" },
	dim: { opacity: 0.6 },
	exit: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		marginTop: 10,
		padding: 8,
		borderRadius: RADIUS.sm,
		backgroundColor: "rgba(234,181,79,0.14)",
	},
	exitText: { color: "#eab54f", fontSize: 12.5, flex: 1 },
	cwd: { color: TERMINAL_COLORS.faint, fontSize: 11, fontFamily: MONO, marginTop: 8 },
	keys: {
		backgroundColor: TERMINAL_COLORS.bar,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderColor: TERMINAL_COLORS.line,
	},
	key: {
		minWidth: 42,
		height: 34,
		paddingHorizontal: 10,
		marginLeft: 6,
		marginTop: 6,
		borderRadius: 8,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: TERMINAL_COLORS.key,
	},
	keyActive: { backgroundColor: TERMINAL_COLORS.cursor },
	keyPressed: { opacity: 0.6 },
	keyText: { color: TERMINAL_COLORS.text, fontSize: 13, fontWeight: "600", fontFamily: MONO },
	keyTextActive: { color: TERMINAL_COLORS.onCursor },
	inputRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingTop: 8 },
	input: {
		flex: 1,
		height: 40,
		borderRadius: RADIUS.pill,
		paddingHorizontal: 14,
		fontFamily: MONO,
		fontSize: 14,
		color: TERMINAL_COLORS.text,
		backgroundColor: TERMINAL_COLORS.input,
		borderWidth: 1,
		borderColor: TERMINAL_COLORS.line,
	},
});
