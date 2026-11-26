/** A dedicated Chromium process. CDP uses private stdio pipes, never an open debugging port. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
	BROWSER_PICK_TIMEOUT_MS,
	type BrowserCommand,
	type BrowserControl,
	type BrowserControlResult,
	type BrowserElement,
	type BrowserImage,
	type BrowserPageState,
	type BrowserResult,
} from "@pier/protocol";
import { DESCRIBE, type DescribedElement, HIGHLIGHT, imageSize, visibleClip } from "./inspect.ts";
import { webUrl } from "./network.ts";

export function findChromium(): string {
	const explicit = process.env.PIER_BROWSER_BIN;
	if (explicit) return explicit;
	const candidates =
		process.platform === "darwin"
			? [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				]
			: process.platform === "win32"
				? [
						...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
							.filter((p): p is string => !!p)
							.flatMap((p) => [
								join(p, "Google", "Chrome", "Application", "chrome.exe"),
								join(p, "Microsoft", "Edge", "Application", "msedge.exe"),
							]),
					]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium",
						"/usr/bin/chromium-browser",
						"/usr/bin/microsoft-edge",
						"/opt/google/chrome/chrome",
						join(homedir(), ".local", "bin", "chromium"),
					];
	const found = candidates.find((path) => existsSync(path));
	if (!found)
		throw new Error("这台主机未找到 Chrome、Chromium 或 Edge。请安装其中一个，或用 PIER_BROWSER_BIN 指定可执行文件。");
	return found;
}

/**
 * Switches and environment that keep the process Pier starts the browser itself. On Windows,
 * Chrome and Edge relaunch themselves when started elevated (de-elevation), and Edge does when it
 * inherits an AppCompat layer (`__COMPAT_LAYER`, e.g. `Installer` when Pier was restarted by its
 * installer). The relaunched browser does not get the CDP pipe: the one Pier started exits at once,
 * before its profile is even created, and every launch fails with "本地浏览器已关闭".
 */
export function launchSettings(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): { args: string[]; env: NodeJS.ProcessEnv } {
	if (platform !== "win32") return { args: [], env };
	return {
		// Chromium ignores switches it does not know: Chrome is fine with Edge's.
		args: ["--do-not-de-elevate", "--edge-skip-compat-layer-relaunch"],
		// Windows environment names are case-insensitive.
		env: Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "__COMPAT_LAYER")),
	};
}

/**
 * Chromium's fatal startup errors when it cannot sandbox its processes: the host stops unconfined
 * programs from creating user namespaces (Ubuntu 23.10+ AppArmor) and there is no usable setuid
 * `chrome-sandbox` beside the browser.
 */
const NO_SANDBOX = ["No usable sandbox!", "The SUID sandbox helper binary was found, but is not configured correctly"];
export const SANDBOX_UNAVAILABLE =
	"浏览器启动后立即退出：它无法启用沙箱，因为这台电脑不允许普通程序创建用户命名空间（Ubuntu 23.10 起 AppArmor 的默认设置）。请为运行 Pier Host 的用户配置免密 sudo 后重试，Pier 会为它下载的浏览器装好沙箱辅助程序；也可以安装 Google Chrome。";

interface Pending {
	resolve(result: Record<string, unknown>): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}
interface Target {
	targetId: string;
	type: string;
	title: string;
	url: string;
}
interface HistoryEntry {
	id: number;
	url: string;
}
/** The empty page a browser starts on (before the first address) is not somewhere to go back to. */
function firstEntry(entries: HistoryEntry[]): number {
	return entries[0]?.url === "about:blank" && entries.length > 1 ? 1 : 0;
}
/** A viewport capture larger than this (base64) is sent as a JPEG. */
const PNG_LIMIT = 8_000_000;
/** How long a tab may take to say whether it is on screen before it is skipped. */
const PROBE_MS = 1500;

export class ChromiumBrowser {
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private readonly pending = new Map<number, Pending>();
	/** CDP sessions attached to tabs, by target ID. */
	private readonly sessions = new Map<string, Promise<string>>();
	private readonly input: Writable;
	private ended = false;
	private chain: Promise<unknown> = Promise.resolve();
	private readonly exited: Promise<void>;
	/** Chromium said it cannot sandbox itself (the only thing read from its diagnostics). */
	private unsandboxed = false;
	private readonly diagnosticsEnded: Promise<void>;
	private queued = 0;
	/** The tab last seen on screen (or activated through `control`). */
	private activeTab?: string;
	/** The element pick waiting for the user's click, if any. */
	private picking?: { session: string; finish(nodeId?: number): void };

	constructor(
		private readonly child: ChildProcess,
		private readonly onExit: () => void,
	) {
		this.exited = new Promise((resolve) => {
			child.once("exit", () => resolve());
			child.once("error", () => resolve());
		});
		this.input = child.stdio[3] as Writable;
		const output = child.stdio[4] as Readable;
		output.on("data", (chunk: Buffer) => this.receive(chunk));
		output.on("error", () => {
			void this.close();
		});
		this.input.on("error", () => {
			void this.close();
		});
		// Drain diagnostic output without logging it: a URL or a browser error can contain secrets.
		// Only look for the sandbox failure, which the user can fix and would otherwise not see.
		const diagnostics = child.stderr as Readable | null;
		let tail = "";
		diagnostics?.on("data", (chunk: Buffer) => {
			if (this.unsandboxed) return;
			tail = tail.slice(-128) + chunk.toString("latin1");
			this.unsandboxed = NO_SANDBOX.some((marker) => tail.includes(marker));
		});
		this.diagnosticsEnded = new Promise((resolve) => {
			if (!diagnostics) resolve();
			diagnostics?.once("end", resolve);
			diagnostics?.once("close", resolve);
			diagnostics?.once("error", resolve);
		});
		child.once("error", () => this.finish());
		child.once("exit", () => this.finish());
	}
	static async start(
		profile: string,
		url: string,
		proxyPort: number | undefined,
		onExit: () => void,
		launchOptions?: { executable?: string; args?: string[]; env?: NodeJS.ProcessEnv; downloadDir?: string },
	): Promise<ChromiumBrowser> {
		mkdirSync(profile, { recursive: true, mode: 0o700 });
		const launch = launchSettings(process.platform, launchOptions?.env ?? process.env);
		const args = [
			"--remote-debugging-pipe",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			...launch.args,
		];
		if (proxyPort)
			args.push(
				"--disable-quic",
				"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
				`--proxy-server=http://127.0.0.1:${proxyPort}`,
				"--proxy-bypass-list=<-loopback>",
				"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
			);
		args.push(...(launchOptions?.args ?? []), "about:blank");
		const child = spawn(launchOptions?.executable ?? findChromium(), args, {
			stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
			windowsHide: false,
			env: launch.env,
		});
		const browser = new ChromiumBrowser(child, onExit);
		try {
			await browser.send("Browser.getVersion");
			if (launchOptions?.downloadDir)
				await browser.send("Browser.setDownloadBehavior", {
					behavior: "allow",
					downloadPath: launchOptions.downloadDir,
				});
			const tabs = await browser.targets();
			const tab = tabs[0];
			// Do not wait for the first page: a slow site, or a dev server compiling its first request,
			// must not fail the whole launch. It goes on loading, and the panel shows it loading.
			if (tab) void browser.send("Page.navigate", { url }, await browser.session(tab.targetId)).catch(() => {});
			else await browser.send("Target.createTarget", { url });
			return browser;
		} catch (error) {
			await browser.close();
			// The exit can be seen before the last diagnostics are read.
			if (!browser.unsandboxed) await Promise.race([browser.diagnosticsEnded, delay(1000)]);
			if (browser.unsandboxed) throw new Error(SANDBOX_UNAVAILABLE);
			throw error;
		}
	}
	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > 20 * 1024 * 1024) {
			this.close();
			return;
		}
		for (;;) {
			const end = this.buffer.indexOf(0);
			if (end < 0) return;
			const message = this.buffer.subarray(0, end).toString("utf8");
			this.buffer = this.buffer.subarray(end + 1);
			try {
				const frame = JSON.parse(message) as {
					id?: number;
					method?: string;
					params?: Record<string, unknown>;
					sessionId?: string;
					result?: Record<string, unknown>;
					error?: { message?: string };
				};
				if (frame.id === undefined) {
					if (frame.method) this.event(frame.method, frame.params ?? {}, frame.sessionId);
					continue;
				}
				const pending = this.pending.get(frame.id);
				if (!pending) continue;
				this.pending.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.error) pending.reject(new Error(frame.error.message ?? "Browser command failed"));
				else pending.resolve(frame.result ?? {});
			} catch {
				/* Ignore non-protocol diagnostics. */
			}
		}
	}
	/** Protocol events: tabs going away and the element picker. */
	private event(method: string, params: Record<string, unknown>, sessionId?: string): void {
		if (method === "Target.detachedFromTarget") {
			const target = typeof params.targetId === "string" ? params.targetId : undefined;
			if (target) this.sessions.delete(target);
			if (this.picking && this.picking.session === params.sessionId) this.picking.finish();
			return;
		}
		const picking = this.picking;
		if (!picking || picking.session !== sessionId) return;
		if (method === "Overlay.inspectNodeRequested" && typeof params.backendNodeId === "number")
			picking.finish(params.backendNodeId);
		else if (method === "Overlay.inspectModeCanceled") picking.finish();
		// A new document drops the inspector's mode: arm it again so the pick survives navigation.
		else if (method === "DOM.documentUpdated")
			void this.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: HIGHLIGHT }, sessionId).catch(
				() => {},
			);
	}
	private send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		timeoutMs = 20_000,
	): Promise<Record<string, unknown>> {
		if (this.ended) return Promise.reject(new Error("本地浏览器已关闭"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Browser command timed out"));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, (error) => {
				if (error) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}
	private async targets(): Promise<Target[]> {
		const result = await this.send("Target.getTargets");
		return (result.targetInfos as Target[]).filter((t) => t.type === "page" && !t.url.startsWith("chrome-extension:"));
	}
	private session(tabId: string): Promise<string> {
		const existing = this.sessions.get(tabId);
		if (existing) return existing;
		// One attachment per tab, even when commands for it arrive together.
		const session = this.send("Target.attachToTarget", { targetId: tabId, flatten: true }).then((result) =>
			String(result.sessionId),
		);
		this.sessions.set(tabId, session);
		session.catch(() => {
			if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
		});
		return session;
	}
	private async evaluate(expression: string, session: string): Promise<unknown> {
		const response = await this.send(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: true, userGesture: true },
			session,
		);
		if (response.exceptionDetails) throw new Error("网页脚本执行失败，请检查页面和选择器");
		return (response.result as { value?: unknown })?.value;
	}
	action(command: BrowserCommand): Promise<BrowserResult> {
		if (this.queued >= 32) return Promise.reject(new Error("Too many browser commands"));
		this.queued++;
		const run = this.chain.then(() => this.perform(command));
		this.chain = run.catch(() => {});
		return run.finally(() => {
			this.queued--;
		});
	}
	private async perform(command: BrowserCommand): Promise<BrowserResult> {
		const tabs = await this.targets();
		if (command.action === "tabs")
			return { text: JSON.stringify(tabs.map((t) => ({ tabId: t.targetId, title: t.title, url: t.url }))) };
		const tab = command.tabId ? tabs.find((t) => t.targetId === command.tabId) : tabs[0];
		if (!tab) throw new Error("浏览器标签页不存在");
		const session = await this.session(tab.targetId);
		switch (command.action) {
			case "navigate": {
				const url = webUrl(command.url ?? "").href;
				const result = await this.send("Page.navigate", { url }, session);
				if (result.errorText) throw new Error("网页导航失败");
				return { text: `已导航到 ${url}` };
			}
			case "snapshot": {
				const value = await this.evaluate(
					`JSON.stringify({title:document.title,url:location.href,text:(document.body?.innerText||'').slice(0,80000),elements:Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).slice(0,300).map(e=>({tag:e.tagName,id:e.id,name:e.getAttribute('name'),type:e.getAttribute('type'),text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,200)}))})`,
					session,
				);
				return { text: String(value).slice(0, 180_000) };
			}
			case "click": {
				if (!command.selector) throw new Error("需要 CSS 选择器");
				const point = (await this.evaluate(
					`(()=>{const e=document.querySelector(${JSON.stringify(command.selector)});if(!e)throw Error('Element not found');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Element not visible');return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
					session,
				)) as { x: number; y: number };
				// Move there first, as a pointer does: hover styles, and the element picker's highlight.
				await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, session);
				await this.send(
					"Input.dispatchMouseEvent",
					{ type: "mousePressed", button: "left", clickCount: 1, ...point },
					session,
				);
				await this.send(
					"Input.dispatchMouseEvent",
					{ type: "mouseReleased", button: "left", clickCount: 1, ...point },
					session,
				);
				return { text: "已点击" };
			}
			case "fill": {
				if (!command.selector || command.text === undefined) throw new Error("需要 CSS 选择器和输入内容");
				const selected = await this.evaluate(
					`(()=>{const e=document.querySelector(${JSON.stringify(command.selector)});if(!e||(!(e instanceof HTMLInputElement)&&!(e instanceof HTMLTextAreaElement)&&!(e instanceof HTMLSelectElement)&&!e.isContentEditable))throw Error('Editable element not found');e.focus();if(e instanceof HTMLSelectElement){const value=${JSON.stringify(command.text)};if(!Array.from(e.options).some(o=>o.value===value))throw Error('Option not found');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;}if(e.isContentEditable)e.textContent='';else {const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,'');}e.dispatchEvent(new Event('input',{bubbles:true}));return false;})()`,
					session,
				);
				if (!selected) await this.send("Input.insertText", { text: command.text }, session);
				return { text: "已输入" };
			}
			case "press": {
				if (!command.key) throw new Error("需要按键");
				const codes: Record<string, number> = {
					Enter: 13,
					Tab: 9,
					Escape: 27,
					Backspace: 8,
					ArrowLeft: 37,
					ArrowUp: 38,
					ArrowRight: 39,
					ArrowDown: 40,
				};
				const key = {
					key: command.key,
					windowsVirtualKeyCode: codes[command.key],
					nativeVirtualKeyCode: codes[command.key],
				};
				await this.send(
					"Input.dispatchKeyEvent",
					{ type: "keyDown", ...key, ...(command.key === "Enter" ? { text: "\r" } : {}) },
					session,
				);
				await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, session);
				return { text: "已按键" };
			}
			case "evaluate":
				if (!command.expression) throw new Error("需要 JavaScript 表达式");
				return {
					text: JSON.stringify(await this.evaluate(command.expression, session))?.slice(0, 180_000) ?? "undefined",
				};
			case "screenshot": {
				const result = await this.send("Page.captureScreenshot", { format: "png" }, session);
				const data = String(result.data);
				if (data.length > 12_000_000) throw new Error("截图过大");
				return { image: { data, mimeType: "image/png" } };
			}
		}
	}
	/**
	 * The tab on screen. A tab hidden behind another reports `document.visibilityState` "hidden";
	 * the last one seen (or activated) wins among several visible ones (separate windows), and
	 * stays when none answers (a minimized window, a page blocked by a dialog). `probe: false`
	 * trusts the last one seen while it is still open.
	 */
	private async active(tabs: Target[], probe = true): Promise<{ tab?: Target; loading: boolean }> {
		const remembered = tabs.find((t) => t.targetId === this.activeTab);
		if (!probe && remembered) return { tab: remembered, loading: false };
		const probes = await Promise.all(
			tabs.slice(0, 16).map(async (tab) => {
				try {
					const session = await this.session(tab.targetId);
					const response = await this.send(
						"Runtime.evaluate",
						{ expression: "[document.visibilityState, document.readyState]", returnByValue: true },
						session,
						PROBE_MS,
					);
					const value = (response.result as { value?: unknown } | undefined)?.value;
					return Array.isArray(value)
						? { tab, visible: value[0] === "visible", ready: value[1] === "complete" }
						: undefined;
				} catch {
					return undefined;
				}
			}),
		);
		const answered = probes.filter((p) => p !== undefined);
		const visible = answered.filter((p) => p.visible);
		const chosen =
			visible.find((p) => p.tab.targetId === this.activeTab) ??
			visible[visible.length - 1] ??
			answered.find((p) => p.tab.targetId === this.activeTab);
		const tab = chosen?.tab ?? remembered ?? tabs[tabs.length - 1];
		if (tab) this.activeTab = tab.targetId;
		return { tab, loading: chosen ? !chosen.ready : false };
	}
	private async tab(tabId?: string): Promise<Target> {
		const tabs = await this.targets();
		const tab = tabId ? tabs.find((t) => t.targetId === tabId) : (await this.active(tabs, false)).tab;
		if (!tab) throw new Error("浏览器标签页不存在");
		return tab;
	}
	private async pageState(): Promise<BrowserPageState> {
		const tabs = await this.targets();
		const { tab, loading } = await this.active(tabs);
		let canGoBack = false;
		let canGoForward = false;
		if (tab) {
			try {
				const history = await this.send("Page.getNavigationHistory", {}, await this.session(tab.targetId), PROBE_MS);
				const index = Number(history.currentIndex);
				const entries = Array.isArray(history.entries) ? (history.entries as HistoryEntry[]) : [];
				canGoBack = index > firstEntry(entries);
				canGoForward = index >= 0 && index < entries.length - 1;
			} catch {
				/* A busy page keeps its buttons off until the next look. */
			}
		}
		return {
			tabs: tabs.map((t) => ({ id: t.targetId, title: t.title, url: t.url })),
			...(tab ? { activeTabId: tab.targetId } : {}),
			canGoBack,
			canGoForward,
			loading,
		};
	}
	private async history(session: string, step: -1 | 1): Promise<void> {
		const history = await this.send("Page.getNavigationHistory", {}, session);
		const entries = Array.isArray(history.entries) ? (history.entries as HistoryEntry[]) : [];
		const index = Number(history.currentIndex) + step;
		const entry = index >= firstEntry(entries) ? entries[index] : undefined;
		if (entry) await this.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session);
	}
	private async capture(session: string, clip?: ReturnType<typeof visibleClip>): Promise<BrowserImage> {
		let result = await this.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) }, session);
		let mimeType: BrowserImage["mimeType"] = "image/png";
		if (String(result.data).length > PNG_LIMIT) {
			result = await this.send(
				"Page.captureScreenshot",
				{ format: "jpeg", quality: 85, ...(clip ? { clip } : {}) },
				session,
			);
			mimeType = "image/jpeg";
		}
		const data = String(result.data);
		if (data.length > 30_000_000) throw new Error("截图过大");
		return { data, mimeType, ...imageSize(data) };
	}
	/**
	 * Let the user click an element, as in DevTools' inspector: the page outlines what is under
	 * the pointer and swallows the click. One pick at a time; a new one ends the previous.
	 */
	private async pick(tabId?: string): Promise<BrowserControlResult> {
		this.picking?.finish();
		const tab = await this.tab(tabId);
		const session = await this.session(tab.targetId);
		await this.send("DOM.enable", {}, session);
		await this.send("Overlay.enable", {}, session);
		let finish: (nodeId?: number) => void = () => {};
		const picked = new Promise<number | undefined>((resolve) => {
			finish = resolve;
		});
		const picking = { session, finish };
		this.picking = picking;
		let nodeId: number | undefined;
		// Nobody is waiting any more after the requests' own limit.
		const timer = setTimeout(() => picking.finish(), BROWSER_PICK_TIMEOUT_MS);
		try {
			await this.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: HIGHLIGHT }, session);
			nodeId = await picked;
		} finally {
			clearTimeout(timer);
			if (this.picking === picking) this.picking = undefined;
			await this.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }, session).catch(() => {});
		}
		if (nodeId === undefined) return { cancelled: true };
		return { element: await this.describe(session, nodeId) };
	}
	private async describe(session: string, nodeId: number): Promise<BrowserElement> {
		const resolved = await this.send("DOM.resolveNode", { backendNodeId: nodeId }, session);
		const objectId = (resolved.object as { objectId?: string } | undefined)?.objectId;
		if (!objectId) throw new Error("无法读取所选元素");
		let described: DescribedElement | null | undefined;
		try {
			const response = await this.send(
				"Runtime.callFunctionOn",
				{ objectId, functionDeclaration: DESCRIBE, returnByValue: true },
				session,
			);
			if (response.exceptionDetails) throw new Error("无法读取所选元素");
			described = (response.result as { value?: DescribedElement | null } | undefined)?.value;
		} finally {
			void this.send("Runtime.releaseObject", { objectId }, session).catch(() => {});
		}
		if (!described) throw new Error("无法读取所选元素");
		const clip = visibleClip(described);
		const image = clip ? await this.capture(session, clip).catch(() => undefined) : undefined;
		const { viewport: _viewport, ...element } = described;
		return { nodeId, ...element, ...(image ? { image } : {}) };
	}
	/** The panel's own controls (`browser.control`): no opt-in, only the opening connection gets here. */
	async control(command: BrowserControl): Promise<BrowserControlResult> {
		switch (command.op) {
			case "state":
				return { state: await this.pageState() };
			case "pick":
				return this.pick(command.tabId);
			case "cancelPick":
				this.picking?.finish();
				return {};
			case "newTab": {
				const url = command.url ? webUrl(command.url).href : "about:blank";
				const created = await this.send("Target.createTarget", { url });
				this.activeTab = String(created.targetId);
				return { state: await this.pageState() };
			}
			case "fullscreen": {
				const tab = await this.tab(command.tabId);
				const windowOf = async () => {
					const window = await this.send("Browser.getWindowForTarget", { targetId: tab.targetId });
					return { id: window.windowId, state: (window.bounds as { windowState?: string } | undefined)?.windowState };
				};
				const setState = (id: unknown, windowState: string) =>
					this.send("Browser.setWindowBounds", { windowId: id, bounds: { windowState } });
				const window = await windowOf();
				if (command.value !== false) {
					if (window.state !== "fullscreen") await setState(window.id, "fullscreen");
				} else if (window.state === "fullscreen") {
					// A fullscreen window must become normal first; that restores it to maximized.
					await setState(window.id, "normal");
					const after = await windowOf();
					if (after.state === "normal") await setState(after.id, "maximized");
				}
				return {};
			}
		}
		const tab = await this.tab(command.tabId);
		const session = await this.session(tab.targetId);
		switch (command.op) {
			case "navigate": {
				const result = await this.send("Page.navigate", { url: webUrl(command.url ?? "").href }, session);
				if (result.errorText) throw new Error("网页导航失败");
				break;
			}
			case "back":
			case "forward":
				await this.history(session, command.op === "back" ? -1 : 1);
				break;
			case "reload":
				await this.send("Page.reload", {}, session);
				break;
			case "stop":
				await this.send("Page.stopLoading", {}, session);
				break;
			case "activateTab":
				await this.send("Target.activateTarget", { targetId: tab.targetId });
				this.activeTab = tab.targetId;
				break;
			case "closeTab":
				// The browser quits with its last tab: leave an empty page instead.
				if ((await this.targets()).length > 1) {
					await this.send("Target.closeTarget", { targetId: tab.targetId });
					if (this.activeTab === tab.targetId) this.activeTab = undefined;
					// The tab goes away a moment later: report the tabs without it.
					for (let i = 0; i < 20 && (await this.targets()).some((t) => t.targetId === tab.targetId); i++)
						await new Promise((resolve) => setTimeout(resolve, 50));
				} else await this.send("Page.navigate", { url: "about:blank" }, session);
				break;
			case "highlight":
				if (command.nodeId === undefined) throw new Error("需要元素");
				await this.send("DOM.enable", {}, session);
				await this.send("Overlay.enable", {}, session);
				await this.send(
					"Overlay.highlightNode",
					{ highlightConfig: HIGHLIGHT, backendNodeId: command.nodeId },
					session,
				);
				return {};
			case "clearHighlight":
				await this.send("Overlay.hideHighlight", {}, session).catch(() => {});
				return {};
			case "capture":
				return { image: await this.capture(session) };
		}
		return { state: await this.pageState() };
	}
	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		this.picking?.finish();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("本地浏览器已关闭"));
		}
		this.pending.clear();
		this.onExit();
	}
	close(): Promise<void> {
		if (this.ended) return this.exited;
		void this.send("Browser.close").catch(() => {});
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
		timer.unref();
		this.child.once("exit", () => clearTimeout(timer));
		this.finish();
		return this.exited;
	}
}
