import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import {
	generateKeyPair,
	type KeyPair,
	RELAY_CLOSE,
	type RelayServerMessage,
	relayConnectUrl,
	relayRegisterProof,
	toBase64Url,
} from "@pier/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_ICE_SERVER_URLS, type RelayServer, startRelayServer } from "../src/server.ts";
import { bindingResponse } from "../src/stun.ts";

const TOKEN = "relay-test-token-0123456789";

function nextMessage(socket: WebSocket): Promise<RelayServerMessage> {
	return new Promise((resolve, reject) => {
		socket.once("message", (data) => resolve(JSON.parse(data.toString()) as RelayServerMessage));
		socket.once("close", (code) => reject(new Error(`closed ${code}`)));
	});
}

function closed(socket: WebSocket): Promise<number> {
	return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

function opened(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
}

/** Register `keys` as a host; resolves with the control socket and the `registered` message. */
async function registerHost(
	relay: RelayServer,
	keys: KeyPair,
	token?: string,
): Promise<{ socket: WebSocket; registered: RelayServerMessage }> {
	const socket = new WebSocket(`${relay.url}/v1/host`);
	const challenge = await nextMessage(socket);
	if (challenge.t !== "challenge") throw new Error(challenge.t);
	const reply = nextMessage(socket);
	socket.send(
		JSON.stringify({
			t: "register",
			v: 1,
			pk: toBase64Url(keys.publicKey),
			proof: relayRegisterProof(keys, challenge),
			...(token ? { token } : {}),
		}),
	);
	return { socket, registered: await reply };
}

describe("relay server", () => {
	let relay: RelayServer;
	const sockets: WebSocket[] = [];
	const track = <T extends WebSocket>(socket: T): T => {
		sockets.push(socket);
		return socket;
	};
	afterEach(async () => {
		for (const socket of sockets.splice(0)) socket.terminate();
		await relay?.close();
	});

	it("registers hosts with a token in private mode and pipes device connections", async () => {
		relay = await startRelayServer({ mode: "private", tokens: [TOKEN], port: 0, stunPort: 0 });
		const keys = generateKeyPair();
		const { socket: control, registered } = await registerHost(relay, keys, TOKEN);
		track(control);
		expect(registered).toMatchObject({ t: "registered", mode: "private" });

		const device = track(new WebSocket(relayConnectUrl(relay.url, keys.publicKey)));
		const deviceOpened = opened(device);
		const incoming = await nextMessage(control);
		await deviceOpened;
		device.send("hello before pickup");
		if (incoming.t !== "incoming") throw new Error(incoming.t);
		expect(incoming.addr).toBe("127.0.0.1");
		const accepted = track(new WebSocket(`${relay.url}/v1/accept?id=${incoming.id}`));
		const early = new Promise<string>((resolve) => accepted.once("message", (d) => resolve(d.toString())));
		await opened(accepted);
		expect(await early).toBe("hello before pickup");
		const reply = new Promise<string>((resolve) => device.once("message", (d) => resolve(d.toString())));
		accepted.send("from host");
		expect(await reply).toBe("from host");
		expect(relay.stats()).toEqual({ hosts: 1, streams: 1 });
		// Close codes pass through (e.g. the host refusing an unknown device).
		const deviceClosed = closed(device);
		accepted.close(4403, "UNKNOWN_DEVICE");
		expect(await deviceClosed).toBe(4403);
		// The id cannot be used twice.
		const again = track(new WebSocket(`${relay.url}/v1/accept?id=${incoming.id}`));
		await expect(opened(again)).rejects.toThrow(/404/);
	});

	it("kicks a host and closes its active and pending relay streams", async () => {
		relay = await startRelayServer({ mode: "open", port: 0, stunPort: 0 });
		const keys = generateKeyPair();
		const { socket: control } = await registerHost(relay, keys);
		track(control);
		const incomingMessage = nextMessage(control);
		const device = track(new WebSocket(relayConnectUrl(relay.url, keys.publicKey)));
		await opened(device);
		const incoming = await incomingMessage;
		if (incoming.t !== "incoming") throw new Error(incoming.t);
		const accepted = track(new WebSocket(`${relay.url}/v1/accept?id=${incoming.id}`));
		await opened(accepted);
		const pendingIncoming = nextMessage(control);
		const pendingDevice = track(new WebSocket(relayConnectUrl(relay.url, keys.publicKey)));
		await opened(pendingDevice);
		const pending = await pendingIncoming;
		if (pending.t !== "incoming") throw new Error(pending.t);
		const controlClosed = closed(control);
		const deviceClosed = closed(device);
		const acceptedClosed = closed(accepted);
		const pendingClosed = closed(pendingDevice);

		expect(relay.kickHost(toBase64Url(keys.publicKey))).toBe(true);
		expect(await controlClosed).toBe(1000);
		expect(await deviceClosed).toBe(1000);
		expect(await acceptedClosed).toBe(1000);
		expect(await pendingClosed).toBe(1000);
		expect(relay.kickHost(toBase64Url(keys.publicKey))).toBe(false);
		expect(relay.stats()).toEqual({ hosts: 0, streams: 0 });
		const lateAccept = track(new WebSocket(`${relay.url}/v1/accept?id=${pending.id}`));
		await expect(opened(lateAccept)).rejects.toThrow(/404/);
	});

	it("refuses wrong tokens and failed key proofs", async () => {
		relay = await startRelayServer({ mode: "private", tokens: [TOKEN], port: 0, stunPort: 0 });
		const wrong = await registerHost(relay, generateKeyPair(), "wrong-token-0123456789");
		track(wrong.socket);
		expect(wrong.registered).toMatchObject({ t: "error", code: "UNAUTHORIZED" });
		expect(await closed(wrong.socket)).toBe(RELAY_CLOSE.unauthorized);

		// A proof made with another key than the one registered.
		const socket = track(new WebSocket(`${relay.url}/v1/host`));
		const challenge = await nextMessage(socket);
		if (challenge.t !== "challenge") throw new Error(challenge.t);
		const reply = nextMessage(socket);
		socket.send(
			JSON.stringify({
				t: "register",
				v: 1,
				pk: toBase64Url(generateKeyPair().publicKey),
				proof: relayRegisterProof(generateKeyPair(), challenge),
				token: TOKEN,
			}),
		);
		expect(await reply).toMatchObject({ t: "error", code: "UNAUTHORIZED" });
		expect(relay.stats().hosts).toBe(0);
	});

	it("rejects device connections to hosts that are offline, and times out unanswered ones", async () => {
		relay = await startRelayServer({ mode: "open", port: 0, stunPort: 0, acceptTimeoutMs: 200 });
		const keys = generateKeyPair();
		const offline = track(new WebSocket(relayConnectUrl(relay.url, keys.publicKey)));
		await expect(opened(offline)).rejects.toThrow(/404/);
		const { socket: control, registered } = await registerHost(relay, keys);
		track(control);
		expect(registered).toMatchObject({ t: "registered", mode: "open" });
		const device = track(new WebSocket(relayConnectUrl(relay.url, keys.publicKey)));
		expect(await closed(device)).toBe(RELAY_CLOSE.acceptTimeout);
	});

	it("lets a new registration replace the old one and limits connections per host", async () => {
		relay = await startRelayServer({ mode: "open", port: 0, stunPort: 0, maxStreamsPerHost: 1 });
		const keys = generateKeyPair();
		const first = await registerHost(relay, keys);
		track(first.socket);
		const firstClosed = closed(first.socket);
		const second = await registerHost(relay, keys);
		track(second.socket);
		expect(await firstClosed).toBe(RELAY_CLOSE.replaced);
		expect(relay.stats().hosts).toBe(1);
		const one = track(new WebSocket(relayConnectUrl(relay.url, keys.publicKey)));
		await opened(one);
		const two = track(new WebSocket(relayConnectUrl(relay.url, keys.publicKey)));
		await expect(opened(two)).rejects.toThrow(/503/);
	});

	it("announces its STUN server and answers binding requests", async () => {
		relay = await startRelayServer({
			mode: "open",
			port: 0,
			stunPort: 0,
			iceServers: [{ urls: "stun:stun.example.com:3478" }],
		});
		const { socket, registered } = await registerHost(relay, generateKeyPair());
		track(socket);
		expect(registered).toMatchObject({
			iceServers: [{ urls: `stun:127.0.0.1:${relay.stunPort}` }, { urls: "stun:stun.example.com:3478" }],
		});

		const client = createSocket("udp4");
		const transactionId = randomBytes(12);
		const request = Buffer.alloc(20);
		request.writeUInt16BE(0x0001, 0);
		request.writeUInt32BE(0x2112a442, 4);
		transactionId.copy(request, 8);
		const response = await new Promise<Buffer>((resolve) => {
			client.once("message", (message) => resolve(message));
			client.send(request, relay.stunPort as number, "127.0.0.1");
		});
		const port = client.address().port;
		client.close();
		expect(response.readUInt16BE(0)).toBe(0x0101);
		expect(response.subarray(8, 20).equals(transactionId)).toBe(true);
		// XOR-MAPPED-ADDRESS is the first attribute.
		expect(response.readUInt16BE(20)).toBe(0x0020);
		expect(response.readUInt16BE(26) ^ 0x2112).toBe(port);
		const cookie = [0x21, 0x12, 0xa4, 0x42];
		const ip = [...response.subarray(28, 32)].map((b, i) => b ^ (cookie[i] ?? 0)).join(".");
		expect(ip).toBe("127.0.0.1");
	});

	it("announces domestic and international STUN fallbacks by default", async () => {
		relay = await startRelayServer({ mode: "open", port: 0, stunPort: false });
		const { socket, registered } = await registerHost(relay, generateKeyPair());
		track(socket);
		expect(registered).toMatchObject({
			iceServers: DEFAULT_ICE_SERVER_URLS.map((urls) => ({ urls })),
		});
	});

	it("ignores datagrams that are not STUN binding requests", () => {
		expect(bindingResponse(Buffer.from("hello world, not stun"), { address: "1.2.3.4", port: 5 })).toBeUndefined();
		const ipv6 = Buffer.alloc(20);
		ipv6.writeUInt16BE(0x0001, 0);
		ipv6.writeUInt32BE(0x2112a442, 4);
		const response = bindingResponse(ipv6, { address: "2001:db8::1", port: 4242 });
		expect(response?.readUInt8(25)).toBe(0x02);
		expect(response?.length).toBeGreaterThan(40);
	});
});
