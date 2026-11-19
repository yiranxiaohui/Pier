/**
 * Pier secure channel: how a remote device and a Pier Host run Noise over WebSocket
 * text frames. See `docs/security.md` for the full description.
 *
 * Frames (JSON text):
 *   device → host  { t: "hello", v: 1, mode: "pair" | "connect", m: <base64 Noise message 1> }
 *   either         { t: "hs", m: <base64 Noise message> }            remaining handshake messages
 *   either         { t: "enc", n: <nonce>, c: <base64 ciphertext> }   after the handshake
 *   host → device  { t: "error", code, message }                      handshake refused (plaintext)
 *
 * - `pair` runs Noise XX. The device checks that the host's static key equals the one
 *   in the pairing QR code, then sends the one-time pairing code and its name in the
 *   third message. The host answers with a single encrypted {@link PairResult} and closes.
 * - `connect` runs Noise IK with the host key learned during pairing. The host accepts
 *   only registered device keys. Afterwards every Pier protocol frame travels as `enc`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, toBase32, toBase64, utf8Decode, utf8Encode } from "./bytes.ts";
import { type CipherState, equalBytes, Handshake, type HandshakeResult, type KeyPair, NoiseError } from "./noise.ts";

export const CHANNEL_VERSION = 1;

export type ChannelMode = "pair" | "connect";

export const CHANNEL_ERROR_CODES = [
	/** The device key is not registered (never paired, or revoked). The device must pair again. */
	"UNKNOWN_DEVICE",
	/** Pairing code missing, wrong, expired, or already used. */
	"PAIRING_INVALID",
	/** The desktop user declined the pairing request. */
	"PAIRING_REJECTED",
	/** Nobody answered the pairing request on the desktop in time. */
	"PAIRING_TIMEOUT",
	/** Malformed or unexpected handshake frame, or unsupported channel version. */
	"BAD_HANDSHAKE",
	/** Too many concurrent handshakes, or remote access is shutting down. */
	"UNAVAILABLE",
] as const;
export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

/** WebSocket close codes used by the remote gateway. */
export const CLOSE_CODES = {
	/** Handshake failed or was refused. */
	handshakeFailed: 4400,
	/** Device unknown or revoked; do not retry without pairing again. */
	deviceRevoked: 4403,
	/** Remote access was turned off on the host. */
	remoteDisabled: 4410,
} as const;

export class ChannelError extends Error {
	constructor(
		readonly code: ChannelErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ChannelError";
	}
}

export type ChannelFrame =
	| { t: "hello"; v: number; mode: ChannelMode; m: string }
	| { t: "hs"; m: string }
	| { t: "enc"; n: number; c: string }
	| { t: "error"; code: ChannelErrorCode; message: string };

/** Largest accepted handshake frame (handshake messages are tiny). */
export const MAX_HANDSHAKE_FRAME = 8 * 1024;

export function parseChannelFrame(raw: string): ChannelFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	switch (v.t) {
		case "hello":
			if (typeof v.v === "number" && (v.mode === "pair" || v.mode === "connect") && typeof v.m === "string") {
				return { t: "hello", v: v.v, mode: v.mode, m: v.m };
			}
			return undefined;
		case "hs":
			return typeof v.m === "string" ? { t: "hs", m: v.m } : undefined;
		case "enc":
			return typeof v.n === "number" && Number.isSafeInteger(v.n) && typeof v.c === "string"
				? { t: "enc", n: v.n, c: v.c }
				: undefined;
		case "error":
			return typeof v.code === "string" &&
				(CHANNEL_ERROR_CODES as readonly string[]).includes(v.code) &&
				typeof v.message === "string"
				? { t: "error", code: v.code as ChannelErrorCode, message: v.message }
				: undefined;
		default:
			return undefined;
	}
}

export function errorFrame(code: ChannelErrorCode, message: string): string {
	return JSON.stringify({ t: "error", code, message } satisfies ChannelFrame);
}

function prologue(mode: ChannelMode): Uint8Array {
	return utf8Encode(`pier-channel/${CHANNEL_VERSION} ${mode}`);
}

function decodeMessage(m: string): Uint8Array {
	try {
		return fromBase64(m);
	} catch {
		throw new ChannelError("BAD_HANDSHAKE", "Handshake message is not valid base64");
	}
}

function asJson(bytes: Uint8Array): unknown {
	if (!bytes.length) return undefined;
	try {
		return JSON.parse(utf8Decode(bytes));
	} catch {
		throw new ChannelError("BAD_HANDSHAKE", "Handshake payload is not JSON");
	}
}

function wrapNoise<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof ChannelError) throw error;
		if (error instanceof NoiseError) throw new ChannelError("BAD_HANDSHAKE", error.message);
		throw error;
	}
}

/** Short, human-comparable fingerprint of a static public key, e.g. `K7QF-2M4A-XJ3D-9PLR`. */
export function keyFingerprint(publicKey: Uint8Array): string {
	const text = toBase32(sha256(publicKey).subarray(0, 10));
	return text.match(/.{1,4}/g)?.join("-") ?? text;
}

/**
 * Encrypted transport after a completed handshake. Every Pier frame becomes one
 * `enc` frame; nonces are implicit counters, carried in `n` to detect loss or reordering.
 *
 * Unlike raw Noise transport messages, a frame is not limited to 65535 bytes: the
 * ChaCha20-Poly1305 keys from `Split()` encrypt each whole frame (images travel inline).
 */
export class SecureTransport {
	private readonly send: CipherState;
	private readonly receive: CipherState;
	readonly handshakeHash: Uint8Array;
	readonly remoteStaticKey: Uint8Array;

	constructor(result: HandshakeResult) {
		this.send = result.send;
		this.receive = result.receive;
		this.handshakeHash = result.handshakeHash;
		this.remoteStaticKey = result.remoteStaticKey;
	}

	/** Nonce the next `enc` frame from the other side must carry. */
	get receiveNonce(): number {
		return this.receive.nonce;
	}

	/** Encrypt a text message into an `enc` frame. */
	seal(plaintext: string): string {
		return this.sealBytes(utf8Encode(plaintext));
	}

	/** Encrypt raw plaintext bytes into an `enc` frame (see `SecureSession` for compressed frames). */
	sealBytes(plaintext: Uint8Array): string {
		const n = this.send.nonce;
		const c = this.send.encryptWithAd(new Uint8Array(0), plaintext);
		return JSON.stringify({ t: "enc", n, c: toBase64(c) });
	}

	/** Decrypt an `enc` frame. Throws on tampering, replay, reordering or a non-`enc` frame. */
	open(raw: string): string {
		const frame = parseChannelFrame(raw);
		if (!frame) throw new ChannelError("BAD_HANDSHAKE", "Invalid channel frame");
		return this.openFrame(frame);
	}

	/** {@link open} for an already parsed frame. */
	openFrame(frame: ChannelFrame): string {
		return utf8Decode(this.openFrameBytes(frame));
	}

	/** {@link openFrame}, returning the plaintext bytes. */
	openFrameBytes(frame: ChannelFrame): Uint8Array {
		if (frame.t === "error") throw new ChannelError(frame.code, frame.message);
		if (frame.t !== "enc") throw new ChannelError("BAD_HANDSHAKE", `Unexpected ${frame.t} frame`);
		if (frame.n !== this.receive.nonce) throw new ChannelError("BAD_HANDSHAKE", "Unexpected frame nonce");
		let bytes: Uint8Array;
		try {
			bytes = fromBase64(frame.c);
		} catch {
			throw new ChannelError("BAD_HANDSHAKE", "Ciphertext is not valid base64");
		}
		return wrapNoise(() => this.receive.decryptWithAd(new Uint8Array(0), bytes));
	}
}

// ---- pairing payloads -------------------------------------------------------------------

export interface DeviceDescription {
	name: string;
	platform?: string;
	model?: string;
	appVersion?: string;
}

/** Sent by the device in the third XX message. */
export interface PairRequest {
	v: number;
	code: string;
	device: DeviceDescription;
}

/** Sent by the host (encrypted, XX message 2 payload). */
export interface PairHostHello {
	hostId: string;
	hostName: string;
}

export type PairResult =
	| { ok: true; deviceId: string; hostId: string; hostName: string }
	| { ok: false; code: ChannelErrorCode; message: string };

function parsePairRequest(value: unknown): PairRequest {
	const v = value as Partial<PairRequest> | undefined;
	const device = v?.device as Partial<DeviceDescription> | undefined;
	if (
		!v ||
		typeof v.code !== "string" ||
		v.code.length > 256 ||
		!device ||
		typeof device.name !== "string" ||
		!device.name.trim() ||
		device.name.length > 100
	) {
		throw new ChannelError("PAIRING_INVALID", "Malformed pairing request");
	}
	const text = (x: unknown, max: number) => (typeof x === "string" && x.length <= max ? x : undefined);
	const platform = text(device.platform, 50);
	const model = text(device.model, 100);
	const appVersion = text(device.appVersion, 50);
	return {
		v: typeof v.v === "number" ? v.v : CHANNEL_VERSION,
		code: v.code,
		device: {
			name: device.name.trim(),
			...(platform ? { platform } : {}),
			...(model ? { model } : {}),
			...(appVersion ? { appVersion } : {}),
		},
	};
}

// ---- device (initiator) side -------------------------------------------------------------

/**
 * Capabilities exchanged in the IK handshake payloads (encrypted and authenticated). Older
 * hosts and devices send empty payloads and ignore the other side's, so both only use a
 * feature when the other side announced it.
 */
export interface ConnectHello {
	/** `ctl`: understands control frames inside the channel (see `session.ts`). */
	caps?: string[];
	/** Host only: this connection may move to a peer-to-peer path; the ICE servers to use. */
	p2p?: { iceServers: IceServer[] };
}

/** A STUN / TURN server for WebRTC ICE (the W3C `RTCIceServer` shape). */
export interface IceServer {
	urls: string | string[];
	username?: string;
	credential?: string;
}

function parseConnectHello(value: unknown): ConnectHello {
	if (!value || typeof value !== "object") return {};
	const v = value as Record<string, unknown>;
	const caps = Array.isArray(v.caps) ? v.caps.filter((c): c is string => typeof c === "string").slice(0, 32) : [];
	const out: ConnectHello = { caps };
	const p2p = v.p2p as { iceServers?: unknown } | undefined;
	if (p2p && typeof p2p === "object" && Array.isArray(p2p.iceServers)) {
		const iceServers: IceServer[] = [];
		for (const s of p2p.iceServers.slice(0, 8)) {
			const server = s as Partial<IceServer> | undefined;
			const urls = typeof server?.urls === "string" ? [server.urls] : server?.urls;
			if (!Array.isArray(urls)) continue;
			const valid = urls.filter((u): u is string => typeof u === "string" && /^(stun|stuns|turn|turns):/i.test(u));
			if (!valid.length) continue;
			iceServers.push({
				urls: valid,
				...(typeof server?.username === "string" ? { username: server.username } : {}),
				...(typeof server?.credential === "string" ? { credential: server.credential } : {}),
			});
		}
		out.p2p = { iceServers };
	}
	return out;
}

/** Device side of `connect` (Noise IK). */
export class ConnectInitiator {
	private readonly handshake: Handshake;
	private readonly payload: ConnectHello | undefined;
	/** What the host announced in its handshake reply (empty for older hosts). */
	hostHello: ConnectHello = {};

	constructor(options: { deviceKeyPair: KeyPair; hostPublicKey: Uint8Array; hello?: ConnectHello }) {
		this.payload = options.hello;
		this.handshake = wrapNoise(
			() =>
				new Handshake({
					pattern: "IK",
					initiator: true,
					prologue: prologue("connect"),
					staticKeyPair: options.deviceKeyPair,
					remoteStaticKey: options.hostPublicKey,
				}),
		);
	}

	/** First frame to send after the socket opens. */
	start(): string {
		const payload = this.payload;
		const m = wrapNoise(() =>
			this.handshake.writeMessage(payload ? utf8Encode(JSON.stringify(payload)) : new Uint8Array(0)),
		);
		return JSON.stringify({ t: "hello", v: CHANNEL_VERSION, mode: "connect", m: toBase64(m) } satisfies ChannelFrame);
	}

	/** Handle the host's reply; returns the established transport. */
	receive(raw: string): SecureTransport {
		const frame = parseChannelFrame(raw);
		if (frame?.t === "error") throw new ChannelError(frame.code, frame.message);
		if (frame?.t !== "hs") throw new ChannelError("BAD_HANDSHAKE", "Expected a handshake frame");
		const payload = wrapNoise(() => this.handshake.readMessage(decodeMessage(frame.m)));
		try {
			this.hostHello = parseConnectHello(asJson(payload));
		} catch {
			this.hostHello = {};
		}
		return new SecureTransport(wrapNoise(() => this.handshake.finish()));
	}
}

/** Device side of `pair` (Noise XX). */
export class PairInitiator {
	private readonly handshake: Handshake;
	private transport: SecureTransport | undefined;
	hostHello: PairHostHello | undefined;

	constructor(
		private readonly options: {
			deviceKeyPair: KeyPair;
			/** Host static key from the pairing QR code. */
			expectedHostKey: Uint8Array;
			code: string;
			device: DeviceDescription;
		},
	) {
		this.handshake = new Handshake({
			pattern: "XX",
			initiator: true,
			prologue: prologue("pair"),
			staticKeyPair: options.deviceKeyPair,
		});
	}

	start(): string {
		const m = wrapNoise(() => this.handshake.writeMessage());
		return JSON.stringify({ t: "hello", v: CHANNEL_VERSION, mode: "pair", m: toBase64(m) } satisfies ChannelFrame);
	}

	/**
	 * Feed a frame from the host. Returns the frame to send next (message 3), or the
	 * final pairing result once it arrives.
	 */
	receive(raw: string): { send: string } | { result: PairResult } {
		const frame = parseChannelFrame(raw);
		if (frame?.t === "error") throw new ChannelError(frame.code, frame.message);
		if (!this.transport) {
			if (frame?.t !== "hs") throw new ChannelError("BAD_HANDSHAKE", "Expected a handshake frame");
			const payload = wrapNoise(() => this.handshake.readMessage(decodeMessage(frame.m)));
			const hostKey = this.handshake.remoteStaticKey;
			if (!hostKey || !equalBytes(hostKey, this.options.expectedHostKey)) {
				throw new ChannelError("BAD_HANDSHAKE", "Host key does not match the pairing code; possible interception");
			}
			const hello = asJson(payload) as Partial<PairHostHello> | undefined;
			if (hello && typeof hello.hostId === "string" && typeof hello.hostName === "string") {
				this.hostHello = { hostId: hello.hostId, hostName: hello.hostName };
			}
			const request: PairRequest = { v: CHANNEL_VERSION, code: this.options.code, device: this.options.device };
			const m = wrapNoise(() => this.handshake.writeMessage(utf8Encode(JSON.stringify(request))));
			this.transport = new SecureTransport(wrapNoise(() => this.handshake.finish()));
			return { send: JSON.stringify({ t: "hs", m: toBase64(m) } satisfies ChannelFrame) };
		}
		const result = JSON.parse(this.transport.open(raw)) as PairResult;
		if (typeof result !== "object" || result === null || typeof result.ok !== "boolean") {
			throw new ChannelError("BAD_HANDSHAKE", "Malformed pairing result");
		}
		return { result };
	}
}

// ---- host (responder) side ---------------------------------------------------------------

export type ResponderStep =
	/** Send `frame` and keep reading handshake frames. */
	| { kind: "continue"; frame: string }
	/** IK finished: send `frame`, then the channel carries Pier frames through `transport`. */
	| {
			kind: "connected";
			frame: string;
			transport: SecureTransport;
			remoteStaticKey: Uint8Array;
			/** What the device announced (empty for older devices). */
			deviceHello: ConnectHello;
	  }
	/** XX finished: decide, send `transport.seal(JSON.stringify(result))`, then close. */
	| { kind: "pairRequest"; transport: SecureTransport; remoteStaticKey: Uint8Array; request: PairRequest };

export interface ResponderOptions {
	hostKeyPair: KeyPair;
	hostHello: PairHostHello;
	/** IK: whether a device static key is registered. Checked before the host answers. */
	isKnownDevice(publicKey: Uint8Array): boolean;
	/** Whether pairing is currently possible (a pairing code is active). */
	pairingOpen(): boolean;
	/** IK: what to announce to a device in the handshake reply, given what it announced. */
	connectHello?(deviceHello: ConnectHello): ConnectHello | undefined;
}

/** Host side of both channel modes. Feed every incoming frame to `receive` until it returns a final step. */
export class ChannelResponder {
	private handshake: Handshake | undefined;
	private mode: ChannelMode | undefined;

	constructor(private readonly options: ResponderOptions) {}

	get channelMode(): ChannelMode | undefined {
		return this.mode;
	}

	receive(raw: string): ResponderStep {
		if (raw.length > MAX_HANDSHAKE_FRAME) throw new ChannelError("BAD_HANDSHAKE", "Handshake frame too large");
		const frame = parseChannelFrame(raw);
		if (!frame) throw new ChannelError("BAD_HANDSHAKE", "Invalid handshake frame");
		if (!this.handshake) {
			if (frame.t !== "hello") throw new ChannelError("BAD_HANDSHAKE", "Expected hello");
			if (frame.v !== CHANNEL_VERSION) {
				throw new ChannelError("BAD_HANDSHAKE", `Unsupported channel version ${frame.v}; please update Pier`);
			}
			this.mode = frame.mode;
			if (frame.mode === "connect") return this.connect(frame.m);
			if (!this.options.pairingOpen()) {
				throw new ChannelError("PAIRING_INVALID", "No pairing is in progress on the desktop");
			}
			const handshake = new Handshake({
				pattern: "XX",
				initiator: false,
				prologue: prologue("pair"),
				staticKeyPair: this.options.hostKeyPair,
			});
			this.handshake = handshake;
			wrapNoise(() => handshake.readMessage(decodeMessage(frame.m)));
			const m = wrapNoise(() => handshake.writeMessage(utf8Encode(JSON.stringify(this.options.hostHello))));
			return { kind: "continue", frame: JSON.stringify({ t: "hs", m: toBase64(m) } satisfies ChannelFrame) };
		}
		const handshake = this.handshake;
		if (this.mode !== "pair" || handshake.isComplete() || frame.t !== "hs") {
			throw new ChannelError("BAD_HANDSHAKE", "Unexpected handshake frame");
		}
		const payload = wrapNoise(() => handshake.readMessage(decodeMessage(frame.m)));
		const request = parsePairRequest(asJson(payload));
		const result = wrapNoise(() => handshake.finish());
		return {
			kind: "pairRequest",
			transport: new SecureTransport(result),
			remoteStaticKey: result.remoteStaticKey,
			request,
		};
	}

	private connect(m: string): ResponderStep {
		const handshake = new Handshake({
			pattern: "IK",
			initiator: false,
			prologue: prologue("connect"),
			staticKeyPair: this.options.hostKeyPair,
		});
		this.handshake = handshake;
		const payload = wrapNoise(() => handshake.readMessage(decodeMessage(m)));
		const deviceKey = handshake.remoteStaticKey;
		if (!deviceKey || !this.options.isKnownDevice(deviceKey)) {
			throw new ChannelError("UNKNOWN_DEVICE", "This device is not paired with the host (or was revoked)");
		}
		let deviceHello: ConnectHello = {};
		try {
			deviceHello = parseConnectHello(asJson(payload));
		} catch {
			deviceHello = {};
		}
		const hello = this.options.connectHello?.(deviceHello);
		const reply = wrapNoise(() =>
			handshake.writeMessage(hello ? utf8Encode(JSON.stringify(hello)) : new Uint8Array(0)),
		);
		const result = wrapNoise(() => handshake.finish());
		return {
			kind: "connected",
			frame: JSON.stringify({ t: "hs", m: toBase64(reply) } satisfies ChannelFrame),
			transport: new SecureTransport(result),
			remoteStaticKey: result.remoteStaticKey,
			deviceHello,
		};
	}
}
