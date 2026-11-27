import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * Files pdf.js loads at run time, by folder of `pdfjs-dist`: CMaps for text in CJK fonts that are
 * not embedded, the standard fonts, and the JPEG 2000 / JBIG2 image decoders (with their fallbacks
 * for webviews that cannot compile WebAssembly). The PDF preview finds them under `/pdfjs/`.
 */
const PDFJS_ASSETS: Record<string, RegExp> = {
	cmaps: /^(.+\.bcmap|LICENSE)$/,
	standard_fonts: /^(.+\.(pfb|ttf)|LICENSE_.+)$/,
	wasm: /^((openjpeg|jbig2)(\.wasm|_nowasm_fallback\.js)|LICENSE_(PDFJS_)?(OPENJPEG|JBIG2))$/,
};

function pdfjsAssets(): Plugin {
	const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
	const files = () =>
		Object.entries(PDFJS_ASSETS).flatMap(([folder, keep]) =>
			readdirSync(join(root, folder))
				.filter((name) => keep.test(name))
				.map((name) => `${folder}/${name}`),
		);
	return {
		name: "pier-pdfjs-assets",
		configureServer(server) {
			const served = new Set(files());
			server.middlewares.use("/pdfjs/", (request, response, next) => {
				const path = decodeURIComponent((request.url ?? "").split("?")[0]?.replace(/^\//, "") ?? "");
				if (!served.has(path)) return next();
				response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "application/octet-stream");
				response.end(readFileSync(join(root, path)));
			});
		},
		generateBundle() {
			for (const path of files()) {
				this.emitFile({ type: "asset", fileName: `pdfjs/${path}`, source: readFileSync(join(root, path)) });
			}
		},
	};
}

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
	plugins: [react(), pdfjsAssets()],
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
