/** Opt-in real browser check: PIER_TEST_BROWSER=/path/to/chrome bunx vitest run ... */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ChromiumBrowser } from "../src/browser/chromium.ts";
import { remoteProxy } from "../src/browser/network.ts";
import { startTestHost, type TestHost } from "./helpers.ts";

const executable = process.env.PIER_TEST_BROWSER;

describe.skipIf(!executable)("real locally rendered Chromium", () => {
	let browser: ChromiumBrowser | undefined;
	let host: TestHost | undefined;
	const cleanup: Array<() => void | Promise<void>> = [];
	afterEach(async () => {
		await browser?.close();
		await host?.close();
		for (const close of cleanup.splice(0)) await close();
	});

	it("renders through a proxy, fills and clicks, presses keys, captures PNG and persists local login state", async () => {
		const root = mkdtempSync(join(tmpdir(), "pier-real-browser-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end(`<!doctype html><title>Local rendering test</title><input id="name"><select id="choice"><option value="a">A</option><option value="b">B</option></select><button id="submit">Submit</button><p id="result"></p><script>
			 document.querySelector('#submit').onclick=()=>{document.querySelector('#result').textContent=document.querySelector('#name').value;localStorage.setItem('login','kept-locally');document.cookie='login=test; SameSite=Lax';};
			 document.querySelector('#name').onkeydown=e=>{if(e.key==='Enter')document.querySelector('#submit').click();};
			 document.querySelector('#choice').onchange=e=>{window.selected=e.target.value;};
			 const ws=new WebSocket('ws://'+location.host+'/hmr');ws.onopen=()=>ws.send('proxy-hot-reload');ws.onmessage=e=>{window.hotReload=e.data;ws.close();};
			</script>`);
		});
		const ws = new WebSocketServer({ server });
		ws.on("connection", (socket) => socket.on("message", (bytes, binary) => socket.send(bytes, { binary })));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => {
			for (const client of ws.clients) client.terminate();
			ws.close();
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const port = (server.address() as AddressInfo).port;
		host = await startTestHost();
		const client = await host.connect();
		const proxy = await remoteProxy(client);
		cleanup.push(() => proxy.close());
		let exited = false;
		const profile = join(root, "profile");
		const launch = () =>
			ChromiumBrowser.start(
				profile,
				`http://127.0.0.1:${port}/`,
				proxy.port,
				() => {
					exited = true;
				},
				{ executable, args: ["--headless=new", "--no-sandbox"] },
			);
		browser = await launch();
		const ready = async () =>
			expect.poll(async () => (await browser?.action({ action: "snapshot" }))?.text).toContain("Local rendering test");
		await ready();
		await expect
			.poll(async () => (await browser?.action({ action: "evaluate", expression: "window.hotReload" }))?.text)
			.toBe('"proxy-hot-reload"');
		await browser.action({ action: "fill", selector: "#choice", text: "b" });
		expect((await browser.action({ action: "evaluate", expression: "window.selected" })).text).toBe('"b"');
		await browser.action({ action: "fill", selector: "#name", text: "Rendered on this computer" });
		await browser.action({ action: "click", selector: "#submit" });
		expect((await browser.action({ action: "snapshot" })).text).toContain("Rendered on this computer");
		await browser.action({ action: "fill", selector: "#name", text: "Pressed Enter" });
		await browser.action({ action: "press", key: "Enter" });
		expect((await browser.action({ action: "snapshot" })).text).toContain("Pressed Enter");
		const screenshot = await browser.action({ action: "screenshot" });
		expect(
			Buffer.from(screenshot.image?.data ?? "", "base64")
				.subarray(0, 8)
				.toString("hex"),
		).toBe("89504e470d0a1a0a");
		const tabs = JSON.parse((await browser.action({ action: "tabs" })).text ?? "[]");
		expect(tabs[0].url).toBe(`http://127.0.0.1:${port}/`);
		await browser.close();
		await expect.poll(() => exited).toBe(true);
		// Chrome releases its profile lock asynchronously after Browser.close.
		await expect
			.poll(() => import("node:fs").then((fs) => fs.existsSync(join(profile, "SingletonLock"))), { timeout: 10_000 })
			.toBe(false);
		browser = await launch();
		await ready();
		expect((await browser.action({ action: "evaluate", expression: 'localStorage.getItem("login")' })).text).toBe(
			'"kept-locally"',
		);
	});
});
