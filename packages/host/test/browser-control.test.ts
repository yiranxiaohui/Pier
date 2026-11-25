/** Opt-in real browser check: PIER_TEST_BROWSER=/path/to/chrome bunx vitest run ... */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChromiumBrowser } from "../src/browser/chromium.ts";

const executable = process.env.PIER_TEST_BROWSER;

describe.skipIf(!executable)("the panel's controls of a real Chromium", () => {
	let browser: ChromiumBrowser | undefined;
	const cleanup: Array<() => void | Promise<void>> = [];
	afterEach(async () => {
		await browser?.close();
		for (const close of cleanup.splice(0)) await close();
	});

	it("follows tabs and history, picks an element with its screenshot, and captures the viewport", async () => {
		const root = mkdtempSync(join(tmpdir(), "pier-browser-control-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const server = createServer((req, res) => {
			res.setHeader("content-type", "text/html");
			res.end(
				req.url === "/second"
					? "<!doctype html><title>Second</title><p>second page</p>"
					: `<!doctype html><title>First</title><style>body{margin:0}#card{margin:40px;width:200px;height:80px;background:#cde}</style>
					<main><div id="card" class="card hero"><button class="go">Go</button> Card text</div><div class="card">other</div></main>`,
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		browser = await ChromiumBrowser.start(join(root, "profile"), `${origin}/`, undefined, () => {}, {
			executable,
			// No keyring: without a session D-Bus, Chrome can wait half a minute for one before it starts.
			args: ["--headless=new", "--no-sandbox", "--window-size=800,600", "--password-store=basic"],
		});
		const live = browser;
		await expect.poll(async () => (await live.control({ op: "state" })).state?.tabs[0]?.title).toBe("First");
		let state = (await live.control({ op: "state" })).state;
		expect(state).toMatchObject({ canGoBack: false, canGoForward: false, tabs: [{ url: `${origin}/` }] });
		expect(state?.activeTabId).toBe(state?.tabs[0]?.id);

		await live.control({ op: "navigate", url: `${origin}/second` });
		await expect.poll(async () => (await live.control({ op: "state" })).state?.tabs[0]?.title).toBe("Second");
		expect((await live.control({ op: "state" })).state?.canGoBack).toBe(true);
		await live.control({ op: "back" });
		await expect.poll(async () => (await live.control({ op: "state" })).state?.tabs[0]?.title).toBe("First");
		expect((await live.control({ op: "state" })).state?.canGoForward).toBe(true);
		await expect(live.control({ op: "navigate", url: "file:///etc/passwd" })).rejects.toThrow();

		// Pick: the inspector takes the next click on the page (here a synthetic one).
		const picking = live.control({ op: "pick" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		await live.action({ action: "click", selector: "#card" });
		const { element } = await picking;
		expect(element).toMatchObject({
			label: "div#card.card.hero",
			selector: "#card",
			tag: "div",
			url: `${origin}/`,
			title: "First",
			text: "Go Card text",
		});
		expect(element?.html).toContain('<button class="go">Go</button>');
		expect(element?.rect).toMatchObject({ x: 40, y: 40, width: 200, height: 80 });
		expect(element?.image).toMatchObject({ mimeType: "image/png", width: 200, height: 80 });
		await live.control({ op: "highlight", nodeId: element?.nodeId as number });
		await live.control({ op: "clearHighlight" });

		// A cancelled pick resolves without an element, and the page gets its clicks back.
		const cancelled = live.control({ op: "pick" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		await live.control({ op: "cancelPick" });
		expect(await cancelled).toEqual({ cancelled: true });

		const shot = (await live.control({ op: "capture" })).image;
		expect(shot?.mimeType).toBe("image/png");
		expect(shot?.width).toBeGreaterThan(100);

		// Tabs: a new one becomes active; closing it hands back; the last one is emptied, not closed.
		state = (await live.control({ op: "newTab", url: `${origin}/second` })).state;
		expect(state?.tabs).toHaveLength(2);
		const second = state?.activeTabId as string;
		expect(state?.tabs.find((tab) => tab.id === second)?.url).toBe(`${origin}/second`);
		state = (await live.control({ op: "closeTab", tabId: second })).state;
		expect(state?.tabs).toHaveLength(1);
		expect(state?.activeTabId).toBe(state?.tabs[0]?.id);
		await live.control({ op: "closeTab" });
		await expect.poll(async () => (await live.control({ op: "state" })).state?.tabs[0]?.url).toBe("about:blank");
	});
});
