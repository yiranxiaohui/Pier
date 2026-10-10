import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { photonWasmDirs } from "./photon-wasm.ts";

type ResolveFilename = (request: string, ...args: unknown[]) => string;
const module = createRequire(import.meta.url)("module") as { _resolveFilename: ResolveFilename };

/** pi resolves QuickJS through createRequire; compiled binaries need the shipped asset's real path. */
export function installCodemodeWasmRedirect(dirs: readonly string[] = photonWasmDirs()): () => void {
	const wasm = dirs.map((dir) => join(dir, "quickjs.wasm")).find((path) => existsSync(path));
	if (!wasm) return () => {};
	const original = module._resolveFilename;
	const patched: ResolveFilename = (request, ...args) =>
		request === "quickjs-wasi/quickjs.wasm" ? wasm : original.call(module, request, ...args);
	module._resolveFilename = patched;
	return () => {
		if (module._resolveFilename === patched) module._resolveFilename = original;
	};
}
