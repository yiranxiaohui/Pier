import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PierClient } from "@pier/client";
import type { BrowserCommand, BrowserControl, PairingRequest, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { EmbedHooks } from "../src/browser/chromium.ts";
import type { RemoteBrowserLaunch, RemoteBrowserProcess } from "../src/browser/selkies.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

const REMOTE = { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } as const;
describe("browsers running on the workspace host", () => {
	let a: TestHost;
	let b: TestHost;
	let local: PierClient;
	let desktop: PierClient;
	let workspace: WorkspaceInfo;
	let peerId: string;
	const launches: RemoteBrowserLaunch[] = [];
	const actions: BrowserCommand[] = [];
	const controls: BrowserControl[] = [];
	const transports: string[] = [];
	const localLaunch = vi.fn();
	const cleanup: Array<() => Promise<void>> = [];
	let closed: number;
	let launchGate: Promise<void> | undefined;
	let releaseLaunch: (() => void) | undefined;
	let failLaunch: boolean;
	beforeEach(async () => {
		launches.length = actions.length = transports.length = controls.length = 0;
		closed = 0;
		launchGate = undefined;
		releaseLaunch = undefined;
		failLaunch = false;
		localLaunch.mockClear();
		a = await startTestHost({ browser: { launch: localLaunch } });
		b = await startTestHost({
			remote: REMOTE,
			remoteBrowser: {
				launch: async (options) => {
					launches.push(options);
					options.onProgress?.({
						stage: "downloading",
						component: "selkies",
						message: "正在下载远程画面组件…",
						downloadedBytes: 25,
						totalBytes: 100,
						logs: "Reading package lists...\nInstalling xvfb...\n",
					});
					await launchGate;
					if (failLaunch) throw new Error("streamer failed");
					const server = createServer((_req, res) => res.end("remote browser viewer"));
					const ws = new WebSocketServer({ server });
					ws.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
					await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
					let stopping: Promise<void> | undefined;
					const stop = () =>
						(stopping ??= new Promise<void>((resolve) => {
							for (const client of ws.clients) client.terminate();
							ws.close();
							server.closeAllConnections();
							server.close(() => resolve());
						}));
					cleanup.push(stop);
					const browser: RemoteBrowserProcess = {
						port: (server.address() as AddressInfo).port,
						token: "private-session-token",
						action: async (command) => {
							actions.push(command);
							return { text: "remote-result" };
						},
						control: async (command) => {
							controls.push(command);
							return {
								state: {
									tabs: [{ id: "tab", title: "Remote page", url: "http://localhost:3000/" }],
									activeTabId: "tab",
									canGoBack: false,
									canGoForward: false,
									loading: false,
								},
							};
						},
						setTransport: async (transport) => {
							transports.push(transport);
						},
						close: async () => {
							if (!stopping) closed++;
							await stop();
							options.onExit();
						},
					};
					return browser;
				},
			},
		});
		local = await a.connect();
		desktop = await b.connect();
		workspace = (await desktop.request("workspace.add", { path: b.workspaceDir, policy: "auto" })).workspace;
		const events = new Recorder();
		desktop.onEvent(events.handler);
		const { uri } = await desktop.request("pairing.start");
		void events
			.waitForType("pairing.request")
			.then((frame) =>
				desktop.request("pairing.respond", { requestId: (frame.event.request as PairingRequest).id, accept: true }),
			);
		peerId = (await local.request("peer.pair", { uri })).peer.id;
	});
	afterEach(async () => {
		releaseLaunch?.();
		await a.close();
		await b.close();
		for (const stop of cleanup.splice(0)) await stop();
	});
	const open = (controlled = false) =>
		local.request("browser.open", {
			peerId,
			workspaceId: workspace.id,
			url: "http://localhost:3000/app?q=1#tab",
			mode: "remote",
			controlled,
		});

	it("launches remotely, forwards HTTP and binary WebSockets, and runs the Agent against that same process", async () => {
		const info = await open(true);
		expect(localLaunch).not.toHaveBeenCalled();
		expect(launches).toHaveLength(1);
		expect(launches[0]?.profile.startsWith(b.root)).toBe(true);
		expect(launches[0]?.url).toBe("http://localhost:3000/app?q=1#tab");
		expect(info).toMatchObject({ mode: "remote", transport: "webrtc", controllable: true });
		const viewer = new URL(info.localUrl);
		expect(viewer.hostname).toBe("127.0.0.1");
		expect(viewer.search).toBe("");
		expect(viewer.hash).toBe("#token=private-session-token");
		expect(await (await fetch(viewer.origin)).text()).toBe("remote browser viewer");
		const socket = new WebSocket(viewer.origin.replace("http:", "ws:"));
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const received = new Promise<Buffer>((resolve) => socket.once("message", (data) => resolve(data as Buffer)));
		const payload = Buffer.alloc(96_000, 123);
		socket.send(payload);
		expect(await received).toEqual(payload);
		socket.terminate();
		expect(
			await desktop.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } }),
		).toEqual({ text: "remote-result" });
		expect(actions).toEqual([{ action: "snapshot" }]);
		const switched = await local.request("browser.setTransport", {
			browserId: info.browserId,
			transport: "websockets",
		});
		expect(switched.transport).toBe("websockets");
		expect(switched.localUrl).toBe(info.localUrl);
		expect(transports).toEqual(["websockets"]);
		expect(launches).toHaveLength(1);
		await local.request("browser.close", { browserId: info.browserId });
		expect(closed).toBe(1);
		expect((await local.request("browser.list")).browsers).toEqual([]);
		await expect(
			desktop.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } }),
		).rejects.toThrow();
	});
	it("keeps Agent access opt-in and sessions private to their owning connection", async () => {
		const info = await open();
		await expect(
			desktop.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } }),
		).rejects.toThrow();
		const stranger = await a.connect();
		expect((await stranger.request("browser.list")).browsers).toEqual([]);
		expect(await stranger.request("browser.close", { browserId: info.browserId })).toEqual({ closed: false });
		await expect(
			stranger.request("browser.setTransport", { browserId: info.browserId, transport: "websockets" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const remote = await desktop.request("browser.remoteOpen", {
			workspaceId: (await desktop.request("workspace.add", { path: b.root, policy: "auto" })).workspace.id,
			url: "https://example.com",
		});
		const other = await b.connect();
		expect(await other.request("browser.remoteClose", { browserId: remote.browserId })).toEqual({ closed: false });
		await expect(
			other.request("browser.remoteTransport", { browserId: remote.browserId, transport: "websockets" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(open()).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("removes the local viewer when the remote browser exits", async () => {
		await open(true);
		launches[0]?.onExit();
		await expect.poll(async () => (await local.request("browser.list")).browsers).toEqual([]);
		await expect.poll(() => closed).toBe(1);
	});
	it("cleans a process whose owner disconnects during startup and preserves its profile on retry", async () => {
		launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const pending = open(true).catch(() => undefined);
		await expect.poll(() => launches.length).toBe(1);
		expect((await local.request("browser.list")).browsers).toEqual([]);
		local.close();
		releaseLaunch?.();
		await pending;
		await expect.poll(() => closed).toBe(1);
		local = await a.connect();
		launchGate = undefined;
		await open();
		expect(launches[1]?.profile).toBe(launches[0]?.profile);
	});
	it("forwards private setup progress and can cancel before a remote browser is ready", async () => {
		launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const events = new Recorder();
		local.onEvent(events.handler);
		const pending = open().catch(() => undefined);
		const event = await events.waitFor(
			(frame) =>
				frame.event.type === "browser.preparing" &&
				(frame.event.progress as { stage?: string } | undefined)?.stage === "downloading",
		);
		expect(event.event.progress).toMatchObject({ logs: "Reading package lists...\nInstalling xvfb...\n" });
		const result = await local.request("browser.list");
		expect(result.browsers).toEqual([]);
		expect(result.preparations).toHaveLength(1);
		expect(result.preparations?.[0]).toMatchObject({
			workspaceId: workspace.id,
			peerId,
			progress: {
				stage: "downloading",
				downloadedBytes: 25,
				totalBytes: 100,
				logs: "Reading package lists...\nInstalling xvfb...\n",
			},
		});
		const stranger = await a.connect();
		expect((await stranger.request("browser.list")).preparations).toEqual([]);
		const id = result.preparations?.[0]?.browserId as string;
		expect(await stranger.request("browser.close", { browserId: id })).toEqual({ closed: false });
		expect(await local.request("browser.close", { browserId: id })).toEqual({ closed: true });
		await pending;
		await expect.poll(() => launches[0]?.signal?.aborted).toBe(true);
		releaseLaunch?.();
		await expect.poll(() => closed).toBe(1);
		expect((await local.request("browser.list")).preparations).toEqual([]);
	});
	it("releases failed startup reservations and rejects invalid targets", async () => {
		failLaunch = true;
		await expect(open()).rejects.toThrow("streamer failed");
		failLaunch = false;
		await open();
		expect(launches).toHaveLength(2);
		await expect(
			desktop.request("browser.remoteOpen", { workspaceId: workspace.id, url: "file:///etc/passwd" }),
		).rejects.toThrow();
		await expect(
			desktop.request("browser.remoteOpen", { workspaceId: "missing", url: "https://example.com" }),
		).rejects.toThrow();
		expect(launches).toHaveLength(2);
	});
	it("lets only the opening connection drive the remote page, without the integrations opt-in", async () => {
		const info = await open();
		expect(info.managed).toBe(true);
		const result = await local.request("browser.control", { browserId: info.browserId, command: { op: "state" } });
		expect(result.state?.tabs[0]?.title).toBe("Remote page");
		await local.request("browser.control", {
			browserId: info.browserId,
			command: { op: "navigate", url: "http://localhost:5173/" },
		});
		expect(controls).toEqual([{ op: "state" }, { op: "navigate", url: "http://localhost:5173/" }]);
		// Not part of the external integrations' protocol control.
		await expect(
			desktop.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } }),
		).rejects.toThrow();
		const stranger = await a.connect();
		await expect(
			stranger.request("browser.control", { browserId: info.browserId, command: { op: "state" } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const remote = await desktop.request("browser.remoteOpen", {
			workspaceId: (await desktop.request("workspace.add", { path: b.root, policy: "auto" })).workspace.id,
			url: "https://example.com",
		});
		const other = await b.connect();
		await expect(
			other.request("browser.remoteControl", { browserId: remote.browserId, command: { op: "state" } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(controls).toHaveLength(2);
		await expect(
			local.request("browser.control", { browserId: info.browserId, command: { op: "teleport" } as never }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await local.request("browser.close", { browserId: info.browserId });
		await expect(
			local.request("browser.control", { browserId: info.browserId, command: { op: "state" } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("asks to update a remote host that cannot be driven yet", async () => {
		const original = b.host.info.bind(b.host);
		vi.spyOn(b.host, "info").mockImplementation(() => ({ ...original(), protocolVersion: "1.66" }));
		const info = await open();
		await expect(
			local.request("browser.control", { browserId: info.browserId, command: { op: "state" } }),
		).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("1.67") });
		expect(controls).toEqual([]);
	});
	it("launches a managed local window on request and drives it", async () => {
		const control = vi.fn(async () => ({}));
		localLaunch.mockResolvedValueOnce({ action: vi.fn(), control, close: vi.fn() });
		const localWorkspace = (await local.request("workspace.add", { path: a.workspaceDir, policy: "auto" })).workspace;
		const info = await local.request("browser.open", {
			workspaceId: localWorkspace.id,
			url: "http://localhost:3000/",
			mode: "service",
			managed: true,
		});
		expect(localLaunch).toHaveBeenCalledTimes(1);
		expect(info).toMatchObject({ mode: "service", managed: true, controllable: false });
		await local.request("browser.control", { browserId: info.browserId, command: { op: "reload" } });
		expect(control).toHaveBeenCalledWith({ op: "reload" });
		// One Pier-launched browser per computer: it shares one profile.
		await expect(
			local.request("browser.open", {
				workspaceId: localWorkspace.id,
				url: "http://localhost:3000/",
				mode: "service",
				managed: true,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// The system browser is not driven by Pier.
		const plain = await local.request("browser.open", {
			workspaceId: localWorkspace.id,
			url: "http://localhost:4000/",
			mode: "service",
		});
		expect(plain.managed).toBeUndefined();
		await expect(
			local.request("browser.control", { browserId: plain.browserId, command: { op: "state" } }),
		).rejects.toMatchObject({ code: "UNSUPPORTED" });
	});
	it("draws the panel's local browser in the panel and reopens it as a window with its pages", async () => {
		const hooks: Array<EmbedHooks | undefined> = [];
		const exits: Array<() => void> = [];
		const closes: Array<ReturnType<typeof vi.fn>> = [];
		const calls: BrowserControl[][] = [];
		localLaunch.mockImplementation(
			async (_profile: string, _url: string, _port: unknown, onExit: () => void, options?: { embed?: EmbedHooks }) => {
				hooks.push(options?.embed);
				exits.push(onExit);
				const close = vi.fn(async () => {});
				closes.push(close);
				const received: BrowserControl[] = [];
				calls.push(received);
				return {
					action: vi.fn(),
					close,
					control: async (command: BrowserControl) => {
						received.push(command);
						if (command.op !== "state") return {};
						return {
							state: {
								tabs: [
									{ id: "a", title: "A", url: "http://localhost:3000/a" },
									{ id: "b", title: "B", url: "http://localhost:3000/b" },
									{ id: "c", title: "", url: "about:blank" },
								],
								activeTabId: "a",
								canGoBack: false,
								canGoForward: false,
								loading: false,
							},
						};
					},
				};
			},
		);
		const localWorkspace = (await local.request("workspace.add", { path: a.workspaceDir, policy: "auto" })).workspace;
		const events = new Recorder();
		local.onEvent(events.handler);
		const info = await local.request("browser.open", {
			workspaceId: localWorkspace.id,
			url: "http://localhost:3000/a",
			mode: "service",
			managed: true,
			embedded: true,
			locale: "zh-CN",
		});
		expect(info).toMatchObject({ mode: "service", managed: true, embedded: true });
		expect(localLaunch.mock.calls[0]?.[4]).toMatchObject({ locale: "zh-CN" });
		const browserId = info.browserId;
		const control = (command: BrowserControl) => local.request("browser.control", { browserId, command });

		// Frames and popups go to the connection that opened it, and only there.
		const stranger = await a.connect();
		const overheard = new Recorder();
		stranger.onEvent(overheard.handler);
		await hooks[0]?.frame({ tabId: "a", data: "AAAA", width: 640, height: 480 });
		hooks[0]?.popup("a", { kind: "files", multiple: false });
		hooks[0]?.popup("a", undefined);
		expect((await events.waitForType("browser.frame")).event).toEqual({
			type: "browser.frame",
			browserId,
			tabId: "a",
			data: "AAAA",
			width: 640,
			height: 480,
		});
		await events.waitFor((frame) => frame.event.type === "browser.popup" && !frame.event.popup);
		expect(events.frames.filter((frame) => frame.event.type === "browser.popup").map((frame) => frame.event)).toEqual([
			{ type: "browser.popup", browserId, tabId: "a", popup: { kind: "files", multiple: false } },
			{ type: "browser.popup", browserId, tabId: "a" },
		]);
		await control({ op: "screencast", value: true, width: 640, height: 480, scale: 2 });
		await control({ op: "input", input: { type: "text", text: "你好" } });
		expect(calls[0]).toEqual([
			{ op: "screencast", value: true, width: 640, height: 480, scale: 2 },
			{ op: "input", input: { type: "text", text: "你好" } },
		]);
		expect(overheard.types()).not.toContain("browser.frame");
		expect(overheard.types()).not.toContain("browser.popup");

		// As a window: the same profile, its web pages reopened with the one on screen last.
		await control({ op: "embed", value: false });
		expect(closes[0]).toHaveBeenCalledTimes(1);
		expect(localLaunch).toHaveBeenCalledTimes(2);
		expect(localLaunch.mock.calls[1]?.[0]).toBe(localLaunch.mock.calls[0]?.[0]);
		expect(localLaunch.mock.calls[1]?.[1]).toBe("http://localhost:3000/b");
		expect(hooks[1]).toBeUndefined();
		expect(calls[1]).toEqual([{ op: "newTab", url: "http://localhost:3000/a" }]);
		expect((await local.request("browser.list")).browsers).toMatchObject([{ browserId, embedded: false }]);
		await expect(control({ op: "input", input: { type: "text", text: "x" } })).rejects.toMatchObject({
			code: "UNSUPPORTED",
		});
		await control({ op: "reload" });
		expect(calls[1]).toContainEqual({ op: "reload" });
		// The old process going away late does not close the reopened browser.
		exits[0]?.();
		expect((await local.request("browser.list")).browsers).toHaveLength(1);

		// And back into the panel.
		await control({ op: "embed", value: true });
		expect(localLaunch).toHaveBeenCalledTimes(3);
		expect(hooks[2]).toBeDefined();
		expect((await local.request("browser.list")).browsers).toMatchObject([{ browserId, embedded: true }]);
		// The new process exiting closes the browser.
		exits[2]?.();
		await expect.poll(async () => (await local.request("browser.list")).browsers).toEqual([]);
	});
	it("keeps the panel's browser as it was when it cannot open as a window", async () => {
		const modes: boolean[] = [];
		localLaunch.mockImplementation(
			async (_profile: string, url: string, _port: unknown, _onExit: () => void, options?: { embed?: EmbedHooks }) => {
				modes.push(!!options?.embed);
				// No display for a window here.
				if (!options?.embed) throw new Error("本地浏览器已关闭");
				return {
					action: vi.fn(),
					close: vi.fn(async () => {}),
					control: async (command: BrowserControl) =>
						command.op === "state"
							? {
									state: {
										tabs: [{ id: "a", title: "A", url }],
										activeTabId: "a",
										canGoBack: false,
										canGoForward: false,
										loading: false,
									},
								}
							: {},
				};
			},
		);
		const localWorkspace = (await local.request("workspace.add", { path: a.workspaceDir, policy: "auto" })).workspace;
		const info = await local.request("browser.open", {
			workspaceId: localWorkspace.id,
			url: "http://localhost:3000/a",
			mode: "service",
			managed: true,
			embedded: true,
		});
		await expect(
			local.request("browser.control", { browserId: info.browserId, command: { op: "embed", value: false } }),
		).rejects.toMatchObject({ code: "CONFLICT", message: "无法以独立窗口打开浏览器：本地浏览器已关闭" });
		expect(modes).toEqual([true, false, true]);
		expect(localLaunch.mock.calls[2]?.[1]).toBe("http://localhost:3000/a");
		expect((await local.request("browser.list")).browsers).toMatchObject([
			{ browserId: info.browserId, embedded: true },
		]);
		await local.request("browser.control", { browserId: info.browserId, command: { op: "screencast", value: false } });
	});
	it("keeps a remote browser's stream: no panel frames, input or window switch", async () => {
		const info = await open();
		for (const command of [
			{ op: "screencast", value: true, width: 640, height: 480 },
			{ op: "input", input: { type: "text", text: "x" } },
			{ op: "embed", value: false },
		] as BrowserControl[])
			await expect(local.request("browser.control", { browserId: info.browserId, command })).rejects.toMatchObject({
				code: "UNSUPPORTED",
			});
		expect(controls).toEqual([]);
	});
	it("rejects an old remote host before trying to launch or proxy a local browser", async () => {
		const original = b.host.info.bind(b.host);
		vi.spyOn(b.host, "info").mockImplementation(() => ({ ...original(), protocolVersion: "1.46" }));
		await expect(open()).rejects.toThrow("1.48");
		expect(launches).toHaveLength(0);
		expect(localLaunch).not.toHaveBeenCalled();
	});
});
