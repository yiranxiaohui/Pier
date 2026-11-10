import "@fontsource-variable/noto-sans-sc/wght.css";
import "highlight.js/styles/github-dark.css";
import "./styles.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { customTitleBar } from "./components/TitleBar.tsx";
import { bridge } from "./lib/bridge.ts";
import { installTerminalResolver } from "./lib/remote-terminals.ts";
import { PierStore, StoreContext } from "./lib/store.tsx";
import { installTheme } from "./lib/theme.ts";

installTheme();

if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) {
	document.documentElement.classList.add("linux");
}

if (customTitleBar) document.documentElement.classList.add("custom-titlebar");

// Only show the app's context menus, never the WebView's page actions (e.g. Reload).
window.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

// HTML5 file drops are enabled in the desktop window (the composer and file panel take them);
// a file dropped anywhere else must not make the webview navigate to it.
for (const type of ["dragover", "drop"] as const) {
	window.addEventListener(type, (event) => {
		if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "none";
	});
}

const store = new PierStore(bridge);
installTerminalResolver(store);

function Root() {
	useEffect(() => store.start(), []);
	return (
		<StoreContext.Provider value={store}>
			<App />
		</StoreContext.Provider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
