/** Opt in with PIER_TEST_SELKIES and PIER_TEST_BROWSER pointing to installed executables. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromiumBrowser } from "../src/browser/chromium.ts";
import { SelkiesBrowser } from "../src/browser/selkies.ts";

const selkies = process.env.PIER_TEST_SELKIES;
const chromium = process.env.PIER_TEST_BROWSER;
describe.skipIf(process.platform !== "linux" || !selkies || !chromium)("real Selkies browser runtime", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("authenticates the stream, switches transport without losing the browser, and preserves its profile", async () => {
		vi.stubEnv("PIER_SELKIES_BIN", selkies);
		vi.stubEnv("PIER_BROWSER_BIN", chromium);
		const root = mkdtempSync(join(tmpdir(), "pier-selkies-test-"));
		const server = createServer((_req, res) => {
			res.setHeader("Content-Type", "text/html");
			res.end('<title>Pier remote browser</title><input id="name"><p>Remote browser smoke test</p>');
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		let browser: SelkiesBrowser | undefined;
		const start = () =>
			SelkiesBrowser.start({ profile: join(root, "profile"), url, transport: "webrtc", iceServers: [], onExit() {} });
		try {
			browser = await start();
			const viewer = `http://127.0.0.1:${browser.port}`;
			expect((await fetch(`${viewer}/api/sessions`)).status).toBe(401);
			expect(
				(await fetch(`${viewer}/api/sessions`, { headers: { Authorization: `Bearer ${browser.token}` } })).status,
			).toBe(200);
			expect(await (await fetch(`${viewer}/api/status`)).json()).toMatchObject({ current_mode: "webrtc" });
			await expect
				.poll(async () => (await browser?.action({ action: "snapshot" }))?.text)
				.toContain("Remote browser smoke test");
			await browser.action({ action: "fill", selector: "#name", text: "same browser" });
			await browser.action({ action: "evaluate", expression: "localStorage.setItem('login','retained')" });
			await browser.setTransport("websockets");
			expect(await (await fetch(`${viewer}/api/status`)).json()).toMatchObject({ current_mode: "websockets" });
			expect(
				(await browser.action({ action: "evaluate", expression: "document.querySelector('#name').value" })).text,
			).toBe('"same browser"');
			const png = (await browser.action({ action: "screenshot" })).image;
			expect(
				Buffer.from(png?.data ?? "", "base64")
					.subarray(0, 8)
					.toString("hex"),
			).toBe("89504e470d0a1a0a");
			await browser.close();
			await expect(fetch(`${viewer}/api/status`)).rejects.toThrow();
			browser = await start();
			await expect
				.poll(
					async () =>
						(await browser?.action({ action: "evaluate", expression: "localStorage.getItem('login')" }))?.text,
				)
				.toBe('"retained"');
		} finally {
			await browser?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);
	it("fills the display with the page while the panel's toolbar stands in for the browser's", async () => {
		vi.stubEnv("PIER_SELKIES_BIN", selkies);
		vi.stubEnv("PIER_BROWSER_BIN", chromium);
		const root = mkdtempSync(join(tmpdir(), "pier-selkies-fullscreen-"));
		let browser: SelkiesBrowser | undefined;
		try {
			browser = await SelkiesBrowser.start({
				profile: join(root, "profile"),
				url: "about:blank",
				transport: "webrtc",
				iceServers: [],
				onExit() {},
			});
			const live = browser;
			const room = async () =>
				JSON.parse(
					(await live.action({ action: "evaluate", expression: "[innerHeight, screen.height]" })).text ?? "[]",
				) as number[];
			// Maximized with its tab strip and address bar, but no banner above the page.
			await expect.poll(async () => (await room())[0]).toBeGreaterThan(0);
			const [inner, screen] = await room();
			expect(inner).toBeLessThan(screen as number);
			await live.control({ op: "fullscreen", value: true });
			await expect.poll(async () => (await room())[0]).toBe(screen);
			// A separate viewer gets them back.
			await live.control({ op: "fullscreen", value: false });
			await expect.poll(async () => (await room())[0]).toBe(inner);
		} finally {
			await browser?.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
	it("fits the display and browser to a Retina viewer across sizes and transports", async () => {
		vi.stubEnv("PIER_SELKIES_BIN", selkies);
		vi.stubEnv("PIER_BROWSER_BIN", chromium);
		const root = mkdtempSync(join(tmpdir(), "pier-browser-size-test-"));
		let remote: SelkiesBrowser | undefined;
		let viewer: ChromiumBrowser | undefined;
		try {
			remote = await SelkiesBrowser.start({
				profile: join(root, "remote"),
				url: "about:blank",
				transport: "webrtc",
				iceServers: [],
				onExit() {},
			});
			for (const transport of ["webrtc", "websockets"] as const) {
				await remote.setTransport(transport);
				viewer = await ChromiumBrowser.start(
					join(root, "viewer"),
					`http://127.0.0.1:${remote.port}/#token=${remote.token}`,
					undefined,
					() => {},
					{
						executable: chromium,
						args: [
							"--headless=new",
							"--window-size=1280,820",
							"--force-device-scale-factor=2",
							"--autoplay-policy=no-user-gesture-required",
						],
					},
				);
				// Drive the real viewer's window through CDP without adding a test-only public API.
				// biome-ignore lint/complexity/useLiteralKeys: Access CDP for integration testing.
				const targets = await viewer["targets"]();
				// biome-ignore lint/complexity/useLiteralKeys: Access CDP for integration testing.
				const { windowId } = await viewer["send"]("Browser.getWindowForTarget", { targetId: targets[0]?.targetId });
				for (const [width, height] of [
					[1280, 820],
					[1800, 1000],
					[900, 650],
				]) {
					// biome-ignore lint/complexity/useLiteralKeys: Access CDP for integration testing.
					await viewer["send"]("Browser.setWindowBounds", { windowId, bounds: { width, height } });
					const size = JSON.parse(
						(await viewer.action({ action: "evaluate", expression: "[innerWidth,innerHeight]" })).text ?? "[]",
					) as number[];
					await expect
						.poll(
							async () => {
								const actual = JSON.parse(
									(
										await remote?.action({
											action: "evaluate",
											expression: "[screen.width,screen.height,outerWidth,outerHeight,devicePixelRatio]",
										})
									)?.text ?? "[]",
								) as number[];
								return (
									actual.length === 5 &&
									actual[4] === 1 &&
									actual.slice(0, 4).every((value, index) => Math.abs(value - (size[index % 2] ?? 0)) < 8)
								);
							},
							{ timeout: 20_000 },
						)
						.toBe(true);
				}
				await viewer.close();
				viewer = undefined;
			}
		} finally {
			await viewer?.close();
			await remote?.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
