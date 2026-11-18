import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PierClient } from "@pier/client";
import type { AccountLine } from "@pier/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startLocalGateway } from "../src/gateway/local-gateway.ts";
import { PierHost } from "../src/host.ts";
import { accountSite } from "../src/pi/account.ts";
import { PiEnvironment } from "../src/pi/environment.ts";
import {
	DASHBOARD_TOKEN,
	EMAIL_CODE,
	type FakeNewApi,
	type FakeOptions,
	PASSWORD,
	PAT,
	startFakeNewApi,
	TOKEN_KEY_B,
	TOTP,
} from "./fake-newapi.ts";
import { TOKEN, testPiLoader } from "./helpers.ts";

interface Harness {
	root: string;
	accountFile: string;
	credentials: InMemoryCredentialStore;
	client: PierClient;
	second: PierClient;
	/** Stop the host and start a new one on the same directories. */
	restart(): Promise<void>;
	close(): Promise<void>;
}

async function startHarness(site: string | AccountLine[]): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pier-account-"));
	const agentDir = join(root, "agent");
	const modelsPath = join(agentDir, "models.json");
	mkdirSync(agentDir, { recursive: true });
	const credentials = new InMemoryCredentialStore();
	let stop: () => Promise<void> = async () => {};
	const harness: Harness = {
		root,
		accountFile: join(root, "pier", "account.json"),
		credentials,
		client: undefined as unknown as PierClient,
		second: undefined as unknown as PierClient,
		async restart() {
			await stop();
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
				...(typeof site === "string" ? { accountSite: site } : { accountLines: site }),
				agentConfigDirs: { "claude-code": join(root, "claude"), codex: join(root, "codex") },
			});
			const gateway = await startLocalGateway(host);
			const connect = async () => {
				const client = new PierClient({ url: gateway.url, token: TOKEN, client: { name: "test", version: "0.0.0" } });
				await client.connect();
				return client;
			};
			harness.client = await connect();
			harness.second = await connect();
			stop = async () => {
				harness.client.close();
				harness.second.close();
				await host.shutdown();
				await gateway.close();
			};
		},
		async close() {
			await stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
	await harness.restart();
	return harness;
}

/** Another address of `target`'s server, the way a second line reaches the same site. */
function startProxy(target: string): Promise<{ url: string; server: Server }> {
	const upstream = new URL(target);
	const server = createServer((req, res) => {
		const forward = request(
			{ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers },
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		forward.on("error", () => res.destroy());
		req.pipe(forward);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
		);
	});
}

describe("personal center site info", () => {
	it("reads sign-in options and the quota display from /api/status", () => {
		expect(
			accountSite("https://api.example.com", {
				system_name: "云链API",
				register_enabled: true,
				password_register_enabled: false,
				email_verification: true,
				github_oauth: true,
				linuxdo_oauth: true,
				oidc_enabled: true,
				oidc_display_name: "SSO",
				quota_per_unit: 500000,
				quota_display_type: "USD",
				usd_exchange_rate: 7,
			}),
		).toEqual({
			name: "云链API",
			url: "https://api.example.com",
			registerEnabled: false,
			emailVerification: true,
			passwordLogin: true,
			browserLogin: false,
			turnstile: false,
			oauth: ["GitHub", "LinuxDO", "SSO"],
			quota: { perUnit: 500000, type: "USD", usdRate: 7 },
		});
		expect(
			accountSite("https://x.test", { app_authorization_enabled: true, app_authorization_scopes: ["token", "account"] })
				.browserLogin,
		).toBe(true);
		// Sites whose app authorization only hands out tokens cannot sign Pier in.
		expect(accountSite("https://x.test", { app_authorization_enabled: true }).browserLogin).toBe(false);
		expect(accountSite("https://x.test", { display_in_currency: false }).quota).toEqual({
			perUnit: 500000,
			type: "TOKENS",
		});
	});
});

describe("personal center", () => {
	let t: Harness;
	let site: FakeNewApi;
	const offline = process.env.PI_OFFLINE;
	const start = async (options: FakeOptions) => {
		site = await startFakeNewApi(options);
		t = await startHarness(site.url);
	};

	beforeAll(() => {
		process.env.PI_OFFLINE = "1";
	});
	afterAll(() => {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	});
	afterEach(async () => {
		await t.close();
		site.server.close();
	});

	it("signs in, shows the balance and keeps the login across restarts", async () => {
		await start({ variant: "modern", twoFA: true });
		const before = await t.client.request("account.status", {});
		expect(before.user).toBeUndefined();
		expect(before.site).toMatchObject({
			name: "测试站",
			url: site.url,
			registerEnabled: true,
			oauth: ["GitHub"],
			quota: { perUnit: 500000, type: "CNY", usdRate: 7 },
		});
		await expect(t.client.request("account.overview", {})).rejects.toMatchObject({
			message: expect.stringContaining("请先登录"),
		});

		await expect(t.client.request("account.login", { username: "alice", password: "nope" })).rejects.toMatchObject({
			message: expect.stringContaining("用户名或密码错误"),
		});
		expect(await t.client.request("account.login", { username: "alice", password: PASSWORD })).toEqual({
			status: "verify",
			methods: ["2fa"],
		});
		const result = await t.client.request("account.verify", { code: TOTP });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.overview.user).toEqual({
			id: 7,
			username: "alice",
			displayName: "Alice",
			group: "default",
			email: "alice@example.com",
			quota: 3_500_000,
			usedQuota: 1_000_000,
			requestCount: 42,
		});
		expect(result.overview.tokens.map((token) => token.id)).toEqual([2, 1]);
		expect(result.overview.groups.map((group) => group.name)).toEqual(["default", "vip"]);

		// Only the refresh cookie is saved, owner-only; never the dashboard token or passwords.
		const saved = readFileSync(t.accountFile, "utf8");
		expect(saved).toContain(site.refreshToken);
		expect(saved).not.toContain(DASHBOARD_TOKEN);
		expect(saved).not.toContain(PASSWORD);
		if (process.platform !== "win32") expect(statSync(t.accountFile).mode & 0o777).toBe(0o600);
		// Every connection of the host shares the login.
		expect((await t.second.request("account.status", {})).user).toEqual({
			id: 7,
			username: "alice",
			displayName: "Alice",
			group: "default",
		});

		await t.restart();
		expect((await t.client.request("account.status", {})).user).toMatchObject({ username: "alice" });
		const overview = await t.client.request("account.overview", {});
		expect(overview.user.quota).toBe(3_500_000);
		// The restarted host got a new access token with the refresh cookie, which rotated.
		expect(site.refreshes).toBe(1);
		expect(site.requests.find((r) => r.path === "/api/user/auth/refresh")?.headers.origin).toBe(site.url);
		expect(readFileSync(t.accountFile, "utf8")).toContain(site.refreshToken);

		// An access token the site stops accepting early is renewed once.
		site.accessTokens.clear();
		expect((await t.client.request("account.overview", {})).user.username).toBe("alice");
		expect(site.refreshes).toBe(2);

		// A refused origin or server error is not a dead login.
		site.accessTokens.clear();
		const originalUrl = site.url;
		site.url = "https://other.example";
		await expect(t.client.request("account.overview", {})).rejects.toMatchObject({
			message: expect.stringContaining("AUTH_ORIGIN_FORBIDDEN"),
		});
		site.url = originalUrl;
		expect((await t.client.request("account.status", {})).user).toMatchObject({ username: "alice" });
		expect((await t.client.request("account.overview", {})).user.username).toBe("alice");

		// A login the site revoked is forgotten.
		site.accessTokens.clear();
		site.refreshToken = undefined;
		await expect(t.client.request("account.overview", {})).rejects.toMatchObject({
			message: expect.stringContaining("登录已过期"),
		});
		expect((await t.client.request("account.status", {})).user).toBeUndefined();
		expect(() => statSync(t.accountFile)).toThrow();
	});

	it("signs in through the browser and keeps the login across restarts", async () => {
		await start({ variant: "modern", appAuth: true, appAccount: true });
		expect((await t.client.request("account.status", {})).site?.browserLogin).toBe(true);

		const started = await t.client.request("account.authorizeStart", {});
		const consent = new URL(started.authorizeUrl);
		expect(consent.origin).toBe(site.url);
		expect(consent.pathname).toBe("/app-auth");
		expect(consent.searchParams.get("scope")).toBe("account");
		expect(consent.searchParams.get("client_name")).toBe("Pier");
		expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
		expect(consent.searchParams.has("key_name")).toBe(false);
		expect(new URL(consent.searchParams.get("redirect_uri") ?? "").hostname).toBe("127.0.0.1");
		// The flow belongs to the connection that started it.
		await expect(t.second.request("account.authorizeWait", { flowId: started.flowId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(t.client.request("newapi.authorizeWait", { flowId: started.flowId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		const waiting = t.client.request("account.authorizeWait", { flowId: started.flowId });
		const page = await fetch(site.approve(started.authorizeUrl));
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Pier 已登录 Alice");
		const result = await waiting;
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.overview.user).toMatchObject({ id: 7, username: "alice", quota: 3_500_000 });
		// Signing in creates no token.
		expect(site.tokens).toHaveLength(2);
		expect(site.requests.find((r) => r.path === "/api/app-auth/token")?.headers["user-agent"]).toMatch(/^Pier\//);

		// Like a password login, only the refresh token is saved.
		const saved = readFileSync(t.accountFile, "utf8");
		expect(saved).toContain(site.refreshToken);
		expect(saved).not.toContain("app-access-1");
		expect((await t.second.request("account.status", {})).user).toMatchObject({ username: "alice" });

		await t.restart();
		expect((await t.client.request("account.overview", {})).user.username).toBe("alice");
		expect(site.refreshes).toBe(1);

		expect(await t.client.request("account.logout", {})).toEqual({ loggedOut: true });
		expect(site.logouts).toBe(1);
		expect(() => statSync(t.accountFile)).toThrow();
	});

	it("signs another computer in with a redirect caught on the browser's computer", async () => {
		await start({ variant: "modern", appAuth: true, appAccount: true });
		// `t.second` plays this computer (relay), `t.client` the computer being signed in.
		const relay = await t.second.request("loopback.open", {});
		expect(relay.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		for (const redirectUri of [
			"http://example.com:80/callback",
			"http://127.0.0.1:1/other",
			"https://127.0.0.1:1/callback",
		]) {
			await expect(t.client.request("account.authorizeStart", { redirectUri })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
		const started = await t.client.request("account.authorizeStart", { redirectUri: relay.redirectUri });
		const params = new URL(started.authorizeUrl).searchParams;
		expect(params.get("redirect_uri")).toBe(relay.redirectUri);
		const waiting = t.client.request("account.authorizeWait", { flowId: started.flowId });

		// Forward one callback the way the app does; the browser waits for the outcome.
		const forward = async () => {
			const callback = await t.second.request("loopback.next", { relayId: relay.relayId });
			const page = await t.client.request("account.authorizeCallback", {
				flowId: started.flowId,
				query: callback.query,
			});
			expect(
				await t.second.request("loopback.respond", { relayId: relay.relayId, requestId: callback.requestId, ...page }),
			).toEqual({ responded: true });
			return page;
		};

		// Only the right state settles the flow.
		const forged = new URL(relay.redirectUri);
		forged.searchParams.set("code", "forged");
		forged.searchParams.set("state", "wrong");
		const [forgedPage, forgedForward] = await Promise.all([fetch(forged), forward()]);
		expect(forgedForward.status).toBe(400);
		expect(forgedPage.status).toBe(400);
		expect(await forgedPage.text()).toContain("无效的授权回调");
		// Other paths never reach the app.
		expect((await fetch(new URL("/other", relay.redirectUri))).status).toBe(404);

		const [page, forwarded] = await Promise.all([fetch(site.approve(started.authorizeUrl)), forward()]);
		expect(forwarded).toMatchObject({ status: 200, title: "登录成功" });
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Pier 已登录 Alice");
		const result = await waiting;
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.overview.user.username).toBe("alice");
		expect(readFileSync(t.accountFile, "utf8")).toContain(site.refreshToken);

		// The relay belongs to its connection and ends with `loopback.close`.
		await expect(t.client.request("loopback.next", { relayId: relay.relayId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		const next = t.second.request("loopback.next", { relayId: relay.relayId });
		expect(await t.second.request("loopback.close", { relayId: relay.relayId })).toEqual({ closed: true });
		await expect(next).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(fetch(relay.redirectUri)).rejects.toThrow();

		// A flow whose browser returns to this host takes no forwarded callbacks.
		const own = await t.client.request("account.authorizeStart", {});
		await expect(
			t.client.request("account.authorizeCallback", { flowId: own.flowId, query: "?code=x&state=y" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await t.client.request("account.authorizeCancel", { flowId: own.flowId });
	});

	it("reports declined, cancelled and unsupported browser sign-ins", async () => {
		await start({ variant: "modern", appAuth: true, appAccount: true });
		const declined = await t.client.request("account.authorizeStart", {});
		const declinedWait = t.client.request("account.authorizeWait", { flowId: declined.flowId });
		const params = new URL(declined.authorizeUrl).searchParams;
		const redirect = new URL(params.get("redirect_uri") ?? "");
		redirect.searchParams.set("error", "access_denied");
		redirect.searchParams.set("state", params.get("state") ?? "");
		expect((await fetch(redirect)).status).toBe(400);
		await expect(declinedWait).rejects.toMatchObject({ message: expect.stringContaining("取消授权") });

		const cancelled = await t.client.request("account.authorizeStart", {});
		const cancelledWait = t.client.request("account.authorizeWait", { flowId: cancelled.flowId });
		expect(await t.client.request("account.authorizeCancel", { flowId: cancelled.flowId })).toEqual({
			cancelled: true,
		});
		await expect(cancelledWait).rejects.toMatchObject({ message: expect.stringContaining("取消") });
		expect((await t.client.request("account.status", {})).user).toBeUndefined();
		expect(() => statSync(t.accountFile)).toThrow();
		await t.close();
		site.server.close();

		// App authorization that only hands out tokens cannot sign Pier in.
		await start({ variant: "modern", appAuth: true });
		expect((await t.client.request("account.status", {})).site?.browserLogin).toBe(false);
		await expect(t.client.request("account.authorizeStart", {})).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("还不支持"),
		});
	});

	it("configures a group's key as a provider and creates keys in groups", async () => {
		await start({ variant: "modern" });
		await t.client.request("account.login", { username: "alice", password: PASSWORD });

		const created = await t.client.request("account.createToken", { name: "Pier", group: "vip" });
		expect(created.tokens[0]).toMatchObject({ id: created.tokenId, name: "Pier", group: "vip", status: 1 });

		const used = await t.client.request("account.useToken", { tokenId: 2 });
		expect(used.models).toEqual([
			{ id: "m-a", api: "openai-completions" },
			{ id: "m-b", api: "anthropic-messages" },
			{ id: "only-main", api: "openai-completions" },
		]);
		expect(JSON.stringify(used)).not.toContain(TOKEN_KEY_B);
		const provider = {
			id: "yunlian-vip",
			name: "云链API · vip",
			api: "openai-completions" as const,
			baseUrl: `${site.url}/v1`,
			models: [{ id: "m-a" }],
		};
		// The key reference belongs to the connection that asked for it.
		await expect(
			t.second.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const saved = await t.client.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true });
		expect(saved.provider).toMatchObject({ id: "yunlian-vip", stored: true });
		expect(await t.credentials.read("yunlian-vip")).toEqual({ type: "api_key", key: `sk-${TOKEN_KEY_B}` });

		expect(await t.client.request("account.logout", {})).toEqual({ loggedOut: true });
		expect(site.logouts).toBe(1);
		expect(() => statSync(t.accountFile)).toThrow();
		await expect(t.client.request("account.useToken", { tokenId: 2 })).rejects.toMatchObject({
			message: expect.stringContaining("请先登录"),
		});
		expect(await t.client.request("account.logout", {})).toEqual({ loggedOut: false });
	});

	it("writes a group's key into Claude Code and Codex from a key reference", async () => {
		await start({ variant: "modern" });
		await t.client.request("account.login", { username: "alice", password: PASSWORD });
		const used = await t.client.request("account.useToken", { tokenId: 2 });

		// The key reference belongs to the connection that asked for it.
		await expect(
			t.second.request("agentConfig.update", {
				runtime: "claude-code",
				scope: "user",
				changes: [{ path: ["env", "ANTHROPIC_AUTH_TOKEN"], apiKeyRef: used.keyRef }],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			t.client.request("agentConfig.update", {
				runtime: "claude-code",
				scope: "user",
				changes: [{ path: ["env", "ANTHROPIC_AUTH_TOKEN"], value: "x", apiKeyRef: used.keyRef }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const claude = await t.client.request("agentConfig.update", {
			runtime: "claude-code",
			scope: "user",
			changes: [
				{ path: ["env", "ANTHROPIC_BASE_URL"], value: site.url },
				{ path: ["env", "ANTHROPIC_AUTH_TOKEN"], apiKeyRef: used.keyRef },
				{ path: ["env", "ANTHROPIC_API_KEY"] },
			],
		});
		expect(claude.changed).toBe(true);
		const settings = JSON.parse(readFileSync(join(t.root, "claude", "settings.json"), "utf8"));
		expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: site.url, ANTHROPIC_AUTH_TOKEN: `sk-${TOKEN_KEY_B}` });

		const codex = await t.client.request("agentConfig.update", {
			runtime: "codex",
			scope: "user",
			changes: [
				{ path: ["model_providers", "yunlian-vip", "base_url"], value: `${site.url}/v1` },
				{ path: ["model_providers", "yunlian-vip", "wire_api"], value: "responses" },
				{ path: ["model_providers", "yunlian-vip", "experimental_bearer_token"], apiKeyRef: used.keyRef },
				{ path: ["model_provider"], value: "yunlian-vip" },
			],
		});
		expect(codex.changed).toBe(true);
		expect(readFileSync(join(t.root, "codex", "config.toml"), "utf8")).toContain(
			`experimental_bearer_token = "sk-${TOKEN_KEY_B}"`,
		);
	});

	it("registers with an email code and signs in", async () => {
		await start({ variant: "modern", emailVerification: true });
		await expect(
			t.client.request("account.register", { username: "bob", password: "bob-password" }),
		).rejects.toMatchObject({ message: expect.stringContaining("验证码") });
		expect(await t.client.request("account.sendCode", { email: "bob@example.com" })).toEqual({ sent: true });
		expect(site.codesSent).toEqual(["bob@example.com"]);
		await expect(
			t.client.request("account.register", {
				username: "bob",
				password: "bob-password",
				email: "bob@example.com",
				code: "000000",
			}),
		).rejects.toMatchObject({ message: expect.stringContaining("验证码错误") });
		const result = await t.client.request("account.register", {
			username: "bob",
			password: "bob-password",
			email: "bob@example.com",
			code: EMAIL_CODE,
		});
		expect(result.status).toBe("ok");
		expect(site.users.get("bob")).toBe("bob-password");
		await expect(t.client.request("account.register", { username: "x", password: "short" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("switches lines and keeps the login", async () => {
		site = await startFakeNewApi({ variant: "modern", twoFA: true });
		const proxy = await startProxy(site.url);
		const direct = site.url;
		const lines = [
			{ id: "cn", name: "国内线路", url: direct, description: "适合中国大陆网络" },
			{ id: "global", name: "国际线路", url: proxy.url },
		];
		try {
			t = await startHarness(lines);
			const initial = await t.client.request("account.status", {});
			expect(initial).toMatchObject({ line: "cn", lines, site: { url: direct } });
			// The default line alone is not saved.
			expect(() => statSync(t.accountFile)).toThrow();
			await expect(t.client.request("account.setLine", { line: "moon" })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});

			// Switching drops a sign-in waiting for its two-factor code.
			expect((await t.client.request("account.login", { username: "alice", password: PASSWORD })).status).toBe(
				"verify",
			);
			expect((await t.client.request("account.setLine", { line: "global" })).site?.url).toBe(proxy.url);
			await expect(t.client.request("account.verify", { code: TOTP })).rejects.toMatchObject({
				message: expect.stringContaining("重新输入"),
			});
			expect(JSON.parse(readFileSync(t.accountFile, "utf8"))).toEqual({ version: 1, line: "global" });

			// Signing in on the chosen line.
			site.url = proxy.url;
			await t.client.request("account.login", { username: "alice", password: PASSWORD });
			await t.client.request("account.verify", { code: TOTP });
			const port = (url: string) => new URL(url).port;
			expect(site.requests.at(-1)?.headers.host).toContain(port(proxy.url));
			expect(JSON.parse(readFileSync(t.accountFile, "utf8"))).toMatchObject({
				line: "global",
				session: { origin: proxy.url },
			});

			// The line and the login survive a restart; the login is renewed through the line.
			await t.restart();
			const restored = await t.client.request("account.status", {});
			expect(restored).toMatchObject({ line: "global", site: { url: proxy.url }, user: { username: "alice" } });
			expect((await t.client.request("account.overview", {})).site.url).toBe(proxy.url);
			const refresh = site.requests.filter((r) => r.path === "/api/user/auth/refresh").at(-1);
			expect(refresh?.headers.origin).toBe(proxy.url);
			expect(refresh?.headers.host).toContain(port(proxy.url));

			// Back to the domestic line: the same login keeps working there.
			site.url = direct;
			site.accessTokens.clear();
			const back = await t.client.request("account.setLine", { line: "cn" });
			expect(back).toMatchObject({ line: "cn", site: { url: direct }, user: { username: "alice" } });
			const overview = await t.client.request("account.overview", {});
			expect(overview.site.url).toBe(direct);
			expect(site.requests.at(-1)?.headers.host).toContain(port(direct));
			const saved = JSON.parse(readFileSync(t.accountFile, "utf8"));
			expect(saved.line).toBeUndefined();
			expect(saved.session.origin).toBe(direct);
			expect(saved.session.cookies.new_api_refresh).toBe(site.refreshToken);

			// Signing out keeps the chosen line.
			await t.client.request("account.setLine", { line: "global" });
			site.url = proxy.url;
			expect(await t.client.request("account.logout", {})).toEqual({ loggedOut: true });
			expect(JSON.parse(readFileSync(t.accountFile, "utf8"))).toEqual({ version: 1, line: "global" });
			await t.client.request("account.setLine", { line: "cn" });
			expect(() => statSync(t.accountFile)).toThrow();
		} finally {
			proxy.server.close();
		}
	});

	it("keeps a system access token login", async () => {
		await start({ variant: "modern" });
		const result = await t.client.request("account.login", { accessToken: PAT });
		expect(result.status).toBe("ok");
		expect(readFileSync(t.accountFile, "utf8")).toContain(PAT);
		await t.restart();
		expect((await t.client.request("account.overview", {})).user.username).toBe("alice");
		// The user's own access token is never revoked.
		await t.client.request("account.logout", {});
		expect(site.logouts).toBe(0);
	});
});
