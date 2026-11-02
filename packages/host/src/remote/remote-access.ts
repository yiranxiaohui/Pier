import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dataChannelPath, type RtcDataChannelLike, type RtcPeerConnectionLike } from "@pier/client";
import {
	CAP_CONTROL,
	ChannelError,
	ChannelResponder,
	CLOSE_CODES,
	type ConnectHello,
	type ControlMessage,
	equalBytes,
	errorFrame,
	formatPairingUri,
	type KeyPair,
	keyFingerprint,
	normalizeRelayUrl,
	type PairRequest,
	type PairResult,
	RelayUrlError,
	randomBytes,
	SecureSession,
	type SecureTransport,
	type SessionPath,
	toBase64Url,
	utf8Encode,
} from "@pier/crypto";
import {
	type ConnectionRouteKind,
	type DeviceInfo,
	type PairingRequest,
	type PairingResolution,
	type PierHostEvent,
	PierProtocolError,
	PROTOCOL_VERSION,
	type RelayStatus,
	type RemoteAccessStatus,
} from "@pier/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { ConfigStore, RelayConfig } from "../config.ts";
import type { Connection, RemoteDevice, Transport } from "../connection.ts";
import { auditLogPath, devicesPath, identityPath } from "../paths.ts";
import { advertiseMdns, listLanAddresses, type MdnsAdvertisement } from "./network.ts";
import { answerOffer, type P2PAnswer, watchPeerConnection } from "./p2p.ts";
import { RelayClient } from "./relay-client.ts";
import { type AuditEntry, AuditLog, DeviceStore, loadOrCreateIdentity, toDeviceInfo } from "./store.ts";

export interface RemoteAccessOptions {
	/** Force remote access on/off for this run without touching the saved setting. */
	enabled?: boolean;
	/** Override the configured port for this run (0 picks a free port). */
	port?: number;
	/** Interface to bind (default: all interfaces, IPv4 and IPv6). */
	bindHost?: string;
	/** Addresses to put into pairing codes instead of the detected LAN addresses. */
	advertiseAddresses?: string[];
	/** Advertise `_pier._tcp` over mDNS while listening (default true). */
	mdns?: boolean;
	/** Use this relay for this run instead of the saved setting (`token` for private relays). */
	relay?: { url: string; token?: string };
	/** Turn peer-to-peer paths on/off for this run. */
	p2p?: boolean;
	/** How long a pairing code stays valid (default 5 minutes). */
	pairingTtlMs?: number;
	/** How long a pairing request waits for the desktop user (default 2 minutes). */
	approvalTimeoutMs?: number;
	/** Handshake must complete within this time (default 10 s). */
	handshakeTimeoutMs?: number;
	/** Ping interval used to detect dead remote connections (default 30 s). */
	heartbeatMs?: number;
	/** Wrong pairing codes tolerated before the active code is invalidated (default 5). */
	maxPairingFailures?: number;
}

export interface RemoteHostHooks {
	hostId(): string;
	hostName(): string;
	/** Create a protocol connection for an authenticated device. */
	connect(transport: Transport, device: RemoteDevice): Connection;
	broadcastLocal(event: PierHostEvent): void;
	remoteConnections(): Connection[];
	log(message: string): void;
}

/** Concurrent unauthenticated handshakes allowed before new sockets are refused. */
const MAX_PENDING_HANDSHAKES = 32;
const MAX_REMOTE_PAYLOAD = 64 * 1024 * 1024;
/** Peer-to-peer setups in progress at once (each runs ICE and DTLS). */
const MAX_P2P_SETUPS = 8;
/** How long the device has to open the data channel after the answer. */
const P2P_SETUP_TIMEOUT_MS = 30_000;

interface ActivePairing {
	code: string;
	expiresAt: number;
	failures: number;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
	request: PairingRequest;
	resolve(resolution: PairingResolution): void;
}

interface Listener {
	wss: WebSocketServer;
	port: number;
	heartbeat: ReturnType<typeof setInterval>;
	mdns?: MdnsAdvertisement;
}

/** How a device socket reached the host. */
interface Origin {
	via: "lan" | "relay";
	/** The device's network address (for a relay: as the relay saw it). */
	address?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
	return equalBytes(utf8Encode(a), utf8Encode(b));
}

function wsPath(socket: WebSocket): SessionPath {
	return {
		send: (frame) => socket.send(frame),
		close: (code, reason) => socket.close(code, reason),
		get bufferedAmount() {
			return socket.bufferedAmount;
		},
	};
}

/**
 * Remote access: the encrypted LAN listener, the Pier Relay registration, peer-to-peer
 * paths, pairing, the device registry and the audit log. Local connections manage it
 * through the `remote.*`, `pairing.*` and `device.*` methods; remote devices only ever see
 * an authenticated protocol connection.
 */
export class RemoteAccess {
	readonly identity: KeyPair;
	readonly devices: DeviceStore;
	readonly audit: AuditLog;
	private listener: Listener | undefined;
	private lastError: string | undefined;
	private relayClient: RelayClient | undefined;
	private pairing: ActivePairing | undefined;
	private readonly approvals = new Map<string, PendingApproval>();
	private readonly live = new Set<LiveSession>();
	private pendingHandshakes = 0;
	private p2pSetups = 0;
	private enabledOverride: boolean | undefined;
	private portOverride: number | undefined;
	private relayOverride: { url: string; token?: string } | undefined;
	private p2pOverride: boolean | undefined;
	private transition: Promise<void> = Promise.resolve();
	private stopped = false;

	constructor(
		pierDir: string,
		private readonly config: ConfigStore,
		private readonly hooks: RemoteHostHooks,
		private readonly options: RemoteAccessOptions = {},
	) {
		this.identity = loadOrCreateIdentity(identityPath(pierDir));
		this.devices = new DeviceStore(devicesPath(pierDir));
		this.audit = new AuditLog(auditLogPath(pierDir));
		this.enabledOverride = options.enabled;
		this.portOverride = options.port;
		this.p2pOverride = options.p2p;
		if (options.relay) {
			this.relayOverride = { ...options.relay, url: normalizeRelayUrl(options.relay.url) };
		}
	}

	get enabled(): boolean {
		return this.enabledOverride ?? this.config.remote.enabled;
	}

	get running(): boolean {
		return this.listener !== undefined;
	}

	private get desiredPort(): number {
		return this.portOverride ?? this.config.remote.port;
	}

	/** The relay to register with, if any. */
	private get desiredRelay(): { url: string; token?: string } | undefined {
		if (this.relayOverride) return this.relayOverride;
		const relay = this.config.remote.relay;
		return relay?.enabled && relay.url ? { url: relay.url, ...(relay.token ? { token: relay.token } : {}) } : undefined;
	}

	/** The relay this host registers with, if any (offered to computers added over SSH). */
	relaySettings(): { url: string; token?: string } | undefined {
		const relay = this.desiredRelay;
		return relay ? { ...relay } : undefined;
	}

	get p2pEnabled(): boolean {
		return this.p2pOverride ?? this.config.remote.p2p ?? true;
	}

	/** ICE servers already supplied by the configured relay; no implicit third-party TURN. */
	browserIceServers() {
		return this.relayClient?.iceServers ?? [];
	}

	/** Whether devices can reach the host at all right now (LAN listener or relay). */
	private get reachable(): boolean {
		return this.running || this.relayClient?.state === "online";
	}

	addresses(): string[] {
		if (this.options.advertiseAddresses?.length) return [...this.options.advertiseAddresses];
		const port = this.listener?.port ?? this.desiredPort;
		if (this.options.bindHost && this.options.bindHost !== "0.0.0.0" && this.options.bindHost !== "::") {
			return [
				this.options.bindHost.includes(":") ? `[${this.options.bindHost}]:${port}` : `${this.options.bindHost}:${port}`,
			];
		}
		return listLanAddresses(port);
	}

	private relayStatus(): RelayStatus {
		const saved: Partial<RelayConfig> = this.config.remote.relay ?? {};
		const desired = this.desiredRelay;
		const client = this.relayClient;
		const url = desired?.url ?? (saved.url || undefined);
		return {
			enabled: desired !== undefined,
			...(url ? { url } : {}),
			hasToken: Boolean(desired?.token ?? saved.token),
			state: client?.state ?? "off",
			...(client?.error && client.state !== "online" ? { error: client.error } : {}),
			...(client?.mode && client.state === "online" ? { mode: client.mode } : {}),
		};
	}

	status(): RemoteAccessStatus {
		const pairingActive = this.pairing !== undefined && this.pairing.expiresAt > Date.now();
		return {
			enabled: this.enabled,
			port: this.listener?.port ?? this.desiredPort,
			running: this.running,
			addresses: this.running ? this.addresses() : [],
			hostFingerprint: keyFingerprint(this.identity.publicKey),
			mdns: this.listener?.mdns !== undefined,
			...(this.lastError && this.enabled && !this.running ? { error: this.lastError } : {}),
			pairingActive,
			relay: this.relayStatus(),
			p2p: this.p2pEnabled,
		};
	}

	private emitStatus(): void {
		this.hooks.broadcastLocal({ type: "remote.changed", status: this.status() });
	}

	/** Start or stop the listener and the relay registration to match the settings. Serialized. */
	apply(): Promise<void> {
		const run = this.transition.then(async () => {
			if (this.stopped) return;
			const wantPort = this.desiredPort;
			if (this.enabled) {
				if (!(this.listener && (wantPort === 0 || this.listener.port === wantPort))) {
					await this.stopListener("Remote access port changed");
					await this.startListener(wantPort);
				}
			} else {
				await this.stopListener("Remote access was turned off");
			}
			this.applyRelay();
		});
		this.transition = run.catch(() => undefined);
		return run.finally(() => this.emitStatus());
	}

	private applyRelay(): void {
		const want = this.desiredRelay;
		const current = this.relayClient;
		if (current && want && current.url === want.url && this.relayToken === want.token) return;
		if (current) this.stopRelay(want ? "Relay settings changed" : "Relay was turned off");
		if (!want || this.stopped) return;
		this.relayToken = want.token;
		this.relayClient = new RelayClient({
			url: want.url,
			...(want.token ? { token: want.token } : {}),
			identity: this.identity,
			onIncoming: (socket, info) =>
				this.accept(socket, { via: "relay", ...(info.address ? { address: info.address } : {}) }),
			onChange: () => this.emitStatus(),
			log: (message) => this.hooks.log(message),
		});
	}

	private relayToken: string | undefined;

	private stopRelay(reason: string): void {
		const client = this.relayClient;
		if (!client) return;
		this.relayClient = undefined;
		client.stop();
		// Peer-to-peer paths were set up through the relay: turning it off ends them too.
		for (const live of [...this.live]) {
			if (live.route !== "lan") this.closeSession(live, CLOSE_CODES.remoteDisabled, reason);
		}
		if (!this.running) this.cancelPairing();
		this.hooks.log(`relay registration stopped (${reason})`);
	}

	/** Persist new settings (from `remote.configure`) and apply them. */
	async configure(patch: {
		enabled?: boolean;
		port?: number;
		relay?: { enabled?: boolean; url?: string; token?: string | null };
		p2p?: boolean;
	}): Promise<RemoteAccessStatus> {
		const next: Parameters<ConfigStore["setRemote"]>[0] = {};
		if (patch.enabled !== undefined) next.enabled = patch.enabled;
		if (patch.port !== undefined) next.port = patch.port;
		if (patch.p2p !== undefined) next.p2p = patch.p2p;
		if (patch.relay) {
			const saved = this.config.remote.relay ?? { enabled: false, url: "" };
			let url = saved.url;
			if (patch.relay.url !== undefined) {
				try {
					url = patch.relay.url.trim() ? normalizeRelayUrl(patch.relay.url) : "";
				} catch (error) {
					throw new PierProtocolError(
						"BAD_REQUEST",
						error instanceof RelayUrlError ? error.message : "Invalid relay address",
					);
				}
			}
			const enabled = patch.relay.enabled ?? saved.enabled;
			if (enabled && !url) throw new PierProtocolError("BAD_REQUEST", "Enter the relay address first");
			const token =
				patch.relay.token === null
					? undefined
					: patch.relay.token !== undefined
						? patch.relay.token.trim()
						: saved.token;
			next.relay = { enabled, url, ...(token ? { token } : {}) };
		}
		this.config.setRemote(next);
		// An explicit choice in the app wins over this run's command-line overrides.
		if (patch.enabled !== undefined) this.enabledOverride = undefined;
		if (patch.port !== undefined) this.portOverride = undefined;
		if (patch.relay) this.relayOverride = undefined;
		if (patch.p2p !== undefined) this.p2pOverride = undefined;
		await this.apply();
		return this.status();
	}

	private async startListener(port: number): Promise<void> {
		try {
			const wss = await new Promise<WebSocketServer>((resolve, reject) => {
				const server = new WebSocketServer({
					port,
					...(this.options.bindHost ? { host: this.options.bindHost } : {}),
					maxPayload: MAX_REMOTE_PAYLOAD,
					perMessageDeflate: false,
				});
				server.once("error", reject);
				server.once("listening", () => {
					server.off("error", reject);
					resolve(server);
				});
			});
			wss.on("error", (error) => this.hooks.log(`remote listener error: ${error.message}`));
			wss.on("connection", (socket, req) => this.accept(socket, { via: "lan", ...this.lanAddress(req) }));
			const actualPort = (wss.address() as AddressInfo).port;
			const alive = new WeakSet<WebSocket>();
			wss.on("connection", (socket) => {
				alive.add(socket);
				socket.on("pong", () => alive.add(socket));
			});
			const heartbeat = setInterval(() => {
				for (const socket of wss.clients) {
					if (!alive.has(socket)) {
						socket.terminate();
						continue;
					}
					alive.delete(socket);
					socket.ping();
				}
			}, this.options.heartbeatMs ?? 30_000);
			heartbeat.unref?.();
			const listener: Listener = { wss, port: actualPort, heartbeat };
			if (this.options.mdns !== false) {
				try {
					listener.mdns = advertiseMdns({
						name: this.hooks.hostName(),
						port: actualPort,
						hostId: this.hooks.hostId(),
						protocolVersion: PROTOCOL_VERSION,
						onError: (error) => this.hooks.log(`mDNS: ${error.message}`),
					});
				} catch (error) {
					this.hooks.log(`mDNS unavailable: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			this.listener = listener;
			this.lastError = undefined;
			this.hooks.log(
				`remote access listening on port ${actualPort} (${this.addresses().join(", ") || "no LAN address"})`,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			this.lastError =
				code === "EADDRINUSE"
					? `Port ${port} is already in use`
					: code === "EACCES"
						? `No permission to listen on port ${port}`
						: error instanceof Error
							? error.message
							: String(error);
			this.hooks.log(`remote access failed to start: ${this.lastError}`);
		}
	}

	private lanAddress(req: IncomingMessage): { address?: string } {
		const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
		return address ? { address } : {};
	}

	private async stopListener(reason: string): Promise<void> {
		const listener = this.listener;
		if (!listener) return;
		this.listener = undefined;
		if (this.relayClient?.state !== "online") this.cancelPairing();
		clearInterval(listener.heartbeat);
		for (const live of [...this.live]) {
			if (live.route === "lan") this.closeSession(live, CLOSE_CODES.remoteDisabled, reason);
		}
		for (const socket of listener.wss.clients) socket.close(CLOSE_CODES.remoteDisabled, reason);
		await listener.mdns?.stop();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				for (const socket of listener.wss.clients) socket.terminate();
			}, 1000);
			listener.wss.close(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.hooks.log(`remote access stopped (${reason})`);
	}

	async shutdown(): Promise<void> {
		for (const approval of [...this.approvals.values()]) approval.resolve("cancelled");
		await this.transition;
		this.stopped = true;
		this.stopRelay("Host shutting down");
		await this.stopListener("Host shutting down");
		for (const live of [...this.live]) this.closeSession(live, 1001, "Host shutting down");
	}

	// ---- pairing --------------------------------------------------------------------------

	startPairing(): { uri: string; expiresAt: string; addresses: string[]; relays: string[] } {
		if (!this.reachable) {
			throw new PierProtocolError("CONFLICT", "Turn on remote access (LAN or relay) before pairing a device");
		}
		const addresses = this.running ? this.addresses() : [];
		const relay = this.relayClient?.state === "online" ? this.relayClient.url : undefined;
		const relays = relay ? [relay] : [];
		if (!addresses.length && !relays.length) {
			throw new PierProtocolError("CONFLICT", "No network address found; connect to a network first");
		}
		if (this.pairing) clearTimeout(this.pairing.timer);
		const ttl = this.options.pairingTtlMs ?? 5 * 60_000;
		const code = toBase64Url(randomBytes(16));
		const expiresAt = Date.now() + ttl;
		const timer = setTimeout(() => {
			if (this.pairing?.code === code) {
				this.pairing = undefined;
				this.emitStatus();
			}
		}, ttl);
		timer.unref?.();
		this.pairing = { code, expiresAt, failures: 0, timer };
		this.emitStatus();
		return {
			uri: formatPairingUri({
				hostId: this.hooks.hostId(),
				hostName: this.hooks.hostName(),
				hostPublicKey: this.identity.publicKey,
				addresses,
				relays,
				code,
			}),
			expiresAt: new Date(expiresAt).toISOString(),
			addresses,
			relays,
		};
	}

	cancelPairing(): boolean {
		const had = this.pairing !== undefined;
		if (this.pairing) clearTimeout(this.pairing.timer);
		this.pairing = undefined;
		if (had) this.emitStatus();
		return had;
	}

	private pairingOpen(): boolean {
		return this.pairing !== undefined && this.pairing.expiresAt > Date.now();
	}

	respondPairing(requestId: string, accept: boolean): boolean {
		const approval = this.approvals.get(requestId);
		if (!approval) return false;
		approval.resolve(accept ? "accepted" : "rejected");
		return true;
	}

	pendingPairingRequests(): PairingRequest[] {
		return [...this.approvals.values()].map((a) => a.request);
	}

	/**
	 * Validate the one-time code, ask the desktop user, and register the device when
	 * accepted. `onAbort` lets the caller cancel the question if the device goes away.
	 */
	private async handlePairRequest(
		request: PairRequest,
		deviceKey: Uint8Array,
		origin: Origin,
		onAbort: (abort: () => void) => void,
	): Promise<PairResult> {
		const address = origin.address;
		const auditOrigin = {
			...(address ? { address } : {}),
			...(origin.via === "relay" ? { detail: { via: "relay" } } : {}),
		};
		const pairing = this.pairing;
		if (!pairing || pairing.expiresAt <= Date.now()) {
			return { ok: false, code: "PAIRING_INVALID", message: "The pairing code has expired; show a new one" };
		}
		if (!constantTimeEqual(request.code, pairing.code)) {
			pairing.failures += 1;
			this.audit.write({ event: "pair.badCode", ...auditOrigin });
			if (pairing.failures >= (this.options.maxPairingFailures ?? 5)) this.cancelPairing();
			return { ok: false, code: "PAIRING_INVALID", message: "Invalid pairing code" };
		}
		// One-time: the code is used up whatever the desktop user decides.
		this.cancelPairing();

		const timeoutMs = this.options.approvalTimeoutMs ?? 2 * 60_000;
		const pairingRequest: PairingRequest = {
			id: randomUUID(),
			device: request.device,
			fingerprint: keyFingerprint(deviceKey),
			...(address ? { address: origin.via === "relay" ? `${address}（经中继）` : address } : {}),
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
		};
		const resolution = await new Promise<PairingResolution>((resolve) => {
			const timer = setTimeout(() => finish("expired"), timeoutMs);
			const finish = (value: PairingResolution) => {
				if (!this.approvals.has(pairingRequest.id)) return;
				clearTimeout(timer);
				this.approvals.delete(pairingRequest.id);
				resolve(value);
			};
			this.approvals.set(pairingRequest.id, { request: pairingRequest, resolve: finish });
			onAbort(() => finish("cancelled"));
			this.hooks.broadcastLocal({ type: "pairing.request", request: pairingRequest });
		});

		if (resolution !== "accepted") {
			this.hooks.broadcastLocal({ type: "pairing.resolved", requestId: pairingRequest.id, resolution });
			this.audit.write({ event: `pair.${resolution}`, deviceName: request.device.name, ...auditOrigin });
			return resolution === "rejected"
				? { ok: false, code: "PAIRING_REJECTED", message: "Pairing was declined on the desktop" }
				: { ok: false, code: "PAIRING_TIMEOUT", message: "Nobody confirmed the pairing on the desktop in time" };
		}
		const device = this.devices.register({
			publicKey: deviceKey,
			name: request.device.name,
			...(request.device.platform ? { platform: request.device.platform } : {}),
			...(request.device.model ? { model: request.device.model } : {}),
			...(request.device.appVersion ? { appVersion: request.device.appVersion } : {}),
		});
		this.hooks.broadcastLocal({
			type: "pairing.resolved",
			requestId: pairingRequest.id,
			resolution,
			deviceId: device.id,
		});
		this.hooks.broadcastLocal({ type: "device.changed" });
		this.audit.write({ event: "pair.accepted", deviceId: device.id, deviceName: device.name, ...auditOrigin });
		this.hooks.log(`paired device ${device.name} (${device.id})`);
		return { ok: true, deviceId: device.id, hostId: this.hooks.hostId(), hostName: this.hooks.hostName() };
	}

	// ---- devices --------------------------------------------------------------------------

	listDevices(): DeviceInfo[] {
		const routes = new Map<string, ConnectionRouteKind>();
		for (const live of this.live) {
			// The best route wins when a device has several connections.
			const current = routes.get(live.device.id);
			if (!current || live.route === "lan" || (live.route === "p2p" && current === "relay")) {
				routes.set(live.device.id, live.route);
			}
		}
		const connected = new Set(this.hooks.remoteConnections().map((c) => c.device?.id));
		return this.devices
			.list()
			.sort((a, b) => b.pairedAt.localeCompare(a.pairedAt))
			.map((d) => {
				const info = toDeviceInfo(d, connected.has(d.id));
				const route = info.connected ? routes.get(d.id) : undefined;
				return route ? { ...info, route } : info;
			});
	}

	isRegistered(deviceId: string): boolean {
		return this.devices.get(deviceId) !== undefined;
	}

	revoke(deviceId: string): boolean {
		const device = this.devices.get(deviceId);
		if (!this.devices.remove(deviceId)) return false;
		for (const connection of this.hooks.remoteConnections()) {
			if (connection.device?.id === deviceId) connection.close(CLOSE_CODES.deviceRevoked, "Device revoked");
		}
		this.audit.write({ event: "device.revoke", deviceId, ...(device ? { deviceName: device.name } : {}) });
		this.hooks.broadcastLocal({ type: "device.changed" });
		this.hooks.log(`revoked device ${device?.name ?? deviceId}`);
		return true;
	}

	rename(deviceId: string, name: string): DeviceInfo {
		const record = this.devices.rename(deviceId, name);
		if (!record) throw new PierProtocolError("NOT_FOUND", `Device ${deviceId} not found`);
		for (const connection of this.hooks.remoteConnections()) {
			if (connection.device?.id === deviceId) connection.device.name = name;
		}
		this.hooks.broadcastLocal({ type: "device.changed" });
		const connected = this.hooks.remoteConnections().some((c) => c.device?.id === deviceId);
		return toDeviceInfo(record, connected);
	}

	record(entry: AuditEntry): void {
		this.audit.write(entry);
	}

	// ---- sockets --------------------------------------------------------------------------

	/** What to tell a device in the handshake reply: control frames, and p2p over a relay. */
	private connectHello(device: ConnectHello, origin: Origin): ConnectHello | undefined {
		if (!device.caps?.includes(CAP_CONTROL)) return undefined;
		const hello: ConnectHello = { caps: [CAP_CONTROL] };
		const iceServers = this.relayClient?.iceServers ?? [];
		if (origin.via === "relay" && this.p2pEnabled && iceServers.length) hello.p2p = { iceServers };
		return hello;
	}

	private accept(socket: WebSocket, origin: Origin): void {
		if (this.pendingHandshakes >= MAX_PENDING_HANDSHAKES) {
			socket.send(errorFrame("UNAVAILABLE", "Too many pending connections; try again"));
			socket.close(CLOSE_CODES.handshakeFailed, "Busy");
			return;
		}
		this.pendingHandshakes += 1;
		let handshaking = true;
		const endHandshake = () => {
			if (!handshaking) return;
			handshaking = false;
			this.pendingHandshakes -= 1;
		};

		const responder = new ChannelResponder({
			hostKeyPair: this.identity,
			hostHello: { hostId: this.hooks.hostId(), hostName: this.hooks.hostName() },
			isKnownDevice: (key) => this.devices.findByKey(key) !== undefined,
			pairingOpen: () => this.pairingOpen(),
			connectHello: (device) => this.connectHello(device, origin),
		});
		let phase: "handshake" | "pairing" | "open" | "closed" = "handshake";
		let abortPairing: (() => void) | undefined;
		const path = wsPath(socket);
		let live: LiveSession | undefined;

		const refuse = (code: ChannelError["code"], message: string) => {
			phase = "closed";
			endHandshake();
			try {
				socket.send(errorFrame(code, message));
			} catch {
				// Socket already gone.
			}
			socket.close(code === "UNKNOWN_DEVICE" ? CLOSE_CODES.deviceRevoked : CLOSE_CODES.handshakeFailed, code);
		};
		const timer = setTimeout(() => {
			if (phase === "handshake") refuse("BAD_HANDSHAKE", "Handshake timed out");
		}, this.options.handshakeTimeoutMs ?? 10_000);
		timer.unref?.();

		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				if (live) live.connection.close(1003, "Binary frames are not supported");
				else refuse("BAD_HANDSHAKE", "Binary frames are not supported");
				return;
			}
			const raw = data.toString();
			if (phase === "open" && live) {
				live.session.receive(raw, path);
				return;
			}
			if (phase !== "handshake") {
				if (phase === "pairing") refuse("BAD_HANDSHAKE", "Unexpected frame while pairing");
				return;
			}
			try {
				const step = responder.receive(raw);
				if (step.kind === "continue") {
					socket.send(step.frame);
				} else if (step.kind === "connected") {
					clearTimeout(timer);
					endHandshake();
					const record = this.devices.findByKey(step.remoteStaticKey);
					if (!record) {
						refuse("UNKNOWN_DEVICE", "This device is not paired with the host (or was revoked)");
						return;
					}
					socket.send(step.frame);
					phase = "open";
					live = this.openSession(step.transport, path, record, origin);
				} else {
					clearTimeout(timer);
					endHandshake();
					phase = "pairing";
					const secure = step.transport;
					void this.handlePairRequest(step.request, step.remoteStaticKey, origin, (abort) => {
						abortPairing = abort;
					}).then((result) => {
						abortPairing = undefined;
						if (socket.readyState !== socket.OPEN) return;
						socket.send(secure.seal(JSON.stringify(result)));
						phase = "closed";
						socket.close(result.ok ? 1000 : CLOSE_CODES.handshakeFailed, result.ok ? "Paired" : result.code);
					});
				}
			} catch (error) {
				if (error instanceof ChannelError) refuse(error.code, error.message);
				else refuse("BAD_HANDSHAKE", "Handshake failed");
			}
		});

		const onGone = () => {
			clearTimeout(timer);
			endHandshake();
			abortPairing?.();
			abortPairing = undefined;
			if (phase === "open" && live) this.pathGone(live, path);
			phase = "closed";
		};
		socket.on("close", onGone);
		socket.on("error", onGone);
	}

	private openSession(
		transport: SecureTransport,
		path: SessionPath,
		record: { id: string; name: string },
		origin: Origin,
	): LiveSession {
		const address = origin.address;
		const device: RemoteDevice = { id: record.id, name: record.name, ...(address ? { address } : {}) };
		const live = new LiveSession(device, origin.via, path);
		live.session = new SecureSession(transport, path, {
			message: (text) => {
				const connection = live.connection;
				void connection.receive(text).catch(() => connection.close(1011, "Internal error"));
			},
			control: (message, from) => this.onControl(live, message, from),
			fail: (error) => live.connection.close(CLOSE_CODES.handshakeFailed, error.message.slice(0, 100)),
		});
		live.connection = this.hooks.connect(
			{
				send: (text) => live.session.send(text),
				close: (code, reason) => this.closeSession(live, code ?? 1000, reason ?? ""),
				get bufferedAmount() {
					return live.session.bufferedAmount;
				},
			},
			device,
		);
		this.live.add(live);
		this.devices.touch(record.id);
		this.audit.write({
			event: "connect",
			deviceId: record.id,
			deviceName: record.name,
			...(address ? { address } : {}),
			...(origin.via === "relay" ? { detail: { via: "relay" } } : {}),
		});
		this.hooks.broadcastLocal({ type: "device.changed" });
		return live;
	}

	/** Close every path of a session (the connection was closed by the host). */
	private closeSession(live: LiveSession, code: number, reason: string): void {
		if (live.ended) return;
		const active = live.session.path;
		if (live.route === "p2p") {
			// A data channel carries no close code: tell the device first.
			try {
				live.session.sendControl({ c: "close", code, reason });
			} catch {
				// Already gone.
			}
		}
		for (const other of [...live.paths]) {
			if (other !== active) other.close(code, reason);
		}
		try {
			active.close(code, reason);
		} catch {
			// Already closed.
		}
		// A data channel does not report a close we started; sockets do (onGone).
		if (live.route === "p2p") this.pathGone(live, active);
	}

	/** A path of a live session closed: the session ends when it was the one carrying it. */
	private pathGone(live: LiveSession, path: SessionPath): void {
		live.paths.delete(path);
		if (live.session.path !== path) {
			// The relay socket after moving to p2p, or a data channel that never took over.
			if (live.p2p?.path === path) live.closeP2P();
			return;
		}
		if (live.ended) return;
		live.ended = true;
		live.session.dispose();
		live.closeP2P();
		for (const other of [...live.paths]) other.close(1000, "Connection closed");
		live.paths.clear();
		this.live.delete(live);
		const { connection, device } = live;
		connection.onTransportClosed();
		this.devices.touch(device.id);
		this.audit.write({ event: "disconnect", deviceId: device.id, deviceName: device.name });
		this.hooks.broadcastLocal({ type: "device.changed" });
	}

	private onControl(live: LiveSession, message: ControlMessage, from: SessionPath | undefined): void {
		switch (message.c) {
			case "rtc.offer":
				void this.answerP2P(live, message);
				return;
			case "close":
				// The device closed its data channel connection.
				if (live.route === "p2p") this.pathGone(live, live.session.path);
				return;
			case "fin": {
				// The device moved to the data channel and sends nothing more on this path; follow it
				// once our side of the channel is there.
				const p2p = live.p2p;
				if (!p2p || from !== live.session.path) return;
				if (p2p.path) this.switchToP2P(live, p2p.path);
				else p2p.finPending = true;
				return;
			}
			default:
				return;
		}
	}

	private switchToP2P(live: LiveSession, path: SessionPath): void {
		if (live.session.path === path) return;
		// Sends our `fin` on the relay; the device then closes the relay socket.
		live.session.switchPath(path);
		live.route = "p2p";
		this.audit.write({
			event: "route",
			deviceId: live.device.id,
			deviceName: live.device.name,
			detail: { via: "p2p" },
		});
		this.hooks.log(`device ${live.device.name} moved to a peer-to-peer path`);
		this.hooks.broadcastLocal({ type: "device.changed" });
	}

	private async answerP2P(live: LiveSession, message: ControlMessage): Promise<void> {
		const decline = (text: string) => {
			try {
				live.session.sendControl({ c: "rtc.error", message: text });
			} catch {
				// Connection gone.
			}
		};
		if (live.route !== "relay") return decline("Not available on this connection");
		if (!this.p2pEnabled) return decline("Peer-to-peer connections are turned off on this computer");
		if (typeof message.sdp !== "string" || message.sdp.length > 64 * 1024) return decline("Invalid offer");
		if (this.p2pSetups >= MAX_P2P_SETUPS) return decline("Busy");
		live.closeP2P();
		this.p2pSetups += 1;
		try {
			let answer: P2PAnswer;
			try {
				answer = await answerOffer(message.sdp, this.relayClient?.iceServers ?? [], P2P_SETUP_TIMEOUT_MS);
			} catch (error) {
				this.hooks.log(`p2p answer failed: ${error instanceof Error ? error.message : String(error)}`);
				return decline("Could not set up a peer-to-peer connection");
			}
			if (live.ended) {
				answer.pc.close();
				return;
			}
			const entry: P2PState = { pc: answer.pc, finPending: false };
			live.p2p = entry;
			watchPeerConnection(answer.pc, () => {
				if (entry.path) this.pathGone(live, entry.path);
				else if (live.p2p === entry) live.closeP2P();
			});
			try {
				live.session.sendControl({ c: "rtc.answer", sdp: answer.sdp });
			} catch {
				live.closeP2P();
				return;
			}
			let channel: RtcDataChannelLike;
			try {
				channel = await answer.channel;
			} catch {
				if (live.p2p === entry) live.closeP2P();
				return;
			}
			if (live.p2p !== entry || live.ended) {
				channel.close();
				return;
			}
			const path: SessionPath = dataChannelPath(
				channel,
				{
					frame: (text) => live.session.receive(text, path),
					close: () => {
						this.pathGone(live, path);
						closePeerConnection(entry.pc);
					},
				},
				{ onClosed: () => closePeerConnection(entry.pc) },
			);
			entry.path = path;
			live.paths.add(path);
			if (entry.finPending) this.switchToP2P(live, path);
		} finally {
			this.p2pSetups -= 1;
		}
	}
}

interface P2PState {
	pc: RtcPeerConnectionLike;
	/** Our end of the device's data channel, once announced. */
	path?: SessionPath;
	/** The device already switched (its `fin` arrived before our channel did). */
	finPending: boolean;
}

/** An authenticated device connection, possibly spread over several paths while it moves. */
class LiveSession {
	session!: SecureSession;
	connection!: Connection;
	readonly paths = new Set<SessionPath>();
	p2p: P2PState | undefined;
	ended = false;

	constructor(
		readonly device: RemoteDevice,
		public route: ConnectionRouteKind,
		path: SessionPath,
	) {
		this.paths.add(path);
	}

	closeP2P(): void {
		const current = this.p2p;
		this.p2p = undefined;
		if (!current) return;
		if (current.path) {
			// The path closes the peer connection once its last frames went out.
			this.paths.delete(current.path);
			current.path.close();
			return;
		}
		closePeerConnection(current.pc);
	}
}

function closePeerConnection(pc: RtcPeerConnectionLike): void {
	try {
		pc.close();
	} catch {
		// Ignore.
	}
}
