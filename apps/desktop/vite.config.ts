import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: {
		// The Pier Host allows the http://localhost:1420 origin in development.
		port: 1420,
		strictPort: true,
		host: host || "localhost",
		hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
		watch: { ignored: ["**/src-tauri/**"] },
	},
	envPrefix: ["VITE_", "TAURI_ENV_"],
	build: {
		target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
		minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
		sourcemap: !!process.env.TAURI_ENV_DEBUG,
		// The code editor's Monaco core (~2.7 MB) is one lazily loaded chunk; the start-up bundle stays below 2 MB.
		chunkSizeWarningLimit: 3000,
	},
});
