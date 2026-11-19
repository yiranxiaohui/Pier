import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLOSE_DEVICE_REVOKED, PierClient, type WebSocketLike } from "@pier/client";
import { formatPairingUri, keyFingerprint } from "@pier/crypto";
import type { EventFrame, PairingRequest, PeerInfo, SessionSnapshot, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CLOSE_PEER_UNKNOWN, CLOSE_PEER_UNREACHABLE } from "../src/peers/peers.ts";
import { fauxAssistantMessage, Recorder, startTestHost, type TestHost, TOKEN } from "./helpers.ts";

const REMOTE = { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } as const;

async function expectCode(promise: Promise<unknown>, code: string): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		expect((error as { code?: string }).code).toBe(code);
		return error;
	}
	throw new Error(`Expected ${code}`);
}

describe("computer-to-computer (peers)", () => {
	/** The computer the user sits at. */
	let a: TestHost;
	/** The computer it connects to. */
	let b: TestHost;
	let aDesktop: PierClient;
	let bDesktop: PierClient;
	let aEvents: Recorder;
	let bEvents: Recorder;
	let bWorkspace: WorkspaceInfo;
	const extra: PierClient[] = [];
	/** Sizes of the frames A received from other computers (the encrypted channel). */
	let aReceived: number[] = [];

	beforeEach(async () => {
		aReceived = [];
		[a, b] = await Promise.all([
			startTestHost({
				peers: {
					openTimeoutMs: 1000,
					createWebSocket: (url) => {
						const socket = new WebSocket(url, { perMessageDeflate: false });
						socket.on("message", (data: Buffer) => aReceived.push(data.length));
						return socket as unknown as WebSocketLike;
					},
				},
			}),
			startTestHost({ remote: { ...REMOTE, approvalTimeoutMs: 2000 } }),
		]);
		aDesktop = await a.connect();
		bDesktop = await b.connect();
		aEvents = new Recorder();
		bEvents = new Recorder();
		aDesktop.onEvent(aEvents.handler);
		bDesktop.onEvent(bEvents.handler);
		bWorkspace = (await bDesktop.request("workspace.add", { path: b.workspaceDir })).workspace;
	});
	afterEach(async () => {
		for (const client of extra.splice(0)) client.close();
		await Promise.all([a.close(), b.close()]);
	});

	/** Pair A with B, answering B's confirmation dialog with `accept`. */
	async function pair(accept: boolean | undefined = true): Promise<PeerInfo> {
		const { uri } = await bDesktop.request("pairing.start");
		const from = bEvents.mark();
		void bEvents
			.waitForType("pairing.request", from)
			.then((frame) => {
				const request = frame.event.request as PairingRequest;
				if (accept !== undefined) return bDesktop.request("pairing.respond", { requestId: request.id, accept });
			})
			.catch(() => undefined);
		return (await aDesktop.request("peer.pair", { uri }, { timeoutMs: 10_000 })).peer;
	}

	/** A desktop client of A that talks to B through A's local gateway. */
	function viaA(peerId: string, token = TOKEN): PierClient {
		const client = new PierClient({
			url: `${a.url}/peer/${encodeURIComponent(peerId)}`,
			token,
			client: { name: "pier-desktop", version: "0.0.0" },
			reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
		});
		extra.push(client);
		return client;
	}

	it("transfers a file in an unregistered directory of the paired host", async () => {
		const peer = await pair();
		const client = viaA(peer.id);
		await client.connect();
		const directory = join(b.root, "incoming");
		mkdirSync(directory);
		const path = "payload.bin";
		const bytes = Buffer.from([0, 255, 128, 42]);
		const started = await client.request("host.uploadStart", { directory, path, size: bytes.length });
		await client.request("workspace.uploadChunk", {
			uploadId: started.uploadId,
			offset: 0,
			data: bytes.toString("base64"),
		});
		await client.request("workspace.uploadFinish", { uploadId: started.uploadId });
		expect(await client.request("host.files", { directory })).toMatchObject({
			directory,
			parent: b.root,
			entries: [{ name: path, kind: "file", size: 4 }],
		});
		expect(await client.request("host.readBytes", { directory, path, offset: 1, length: 3 })).toMatchObject({
			eof: true,
			data: bytes.subarray(1).toString("base64"),
		});
		await expectCode(client.request("host.uploadStart", { directory, path, size: 1 }), "CONFLICT");
		await expectCode(client.request("host.files", { directory: "relative" }), "BAD_REQUEST");
		await expectCode(
			client.request("host.readBytes", { directory, path: "../payload.bin", offset: 0, length: 1 }),
			"BAD_REQUEST",
		);
		expect((await client.request("workspace.list")).workspaces).toEqual([bWorkspace]);
	});

	it("manages files in unregistered directories of the paired host", async () => {
		const peer = await pair();
		const client = viaA(peer.id);
		await client.connect();
		const directory = join(b.root, "manage");
		const other = join(b.root, "other");
		mkdirSync(directory);
		mkdirSync(other);
		expect(await client.request("host.createDirectory", { directory, path: "docs/notes" })).toEqual({
			path: "docs/notes",
		});
		const created = await client.request("host.createFile", { directory, path: "docs/notes/todo.md" });
		expect(created).toMatchObject({ path: "docs/notes/todo.md", size: 0 });
		await expectCode(client.request("host.createFile", { directory, path: "docs/notes/todo.md" }), "CONFLICT");
		const written = await client.request("host.writeFile", {
			directory,
			path: "docs/notes/todo.md",
			text: "# todo\n",
			expectedModifiedAt: created.modifiedAt,
		});
		expect(written.size).toBe(7);
		expect(
			await client.request("host.readFile", { directory: join(directory, "docs"), path: "notes/todo.md" }),
		).toMatchObject({ kind: "text", text: "# todo\n" });
		expect(
			await client.request("host.transferPath", {
				directory: join(directory, "docs", "notes"),
				path: "todo.md",
				destinationDirectory: other,
				destinationPath: "copy.md",
				mode: "copy",
			}),
		).toEqual({ sourcePath: "todo.md", path: "copy.md", kind: "file" });
		await client.request("host.transferPath", {
			directory,
			path: "docs",
			destinationDirectory: directory,
			destinationPath: "renamed",
			mode: "move",
		});
		expect(readFileSync(join(directory, "renamed", "notes", "todo.md"), "utf8")).toBe("# todo\n");
		expect(readFileSync(join(other, "copy.md"), "utf8")).toBe("# todo\n");
		expect(await client.request("host.deletePath", { directory, path: "renamed" })).toEqual({
			path: "renamed",
			kind: "directory",
		});
		expect(existsSync(join(directory, "renamed"))).toBe(false);
		await expectCode(client.request("host.deletePath", { directory, path: "../other" }), "BAD_REQUEST");
		await expectCode(client.request("host.deletePath", { directory, path: "." }), "BAD_REQUEST");
		await expectCode(client.request("host.createFile", { directory: "relative", path: "a" }), "BAD_REQUEST");
		expect(existsSync(other)).toBe(true);
		// A host directory is no boundary: links to other directories open like any other entry.
		symlinkSync(other, join(directory, "linked"));
		symlinkSync(join(other, "copy.md"), join(directory, "linked.md"));
		expect((await client.request("host.files", { directory })).entries).toEqual([
			expect.objectContaining({ name: "linked", path: "linked", kind: "directory", symlink: true }),
			expect.objectContaining({ name: "linked.md", path: "linked.md", kind: "file", symlink: true }),
		]);
		expect(await client.request("host.readFile", { directory, path: "linked.md" })).toMatchObject({
			path: "linked.md",
			text: "# todo\n",
		});
		expect(
			await client.request("host.readBytes", { directory, path: "linked/copy.md", offset: 0, length: 2 }),
		).toMatchObject({ path: "linked/copy.md", data: Buffer.from("# ").toString("base64") });
		expect(await client.request("host.deletePath", { directory, path: "linked" })).toEqual({
			path: "linked",
			kind: "other",
		});
		expect(existsSync(join(other, "copy.md"))).toBe(true);
	});

	it("pairs with the host key, then drives the other computer through the local gateway", async () => {
		const from = aEvents.mark();
		let request: PairingRequest | undefined;
		const pairing = bEvents.waitForType("pairing.request").then((f) => {
			request = f.event.request as PairingRequest;
		});
		const peer = await pair();
		await pairing;
		// B sees A's host key (the same fingerprint A shows as its own) and its name and OS.
		expect(request).toMatchObject({
			device: { name: a.host.info().hostName, platform: process.platform },
			fingerprint: keyFingerprint(a.host.remote.identity.publicKey),
		});
		expect(peer).toMatchObject({
			id: b.host.info().hostId,
			name: b.host.info().hostName,
			fingerprint: keyFingerprint(b.host.remote.identity.publicKey),
			connected: false,
		});
		await aEvents.waitForType("peer.changed", from);
		expect((await aDesktop.request("peer.list")).peers).toEqual([peer]);
		const devices = (await bDesktop.request("device.list")).devices;
		expect(devices).toEqual([expect.objectContaining({ id: peer.deviceId, platform: process.platform })]);

		const remote = viaA(peer.id);
		const hello = await remote.connect();
		expect(hello.host.hostId).toBe(b.host.info().hostId);
		expect(hello.device).toEqual({ id: peer.deviceId, name: a.host.info().hostName });
		expect((await bDesktop.request("device.list")).devices[0]?.connected).toBe(true);
		const listed = (await aDesktop.request("peer.list")).peers[0];
		expect(listed).toMatchObject({ connected: true, version: b.host.info().version, platform: process.platform });
		expect(listed?.lastConnectedAt).toBeDefined();

		// A paired computer manages B's workspaces, but not who can reach B.
		expect((await remote.request("workspace.list")).workspaces.map((w) => w.id)).toEqual([bWorkspace.id]);
		expect((await remote.request("workspace.add", { path: b.workspaceDir })).workspace.id).toBe(bWorkspace.id);
		expect((await remote.request("host.listDirectories")).path).toBeTruthy();
		// Other computers can see B's resource usage (the status bar's host status).
		expect((await remote.request("host.stats")).memory.total).toBeGreaterThan(0);
		await expectCode(remote.request("pairing.start"), "FORBIDDEN");
		await expectCode(remote.request("peer.remove", { peerId: "unrelated" }), "FORBIDDEN");
		// Remote settings inspect B (not the proxying local host A); access controls stay local.
		expect(await remote.request("peer.list")).toEqual({ peers: [] });
		expect(await remote.request("remote.status")).toEqual(await bDesktop.request("remote.status"));
		expect(await remote.request("device.list")).toEqual(await bDesktop.request("device.list"));
		a.host.recordLog("only-on-local-computer-A");
		b.host.recordLog("only-on-selected-computer-B");
		const logs = (await remote.request("host.logs")).lines;
		expect(logs).toContain("only-on-selected-computer-B");
		expect(logs).not.toContain("only-on-local-computer-A");

		b.faux.setResponses([fauxAssistantMessage("answered by computer B")]);
		const { session } = await remote.request("session.create", { workspaceId: bWorkspace.id });
		const rec = new Recorder();
		await remote.subscribe(session.id, rec.handler, { workspaceId: bWorkspace.id });
		await rec.waitForType("session.snapshot");
		await remote.request("session.prompt", { sessionId: session.id, text: "hello from A" });
		await rec.waitForType("agent_settled");
		expect(rec.text()).toBe("answered by computer B");
		// The session lives on B, not on A.
		expect((await bDesktop.request("session.list", { workspaceId: bWorkspace.id })).sessions[0]?.id).toBe(session.id);

		// B's local-only events do not reach A's window.
		const seen: string[] = [];
		remote.onEvent((frame: EventFrame) => seen.push(frame.event.type));
		await bDesktop.request("pairing.start");
		await bDesktop.request("pairing.cancel");
		await remote.request("host.info");
		expect(seen.filter((t) => t.startsWith("pairing.") || t.startsWith("remote."))).toEqual([]);

		remote.close();
		await aEvents.waitFor((f) => f.event.type === "peer.changed", aEvents.mark());
		expect((await aDesktop.request("peer.list")).peers[0]?.connected).toBe(false);
	});

	it("receives large frames from the other computer compressed", async () => {
		const answer = Array.from({ length: 400 }, (_, i) => `Line ${i}: the session transcript repeats itself.`).join(
			"\n",
		);
		b.faux.setResponses([fauxAssistantMessage(answer)]);
		const { session } = await bDesktop.request("session.create", { workspaceId: bWorkspace.id });
		const run = new Recorder();
		await bDesktop.subscribe(session.id, run.handler);
		await bDesktop.request("session.prompt", { sessionId: session.id, text: "long answer" });
		await run.waitForType("agent_settled");

		const remote = viaA((await pair()).id);
		await remote.connect();
		const rec = new Recorder();
		await remote.subscribe(session.id, rec.handler);
		const snapshot = (await rec.waitForType("session.snapshot")).event.snapshot as SessionSnapshot;
		expect(snapshot.messages).toEqual((await bDesktop.request("session.snapshot", { sessionId: session.id })).messages);
		const size = JSON.stringify(snapshot).length;
		expect(size).toBeGreaterThan(answer.length);
		// Uncompressed, the snapshot alone would take more than `size` (base64 adds a third).
		expect(Math.max(...aReceived)).toBeLessThan(size / 3);
	});

	it("creates files and empty folders on the peer through the local desktop gateway", async () => {
		const aWorkspace = (await aDesktop.request("workspace.add", { path: a.workspaceDir })).workspace;
		const remote = viaA((await pair()).id);
		await remote.connect();
		expect(
			await remote.request("workspace.createFile", { workspaceId: bWorkspace.id, path: "new/note.md" }),
		).toMatchObject({ path: "new/note.md", size: 0 });
		expect(
			await remote.request("workspace.createDirectory", { workspaceId: bWorkspace.id, path: "new/empty" }),
		).toEqual({ path: "new/empty" });
		expect(readFileSync(join(b.workspaceDir, "new", "note.md"), "utf8")).toBe("");
		expect(
			(await bDesktop.request("workspace.files", { workspaceId: bWorkspace.id, path: "new/empty" })).entries,
		).toEqual([]);
		expect(
			(await aDesktop.request("workspace.files", { workspaceId: aWorkspace.id })).entries.some(
				(entry) => entry.name === "new",
			),
		).toBe(false);
		await expectCode(
			remote.request("workspace.createFile", { workspaceId: bWorkspace.id, path: "new/note.md" }),
			"CONFLICT",
		);
		remote.close();
	});

	it("previews a confirmed artifact outside the remote workspace once through the local gateway", async () => {
		const outside = mkdtempSync(join(homedir(), ".pier-peer-preview-test-"));
		try {
			const directory = join(outside, "artifacts", "Pier", "sidebar-navigation");
			mkdirSync(directory, { recursive: true });
			const path = join(directory, "light.png");
			const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=";
			writeFileSync(path, Buffer.from(png, "base64"));
			const otherPath = join(directory, "other.txt");
			writeFileSync(otherPath, "ARTIFACT-CONTENT-MUST-NOT-BE-AUDITED");
			const remote = viaA((await pair()).id);
			await remote.connect();
			const params = { workspaceId: bWorkspace.id, path };
			const denied = await expectCode(remote.request("workspace.previewFile", params), "FORBIDDEN");
			const expectedRealPath = realpathSync(path);
			expect(denied).toMatchObject({ data: { reason: "OUTSIDE_ALLOWED_ROOTS", resolvedPath: expectedRealPath } });
			expect(await remote.request("workspace.authorizeFilePreview", { ...params, expectedRealPath })).toMatchObject({
				path,
				kind: "image",
				mimeType: "image/png",
				data: png,
			});
			// Confirming one target must neither authorize a different target nor persist access.
			await expectCode(
				remote.request("workspace.authorizeFilePreview", { ...params, path: otherPath, expectedRealPath }),
				"CONFLICT",
			);
			for (const client of [remote, bDesktop]) {
				await expectCode(client.request("workspace.previewFile", params), "FORBIDDEN");
				await expectCode(client.request("workspace.previewFile", { ...params, path: otherPath }), "FORBIDDEN");
				await expectCode(client.request("workspace.readFile", params), "BAD_REQUEST");
			}
			await remote.request("workspace.authorizeFilePreview", {
				...params,
				path: otherPath,
				expectedRealPath: realpathSync(otherPath),
			});
			const audit = readFileSync(join(b.root, "pier", "audit.log"), "utf8");
			const entries = audit
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			expect(entries).toContainEqual(
				expect.objectContaining({
					event: "workspace.authorizeFilePreview",
					detail: { workspaceId: bWorkspace.id, path, expectedRealPath },
				}),
			);
			expect(audit).not.toContain(png);
			expect(audit).not.toContain("ARTIFACT-CONTENT-MUST-NOT-BE-AUDITED");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("checks the local token before connecting and never forwards it", async () => {
		const peer = await pair();
		await expectCode(viaA(peer.id, "wrong-token-0123456789").connect(), "UNAUTHENTICATED");
		expect((await bDesktop.request("device.list")).devices[0]?.connected).toBe(false);
		await expectCode(viaA("no-such-computer").connect(), "NOT_FOUND");

		// B would reject a local token anyway, but it must not even see it.
		const remote = viaA(peer.id);
		await remote.connect();
		expect(remote.helloResult?.device).toBeDefined();
	});

	it("refuses its own link and reports declined pairing", async () => {
		const own = formatPairingUri({
			hostId: a.host.info().hostId,
			hostName: a.host.info().hostName,
			hostPublicKey: a.host.remote.identity.publicKey,
			addresses: ["127.0.0.1:9"],
			code: "unused",
		});
		const error = await expectCode(aDesktop.request("peer.pair", { uri: own }), "CONFLICT");
		expect((error as { data?: { reason?: string } }).data?.reason).toBe("SELF");
		await expectCode(aDesktop.request("peer.pair", { uri: "pier://nope" }), "BAD_REQUEST");

		const declined = await expectCode(pair(false), "CONFLICT");
		expect((declined as { data?: { reason?: string } }).data?.reason).toBe("PAIRING_REJECTED");
		expect((await aDesktop.request("peer.list")).peers).toEqual([]);
	});

	it("stops reconnecting once the other computer removed this one", async () => {
		const peer = await pair();
		const remote = viaA(peer.id);
		await remote.connect();
		const closed = new Promise<void>((resolve) => remote.onState((s) => s === "closed" && resolve()));
		await bDesktop.request("device.revoke", { deviceId: peer.deviceId });
		await closed;
		expect(remote.terminalClose?.code).toBe(CLOSE_DEVICE_REVOKED);

		// New attempts are refused during the handshake, and A still lists the peer.
		const again = viaA(peer.id);
		await expect(again.connect()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
		expect(again.terminalClose?.code).toBe(CLOSE_DEVICE_REVOKED);
		expect((await aDesktop.request("peer.list")).peers).toHaveLength(1);

		// Pairing again fixes it; the device id on B changes because B forgot the key.
		const repaired = await pair();
		await viaA(repaired.id).connect();
	});

	it("reports an unreachable computer and reconnects when it is back", async () => {
		const peer = await pair();
		const remote = viaA(peer.id);
		await remote.connect();
		const reconnecting = new Promise<void>((resolve) => remote.onState((s) => s === "reconnecting" && resolve()));
		await bDesktop.request("remote.configure", { enabled: false });
		await reconnecting;

		const offline = viaA(peer.id);
		const error = await offline.connect().then(
			() => undefined,
			(e: Error) => e,
		);
		expect(error?.message).toMatch(/Could not connect|closed/);

		const port = Number(peer.addresses[0]?.split(":").pop());
		const reopened = new Promise<void>((resolve) => remote.onState((s) => s === "open" && resolve()));
		await bDesktop.request("remote.configure", { enabled: true, port });
		await reopened;
		expect((await remote.request("workspace.list")).workspaces).toHaveLength(1);
		expect(CLOSE_PEER_UNREACHABLE).toBe(4502);
	});

	it("updates the addresses of a computer whose IP changed and reconnects through them", async () => {
		const peer = await pair();
		const port = Number(peer.addresses[0]?.split(":").pop());
		const remote = viaA(peer.id);
		await remote.connect();

		// Simulate a stale address: the computer is no longer reachable there.
		await aDesktop.request("peer.update", { peerId: peer.id, addresses: ["127.0.0.1:1"] });
		const stale = viaA(peer.id);
		await expect(stale.connect()).rejects.toThrow();
		stale.close();

		const reopened = new Promise<void>((resolve) => remote.onState((s) => s === "open" && resolve()));
		const { peer: updated } = await aDesktop.request("peer.update", {
			peerId: peer.id,
			addresses: [" 127.0.0.1:1 ", `127.0.0.1:${port}`, `127.0.0.1:${port}`],
		});
		expect(updated.addresses).toEqual(["127.0.0.1:1", `127.0.0.1:${port}`]);
		await reopened;
		expect((await remote.request("workspace.list")).workspaces).toHaveLength(1);
		// The address that worked moves to the front.
		const [listed] = (await aDesktop.request("peer.list")).peers;
		expect(listed?.addresses[0]).toBe(`127.0.0.1:${port}`);

		await expectCode(aDesktop.request("peer.update", { peerId: peer.id, addresses: ["no-port"] }), "BAD_REQUEST");
		await expectCode(aDesktop.request("peer.update", { peerId: peer.id, addresses: ["h:70000"] }), "BAD_REQUEST");
		await expectCode(aDesktop.request("peer.update", { peerId: "nope", addresses: ["h:1"] }), "NOT_FOUND");
		remote.close();
	});

	it("closes proxied connections when the computer is removed here", async () => {
		const peer = await pair();
		const remote = viaA(peer.id);
		await remote.connect();
		const reconnecting = new Promise<void>((resolve) => remote.onState((s) => s !== "open" && resolve()));
		expect(await aDesktop.request("peer.remove", { peerId: peer.id })).toEqual({ removed: true });
		await reconnecting;
		expect((await aDesktop.request("peer.list")).peers).toEqual([]);
		const gone = viaA(peer.id);
		await expectCode(gone.connect(), "NOT_FOUND");
		expect(CLOSE_PEER_UNKNOWN).toBe(4404);
		remote.close();
	});
});
