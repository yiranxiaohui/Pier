/**
 * Pier Relay: forwards end-to-end encrypted channel frames between devices and Pier hosts
 * that cannot reach each other directly, and answers STUN so they can try a peer-to-peer
 * path first. See `packages/crypto/src/relay.ts` for the wire format.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
	createRelayChallenge,
	equalBytes,
	fromBase64Url,
	type IceServer,
	RELAY_CLOSE,
	RELAY_PROTOCOL_VERSION,
	type RelayErrorCode,
	type RelayMode,
	type RelayRegisterMessage,
	type RelayServerMessage,
	toBase64Url,
	utf8Encode,
} from "@pier/crypto";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { createAdmin, type RelayAdmin } from "./admin.ts";
import { type RelaySettings, RelayStore, type TokenOwner } from "./store.ts";
import { type StunServer, startStunServer } from "./stun.ts";

export type { RegistrationPolicy, RelaySettings } from "./store.ts";

export const RELAY_VERSION = "0.2.38";

export interface RelayServerOptions {
	/** TCP port for HTTP / WebSocket (default 7480; 0 picks a free port). */
	port?: number;
	/** Interface to bind (default: all). */
	host?: string;
	/** `private` (hosts need a token) or `open` (any host may register). */
	mode: RelayMode;
	/** Access tokens accepted from hosts in private mode. */
	tokens?: string[];
	/** UDP port of the built-in STUN server (default 3478; `false` turns it off). */
	stunPort?: number | false;
	/**
	 * Name or IP clients reach this server at, for the STUN URL announced to hosts. By default
	 * the `Host` header of each host's connection is used.
	 */
	publicHost?: string;
	/** More STUN / TURN servers to announce to hosts (e.g. a public STUN server). */
	iceServers?: IceServer[];
	/** Registered hosts at most (default 10 000 in private mode, 1000 in open mode). */
	maxHosts?: number;
	/** Concurrent device connections per host (default 32). */
	maxStreamsPerHost?: number;
	/** Connection attempts per client IP per minute (default 120). */
	connectsPerMinute?: number;
	/** Bytes per second per connection and direction, 0 for no limit (default: 0 private, 2 MiB/s open). */
	bytesPerSecond?: number;
	/** Take the client address from `X-Forwarded-For` / `X-Real-IP` (behind a reverse proxy). */
	trustProxy?: boolean;
	/** How long a host has to pick up a device connection (default 10 s). */
	acceptTimeoutMs?: number;
	/** Ping interval for dead-connection detection (default 30 s). */
	heartbeatMs?: number;
	/**
	 * Directory for the admin panel's data (accounts, their access tokens, settings changed in
	 * the panel). Turns on the web admin panel at `/` and account tokens; settings saved there
	 * take precedence over these options.
	 */
	dataDir?: string;
	log?: (message: string) => void;
}

/** Public STUN fallbacks announced when no extra ICE servers were configured. */
export const DEFAULT_ICE_SERVER_URLS = [
	"stun:stun.miwifi.com:3478",
	"stun:stun.qq.com:3478",
	"stun:stun.l.google.com:19302",
	"stun:stun.cloudflare.com:3478",
	"stun:global.stun.twilio.com:3478",
] as const;

/** How a registered computer was let in. */
export type HostVia = "open" | "static" | "account";

export interface RelayHostInfo {
	/** The computer's public key (base64url). */
	key: string;
	address: string;
	connectedAt: number;
	/** Device connections through the relay right now. */
	streams: number;
	/** `static`: a token from the command line; `account`: an account's token; `open`: none. */
	via: HostVia;
	tokenId?: string;
	userId?: string;
}

export interface RelayServer {
	/** `ws://host:port` of the listener. */
	url: string;
	port: number;
	/** UDP port of the STUN server, if running. */
	stunPort: number | undefined;
	stats(): { hosts: number; streams: number };
	/** Current settings (changed with `configure` or in the admin panel). */
	settings(): RelaySettings;
	/** Change settings while running; computers no longer allowed in are disconnected. */
	configure(change: Partial<RelaySettings>): RelaySettings;
	/** Registered computers. */
	hosts(): RelayHostInfo[];
	/** Disconnect one registered computer and all of its relay streams. */
	kickHost(key: string): boolean;
	close(): Promise<void>;
}

/** Frames up to the Pier limit (64 MiB) plus base64 and JSON overhead. */
const MAX_PAYLOAD = 96 * 1024 * 1024;
/** Control messages on `/v1/host` are tiny. */
const MAX_CONTROL_PAYLOAD = 16 * 1024;
/** What a device may send before its host picked up the connection (the handshake hello). */
const MAX_EARLY_BYTES = 256 * 1024;
/** Pause the sending side while the other side has this much queued. */
const HIGH_WATER = 8 * 1024 * 1024;
const REGISTER_TIMEOUT_MS = 10_000;

interface HostEntry {
	key: string;
	socket: WebSocket;
	address: string;
	host: string | undefined;
	streams: Set<Stream>;
	connectedAt: number;
	via: HostVia;
	owner?: TokenOwner;
}

interface Stream {
	id: string;
	host: HostEntry;
	device: WebSocket;
	hostSocket?: WebSocket;
	early: Array<{ data: RawData; isBinary: boolean }>;
	earlyBytes: number;
	timer: ReturnType<typeof setTimeout>;
	closed: boolean;
}

function constantTimeEqual(a: string, b: string): boolean {
	return equalBytes(utf8Encode(a), utf8Encode(b));
}

/** Close codes that may be sent in a close frame; others are replaced. */
function sendableCode(code: number): number {
	if (code === 1000 || code === 1001 || (code >= 1002 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
	if (code >= 3000 && code <= 4999) return code;
	return 1001;
}

function closeQuietly(socket: WebSocket | undefined, code: number, reason: string): void {
	if (!socket) return;
	try {
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
			socket.close(sendableCode(code), reason.slice(0, 120));
		}
	} catch {
		socket.terminate();
	}
}

function refuseUpgrade(socket: Socket, status: number, message: string): void {
	try {
		socket.write(
			`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
		);
	} catch {
		// Ignore.
	}
	socket.destroy();
}

/** Per-key event counter over a sliding minute. */
class RateLimiter {
	private readonly hits = new Map<string, number[]>();
	private readonly sweep: ReturnType<typeof setInterval>;

	constructor(public perMinute: number) {
		this.sweep = setInterval(() => {
			const cutoff = Date.now() - 60_000;
			for (const [key, times] of this.hits) {
				const kept = times.filter((t) => t > cutoff);
				if (kept.length) this.hits.set(key, kept);
				else this.hits.delete(key);
			}
		}, 60_000);
		this.sweep.unref?.();
	}

	allow(key: string): boolean {
		if (this.perMinute <= 0) return true;
		const now = Date.now();
		const times = (this.hits.get(key) ?? []).filter((t) => t > now - 60_000);
		if (times.length >= this.perMinute) {
			this.hits.set(key, times);
			return false;
		}
		times.push(now);
		this.hits.set(key, times);
		return true;
	}

	stop(): void {
		clearInterval(this.sweep);
	}
}

/** Pipe messages from `from` to `to` with backpressure and an optional rate limit (read per message). */
function pipe(from: WebSocket, to: WebSocket, rate: () => number): void {
	let windowStart = Date.now();
	let windowBytes = 0;
	let paused = false;
	let throttle: ReturnType<typeof setTimeout> | undefined;
	const resume = () => {
		if (!paused) return;
		if (to.bufferedAmount > HIGH_WATER / 2) return;
		if (throttle) return;
		paused = false;
		from.resume();
	};
	from.on("message", (data, isBinary) => {
		if (to.readyState !== WebSocket.OPEN) return;
		const size = Array.isArray(data)
			? data.reduce((n, b) => n + b.length, 0)
			: (data as Buffer | ArrayBuffer).byteLength;
		to.send(data, { binary: isBinary }, () => resume());
		const bytesPerSecond = rate();
		if (bytesPerSecond > 0) {
			const now = Date.now();
			if (now - windowStart >= 1000) {
				windowStart = now;
				windowBytes = 0;
			}
			windowBytes += size;
			if (windowBytes > bytesPerSecond && !throttle) {
				paused = true;
				from.pause();
				throttle = setTimeout(
					() => {
						throttle = undefined;
						windowStart = Date.now();
						windowBytes = 0;
						resume();
					},
					Math.max(10, 1000 - (now - windowStart)),
				);
			}
		}
		if (to.bufferedAmount > HIGH_WATER && !paused) {
			paused = true;
			from.pause();
		}
	});
	from.on("close", () => {
		if (throttle) clearTimeout(throttle);
	});
}

/** Defaults that depend on the mode. */
export const MODE_DEFAULTS = {
	private: { maxHosts: 10_000, bytesPerSecond: 0 },
	open: { maxHosts: 1000, bytesPerSecond: 2 * 1024 * 1024 },
} as const;

function initialSettings(options: RelayServerOptions): RelaySettings {
	const iceServers = options.iceServers ?? DEFAULT_ICE_SERVER_URLS.map((urls) => ({ urls }));
	return {
		mode: options.mode,
		maxHosts: options.maxHosts ?? null,
		maxStreamsPerHost: options.maxStreamsPerHost ?? 32,
		bytesPerSecond: options.bytesPerSecond ?? null,
		connectsPerMinute: options.connectsPerMinute ?? 120,
		publicHost: options.publicHost ?? null,
		iceServers: iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])),
	};
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
	const log = options.log ?? (() => {});
	const tokens = (options.tokens ?? []).map((t) => t.trim()).filter(Boolean);
	const store = options.dataDir ? await RelayStore.open(options.dataDir) : undefined;
	let settings: RelaySettings = store?.settings
		? { ...initialSettings(options), ...store.settings }
		: initialSettings(options);
	if (store?.settings) log(`using the settings saved in the admin panel (${settings.mode} mode)`);
	if (settings.mode === "private" && !tokens.length && !store) {
		throw new Error("Private mode needs at least one access token");
	}
	const maxHosts = () => settings.maxHosts ?? MODE_DEFAULTS[settings.mode].maxHosts;
	const bytesPerSecond = () => settings.bytesPerSecond ?? MODE_DEFAULTS[settings.mode].bytesPerSecond;
	const acceptTimeoutMs = options.acceptTimeoutMs ?? 10_000;
	const limiter = new RateLimiter(settings.connectsPerMinute);
	const startedAt = Date.now();
	const hosts = new Map<string, HostEntry>();
	const pending = new Map<string, Stream>();
	let streamCount = 0;

	const stun: StunServer | undefined =
		options.stunPort === false ? undefined : await startStunServer({ port: options.stunPort ?? 3478 });

	const clientAddress = (req: IncomingMessage): string => {
		if (options.trustProxy) {
			const forwarded = String(req.headers["x-forwarded-for"] ?? "")
				.split(",")[0]
				?.trim();
			const real = String(req.headers["x-real-ip"] ?? "").trim();
			if (forwarded) return forwarded;
			if (real) return real;
		}
		return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
	};

	/** STUN URL for a host that reached us at `hostHeader`. */
	const iceServersFor = (hostHeader: string | undefined): IceServer[] => {
		const servers: IceServer[] = [];
		if (stun) {
			const name = settings.publicHost ?? hostHeader?.replace(/:\d+$/, "");
			if (name) servers.push({ urls: `stun:${name}:${stun.port}` });
		}
		return [...servers, ...settings.iceServers.map((urls) => ({ urls }))];
	};

	let admin: RelayAdmin | undefined;
	const server: Server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		if (path.endsWith("/health")) {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify({ ok: true, service: "pier-relay", version: RELAY_VERSION, mode: settings.mode }));
			return;
		}
		if (admin) {
			admin.handle(req, res, path).catch((error: unknown) => {
				log(`admin: ${error instanceof Error ? error.message : String(error)}`);
				if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "服务器内部错误" }));
			});
			return;
		}
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(`Pier Relay ${RELAY_VERSION} (${settings.mode} mode)\n`);
	});
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
	const controlWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_CONTROL_PAYLOAD });

	// ---- heartbeat ---------------------------------------------------------------------------
	const alive = new WeakSet<WebSocket>();
	const heartbeat = setInterval(() => {
		for (const socket of [...wss.clients, ...controlWss.clients]) {
			if (!alive.has(socket)) {
				socket.terminate();
				continue;
			}
			alive.delete(socket);
			try {
				socket.ping();
			} catch {
				// Closing.
			}
		}
	}, options.heartbeatMs ?? 30_000);
	heartbeat.unref?.();
	const track = (socket: WebSocket) => {
		alive.add(socket);
		socket.on("pong", () => alive.add(socket));
	};

	// ---- hosts ----------------------------------------------------------------------------
	const sendControl = (socket: WebSocket, message: RelayServerMessage) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};
	const refuseHost = (socket: WebSocket, code: RelayErrorCode, message: string, closeCode: number) => {
		sendControl(socket, { t: "error", code, message });
		closeQuietly(socket, closeCode, code);
	};

	const onHost = (socket: WebSocket, req: IncomingMessage) => {
		track(socket);
		const address = clientAddress(req);
		const challenge = createRelayChallenge();
		let entry: HostEntry | undefined;
		const timer = setTimeout(() => {
			if (!entry) refuseHost(socket, "BAD_REQUEST", "Registration timed out", RELAY_CLOSE.badRequest);
		}, REGISTER_TIMEOUT_MS);
		timer.unref?.();
		sendControl(socket, {
			t: "challenge",
			v: RELAY_PROTOCOL_VERSION,
			mode: settings.mode,
			nonce: challenge.nonce,
			ek: challenge.ek,
		});
		socket.on("message", (data, isBinary) => {
			if (entry || isBinary) return;
			let message: Partial<RelayRegisterMessage>;
			try {
				message = JSON.parse(data.toString()) as Partial<RelayRegisterMessage>;
			} catch {
				refuseHost(socket, "BAD_REQUEST", "Malformed message", RELAY_CLOSE.badRequest);
				return;
			}
			if (message.t !== "register" || typeof message.pk !== "string" || typeof message.proof !== "string") {
				refuseHost(socket, "BAD_REQUEST", "Expected register", RELAY_CLOSE.badRequest);
				return;
			}
			if (message.v !== RELAY_PROTOCOL_VERSION) {
				refuseHost(socket, "UNSUPPORTED_VERSION", "Unsupported relay protocol version", RELAY_CLOSE.badRequest);
				return;
			}
			const key = challenge.verify(message.pk, message.proof);
			if (!key) {
				refuseHost(socket, "UNAUTHORIZED", "Key proof failed", RELAY_CLOSE.unauthorized);
				return;
			}
			// A token counts in open mode too: it ties the computer to an account.
			const token = typeof message.token === "string" ? message.token.trim() : "";
			const isStatic = !!token && tokens.some((t) => constantTimeEqual(t, token));
			const owner = token && !isStatic ? store?.resolveToken(token, address) : undefined;
			const via: HostVia = isStatic ? "static" : owner ? "account" : "open";
			if (settings.mode === "private" && via === "open") {
				log(`host from ${address}: ${token ? "wrong" : "missing"} access token`);
				refuseHost(socket, "UNAUTHORIZED", "Wrong or missing access token", RELAY_CLOSE.unauthorized);
				return;
			}
			const id = toBase64Url(key);
			const previous = hosts.get(id);
			if (!previous && hosts.size >= maxHosts()) {
				refuseHost(socket, "LIMIT", "Too many hosts on this relay", RELAY_CLOSE.limit);
				return;
			}
			clearTimeout(timer);
			if (previous) {
				hosts.delete(id);
				closeQuietly(previous.socket, RELAY_CLOSE.replaced, "Replaced by a newer connection");
			}
			entry = {
				key: id,
				socket,
				address,
				host: req.headers.host,
				streams: previous?.streams ?? new Set(),
				connectedAt: Date.now(),
				via,
				...(owner ? { owner } : {}),
			};
			for (const stream of entry.streams) stream.host = entry;
			hosts.set(id, entry);
			sendControl(socket, { t: "registered", mode: settings.mode, iceServers: iceServersFor(req.headers.host) });
			log(`host ${id.slice(0, 8)}… registered from ${address} (${hosts.size} online)`);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			if (entry && hosts.get(entry.key) === entry) {
				hosts.delete(entry.key);
				// Device connections waiting for this host cannot be picked up any more.
				for (const stream of [...entry.streams]) {
					if (!stream.hostSocket) endStream(stream, RELAY_CLOSE.hostOffline, "HOST_OFFLINE");
				}
				log(`host ${entry.key.slice(0, 8)}… went offline (${hosts.size} online)`);
			}
		});
		socket.on("error", () => {});
	};

	// ---- device streams -------------------------------------------------------------------
	const endStream = (stream: Stream, code: number, reason: string) => {
		if (stream.closed) return;
		stream.closed = true;
		clearTimeout(stream.timer);
		pending.delete(stream.id);
		stream.host.streams.delete(stream);
		streamCount -= 1;
		closeQuietly(stream.device, code, reason);
		closeQuietly(stream.hostSocket, code, reason);
	};
	const kickHost = (key: string): boolean => {
		const entry = hosts.get(key);
		if (!entry) return false;
		hosts.delete(key);
		for (const stream of [...entry.streams]) endStream(stream, 1000, "Kicked by administrator");
		closeQuietly(entry.socket, 1000, "Kicked by administrator");
		log(`disconnected computer ${key.slice(0, 8)}… by administrator (${hosts.size} online)`);
		return true;
	};

	const onDevice = (socket: WebSocket, req: IncomingMessage, host: HostEntry) => {
		track(socket);
		const id = toBase64Url(randomBytes(18));
		const stream: Stream = {
			id,
			host,
			device: socket,
			early: [],
			earlyBytes: 0,
			closed: false,
			timer: setTimeout(() => endStream(stream, RELAY_CLOSE.acceptTimeout, "ACCEPT_TIMEOUT"), acceptTimeoutMs),
		};
		stream.timer.unref?.();
		streamCount += 1;
		host.streams.add(stream);
		pending.set(id, stream);
		const early = (data: RawData, isBinary: boolean) => {
			if (stream.hostSocket) return;
			const size = (data as Buffer).byteLength ?? 0;
			stream.earlyBytes += size;
			if (stream.earlyBytes > MAX_EARLY_BYTES) {
				endStream(stream, RELAY_CLOSE.limit, "Too much data before the host answered");
				return;
			}
			stream.early.push({ data, isBinary });
		};
		socket.on("message", early);
		socket.on("close", (code, reason) => {
			if (stream.closed) return;
			stream.closed = true;
			clearTimeout(stream.timer);
			pending.delete(id);
			stream.host.streams.delete(stream);
			streamCount -= 1;
			closeQuietly(stream.hostSocket, code, reason.toString());
		});
		socket.on("error", () => {});
		sendControl(host.socket, { t: "incoming", id, addr: clientAddress(req) });
	};

	const onAccept = (socket: WebSocket, stream: Stream) => {
		track(socket);
		pending.delete(stream.id);
		clearTimeout(stream.timer);
		stream.hostSocket = socket;
		for (const { data, isBinary } of stream.early.splice(0)) socket.send(data, { binary: isBinary });
		stream.earlyBytes = 0;
		pipe(stream.device, socket, bytesPerSecond);
		pipe(socket, stream.device, bytesPerSecond);
		socket.on("close", (code, reason) => {
			if (stream.closed) return;
			stream.closed = true;
			stream.host.streams.delete(stream);
			streamCount -= 1;
			closeQuietly(stream.device, code, reason.toString());
		});
		socket.on("error", () => {});
	};

	server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
		socket.on("error", () => {});
		const [rawPath = "/", query = ""] = (req.url ?? "/").split("?");
		const path = rawPath.replace(/\/+$/, "");
		const params = new URLSearchParams(query);
		const address = clientAddress(req);
		if (path.endsWith("/v1/host")) {
			if (!limiter.allow(`h:${address}`)) return refuseUpgrade(socket, 429, "Too Many Requests");
			controlWss.handleUpgrade(req, socket, head, (ws) => onHost(ws, req));
			return;
		}
		if (path.endsWith("/v1/connect")) {
			if (!limiter.allow(`d:${address}`)) return refuseUpgrade(socket, 429, "Too Many Requests");
			const key = params.get("host") ?? "";
			let valid = false;
			try {
				valid = fromBase64Url(key).length === 32;
			} catch {
				valid = false;
			}
			if (!valid) return refuseUpgrade(socket, 400, "Bad Request");
			const host = hosts.get(key);
			if (!host) return refuseUpgrade(socket, 404, "Host Offline");
			if (host.streams.size >= settings.maxStreamsPerHost) return refuseUpgrade(socket, 503, "Too Many Connections");
			wss.handleUpgrade(req, socket, head, (ws) => onDevice(ws, req, host));
			return;
		}
		if (path.endsWith("/v1/accept")) {
			const stream = pending.get(params.get("id") ?? "");
			if (!stream || stream.closed) return refuseUpgrade(socket, 404, "Not Found");
			// Only the host that was told about the connection can pick it up: the id is secret,
			// random and only sent over its authenticated control socket.
			pending.delete(stream.id);
			wss.handleUpgrade(req, socket, head, (ws) => {
				if (stream.closed) {
					closeQuietly(ws, 1001, "Device went away");
					return;
				}
				onAccept(ws, stream);
			});
			return;
		}
		refuseUpgrade(socket, 404, "Not Found");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 7480, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	let closing: Promise<void> | undefined;
	const shown = options.host && options.host !== "::" && options.host !== "0.0.0.0" ? options.host : "127.0.0.1";
	log(
		`listening on port ${port} (${settings.mode} mode${stun ? `, STUN on udp ${stun.port}` : ""}${bytesPerSecond() ? `, ${bytesPerSecond()} B/s per connection` : ""}${store ? ", admin panel on" : ""})`,
	);

	/** Whether a registered computer may stay under the current settings and accounts. */
	const allowed = (entry: HostEntry): boolean => {
		if (settings.mode === "open" || entry.via === "static") return true;
		return entry.via === "account" && !!entry.owner && !!store?.tokenValid(entry.owner.tokenId);
	};
	/** Disconnect computers that are no longer allowed in (mode switched, token or account revoked). */
	const revalidate = (): number => {
		let dropped = 0;
		for (const entry of [...hosts.values()]) {
			if (allowed(entry)) continue;
			dropped += 1;
			refuseHost(entry.socket, "UNAUTHORIZED", "Access revoked", RELAY_CLOSE.unauthorized);
		}
		if (dropped) log(`disconnected ${dropped} computer(s) that are no longer allowed in`);
		return dropped;
	};
	const currentSettings = (): RelaySettings => ({ ...settings, iceServers: [...settings.iceServers] });
	const configure = (change: Partial<RelaySettings>): RelaySettings => {
		const previousMode = settings.mode;
		settings = { ...settings };
		for (const [name, value] of Object.entries(change)) {
			if (value !== undefined && name in settings) (settings as unknown as Record<string, unknown>)[name] = value;
		}
		settings.iceServers = [...settings.iceServers];
		limiter.perMinute = settings.connectsPerMinute;
		if (settings.mode !== previousMode) log(`switched to ${settings.mode} mode`);
		revalidate();
		return currentSettings();
	};
	const hostList = (): RelayHostInfo[] =>
		[...hosts.values()].map((entry) => ({
			key: entry.key,
			address: entry.address,
			connectedAt: entry.connectedAt,
			streams: entry.streams.size,
			via: entry.via,
			...(entry.owner ? { tokenId: entry.owner.tokenId, userId: entry.owner.userId } : {}),
		}));
	const stats = () => ({ hosts: hosts.size, streams: streamCount });

	if (store) {
		admin = createAdmin({
			store,
			log,
			trustProxy: options.trustProxy === true,
			staticTokens: tokens.length,
			stunPort: stun?.port,
			startedAt,
			version: RELAY_VERSION,
			relay: {
				settings: currentSettings,
				configure,
				hosts: hostList,
				stats,
				kickHost,
				revalidate,
				effective: () => ({ maxHosts: maxHosts(), bytesPerSecond: bytesPerSecond() }),
			},
		});
	}

	return {
		url: `ws://${shown.includes(":") ? `[${shown}]` : shown}:${port}`,
		port,
		stunPort: stun?.port,
		stats,
		settings: currentSettings,
		configure,
		hosts: hostList,
		kickHost,
		close: async () => {
			if (closing) return closing;
			closing = shutdown();
			return closing;
		},
	};

	async function shutdown(): Promise<void> {
		clearInterval(heartbeat);
		limiter.stop();
		for (const socket of [...wss.clients, ...controlWss.clients]) socket.terminate();
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
		await stun?.close();
		admin?.close();
		await store?.flush();
	}
}
