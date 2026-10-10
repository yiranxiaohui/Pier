import type {
	AccountLine,
	AccountLoginResult,
	AccountOverview,
	AccountSite,
	AccountStatus,
	AgentConfigResult,
	NewApiGroup,
	NewApiModel,
	NewApiToken,
	ProviderInfo,
} from "@pier/protocol";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	accountTokenSelectionKey,
	readAccountTokenChoice,
	resolveAccountTokenChoice,
	saveAccountTokenChoice,
} from "../lib/account-tokens.ts";
import {
	CLAUDE_FAMILIES,
	claudeFamilyModel,
	claudeModels,
	claudeRelayChanges,
	claudeRelayState,
	codexModels,
	codexRelayChanges,
	codexRelayState,
	type RelayGroup,
	relayModels,
	tokenRelayModels,
} from "../lib/agent-relay.ts";
import { forwardCallbacks } from "../lib/browser-login.ts";
import { hostSpeaksMinor } from "../lib/settings-target.ts";
import { useAppState, useSettingsTarget, useStore } from "../lib/store.tsx";
import { findYunlianGroupProvider, formatQuota, relayProvider, YUNLIAN_NAME, yunlianGroupId } from "../lib/yunlian.ts";
import {
	IconAlert,
	IconCheck,
	IconChevronDown,
	IconExternal,
	IconKey,
	IconLoader,
	IconPlus,
	IconPower,
	IconRefresh,
	IconX,
} from "./Icons.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup } from "./SettingsUi.tsx";

/** 个人中心: the 云链API account behind Pier — sign-in, registration, balance and per-group keys. */

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ErrorBanner({ error }: { error?: string | undefined }) {
	if (!error) return null;
	return (
		<div className="banner error inline">
			<IconAlert size={15} />
			<span>{error}</span>
		</div>
	);
}

/** Run an async action with a busy flag and an error message. */
function useAction() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const run = useCallback(async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		try {
			await fn();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}, []);
	return { busy, error, setError, run };
}

function SiteHeader({ site }: { site: AccountSite }) {
	return (
		<div className="account-hero">
			{site.logo ? <img src={site.logo} alt="" className="account-logo" /> : <div className="account-logo" />}
			<div className="provider-main">
				<div className="account-hero-title">{site.name}</div>
				<div className="muted small">
					Pier 的模型服务由{site.name}提供。登录后可以查看余额，并把各分组的令牌一键配置到 pi、Claude Code 或 Codex。
				</div>
			</div>
		</div>
	);
}

// ---- sign-in and registration -----------------------------------------------------------

/** How long to wait for the user in the browser (the host abandons the flow after 10 minutes). */
const BROWSER_LOGIN_TIMEOUT_MS = 11 * 60_000;

/**
 * Sign in on the website in the system browser: every sign-in method of the site works there
 * (password, GitHub, LinuxDO, passkeys, human verification), and Pier never sees the password.
 * For another computer's Pier, this computer's host catches the browser's redirect and the
 * callback is forwarded to that computer, which keeps the login (protocol 1.28).
 */
function BrowserLogin({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const store = useStore();
	const target = useSettingsTarget();
	const [flow, setFlow] = useState<{ flowId: string; authorizeUrl: string } | undefined>();
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | undefined>();
	// Bumped to abandon the current attempt (cancel, retry or leaving the page).
	const attempt = useRef(0);
	const pending = useRef<string | undefined>(undefined);
	const relay = useRef<string | undefined>(undefined);

	const closeRelay = useCallback(() => {
		const relayId = relay.current;
		relay.current = undefined;
		if (relayId) void store.loopback("loopback.close", { relayId }).catch(() => undefined);
	}, [store]);

	const cancel = useCallback(() => {
		attempt.current++;
		const flowId = pending.current;
		pending.current = undefined;
		if (flowId) void store.account("account.authorizeCancel", { flowId }).catch(() => undefined);
		closeRelay();
		setFlow(undefined);
		setStarting(false);
	}, [store, closeRelay]);

	useEffect(() => cancel, [cancel]);

	const start = async () => {
		cancel();
		const current = ++attempt.current;
		const active = () => current === attempt.current;
		setError(undefined);
		setStarting(true);
		try {
			// Another computer: the browser returns to this computer, which hands the callback over.
			const opened = target.local ? undefined : await store.loopback("loopback.open", {});
			if (opened) {
				if (!active()) {
					void store.loopback("loopback.close", { relayId: opened.relayId }).catch(() => undefined);
					return;
				}
				relay.current = opened.relayId;
			}
			const started = await store.account("account.authorizeStart", opened ? { redirectUri: opened.redirectUri } : {});
			if (!active()) {
				void store.account("account.authorizeCancel", { flowId: started.flowId }).catch(() => undefined);
				return;
			}
			pending.current = started.flowId;
			const forwarding = opened
				? forwardCallbacks(
						{
							next: () => store.loopback("loopback.next", { relayId: opened.relayId }, BROWSER_LOGIN_TIMEOUT_MS),
							forward: (query) => store.account("account.authorizeCallback", { flowId: started.flowId, query }, 60_000),
							respond: (requestId, page) =>
								store.loopback("loopback.respond", { relayId: opened.relayId, requestId, ...page }),
						},
						active,
					)
				: undefined;
			setFlow(started);
			setStarting(false);
			store.openExternal(started.authorizeUrl);
			try {
				const result = await store.account(
					"account.authorizeWait",
					{ flowId: started.flowId },
					BROWSER_LOGIN_TIMEOUT_MS,
				);
				if (!active()) return;
				pending.current = undefined;
				setFlow(undefined);
				onDone(result);
			} finally {
				// Let the browser show the outcome before the relay closes.
				await forwarding?.settle();
				if (relay.current === opened?.relayId) closeRelay();
			}
		} catch (e) {
			if (!active()) return;
			pending.current = undefined;
			closeRelay();
			setFlow(undefined);
			setStarting(false);
			setError(errorText(e));
		}
	};

	if (flow) {
		return (
			<div className="account-form">
				<p className="account-waiting">
					<IconLoader size={14} className="spin" />
					<span>已在浏览器中打开{site.name}，请在网页上登录，并在授权页面点击「授权」。完成后会自动回到这里。</span>
				</p>
				<div className="account-actions">
					<div className="account-links muted small">
						<button type="button" className="link-button" onClick={() => store.openExternal(flow.authorizeUrl)}>
							<IconExternal size={12} /> 浏览器没有打开？重新打开
						</button>
					</div>
					<button type="button" onClick={cancel}>
						取消
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="account-form">
			<p className="muted">
				在浏览器中登录{site.name}
				{site.oauth.length ? `（支持账号密码、${site.oauth.join("、")} 等所有登录方式）` : ""}
				，并允许 Pier 访问你的账户。没有账号可以在登录页面注册。
				{target.local ? "" : `浏览器在这台电脑上打开，登录状态保存在 ${target.name} 上的 Pier 中。`}
			</p>
			<ErrorBanner error={error} />
			<div className="account-actions">
				<span />
				<button type="button" className="primary" disabled={starting} onClick={() => void start()}>
					{starting ? <IconLoader size={14} className="spin" /> : <IconExternal size={14} />}
					在浏览器中登录
				</button>
			</div>
			<p className="muted small">Pier 不会接触你的密码，只保存一个可以随时在网页「登录会话」中注销的登录状态。</p>
		</div>
	);
}

function LoginForm({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const store = useStore();
	const [mode, setMode] = useState<"password" | "token">(site.passwordLogin && !site.turnstile ? "password" : "token");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [accessToken, setAccessToken] = useState("");
	const [userId, setUserId] = useState("");
	const [verifying, setVerifying] = useState(false);
	const [code, setCode] = useState("");
	const { busy, error, setError, run } = useAction();

	const finish = (result: AccountLoginResult) => {
		if (result.status === "verify") {
			setVerifying(true);
			setCode("");
			return;
		}
		setPassword("");
		onDone(result);
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		void run(async () => {
			if (verifying) {
				if (!code.trim()) throw new Error("请输入验证码");
				finish(await store.account("account.verify", { code: code.trim() }));
			} else if (mode === "password") {
				if (!username.trim() || !password) throw new Error("请填写用户名和密码");
				finish(await store.account("account.login", { username: username.trim(), password }));
			} else {
				if (!accessToken.trim()) throw new Error("请填写系统访问令牌");
				const id = Number(userId.trim());
				if (userId.trim() && !(Number.isInteger(id) && id > 0)) throw new Error("用户 ID 必须是正整数");
				finish(
					await store.account("account.login", {
						accessToken: accessToken.trim(),
						...(userId.trim() ? { userId: id } : {}),
					}),
				);
			}
		});
	};

	if (verifying) {
		return (
			<form className="account-form" onSubmit={submit}>
				<p className="muted">该账号开启了两步验证，请输入身份验证器中的 6 位验证码（也可以使用备用码）。</p>
				<label className="form-field">
					<span className="field-label">验证码</span>
					<input
						// biome-ignore lint/a11y/noAutofocus: the only field of this step.
						autoFocus
						inputMode="numeric"
						autoComplete="one-time-code"
						placeholder="123456"
						value={code}
						onChange={(e) => setCode(e.target.value)}
					/>
				</label>
				<ErrorBanner error={error} />
				<div className="account-actions">
					<button type="button" onClick={() => setVerifying(false)}>
						返回
					</button>
					<button type="submit" className="primary" disabled={busy || !code.trim()}>
						{busy ? <IconLoader size={14} className="spin" /> : null}
						验证
					</button>
				</div>
			</form>
		);
	}

	return (
		<form className="account-form" onSubmit={submit}>
			{mode === "password" ? (
				<div className="form-grid">
					<label className="form-field">
						<span className="field-label">用户名或邮箱</span>
						<input
							// biome-ignore lint/a11y/noAutofocus: first field of the form.
							autoFocus
							autoComplete="username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
						/>
					</label>
					<label className="form-field">
						<span className="field-label">密码</span>
						<input
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</label>
				</div>
			) : (
				<>
					<div className="form-grid">
						<label className="form-field">
							<span className="field-label">系统访问令牌</span>
							<input
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={accessToken}
								onChange={(e) => setAccessToken(e.target.value)}
							/>
						</label>
						<label className="form-field">
							<span className="field-label">用户 ID（可选）</span>
							<input
								inputMode="numeric"
								placeholder="可选"
								value={userId}
								onChange={(e) => setUserId(e.target.value.replace(/\D/g, ""))}
							/>
						</label>
					</div>
					<p className="muted small">
						用 {site.oauth.length ? site.oauth.join("、") : "第三方账号"} 登录的账号没有密码：请在网页控制台「个人设置 →
						安全设置」中生成系统访问令牌，粘贴到这里。
						<button type="button" className="link-button" onClick={() => store.openExternal(`${site.url}/profile`)}>
							<IconExternal size={12} /> 打开个人设置
						</button>
					</p>
				</>
			)}
			<ErrorBanner error={error} />
			<div className="account-actions">
				<div className="account-links muted small">
					{site.passwordLogin && !site.turnstile ? (
						<button
							type="button"
							className="link-button"
							onClick={() => {
								setMode(mode === "password" ? "token" : "password");
								setError(undefined);
							}}
						>
							{mode === "password"
								? `${site.oauth.length ? `${site.oauth.join(" / ")} 账号？` : ""}使用访问令牌登录`
								: "使用账号密码登录"}
						</button>
					) : null}
					{mode === "password" ? (
						<button type="button" className="link-button" onClick={() => store.openExternal(`${site.url}/reset`)}>
							忘记密码
						</button>
					) : null}
				</div>
				<button type="submit" className="primary" disabled={busy}>
					{busy ? <IconLoader size={14} className="spin" /> : mode === "token" ? <IconKey size={14} /> : null}
					登录
				</button>
			</div>
			{mode === "password" ? <p className="muted small">密码只用于这次登录，不会被保存。</p> : null}
		</form>
	);
}

const CODE_COOLDOWN_S = 60;

function RegisterForm({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const store = useStore();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [affCode, setAffCode] = useState("");
	const [cooldown, setCooldown] = useState(0);
	const [sent, setSent] = useState(false);
	const { busy, error, setError, run } = useAction();
	const sending = useAction();

	useEffect(() => {
		if (cooldown <= 0) return;
		const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
		return () => clearTimeout(timer);
	}, [cooldown]);

	if (!site.registerEnabled || site.turnstile) {
		return (
			<div className="account-form">
				<p className="muted">
					{site.registerEnabled
						? `${site.name} 注册需要人机验证，请在网页上完成注册，然后回到这里登录。`
						: `${site.name} 目前没有开放账号密码注册${site.oauth.length ? `，可以在网页上用 ${site.oauth.join("、")} 登录` : ""}。`}
				</p>
				<div className="account-actions">
					<span />
					<button type="button" onClick={() => store.openExternal(`${site.url}/register`)}>
						<IconExternal size={14} />
						在网页上注册
					</button>
				</div>
			</div>
		);
	}

	const sendCode = () =>
		void sending.run(async () => {
			if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error("请填写有效的邮箱地址");
			await store.account("account.sendCode", { email: email.trim() });
			setSent(true);
			setCooldown(CODE_COOLDOWN_S);
		});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		void run(async () => {
			const name = username.trim();
			if (!name) throw new Error("请填写用户名");
			if ([...name].length > 20) throw new Error("用户名最多 20 个字符");
			if (password.length < 8) throw new Error("密码至少 8 位");
			if (password !== confirm) throw new Error("两次输入的密码不一致");
			if (site.emailVerification && (!email.trim() || !code.trim())) throw new Error("请填写邮箱并输入收到的验证码");
			const result = await store.account("account.register", {
				username: name,
				password,
				...(email.trim() ? { email: email.trim() } : {}),
				...(code.trim() ? { code: code.trim() } : {}),
				...(affCode.trim() ? { affCode: affCode.trim() } : {}),
			});
			setPassword("");
			setConfirm("");
			onDone(result);
		});
	};

	return (
		<form className="account-form" onSubmit={submit}>
			<div className="form-grid">
				<label className="form-field">
					<span className="field-label">用户名</span>
					<input
						// biome-ignore lint/a11y/noAutofocus: first field of the form.
						autoFocus
						autoComplete="username"
						maxLength={20}
						placeholder="最多 20 个字符"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
					/>
				</label>
				<label className="form-field">
					<span className="field-label">邀请码（可选）</span>
					<input value={affCode} maxLength={32} onChange={(e) => setAffCode(e.target.value)} />
				</label>
				<label className="form-field">
					<span className="field-label">密码</span>
					<input
						type="password"
						autoComplete="new-password"
						placeholder="至少 8 位"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</label>
				<label className="form-field">
					<span className="field-label">确认密码</span>
					<input
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
					/>
				</label>
				{site.emailVerification ? (
					<>
						<div className="form-field">
							<span className="field-label">邮箱</span>
							<div className="auth-input-row">
								<input
									type="email"
									autoComplete="email"
									maxLength={50}
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
								<button type="button" disabled={sending.busy || cooldown > 0} onClick={sendCode}>
									{sending.busy ? <IconLoader size={13} className="spin" /> : null}
									{cooldown > 0 ? `${cooldown} 秒` : sent ? "重新发送" : "发送验证码"}
								</button>
							</div>
						</div>
						<label className="form-field">
							<span className="field-label">邮箱验证码</span>
							<input
								inputMode="numeric"
								autoComplete="one-time-code"
								value={code}
								onChange={(e) => setCode(e.target.value)}
							/>
						</label>
					</>
				) : null}
			</div>
			{sent && !sending.error ? <p className="muted small">验证码已发送到 {email.trim()}，请查收邮件。</p> : null}
			<ErrorBanner error={sending.error ?? error} />
			<div className="account-actions">
				<span />
				<button
					type="submit"
					className="primary"
					disabled={busy}
					onClick={() => {
						sending.setError(undefined);
						setError(undefined);
					}}
				>
					{busy ? <IconLoader size={14} className="spin" /> : null}
					注册并登录
				</button>
			</div>
		</form>
	);
}

function SignIn({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const [tab, setTab] = useState<"login" | "register">("login");
	const target = useSettingsTarget();
	// The browser returns to a loopback address on this computer. A paired computer's Pier takes
	// the forwarded callback since protocol 1.28; older ones sign in with a password or a token.
	const browser = site.browserLogin && (target.local || hostSpeaksMinor(target.hostInfo, 28));
	if (browser) {
		return (
			<SettingsGroup>
				<SettingsCard className="account-card">
					<SiteHeader site={site} />
					<BrowserLogin site={site} onDone={onDone} />
				</SettingsCard>
			</SettingsGroup>
		);
	}
	// Sites without browser sign-in: enter the password or a system access token in Pier.
	return (
		<SettingsGroup>
			<SettingsCard className="account-card">
				<SiteHeader site={site} />
				{site.browserLogin ? (
					<p className="muted small">
						{target.name} 上的 Pier 版本过旧，还不能从这台电脑用浏览器登录（需要协议 1.28
						或更高）。请先在「关于与更新」中更新那台电脑，或在这里用账号密码、访问令牌登录，登录状态保存在 {target.name}{" "}
						上的 Pier 中。
					</p>
				) : null}
				<div className="segmented" role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "login"}
						className={tab === "login" ? "active" : ""}
						onClick={() => setTab("login")}
					>
						登录
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "register"}
						className={tab === "register" ? "active" : ""}
						onClick={() => setTab("register")}
					>
						注册
					</button>
				</div>
				{tab === "login" ? <LoginForm site={site} onDone={onDone} /> : <RegisterForm site={site} onDone={onDone} />}
			</SettingsCard>
		</SettingsGroup>
	);
}

// ---- signed in --------------------------------------------------------------------------

interface GroupEntry extends NewApiGroup {
	tokens: NewApiToken[];
	/** Not among the groups the account may use any more. */
	unavailable?: boolean;
}

/** Tokens sorted into the account's groups; tokens without a group use the user's own group. */
function groupEntries(overview: AccountOverview): GroupEntry[] {
	const own = overview.user.group || "default";
	const entries = new Map<string, GroupEntry>(overview.groups.map((g) => [g.name, { ...g, tokens: [] }]));
	for (const token of overview.tokens) {
		const name = token.group || own;
		let entry = entries.get(name);
		if (!entry) {
			entry = { name, tokens: [], unavailable: true };
			entries.set(name, entry);
		}
		entry.tokens.push(token);
	}
	const rank = (e: GroupEntry) => (e.name === own ? 0 : e.unavailable ? 2 : 1);
	return [...entries.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** A token name within NewAPI's 50-byte limit. */
function tokenName(group: string): string {
	const encoder = new TextEncoder();
	let name = `Pier · ${group}`;
	while (encoder.encode(name).length > 50) name = name.slice(0, -1);
	return name;
}

function ratioText(ratio: NewApiGroup["ratio"]): string | undefined {
	if (ratio === undefined) return undefined;
	return typeof ratio === "number" ? `${Number(ratio.toFixed(4))} 倍率` : String(ratio);
}

/** Claude Code's and Codex's user configuration on the managed computer, when it could be read. */
interface AgentConfigs {
	claude?: AgentConfigResult | undefined;
	codex?: AgentConfigResult | undefined;
}

/** Pointing Claude Code and Codex at a group needs protocol 1.25 (key references in `agentConfig.update`). */
const AGENT_RELAY_MINOR = 25;

/** Read both user files, again whenever Pier changes one of them. */
function useAgentConfigs(enabled: boolean): AgentConfigs | undefined {
	const store = useStore();
	const version = useAppState((s) => s.agentConfigVersion);
	const node = useAppState((s) => s.settingsNode);
	const [configs, setConfigs] = useState<AgentConfigs | undefined>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: reread when a file changes or the computer does.
	useEffect(() => {
		if (!enabled) {
			setConfigs(undefined);
			return;
		}
		let live = true;
		void Promise.all([
			store.getAgentConfig("claude-code").catch(() => undefined),
			store.getAgentConfig("codex").catch(() => undefined),
		]).then(([claude, codex]) => {
			if (live) setConfigs({ claude, codex });
		});
		return () => {
			live = false;
		};
	}, [store, enabled, version, node]);
	return configs;
}

function userSettings(config: AgentConfigResult | undefined) {
	return config?.files.find((f) => f.scope === "user")?.settings;
}

function userPath(config: AgentConfigResult | undefined, fallback: string): string {
	return config?.files.find((f) => f.scope === "user")?.path ?? fallback;
}

/** The chosen token's key reference and the models it lists (`account.useToken`). */
interface TakenToken {
	keyRef: string;
	models: NewApiModel[];
	modelsError?: string | undefined;
}

type TakeToken = () => Promise<TakenToken>;

/** `group` with the token's models when its own are not known yet (the group is not added to pi). */
function withTokenModels(group: RelayGroup, used: TakenToken): RelayGroup {
	if (group.models.length) return group;
	const models = tokenRelayModels(used.models);
	if (!models.length) {
		throw new Error(
			used.modelsError ? `无法获取${group.name}的模型列表：${used.modelsError}` : `${group.name} 没有返回可用的模型`,
		);
	}
	return { ...group, models };
}

function NotInstalled({ config }: { config: AgentConfigResult | undefined }) {
	return config && !config.available ? <span className="mini-tag">未安装</span> : null;
}

function InUse({ label = "正在使用" }: { label?: string }) {
	return (
		<span className="mini-tag ok">
			<IconCheck size={11} />
			{label}
		</span>
	);
}

/** Add the group as a provider of the built-in pi, with every model the token can use. */
function PiRelayRow({
	entry,
	overview,
	provider,
	takeToken,
}: {
	entry: GroupEntry;
	overview: AccountOverview;
	provider: ProviderInfo | undefined;
	takeToken: TakeToken;
}) {
	const store = useStore();
	const { busy, error, run } = useAction();
	const name = provider?.name ?? `${overview.site.name} · ${entry.name}`;

	const write = () =>
		void run(async () => {
			const used = await takeToken();
			const target = { id: yunlianGroupId(entry.name), name, siteUrl: overview.site.url };
			const next = relayProvider(target, used.models, provider?.custom, used.modelsError);
			await store.saveCustomProvider(next, { apiKeyRef: used.keyRef }, !provider?.custom);
			store.toast("info", `已把 pi 接入${entry.name}，可以在「模型与服务商」中查看和编辑`);
		});

	return (
		<>
			<div className="provider-row account-agent-row">
				<div className="provider-main">
					<div className="provider-name">
						pi
						{provider ? <InUse label="已添加" /> : null}
					</div>
					<div className="muted small">
						{provider
							? `已添加为服务商「${provider.name}」· ${provider.availableCount || provider.modelCount} 个模型；更新会重新读取令牌可用的模型。`
							: `读取令牌可用的全部模型，添加为 Pier 内置 pi 的服务商「${name}」，可以在「模型与服务商」中查看和编辑。`}
					</div>
				</div>
				<div className="row-actions">
					<button type="button" className={provider ? "" : "primary"} disabled={busy} onClick={write}>
						{busy ? <IconLoader size={13} className="spin" /> : null}
						{provider ? "更新" : "接入"}
					</button>
				</div>
			</div>
			{error ? (
				<div className="account-group-error">
					<ErrorBanner error={error} />
				</div>
			) : null}
		</>
	);
}

/** Write a group's endpoint, token and models into Claude Code's user settings. */
function ClaudeRelayRow({
	group,
	loaded,
	config,
	takeToken,
}: {
	group: RelayGroup;
	/** The group's models are known (otherwise they are read from the token when writing). */
	loaded: boolean;
	config: AgentConfigResult | undefined;
	takeToken: TakeToken;
}) {
	const store = useStore();
	const models = claudeModels(group);
	const state = claudeRelayState(userSettings(config), group);
	const inUse = loaded && state.group;
	const [model, setModel] = useState(inUse && state.model && models.includes(state.model) ? state.model : "");
	const { busy, error, run } = useAction();
	const aliases = CLAUDE_FAMILIES.flatMap((family) => {
		const id = claudeFamilyModel(models, family);
		return id ? [`${family} → ${id}`] : [];
	});
	const path = userPath(config, "~/.claude/settings.json");
	const unusable = loaded && !models.length;

	const write = () =>
		void run(async () => {
			const used = await takeToken();
			const target = withTokenModels(group, used);
			const usable = claudeModels(target);
			if (!usable.length) throw new Error("这个分组没有通过 Anthropic 接口提供的模型，Claude Code 无法使用。");
			const chosen = model && usable.includes(model) ? model : undefined;
			await store.updateAgentUserConfig("claude-code", claudeRelayChanges(target, used.keyRef, chosen));
			store.toast("info", `已把 Claude Code 接入${group.name}，新建的会话生效`);
		});

	return (
		<>
			<div className="provider-row account-agent-row">
				<div className="provider-main">
					<div className="provider-name">
						Claude Code
						{inUse ? <InUse /> : null}
						<NotInstalled config={config} />
					</div>
					<div className="muted small">
						{unusable
							? "这个分组没有通过 Anthropic 接口提供的模型，Claude Code 无法使用。"
							: `写入 ${path} 的 API 地址与令牌${aliases.length ? `，别名 ${aliases.join("、")}` : loaded ? "" : "，按分组的模型设置别名"}；会移除其中的 ANTHROPIC_API_KEY 与 apiKeyHelper。`}
					</div>
				</div>
				<div className="row-actions">
					<Select
						className="setting-select compact account-token-select"
						value={model}
						disabled={busy || !models.length}
						title="默认模型"
						onChange={setModel}
						options={[{ value: "", label: "默认模型：按别名" }, ...models.map((id) => ({ value: id, label: id }))]}
					/>
					<button type="button" className={inUse ? "" : "primary"} disabled={busy || unusable} onClick={write}>
						{busy ? <IconLoader size={13} className="spin" /> : null}
						{inUse ? "更新" : "接入"}
					</button>
				</div>
			</div>
			{error ? (
				<div className="account-group-error">
					<ErrorBanner error={error} />
				</div>
			) : null}
		</>
	);
}

/** Add the group as a Codex provider with the token and make it Codex's current one. */
function CodexRelayRow({
	group,
	loaded,
	config,
	takeToken,
}: {
	group: RelayGroup;
	/** The group's models are known (otherwise they are read from the token when writing). */
	loaded: boolean;
	config: AgentConfigResult | undefined;
	takeToken: TakeToken;
}) {
	const store = useStore();
	const models = codexModels(group);
	const state = codexRelayState(userSettings(config), group);
	const initial =
		(state.current && state.model && models.some((m) => m.id === state.model) ? state.model : undefined) ??
		models[0]?.id ??
		"";
	const [model, setModel] = useState(initial);
	const { busy, error, run } = useAction();
	const chosen = models.find((m) => m.id === model) ?? models[0];
	const path = userPath(config, "~/.codex/config.toml");
	const unusable = loaded && !models.length;

	const write = () =>
		void run(async () => {
			const used = await takeToken();
			const target = withTokenModels(group, used);
			const list = codexModels(target);
			const pick = list.find((m) => m.id === model) ?? list[0];
			if (!pick) throw new Error(`${group.name} 没有返回可用的模型`);
			await store.updateAgentUserConfig("codex", codexRelayChanges(target, used.keyRef, pick.id));
			store.toast("info", `已把 Codex 接入${group.name}（${pick.id}），新建的会话生效`);
		});

	return (
		<>
			<div className="provider-row account-agent-row">
				<div className="provider-main">
					<div className="provider-name">
						Codex
						{state.current ? <InUse /> : null}
						<NotInstalled config={config} />
					</div>
					<div className="muted small">
						{chosen && !chosen.suited
							? "Codex 用 Responses API 调用模型，这个模型的渠道需要支持它（OpenAI 类模型最合适）。"
							: `在 ${path} 中添加服务商 ${group.id}（Responses API）并设为当前，同时设置默认模型。`}
					</div>
				</div>
				<div className="row-actions">
					<Select
						className="setting-select compact account-token-select"
						value={chosen?.id ?? ""}
						disabled={busy || !models.length}
						title="默认模型"
						onChange={setModel}
						options={
							models.length
								? models.map((m) => ({ value: m.id, label: m.id }))
								: [{ value: "", label: "默认模型：自动选择" }]
						}
					/>
					<button type="button" className={state.current ? "" : "primary"} disabled={busy || unusable} onClick={write}>
						{busy ? <IconLoader size={13} className="spin" /> : null}
						{state.current ? "更新" : "接入"}
					</button>
				</div>
			</div>
			{error ? (
				<div className="account-group-error">
					<ErrorBanner error={error} />
				</div>
			) : null}
		</>
	);
}

/** Where a group is configured: pi's provider, Claude Code's and Codex's user configuration. */
interface GroupTargets {
	provider?: ProviderInfo | undefined;
	relay: RelayGroup;
	/** The relay's models are known: from pi's provider or read from a token. */
	loaded: boolean;
	claude: boolean;
	codex: boolean;
	/** Codex has a provider entry for the group (even when it is not the current one). */
	codexDefined: boolean;
}

function groupTargets(
	entry: GroupEntry,
	overview: AccountOverview,
	provider: ProviderInfo | undefined,
	agents: AgentConfigs | undefined,
	fetched?: RelayGroup["models"],
): GroupTargets {
	const models = provider?.custom ? relayModels(provider.custom) : fetched;
	const relay: RelayGroup = {
		id: provider?.id ?? yunlianGroupId(entry.name),
		name: provider?.name ?? `${overview.site.name} · ${entry.name}`,
		siteUrl: overview.site.url,
		models: models ?? [],
	};
	const loaded = models !== undefined;
	const codex = agents ? codexRelayState(userSettings(agents.codex), relay) : undefined;
	return {
		provider,
		relay,
		loaded,
		claude: loaded && agents ? claudeRelayState(userSettings(agents.claude), relay).group : false,
		codex: codex?.current ?? false,
		codexDefined: codex?.defined ?? false,
	};
}

function GroupRow({
	entry,
	selectionKey,
	overview,
	provider,
	agents,
	fresh,
	onTokens,
	onRemove,
}: {
	entry: GroupEntry;
	selectionKey: string;
	overview: AccountOverview;
	/** The pi provider configured for this group, if any. */
	provider?: ProviderInfo | undefined;
	/** Claude Code's and Codex's configuration, when the host can point them at the group. */
	agents?: AgentConfigs | undefined;
	/** Just added: open the choice of where to configure it. */
	fresh?: boolean;
	onTokens: (tokens: NewApiToken[]) => void;
	/** Drop a group that is not configured anywhere. */
	onRemove?: (() => void) | undefined;
}) {
	const store = useStore();
	const usable = entry.tokens.filter((t) => t.status === 1);
	const [choice, setChoice] = useState(() => readAccountTokenChoice(selectionKey));
	const [open, setOpen] = useState(fresh === true);
	// Models read from a token, for Claude Code and Codex while the group is not added to pi.
	const [fetched, setFetched] = useState<RelayGroup["models"] | undefined>();
	const [fetchError, setFetchError] = useState<string | undefined>();
	const fetching = useRef(false);
	const chooseToken = (value: number | "new") => {
		saveAccountTokenChoice(selectionKey, value);
		setChoice(value);
		setFetchError(undefined);
	};
	const selected = resolveAccountTokenChoice(choice, entry.tokens);
	const ratio = ratioText(entry.ratio);
	const targets = groupTargets(entry, overview, provider, agents, fetched);
	const configured = provider !== undefined || targets.claude || targets.codexDefined;

	/** A key reference for the chosen token, creating the token first when asked to. */
	const takeToken = async (): Promise<TakenToken> => {
		let tokenId: number;
		if (selected === "new") {
			const created = await store.account("account.createToken", { name: tokenName(entry.name), group: entry.name });
			onTokens(created.tokens);
			tokenId = created.tokenId;
			chooseToken(tokenId);
		} else tokenId = selected;
		const used = await store.account("account.useToken", { tokenId });
		const models = tokenRelayModels(used.models);
		if (models.length) setFetched(models);
		return used;
	};

	// Claude Code and Codex need the group's models: read them from an existing token (a new one
	// is created only when the user configures something).
	const needModels = open && agents !== undefined && !targets.loaded && selected !== "new" && !fetchError;
	useEffect(() => {
		if (!needModels || fetching.current || typeof selected !== "number") return;
		fetching.current = true;
		void store
			.account("account.useToken", { tokenId: selected })
			.then((used) => {
				const models = tokenRelayModels(used.models);
				if (models.length) setFetched(models);
				else setFetchError(used.modelsError ?? "这个令牌没有返回可用的模型");
			})
			.catch((e: unknown) => setFetchError(errorText(e)))
			.finally(() => {
				fetching.current = false;
			});
	}, [store, needModels, selected]);

	return (
		<div className="account-group">
			<div className="provider-row">
				<div className="provider-main">
					<div className="provider-name">
						{entry.name}
						{ratio ? <span className="mini-tag">{ratio}</span> : null}
						{entry.name === (overview.user.group || "default") ? <span className="mini-tag">我的分组</span> : null}
						{configured ? <InUse label="已配置" /> : null}
						{provider ? <span className="mini-tag accent">pi</span> : null}
						{targets.claude ? <span className="mini-tag accent">Claude Code</span> : null}
						{targets.codex ? <span className="mini-tag accent">Codex</span> : null}
					</div>
					<div className="muted small">
						{[
							entry.unavailable ? "当前账号不可用的分组" : entry.description,
							provider
								? `本地服务商「${provider.name}」· ${provider.availableCount || provider.modelCount} 个模型`
								: `${usable.length} 个可用令牌`,
						]
							.filter(Boolean)
							.join(" · ")}
					</div>
				</div>
				<div className="row-actions">
					<Select<number | "new">
						className="setting-select compact account-token-select"
						value={selected}
						onChange={chooseToken}
						options={[
							...usable.map((token) => ({
								value: token.id,
								label: `${token.name} · ${token.maskedKey || `#${token.id}`}`,
							})),
							{ value: "new", label: "新建令牌" },
						]}
					/>
					<button
						type="button"
						className={["account-agents-toggle", open ? "open" : "", configured || open ? "" : "primary"]
							.filter(Boolean)
							.join(" ")}
						title={agents ? "选择把这个分组配置到 pi、Claude Code 或 Codex" : "把这个分组配置到 pi"}
						aria-expanded={open}
						onClick={() => setOpen((v) => !v)}
					>
						{agents ? "配置到 pi / Claude Code / Codex" : "配置到 pi"}
						<IconChevronDown size={12} className="account-agents-chevron" />
					</button>
					{!configured && onRemove ? (
						<button type="button" className="ghost icon" title="不添加这个分组" onClick={onRemove}>
							<IconX size={13} />
						</button>
					) : null}
				</div>
			</div>
			{open ? (
				<div className="account-agents">
					<PiRelayRow entry={entry} overview={overview} provider={provider} takeToken={takeToken} />
					{agents ? (
						<>
							<ClaudeRelayRow
								key={`claude-${targets.loaded}`}
								group={targets.relay}
								loaded={targets.loaded}
								config={agents.claude}
								takeToken={takeToken}
							/>
							<CodexRelayRow
								key={`codex-${targets.loaded}`}
								group={targets.relay}
								loaded={targets.loaded}
								config={agents.codex}
								takeToken={takeToken}
							/>
						</>
					) : null}
					<p className="muted small">
						{needModels ? (
							<>
								<IconLoader size={12} className="spin" /> 正在读取这个分组的模型…{" "}
							</>
						) : fetchError ? (
							`读取模型失败：${fetchError}。接入时会再读取一次。`
						) : null}
						使用上方选择的令牌，密钥由 Pier Host 直接写入配置（Claude Code / Codex 的配置文件与终端中的 claude / codex
						共用）。之后可以在「模型与服务商」与「Agent 配置」中查看和修改。
					</p>
				</div>
			) : null}
		</div>
	);
}

/** `localStorage[ADDED_GROUPS_KEY]`: groups added to the list, by computer and site. */
const ADDED_GROUPS_KEY = "pier.accountGroups";

function readAddedGroups(): Record<string, string[]> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(ADDED_GROUPS_KEY) ?? "{}");
		return typeof value === "object" && value !== null ? (value as Record<string, string[]>) : {};
	} catch {
		return {};
	}
}

/**
 * The groups the user added to the list on a computer, kept across restarts: a group pointed only
 * at Claude Code cannot be told from Claude Code's settings without the group's models.
 */
function useAddedGroups(node: string, site: string) {
	const key = `${node}\n${site}`;
	const [all, setAll] = useState(readAddedGroups);
	const list = all[key] ?? [];
	const update = useCallback(
		(change: (list: string[]) => string[]) =>
			setAll((current) => {
				const stored = { ...readAddedGroups(), ...current };
				const next = [...new Set(change(stored[key] ?? []))];
				if (next.length) stored[key] = next;
				else delete stored[key];
				try {
					localStorage.setItem(ADDED_GROUPS_KEY, JSON.stringify(stored));
				} catch {
					// Not persisted; the list still works for this visit.
				}
				return stored;
			}),
		[key],
	);
	return [list, update] as const;
}

function Dashboard({
	overview,
	loading,
	onRefresh,
	onTokens,
	onLogout,
}: {
	overview: AccountOverview;
	loading: boolean;
	onRefresh: () => void;
	onTokens: (tokens: NewApiToken[]) => void;
	onLogout: () => Promise<void>;
}) {
	const store = useStore();
	const providers = useAppState((s) => s.providers);
	const target = useSettingsTarget();
	const [confirm, setConfirm] = useState(false);
	const agents = useAgentConfigs(!target.hostInfo || hostSpeaksMinor(target.hostInfo, AGENT_RELAY_MINOR));
	const { site, user } = overview;
	const entries = useMemo(() => groupEntries(overview), [overview]);
	const byId = new Map(providers?.providers.map((p) => [p.id, p]));
	// Groups configured somewhere are listed, and the ones the user added; others are added one at a time.
	const node = useAppState((s) => s.settingsNode);
	const [picked, setPicked] = useAddedGroups(node, site.name);
	const [fresh, setFresh] = useState<string[]>([]);
	const [picking, setPicking] = useState(false);
	const groupNames = entries.map((e) => e.name);
	const providerOf = (entry: GroupEntry) => findYunlianGroupProvider(byId, entry.name, groupNames, site.name);
	const isConfigured = (entry: GroupEntry) => {
		const targets = groupTargets(entry, overview, providerOf(entry), agents);
		return targets.provider !== undefined || targets.claude || targets.codexDefined;
	};
	const shown = entries.filter((e) => isConfigured(e) || picked.includes(e.name));
	const addable = entries.filter((e) => !e.unavailable && !isConfigured(e) && !picked.includes(e.name));
	const [pick, setPick] = useState("");
	const pickValue = addable.some((e) => e.name === pick) ? pick : (addable[0]?.name ?? "");
	const addPicked = () => {
		if (!pickValue) return;
		setPicked((list) => [...list, pickValue]);
		setFresh((list) => [...list, pickValue]);
		setPicking(false);
	};
	const quota = (value: number) => formatQuota(value, site.quota);
	const name = user.displayName && user.displayName !== user.username ? user.displayName : user.username;

	return (
		<>
			<SettingsGroup
				title="账户"
				actions={
					<button type="button" className="ghost" disabled={loading} onClick={onRefresh}>
						{loading ? <IconLoader size={13} className="spin" /> : <IconRefresh size={13} />}
						刷新
					</button>
				}
			>
				<SettingsCard>
					<SettingRow
						title={
							<span className="account-user">
								<span className="account-avatar">{[...name][0]?.toUpperCase()}</span>
								<span>
									{name}
									{name !== user.username ? <span className="muted"> （{user.username}）</span> : null}
								</span>
							</span>
						}
						description={[
							user.email,
							user.group ? `分组 ${user.group}` : "",
							user.id ? `ID ${user.id}` : "",
							`${site.name}（${new URL(site.url).host}）`,
						]
							.filter(Boolean)
							.join(" · ")}
					>
						<button type="button" onClick={() => store.openExternal(`${site.url}/dashboard`)}>
							<IconExternal size={13} />
							网页控制台
						</button>
						<button
							type="button"
							className={confirm ? "danger" : "ghost"}
							onBlur={() => setConfirm(false)}
							onClick={() => {
								if (!confirm) {
									setConfirm(true);
									return;
								}
								void onLogout();
							}}
						>
							<IconPower size={13} />
							{confirm ? "确认退出" : "退出登录"}
						</button>
					</SettingRow>
				</SettingsCard>
				<div className="account-stats">
					<div className="account-stat primary">
						<div className="muted small">当前余额</div>
						<div className="account-stat-value">{quota(user.quota)}</div>
						<button type="button" className="primary" onClick={() => store.openExternal(`${site.url}/wallet`)}>
							<IconExternal size={13} />
							充值
						</button>
					</div>
					<div className="account-stat">
						<div className="muted small">历史消耗</div>
						<div className="account-stat-value">{quota(user.usedQuota)}</div>
					</div>
					<div className="account-stat">
						<div className="muted small">请求次数</div>
						<div className="account-stat-value">{user.requestCount.toLocaleString("zh-CN")}</div>
					</div>
				</div>
			</SettingsGroup>
			<SettingsGroup
				title={`分组与令牌（${shown.length}）`}
				actions={
					<>
						<button
							type="button"
							className="ghost"
							disabled={!addable.length}
							title={addable.length ? undefined : "所有可用分组都已添加"}
							onClick={() => setPicking((v) => !v)}
						>
							<IconPlus size={13} />
							添加分组
						</button>
						<button type="button" className="ghost" onClick={() => store.openExternal(`${site.url}/keys`)}>
							<IconExternal size={13} />
							管理令牌
						</button>
					</>
				}
			>
				<p className="muted small settings-note">
					这里列出已添加和已配置的分组。点「添加分组」选择要使用的分组，再选择它的令牌（或新建令牌），然后选择配置到哪个
					Agent： pi（添加为服务商「{site.name} · 分组名」，可以在「模型与服务商」中查看和编辑）
					{agents ? "、Claude Code 或 Codex（写入它们的用户配置文件），同一个分组可以同时接入多个。" : "。"}
				</p>
				<div className="provider-list">
					{picking && addable.length ? (
						<div className="account-group">
							<div className="provider-row">
								<div className="provider-main">
									<div className="provider-name">添加分组</div>
									<div className="muted small">选择一个分组加入列表，然后选择令牌和要配置的 Agent。</div>
								</div>
								<div className="row-actions">
									<Select
										className="setting-select compact account-token-select"
										value={pickValue}
										onChange={setPick}
										options={addable.map((entry) => ({
											value: entry.name,
											label: [entry.name, ratioText(entry.ratio), entry.description].filter(Boolean).join(" · "),
										}))}
									/>
									<button type="button" className="primary" disabled={!pickValue} onClick={addPicked}>
										添加
									</button>
									<button type="button" className="ghost" onClick={() => setPicking(false)}>
										取消
									</button>
								</div>
							</div>
						</div>
					) : null}
					{shown.map((entry) => {
						const selectionKey = accountTokenSelectionKey(node, site, user, entry.name);
						return (
							<GroupRow
								key={selectionKey}
								entry={entry}
								selectionKey={selectionKey}
								overview={overview}
								provider={providerOf(entry)}
								agents={agents}
								fresh={fresh.includes(entry.name)}
								onTokens={onTokens}
								onRemove={() => setPicked((list) => list.filter((name) => name !== entry.name))}
							/>
						);
					})}
					{!shown.length && !picking ? (
						<div className="provider-row muted small">
							{entries.length ? "还没有添加分组，点右上角「添加分组」选择要使用的分组。" : "这个账号还没有可用的分组。"}
						</div>
					) : null}
				</div>
				<p className="muted small settings-note">
					令牌密钥由 Pier Host 直接保存在{target.local ? "本机" : ` ${target.name} 上`}，不会显示在界面上。
				</p>
			</SettingsGroup>
		</>
	);
}

// ---- line ------------------------------------------------------------------------------

/**
 * The line the host reaches 云链API through (protocol 1.29): the domestic and the international
 * address of the same site. Shown only when the host offers more than one.
 */
function LineSettings({
	lines,
	line,
	busy,
	signedIn,
	onChange,
}: {
	lines: AccountLine[];
	line: string | undefined;
	busy: boolean;
	signedIn: boolean;
	onChange: (line: AccountLine) => void;
}) {
	const target = useSettingsTarget();
	const current = lines.find((l) => l.id === line) ?? lines[0];
	if (lines.length < 2 || !current) return null;
	return (
		<SettingsGroup>
			<SettingsCard>
				<SettingRow
					title={
						<span className="account-line-title">
							线路
							{busy ? <IconLoader size={13} className="spin" /> : null}
						</span>
					}
					description={
						<>
							当前使用{current.name}（<span className="mono">{new URL(current.url).host}</span>）
							{current.description ? `，${current.description}` : ""}。
							{signedIn ? "切换后登录状态保留，" : "请选择网络更顺畅的线路再登录，"}
							已配置到本地的云链API服务商会一起改用新线路。
							{target.local ? "" : `线路保存在 ${target.name} 上的 Pier 中。`}
						</>
					}
				>
					<div className="segmented" title="线路">
						{lines.map((l) => (
							<button
								type="button"
								key={l.id}
								aria-pressed={l.id === current.id}
								className={l.id === current.id ? "active" : undefined}
								title={new URL(l.url).host}
								disabled={busy}
								onClick={() => {
									if (l.id !== current.id) onChange(l);
								}}
							>
								{l.name}
							</button>
						))}
					</div>
				</SettingRow>
			</SettingsCard>
		</SettingsGroup>
	);
}

// ---- page ------------------------------------------------------------------------------

/** The “个人中心” settings page. */
export function AccountSettings() {
	const store = useStore();
	const [status, setStatus] = useState<AccountStatus | undefined>();
	const [overview, setOverview] = useState<AccountOverview | undefined>();
	const [loading, setLoading] = useState(true);
	const [switching, setSwitching] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const load = useCallback(async () => {
		setLoading(true);
		setError(undefined);
		try {
			const next = await store.account("account.status", {});
			setStatus(next);
			if (!next.user) {
				setOverview(undefined);
				return;
			}
			try {
				setOverview(await store.account("account.overview", {}));
			} catch (e) {
				setError(errorText(e));
				// The login may have expired: show the sign-in form again.
				const again = await store.account("account.status", {}).catch(() => next);
				setStatus(again);
				if (!again.user) setOverview(undefined);
			}
		} catch (e) {
			setError(errorText(e));
		} finally {
			setLoading(false);
		}
	}, [store]);

	useEffect(() => {
		void load();
	}, [load]);

	const signedIn = (result: AccountLoginResult) => {
		if (result.status !== "ok") return;
		setError(undefined);
		setOverview(result.overview);
		setStatus((s) => ({ ...s, site: result.overview.site, user: result.overview.user }));
		store.toast("info", `已登录 ${result.overview.site.name}：${result.overview.user.username}`);
	};

	const switchLine = async (line: AccountLine) => {
		setSwitching(true);
		setError(undefined);
		try {
			const next = await store.account("account.setLine", { line: line.id });
			setStatus(next);
			if (!next.user) setOverview(undefined);
			// The 云链API providers of the computer follow the line.
			let moved = 0;
			let moveError: string | undefined;
			try {
				moved = await store.moveYunlianProviders(line.url);
			} catch (e) {
				moveError = `本地服务商没有改用新线路：${errorText(e)}`;
			}
			store.toast("info", `已切换到${line.name}${moved ? `，${moved} 个本地服务商已改用新线路` : ""}`);
			await load();
			if (moveError) setError(moveError);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setSwitching(false);
		}
	};

	const lines = status?.lines?.length ? (
		<LineSettings
			lines={status.lines}
			line={status.line}
			busy={switching}
			signedIn={Boolean(status.user)}
			onChange={(line) => void switchLine(line)}
		/>
	) : null;

	const logout = async () => {
		try {
			await store.account("account.logout", {});
			setOverview(undefined);
			setStatus((s) => (s?.site ? { site: s.site } : s));
			store.toast("info", `已退出 ${status?.site?.name ?? YUNLIAN_NAME}`);
		} catch (e) {
			setError(errorText(e));
		}
	};

	if (!status) {
		return loading ? (
			<p className="muted account-loading">
				<IconLoader size={14} className="spin" /> 正在连接{YUNLIAN_NAME}…
			</p>
		) : (
			<LoadError error={error} onRetry={() => void load()} />
		);
	}

	if (status.user && overview) {
		return (
			<>
				<ErrorBanner error={error} />
				{lines}
				<Dashboard
					overview={overview}
					loading={loading}
					onRefresh={() => void load()}
					onTokens={(tokens) => setOverview((o) => (o ? { ...o, tokens } : o))}
					onLogout={logout}
				/>
			</>
		);
	}
	if (status.user) {
		return (
			<>
				{lines}
				{loading ? (
					<p className="muted account-loading">
						<IconLoader size={14} className="spin" /> 正在读取账户信息…
					</p>
				) : (
					<LoadError error={error} onRetry={() => void load()} onLogout={() => void logout()} />
				)}
			</>
		);
	}
	if (!status.site) {
		return (
			<>
				{lines}
				<LoadError error={status.siteError ?? error} onRetry={() => void load()} />
			</>
		);
	}
	return (
		<>
			<ErrorBanner error={error} />
			{lines}
			<SignIn key={status.line} site={status.site} onDone={signedIn} />
		</>
	);
}

function LoadError({
	error,
	onRetry,
	onLogout,
}: {
	error?: string | undefined;
	onRetry: () => void;
	onLogout?: () => void;
}) {
	return (
		<SettingsCard>
			<SettingRow title={`无法连接${YUNLIAN_NAME}`} description={error ?? "请检查网络后重试。"}>
				{onLogout ? (
					<button type="button" className="ghost" onClick={onLogout}>
						退出登录
					</button>
				) : null}
				<button type="button" onClick={onRetry}>
					<IconRefresh size={13} />
					重试
				</button>
			</SettingRow>
		</SettingsCard>
	);
}
