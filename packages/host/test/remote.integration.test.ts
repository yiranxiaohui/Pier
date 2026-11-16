import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CLOSE_DEVICE_REVOKED,
	createSecureSocketFactory,
	type PairingOutcome,
	PierClient,
	pairWithHost,
	type WebSocketFactory,
	type WebSocketLike,
} from "@pier/client";
import {
	ChannelError,
	ConnectInitiator,
	generateKeyPair,
	type KeyPair,
	keyFingerprint,
	parsePairingUri,
} from "@pier/crypto";
import {
	type EventFrame,
	type PairingRequest,
	PierProtocolError,
	type RemoteAccessStatus,
	type UiRequest,
	type WorkspaceInfo,
} from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Recorder, startTestHost, type TestHost } from "./helpers.ts";

const posixShell = process.platform !== "win32";

const REMOTE = { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } as const;

/** Global WebSocket factory that records every raw frame sent and received (a "packet capture"). */
function capturingFactory(wire: string[]): WebSocketFactory {
	return (url) => {
		const socket = new WebSocket(url) as unknown as WebSocketLike & {
			addEventListener(type: string, fn: (e: { data: unknown }) => void): void;
		};
		const send = socket.send.bind(socket);
		socket.send = (data: string) => {
			wire.push(data);
			send(data);
		};
		socket.addEventListener("message", (e) => wire.push(String(e.data)));
		return socket;
	};
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expect((error as { code?: string }).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code}`);
}

describe("remote access", () => {
	let t: TestHost;
	let desktop: PierClient;
	let desktopEvents: Recorder;
	let workspace: WorkspaceInfo;
	const phoneKeys: KeyPair = generateKeyPair();

	beforeEach(async () => {
		t = await startTestHost({
			remote: { ...REMOTE, approvalTimeoutMs: 2000 },
		});
		desktop = await t.connect();
		desktopEvents = new Recorder();
		desktop.onEvent(desktopEvents.handler);
		workspace = (await desktop.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	async function pair(
		keys: KeyPair = phoneKeys,
		decide: (request: PairingRequest) => boolean | undefined = () => true,
		uri?: string,
	): Promise<PairingOutcome> {
		const pairingUri = uri ?? (await desktop.request("pairing.start")).uri;
		const from = desktopEvents.mark();
		const outcome = pairWithHost({
			info: parsePairingUri(pairingUri),
			deviceKeyPair: keys,
			device: { name: "Test Phone", platform: "android", appVersion: "0.2.0" },
		});
		let settled = false;
		void outcome
			.finally(() => {
				settled = true;
			})
			.catch(() => undefined);
		// Answer the confirmation dialog the desktop shows (unless this attempt already failed).
		void desktopEvents
			.waitForType("pairing.request", from)
			.then((frame) => {
				if (settled) return;
				const request = frame.event.request as PairingRequest;
				const accept = decide(request);
				if (accept !== undefined) return desktop.request("pairing.respond", { requestId: request.id, accept });
			})
			.catch(() => undefined);
		return outcome;
	}

	function phoneClient(outcome: PairingOutcome, keys: KeyPair = phoneKeys, wire?: string[]): PierClient {
		return new PierClient({
			url: "pier-secure://host",
			client: { name: "pier-mobile", version: "0.2.0", platform: "android" },
			coalesceMs: 50,
			reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
			createWebSocket: createSecureSocketFactory({
				addresses: outcome.addresses,
				hostPublicKey: outcome.hostPublicKey,
				deviceKeyPair: keys,
				...(wire ? { createWebSocket: capturingFactory(wire) } : {}),
			}),
		});
	}

	it("previews a host screenshot through the encrypted paired connection", async () => {
		const path = join(t.root, "screen.png");
		const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=";
		writeFileSync(path, Buffer.from(data, "base64"));
		const phone = phoneClient(await pair());
		try {
			await phone.connect();
			expect(await phone.request("workspace.previewFile", { workspaceId: workspace.id, path })).toMatchObject({
				path,
				kind: "image",
				mimeType: "image/png",
				data,
			});
		} finally {
			phone.close();
		}
	});

	it("reports status and a pairing code that points at the listener", async () => {
		const status = await desktop.request("remote.status");
		expect(status).toMatchObject({ enabled: true, running: true, pairingActive: false, mdns: false });
		expect(status.addresses).toEqual([`127.0.0.1:${status.port}`]);
		const identity = t.host.remote.identity.publicKey;
		expect(status.hostFingerprint).toBe(keyFingerprint(identity));

		const from = desktopEvents.mark();
		const started = await desktop.request("pairing.start");
		const info = parsePairingUri(started.uri);
		expect(info.addresses).toEqual(status.addresses);
		expect(Buffer.from(info.hostPublicKey).equals(Buffer.from(identity))).toBe(true);
		expect(info.hostId).toBe(t.host.info().hostId);
		const changed = await desktopEvents.waitForType("remote.changed", from);
		expect((changed.event.status as RemoteAccessStatus).pairingActive).toBe(true);
		expect(await desktop.request("pairing.cancel")).toEqual({ cancelled: true });
		expect((await desktop.request("remote.status")).pairingActive).toBe(false);
	});

	it("pairs after desktop confirmation, then drives a session end to end over the encrypted channel", async () => {
		let seenRequest: PairingRequest | undefined;
		const outcome = await pair(phoneKeys, (request) => {
			seenRequest = request;
			return true;
		});
		expect(seenRequest).toMatchObject({
			device: { name: "Test Phone", platform: "android" },
			fingerprint: keyFingerprint(phoneKeys.publicKey),
			address: "127.0.0.1",
		});
		expect(outcome).toMatchObject({ hostId: t.host.info().hostId, hostName: t.host.info().hostName });
		const devices = (await desktop.request("device.list")).devices;
		expect(devices).toEqual([
			expect.objectContaining({ id: outcome.deviceId, name: "Test Phone", connected: false, appVersion: "0.2.0" }),
		]);

		const wire: string[] = [];
		const phone = phoneClient(outcome, phoneKeys, wire);
		const hello = await phone.connect();
		expect(hello.device).toEqual({ id: outcome.deviceId, name: "Test Phone" });
		expect((await desktop.request("device.list")).devices[0]?.connected).toBe(true);

		// A paired device is trusted to manage the computer (1.10): browse directories, add
		// workspaces, change policies, edit files, and read provider settings.
		expect((await phone.request("workspace.list")).workspaces.map((w) => w.id)).toEqual([workspace.id]);
		const extraDir = join(t.root, "phone-project");
		mkdirSync(extraDir);
		const listing = await phone.request("host.listDirectories", { path: t.root });
		expect(listing.entries.map((e) => e.name)).toContain("phone-project");
		const added = (await phone.request("workspace.add", { path: extraDir })).workspace;
		expect((await desktop.request("workspace.list")).workspaces.map((w) => w.id)).toContain(added.id);
		expect(
			(await phone.request("workspace.setPolicy", { workspaceId: added.id, policy: "auto" })).workspace.policy,
		).toBe("auto");
		writeFileSync(join(extraDir, "x.txt"), "old");
		await phone.request("workspace.writeFile", { workspaceId: added.id, path: "x.txt", text: "new" });
		expect(readFileSync(join(extraDir, "x.txt"), "utf8")).toBe("new");
		expect(await phone.request("workspace.createFile", { workspaceId: added.id, path: "notes/new.md" })).toMatchObject({
			path: "notes/new.md",
			size: 0,
		});
		expect(await phone.request("workspace.createDirectory", { workspaceId: added.id, path: "notes/empty" })).toEqual({
			path: "notes/empty",
		});
		expect(readFileSync(join(extraDir, "notes", "new.md"), "utf8")).toBe("");
		expect((await phone.request("workspace.files", { workspaceId: added.id, path: "notes/empty" })).entries).toEqual(
			[],
		);
		await phone.request("workspace.transferPath", {
			workspaceId: added.id,
			path: "x.txt",
			destinationWorkspaceId: workspace.id,
			destinationPath: "from-phone.txt",
			mode: "copy",
		});
		expect(readFileSync(join(t.workspaceDir, "from-phone.txt"), "utf8")).toBe("new");
		expect(await phone.request("workspace.deletePath", { workspaceId: added.id, path: "x.txt" })).toEqual({
			path: "x.txt",
			kind: "file",
		});
		expect(existsSync(join(extraDir, "x.txt"))).toBe(false);
		expect((await phone.request("provider.list")).providers.length).toBeGreaterThan(0);
		expect(await phone.request("workspace.remove", { workspaceId: added.id })).toEqual({ removed: true });

		// Inspect the selected host, without granting authority to change who may reach it (1.55).
		expect(await phone.request("device.list")).toEqual(await desktop.request("device.list"));
		expect(await phone.request("remote.status")).toEqual(await desktop.request("remote.status"));
		expect(await phone.request("peer.list")).toEqual(await desktop.request("peer.list"));
		t.host.recordLog("remote-settings diagnostic marker");
		t.host.recordLog("request https://example.test/path?token=secret-value password=hidden-value");
		const logs = await phone.request("host.logs");
		expect(logs.lines).toContain("remote-settings diagnostic marker");
		expect(logs).toEqual(await desktop.request("host.logs"));
		expect(logs.lines.join("\n")).not.toMatch(/secret-value|hidden-value/);
		expect(logs.lines.some((line) => line.includes("remote access listening"))).toBe(true);

		// Mutation and pairing remain local-only, including removal of the current device.
		for (const call of [
			phone.request("device.revoke", { deviceId: outcome.deviceId }),
			phone.request("device.rename", { deviceId: outcome.deviceId, name: "Changed" }),
			phone.request("pairing.start"),
			phone.request("pairing.cancel"),
			phone.request("pairing.respond", { requestId: "not-pending", accept: true }),
			phone.request("remote.configure", { enabled: false }),
			phone.request("peer.remove", { peerId: "other-host" }),
			// Listening on this computer for another computer's browser sign-in.
			phone.request("loopback.open"),
		]) {
			await expectCode(call, "FORBIDDEN");
		}

		t.faux.setResponses([fauxAssistantMessage("streamed to the phone: TOP-SECRET-OUTPUT")]);
		const { session } = await phone.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await phone.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		await phone.request("session.prompt", { sessionId: session.id, text: "remote prompt TOP-SECRET-INPUT" });
		await rec.waitForType("agent_settled");
		expect(rec.text()).toBe("streamed to the phone: TOP-SECRET-OUTPUT");

		// Packet capture: after the handshake only ciphertext crosses the wire.
		expect(wire.length).toBeGreaterThan(5);
		const joined = wire.join("\n");
		for (const secret of ["TOP-SECRET", "session.prompt", "host.hello", "workspace", "Test Phone"]) {
			expect(joined).not.toContain(secret);
		}
		expect(wire.slice(2).every((frame) => JSON.parse(frame).t === "enc")).toBe(true);

		// Pairing events never reach remote devices.
		const phoneEvents: string[] = [];
		phone.onEvent((frame: EventFrame) => phoneEvents.push(frame.event.type));
		await desktop.request("pairing.start");
		await desktop.request("pairing.cancel");
		await phone.request("host.info");
		expect(phoneEvents.filter((type) => type.startsWith("remote.") || type.startsWith("pairing."))).toEqual([]);

		// The audit log records what the device did, without prompt text.
		const audit = readFileSync(join(t.root, "pier", "audit.log"), "utf8");
		expect(audit).toContain('"event":"pair.accepted"');
		expect(audit).toContain('"event":"connect"');
		expect(audit).toMatch(/"event":"session.prompt".*"textLength":30/);
		expect(audit).toMatch(/"event":"workspace.add".*phone-project/);
		expect(audit).toMatch(/"event":"workspace.writeFile".*"bytes":3/);
		expect(audit).toMatch(/"event":"workspace.createFile".*"path":"notes\/new.md"/);
		expect(audit).toMatch(/"event":"workspace.createDirectory".*"path":"notes\/empty"/);
		expect(audit).toMatch(/"event":"workspace.deletePath".*"path":"x.txt"/);
		expect(audit).toMatch(/"event":"workspace.transferPath".*"destinationPath":"from-phone.txt"/);
		expect(audit).not.toContain("TOP-SECRET");
		phone.close();
	});

	it.skipIf(!posixShell)("lets the phone answer approvals", async () => {
		const outcome = await pair();
		const phone = phoneClient(outcome);
		await phone.connect();
		t.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "touch from-phone.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const hostEvents = new Recorder();
		phone.onEvent((frame) => {
			if (!frame.sessionId) hostEvents.handler(frame);
		});
		const { session } = await phone.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await phone.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await phone.request("session.prompt", { sessionId: session.id, text: "make a file" });
		const request = (await rec.waitForType("ui.request")).event.request as UiRequest;
		expect(request.kind).toBe("approval");

		// Session lists and activity events tell other screens that an answer is needed.
		const activity = await hostEvents.waitFor((f) => f.event.type === "session.activity" && f.event.pendingUi === 1);
		expect(activity.event).toMatchObject({ sessionId: session.id, workspaceId: workspace.id, state: "streaming" });
		const listed = (await phone.request("session.list", { workspaceId: workspace.id })).sessions;
		expect(listed.find((s) => s.id === session.id)).toMatchObject({ pendingUi: 1, state: "streaming" });
		await phone.request("ui.respond", {
			sessionId: session.id,
			requestId: request.id,
			response: { decision: "allow_once" },
		});
		await rec.waitForType("agent_settled");
		await hostEvents.waitFor((f) => f.event.type === "session.activity" && f.event.state === "idle");
		expect(
			(await phone.request("session.list", { workspaceId: workspace.id })).sessions.find((s) => s.id === session.id),
		).toMatchObject({ pendingUi: 0, state: "idle" });
		expect(readFileSync(join(t.root, "pier", "audit.log"), "utf8")).toContain('"decision":"allow_once"');
		phone.close();
	});

	it("disconnects a revoked device immediately and refuses it afterwards", async () => {
		const outcome = await pair();
		const phone = phoneClient(outcome);
		await phone.connect();
		const errors: Error[] = [];
		phone.onError((e) => errors.push(e));
		const closed = new Promise<void>((resolve) => phone.onState((s) => s === "closed" && resolve()));

		expect(await desktop.request("device.revoke", { deviceId: outcome.deviceId })).toEqual({ revoked: true });
		await closed;
		expect(phone.terminalClose?.code).toBe(CLOSE_DEVICE_REVOKED);
		expect(errors.some((e) => e instanceof PierProtocolError)).toBe(true);
		expect((await desktop.request("device.list")).devices).toEqual([]);

		// A fresh connection attempt is refused during the handshake.
		const again = phoneClient(outcome);
		await expect(again.connect()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
		expect(again.terminalClose).toEqual({ code: CLOSE_DEVICE_REVOKED, reason: "UNKNOWN_DEVICE" });
	});

	it("refuses unpaired devices during the IK handshake", async () => {
		const status = await desktop.request("remote.status");
		const socket = new WebSocket(`ws://${status.addresses[0]}`);
		const initiator = new ConnectInitiator({
			deviceKeyPair: generateKeyPair(),
			hostPublicKey: t.host.remote.identity.publicKey,
		});
		const reply = await new Promise<{ data: string; code: number }>((resolve) => {
			let data = "";
			socket.onopen = () => socket.send(initiator.start());
			socket.onmessage = (e) => {
				data = String(e.data);
			};
			socket.onclose = (e) => resolve({ data, code: e.code });
		});
		expect(reply.code).toBe(4403);
		expect(() => initiator.receive(reply.data)).toThrowError(expect.objectContaining({ code: "UNKNOWN_DEVICE" }));
	});

	it("rejects wrong, reused and declined pairing codes", async () => {
		const { uri } = await desktop.request("pairing.start");
		const wrong = uri.replace(/code=[^&]+/, "code=wrong-code");
		await expect(pair(generateKeyPair(), () => undefined, wrong)).rejects.toMatchObject({ code: "PAIRING_INVALID" });

		// The real code still works once, then it is used up.
		await pair(generateKeyPair(), () => true, uri);
		await expect(pair(generateKeyPair(), () => true, uri)).rejects.toMatchObject({ code: "PAIRING_INVALID" });

		const from = desktopEvents.mark();
		await expect(pair(generateKeyPair(), () => false)).rejects.toBeInstanceOf(ChannelError);
		const resolved = await desktopEvents.waitForType("pairing.resolved", from);
		expect(resolved.event.resolution).toBe("rejected");
		expect((await desktop.request("device.list")).devices).toHaveLength(1);
	});

	it("expires an unanswered pairing request", async () => {
		await expect(pair(generateKeyPair(), () => undefined)).rejects.toMatchObject({ code: "PAIRING_TIMEOUT" });
		expect((await desktop.request("device.list")).devices).toHaveLength(0);
	});

	it("invalidates the pairing code after repeated wrong guesses", async () => {
		const { uri } = await desktop.request("pairing.start");
		const wrong = uri.replace(/code=[^&]+/, "code=guess");
		for (let i = 0; i < 5; i++) {
			await expect(pair(generateKeyPair(), () => undefined, wrong)).rejects.toMatchObject({
				code: "PAIRING_INVALID",
			});
		}
		expect((await desktop.request("remote.status")).pairingActive).toBe(false);
		await expect(pair(generateKeyPair(), () => true, uri)).rejects.toMatchObject({ code: "PAIRING_INVALID" });
	});

	it("renames devices and turns remote access off and on, persisting the setting", async () => {
		const outcome = await pair();
		const renamed = await desktop.request("device.rename", { deviceId: outcome.deviceId, name: "Work phone" });
		expect(renamed.device.name).toBe("Work phone");

		const phone = phoneClient(outcome);
		await phone.connect();
		const reconnecting = new Promise<void>((resolve) => phone.onState((s) => s === "reconnecting" && resolve()));
		const off = await desktop.request("remote.configure", { enabled: false });
		expect(off).toMatchObject({ enabled: false, running: false, addresses: [] });
		await reconnecting;
		const config = JSON.parse(readFileSync(join(t.root, "pier", "config.json"), "utf8"));
		expect(config.remote).toEqual({ enabled: false, port: 7433 });
		await expectCode(desktop.request("pairing.start"), "CONFLICT");

		// Turning it back on (the test pins port 0 → a new random port) lets new clients in again.
		const on = await desktop.request("remote.configure", { enabled: true });
		expect(on.running).toBe(true);
		phone.close();
		const back = phoneClient({ ...outcome, addresses: on.addresses });
		expect((await back.connect()).device?.name).toBe("Work phone");
		back.close();
	});
});
