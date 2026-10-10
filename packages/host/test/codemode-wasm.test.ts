import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { afterEach, expect, it } from "vitest";
import { installCodemodeWasmRedirect } from "../src/pi/codemode-wasm.ts";

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "pier-codemode-wasm-"));
let restore = () => {};
afterEach(() => {
	restore();
	rmSync(root, { recursive: true, force: true });
});

it("loads QuickJS from the packaged asset and leaves other module resolution intact", async () => {
	mkdirSync(root, { recursive: true });
	const wasm = join(root, "quickjs.wasm");
	writeFileSync(wasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
	const previous = require.resolve("quickjs-wasi/quickjs.wasm");
	restore = installCodemodeWasmRedirect([root]);
	expect(require.resolve("quickjs-wasi/quickjs.wasm")).toBe(wasm);
	expect(require.resolve("node:fs")).toBe("node:fs");
	expect(await loadQuickJSWasm(require.resolve("quickjs-wasi/quickjs.wasm"))).toBeInstanceOf(WebAssembly.Module);
	restore();
	expect(require.resolve("quickjs-wasi/quickjs.wasm")).toBe(previous);
});

it("keeps native resolution when bundled assets are absent", () => {
	const previous = require.resolve("quickjs-wasi/quickjs.wasm");
	restore = installCodemodeWasmRedirect([join(root, "absent")]);
	expect(require.resolve("quickjs-wasi/quickjs.wasm")).toBe(previous);
});
