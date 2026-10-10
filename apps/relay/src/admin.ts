/**
 * The relay's web admin panel: a single page at `<base>/` and a JSON API at `<base>/api/…`
 * (`<base>` is whatever path a reverse proxy mounts the relay under). Accounts log in with a
 * session cookie; each account creates its own access tokens for its computers, and
 * administrators approve accounts and change the relay's settings while it runs.
 *
 * Requests that change anything must carry the `X-Pier-Relay: 1` header: browsers do not send
 * custom headers cross-origin without a CORS preflight, which this API never allows, so other
 * sites cannot make a logged-in browser act on the panel (the cookie is also `SameSite=Strict`).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayMode } from "@pier/crypto";
import { adminPage } from "./admin-page.ts";
import type { RelayHostInfo } from "./server.ts";
import {
	dummyPasswordHash,
	type RegistrationPolicy,
	type RelaySettings,
	type RelayStore,
	SESSION_TTL_MS,
	type StoredToken,
	type StoredUser,
	StoreError,
	type UserRole,
	type UserStatus,
	verifyPassword,
} from "./store.ts";

export interface AdminRelayControl {
	settings(): RelaySettings;
	configure(change: Partial<RelaySettings>): RelaySettings;
	hosts(): RelayHostInfo[];
	stats(): { hosts: number; streams: number };
	/** Disconnect one registered computer and all of its relay streams. */
	kickHost(key: string): boolean;
	/** Disconnect computers whose token or account was revoked. */
	revalidate(): number;
	/** Limits in force (defaults filled in for the mode). */
	effective(): { maxHosts: number; bytesPerSecond: number };
}

export interface AdminOptions {
	store: RelayStore;
	relay: AdminRelayControl;
	log: (message: string) => void;
	trustProxy: boolean;
	/** Access tokens given on the command line (never shown). */
	staticTokens: number;
	stunPort: number | undefined;
	startedAt: number;
	version: string;
	/** Login and registration attempts per client address per minute (default 20). */
	authAttemptsPerMinute?: number;
}

export interface RelayAdmin {
	handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
	close(): void;
}

export const SESSION_COOKIE = "pier_relay_session";
const MAX_BODY = 16 * 1024;
const MODES: readonly RelayMode[] = ["private", "open"];
const POLICIES: readonly RegistrationPolicy[] = ["closed", "approval", "open"];
const ROLES: readonly UserRole[] = ["admin", "user"];
const STATUSES: readonly UserStatus[] = ["active", "pending", "disabled"];

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function cookies(req: IncomingMessage): Map<string, string> {
	const jar = new Map<string, string>();
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
	}
	return jar;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...headers,
	});
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpError(413, "请求内容过大");
		chunks.push(chunk as Buffer);
	}
	if (!size) return {};
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "请求格式错误");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "请求格式错误");
	return body as Record<string, unknown>;
}

function intOrNull(value: unknown, name: string, min: number, max: number): number | null {
	if (value === null || value === "") return null;
	return int(value, name, min, max);
}

function int(value: unknown, name: string, min: number, max: number): number {
	const n = typeof value === "string" && value.trim() ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
		throw new HttpError(400, `${name}需要是 ${min}–${max} 之间的整数`);
	}
	return n;
}

/** Validate the settings fields present in `body`. */
export function parseSettings(body: Record<string, unknown>): {
	change: Partial<RelaySettings>;
	registration?: RegistrationPolicy;
} {
	const change: Partial<RelaySettings> = {};
	let registration: RegistrationPolicy | undefined;
	if (body.mode !== undefined) {
		if (!MODES.includes(body.mode as RelayMode)) throw new HttpError(400, "模式只能是 private 或 open");
		change.mode = body.mode as RelayMode;
	}
	if (body.registration !== undefined) {
		if (!POLICIES.includes(body.registration as RegistrationPolicy)) throw new HttpError(400, "注册方式无效");
		registration = body.registration as RegistrationPolicy;
	}
	if (body.maxHosts !== undefined) change.maxHosts = intOrNull(body.maxHosts, "最多注册的电脑数", 1, 1_000_000);
	if (body.maxStreamsPerHost !== undefined) {
		change.maxStreamsPerHost = int(body.maxStreamsPerHost, "每台电脑的连接数", 1, 1024);
	}
	if (body.bytesPerSecond !== undefined) {
		change.bytesPerSecond = intOrNull(body.bytesPerSecond, "带宽上限", 0, 10 * 1024 ** 3);
	}
	if (body.connectsPerMinute !== undefined) {
		change.connectsPerMinute = int(body.connectsPerMinute, "每分钟连接次数", 0, 100_000);
	}
	if (body.publicHost !== undefined) {
		const host = typeof body.publicHost === "string" ? body.publicHost.trim() : body.publicHost;
		if (host === null || host === "") change.publicHost = null;
		else if (typeof host === "string" && /^[A-Za-z0-9.:[\]-]{1,253}$/.test(host)) change.publicHost = host;
		else throw new HttpError(400, "STUN 公网地址只能是主机名或 IP");
	}
	if (body.iceServers !== undefined) {
		const list = Array.isArray(body.iceServers) ? body.iceServers : [];
		const urls = list.map((u) => (typeof u === "string" ? u.trim() : "")).filter(Boolean);
		if (!Array.isArray(body.iceServers) || urls.length > 8 || urls.some((u) => !/^stuns?:[^\s]{1,250}$/i.test(u))) {
			throw new HttpError(400, "额外的 STUN 服务器最多 8 个，每个以 stun: 或 stuns: 开头");
		}
		change.iceServers = urls;
	}
	return { change, ...(registration ? { registration } : {}) };
}

export function createAdmin(options: AdminOptions): RelayAdmin {
	const { store, relay, log } = options;
	if (!store.hasUsers) {
		log("admin panel: no accounts yet; the first account registered on the relay's web page becomes the administrator");
	}

	const attempts = new Map<string, number[]>();
	const perMinute = options.authAttemptsPerMinute ?? 20;
	const sweep = setInterval(() => {
		const cutoff = Date.now() - 60_000;
		for (const [key, times] of attempts) {
			const kept = times.filter((t) => t > cutoff);
			if (kept.length) attempts.set(key, kept);
			else attempts.delete(key);
		}
	}, 60_000);
	sweep.unref?.();
	const throttle = (address: string) => {
		const now = Date.now();
		const times = (attempts.get(address) ?? []).filter((t) => t > now - 60_000);
		times.push(now);
		attempts.set(address, times);
		if (times.length > perMinute) throw new HttpError(429, "尝试次数过多，请一分钟后再试");
	};

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
	const secure = (req: IncomingMessage) =>
		(req.socket as { encrypted?: boolean }).encrypted === true ||
		(options.trustProxy &&
			String(req.headers["x-forwarded-proto"] ?? "")
				.split(",")[0]
				?.trim() === "https");

	const sessionCookie = (req: IncomingMessage, base: string, value: string, maxAge: number) =>
		[
			`${SESSION_COOKIE}=${value}`,
			`Path=${base}/`,
			`Max-Age=${maxAge}`,
			"HttpOnly",
			"SameSite=Strict",
			...(secure(req) ? ["Secure"] : []),
		].join("; ");

	// ---- views ----------------------------------------------------------------------------
	const userView = (user: StoredUser) => ({
		id: user.id,
		username: user.username,
		role: user.role,
		status: user.status,
		createdAt: user.createdAt,
		lastLoginAt: user.lastLoginAt ?? null,
		tokens: store.tokensOf(user.id).length,
	});
	const tokenView = (token: StoredToken, hosts: RelayHostInfo[]) => ({
		id: token.id,
		name: token.name,
		hint: token.hint,
		createdAt: token.createdAt,
		lastUsedAt: token.lastUsedAt ?? null,
		lastUsedFrom: token.lastUsedFrom ?? null,
		online: hosts.filter((h) => h.tokenId === token.id).length,
	});
	const hostView = (host: RelayHostInfo, me: StoredUser) => ({
		key: host.key,
		address: host.address,
		connectedAt: host.connectedAt,
		streams: host.streams,
		via: host.via,
		username: host.userId ? (store.user(host.userId)?.username ?? null) : null,
		tokenName: host.tokenId ? (store.token(host.tokenId)?.name ?? null) : null,
		mine: host.userId === me.id,
	});
	const settingsView = () => ({
		settings: relay.settings(),
		registration: store.registration,
		effective: relay.effective(),
		defaults: {
			private: { maxHosts: 10_000, bytesPerSecond: 0 },
			open: { maxHosts: 1000, bytesPerSecond: 2 * 1024 * 1024 },
		},
		staticTokens: options.staticTokens,
		stunPort: options.stunPort ?? null,
		trustProxy: options.trustProxy,
	});

	const startSession = async (req: IncomingMessage, res: ServerResponse, base: string, user: StoredUser) => {
		const token = await store.createSession(user.id);
		await store.recordLogin(user);
		sendJson(
			res,
			200,
			{ user: { id: user.id, username: user.username, role: user.role } },
			{ "set-cookie": sessionCookie(req, base, token, Math.floor(SESSION_TTL_MS / 1000)) },
		);
	};

	// ---- API ------------------------------------------------------------------------------
	const api = async (req: IncomingMessage, res: ServerResponse, base: string, route: string): Promise<void> => {
		const method = req.method ?? "GET";
		if (method !== "GET" && req.headers["x-pier-relay"] !== "1") throw new HttpError(403, "缺少请求头");
		const sessionToken = cookies(req).get(SESSION_COOKIE);
		const me = store.sessionUser(sessionToken);
		const address = clientAddress(req);
		const [section = "", id, action] = route.split("/");
		// `tokens/<id>`, `users/<id>/password`; `account/password` has no id.
		const key =
			section === "account"
				? `${method} ${route}`
				: `${method} ${section}${id ? "/:id" : ""}${action ? `/${action}` : ""}`;

		// Public routes.
		switch (key) {
			case "GET session":
				return sendJson(res, 200, {
					version: options.version,
					mode: relay.settings().mode,
					setupRequired: !store.hasUsers,
					registration: store.registration,
					user: me ? { id: me.id, username: me.username, role: me.role } : null,
				});
			case "POST register": {
				throttle(address);
				const body = await readJson(req);
				const user = await store.registerUser(body.username, body.password, store.registration);
				log(
					`admin panel: ${user.username} registered from ${address}${user.role === "admin" ? " (first account: administrator)" : user.status === "pending" ? " (pending)" : ""}`,
				);
				if (user.status === "pending") return sendJson(res, 202, { pending: true });
				return startSession(req, res, base, user);
			}
			case "POST login": {
				throttle(address);
				const body = await readJson(req);
				const username = typeof body.username === "string" ? body.username.trim() : "";
				const password = typeof body.password === "string" ? body.password : "";
				const user = username ? store.userByName(username) : undefined;
				const ok = await verifyPassword(password, user?.password ?? (await dummyPasswordHash()));
				if (!user || !ok) {
					log(`admin panel: failed login${username ? ` for ${username.slice(0, 32)}` : ""} from ${address}`);
					throw new HttpError(401, "用户名或密码错误");
				}
				if (user.status === "pending") throw new HttpError(403, "账号正在等待管理员审核");
				if (user.status === "disabled") throw new HttpError(403, "账号已被停用");
				return startSession(req, res, base, user);
			}
			case "POST logout":
				if (sessionToken) await store.deleteSession(sessionToken);
				return sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(req, base, "", 0) });
		}

		if (!me) throw new HttpError(401, "请先登录");
		const admin = me.role === "admin";
		const hosts = relay.hosts();

		switch (key) {
			case "GET overview": {
				const mine = hosts.filter((h) => h.userId === me.id);
				const stats = relay.stats();
				return sendJson(res, 200, {
					mode: relay.settings().mode,
					registration: store.registration,
					startedAt: options.startedAt,
					stunPort: options.stunPort ?? null,
					mine: {
						hosts: mine.length,
						streams: mine.reduce((n, h) => n + h.streams, 0),
						tokens: store.tokensOf(me.id).length,
					},
					...(admin
						? {
								all: {
									...stats,
									users: store.users.length,
									pending: store.users.filter((u) => u.status === "pending").length,
								},
								effective: relay.effective(),
							}
						: {}),
				});
			}
			case "POST account/password": {
				const body = await readJson(req);
				if (!(await verifyPassword(typeof body.current === "string" ? body.current : "", me.password))) {
					throw new HttpError(403, "当前密码不正确");
				}
				await store.setPassword(me.id, body.password, sessionToken);
				return sendJson(res, 200, { ok: true });
			}
			case "GET tokens":
				return sendJson(res, 200, { tokens: store.tokensOf(me.id).map((t) => tokenView(t, hosts)) });
			case "POST tokens": {
				const body = await readJson(req);
				const { token, item } = await store.createToken(me.id, body.name);
				log(`admin panel: ${me.username} created access token ${item.hint}…`);
				return sendJson(res, 200, { token, item: tokenView(item, hosts) });
			}
			case "DELETE tokens/:id": {
				const token = id ? store.token(id) : undefined;
				if (!token || token.userId !== me.id) throw new HttpError(404, "令牌不存在");
				await store.deleteToken(token.id);
				relay.revalidate();
				log(`admin panel: ${me.username} deleted access token ${token.hint}…`);
				return sendJson(res, 200, { ok: true });
			}
			case "GET hosts":
				return sendJson(res, 200, {
					hosts: hosts.filter((h) => admin || h.userId === me.id).map((h) => hostView(h, me)),
				});
			case "POST hosts/:id/kick": {
				const host = id ? hosts.find((h) => h.key === id) : undefined;
				if (!host || (!admin && host.userId !== me.id)) throw new HttpError(404, "电脑不存在");
				if (!relay.kickHost(host.key)) throw new HttpError(404, "电脑已离线");
				log(`admin panel: ${me.username} kicked computer ${host.key.slice(0, 8)}…`);
				return sendJson(res, 200, { ok: true });
			}
		}

		if (!admin) throw new HttpError(403, "需要管理员权限");
		switch (key) {
			case "GET users":
				return sendJson(res, 200, { users: store.users.map(userView), me: me.id });
			case "PATCH users/:id": {
				const body = await readJson(req);
				const target = id ? store.user(id) : undefined;
				if (!target) throw new HttpError(404, "用户不存在");
				if (target.id === me.id) throw new HttpError(400, "不能修改自己的角色或状态");
				const change: { role?: UserRole; status?: UserStatus } = {};
				if (body.role !== undefined) {
					if (!ROLES.includes(body.role as UserRole)) throw new HttpError(400, "角色无效");
					change.role = body.role as UserRole;
				}
				if (body.status !== undefined) {
					if (!STATUSES.includes(body.status as UserStatus)) throw new HttpError(400, "状态无效");
					change.status = body.status as UserStatus;
				}
				const user = await store.updateUser(target.id, change);
				relay.revalidate();
				log(`admin panel: ${me.username} set ${user.username} to ${user.role}/${user.status}`);
				return sendJson(res, 200, { user: userView(user) });
			}
			case "POST users/:id/password": {
				const body = await readJson(req);
				const target = id ? store.user(id) : undefined;
				if (!target) throw new HttpError(404, "用户不存在");
				await store.setPassword(target.id, body.password, target.id === me.id ? sessionToken : undefined);
				log(`admin panel: ${me.username} reset the password of ${target.username}`);
				return sendJson(res, 200, { ok: true });
			}
			case "DELETE users/:id": {
				const target = id ? store.user(id) : undefined;
				if (!target) throw new HttpError(404, "用户不存在");
				if (target.id === me.id) throw new HttpError(400, "不能删除自己");
				await store.deleteUser(target.id);
				relay.revalidate();
				log(`admin panel: ${me.username} deleted ${target.username}`);
				return sendJson(res, 200, { ok: true });
			}
			case "GET settings":
				return sendJson(res, 200, settingsView());
			case "PUT settings": {
				const { change, registration } = parseSettings(await readJson(req));
				const before = relay.settings().mode;
				const settings = relay.configure(change);
				await store.saveSettings(settings, registration ?? store.registration);
				log(
					`admin panel: ${me.username} changed the settings${settings.mode !== before ? ` (now ${settings.mode} mode)` : ""}`,
				);
				return sendJson(res, 200, settingsView());
			}
		}
		throw new HttpError(404, "接口不存在");
	};

	return {
		async handle(req, res, path) {
			const match = /^(.*)\/api\/(.+)$/.exec(path);
			if (match) {
				try {
					await api(req, res, match[1] ?? "", (match[2] ?? "").replace(/\/+$/, ""));
				} catch (error) {
					if (error instanceof HttpError || error instanceof StoreError) {
						sendJson(res, error.status, { error: error.message });
						return;
					}
					throw error;
				}
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { allow: "GET, HEAD" });
				res.end();
				return;
			}
			if (path.endsWith("/")) {
				const nonce = randomBytes(16).toString("base64");
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"x-frame-options": "DENY",
					"referrer-policy": "no-referrer",
					"content-security-policy": [
						"default-src 'none'",
						`script-src 'nonce-${nonce}'`,
						"style-src 'unsafe-inline'",
						"img-src 'self' data:",
						"connect-src 'self'",
						"base-uri 'none'",
						"form-action 'none'",
						"frame-ancestors 'none'",
					].join("; "),
				});
				res.end(req.method === "HEAD" ? undefined : adminPage(nonce));
				return;
			}
			const last = path.slice(path.lastIndexOf("/") + 1);
			if (!last || last.includes(".")) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("Not Found\n");
				return;
			}
			// `/pier-relay` → `/pier-relay/`, relative so it works under any mount path.
			const query = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";
			res.writeHead(302, { location: `${last}/${query}` });
			res.end();
		},
		close() {
			clearInterval(sweep);
		},
	};
}
