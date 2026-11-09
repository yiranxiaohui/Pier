import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PierClient } from "@pier/client";
import type { BrowserCommand, PairingRequest, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
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
	const transports: string[] = [];
	const localLaunch = vi.fn();
	const cleanup: Array<() => Promise<void>> = [];
	let closed: number;
	let launchGate: Promise<void> | undefined;
	let releaseLaunch: (() => void) | undefined;
	let failLaunch: boolean;
	beforeEach(async () => {
		launches.length = actions.length = transports.length = 0;
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
	it("rejects an old remote host before trying to launch or proxy a local browser", async () => {
		const original = b.host.info.bind(b.host);
		vi.spyOn(b.host, "info").mockImplementation(() => ({ ...original(), protocolVersion: "1.46" }));
		await expect(open()).rejects.toThrow("1.48");
		expect(launches).toHaveLength(0);
		expect(localLaunch).not.toHaveBeenCalled();
	});
});
