/**
 * The admin panel's browser script. `panel` is sent to the browser as its own source text
 * (see admin-page.ts), so it must stay self-contained: no imports, no outer variables.
 */
export function panel(): void {
	type Role = "admin" | "user";
	type Status = "active" | "pending" | "disabled";
	type Mode = "private" | "open";
	type Policy = "closed" | "approval" | "open";
	type Page = "overview" | "computers" | "tokens" | "users" | "settings" | "account";
	interface Me {
		id: string;
		username: string;
		role: Role;
	}
	interface Session {
		version: string;
		mode: Mode;
		setupRequired: boolean;
		registration: Policy;
		user: Me | null;
	}
	interface Overview {
		mode: Mode;
		registration: Policy;
		startedAt: number;
		stunPort: number | null;
		mine: { hosts: number; streams: number; tokens: number };
		all?: { hosts: number; streams: number; users: number; pending: number };
		effective?: { maxHosts: number; bytesPerSecond: number };
	}
	interface Host {
		key: string;
		address: string;
		connectedAt: number;
		streams: number;
		via: "open" | "static" | "account";
		username: string | null;
		tokenName: string | null;
		mine: boolean;
	}
	interface Token {
		id: string;
		name: string;
		hint: string;
		createdAt: number;
		lastUsedAt: number | null;
		lastUsedFrom: string | null;
		online: number;
	}
	interface User {
		id: string;
		username: string;
		role: Role;
		status: Status;
		createdAt: number;
		lastLoginAt: number | null;
		tokens: number;
	}
	interface Settings {
		mode: Mode;
		maxHosts: number | null;
		maxStreamsPerHost: number;
		bytesPerSecond: number | null;
		connectsPerMinute: number;
		publicHost: string | null;
		iceServers: string[];
	}
	interface SettingsView {
		settings: Settings;
		registration: Policy;
		effective: { maxHosts: number; bytesPerSecond: number };
		defaults: Record<Mode, { maxHosts: number; bytesPerSecond: number }>;
		staticTokens: number;
		stunPort: number | null;
		trustProxy: boolean;
	}
	type Child = Node | string | number | null | undefined | false | Child[];
	type Props = Record<string, unknown>;

	const ICONS: Record<string, string> = {
		logo: '<circle cx="5" cy="12" r="2.6"/><circle cx="19" cy="12" r="2.6"/><path d="M8 12h1.5M11.25 12h1.5M14.5 12H16"/><path d="M8.5 6.8a6 6 0 0 1 7 0M8.5 17.2a6 6 0 0 0 7 0"/>',
		overview:
			'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
		computers: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
		tokens:
			'<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>',
		users:
			'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
		settings: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
		account: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
		logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
		copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
		refresh:
			'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
		globe:
			'<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
		clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
		activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
	};

	const root = document.getElementById("app") as HTMLElement;
	let session: Session | undefined;
	let pendingUsers = 0;
	let refreshTimer: number | undefined;
	let toasts: HTMLElement | undefined;

	// ---- DOM helpers -----------------------------------------------------------------------
	function h<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		props?: Props | null,
		...children: Child[]
	): HTMLElementTagNameMap[K] {
		const el = document.createElement(tag);
		for (const [name, value] of Object.entries(props ?? {})) {
			if (value === undefined || value === null || value === false) continue;
			if (name.startsWith("on") && typeof value === "function") {
				el.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
			} else if (name === "class") el.className = String(value);
			else if (name === "value") (el as HTMLInputElement).value = String(value);
			else el.setAttribute(name, value === true ? "" : String(value));
		}
		append(el, children);
		return el;
	}
	function append(el: Node, children: Child[]): void {
		for (const child of children) {
			if (child === null || child === undefined || child === false) continue;
			if (Array.isArray(child)) append(el, child);
			else el.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
		}
	}
	function icon(name: string): HTMLElement {
		const span = h("span", { class: "icon" });
		// Static markup from ICONS only.
		span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;
		return span;
	}
	function brand(sub: string): HTMLElement {
		return h(
			"div",
			{ class: "brand" },
			h("div", { class: "brand-mark" }, icon("logo")),
			h("div", null, h("div", { class: "brand-name" }, "Pier Relay"), h("div", { class: "brand-sub" }, sub)),
		);
	}
	function badge(text: string, kind = "", dot = false): HTMLElement {
		return h("span", { class: `badge ${kind}` }, dot ? h("span", { class: "dot" }) : null, text);
	}
	let fieldId = 0;
	function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
		fieldId += 1;
		control.id = `field-${fieldId}`;
		return h(
			"div",
			{ class: "field" },
			h("label", { for: control.id }, label),
			control,
			hint ? h("div", { class: "hint" }, hint) : null,
		);
	}
	function input(props: Props): HTMLInputElement {
		return h("input", { class: "input", ...props });
	}
	function card(title: string, sub: string | null, body: Child, tools?: Child): HTMLElement {
		return h(
			"section",
			{ class: "card" },
			h(
				"div",
				{ class: "card-head" },
				h("div", null, h("h2", null, title), sub ? h("p", null, sub) : null),
				tools ?? null,
			),
			body,
		);
	}
	function pageHead(title: string, sub: string, tools?: Child): HTMLElement {
		return h("div", { class: "page-head" }, h("div", null, h("h1", null, title), h("p", null, sub)), tools ?? null);
	}
	function table(headers: string[], rows: HTMLElement[], empty: string): HTMLElement {
		if (!rows.length) return h("div", { class: "empty" }, empty);
		return h(
			"div",
			{ class: "table-wrap" },
			h(
				"table",
				null,
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						headers.map((t) => h("th", null, t)),
					),
				),
				h("tbody", null, rows),
			),
		);
	}

	// ---- formatting -----------------------------------------------------------------------
	const pad = (n: number) => String(n).padStart(2, "0");
	function dateTime(ms: number | null): string {
		if (!ms) return "—";
		const d = new Date(ms);
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	function ago(ms: number | null): string {
		if (!ms) return "从未";
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return "刚刚";
		if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
		if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
		if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} 天前`;
		return dateTime(ms).slice(0, 10);
	}
	function duration(ms: number): string {
		const m = Math.floor(ms / 60_000);
		if (m < 60) return `${m} 分钟`;
		const hrs = Math.floor(m / 60);
		if (hrs < 48) return `${hrs} 小时 ${m % 60} 分`;
		return `${Math.floor(hrs / 24)} 天 ${hrs % 24} 小时`;
	}
	function rate(bytes: number): string {
		if (!bytes) return "不限";
		const mib = bytes / 1024 / 1024;
		return mib >= 1 ? `${+mib.toFixed(2)} MiB/s` : `${Math.round(bytes / 1024)} KiB/s`;
	}
	const modeName = (mode: Mode) => (mode === "private" ? "私有模式" : "开放模式");
	const policyName: Record<Policy, string> = { closed: "关闭注册", approval: "注册需审核", open: "开放注册" };
	const relayUrl = () =>
		`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${location.pathname.replace(/\/+$/, "")}`;
	const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

	// ---- API ------------------------------------------------------------------------------
	async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(`api/${path}`, {
			method,
			credentials: "same-origin",
			headers: { "x-pier-relay": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		if (res.status === 401 && session?.user) {
			toast("登录已过期，请重新登录", true);
			void boot();
		}
		if (!res.ok) throw new Error(data.error ?? `请求失败（HTTP ${res.status}）`);
		return data as T;
	}

	// ---- overlays -------------------------------------------------------------------------
	function toast(text: string, error = false): void {
		if (!toasts?.isConnected) {
			toasts = h("div", { class: "toasts" });
			document.body.appendChild(toasts);
		}
		const el = h("div", { class: `toast${error ? " error" : ""}` }, text);
		toasts.appendChild(el);
		setTimeout(() => el.remove(), 3600);
	}
	function dialog(
		title: string,
		text: string,
		options: { confirm?: string; danger?: boolean; inputs?: HTMLElement[] } = {},
	): Promise<boolean> {
		return new Promise((resolve) => {
			const close = (ok: boolean) => {
				backdrop.remove();
				document.removeEventListener("keydown", onKey);
				resolve(ok);
			};
			const onKey = (event: KeyboardEvent) => {
				if (event.key === "Escape") close(false);
				if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") close(true);
			};
			const confirm = h(
				"button",
				{ class: `btn ${options.danger ? "solid-danger" : "primary"}`, onclick: () => close(true) },
				options.confirm ?? "确定",
			);
			const backdrop = h(
				"div",
				{
					class: "backdrop",
					onmousedown: (event: MouseEvent) => {
						if (event.target === backdrop) close(false);
					},
				},
				h(
					"div",
					{ class: "dialog", role: "dialog", "aria-modal": "true" },
					h("h3", null, title),
					text ? h("p", null, text) : null,
					options.inputs ?? null,
					h("div", { class: "form-foot" }, h("button", { class: "btn", onclick: () => close(false) }, "取消"), confirm),
				),
			);
			document.addEventListener("keydown", onKey);
			document.body.appendChild(backdrop);
			(backdrop.querySelector("input") ?? confirm).focus();
		});
	}
	async function copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const area = h("textarea", { style: "position:fixed;opacity:0" });
			area.value = text;
			document.body.appendChild(area);
			area.select();
			document.execCommand("copy");
			area.remove();
		}
		toast("已复制到剪贴板");
	}
	function copyRow(value: string): HTMLElement {
		return h(
			"div",
			{ class: "copy-row" },
			input({ value, readonly: true, onfocus: (e: FocusEvent) => (e.target as HTMLInputElement).select() }),
			h("button", { class: "btn", type: "button", onclick: () => void copy(value) }, icon("copy"), "复制"),
		);
	}
	/** Run `action` with `button` disabled; show errors in `errorBox`, or as a toast. */
	async function busy(
		button: HTMLButtonElement | null,
		errorBox: HTMLElement | null,
		action: () => Promise<void>,
	): Promise<void> {
		if (button) button.disabled = true;
		errorBox?.replaceChildren();
		try {
			await action();
		} catch (error) {
			if (errorBox) errorBox.replaceChildren(h("div", { class: "alert error" }, message(error)));
			else toast(message(error), true);
		} finally {
			if (button) button.disabled = false;
		}
	}

	// ---- authentication -------------------------------------------------------------------
	function authScreen(s: Session, tab: "login" | "register" | "setup", notice?: HTMLElement): void {
		stopRefresh();
		const errorBox = h("div", null, notice ?? null);
		const username = input({ autocomplete: "username", maxlength: 32, required: true, autofocus: true });
		const password = input({
			type: "password",
			autocomplete: tab === "login" ? "current-password" : "new-password",
			maxlength: 256,
			required: true,
		});
		const confirmPassword = input({ type: "password", autocomplete: "new-password", maxlength: 256 });
		const submit = h(
			"button",
			{ class: "btn primary block", type: "submit" },
			tab === "login" ? "登录" : tab === "register" ? "注册" : "创建管理员",
		);
		const onSubmit = (event: Event) => {
			event.preventDefault();
			void busy(submit, errorBox, async () => {
				if (tab !== "login" && password.value !== confirmPassword.value) throw new Error("两次输入的密码不一致");
				const body: Record<string, string> = { username: username.value.trim(), password: password.value };
				// The first account registers like any other and becomes the administrator.
				const result = await call<{ pending?: boolean }>("POST", tab === "login" ? "login" : "register", body);
				if (result.pending) {
					authScreen(s, "login", h("div", { class: "alert ok" }, "注册成功。管理员审核通过后即可登录。"));
					return;
				}
				await boot();
			});
		};
		const tabs =
			tab === "setup"
				? null
				: h(
						"div",
						{ class: "tabs" },
						h(
							"button",
							{ class: tab === "login" ? "on" : "", type: "button", onclick: () => authScreen(s, "login") },
							"登录",
						),
						s.registration === "closed"
							? null
							: h(
									"button",
									{ class: tab === "register" ? "on" : "", type: "button", onclick: () => authScreen(s, "register") },
									"注册",
								),
					);
		const lead =
			tab === "setup"
				? "这个中继还没有账号。第一个注册的账号将成为管理员，可以审核其他账号并修改中继设置。"
				: tab === "register"
					? s.registration === "approval"
						? "注册后需要管理员审核，通过后即可登录并创建访问令牌。"
						: "注册后即可创建访问令牌，让你的电脑连接这个中继。"
					: null;
		root.replaceChildren(
			h(
				"div",
				{ class: "auth" },
				h(
					"div",
					{ class: "auth-card" },
					brand("中继管理后台"),
					tab === "setup" ? h("h1", null, "创建管理员账号") : tabs,
					lead ? h("p", { class: "lead" }, lead) : null,
					errorBox,
					h(
						"form",
						{ onsubmit: onSubmit },
						field("用户名", username, tab === "login" ? undefined : "3–32 个字符：字母、数字、下划线、点或连字符"),
						field("密码", password, tab === "login" ? undefined : "至少 8 个字符"),
						tab === "login" ? null : field("确认密码", confirmPassword),
						submit,
					),
					h("div", { class: "auth-foot" }, `Pier Relay ${s.version} · ${modeName(s.mode)}`),
				),
			),
		);
		username.focus();
	}

	// ---- shell ----------------------------------------------------------------------------
	function stopRefresh(): void {
		if (refreshTimer !== undefined) clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
	/** Re-render the current page every `ms` while it stays open. */
	function autoRefresh(ms: number, render: () => Promise<void>): void {
		stopRefresh();
		refreshTimer = window.setInterval(() => {
			if (document.visibilityState === "visible" && !document.querySelector(".backdrop")) void render().catch(() => {});
		}, ms);
	}
	function currentPage(me: Me): Page {
		const page = location.hash.replace(/^#\/?/, "") as Page;
		const pages: Page[] = ["overview", "computers", "tokens", "account"];
		if (me.role === "admin") pages.push("users", "settings");
		return pages.includes(page) ? page : "overview";
	}

	function shell(me: Me, page: Page, content: HTMLElement): void {
		const link = (id: Page, label: string, iconName: string, count?: number) =>
			h(
				"a",
				{ href: `#/${id}`, class: page === id ? "on" : "" },
				icon(iconName),
				label,
				count ? h("span", { class: "count" }, count) : null,
			);
		const logout = h(
			"button",
			{
				class: "btn ghost sm",
				title: "退出登录",
				onclick: () =>
					void busy(logout, null, async () => {
						await call("POST", "logout");
						location.hash = "";
						await boot();
					}),
			},
			icon("logout"),
		);
		root.replaceChildren(
			h(
				"div",
				{ class: "shell" },
				h(
					"aside",
					{ class: "side" },
					brand(session ? modeName(session.mode) : "中继管理后台"),
					h(
						"nav",
						{ class: "nav" },
						link("overview", "概览", "overview"),
						link("computers", "电脑", "computers"),
						link("tokens", "访问令牌", "tokens"),
						me.role === "admin"
							? [
									h("div", { class: "nav-label" }, "管理"),
									link("users", "用户", "users", pendingUsers),
									link("settings", "系统设置", "settings"),
								]
							: null,
						h("div", { class: "nav-label" }, "账号"),
						link("account", "我的账号", "account"),
					),
					h(
						"div",
						{ class: "side-foot" },
						h("div", { class: "avatar" }, me.username.slice(0, 1).toUpperCase()),
						h(
							"div",
							{ class: "who" },
							h("div", { class: "name" }, me.username),
							h("div", { class: "role" }, me.role === "admin" ? "管理员" : "用户"),
						),
						logout,
					),
				),
				h("main", { class: "main" }, content),
			),
		);
	}

	async function route(): Promise<void> {
		const me = session?.user;
		if (!me) return;
		const page = currentPage(me);
		stopRefresh();
		const content = h("div", null);
		shell(me, page, content);
		const render = async () => {
			const view = await PAGES[page](me);
			if (session?.user === me && currentPage(me) === page) {
				content.replaceChildren(view);
				const count = document.querySelector('.nav a[href="#/users"] .count');
				if (me.role === "admin" && (count?.textContent ?? "0") !== String(pendingUsers)) shell(me, page, content);
			}
		};
		try {
			await render();
		} catch (error) {
			content.replaceChildren(h("div", { class: "alert error" }, message(error)));
		}
		if (page === "overview" || page === "computers") autoRefresh(10_000, render);
	}

	// ---- pages: overview ------------------------------------------------------------------
	async function overviewPage(me: Me): Promise<HTMLElement> {
		const o = await call<Overview>("GET", "overview");
		if (session) session.mode = o.mode;
		if (o.all) pendingUsers = o.all.pending;
		const stat = (label: string, iconName: string, value: Child, sub?: string) =>
			h(
				"div",
				{ class: "stat" },
				h("div", { class: "label" }, icon(iconName), label),
				h("div", { class: "value" }, value),
				sub ? h("div", { class: "sub" }, sub) : null,
			);
		const stats = o.all
			? [
					stat("运行模式", o.mode === "private" ? "lock" : "globe", modeName(o.mode), policyName[o.registration]),
					stat(
						"在线电脑",
						"computers",
						o.all.hosts,
						`上限 ${o.effective?.maxHosts ?? "—"} 台 · 我的 ${o.mine.hosts} 台`,
					),
					stat("中继连接", "activity", o.all.streams, `带宽上限 ${rate(o.effective?.bytesPerSecond ?? 0)}`),
					stat("用户", "users", o.all.users, o.all.pending ? `${o.all.pending} 个等待审核` : "没有待审核的账号"),
					stat("运行时间", "clock", duration(Date.now() - o.startedAt), `自 ${dateTime(o.startedAt)}`),
				]
			: [
					stat("运行模式", o.mode === "private" ? "lock" : "globe", modeName(o.mode)),
					stat("我的在线电脑", "computers", o.mine.hosts),
					stat("我的中继连接", "activity", o.mine.streams),
					stat("我的访问令牌", "tokens", o.mine.tokens),
				];
		const steps = h(
			"ol",
			{ class: "steps" },
			h(
				"li",
				null,
				"在「",
				h("a", { href: "#/tokens" }, "访问令牌"),
				"」中创建一个令牌",
				o.mode === "open" ? "（开放模式下可以不填令牌；填写后电脑会关联到你的账号）。" : "。",
			),
			h(
				"li",
				null,
				"在电脑上打开 Pier：",
				h("b", null, "设置 → 设备与远程 → 中继服务器"),
				"，填写下面的中继地址和令牌，保存并开启。",
			),
			h("li", null, "状态显示「在线」后，新生成的配对二维码会带上中继地址，手机扫码即可经中继连接。"),
		);
		const insecure = location.protocol !== "https:";
		return h(
			"div",
			null,
			pageHead(`你好，${me.username}`, "中继只转发端到端加密的数据，看不到会话内容。"),
			o.all?.pending
				? h(
						"div",
						{ class: "alert warn" },
						`有 ${o.all.pending} 个账号等待审核，`,
						h("a", { href: "#/users" }, "前往处理"),
						"。",
					)
				: null,
			h("div", { class: "stats" }, stats),
			card(
				"在 Pier 中使用",
				"把电脑注册到这个中继，手机和电脑不在同一网络时也能连接。",
				h(
					"div",
					{ class: "card-body" },
					field("中继地址", copyRow(relayUrl())),
					insecure
						? h(
								"div",
								{ class: "alert warn" },
								"当前页面不是通过 HTTPS 打开的。请在中继前配置 TLS 反向代理，并在 Pier 中使用 wss:// 地址。",
							)
						: null,
					steps,
				),
			),
		);
	}

	// ---- pages: computers -----------------------------------------------------------------
	async function computersPage(me: Me): Promise<HTMLElement> {
		const { hosts } = await call<{ hosts: Host[] }>("GET", "hosts");
		const admin = me.role === "admin";
		const via = (host: Host) =>
			host.via === "account"
				? badge("账号令牌", "accent")
				: host.via === "static"
					? badge("命令行令牌")
					: badge("开放模式", "warn");
		const rows = hosts
			.sort((a, b) => b.connectedAt - a.connectedAt)
			.map((host) => {
				const reconnectHint =
					host.via === "account"
						? "私有模式下，删除它使用的访问令牌可以阻止再次接入。"
						: host.via === "static"
							? "要阻止再次接入，请在服务器启动配置中撤销它使用的命令行令牌。"
							: "开放模式允许电脑重新接入；要限制接入，可在系统设置切换为私有模式。";
				const kick = h(
					"button",
					{
						class: "btn danger sm",
						onclick: () =>
							void (async () => {
								if (
									!(await dialog(
										`踢出电脑「${host.key.slice(0, 12)}…」？`,
										`将立即断开它当前经中继的连接，Pier 可能自动重连。${reconnectHint}`,
										{ confirm: "踢出", danger: true },
									))
								)
									return;
								await busy(kick, null, async () => {
									await call("POST", `hosts/${encodeURIComponent(host.key)}/kick`);
									toast("电脑已踢出");
									await route();
								});
							})(),
					},
					"踢出",
				);
				return h(
					"tr",
					null,
					h(
						"td",
						null,
						h("div", { class: "row-title mono", title: host.key }, `${host.key.slice(0, 12)}…`),
						h("div", { class: "small faint" }, host.tokenName ? `令牌「${host.tokenName}」` : "—"),
					),
					admin
						? h(
								"td",
								null,
								host.username ?? h("span", { class: "faint" }, "—"),
								host.mine ? [" ", badge("我", "accent")] : null,
							)
						: null,
					h("td", { class: "mono" }, host.address || "—"),
					h("td", null, via(host)),
					h("td", null, host.streams ? badge(`${host.streams} 个`, "ok", true) : h("span", { class: "faint" }, "0")),
					h("td", { title: dateTime(host.connectedAt) }, ago(host.connectedAt)),
					h("td", { class: "actions" }, kick),
				);
			});
		const refresh = h("button", { class: "btn", onclick: () => void route() }, icon("refresh"), "刷新");
		return h(
			"div",
			null,
			pageHead(
				"电脑",
				admin
					? "当前注册在这个中继上的所有电脑，每 10 秒自动刷新。"
					: "用你的令牌注册到这个中继的电脑，每 10 秒自动刷新。",
				refresh,
			),
			card(
				`在线 ${hosts.length} 台`,
				"电脑以公钥区分；「连接」是经中继转发、尚未切换到 P2P 直连的设备连接。",
				h(
					"div",
					{ class: "card-body flush" },
					table(
						admin
							? ["电脑", "账号", "来源地址", "接入方式", "连接", "上线", "操作"]
							: ["电脑", "来源地址", "接入方式", "连接", "上线", "操作"],
						rows,
						admin ? "还没有电脑注册到这个中继。" : "还没有电脑使用你的令牌注册。",
					),
				),
			),
		);
	}

	// ---- pages: tokens --------------------------------------------------------------------
	async function tokensPage(_me: Me): Promise<HTMLElement> {
		const { tokens } = await call<{ tokens: Token[] }>("GET", "tokens");
		const name = input({ placeholder: "令牌名称，例如「办公室电脑」", maxlength: 40 });
		const errorBox = h("div", null);
		const reveal = h("div", null);
		const create = h("button", { class: "btn primary", type: "submit" }, icon("plus"), "创建令牌");
		const list = h("div", null);
		const listCard = card("", null, h("div", { class: "card-body flush" }, list));
		const renderList = (items: Token[]) => {
			const title = listCard.querySelector("h2");
			if (title) title.textContent = `我的令牌（${items.length}）`;
			list.replaceChildren(
				table(
					["名称", "令牌", "在线电脑", "创建时间", "最近使用", ""],
					items.map((token) => {
						const remove = h(
							"button",
							{
								class: "btn danger sm",
								onclick: () =>
									void (async () => {
										const ok = await dialog(
											`删除令牌「${token.name}」？`,
											token.online
												? `正在使用它的 ${token.online} 台电脑会立即断开，之后无法再注册到这个中继。`
												: "使用它的电脑将无法再注册到这个中继。",
											{ confirm: "删除", danger: true },
										);
										if (!ok) return;
										await busy(remove, null, async () => {
											await call("DELETE", `tokens/${encodeURIComponent(token.id)}`);
											toast("令牌已删除");
											await route();
										});
									})(),
							},
							"删除",
						);
						return h(
							"tr",
							null,
							h("td", { class: "row-title" }, token.name),
							h("td", { class: "mono faint" }, `${token.hint}…`),
							h(
								"td",
								null,
								token.online ? badge(`${token.online} 台`, "ok", true) : h("span", { class: "faint" }, "0"),
							),
							h("td", { title: dateTime(token.createdAt) }, ago(token.createdAt)),
							h(
								"td",
								{ title: dateTime(token.lastUsedAt) },
								ago(token.lastUsedAt),
								token.lastUsedFrom ? h("div", { class: "small faint mono" }, token.lastUsedFrom) : null,
							),
							h("td", { class: "actions" }, remove),
						);
					}),
					"还没有令牌。创建一个，填到电脑上 Pier 的中继设置中。",
				),
			);
		};
		renderList(tokens);
		const onSubmit = (event: Event) => {
			event.preventDefault();
			void busy(create, errorBox, async () => {
				const result = await call<{ token: string; item: Token }>("POST", "tokens", { name: name.value });
				name.value = "";
				reveal.replaceChildren(
					h(
						"div",
						{ class: "reveal" },
						h(
							"p",
							null,
							h("b", null, `令牌「${result.item.name}」已创建。`),
							"它只显示这一次，请现在复制并填到 Pier 中。",
						),
						copyRow(result.token),
					),
				);
				const fresh = await call<{ tokens: Token[] }>("GET", "tokens");
				renderList(fresh.tokens);
			});
		};
		return h(
			"div",
			null,
			pageHead("访问令牌", "电脑用访问令牌注册到这个中继。每台电脑可以用单独的令牌，便于单独撤销。"),
			card(
				"创建令牌",
				"令牌只在创建时显示一次；丢失后删除它再创建一个即可。",
				h(
					"div",
					{ class: "card-body" },
					errorBox,
					h("form", { class: "inline-form", onsubmit: onSubmit }, name, create),
					reveal,
				),
			),
			listCard,
		);
	}

	// ---- pages: users ---------------------------------------------------------------------
	async function usersPage(_me: Me): Promise<HTMLElement> {
		const { users, me: myId } = await call<{ users: User[]; me: string }>("GET", "users");
		pendingUsers = users.filter((u) => u.status === "pending").length;
		const statusBadge = (status: Status) =>
			status === "active"
				? badge("正常", "ok", true)
				: status === "pending"
					? badge("待审核", "warn", true)
					: badge("已停用", "danger", true);
		const update = async (button: HTMLButtonElement, user: User, change: Partial<User>, done: string) =>
			busy(button, null, async () => {
				await call("PATCH", `users/${encodeURIComponent(user.id)}`, change);
				toast(done);
				await route();
			});
		const action = (label: string, run: (button: HTMLButtonElement) => void, kind = "") => {
			const button: HTMLButtonElement = h("button", { class: `btn sm ${kind}`, onclick: () => run(button) }, label);
			return button;
		};
		const rows = users
			.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || a.createdAt - b.createdAt)
			.map((user) => {
				const self = user.id === myId;
				const actions: HTMLElement[] = [];
				if (!self) {
					if (user.status === "pending") {
						actions.push(
							action("通过", (b) => void update(b, user, { status: "active" }, `已通过 ${user.username}`), "primary"),
						);
					} else if (user.status === "active") {
						actions.push(
							action(
								"停用",
								(b) =>
									void (async () => {
										if (
											await dialog(
												`停用 ${user.username}？`,
												"停用后无法登录，用其令牌注册的电脑会立即断开（私有模式）。",
												{
													confirm: "停用",
													danger: true,
												},
											)
										)
											await update(b, user, { status: "disabled" }, `已停用 ${user.username}`);
									})(),
							),
						);
					} else {
						actions.push(action("启用", (b) => void update(b, user, { status: "active" }, `已启用 ${user.username}`)));
					}
					actions.push(
						user.role === "admin"
							? action("取消管理员", (b) => void update(b, user, { role: "user" }, `${user.username} 不再是管理员`))
							: action(
									"设为管理员",
									(b) =>
										void (async () => {
											if (await dialog(`把 ${user.username} 设为管理员？`, "管理员可以管理所有用户并修改中继设置。"))
												await update(b, user, { role: "admin" }, `${user.username} 已是管理员`);
										})(),
								),
					);
				}
				actions.push(
					action(
						"重置密码",
						(b) =>
							void (async () => {
								const password = input({ type: "password", autocomplete: "new-password", maxlength: 256 });
								if (
									!(await dialog(`重置 ${user.username} 的密码`, "该账号的其他登录会被退出。", {
										inputs: [field("新密码", password, "至少 8 个字符")],
									}))
								)
									return;
								await busy(b, null, async () => {
									await call("POST", `users/${encodeURIComponent(user.id)}/password`, { password: password.value });
									toast("密码已重置");
								});
							})(),
					),
				);
				if (!self) {
					actions.push(
						action(
							"删除",
							(b) =>
								void (async () => {
									if (
										!(await dialog(
											`删除 ${user.username}？`,
											"账号和它的所有令牌都会被删除，用这些令牌注册的电脑会立即断开（私有模式）。此操作无法撤销。",
											{
												confirm: "删除",
												danger: true,
											},
										))
									)
										return;
									await busy(b, null, async () => {
										await call("DELETE", `users/${encodeURIComponent(user.id)}`);
										toast(`已删除 ${user.username}`);
										await route();
									});
								})(),
							"danger",
						),
					);
				}
				return h(
					"tr",
					null,
					h(
						"td",
						null,
						h("span", { class: "row-title" }, user.username),
						self ? h("span", { class: "faint" }, "（你）") : null,
					),
					h("td", null, user.role === "admin" ? badge("管理员", "accent") : badge("用户")),
					h("td", null, statusBadge(user.status)),
					h("td", null, user.tokens),
					h("td", { title: dateTime(user.createdAt) }, dateTime(user.createdAt).slice(0, 10)),
					h("td", { title: dateTime(user.lastLoginAt) }, ago(user.lastLoginAt)),
					h("td", { class: "actions" }, actions),
				);
			});
		return h(
			"div",
			null,
			pageHead(
				"用户",
				`共 ${users.length} 个账号${pendingUsers ? `，${pendingUsers} 个等待审核` : ""}。注册方式可以在「系统设置」中修改。`,
			),
			card(
				"账号",
				null,
				h(
					"div",
					{ class: "card-body flush" },
					table(["用户名", "角色", "状态", "令牌", "注册", "最近登录", ""], rows, "没有账号。"),
				),
			),
		);
	}

	// ---- pages: settings ------------------------------------------------------------------
	async function settingsPage(_me: Me): Promise<HTMLElement> {
		const view = await call<SettingsView>("GET", "settings");
		const s = view.settings;
		const save = async (change: Record<string, unknown>, done: string) => {
			await call<SettingsView>("PUT", "settings", change);
			toast(done);
			if (session && typeof change.mode === "string") session.mode = change.mode as Mode;
			await route();
		};

		const modeCard = (mode: Mode, iconName: string, title: string, desc: string) => {
			const on = s.mode === mode;
			const button: HTMLButtonElement = h(
				"button",
				{
					class: `mode${on ? " on" : ""}`,
					type: "button",
					onclick: () =>
						void (async () => {
							if (on) return;
							const ok = await dialog(
								`切换到${modeName(mode)}？`,
								mode === "private"
									? "立即生效。没有有效令牌的电脑会马上断开，之后需要令牌才能注册。"
									: "立即生效。任何电脑都可以注册到这个中继，受下面的连接数与带宽限制约束。",
								{ confirm: "切换" },
							);
							if (ok) await busy(button, null, () => save({ mode }, `已切换到${modeName(mode)}`));
						})(),
				},
				h("div", { class: "mode-icon" }, icon(iconName)),
				h(
					"div",
					null,
					h("div", { class: "title" }, title, on ? badge("当前", "accent") : null),
					h("div", { class: "desc" }, desc),
				),
			);
			return button;
		};

		const policies: Policy[] = ["approval", "open", "closed"];
		const policyHint: Record<Policy, string> = {
			approval: "任何人都可以注册，管理员在「用户」中通过后才能登录。",
			open: "任何人都可以注册并立即创建令牌。私有模式下这等于向所有人开放中继。",
			closed: "不再接受注册，只有已有的账号可以登录。",
		};
		const segmented = h(
			"div",
			{ class: "segmented" },
			policies.map((policy) => {
				const button: HTMLButtonElement = h(
					"button",
					{
						type: "button",
						class: view.registration === policy ? "on" : "",
						onclick: () => {
							if (view.registration !== policy)
								void busy(button, null, () => save({ registration: policy }, `已改为「${policyName[policy]}」`));
						},
					},
					policyName[policy],
				);
				return button;
			}),
		);

		const d = view.defaults[s.mode];
		const maxHosts = input({ type: "number", min: 1, value: s.maxHosts ?? "", placeholder: `默认 ${d.maxHosts}` });
		const maxStreams = input({ type: "number", min: 1, max: 1024, value: s.maxStreamsPerHost });
		const bandwidth = input({
			type: "number",
			min: 0,
			step: "0.1",
			value: s.bytesPerSecond === null ? "" : +(s.bytesPerSecond / 1024 / 1024).toFixed(3),
			placeholder: `默认 ${d.bytesPerSecond ? `${d.bytesPerSecond / 1024 / 1024}` : "不限"}`,
		});
		const connects = input({ type: "number", min: 0, value: s.connectsPerMinute });
		const publicHost = input({
			value: s.publicHost ?? "",
			placeholder: "默认取电脑连接中继时的域名",
			spellcheck: "false",
		});
		const ice = h("textarea", { class: "input", placeholder: "stun:stun.miwifi.com:3478", spellcheck: "false" });
		ice.value = s.iceServers.join("\n");
		const errorBox = h("div", null);
		const saveButton = h("button", { class: "btn primary", type: "submit" }, "保存设置");
		const onSubmit = (event: Event) => {
			event.preventDefault();
			void busy(saveButton, errorBox, async () => {
				const mib = bandwidth.value.trim();
				await save(
					{
						maxHosts: maxHosts.value.trim() === "" ? null : Number(maxHosts.value),
						maxStreamsPerHost: Number(maxStreams.value),
						bytesPerSecond: mib === "" ? null : Math.round(Number(mib) * 1024 * 1024),
						connectsPerMinute: Number(connects.value),
						publicHost: publicHost.value.trim() || null,
						iceServers: ice.value
							.split(/[\n,]/)
							.map((u) => u.trim())
							.filter(Boolean),
					},
					"设置已保存，立即生效",
				);
			});
		};

		return h(
			"div",
			null,
			pageHead("系统设置", "这里的修改立即生效，并保存在数据目录中；保存后优先于命令行和环境变量中的设置。"),
			card(
				"运行模式",
				"在线切换，不需要重启中继。",
				h(
					"div",
					{ class: "card-body" },
					h(
						"div",
						{ class: "modes" },
						modeCard(
							"private",
							"lock",
							"私有模式",
							"只有持有访问令牌（账号令牌或命令行令牌）的电脑才能注册。适合自己或团队使用。",
						),
						modeCard("open", "globe", "开放模式", "任何电脑都可以注册，受连接数与带宽限制约束。适合提供公共中继。"),
					),
					s.mode === "private" && view.staticTokens === 0
						? h(
								"p",
								{ class: "small faint", style: "margin:12px 0 0" },
								"没有配置命令行令牌：电脑需要使用账号创建的令牌。",
							)
						: null,
				),
			),
			card("账号注册", policyHint[view.registration], h("div", { class: "card-body" }, segmented)),
			card(
				"限制与 P2P",
				`当前生效：最多 ${view.effective.maxHosts} 台电脑，每个连接 ${rate(view.effective.bytesPerSecond)}。留空表示使用当前模式的默认值。`,
				h(
					"form",
					{ class: "card-body", onsubmit: onSubmit },
					errorBox,
					h(
						"div",
						{ class: "grid2" },
						field("最多注册的电脑数", maxHosts, "私有模式默认 10000，开放模式默认 1000"),
						field("每台电脑同时经中继的连接数", maxStreams, "默认 32"),
						field("每个连接的带宽上限（MiB/s）", bandwidth, "每个方向分别计算；0 表示不限。开放模式默认 2 MiB/s"),
						field("每个 IP 每分钟最多连接次数", connects, "0 表示不限，默认 120"),
						field(
							"STUN 公网地址",
							publicHost,
							"告诉电脑与手机的 STUN 主机名；中继在 CDN 或隧道后时填写服务器的真实地址",
						),
						field("额外的 STUN 服务器", ice, "每行一个，例如 stun:stun.miwifi.com:3478，最多 8 个"),
					),
					h("div", { class: "form-foot" }, saveButton),
				),
			),
			card(
				"运行信息",
				"以下内容来自启动参数，修改需要重启中继。",
				h(
					"div",
					{ class: "card-body" },
					h(
						"dl",
						{ class: "kv" },
						h("dt", null, "版本"),
						h("dd", null, session?.version ?? "—"),
						h("dt", null, "命令行令牌"),
						h("dd", null, view.staticTokens ? `${view.staticTokens} 个（不显示）` : "无"),
						h("dt", null, "STUN 端口"),
						h("dd", null, view.stunPort ? `UDP ${view.stunPort}` : "已关闭"),
						h("dt", null, "信任反向代理"),
						h("dd", null, view.trustProxy ? "是（从 X-Forwarded-For 读取客户端地址）" : "否"),
					),
				),
			),
		);
	}

	// ---- pages: account -------------------------------------------------------------------
	async function accountPage(me: Me): Promise<HTMLElement> {
		const current = input({ type: "password", autocomplete: "current-password", maxlength: 256 });
		const next = input({ type: "password", autocomplete: "new-password", maxlength: 256 });
		const again = input({ type: "password", autocomplete: "new-password", maxlength: 256 });
		const errorBox = h("div", null);
		const submit = h("button", { class: "btn primary", type: "submit" }, "修改密码");
		const onSubmit = (event: Event) => {
			event.preventDefault();
			void busy(submit, errorBox, async () => {
				if (next.value !== again.value) throw new Error("两次输入的新密码不一致");
				await call("POST", "account/password", { current: current.value, password: next.value });
				current.value = next.value = again.value = "";
				errorBox.replaceChildren(h("div", { class: "alert ok" }, "密码已修改，其他设备上的登录已退出。"));
			});
		};
		return h(
			"div",
			null,
			pageHead("我的账号", "账号信息与登录密码。"),
			card(
				"账号信息",
				null,
				h(
					"div",
					{ class: "card-body" },
					h(
						"dl",
						{ class: "kv" },
						h("dt", null, "用户名"),
						h("dd", null, me.username),
						h("dt", null, "角色"),
						h("dd", null, me.role === "admin" ? "管理员" : "用户"),
					),
				),
			),
			card(
				"修改密码",
				"修改后，其他浏览器中的登录会被退出。",
				h(
					"form",
					{ class: "card-body", onsubmit: onSubmit, style: "max-width:420px" },
					errorBox,
					field("当前密码", current),
					field("新密码", next, "至少 8 个字符"),
					field("确认新密码", again),
					h("div", { class: "form-foot", style: "justify-content:flex-start" }, submit),
				),
			),
		);
	}

	const PAGES: Record<Page, (me: Me) => Promise<HTMLElement>> = {
		overview: overviewPage,
		computers: computersPage,
		tokens: tokensPage,
		users: usersPage,
		settings: settingsPage,
		account: accountPage,
	};

	// ---- start ----------------------------------------------------------------------------
	async function boot(): Promise<void> {
		try {
			session = await call<Session>("GET", "session");
		} catch (error) {
			root.replaceChildren(h("div", { class: "boot" }, `无法连接中继：${message(error)}`));
			return;
		}
		if (session.setupRequired) authScreen(session, "setup");
		else if (!session.user) authScreen(session, "login");
		else await route();
	}

	window.addEventListener("hashchange", () => void route());
	void boot();
}
