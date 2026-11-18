import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PierClient } from "@pier/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startLocalGateway } from "../src/gateway/local-gateway.ts";
import { PierHost } from "../src/host.ts";
import { PiEnvironment } from "../src/pi/environment.ts";
import { encryptNewApiPassword, normalizeNewApiUrl } from "../src/pi/newapi.ts";
import {
	DASHBOARD_TOKEN,
	decryptV2,
	type FakeNewApi,
	type FakeOptions,
	PASSWORD,
	PAT,
	PUBLIC_PEM,
	startFakeNewApi,
	TOKEN_KEY_B,
	TOTP,
} from "./fake-newapi.ts";
import { TOKEN, testPiLoader } from "./helpers.ts";

interface Harness {
	modelsPath: string;
	credentials: InMemoryCredentialStore;
	host: PierHost;
	client: PierClient;
	second: PierClient;
	close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pier-newapi-"));
	const agentDir = join(root, "agent");
	const modelsPath = join(agentDir, "models.json");
	mkdirSync(agentDir, { recursive: true });
	const credentials = new InMemoryCredentialStore();
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath, refreshOnCreate: false });
	const settings = SettingsManager.inMemory({});
	const env = await PiEnvironment.create({
		loader: testPiLoader(),
		agentDir,
		modelsPath,
		modelRuntime,
		settingsManager: () => settings,
		sessionDir: join(root, "sessions"),
		isolated: true,
	});
	const host = await PierHost.create({
		pierDir: join(root, "pier"),
		env,
		localToken: TOKEN,
		remote: { enabled: false },
	});
	const gateway = await startLocalGateway(host);
	const connect = async () => {
		const client = new PierClient({ url: gateway.url, token: TOKEN, client: { name: "test", version: "0.0.0" } });
		await client.connect();
		return client;
	};
	const client = await connect();
	const second = await connect();
	return {
		modelsPath,
		credentials,
		host,
		client,
		second,
		async close() {
			client.close();
			second.close();
			await host.shutdown();
			await gateway.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("NewAPI helpers", () => {
	it("normalizes pasted site addresses", () => {
		expect(normalizeNewApiUrl("api.example.com")).toBe("https://api.example.com");
		expect(normalizeNewApiUrl("https://api.example.com/v1/")).toBe("https://api.example.com");
		expect(normalizeNewApiUrl("https://api.example.com/console/token?x=1")).toBe("https://api.example.com");
		expect(normalizeNewApiUrl("http://10.0.0.2:3000/newapi/login")).toBe("http://10.0.0.2:3000/newapi");
		expect(() => normalizeNewApiUrl("ftp://x")).toThrow();
	});

	it("encrypts passwords in the v2 format", () => {
		const long = "p".repeat(500);
		expect(decryptV2(encryptNewApiPassword(PASSWORD, PUBLIC_PEM, "k1"), "k1")).toBe(PASSWORD);
		expect(decryptV2(encryptNewApiPassword(long, PUBLIC_PEM, "k1"), "k1")).toBe(long);
	});
});

describe("NewAPI sign-in", () => {
	let t: Harness;
	const fakes: FakeNewApi[] = [];
	const offline = process.env.PI_OFFLINE;
	const fake = async (options: FakeOptions) => {
		const f = await startFakeNewApi(options);
		fakes.push(f);
		return f;
	};

	beforeAll(() => {
		process.env.PI_OFFLINE = "1";
	});
	afterAll(() => {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	});
	beforeEach(async () => {
		t = await startHarness();
	});
	afterEach(async () => {
		await t.close();
		for (const f of fakes.splice(0)) f.server.close();
	});

	it("logs in with an encrypted password and 2FA, then saves a token as a provider", async () => {
		const site = await fake({ variant: "modern", twoFA: true, encryption: true });

		await expect(
			t.client.request("newapi.login", { baseUrl: site.url, username: "alice", password: "wrong" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("用户名或密码错误") });

		const first = await t.client.request("newapi.login", {
			baseUrl: `${site.url}/v1`,
			username: "alice",
			password: PASSWORD,
		});
		expect(first).toMatchObject({ status: "verify", methods: ["2fa"] });
		await expect(
			t.client.request("newapi.verify", { sessionId: first.sessionId, code: "000000" }),
		).rejects.toMatchObject({ message: expect.stringContaining("验证码错误") });
		// Another connection cannot use this login.
		await expect(t.second.request("newapi.verify", { sessionId: first.sessionId, code: TOTP })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		const result = await t.client.request("newapi.verify", { sessionId: first.sessionId, code: TOTP });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.account).toEqual({
			site: { name: "测试站", url: site.url, version: "v1.3.19" },
			user: { id: 7, username: "alice", displayName: "Alice", group: "default" },
			tokens: [
				{ id: 2, name: "main", maskedKey: "sk-BBBB**********2222", status: 1, group: "vip", unlimitedQuota: true },
				{ id: 1, name: "old", maskedKey: "sk-AAAA**********1111", status: 3, unlimitedQuota: true },
			],
			groups: [
				{ name: "default", description: "默认分组", ratio: 1 },
				{ name: "vip", description: "VIP", ratio: 0.5 },
			],
		});
		const dashboard = site.requests.filter((r) => r.path === "/api/token/");
		expect(dashboard.every((r) => r.headers.authorization === `Bearer ${DASHBOARD_TOKEN}`)).toBe(true);

		const used = await t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 2 });
		expect(used.models).toEqual([
			{ id: "m-a", api: "openai-completions" },
			{ id: "m-b", api: "anthropic-messages" },
			{ id: "only-main", api: "openai-completions" },
		]);
		expect(JSON.stringify([result, used])).not.toContain(TOKEN_KEY_B);

		// The key reference works for probing and saving, but only on this connection.
		const probe = await t.client.request("provider.probeModels", {
			api: "openai-completions",
			baseUrl: `${site.url}/v1`,
			apiKeyRef: used.keyRef,
		});
		expect(probe.models.map((m) => [m.id, m.api])).toEqual([
			["m-a", undefined],
			["m-b", "anthropic-messages"],
			["only-main", undefined],
		]);
		const provider = {
			id: "test-site",
			name: "测试站",
			api: "openai-completions" as const,
			baseUrl: `${site.url}/v1`,
			models: [{ id: "m-a" }, { id: "m-b", api: "anthropic-messages" as const }],
		};
		await expect(
			t.second.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const saved = await t.client.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true });
		expect(saved.provider).toMatchObject({ id: "test-site", stored: true, availableCount: 2 });
		expect(saved.defaultModel).toEqual({ provider: "test-site", modelId: "m-a" });
		expect(await t.credentials.read("test-site")).toEqual({ type: "api_key", key: `sk-${TOKEN_KEY_B}` });
		expect(readFileSync(t.modelsPath, "utf8")).not.toContain(TOKEN_KEY_B);
		// Models on another wire API get their own API and a Base URL derived from the provider's.
		const entry = JSON.parse(readFileSync(t.modelsPath, "utf8")).providers["test-site"];
		expect(entry.models.map((m: Record<string, unknown>) => [m.id, m.api, m.baseUrl])).toEqual([
			["m-a", undefined, undefined],
			["m-b", "anthropic-messages", site.url],
		]);
		expect(saved.provider.custom?.models.map((m) => m.api)).toEqual([undefined, "anthropic-messages"]);

		expect(await t.client.request("newapi.close", { sessionId: result.sessionId })).toEqual({ closed: true });
		expect(site.logouts).toBe(1);
		await expect(
			t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 2 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("creates a token in a group", async () => {
		const site = await fake({ variant: "modern" });
		const result = await t.client.request("newapi.login", { baseUrl: site.url, username: "alice", password: PASSWORD });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		const created = await t.client.request("newapi.createToken", {
			sessionId: result.sessionId,
			name: "Pier",
			group: "vip",
		});
		expect(created.tokenId).toBe(3);
		expect(created.tokens[0]).toMatchObject({ id: 3, name: "Pier", group: "vip", status: 1 });
		const used = await t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 3 });
		expect(used.models.map((m) => m.id)).toContain("only-Pier");
	});

	it("supports legacy cookie sessions with 2FA and keys in the token list", async () => {
		const site = await fake({ variant: "legacy", twoFA: true });
		const first = await t.client.request("newapi.login", { baseUrl: site.url, username: "alice", password: PASSWORD });
		expect(first.status).toBe("verify");
		const result = await t.client.request("newapi.verify", { sessionId: first.sessionId, code: TOTP });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.account.tokens.map((t) => t.maskedKey)).toEqual(["sk-BBBB**********2222", "sk-AAAA**********1111"]);
		expect(result.account.groups).toEqual([{ name: "default", description: "默认", ratio: 1 }]);
		expect(site.requests.find((r) => r.path === "/api/token/")?.headers["new-api-user"]).toBe("7");

		const used = await t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 2 });
		expect(used.models).toHaveLength(3);
		const saved = await t.client.request("provider.saveCustom", {
			provider: { id: "legacy", api: "openai-completions", baseUrl: `${site.url}/v1`, models: [{ id: "m-a" }] },
			apiKeyRef: used.keyRef,
			create: true,
		});
		expect(saved.provider.stored).toBe(true);
		expect(await t.credentials.read("legacy")).toEqual({ type: "api_key", key: `sk-${TOKEN_KEY_B}` });
	});

	it("signs in with a system access token", async () => {
		const modern = await fake({ variant: "modern" });
		const result = await t.client.request("newapi.login", { baseUrl: modern.url, accessToken: PAT });
		expect(result.status).toBe("ok");
		// The user's own access token is never revoked.
		await t.client.request("newapi.close", { sessionId: result.sessionId });
		expect(modern.logouts).toBe(0);

		const legacy = await fake({ variant: "legacy" });
		await expect(t.client.request("newapi.login", { baseUrl: legacy.url, accessToken: PAT })).rejects.toMatchObject({
			message: expect.stringContaining("用户 ID"),
		});
		const ok = await t.client.request("newapi.login", { baseUrl: legacy.url, accessToken: PAT, userId: 7 });
		expect(ok.status).toBe("ok");
		await expect(
			t.client.request("newapi.login", { baseUrl: legacy.url, accessToken: "nope", userId: 7 }),
		).rejects.toMatchObject({ message: expect.stringContaining("NewAPI") });
	});

	it("signs in through the browser with app authorization", async () => {
		const site = await fake({ variant: "modern", appAuth: true });
		const started = await t.client.request("newapi.authorizeStart", { baseUrl: `${site.url}/console` });
		expect(started.site).toEqual({ name: "测试站", url: site.url, version: "v1.3.19" });
		const consent = new URL(started.authorizeUrl);
		expect(`${consent.origin}${consent.pathname}`).toBe(`${site.url}/app-auth`);
		expect(consent.searchParams.get("client_name")).toBe("Pier");
		expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
		expect(consent.searchParams.get("key_name")).toMatch(/^Pier · /);
		const redirect = new URL(consent.searchParams.get("redirect_uri") ?? "");
		expect(redirect.hostname).toBe("127.0.0.1");

		// Only the right state can settle the flow, and another connection cannot wait on it.
		const forged = await fetch(`${redirect.origin}/callback?code=x&state=forged`);
		expect(forged.status).toBe(400);
		await expect(t.second.request("newapi.authorizeWait", { flowId: started.flowId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		const waiting = t.client.request("newapi.authorizeWait", { flowId: started.flowId });
		const page = await fetch(site.approve(started.authorizeUrl));
		expect(page.status).toBe(200);
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await page.text()).toContain("授权成功");
		const result = await waiting;
		const created = site.tokens.at(-1);
		expect(result).toMatchObject({
			site: { name: "测试站", url: site.url },
			user: { id: 7, username: "alice", displayName: "Alice" },
			token: { id: created?.id, name: created?.name, maskedKey: `sk-APP${created?.id}**********ykey` },
			models: [
				{ id: "m-a", api: "openai-completions" },
				{ id: "m-b", api: "anthropic-messages" },
				{ id: `only-${created?.name}`, api: "openai-completions" },
			],
		});
		expect(JSON.stringify(result)).not.toContain(created?.key);

		// The callback stops listening; fetch may reuse a connection serving the last page.
		await expect(
			new Promise<void>((resolve, reject) => {
				const socket = connect(Number(redirect.port), redirect.hostname);
				socket.once("error", reject);
				socket.once("connect", () => {
					socket.destroy();
					resolve();
				});
			}),
		).rejects.toMatchObject({ code: "ECONNREFUSED" });
		const saved = await t.client.request("provider.saveCustom", {
			provider: { id: "browser", api: "openai-completions", baseUrl: `${site.url}/v1`, models: [{ id: "m-a" }] },
			apiKeyRef: result.keyRef,
			create: true,
		});
		expect(saved.provider.stored).toBe(true);
		expect(await t.credentials.read("browser")).toEqual({ type: "api_key", key: `sk-${created?.key}` });
	});

	it("reports declined, cancelled and failed browser authorizations", async () => {
		const site = await fake({ variant: "modern", appAuth: true });

		const declined = await t.client.request("newapi.authorizeStart", { baseUrl: site.url });
		const declinedWait = t.client.request("newapi.authorizeWait", { flowId: declined.flowId });
		const redirect = new URL(new URL(declined.authorizeUrl).searchParams.get("redirect_uri") ?? "");
		const state = new URL(declined.authorizeUrl).searchParams.get("state") ?? "";
		const page = await fetch(`${redirect}?error=access_denied&state=${encodeURIComponent(state)}`);
		expect(page.status).toBe(400);
		await expect(declinedWait).rejects.toMatchObject({ message: expect.stringContaining("取消授权") });

		const cancelled = await t.client.request("newapi.authorizeStart", { baseUrl: site.url });
		const cancelledWait = t.client.request("newapi.authorizeWait", { flowId: cancelled.flowId });
		expect(await t.client.request("newapi.authorizeCancel", { flowId: cancelled.flowId })).toEqual({ cancelled: true });
		await expect(cancelledWait).rejects.toMatchObject({ message: expect.stringContaining("已取消") });

		// The site rejects the code (for example it expired): the flow fails with its message.
		const failed = await t.client.request("newapi.authorizeStart", { baseUrl: site.url });
		const failedWait = t.client.request("newapi.authorizeWait", { flowId: failed.flowId });
		const callback = site.approve(failed.authorizeUrl);
		site.grants.splice(0);
		const failedPage = await fetch(callback);
		expect(failedPage.status).toBe(400);
		expect(await failedPage.text()).toContain("授权码无效");
		await expect(failedWait).rejects.toMatchObject({ message: expect.stringContaining("授权码无效") });

		const plain = await fake({ variant: "modern" });
		await expect(t.client.request("newapi.authorizeStart", { baseUrl: plain.url })).rejects.toMatchObject({
			message: expect.stringContaining("没有开启浏览器授权"),
		});
	});

	it("explains sites that cannot be used", async () => {
		const turnstile = await fake({ variant: "modern", turnstile: true });
		await expect(
			t.client.request("newapi.login", { baseUrl: turnstile.url, username: "alice", password: PASSWORD }),
		).rejects.toMatchObject({ message: expect.stringContaining("访问令牌") });
		const other = createServer((_req, res) => res.end("<html></html>"));
		await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
		try {
			const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
			await expect(
				t.client.request("newapi.login", { baseUrl: url, username: "alice", password: PASSWORD }),
			).rejects.toMatchObject({ message: expect.stringContaining("NewAPI") });
		} finally {
			other.close();
		}
	});
});
