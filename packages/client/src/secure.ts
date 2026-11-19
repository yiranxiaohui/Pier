import {
	addressToUrl,
	CAP_CONTROL,
	CAP_DEFLATE,
	ChannelError,
	CLOSE_CODES,
	type ConnectHello,
	ConnectInitiator,
	type ControlMessage,
	type DeviceDescription,
	type FrameCompression,
	type KeyPair,
	PairInitiator,
	type PairingInfo,
	type PairResult,
	RELAY_CLOSE,
	relayConnectUrl,
	SecureSession,
	type SessionPath,
} from "@pier/crypto";
import type { WebSocketFactory, WebSocketLike } from "./client.ts";
import {
	dataChannelPath,
	mergeIceServers,
	type P2POptions,
	type RtcDataChannelLike,
	type RtcPeerConnectionLike,
	waitForDataChannel,
	waitForIceGathering,
} from "./p2p.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function defaultFactory(): WebSocketFactory {
	const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
	if (!Ctor) throw new Error("No global WebSocket; pass createWebSocket");
	return (url) => new Ctor(url);
}

/** How a secure connection reaches the host. */
export type ConnectionRoute =
	/** Straight to one of the host's addresses (LAN, VPN, forwarded port). */
	| { kind: "direct"; address: string }
	/** Through a Pier Relay; the relay only sees ciphertext. */
	| { kind: "relay"; relay: string }
	/** A peer-to-peer WebRTC path, set up through the relay. */
	| { kind: "p2p"; relay: string };

/** Short label for a route, e.g. for logs. */
export function routeLabel(route: ConnectionRoute): string {
	return route.kind === "direct" ? route.address : route.kind === "relay" ? `relay ${route.relay}` : "p2p";
}

/** One way to reach the host: a direct address or a relay. */
interface Candidate {
	url: string;
	route: ConnectionRoute;
	/** Start this long after the first attempt, unless earlier attempts all failed sooner. */
	delayMs: number;
}

/** Stagger between direct addresses (most fail fast or answer fast on a LAN). */
const ADDRESS_STAGGER_MS = 250;

function candidates(
	addresses: string[],
	relays: string[] | undefined,
	hostPublicKey: Uint8Array,
	relayDelayMs: number,
): Candidate[] {
	const list: Candidate[] = addresses.map((address, i) => ({
		url: addressToUrl(address),
		route: { kind: "direct", address },
		delayMs: i * ADDRESS_STAGGER_MS,
	}));
	const relayStart = addresses.length ? relayDelayMs : 0;
	(relays ?? []).forEach((relay, i) => {
		list.push({
			url: relayConnectUrl(relay, hostPublicKey),
			route: { kind: "relay", relay },
			delayMs: relayStart + i * ADDRESS_STAGGER_MS,
		});
	});
	return list;
}

interface Opened {
	candidate: Candidate;
	socket: WebSocketLike;
}

/**
 * Open sockets to several candidates with staggered starts ("happy eyeballs"): the
 * consumer takes opened sockets in the order they open and tries the handshake on each.
 * When every started attempt failed, the next candidate starts right away.
 */
class CandidateRace {
	private readonly queue: Opened[] = [];
	private readonly waiters: Array<(value: Opened | undefined) => void> = [];
	private readonly live = new Set<WebSocketLike>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private next = 0;
	private inFlight = 0;
	private cancelled = false;
	readonly errors: string[] = [];

	constructor(
		private readonly list: Candidate[],
		private readonly factory: WebSocketFactory,
		private readonly timeoutMs: number,
	) {
		for (const candidate of list) {
			const timer = setTimeout(() => {
				this.timers.delete(timer);
				this.startUpTo(candidate);
			}, candidate.delayMs);
			this.timers.add(timer);
		}
	}

	/** Start every candidate up to and including `candidate` that has not started yet. */
	private startUpTo(candidate: Candidate): void {
		const index = this.list.indexOf(candidate);
		while (!this.cancelled && this.next <= index) this.start(this.list[this.next++] as Candidate);
	}

	private start(candidate: Candidate): void {
		this.inFlight += 1;
		let socket: WebSocketLike;
		try {
			socket = this.factory(candidate.url);
		} catch (error) {
			this.failed(`${routeLabel(candidate.route)}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.live.add(socket);
		let done = false;
		const timer = setTimeout(() => {
			fail(`Timed out connecting to ${routeLabel(candidate.route)}`);
			try {
				socket.close();
			} catch {
				// Ignore.
			}
		}, this.timeoutMs);
		this.timers.add(timer);
		const fail = (message: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			this.timers.delete(timer);
			socket.onopen = null;
			// Node's ws emits an asynchronous error when a CONNECTING socket is closed.
			socket.onerror = () => undefined;
			socket.onclose = null;
			this.live.delete(socket);
			this.failed(message);
		};
		socket.onopen = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			this.timers.delete(timer);
			socket.onopen = null;
			socket.onerror = () => undefined;
			socket.onclose = null;
			this.inFlight -= 1;
			if (this.cancelled) {
				this.live.delete(socket);
				socket.close(1000, "Not needed");
				return;
			}
			const opened = { candidate, socket };
			const waiter = this.waiters.shift();
			if (waiter) waiter(opened);
			else this.queue.push(opened);
		};
		socket.onerror = () => fail(`Could not connect to ${routeLabel(candidate.route)}`);
		socket.onclose = (event) =>
			fail(`Could not connect to ${routeLabel(candidate.route)}${event.reason ? `: ${event.reason}` : ""}`);
	}

	private failed(message: string): void {
		this.inFlight -= 1;
		this.errors.push(message);
		if (this.cancelled) return;
		// Nothing else is trying: start the next candidate now instead of waiting for its turn.
		if (this.inFlight === 0 && this.next < this.list.length) {
			this.start(this.list[this.next++] as Candidate);
			return;
		}
		this.settleIfExhausted();
	}

	private settleIfExhausted(): void {
		if (this.inFlight === 0 && this.next >= this.list.length && !this.queue.length) {
			for (const waiter of this.waiters.splice(0)) waiter(undefined);
		}
	}

	/** The next opened socket, or `undefined` once every candidate failed. */
	take(): Promise<Opened | undefined> {
		const opened = this.queue.shift();
		if (opened) {
			this.live.delete(opened.socket);
			return Promise.resolve(opened);
		}
		if (this.cancelled || (this.inFlight === 0 && this.next >= this.list.length)) return Promise.resolve(undefined);
		return new Promise((resolve) =>
			this.waiters.push((value) => {
				if (value) this.live.delete(value.socket);
				resolve(value);
			}),
		);
	}

	/** Stop: close every socket not handed out and cancel pending starts. */
	cancel(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		for (const socket of this.live) {
			socket.onopen = null;
			// Keep a handler until closing finishes, including pending Node connections.
			socket.onerror = () => undefined;
			socket.onclose = null;
			try {
				socket.close(1000, "Not needed");
			} catch {
				// Ignore.
			}
		}
		this.live.clear();
		this.queue.length = 0;
		for (const waiter of this.waiters.splice(0)) waiter(undefined);
	}

	/** Why every candidate failed, for the user. */
	summary(): string {
		return this.errors.length ? this.errors.join("; ") : "No address to connect to";
	}
}

function socketPath(socket: WebSocketLike): SessionPath {
	return {
		send: (frame) => socket.send(frame),
		close: (code, reason) => socket.close(code, reason),
		get bufferedAmount() {
			return (socket as { bufferedAmount?: number }).bufferedAmount ?? 0;
		},
	};
}

/** Why a relay closed the socket, in words. */
function relayCloseText(code: number | undefined, reason: string | undefined): string | undefined {
	switch (code) {
		case RELAY_CLOSE.hostOffline:
			return "The computer is not connected to the relay";
		case RELAY_CLOSE.acceptTimeout:
			return "The computer did not answer through the relay";
		case RELAY_CLOSE.limit:
			return `Relay limit reached${reason ? `: ${reason}` : ""}`;
		default:
			return undefined;
	}
}

export interface SecureSocketOptions {
	/** Candidate `host:port` addresses (from pairing), tried in order. */
	addresses: string[];
	/** Pier Relay URLs to try when no address answers (from pairing). */
	relays?: string[];
	hostPublicKey: Uint8Array;
	deviceKeyPair: KeyPair;
	createWebSocket?: WebSocketFactory;
	/** Per-address TCP/WebSocket open timeout (default 4 s). */
	openTimeoutMs?: number;
	/** Handshake timeout after the socket opened (default 10 s). */
	handshakeTimeoutMs?: number;
	/** Start trying relays this long after the direct addresses (default 1.5 s). */
	relayDelayMs?: number;
	/** Called with the direct address that worked, so it can be tried first next time. */
	onConnected?: (address: string) => void;
	/** Called whenever the connection's route is established or changes (relay → p2p). */
	onRoute?: (route: ConnectionRoute) => void;
	/** Move relayed connections onto a peer-to-peer path when possible. */
	p2p?: P2POptions;
	/**
	 * Raw DEFLATE for frames (e.g. from `node:zlib`). With it the device announces that it accepts
	 * compressed frames, so a host that supports them compresses large ones (session snapshots),
	 * and it compresses its own large frames for such a host.
	 */
	compression?: FrameCompression;
}

/**
 * A {@link WebSocketLike} that tries the host's addresses (then its relays), runs the
 * Noise IK handshake, and then encrypts every frame. `onopen` fires only after the
 * handshake, so `PierClient` works unchanged on top of it (pass
 * `createSecureSocketFactory(...)` as its `createWebSocket`).
 *
 * A connection through a relay moves onto a peer-to-peer path in the background when the
 * host supports it and `p2p` is given; the client above does not notice.
 *
 * If the host does not know this device (never paired or revoked), the socket closes
 * with code 4403 and reason `UNKNOWN_DEVICE`.
 */
export class SecureWebSocket implements WebSocketLike {
	readyState = CONNECTING;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	/** Address of the established connection (direct routes only). */
	address: string | undefined;
	/** How the connection currently reaches the host. */
	route: ConnectionRoute | undefined;
	private session: SecureSession | undefined;
	/** Every open path with its closer (the active one plus one being retired). */
	private readonly paths = new Map<SessionPath, (code?: number, reason?: string) => void>();
	private race: CandidateRace | undefined;
	private hostHello: ConnectHello = {};
	private closedByUser = false;
	private p2pAttempt: { pc: RtcPeerConnectionLike; answer?: (message: ControlMessage) => void } | undefined;
	private p2pTimer: ReturnType<typeof setTimeout> | undefined;
	private p2pTries = 0;

	constructor(private readonly options: SecureSocketOptions) {
		void this.run();
	}

	private async run(): Promise<void> {
		const factory = this.options.createWebSocket ?? defaultFactory();
		const race = new CandidateRace(
			candidates(
				this.options.addresses,
				this.options.relays,
				this.options.hostPublicKey,
				this.options.relayDelayMs ?? 1500,
			),
			factory,
			this.options.openTimeoutMs ?? 4000,
		);
		this.race = race;
		let lastError: string | undefined;
		for (;;) {
			const opened = await race.take();
			if (!opened) break;
			if (this.closedByUser) {
				race.cancel();
				opened.socket.close(1000, "Closed");
				return;
			}
			try {
				await this.handshake(opened.socket, opened.candidate.route);
				race.cancel();
				return;
			} catch (error) {
				try {
					opened.socket.close();
				} catch {
					// Ignore.
				}
				if (error instanceof ChannelError) {
					race.cancel();
					// The host answered: trying other routes cannot help.
					this.finish(
						error.code === "UNKNOWN_DEVICE" ? CLOSE_CODES.deviceRevoked : CLOSE_CODES.handshakeFailed,
						error.code === "UNKNOWN_DEVICE" ? "UNKNOWN_DEVICE" : error.message,
					);
					return;
				}
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
		this.finish(1006, lastError ?? race.summary());
	}

	private handshake(socket: WebSocketLike, route: ConnectionRoute): Promise<void> {
		const compression = this.options.compression;
		const initiator = new ConnectInitiator({
			deviceKeyPair: this.options.deviceKeyPair,
			hostPublicKey: this.options.hostPublicKey,
			hello: { caps: compression ? [CAP_CONTROL, CAP_DEFLATE] : [CAP_CONTROL] },
		});
		const label = routeLabel(route);
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Secure handshake timed out")),
				this.options.handshakeTimeoutMs ?? 10_000,
			);
			const path = socketPath(socket);
			socket.onmessage = (event) => {
				if (this.session) {
					this.session.receive(String(event.data), path);
					return;
				}
				clearTimeout(timer);
				let session: SecureSession;
				try {
					const transport = initiator.receive(String(event.data));
					this.hostHello = initiator.hostHello;
					session = new SecureSession(
						transport,
						path,
						{
							message: (text) => this.onmessage?.({ data: text }),
							control: (message, from) => this.onControl(message, from),
							fail: () => this.close(CLOSE_CODES.handshakeFailed, "Invalid encrypted frame"),
						},
						compression ? { compression, compressOutgoing: this.hostHello.caps?.includes(CAP_DEFLATE) === true } : {},
					);
				} catch (error) {
					reject(error);
					return;
				}
				this.session = session;
				this.paths.set(path, (code = 1000, reason = "Closed") => {
					try {
						socket.close(code, reason);
					} catch {
						// Already closed.
					}
				});
				this.route = route;
				if (route.kind === "direct") this.address = route.address;
				socket.onerror = (e) => {
					if (this.session?.path === path) this.onerror?.(e);
				};
				socket.onclose = (e) => this.pathClosed(path, e.code ?? 1006, e.reason ?? "");
				this.readyState = OPEN;
				if (route.kind === "direct") this.options.onConnected?.(route.address);
				this.options.onRoute?.(route);
				resolve();
				this.onopen?.({});
				if (route.kind === "relay") this.scheduleP2P();
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error(`Connection to ${label} failed`));
			};
			socket.onclose = (event) => {
				clearTimeout(timer);
				const relayText = route.kind === "relay" ? relayCloseText(event.code, event.reason) : undefined;
				reject(new Error(relayText ?? `Connection to ${label} closed${event.reason ? `: ${event.reason}` : ""}`));
			};
			try {
				socket.send(initiator.start());
			} catch (error) {
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	/** A path went away: fatal when it carried the connection, otherwise just forget it. */
	private pathClosed(path: SessionPath, code: number, reason: string): void {
		const closer = this.paths.get(path);
		if (!closer) return;
		this.paths.delete(path);
		closer();
		if (this.session?.path === path) {
			this.session.dispose();
			this.stopP2P();
			for (const close of this.paths.values()) close();
			this.paths.clear();
			this.finish(code, reason);
		}
	}

	private onControl(message: ControlMessage, from: SessionPath | undefined): void {
		switch (message.c) {
			case "fin":
				// The host switched paths and will send nothing more on the old one.
				if (from && from !== this.session?.path) this.paths.get(from)?.();
				return;
			case "rtc.answer":
			case "rtc.error":
				this.p2pAttempt?.answer?.(message);
				return;
			case "close": {
				// The host closed a data channel connection (which carries no close code itself).
				const active = this.session?.path;
				if (!active || this.route?.kind !== "p2p") return;
				const code = typeof message.code === "number" ? message.code : 1000;
				this.pathClosed(active, code, typeof message.reason === "string" ? message.reason : "");
				return;
			}
			default:
				return;
		}
	}

	// ---- peer-to-peer ----------------------------------------------------------------------

	private scheduleP2P(): void {
		const p2p = this.options.p2p;
		const offered = this.hostHello.p2p;
		if (!p2p || !offered || !this.hostHello.caps?.includes(CAP_CONTROL)) return;
		// A few attempts per connection: NATs and networks change.
		const delays = [p2p.delayMs ?? 500, 30_000, 120_000];
		const delay = delays[this.p2pTries];
		if (delay === undefined) return;
		this.p2pTimer = setTimeout(() => {
			this.p2pTimer = undefined;
			this.p2pTries += 1;
			void this.tryP2P(p2p, mergeIceServers(offered.iceServers, p2p.iceServers)).then((ok) => {
				if (!ok && this.readyState === OPEN && this.route?.kind === "relay") this.scheduleP2P();
			});
		}, delay);
	}

	private stopP2P(): void {
		if (this.p2pTimer) clearTimeout(this.p2pTimer);
		this.p2pTimer = undefined;
		const attempt = this.p2pAttempt;
		this.p2pAttempt = undefined;
		attempt?.answer?.({ c: "rtc.error", message: "Closed" });
	}

	private async tryP2P(p2p: P2POptions, iceServers: P2POptions["iceServers"]): Promise<boolean> {
		const session = this.session;
		const route = this.route;
		if (!session || route?.kind !== "relay" || this.readyState !== OPEN) return false;
		const log = p2p.log ?? (() => {});
		const timeoutMs = p2p.timeoutMs ?? 20_000;
		let pc: RtcPeerConnectionLike;
		try {
			pc = await p2p.createPeerConnection({ iceServers: iceServers ?? [] });
		} catch (error) {
			log(`p2p unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return true; // Not supported here; do not retry.
		}
		const attempt: { pc: RtcPeerConnectionLike; answer?: (message: ControlMessage) => void } = { pc };
		this.p2pAttempt = attempt;
		let channel: RtcDataChannelLike | undefined;
		const current = () => this.p2pAttempt === attempt && this.session === session && this.readyState === OPEN;
		try {
			channel = pc.createDataChannel("pier", { ordered: true });
			const answered = new Promise<ControlMessage>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("The computer did not answer the p2p offer")), timeoutMs);
				attempt.answer = (message) => {
					clearTimeout(timer);
					attempt.answer = undefined;
					resolve(message);
				};
			});
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await waitForIceGathering(pc, 3000);
			const sdp = pc.localDescription?.sdp;
			if (!sdp) throw new Error("No local description");
			if (!current()) throw new Error("Connection closed");
			session.sendControl({ c: "rtc.offer", sdp });
			const answer = await answered;
			if (answer.c !== "rtc.answer" || typeof answer.sdp !== "string") {
				throw new Error(typeof answer.message === "string" ? answer.message : "The computer declined p2p");
			}
			if (!current()) throw new Error("Connection closed");
			await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
			await waitForDataChannel(channel, timeoutMs);
			if (!current()) throw new Error("Connection closed");
		} catch (error) {
			if (this.p2pAttempt === attempt) this.p2pAttempt = undefined;
			try {
				channel?.close();
				pc.close();
			} catch {
				// Ignore.
			}
			log(`p2p failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
		this.p2pAttempt = undefined;
		// Move the session onto the data channel. The host does the same when it reads our
		// `fin`, then sends its own `fin` on the relay, which closes it (see onControl).
		const dc = channel;
		const closePc = () => {
			try {
				pc.close();
			} catch {
				// Ignore.
			}
		};
		const path: SessionPath = dataChannelPath(
			dc,
			{
				frame: (text) => this.session?.receive(text, path),
				close: (reason) => {
					this.pathClosed(path, 1006, reason);
					closePc();
				},
			},
			{ onClosed: closePc },
		);
		this.paths.set(path, () => path.close());
		session.switchPath(path);
		const next: ConnectionRoute = { kind: "p2p", relay: route.relay };
		this.route = next;
		log("moved to a peer-to-peer path");
		this.options.onRoute?.(next);
		return true;
	}

	private finish(code: number, reason: string): void {
		if (this.readyState === CLOSED) return;
		const wasOpen = this.readyState === OPEN;
		this.readyState = CLOSED;
		this.stopP2P();
		this.session?.dispose();
		if (!wasOpen && !this.closedByUser) this.onerror?.({ message: reason });
		this.onclose?.({ code, reason });
	}

	send(data: string): void {
		if (this.readyState !== OPEN || !this.session) throw new Error("Socket is not open");
		this.session.send(data);
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === CLOSED || this.readyState === CLOSING) return;
		this.closedByUser = true;
		this.race?.cancel();
		this.stopP2P();
		const session = this.session;
		if (session) {
			this.readyState = CLOSING;
			const others = [...this.paths.entries()].filter(([path]) => path !== session.path);
			for (const [path, closeOther] of others) {
				this.paths.delete(path);
				closeOther();
			}
			const closeActive = this.paths.get(session.path);
			if (!closeActive) {
				this.finish(code, reason);
				return;
			}
			if (this.route?.kind === "p2p") {
				try {
					session.sendControl({ c: "close", code, reason });
				} catch {
					// Already gone.
				}
			}
			closeActive(code, reason);
			// Data channels do not report a close we started; do not leave the client waiting.
			if (this.route?.kind === "p2p") this.pathClosed(session.path, code, reason);
		} else {
			this.finish(code, reason);
		}
	}
}

/**
 * `createWebSocket` factory for `PierClient` that connects through the secure channel.
 * The `url` passed by the client is ignored; the factory remembers which address
 * worked last and tries it first on reconnect.
 */
export function createSecureSocketFactory(options: SecureSocketOptions): WebSocketFactory {
	let preferred: string | undefined;
	return () => {
		const addresses = preferred
			? [preferred, ...options.addresses.filter((a) => a !== preferred)]
			: [...options.addresses];
		return new SecureWebSocket({
			...options,
			addresses,
			onConnected: (address) => {
				preferred = address;
				options.onConnected?.(address);
			},
		});
	};
}

// ---- pairing --------------------------------------------------------------------------

export interface PairingOutcome {
	deviceId: string;
	hostId: string;
	hostName: string;
	hostPublicKey: Uint8Array;
	addresses: string[];
	/** Relays the host is registered with (from the pairing code). */
	relays: string[];
	/** The address pairing succeeded on (try it first); `undefined` when it went through a relay. */
	address: string | undefined;
	/** How pairing reached the host. */
	route: ConnectionRoute;
}

export type PairingPhase = "connecting" | "waitingForApproval";

export interface PairOptions {
	info: PairingInfo;
	deviceKeyPair: KeyPair;
	device: DeviceDescription;
	createWebSocket?: WebSocketFactory;
	openTimeoutMs?: number;
	/** Start trying relays this long after the direct addresses (default 1.5 s). */
	relayDelayMs?: number;
	/** Overall limit including waiting for the desktop user (default 3 minutes). */
	timeoutMs?: number;
	onPhase?: (phase: PairingPhase) => void;
}

/**
 * Pair with a host from a scanned pairing code: connect (directly, or through one of its
 * relays), run Noise XX (verifying the host key from the QR code), send the one-time code,
 * and wait for the desktop user. Rejects with a {@link ChannelError} (`PAIRING_INVALID`,
 * `PAIRING_REJECTED`, ...) or a network error.
 */
export async function pairWithHost(options: PairOptions): Promise<PairingOutcome> {
	const factory = options.createWebSocket ?? defaultFactory();
	const { info } = options;
	const relays = info.relays ?? [];
	options.onPhase?.("connecting");
	const race = new CandidateRace(
		candidates(info.addresses, relays, info.hostPublicKey, options.relayDelayMs ?? 1500),
		factory,
		options.openTimeoutMs ?? 4000,
	);
	let lastError: unknown;
	try {
		for (;;) {
			const opened = await race.take();
			if (!opened) break;
			race.cancel();
			const { route } = opened.candidate;
			// Pairing codes are single-use once the host saw them, so the first route that opens is final.
			const result = await runPairing(opened.socket, options, route);
			if (!result.ok) throw new ChannelError(result.code, result.message);
			const address = route.kind === "direct" ? route.address : undefined;
			return {
				deviceId: result.deviceId,
				hostId: result.hostId,
				hostName: result.hostName,
				hostPublicKey: info.hostPublicKey,
				addresses: address ? [address, ...info.addresses.filter((a) => a !== address)] : [...info.addresses],
				relays: [...relays],
				address,
				route,
			};
		}
		lastError = new Error(race.summary());
	} finally {
		race.cancel();
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function runPairing(socket: WebSocketLike, options: PairOptions, route: ConnectionRoute): Promise<PairResult> {
	const initiator = new PairInitiator({
		deviceKeyPair: options.deviceKeyPair,
		expectedHostKey: options.info.hostPublicKey,
		code: options.info.code,
		device: options.device,
	});
	return new Promise<PairResult>((resolve, reject) => {
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
			try {
				socket.close(1000, "Pairing finished");
			} catch {
				// Ignore.
			}
		};
		const timer = setTimeout(
			() => done(() => reject(new ChannelError("PAIRING_TIMEOUT", "Pairing timed out"))),
			options.timeoutMs ?? 3 * 60_000,
		);
		socket.onmessage = (event) => {
			try {
				const step = initiator.receive(String(event.data));
				if ("send" in step) {
					socket.send(step.send);
					options.onPhase?.("waitingForApproval");
				} else {
					done(() => resolve(step.result));
				}
			} catch (error) {
				done(() => reject(error));
			}
		};
		socket.onerror = () => done(() => reject(new Error("Connection lost while pairing")));
		socket.onclose = (event) =>
			done(() => {
				const relayText = route.kind === "relay" ? relayCloseText(event.code, event.reason) : undefined;
				reject(new Error(relayText ?? `Connection closed while pairing${event.reason ? `: ${event.reason}` : ""}`));
			});
		try {
			socket.send(initiator.start());
		} catch (error) {
			done(() => reject(error));
		}
	});
}

export { CLOSED as SOCKET_CLOSED, OPEN as SOCKET_OPEN };
