import { platform } from "node:os";
import {
	createSecureSocketFactory,
	type P2POptions,
	PierClient,
	pairWithHost,
	type WebSocketFactory,
	type WebSocketLike,
} from "@pier/client";
import {
	ChannelError,
	CLOSE_CODES,
	equalBytes,
	fromBase64Url,
	type KeyPair,
	normalizeRelayUrl,
	PairingUriError,
	parsePairingUri,
	toBase64Url,
} from "@pier/crypto";
import { type HostInfo, type PeerInfo, type PierHostEvent, PierProtocolError, parseClientFrame } from "@pier/protocol";
import { WebSocket } from "ws";
import { createHostPeerConnection } from "../remote/p2p.ts";
import { type PeerRecord, PeerStore, toPeerInfo } from "./store.ts";

/** Close code for the desktop's proxied socket when the peer cannot be reached or dropped. */
export const CLOSE_PEER_UNREACHABLE = 4502;
/** Close code when the peer is not (or no longer) paired here. */
export const CLOSE_PEER_UNKNOWN = 4404;

/** Why `peer.pair` failed, in the error's `data.reason`. */
export type PeerPairFailure =
	| "SELF"
	| "INVALID_LINK"
	| "UNREACHABLE"
	| "PAIRING_INVALID"
	| "PAIRING_REJECTED"
	| "PAIRING_TIMEOUT"
	| "BAD_HANDSHAKE"
	| "UNAVAILABLE"
	| "UNKNOWN_DEVICE";

const MAX_PEER_PAYLOAD = 64 * 1024 * 1024;
/** Frames the desktop may send before the peer connection is up (it normally sends only `host.hello`). */
const MAX_PENDING_FRAMES = 256;

/** Outgoing sockets use `ws` (the same implementation as the listeners), without compression. */
const defaultFactory: WebSocketFactory = (url) =>
	new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_PEER_PAYLOAD }) as unknown as WebSocketLike;

/** WebSocket close reasons are limited to 123 bytes. */
function closeReason(text: string): string {
	if (Buffer.byteLength(text) <= 123) return text;
	let out = text;
	while (Buffer.byteLength(out) > 120) out = out.slice(0, -1);
	return `${out}…`;
}

/** Close codes a server may send; anything else (e.g. 1006 for "unreachable") is mapped. */
function forwardableCode(code: number | undefined): number {
	if (code === 1000 || code === 1001 || code === 1011 || code === 1013) return code;
	if (code !== undefined && code >= 3000 && code <= 4999) return code;
	return CLOSE_PEER_UNREACHABLE;
}

export interface PeerHooks {
	hostId(): string;
	hostName(): string;
	hostVersion(): string;
	/** This host's static key, used as the device key on peers. */
	identity(): KeyPair;
	verifyLocalToken(token: unknown): boolean;
	broadcastLocal(event: PierHostEvent): void;
	log(message: string): void;
	/** Whether connections through a relay may move to a peer-to-peer path (default on). */
	p2pEnabled?(): boolean;
}

export interface PeerManagerOptions {
	createWebSocket?: WebSocketFactory;
	/** Per-address open timeout (default 4 s). */
	openTimeoutMs?: number;
	/** Overall `peer.pair` limit including the other user's confirmation (default 3 minutes). */
	pairTimeoutMs?: number;
}

/** The desktop side of a proxied connection (a `ws` server socket on the local gateway). */
export interface ProxySocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "message", listener: (data: { toString(): string }, isBinary: boolean) => void): unknown;
	on(event: "close" | "error", listener: () => void): unknown;
}

/**
 * Computers this host paired with as a device (the "nodes" the desktop can switch to), and
 * the proxy that connects the desktop UI to them.
 *
 * Every computer runs a Pier Host with one static key. Pairing with another computer
 * registers that key there as a device, exactly like a phone; the desktop UI then talks to
 * the other computer through `ws://127.0.0.1:<port>/peer/<id>` on its own local gateway,
 * which runs the Noise IK channel so the key never leaves the host process. The other
 * computer treats the connection as a remote device (no local-only methods or events).
 */
export class PeerManager {
	private readonly store: PeerStore;
	/** Open proxied connections per peer (closers). */
	private readonly proxies = new Map<string, Set<(code: number, reason: string) => void>>();
	private stopped = false;

	constructor(
		path: string,
		private readonly hooks: PeerHooks,
		private readonly options: PeerManagerOptions = {},
	) {
		this.store = new PeerStore(path);
	}

	private get factory(): WebSocketFactory {
		return this.options.createWebSocket ?? defaultFactory;
	}

	private info(record: PeerRecord): PeerInfo {
		return toPeerInfo(record, (this.proxies.get(record.id)?.size ?? 0) > 0);
	}

	private changed(): void {
		this.hooks.broadcastLocal({ type: "peer.changed" });
	}

	/** Dedicated encrypted connection for browser traffic, separate from chat subscriptions. */
	async openClient(peerId: string): Promise<PierClient> {
		const record = this.store.get(peerId);
		if (!record || this.stopped) throw new PierProtocolError("NOT_FOUND", "Paired computer not found");
		const client = new PierClient({
			url: "pier-secure://browser",
			client: { name: "pier-browser", version: this.hooks.hostVersion() },
			reconnect: { enabled: false },
			heartbeatMs: 15_000,
			heartbeatTimeoutMs: 10_000,
			createWebSocket: createSecureSocketFactory({
				addresses: record.addresses,
				relays: record.relays,
				hostPublicKey: fromBase64Url(record.publicKey),
				deviceKeyPair: this.hooks.identity(),
				createWebSocket: this.factory,
				...(this.hooks.p2pEnabled?.() === false
					? {}
					: {
							p2p: {
								createPeerConnection: (config) => createHostPeerConnection(config.iceServers),
							},
						}),
			}),
		});
		const close = () => client.close();
		const set = this.proxies.get(peerId) ?? new Set();
		set.add(close);
		this.proxies.set(peerId, set);
		client.onState((state) => {
			if (state !== "closed") return;
			set.delete(close);
			if (!set.size) this.proxies.delete(peerId);
			this.changed();
		});
		try {
			const hello = await client.connect();
			this.connected(peerId, hello.host, undefined);
			this.changed();
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	}

	list(): PeerInfo[] {
		return this.store
			.list()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((p) => this.info(p));
	}

	get(id: string): PeerInfo | undefined {
		const record = this.store.get(id);
		return record ? this.info(record) : undefined;
	}

	/** Pair with another computer from its pairing link; resolves once its user allowed it. */
	async pair(uri: string): Promise<PeerInfo> {
		let info: ReturnType<typeof parsePairingUri>;
		try {
			info = parsePairingUri(uri);
		} catch (error) {
			const message = error instanceof PairingUriError ? error.message : "Malformed pairing link";
			throw new PierProtocolError("BAD_REQUEST", `Invalid pairing link: ${message}`, { reason: "INVALID_LINK" });
		}
		const identity = this.hooks.identity();
		if (info.hostId === this.hooks.hostId() || equalBytes(info.hostPublicKey, identity.publicKey)) {
			throw new PierProtocolError("CONFLICT", "This is this computer's own pairing link", { reason: "SELF" });
		}
		this.hooks.log(
			`pairing with computer ${info.hostName} (${[...info.addresses, ...(info.relays ?? []).map((r) => `relay ${r}`)].join(", ")})`,
		);
		let outcome: Awaited<ReturnType<typeof pairWithHost>>;
		try {
			outcome = await pairWithHost({
				info,
				deviceKeyPair: identity,
				device: { name: this.hooks.hostName(), platform: platform(), appVersion: this.hooks.hostVersion() },
				createWebSocket: this.factory,
				...(this.options.openTimeoutMs ? { openTimeoutMs: this.options.openTimeoutMs } : {}),
				...(this.options.pairTimeoutMs ? { timeoutMs: this.options.pairTimeoutMs } : {}),
			});
		} catch (error) {
			if (error instanceof ChannelError) {
				this.hooks.log(`pairing with ${info.hostName} failed: ${error.code}`);
				throw new PierProtocolError("CONFLICT", error.message, { reason: error.code });
			}
			const message = error instanceof Error ? error.message : String(error);
			this.hooks.log(`pairing with ${info.hostName} failed: ${message}`);
			throw new PierProtocolError("CONFLICT", message, { reason: "UNREACHABLE" });
		}
		if (this.stopped) throw new PierProtocolError("CONFLICT", "Host is shutting down");
		const existing = this.store.get(outcome.hostId);
		const record = this.store.put({
			id: outcome.hostId,
			name: outcome.hostName,
			publicKey: toBase64Url(outcome.hostPublicKey),
			addresses: outcome.addresses,
			...(outcome.relays.length ? { relays: outcome.relays } : {}),
			deviceId: outcome.deviceId,
			pairedAt: new Date().toISOString(),
			...(existing?.platform ? { platform: existing.platform } : {}),
			...(existing?.version ? { version: existing.version } : {}),
		});
		// A fresh pairing (e.g. after being revoked there) replaces the old channel.
		this.closeProxies(record.id, 1012, "Paired again");
		this.hooks.log(`paired with computer ${record.name} (${record.id})`);
		this.changed();
		return this.info(record);
	}

	/**
	 * Replace the addresses used to reach a paired computer (its IP changed, or it moved to
	 * another network). Open connections to it reconnect with the new addresses; the pinned
	 * host key still authenticates whoever answers there.
	 */
	update(id: string, addresses: string[], relays?: string[]): PeerInfo {
		const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
		let relayUrls: string[] | undefined;
		if (relays) {
			try {
				relayUrls = [
					...new Set(
						relays
							.map((r) => r.trim())
							.filter(Boolean)
							.map((r) => normalizeRelayUrl(r)),
					),
				];
			} catch (error) {
				throw new PierProtocolError("BAD_REQUEST", error instanceof Error ? error.message : "Invalid relay address");
			}
		}
		for (const address of unique) {
			const port = Number(address.slice(address.lastIndexOf(":") + 1));
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new PierProtocolError("BAD_REQUEST", `Invalid port in address ${address}`);
			}
		}
		const before = this.store.get(id);
		if (!before) throw new PierProtocolError("NOT_FOUND", "This computer is not paired here");
		const nextRelays = relayUrls ?? before.relays ?? [];
		if (!unique.length && !nextRelays.length) {
			throw new PierProtocolError("BAD_REQUEST", "At least one address or relay is required");
		}
		const record = this.store.update(id, { addresses: unique, relays: nextRelays });
		if (!record) throw new PierProtocolError("NOT_FOUND", "This computer is not paired here");
		if (before.addresses.join(",") !== unique.join(",") || (before.relays ?? []).join(",") !== nextRelays.join(",")) {
			this.hooks.log(
				`addresses of computer ${record.name} changed to ${[...unique, ...nextRelays.map((r) => `relay ${r}`)].join(", ")}`,
			);
			// Reconnect through the new addresses (the desktop client reconnects on 1012).
			this.closeProxies(id, 1012, "Addresses changed");
			this.changed();
		}
		return this.info(record);
	}

	remove(id: string): boolean {
		if (!this.store.remove(id)) return false;
		this.closeProxies(id, CLOSE_PEER_UNKNOWN, "Computer removed");
		this.hooks.log(`forgot computer ${id}`);
		this.changed();
		return true;
	}

	private closeProxies(id: string, code: number, reason: string): void {
		for (const close of [...(this.proxies.get(id) ?? [])]) close(code, reason);
	}

	shutdown(): void {
		this.stopped = true;
		for (const id of [...this.proxies.keys()]) this.closeProxies(id, 1001, "Host shutting down");
	}

	/** The peer answered `host.hello` through a proxy: remember its name, version and address. */
	private connected(id: string, host: HostInfo | undefined, address: string | undefined): void {
		const record = this.store.get(id);
		if (!record) return;
		const addresses =
			address && record.addresses.includes(address)
				? [address, ...record.addresses.filter((a) => a !== address)]
				: record.addresses;
		this.store.update(id, {
			addresses,
			lastConnectedAt: new Date().toISOString(),
			...(host?.hostName ? { name: host.hostName } : {}),
			...(host?.platform ? { platform: host.platform } : {}),
			...(host?.version ? { version: host.version } : {}),
		});
		this.changed();
	}

	/**
	 * Bridge a desktop socket (`/peer/<id>` on the local gateway) to the peer. The first frame
	 * must be `host.hello` with the local token, which is checked here and stripped before the
	 * hello is forwarded over the secure channel. After that frames pass through unchanged.
	 */
	attachProxy(socket: ProxySocket, peerId: string): void {
		let phase: "hello" | "connecting" | "open" | "closed" = "hello";
		let secure: WebSocketLike | undefined;
		let helloId: string | undefined;
		let registered = false;
		let address: string | undefined;
		const pending: string[] = [];

		const unregister = () => {
			if (!registered) return;
			registered = false;
			const set = this.proxies.get(peerId);
			set?.delete(closeFromHost);
			if (set && !set.size) {
				this.proxies.delete(peerId);
				this.changed();
			}
		};
		const closeLocal = (code: number, reason: string) => {
			if (phase === "closed") return;
			phase = "closed";
			unregister();
			try {
				socket.close(forwardableCode(code), closeReason(reason));
			} catch {
				// Already closed.
			}
		};
		const closeSecure = () => {
			const s = secure;
			secure = undefined;
			if (!s) return;
			s.onopen = null;
			s.onmessage = null;
			s.onclose = null;
			s.onerror = null;
			try {
				s.close(1000, "Desktop disconnected");
			} catch {
				// Ignore.
			}
		};
		function closeFromHost(code: number, reason: string) {
			closeSecure();
			closeLocal(code, reason);
		}
		const refuse = (id: string, code: "UNAUTHENTICATED" | "NOT_FOUND", message: string, closeCode: number) => {
			try {
				socket.send(
					JSON.stringify({ type: "res", id, ok: false, error: new PierProtocolError(code, message).toJSON() }),
				);
			} catch {
				// Ignore.
			}
			closeLocal(closeCode, code);
		};

		const onPeerFrame = (text: string) => {
			if (helloId !== undefined && text.includes(helloId)) {
				try {
					const frame = JSON.parse(text) as {
						type?: string;
						id?: string;
						ok?: boolean;
						result?: { host?: HostInfo };
					};
					if (frame.type === "res" && frame.id === helloId) {
						helloId = undefined;
						if (frame.ok) this.connected(peerId, frame.result?.host, address);
					}
				} catch {
					// Not JSON; the desktop reports it.
				}
			}
			try {
				socket.send(text);
			} catch {
				closeFromHost(1011, "Send failed");
			}
		};

		const start = (hello: string) => {
			const record = this.store.get(peerId);
			if (!record) return;
			phase = "connecting";
			pending.push(hello);
			const set = this.proxies.get(peerId) ?? new Set();
			const first = !set.size;
			set.add(closeFromHost);
			this.proxies.set(peerId, set);
			registered = true;
			if (first) this.changed();
			const p2p: P2POptions | undefined =
				this.hooks.p2pEnabled?.() === false
					? undefined
					: {
							createPeerConnection: (config) => createHostPeerConnection(config.iceServers),
							log: (message) => this.hooks.log(`computer ${record.name}: ${message}`),
						};
			const open = createSecureSocketFactory({
				addresses: record.addresses,
				...(record.relays?.length ? { relays: record.relays } : {}),
				...(p2p ? { p2p } : {}),
				hostPublicKey: fromBase64Url(record.publicKey),
				deviceKeyPair: this.hooks.identity(),
				createWebSocket: this.factory,
				...(this.options.openTimeoutMs ? { openTimeoutMs: this.options.openTimeoutMs } : {}),
				onConnected: (a) => {
					address = a;
				},
			});
			const s = open("");
			secure = s;
			s.onopen = () => {
				if (secure !== s) return;
				phase = "open";
				for (const frame of pending.splice(0)) s.send(frame);
			};
			s.onmessage = (event) => {
				if (secure === s) onPeerFrame(String(event.data));
			};
			s.onerror = () => {};
			s.onclose = (event) => {
				if (secure !== s) return;
				secure = undefined;
				const reason = event.reason ?? "";
				if (event.code === CLOSE_CODES.deviceRevoked) {
					this.hooks.log(`computer ${record.name} no longer accepts this one (${reason || "revoked"})`);
				}
				closeLocal(event.code ?? CLOSE_PEER_UNREACHABLE, reason || "Connection to the computer was lost");
			};
		};

		socket.on("message", (data, isBinary) => {
			if (phase === "closed") return;
			if (isBinary) {
				closeFromHost(1003, "Binary frames are not supported");
				return;
			}
			const text = data.toString();
			if (phase === "open") {
				try {
					secure?.send(text);
				} catch {
					closeFromHost(CLOSE_PEER_UNREACHABLE, "Connection to the computer was lost");
				}
				return;
			}
			if (phase === "connecting") {
				if (pending.length >= MAX_PENDING_FRAMES) closeFromHost(1013, "Too many frames before the connection opened");
				else pending.push(text);
				return;
			}
			// phase === "hello"
			const frame = parseClientFrame(text);
			if (frame?.method !== "host.hello") {
				refuse(frame?.id ?? "", "UNAUTHENTICATED", "Call host.hello first", 4401);
				return;
			}
			const params = (frame.params ?? {}) as Record<string, unknown>;
			if (!this.hooks.verifyLocalToken(params.token)) {
				refuse(frame.id, "UNAUTHENTICATED", "Invalid local token", 4401);
				return;
			}
			if (this.stopped || !this.store.get(peerId)) {
				refuse(frame.id, "NOT_FOUND", "This computer is not paired here", CLOSE_PEER_UNKNOWN);
				return;
			}
			const { token: _token, ...forwarded } = params;
			helloId = frame.id;
			start(JSON.stringify({ ...frame, params: forwarded }));
		});
		const onGone = () => {
			phase = "closed";
			unregister();
			closeSecure();
		};
		socket.on("close", onGone);
		socket.on("error", onGone);
	}
}
