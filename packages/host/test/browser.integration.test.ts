import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { type AddressInfo, connect, type Server, type Socket, createServer as tcpServer } from "node:net";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import type { BrowserCommand, PairingRequest, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserProcess } from "../src/browser/browsers.ts";
import { remoteProxy } from "../src/browser/network.ts";
import { fauxAssistantMessage, fauxToolCall, Recorder, startTestHost, type TestHost } from "./helpers.ts";

const REMOTE = { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } as const;
async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}
function readHttp(
	port: number,
	path = "/",
	headers: Record<string, string> = {},
): Promise<{ text: string; status: number; headers: import("node:http").IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () =>
				resolve({ text: Buffer.concat(chunks).toString(), status: res.statusCode ?? 0, headers: res.headers }),
			);
		});
		req.on("error", reject);
		req.end("request-body");
	});
}

describe("local rendering over paired host network", () => {
	let a: TestHost;
	let b: TestHost;
	let local: PierClient;
	let remoteDesktop: PierClient;
	let peerId: string;
	let workspace: WorkspaceInfo;
	const cleanup: Array<() => void | Promise<void>> = [];
	const actions: BrowserCommand[] = [];
	const launches: Array<{ profile: string; url: string; proxyPort?: number; close: () => void }> = [];
	const logs: string[] = [];

	beforeEach(async () => {
		actions.length = 0;
		launches.length = 0;
		logs.length = 0;
		a = await startTestHost({
			browser: {
				launch: async (profile, url, proxyPort, onExit) => {
					const process: BrowserProcess = {
						action: async (command) => {
							actions.push(command);
							return { text: `browser:${command.action}` };
						},
						close: onExit,
					};
					launches.push({ profile, url, proxyPort, close: onExit });
					return process;
				},
			},
		});
		b = await startTestHost({ remote: REMOTE, log: (line) => logs.push(line) });
		local = await a.connect();
		remoteDesktop = await b.connect();
		workspace = (await remoteDesktop.request("workspace.add", { path: b.workspaceDir, policy: "auto" })).workspace;
		const events = new Recorder();
		remoteDesktop.onEvent(events.handler);
		const { uri } = await remoteDesktop.request("pairing.start");
		void events.waitForType("pairing.request").then((frame) =>
			remoteDesktop.request("pairing.respond", {
				requestId: (frame.event.request as PairingRequest).id,
				accept: true,
			}),
		);
		peerId = (await local.request("peer.pair", { uri })).peer.id;
	});
	afterEach(async () => {
		await Promise.all([a.close(), b.close()]);
		for (const close of cleanup.splice(0)) await close();
	});

	async function service() {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				res.setHeader("set-cookie", "session=test; HttpOnly");
				res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie }));
			});
		});
		const ws = new WebSocketServer({ server });
		ws.on("connection", (socket) => socket.on("message", (bytes, binary) => socket.send(bytes, { binary })));
		const port = await listen(server as unknown as Server);
		cleanup.push(() => {
			for (const client of ws.clients) client.terminate();
			ws.close();
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		});
		return port;
	}

	it("forwards HTTP bodies, cookies and concurrent WebSocket hot reload over the encrypted peer channel", async () => {
		const port = await service();
		const info = await local.request("browser.open", {
			peerId,
			workspaceId: workspace.id,
			url: `http://localhost:${port}/app?q=1#view`,
			mode: "service",
		});
		const localPort = Number(new URL(info.localUrl).port);
		expect(new URL(info.localUrl).hostname).toBe("127.0.0.1");
		expect(new URL(info.localUrl).pathname).toBe("/app");
		const another = await local.request("browser.open", {
			peerId,
			workspaceId: workspace.id,
			url: `http://localhost:${port}/second`,
			mode: "service",
		});
		expect(another.browserId).toBe(info.browserId);
		expect(new URL(another.localUrl).port).toBe(String(localPort));
		const responses = await Promise.all(
			Array.from({ length: 6 }, () => readHttp(localPort, "/app?q=1", { cookie: "session=test" })),
		);
		for (const response of responses) {
			expect(JSON.parse(response.text)).toEqual({ path: "/app?q=1", body: "request-body", cookie: "session=test" });
			expect(response.headers["set-cookie"]).toEqual(["session=test; HttpOnly"]);
		}
		const socket = new WebSocket(`ws://127.0.0.1:${localPort}/hmr`);
		cleanup.push(() => socket.terminate());
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const echo = new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
		socket.send("hot-reload");
		expect(await echo).toBe("hot-reload");
		const audit = readFileSync(join(b.root, "pier", "audit.log"), "utf8");
		expect(audit).toContain("tunnel.open");
		expect(audit).not.toContain("request-body");
		expect(audit).not.toContain("session=test");
		expect(logs.join("")).not.toContain("request-body");
		expect(logs.join("")).not.toContain("session=test");
		await local.request("browser.close", { browserId: info.browserId });
		await expect(readHttp(localPort)).rejects.toThrow();
	});

	it("proxies absolute HTTP requests and raw CONNECT bytes without changing target origins", async () => {
		const client = await a.host.peers.openClient(peerId);
		cleanup.push(() => client.close());
		const proxy = await remoteProxy(client);
		cleanup.push(() => proxy.close());
		const port = await service();
		const response = await readHttp(proxy.port, `http://127.0.0.1:${port}/original?x=1`);
		expect(JSON.parse(response.text).path).toBe("/original?x=1");
		const echo = tcpServer((socket) => socket.pipe(socket));
		const echoPort = await listen(echo);
		cleanup.push(() => new Promise<void>((resolve) => echo.close(() => resolve())));
		const socket = connect(proxy.port, "127.0.0.1");
		cleanup.push(() => {
			socket.destroy();
		});
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		const established = new Promise<void>((resolve) =>
			socket.once("data", (bytes) => {
				expect(String(bytes)).toContain("200 Connection Established");
				resolve();
			}),
		);
		socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
		await established;
		const payload = Buffer.alloc(1024 * 1024, 137);
		const result = new Promise<Buffer>((resolve) => {
			const parts: Buffer[] = [];
			let length = 0;
			socket.on("data", (bytes: Buffer) => {
				parts.push(bytes);
				length += bytes.length;
				if (length === payload.length) resolve(Buffer.concat(parts));
			});
		});
		socket.write(payload);
		expect(await result).toEqual(payload);
		socket.destroy();
	});

	it("keeps streams private to their connection, rejects malformed writes and cleans up on disconnect", async () => {
		const client = await a.host.peers.openClient(peerId);
		cleanup.push(() => client.close());
		const sockets = new Set<Socket>();
		const server = tcpServer({ allowHalfOpen: true }, (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("end", () => socket.end());
		});
		const port = await listen(server);
		cleanup.push(() => {
			for (const socket of sockets) socket.destroy();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const { tunnelId } = await client.request("tunnel.open", { host: "127.0.0.1", port });
		await expect(remoteDesktop.request("tunnel.read", { tunnelId })).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(remoteDesktop.request("tunnel.close", { tunnelId })).resolves.toEqual({ closed: false });
		await expect(client.request("tunnel.write", { tunnelId, data: "not base64!!" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(
			client.request("browser.open", { workspaceId: workspace.id, url: "http://example.com", mode: "network" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const gone = new Promise<void>((resolve) => [...sockets][0]?.once("close", () => resolve()));
		client.close();
		await gone;
	});

	it("routes agent actions to the local browser only with explicit opt in and removes it after revocation", async () => {
		const info = await local.request("browser.open", {
			peerId,
			workspaceId: workspace.id,
			url: "https://example.com",
			mode: "network",
			controlled: false,
		});
		expect(info.controllable).toBe(false);
		expect(launches[0]?.proxyPort).toBeGreaterThan(0);
		await expect(
			remoteDesktop.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await local.request("browser.close", { browserId: info.browserId });
		const controlled = await local.request("browser.open", {
			peerId,
			workspaceId: workspace.id,
			url: "https://example.com",
			mode: "network",
			controlled: true,
		});
		const result = await remoteDesktop.request("browser.action", {
			workspaceId: workspace.id,
			command: { action: "snapshot" },
		});
		expect(result.text).toBe("browser:snapshot");
		expect(actions).toEqual([{ action: "snapshot" }]);
		expect(launches[0]?.profile).toBe(launches[1]?.profile);
		expect((await local.request("browser.list")).browsers).toEqual([controlled]);
		const device = (await remoteDesktop.request("device.list")).devices[0];
		await remoteDesktop.request("device.revoke", { deviceId: device?.id ?? "" });
		await expect.poll(async () => (await local.request("browser.list")).browsers).toEqual([]);
		await expect(
			remoteDesktop.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("accepts browser replies only from the registered connection and rejects pending actions when detached", async () => {
		const other = await b.connect();
		const browserId = "manual-controller";
		await remoteDesktop.request("browser.attach", { workspaceId: workspace.id, browserId });
		const events = new Recorder();
		remoteDesktop.onEvent(events.handler);
		const pending = other.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } });
		const command = await events.waitForType("browser.command");
		const requestId = String(command.event.requestId);
		expect(await other.request("browser.result", { requestId, result: { text: "wrong connection" } })).toEqual({
			accepted: false,
		});
		expect(await other.request("browser.detach", { browserId })).toEqual({ detached: false });
		await remoteDesktop.request("browser.result", { requestId, result: { text: "real result" } });
		expect(await pending).toEqual({ text: "real result" });
		const mark = events.mark();
		const detached = expect(
			other.request("browser.action", { workspaceId: workspace.id, command: { action: "snapshot" } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await events.waitForType("browser.command", mark);
		await remoteDesktop.request("browser.detach", { browserId });
		await detached;
	});

	it("runs the built in pi browser tool with workspace approvals before interacting with a page", async () => {
		await local.request("browser.open", {
			peerId,
			workspaceId: workspace.id,
			url: "https://example.com",
			mode: "network",
			controlled: true,
		});
		await remoteDesktop.request("workspace.setPolicy", { workspaceId: workspace.id, policy: "ask" });
		const { session } = await remoteDesktop.request("session.create", { workspaceId: workspace.id });
		const events = new Recorder();
		await remoteDesktop.subscribe(session.id, events.handler, { workspaceId: workspace.id });
		b.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("pier_browser", { action: "click", selector: "#submit" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await remoteDesktop.request("session.prompt", { sessionId: session.id, text: "click button" });
		const frame = await events.waitForType("ui.request");
		expect(actions).toEqual([]);
		const ui = frame.event.request as { id: string; approval: { toolName: string } };
		expect(ui.approval.toolName).toBe("pier_browser");
		await remoteDesktop.request("ui.respond", {
			sessionId: session.id,
			requestId: ui.id,
			response: { decision: "allow_once" },
		});
		await events.waitForType("agent_settled");
		expect(actions).toEqual([{ action: "click", selector: "#submit" }]);
	});

	it("handles service failures, unsafe URL schemes, missing browsers and connection-owned browser lifetimes", async () => {
		await expect(
			local.request("browser.open", { peerId, workspaceId: workspace.id, url: "file:///etc/passwd", mode: "service" }),
		).rejects.toThrow();
		await expect(
			local.request("browser.open", {
				peerId,
				workspaceId: workspace.id,
				url: "https://user:pass@example.com",
				mode: "network",
			}),
		).rejects.toThrow();
		expect((await local.request("browser.list")).browsers).toEqual([]);
		const port = await service();
		const info = await local.request("browser.open", {
			peerId,
			workspaceId: workspace.id,
			url: `http://127.0.0.1:${port}`,
			mode: "service",
		});
		const stranger = await a.connect();
		expect((await stranger.request("browser.list")).browsers).toEqual([]);
		expect(await stranger.request("browser.close", { browserId: info.browserId })).toEqual({ closed: false });
		local.close();
		await expect
			.poll(async () => {
				try {
					await readHttp(Number(new URL(info.localUrl).port));
					return false;
				} catch {
					return true;
				}
			})
			.toBe(true);
	});
});
