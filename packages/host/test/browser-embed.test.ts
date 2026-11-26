/** Opt-in real browser check: PIER_TEST_BROWSER=/path/to/chrome bunx vitest run ... */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserControl, BrowserInput, BrowserPopup } from "@pier/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type BrowserFrame, ChromiumBrowser } from "../src/browser/chromium.ts";

const executable = process.env.PIER_TEST_BROWSER;

const PAGE = `<!doctype html><title>Embedded</title><style>body{margin:0;font:16px sans-serif}</style>
<input id="field" style="position:absolute;left:20px;top:20px;width:300px;height:30px">
<select id="pick" onchange="document.title='chose '+this.value" style="position:absolute;left:20px;top:80px;width:160px;height:30px">
	<option>Alpha</option><option disabled>Beta</option><optgroup label="More"><option>Gamma</option></optgroup>
</select>
<button id="ask" onclick="document.title='answer '+confirm('Sure?')" style="position:absolute;left:20px;top:140px;width:100px;height:30px">Ask</button>
<input id="upload" type="file" style="position:absolute;left:20px;top:200px;width:200px;height:30px">
<a id="out" href="/other" target="_blank" style="position:absolute;left:20px;top:260px;width:100px;height:30px;display:block">Other</a>
<p style="position:absolute;left:20px;top:320px;margin:0">Plain words</p>`;

describe.skipIf(!executable)("a windowless Chromium drawn in the panel", () => {
	let browser: ChromiumBrowser | undefined;
	const cleanup: Array<() => void | Promise<void>> = [];
	afterEach(async () => {
		await browser?.close();
		for (const close of cleanup.splice(0)) await close();
	});

	it("streams the page at the panel's size and takes its mouse, keys, IME and popups", async () => {
		const root = mkdtempSync(join(tmpdir(), "pier-browser-embed-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const server = createServer((req, res) => {
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.end(
				req.url === "/other"
					? `<!doctype html><title>Other</title><p>${req.headers["user-agent"]}|${req.headers["accept-language"]}</p>`
					: PAGE,
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const frames: BrowserFrame[] = [];
		const popups: Array<{ tabId: string; popup?: BrowserPopup }> = [];
		browser = await ChromiumBrowser.start(join(root, "profile"), `${origin}/`, undefined, () => {}, {
			executable,
			args: ["--no-sandbox", "--password-store=basic"],
			locale: "zh-CN",
			embed: {
				frame: (frame) => {
					frames.push(frame);
				},
				popup: (tabId, popup) => {
					popups.push({ tabId, ...(popup ? { popup } : {}) });
				},
			},
		});
		const live = browser;
		const control = (command: BrowserControl) => live.control(command);
		const input = (value: BrowserInput) => control({ op: "input", input: value });
		const evaluate = async (expression: string) =>
			JSON.parse((await live.action({ action: "evaluate", expression })).text ?? "null") as unknown;
		const click = async (x: number, y: number) => {
			await input({ type: "mouse", event: "move", x, y });
			await input({ type: "mouse", event: "down", x, y, button: "left", buttons: 1, clickCount: 1 });
			await input({ type: "mouse", event: "up", x, y, button: "left", clickCount: 1 });
		};
		await expect.poll(async () => (await control({ op: "state" })).state?.tabs[0]?.title).toBe("Embedded");

		// The page at the panel's size, its picture at the device pixel ratio.
		await control({ op: "screencast", value: true, width: 640, height: 480, scale: 1.5 });
		await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThan(0);
		const first = frames[0] as BrowserFrame;
		expect(first).toMatchObject({ width: 640, height: 480 });
		const jpeg = Buffer.from(first.data, "base64");
		expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
		expect(await evaluate("[innerWidth, innerHeight, devicePixelRatio, document.hasFocus()]")).toEqual([
			640,
			480,
			1.5,
			true,
		]);
		// A person's browser: no "HeadlessChrome", the user's language.
		expect(await evaluate("navigator.userAgent")).not.toContain("Headless");
		expect(await evaluate("navigator.language")).toBe("zh-CN");

		// Typing, a finished IME composition and the pointer's shape.
		await click(100, 35);
		for (const [key, code, keyCode] of [
			["a", "KeyA", 65],
			["b", "KeyB", 66],
		] as const) {
			await input({ type: "key", event: "down", key, code, keyCode, text: key });
			await input({ type: "key", event: "up", key, code, keyCode });
		}
		await input({ type: "composition", text: "ni" });
		await input({ type: "text", text: "你" });
		await expect.poll(() => evaluate("document.getElementById('field').value")).toBe("ab你");
		await expect.poll(() => evaluate("document.activeElement.id")).toBe("field");
		await input({ type: "key", event: "down", key: "Backspace", code: "Backspace", keyCode: 8 });
		await input({ type: "key", event: "up", key: "Backspace", code: "Backspace", keyCode: 8 });
		await expect.poll(() => evaluate("document.getElementById('field').value")).toBe("ab");
		await evaluate("document.getElementById('field').select(), true");
		expect((await control({ op: "copy" })).text).toBe("ab");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await input({ type: "mouse", event: "move", x: 50, y: 275 })).cursor).toBe("pointer");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await input({ type: "mouse", event: "move", x: 40, y: 328 })).cursor).toBe("text");

		// A select list opens in the panel; choosing fires the page's change event.
		await click(60, 95);
		await expect.poll(() => popups.at(-1)?.popup?.kind).toBe("select");
		const list = popups.at(-1)?.popup as Extract<BrowserPopup, { kind: "select" }>;
		expect(list.rect).toEqual({ x: 20, y: 80, width: 160, height: 30 });
		expect(list.selected).toBe(0);
		expect(list.options).toEqual([
			{ label: "Alpha" },
			{ label: "Beta", disabled: true },
			{ label: "Gamma", group: "More" },
		]);
		expect((await control({ op: "state" })).state?.popup?.kind).toBe("select");
		await control({ op: "choose", index: 2 });
		expect(popups.at(-1)?.popup).toBeUndefined();
		await expect.poll(async () => (await control({ op: "state" })).state?.tabs[0]?.title).toBe("chose Gamma");

		// A dialog waits for the panel's answer; the click behind it goes through after.
		await click(60, 155);
		await expect.poll(() => popups.at(-1)?.popup).toEqual({ kind: "dialog", dialog: "confirm", message: "Sure?" });
		await control({ op: "dialog", value: true });
		await expect.poll(async () => (await control({ op: "state" })).state?.tabs[0]?.title).toBe("answer true");

		// A file chooser asks the panel for files.
		const file = join(root, "note.txt");
		writeFileSync(file, "hello");
		await click(60, 215);
		await expect.poll(() => popups.at(-1)?.popup).toEqual({ kind: "files", multiple: false });
		await expect(control({ op: "files", files: ["note.txt"] })).rejects.toThrow();
		await control({ op: "files", files: [file] });
		await expect.poll(() => evaluate("document.getElementById('upload').files[0]?.name")).toBe("note.txt");

		// Picking an element works on the page drawn here, with the panel's own clicks.
		const picking = control({ op: "pick" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		await click(100, 35);
		expect((await picking).element).toMatchObject({ selector: "#field", tag: "input" });
		await control({ op: "clearHighlight" });

		// A tab the page opens is the one shown, with the same user agent and language.
		const before = frames.at(-1)?.tabId;
		await click(50, 275);
		await expect.poll(() => frames.at(-1)?.tabId !== before, { timeout: 10_000 }).toBe(true);
		const state = (await control({ op: "state" })).state;
		expect(state?.tabs).toHaveLength(2);
		expect(state?.activeTabId).toBe(frames.at(-1)?.tabId);
		await expect
			.poll(
				async () => (await control({ op: "state" })).state?.tabs.find((tab) => tab.id === state?.activeTabId)?.title,
			)
			.toBe("Other");

		// Another site (another renderer process) keeps streaming, with the panel's viewport.
		const shownTab = frames.at(-1)?.tabId;
		const seen = frames.length;
		await control({ op: "navigate", url: origin.replace("127.0.0.1", "localhost") });
		await expect
			.poll(async () => (await control({ op: "state" })).state?.tabs.find((tab) => tab.id === shownTab)?.url)
			.toContain("localhost");
		await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThan(seen);
		expect(frames.at(-1)).toMatchObject({ tabId: shownTab, width: 640, height: 480 });

		// Stopping ends the frames.
		await control({ op: "screencast", value: false });
		const count = frames.length;
		await live.control({ op: "navigate", url: `${origin}/` });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(frames.length).toBe(count);
	});
});
