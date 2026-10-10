import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateKeyPair,
	type KeyPair,
	RELAY_CLOSE,
	type RelayServerMessage,
	relayRegisterProof,
	toBase64Url,
} from "@pier/crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type RelayServer, startRelayServer } from "../src/server.ts";
import { DATA_FILE } from "../src/store.ts";

function nextMessage(socket: WebSocket): Promise<RelayServerMessage> {
	return new Promise((resolve, reject) => {
		socket.once("message", (data) => resolve(JSON.parse(data.toString()) as RelayServerMessage));
		socket.once("close", (code) => reject(new Error(`closed ${code}`)));
	});
}

function closed(socket: WebSocket): Promise<number> {
	return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("Timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

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

/** A browser stand-in: keeps the session cookie and sends the panel's request header. */
class Client {
	cookie = "";
	constructor(private readonly base: string) {}

	async call(
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = { "x-pier-relay": "1" },
	): Promise<{ status: number; data: Record<string, unknown> & { error?: string } }> {
		const res = await fetch(`${this.base}/api/${path}`, {
			method,
			headers: {
				...headers,
				...(this.cookie ? { cookie: this.cookie } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const set = res.headers.get("set-cookie");
		if (set) this.cookie = set.split(";")[0] ?? "";
		return { status: res.status, data: (await res.json()) as Record<string, unknown> & { error?: string } };
	}
}

describe("relay admin panel", () => {
	let dir: string;
	let relay: RelayServer | undefined;
	let logs: string[];
	const sockets: WebSocket[] = [];
	const track = (socket: WebSocket) => {
		sockets.push(socket);
		return socket;
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pier-relay-admin-"));
		logs = [];
	});
	afterEach(async () => {
		for (const socket of sockets.splice(0)) socket.terminate();
		await relay?.close();
		relay = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	const start = async (mode: "private" | "open" = "private", extra: { tokens?: string[] } = {}) => {
		relay = await startRelayServer({
			mode,
			port: 0,
			stunPort: 0,
			dataDir: dir,
			...extra,
			log: (line) => logs.push(line),
		});
		return { relay, base: relay.url.replace(/^ws/, "http") };
	};
	/** Start, register the first account (the administrator), and return a logged-in client. */
	const startWithAdmin = async (mode: "private" | "open" = "private") => {
		const started = await start(mode);
		const admin = new Client(started.base);
		const first = await admin.call("POST", "register", { username: "admin", password: "admin-password" });
		expect(first.status).toBe(200);
		return { ...started, admin };
	};

	it("makes the first registered account the administrator", async () => {
		const { base } = await start();
		const client = new Client(base);
		expect((await client.call("GET", "session")).data).toMatchObject({ setupRequired: true, user: null });
		expect(logs.join("\n")).toContain("the first account registered");
		// The header is required for anything that changes state.
		const noHeader = await client.call("POST", "register", { username: "Admin", password: "pw-12345678" }, {});
		expect(noHeader.status).toBe(403);

		// Two at once: only one becomes the administrator, the other waits for approval.
		const other = new Client(base);
		const [a, b] = await Promise.all([
			client.call("POST", "register", { username: "Admin", password: "pw-12345678" }),
			other.call("POST", "register", { username: "other", password: "pw-87654321" }),
		]);
		expect([a.status, b.status].sort()).toEqual([200, 202]);
		const winner = a.status === 200 ? client : other;
		const { data } = await winner.call("GET", "session");
		expect(data).toMatchObject({ setupRequired: false, user: { role: "admin" } });
		expect(winner.cookie).toMatch(/^pier_relay_session=/);
		const users = (await winner.call("GET", "users")).data.users as Array<{ role: string; status: string }>;
		expect(users.map((u) => `${u.role}/${u.status}`).sort()).toEqual(["admin/active", "user/pending"]);

		// Passwords and session cookies are not stored in the clear.
		const file = await readFile(join(dir, DATA_FILE), "utf8");
		expect(file).not.toContain("pw-12345678");
		expect(file).not.toContain(winner.cookie.split("=")[1]);
	});

	it("refuses registration when closed, also after a restart", async () => {
		const { base } = await start();
		const admin = new Client(base);
		expect((await admin.call("POST", "register", { username: "root", password: "root-password" })).status).toBe(200);
		expect((await admin.call("PUT", "settings", { registration: "closed" })).status).toBe(200);
		await relay?.close();
		relay = undefined;
		// After a restart, closed stays closed and the first account is not created again.
		const restarted = await start();
		const late = await new Client(restarted.base).call("POST", "register", {
			username: "late",
			password: "late-password",
		});
		expect(late).toMatchObject({ status: 403, data: { error: "管理员关闭了注册" } });
		expect((await new Client(restarted.base).call("GET", "session")).data).toMatchObject({ setupRequired: false });
	});

	it("registers accounts for approval and lets administrators manage them", async () => {
		const { base, admin } = await startWithAdmin();
		const alice = new Client(base);
		expect((await alice.call("POST", "register", { username: "a", password: "password1" })).status).toBe(400);
		const registered = await alice.call("POST", "register", { username: "alice", password: "alice-password" });
		expect(registered.status).toBe(202);
		expect(registered.data).toEqual({ pending: true });
		const early = await alice.call("POST", "login", { username: "alice", password: "alice-password" });
		expect(early).toMatchObject({ status: 403, data: { error: "账号正在等待管理员审核" } });
		expect((await alice.call("POST", "register", { username: "ALICE", password: "alice-password" })).status).toBe(409);

		const { data: list } = await admin.call("GET", "users");
		const users = list.users as Array<{ id: string; username: string; status: string }>;
		const id = users.find((u) => u.username === "alice")?.id ?? "";
		expect(users.find((u) => u.username === "alice")?.status).toBe("pending");
		expect((await admin.call("PATCH", `users/${id}`, { status: "active" })).status).toBe(200);

		expect((await alice.call("POST", "login", { username: "alice", password: "wrong-password" })).status).toBe(401);
		expect((await alice.call("POST", "login", { username: "alice", password: "alice-password" })).status).toBe(200);
		// Users cannot reach administrator routes, and administrators cannot lock themselves out.
		expect((await alice.call("GET", "settings")).status).toBe(403);
		expect((await alice.call("GET", "users")).status).toBe(403);
		const adminId = users.find((u) => u.username === "admin")?.id ?? "";
		expect((await admin.call("PATCH", `users/${adminId}`, { role: "user" })).status).toBe(400);
		expect((await admin.call("DELETE", `users/${adminId}`)).status).toBe(400);

		// Changing the password keeps this login and ends the others.
		const other = new Client(base);
		await other.call("POST", "login", { username: "alice", password: "alice-password" });
		const changed = await alice.call("POST", "account/password", {
			current: "alice-password",
			password: "new-password",
		});
		expect(changed.status).toBe(200);
		expect((await alice.call("GET", "tokens")).status).toBe(200);
		expect((await other.call("GET", "tokens")).status).toBe(401);

		// Closed registration.
		expect((await admin.call("PUT", "settings", { registration: "closed" })).status).toBe(200);
		expect(
			(await new Client(base).call("POST", "register", { username: "bob", password: "bob-password" })).status,
		).toBe(403);
	});

	it("lets computers register with an account's token and drops them when it is revoked", async () => {
		const { relay, base, admin } = await startWithAdmin();
		await admin.call("PUT", "settings", { registration: "open" });
		const bob = new Client(base);
		expect((await bob.call("POST", "register", { username: "bob", password: "bob-password" })).status).toBe(200);
		const created = await bob.call("POST", "tokens", { name: "laptop" });
		const token = created.data.token as string;
		expect(token).toMatch(/^prt_/);

		// Private mode without command-line tokens: only account tokens get in.
		const anonymous = await registerHost(relay, generateKeyPair());
		track(anonymous.socket);
		expect(anonymous.registered).toMatchObject({ t: "error", code: "UNAUTHORIZED" });
		const keys = generateKeyPair();
		const host = await registerHost(relay, keys, token);
		track(host.socket);
		expect(host.registered).toMatchObject({ t: "registered", mode: "private" });
		expect(relay.hosts()).toMatchObject([{ key: toBase64Url(keys.publicKey), via: "account" }]);

		const mine = await bob.call("GET", "hosts");
		expect(mine.data.hosts).toMatchObject([{ username: "bob", tokenName: "laptop", mine: true }]);
		const tokens = await bob.call("GET", "tokens");
		expect(tokens.data.tokens).toMatchObject([{ name: "laptop", online: 1, hint: token.slice(0, 8) }]);
		expect(JSON.stringify(tokens.data)).not.toContain(token);
		expect(await readFile(join(dir, DATA_FILE), "utf8")).not.toContain(token);

		// Other accounts see neither the computer nor the token.
		const { data: others } = await admin.call("GET", "tokens");
		expect(others.tokens).toEqual([]);
		expect((await admin.call("GET", "hosts")).data.hosts).toMatchObject([{ username: "bob", mine: false }]);

		const dropped = closed(host.socket);
		const tokenId = (created.data.item as { id: string }).id;
		expect((await admin.call("DELETE", `tokens/${tokenId}`)).status).toBe(404);
		expect((await bob.call("DELETE", `tokens/${tokenId}`)).status).toBe(200);
		expect(await dropped).toBe(RELAY_CLOSE.unauthorized);
		await waitFor(() => relay.stats().hosts === 0);

		// Disabling the account works the same way.
		const second = (await bob.call("POST", "tokens", { name: "desktop" })).data.token as string;
		const again = await registerHost(relay, generateKeyPair(), second);
		track(again.socket);
		expect(again.registered).toMatchObject({ t: "registered" });
		const users = (await admin.call("GET", "users")).data.users as Array<{ id: string; username: string }>;
		const disabled = closed(again.socket);
		await admin.call("PATCH", `users/${users.find((u) => u.username === "bob")?.id}`, { status: "disabled" });
		expect(await disabled).toBe(RELAY_CLOSE.unauthorized);
		expect((await bob.call("GET", "tokens")).status).toBe(401);
	});

	it("lets users kick their own computers and administrators kick any computer", async () => {
		const { relay, base, admin } = await startWithAdmin();
		await admin.call("PUT", "settings", { registration: "open" });
		const bob = new Client(base);
		expect((await bob.call("POST", "register", { username: "bob", password: "bob-password" })).status).toBe(200);
		const token = (await bob.call("POST", "tokens", { name: "laptop" })).data.token as string;
		const keys = generateKeyPair();
		const host = await registerHost(relay, keys, token);
		track(host.socket);
		const key = toBase64Url(keys.publicKey);

		const ownerClosed = closed(host.socket);
		expect((await bob.call("POST", `hosts/${key}/kick`)).status).toBe(200);
		expect(await ownerClosed).toBe(1000);
		expect(relay.stats().hosts).toBe(0);

		const charlie = new Client(base);
		expect((await charlie.call("POST", "register", { username: "charlie", password: "charlie-password" })).status).toBe(
			200,
		);
		const otherToken = (await charlie.call("POST", "tokens", { name: "desktop" })).data.token as string;
		const otherKeys = generateKeyPair();
		const other = await registerHost(relay, otherKeys, otherToken);
		track(other.socket);
		const otherKey = toBase64Url(otherKeys.publicKey);
		expect((await bob.call("POST", `hosts/${otherKey}/kick`)).status).toBe(404);
		const adminClosed = closed(other.socket);
		expect((await admin.call("POST", `hosts/${otherKey}/kick`)).status).toBe(200);
		expect(await adminClosed).toBe(1000);
		expect((await admin.call("POST", `hosts/${otherKey}/kick`)).status).toBe(404);
	});

	it("switches modes while running and keeps saved settings across restarts", async () => {
		const { relay, base, admin } = await startWithAdmin("open");
		const health = async () => ((await (await fetch(`${base}/health`)).json()) as { mode: string }).mode;
		expect(await health()).toBe("open");
		const open = await registerHost(relay, generateKeyPair());
		track(open.socket);
		expect(open.registered).toMatchObject({ t: "registered", mode: "open" });
		const token = (await admin.call("POST", "tokens", { name: "kept" })).data.token as string;
		const kept = await registerHost(relay, generateKeyPair(), token);
		track(kept.socket);

		const dropped = closed(open.socket);
		const saved = await admin.call("PUT", "settings", {
			mode: "private",
			maxStreamsPerHost: 4,
			bytesPerSecond: 1048576,
			iceServers: ["stun:stun.example.com:3478"],
		});
		expect(saved.status).toBe(200);
		expect(saved.data.settings).toMatchObject({ mode: "private", maxStreamsPerHost: 4, bytesPerSecond: 1048576 });
		expect(await dropped).toBe(RELAY_CLOSE.unauthorized);
		await waitFor(() => relay.stats().hosts === 1);
		expect(await health()).toBe("private");
		const refused = await registerHost(relay, generateKeyPair());
		track(refused.socket);
		expect(refused.registered).toMatchObject({ t: "error", code: "UNAUTHORIZED" });
		const announced = await registerHost(relay, generateKeyPair(), token);
		track(announced.socket);
		expect(announced.registered).toMatchObject({
			mode: "private",
			iceServers: expect.arrayContaining([{ urls: "stun:stun.example.com:3478" }]),
		});

		expect((await admin.call("PUT", "settings", { mode: "closed" })).status).toBe(400);
		expect((await admin.call("PUT", "settings", { maxStreamsPerHost: 0 })).status).toBe(400);
		expect((await admin.call("PUT", "settings", { iceServers: ["http://x"] })).status).toBe(400);

		// The command line says open, but the panel's choice wins after a restart.
		for (const socket of sockets.splice(0)) socket.terminate();
		await relay.close();
		logs = [];
		const restarted = await start("open");
		expect(restarted.relay.settings()).toMatchObject({ mode: "private", maxStreamsPerHost: 4 });
		expect(logs.join("\n")).toContain("using the settings saved in the admin panel");
		expect(logs.join("\n")).not.toContain("no accounts yet");
		const login = new Client(restarted.base);
		expect((await login.call("POST", "login", { username: "admin", password: "admin-password" })).status).toBe(200);
		const back = await registerHost(restarted.relay, generateKeyPair(), token);
		track(back.socket);
		expect(back.registered).toMatchObject({ t: "registered" });
	});

	it("serves the page under any mount path", async () => {
		const { base } = await start();
		const page = await fetch(`${base}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		const csp = page.headers.get("content-security-policy") ?? "";
		const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
		const html = await page.text();
		const open = `<script nonce="${nonce}">`;
		const script = html.slice(html.indexOf(open) + open.length, html.lastIndexOf("</script>"));
		expect(nonce).toBeTruthy();
		expect(html).toContain(open);
		expect(script).toContain("api/");
		// The script is valid JavaScript for the browser (it is only parsed here, not run).
		expect(() => new Function(script)).not.toThrow();

		const mounted = await fetch(`${base}/pier-relay`, { redirect: "manual" });
		expect(mounted.status).toBe(302);
		expect(mounted.headers.get("location")).toBe("pier-relay/");
		expect((await fetch(`${base}/pier-relay/`)).status).toBe(200);
		const session = await fetch(`${base}/pier-relay/api/session`);
		expect(await session.json()).toMatchObject({ setupRequired: true });
		expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
	});

	it("still needs a token in private mode without a data directory", async () => {
		await expect(startRelayServer({ mode: "private", port: 0, stunPort: 0 })).rejects.toThrow(/access token/);
		relay = await startRelayServer({ mode: "private", tokens: ["static-token-0123456789"], port: 0, stunPort: 0 });
		const text = await (await fetch(`${relay.url.replace(/^ws/, "http")}/`)).text();
		expect(text).toContain("private mode");
	});
});
