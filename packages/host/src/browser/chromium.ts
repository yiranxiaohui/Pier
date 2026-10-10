/** A dedicated local Chromium process. CDP uses private stdio pipes, never an open debugging port. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { BrowserCommand, BrowserResult } from "@pier/protocol";
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
		throw new Error(
			"未找到本地 Chrome、Chromium 或 Edge。请安装其中一个，或用 PIER_BROWSER_BIN 指定可执行文件；开发服务也可用默认浏览器打开。",
		);
	return found;
}

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

export class ChromiumBrowser {
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private readonly pending = new Map<number, Pending>();
	private readonly sessions = new Map<string, string>();
	private readonly input: Writable;
	private ended = false;
	private chain: Promise<unknown> = Promise.resolve();
	private readonly exited: Promise<void>;
	private queued = 0;

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
		(child.stderr as Readable)?.resume();
		child.once("error", () => this.finish());
		child.once("exit", () => this.finish());
	}
	static async start(
		profile: string,
		url: string,
		proxyPort: number | undefined,
		onExit: () => void,
		testOptions?: { executable?: string; args?: string[] },
	): Promise<ChromiumBrowser> {
		mkdirSync(profile, { recursive: true, mode: 0o700 });
		const args = [
			"--remote-debugging-pipe",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-quic",
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		];
		if (proxyPort)
			args.push(
				`--proxy-server=http://127.0.0.1:${proxyPort}`,
				"--proxy-bypass-list=<-loopback>",
				"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
			);
		args.push(...(testOptions?.args ?? []), "about:blank");
		const child = spawn(testOptions?.executable ?? findChromium(), args, {
			stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
			windowsHide: false,
		});
		const browser = new ChromiumBrowser(child, onExit);
		try {
			await browser.send("Browser.getVersion");
			const tabs = await browser.targets();
			const tab = tabs[0];
			if (tab) await browser.send("Page.navigate", { url }, await browser.session(tab.targetId));
			else await browser.send("Target.createTarget", { url });
			return browser;
		} catch (error) {
			browser.close();
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
					result?: Record<string, unknown>;
					error?: { message?: string };
				};
				if (frame.id === undefined) continue;
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
	private send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		if (this.ended) return Promise.reject(new Error("本地浏览器已关闭"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Browser command timed out"));
			}, 20_000);
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
	private async session(tabId: string): Promise<string> {
		const existing = this.sessions.get(tabId);
		if (existing) return existing;
		const result = await this.send("Target.attachToTarget", { targetId: tabId, flatten: true });
		const sessionId = String(result.sessionId);
		this.sessions.set(tabId, sessionId);
		return sessionId;
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
	private finish(): void {
		if (this.ended) return;
		this.ended = true;
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
