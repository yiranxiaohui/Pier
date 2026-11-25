import Ionicons from "@expo/vector-icons/Ionicons";
import * as Font from "expo-font";
import { Stack, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ToastHost } from "../src/components/ui.tsx";
import { MobileStore, StoreContext } from "../src/store.ts";
import { TERMINAL_COLORS } from "../src/terminal-colors.ts";
import { usePalette } from "../src/theme.ts";
import { initThemePreference } from "../src/theme-preference.ts";
import { updater } from "../src/updater.ts";

const store = new MobileStore();

export default function RootLayout() {
	const p = usePalette();
	const [themeReady, setThemeReady] = useState(false);
	const terminal = useSegments().at(-1) === "terminal";
	useEffect(() => {
		void initThemePreference().then(() => setThemeReady(true));
	}, []);
	useEffect(() => {
		if (themeReady) void SystemUI.setBackgroundColorAsync(terminal ? TERMINAL_COLORS.background : p.bg).catch(() => {});
	}, [p.bg, terminal, themeReady]);
	useEffect(() => {
		void store.init();
		void updater.init();
		// Icons render once their font is in; load it right away instead of on first use.
		void Font.loadAsync(Ionicons.font).catch(() => {});
		// iOS suspends sockets in the background; resume (with seq replay) right away on return.
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				store.onBackground();
				return;
			}
			store.onForeground();
			updater.onForeground();
		});
		return () => subscription.remove();
	}, []);
	if (!themeReady) return null;
	return (
		<SafeAreaProvider>
			<StoreContext.Provider value={store}>
				<StatusBar style={terminal || p.dark ? "light" : "dark"} />
				<Stack
					screenOptions={{
						headerStyle: { backgroundColor: p.bg },
						headerShadowVisible: false,
						headerTintColor: p.text,
						headerTitleStyle: { color: p.text, fontWeight: "700", fontSize: 17 },
						headerBackButtonDisplayMode: "minimal",
						contentStyle: { backgroundColor: p.bg },
						animation: "slide_from_right",
					}}
				>
					<Stack.Screen name="index" options={{ title: "" }} />
					<Stack.Screen
						name="pair"
						options={{ title: "添加电脑", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen name="settings" options={{ title: "设置" }} />
					<Stack.Screen name="host/[hostId]/index" options={{ title: "" }} />
					<Stack.Screen
						name="host/[hostId]/addresses"
						options={{ title: "连接地址", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen
						name="host/[hostId]/add-workspace"
						options={{ title: "添加工作区", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen
						name="host/[hostId]/workspace/[workspaceId]"
						options={{ title: "工作区设置", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen name="host/[hostId]/session/[sessionId]" options={{ title: "" }} />
					<Stack.Screen name="host/[hostId]/files" options={{ title: "文件" }} />
					<Stack.Screen name="host/[hostId]/file" options={{ title: "" }} />
					<Stack.Screen
						name="host/[hostId]/terminal"
						options={{
							title: "终端",
							headerStyle: { backgroundColor: TERMINAL_COLORS.background },
							headerTintColor: TERMINAL_COLORS.text,
							headerTitleStyle: { color: TERMINAL_COLORS.text, fontWeight: "700", fontSize: 17 },
							contentStyle: { backgroundColor: TERMINAL_COLORS.background },
						}}
					/>
					<Stack.Screen name="host/[hostId]/extensions" options={{ title: "pi 扩展" }} />
				</Stack>
				<ToastHost />
			</StoreContext.Provider>
		</SafeAreaProvider>
	);
}
