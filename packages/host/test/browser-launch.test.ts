import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromiumBrowser, launchSettings, SANDBOX_UNAVAILABLE } from "../src/browser/chromium.ts";
import { REMOTE_BROWSER_ARGS } from "../src/browser/selkies.ts";

describe("browser launch settings", () => {
	it("keeps Windows Chrome and Edge from relaunching away from the CDP pipe", () => {
		const env = {
			PATH: "C:\\Windows",
			__compat_layer: "Installer",
			__COMPAT_LAYER: "DetectorsAppHealth",
			TEMP: "C:\\t",
		};
		const settings = launchSettings("win32", env);
		expect(settings.args).toEqual(["--do-not-de-elevate", "--edge-skip-compat-layer-relaunch"]);
		expect(settings.env).toEqual({ PATH: "C:\\Windows", TEMP: "C:\\t" });
		// The caller's environment is left alone.
		expect(env.__COMPAT_LAYER).toBe("DetectorsAppHealth");
	});

	it("changes nothing elsewhere", () => {
		const env = { PATH: "/usr/bin", __COMPAT_LAYER: "Installer" };
		expect(launchSettings("linux", env)).toEqual({ args: [], env });
		expect(launchSettings("darwin", env).env).toBe(env);
	});
});

describe.skipIf(process.platform === "win32")("a browser that exits at once", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	function fake(script: string): { executable: string; profile: string } {
		const root = mkdtempSync(join(tmpdir(), "pier-fake-browser-"));
		roots.push(root);
		const executable = join(root, "chrome");
		writeFileSync(executable, `#!/bin/sh\n${script}\n`);
		chmodSync(executable, 0o700);
		return { executable, profile: join(root, "profile") };
	}
	const start = (fake: { executable: string; profile: string }) =>
		ChromiumBrowser.start(fake.profile, "about:blank", undefined, () => {}, { executable: fake.executable });

	it("explains that it could not sandbox itself, even when the message arrives in pieces", async () => {
		const browser = fake(
			"printf '[1:1:FATAL:zygote_host_impl_linux.cc:130] No usable ' >&2\nsleep 0.2\nprintf 'sandbox! If you are running on Ubuntu 23.10+ ...\\n' >&2\nexit 133",
		);
		await expect(start(browser)).rejects.toThrow(SANDBOX_UNAVAILABLE);
	});

	it("explains a setuid helper Chromium will not use", async () => {
		const browser = fake(
			"echo 'FATAL: The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing...' >&2\nexit 133",
		);
		await expect(start(browser)).rejects.toThrow(SANDBOX_UNAVAILABLE);
	});

	it("keeps other failures as they were", async () => {
		const error = await start(fake("echo 'something else went wrong' >&2\nexit 1")).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toBe(SANDBOX_UNAVAILABLE);
	});
});

describe.skipIf(process.platform === "win32")("starting a browser", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("does not wait for the first page, so a slow one cannot fail the launch", async () => {
		root = mkdtempSync(join(tmpdir(), "pier-fake-browser-"));
		const executable = join(root, "chrome");
		const navigated = join(root, "navigated");
		// Answers the protocol on the CDP pipe, except the navigation: that page never responds.
		writeFileSync(
			executable,
			`#!${process.execPath}
const fs = require("node:fs");
const output = fs.createWriteStream(null, { fd: 4 });
const answer = (id, result) => output.write(JSON.stringify({ id, result }) + "\\0");
let buffer = "";
fs.createReadStream(null, { fd: 3 }).on("data", (chunk) => {
	buffer += chunk;
	for (let end; (end = buffer.indexOf("\\0")) >= 0; ) {
		const { id, method, params } = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (method === "Browser.getVersion") answer(id, { product: "Fake" });
		else if (method === "Target.getTargets")
			answer(id, { targetInfos: [{ targetId: "T", type: "page", title: "", url: "about:blank" }] });
		else if (method === "Target.attachToTarget") answer(id, { sessionId: "S" });
		else if (method === "Page.navigate") fs.writeFileSync(${JSON.stringify(navigated)}, params.url);
		else if (method === "Browser.close") process.exit(0);
	}
});
`,
		);
		chmodSync(executable, 0o700);
		const started = Date.now();
		const browser = await ChromiumBrowser.start(join(root, "profile"), "http://127.0.0.1:3000/", undefined, () => {}, {
			executable,
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		await vi.waitFor(() => expect(readFileSync(navigated, "utf8")).toBe("http://127.0.0.1:3000/"));
		await browser.close();
	});

	it("keeps the remote browser's cookies away from a desktop keyring nobody can unlock", () => {
		expect(REMOTE_BROWSER_ARGS).toContain("--password-store=basic");
	});
});
