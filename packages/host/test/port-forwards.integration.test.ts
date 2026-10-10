import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import type { PierClient } from "@pier/client";
import { MethodParamsSchemas, type PairingRequest } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

describe("independent TCP port mappings", () => {
	let localHost: TestHost;
	let remoteHost: TestHost;
	let local: PierClient;
	let remote: PierClient;
	let peerId: string;
	const servers: Server[] = [];
	const sockets = new Set<Socket>();

	beforeEach(async () => {
		localHost = await startTestHost();
		remoteHost = await startTestHost({ remote: { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } });
		local = await localHost.connect();
		remote = await remoteHost.connect();
		const events = new Recorder();
		remote.onEvent(events.handler);
		const { uri } = await remote.request("pairing.start");
		void events.waitForType("pairing.request").then((frame) =>
			remote.request("pairing.respond", {
				requestId: (frame.event.request as PairingRequest).id,
				accept: true,
			}),
		);
		peerId = (await local.request("peer.pair", { uri })).peer.id;
	});

	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		await Promise.all([localHost.close(), remoteHost.close()]);
		await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	});

	async function echoPort(): Promise<number> {
		const server = createServer({ allowHalfOpen: true }, (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.pipe(socket);
		});
		servers.push(server);
		return listen(server);
	}

	async function exchange(port: number, payload: Buffer): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
			sockets.add(socket);
			socket.setTimeout(10_000, () => socket.destroy(new Error("TCP exchange timed out")));
			const chunks: Buffer[] = [];
			socket.on("data", (data) => chunks.push(Buffer.from(data)));
			socket.once("error", reject);
			socket.once("connect", () => socket.end(payload));
			socket.once("end", () => {
				socket.destroy();
				resolve(Buffer.concat(chunks));
			});
			socket.once("close", () => sockets.delete(socket));
		});
	}

	it("lists listening sockets over the paired channel without a workspace", async () => {
		const port = await echoPort();
		const paired = await localHost.host.peers.openClient(peerId);
		try {
			const result = await paired.request("host.ports");
			expect(result.ports).toContainEqual(expect.objectContaining({ protocol: "tcp", address: "127.0.0.1", port }));
		} finally {
			paired.close();
		}
	});

	it("forwards concurrent binary traffic with half-close and closes only the selected mapping", async () => {
		const remotePort = await echoPort();
		const info = await local.request("portForward.open", { peerId, remoteHost: "127.0.0.1", remotePort });
		const second = await local.request("portForward.open", { peerId, remoteHost: "127.0.0.1", remotePort });
		expect(info.localHost).toBe("127.0.0.1");
		expect((await local.request("browser.list")).browsers).toEqual([]);
		const payload = Buffer.alloc(1024 * 1024, 173);
		const responses = await Promise.all(Array.from({ length: 3 }, () => exchange(info.localPort, payload)));
		for (const response of responses) expect(response).toEqual(payload);
		expect((await local.request("portForward.list")).forwards).toHaveLength(2);
		expect(await local.request("portForward.close", { id: info.id })).toEqual({ closed: true });
		await expect(exchange(info.localPort, Buffer.from("closed"))).rejects.toThrow();
		expect(await exchange(second.localPort, Buffer.from("still-open"))).toEqual(Buffer.from("still-open"));
	});

	it("honors a fixed local port and reports conflicts without leaking a listener", async () => {
		const remotePort = await echoPort();
		const reserved = createServer();
		servers.push(reserved);
		const fixed = await listen(reserved);
		await expect(
			local.request("portForward.open", { peerId, remoteHost: "127.0.0.1", remotePort, localPort: fixed }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await local.request("portForward.list")).forwards).toEqual([]);
		await new Promise<void>((resolve) => reserved.close(() => resolve()));
		const info = await local.request("portForward.open", {
			peerId,
			remoteHost: "127.0.0.1",
			remotePort,
			localPort: fixed,
		});
		expect(info.localPort).toBe(fixed);
		expect(await exchange(fixed, Buffer.from("fixed"))).toEqual(Buffer.from("fixed"));
	});

	it("keeps mappings private to their local connection and rejects remote management", async () => {
		const info = await local.request("portForward.open", {
			peerId,
			remoteHost: "127.0.0.1",
			remotePort: await echoPort(),
		});
		const other = await localHost.connect();
		expect((await other.request("portForward.list")).forwards).toEqual([]);
		expect(await other.request("portForward.close", { id: info.id })).toEqual({ closed: false });
		const paired = await localHost.host.peers.openClient(peerId);
		try {
			for (const method of ["portForward.list", "portForward.open", "portForward.close"] as const) {
				await expect(
					paired.request(
						method,
						method === "portForward.open"
							? { peerId, remoteHost: "127.0.0.1", remotePort: 22 }
							: method === "portForward.close"
								? { id: info.id }
								: {},
					),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
		} finally {
			paired.close();
		}
		local.close();
		await expect.poll(async () => (await other.request("portForward.list")).forwards).toEqual([]);
		await expect
			.poll(async () => {
				try {
					await exchange(info.localPort, Buffer.from("closed"));
					return false;
				} catch {
					return true;
				}
			})
			.toBe(true);
	});

	it("removes local listeners when the remote host disconnects", async () => {
		const info = await local.request("portForward.open", {
			peerId,
			remoteHost: "127.0.0.1",
			remotePort: await echoPort(),
		});
		await remoteHost.host.shutdown();
		await expect.poll(async () => (await local.request("portForward.list")).forwards).toEqual([]);
		await expect(exchange(info.localPort, Buffer.from("closed"))).rejects.toThrow();
	});

	it("closes listeners when the paired computer is removed", async () => {
		const info = await local.request("portForward.open", {
			peerId,
			remoteHost: "127.0.0.1",
			remotePort: await echoPort(),
		});
		await local.request("peer.remove", { peerId });
		await expect.poll(async () => (await local.request("portForward.list")).forwards).toEqual([]);
		await expect(exchange(info.localPort, Buffer.from("removed"))).rejects.toThrow();
	});

	it("maps older hosts with tunnel support and rejects hosts without it", async () => {
		const original = remoteHost.host.info.bind(remoteHost.host);
		remoteHost.host.info = () => ({ ...original(), protocolVersion: "1.37" });
		const remotePort = await echoPort();
		const info = await local.request("portForward.open", { peerId, remoteHost: "127.0.0.1", remotePort });
		expect(await exchange(info.localPort, Buffer.from("older-host"))).toEqual(Buffer.from("older-host"));
		await local.request("portForward.close", { id: info.id });
		remoteHost.host.info = () => ({ ...original(), protocolVersion: "1.36" });
		await expect(
			local.request("portForward.open", { peerId, remoteHost: "127.0.0.1", remotePort }),
		).rejects.toMatchObject({ code: "UNSUPPORTED" });
		expect((await local.request("portForward.list")).forwards).toEqual([]);
	});

	it("reports service connection failure while retaining the local mapping", async () => {
		const unused = createServer();
		servers.push(unused);
		const remotePort = await listen(unused);
		await new Promise<void>((resolve) => unused.close(() => resolve()));
		const info = await local.request("portForward.open", { peerId, remoteHost: "127.0.0.1", remotePort });
		const socket = connect(info.localPort, "127.0.0.1");
		sockets.add(socket);
		socket.on("error", () => {});
		await expect
			.poll(async () => (await local.request("portForward.list")).forwards[0]?.lastError)
			.toContain("无法连接远程端口");
	});

	it("validates local port bounds and rejects URL or credential-shaped destinations", () => {
		const schema = MethodParamsSchemas["portForward.open"];
		const input = { peerId, remoteHost: "::1", remotePort: 3000, localPort: 0 };
		expect(schema.safeParse(input).success).toBe(true);
		for (const remoteHost of ["http://localhost", "user:pass@host", "host;echo test"]) {
			expect(schema.safeParse({ ...input, remoteHost }).success).toBe(false);
		}
		for (const localPort of [-1, 65536, 1.5]) expect(schema.safeParse({ ...input, localPort }).success).toBe(false);
	});
});
