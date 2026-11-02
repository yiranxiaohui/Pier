import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDesktop } from "../src/standalone/desktop.ts";
import { launchMode } from "../src/standalone/mode.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("unified Pier launch mode", () => {
	it("selects the GUI on X11 and Wayland and the Host on bare servers", () => {
		expect(launchMode([], {}, true)).toBe("host");
		expect(launchMode([], { DISPLAY: " " }, true)).toBe("host");
		expect(launchMode([], { DISPLAY: ":0" }, true)).toBe("desktop");
		expect(launchMode([], { WAYLAND_DISPLAY: "wayland-0" }, true)).toBe("desktop");
		expect(launchMode(["--autostart"], { DISPLAY: ":0" }, true)).toBe("desktop");
		expect(launchMode([], { DISPLAY: ":0" }, false)).toBe("host");
	});
	it.each([
		"run",
		"--headless",
		"cli",
		"install",
		"update",
		"uninstall",
		"status",
		"--help",
		"--version",
		"--watch-stdin",
		"--check-images",
	])("keeps %s usable with a graphical display", (command) => {
		expect(launchMode([command], { DISPLAY: ":0" }, true)).toBe("host");
	});
	it.each(["desktop", "--desktop"])("honors explicit %s so a missing display can be reported", (command) => {
		expect(launchMode([command], {}, true)).toBe("desktop");
	});
});

describe("embedded desktop", () => {
	it("verifies and prepares an executable privately, then reuses it", () => {
		const root = mkdtempSync(join(tmpdir(), "pier-desktop-test-"));
		roots.push(root);
		const path = join(root, "embedded");
		writeFileSync(path, "appimage-bytes");
		const image = { path, sha256: createHash("sha256").update("appimage-bytes").digest("hex") };
		const executable = prepareDesktop(image, root);
		expect(readFileSync(executable, "utf8")).toBe("appimage-bytes");
		if (process.platform !== "win32") expect(statSync(executable).mode & 0o777).toBe(0o700);
		rmSync(path);
		expect(prepareDesktop(image, root)).toBe(executable);
	});
	it("rejects corrupt data before writing a desktop executable", () => {
		const root = mkdtempSync(join(tmpdir(), "pier-desktop-test-"));
		roots.push(root);
		const path = join(root, "embedded");
		writeFileSync(path, "corrupt");
		expect(() => prepareDesktop({ path, sha256: "0".repeat(64) }, root)).toThrow("checksum mismatch");
		expect(existsSync(join(root, "runtime"))).toBe(false);
		expect(() => prepareDesktop({ path, sha256: "../outside" }, root)).toThrow("Invalid desktop checksum");
	});
});
