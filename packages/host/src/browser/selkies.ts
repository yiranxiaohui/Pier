/** A private X11 display, a host-native browser, and a token-protected Selkies stream. */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { IceServer } from "@pier/crypto";
import {
	type BrowserCommand,
	type BrowserControl,
	type BrowserPreparationProgress,
	type BrowserTransport,
	PierProtocolError,
} from "@pier/protocol";
import type { BrowserProcess } from "./browsers.ts";
import { ChromiumBrowser } from "./chromium.ts";
import { BrowserRuntimeInstaller } from "./installation.ts";

export interface RemoteBrowserProcess extends BrowserProcess {
	port: number;
	token: string;
	setTransport(transport: BrowserTransport): Promise<void>;
}
export interface RemoteBrowserLaunch {
	profile: string;
	url: string;
	transport: BrowserTransport;
	iceServers: IceServer[];
	signal?: AbortSignal;
	installer?: BrowserRuntimeInstaller;
	onProgress?: (progress: BrowserPreparationProgress) => void;
	onExit(): void;
}

/** Switches for the browser on the private display, after the ones every Pier-launched browser gets. */
export const REMOTE_BROWSER_ARGS = [
	"--ozone-platform=x11",
	"--window-position=0,0",
	"--window-size=1440,900",
	"--start-maximized",
	"--force-device-scale-factor=1",
	// No banners above the page (e.g. Chrome for Testing's "only for automated testing"): the
	// viewer shows the page itself, and the panel's address bar stands in for the browser's.
	"--disable-infobars",
	// Keep cookie encryption in the profile instead of the desktop keyring. Nobody can answer an
	// unlock prompt from this display: a locked keyring (gnome-keyring running without a desktop
	// login) holds every request that needs cookies for D-Bus's 25 s timeout at each start.
	"--password-store=basic",
];

/** FamilyWild Xauthority cookie, with no X11 TCP listener or access-control bypass. */
export function xAuthority(cookie: Uint8Array): Buffer {
	const fields = [Buffer.alloc(0), Buffer.alloc(0), Buffer.from("MIT-MAGIC-COOKIE-1"), Buffer.from(cookie)];
	return Buffer.concat([
		Buffer.from([255, 255]),
		...fields.flatMap((field) => {
			const length = Buffer.alloc(2);
			length.writeUInt16BE(field.length);
			return [length, field];
		}),
	]);
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (!address || typeof address === "string") throw new Error("无法分配浏览器端口");
	return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
	if (!child.pid) return;
	const signal = (name: NodeJS.Signals | 0): boolean => {
		try {
			// Each helper owns its process group, including an AppImage's child processes.
			process.kill(-(child.pid as number), name);
			return true;
		} catch {
			return false;
		}
	};
	if (!signal("SIGTERM")) return;
	const deadline = Date.now() + 2000;
	while (signal(0) && Date.now() < deadline) await delay(50);
	// A helper can exit before its children. Do not cancel escalation just because the leader exits.
	signal("SIGKILL");
}

export class SelkiesBrowser implements RemoteBrowserProcess {
	port = 0;
	readonly token = randomBytes(32).toString("base64url");
	private readonly master = randomBytes(32).toString("base64url");
	private readonly children: ChildProcess[] = [];
	private browser?: ChromiumBrowser;
	private closed = false;
	private closing?: Promise<void>;
	private constructor(
		private readonly runtime: string,
		private readonly onExit: () => void,
	) {}

	static async start(options: RemoteBrowserLaunch): Promise<SelkiesBrowser> {
		if (process.platform !== "linux")
			throw new PierProtocolError("UNSUPPORTED", "远程浏览器目前支持 Linux 主机；本机浏览器支持所有桌面平台");
		const {
			selkies,
			xvfb,
			openbox,
			chromium: executable,
		} = await (options.installer ?? new BrowserRuntimeInstaller(join(homedir(), ".pier", "browser-runtime"))).ensure(
			options.onProgress,
			options.signal,
		);
		options.signal?.throwIfAborted();
		options.onProgress?.({ stage: "starting", message: "正在启动远程浏览器…" });
		const session = new SelkiesBrowser(mkdtempSync(join(tmpdir(), "pier-browser-")), options.onExit);
		const abort = () => {
			void session.close();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			await session.start(selkies, xvfb, openbox, executable, options);
			if (session.closed) throw new Error("远程浏览器启动过程中已关闭");
			return session;
		} catch (error) {
			await session.close();
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
	}

	private launch(executable: string, args: string[], env: NodeJS.ProcessEnv, displayFd = false): ChildProcess {
		const child = spawn(executable, args, {
			env,
			detached: true,
			stdio: displayFd ? ["ignore", "ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
		});
		this.children.push(child);
		child.stderr?.resume(); // Never print URLs, session credentials, or browser diagnostics.
		child.once("error", () => {
			void this.close();
		});
		child.once("exit", () => {
			void this.close();
		});
		return child;
	}

	private async start(
		selkies: string,
		xvfb: string,
		openbox: string,
		executable: string,
		options: RemoteBrowserLaunch,
	): Promise<void> {
		const auth = join(this.runtime, "Xauthority");
		writeFileSync(auth, xAuthority(randomBytes(16)), { mode: 0o600 });
		const display = this.launch(
			xvfb,
			[
				"-displayfd",
				"3",
				"-auth",
				auth,
				"-screen",
				"0",
				// Xvfb cannot grow past its initial framebuffer. Selkies caps each dimension at 4080.
				"4096x4096x24",
				"-nolisten",
				"tcp",
				"-noreset",
				"-s",
				"0",
				"+extension",
				"RANDR",
			],
			process.env,
			true,
		);
		const number = await new Promise<string>((resolve, reject) => {
			let data = "";
			const timer = setTimeout(() => reject(new Error("远程显示启动超时，请检查 Xvfb")), 10_000);
			const fail = () => {
				clearTimeout(timer);
				reject(new Error("远程显示启动失败，请检查 Xvfb"));
			};
			display.once("error", fail);
			display.once("exit", fail);
			(display.stdio[3] as Readable).on("data", (chunk: Buffer) => {
				data += chunk.toString();
				if (/^\d+\n$/.test(data)) {
					clearTimeout(timer);
					display.off("error", fail);
					display.off("exit", fail);
					resolve(data.trim());
				} else if (data.length > 32) fail();
			});
		});
		if (this.closed) throw new Error("远程显示已关闭");
		const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${number}`, XAUTHORITY: auth };
		delete env.WAYLAND_DISPLAY;
		// Start small, retaining headroom for the viewer's subsequent RandR resizes.
		await new Promise<void>((resolve, reject) => {
			execFile(selkies, ["resize", "1440x900"], { env, timeout: 10_000 }, (error) =>
				error ? reject(new Error("远程显示无法调整分辨率，请检查 Xvfb 和 Selkies")) : resolve(),
			);
		});
		if (this.closed) throw new Error("远程显示已关闭");
		// A maximized window follows RandR changes only when a window manager owns the display.
		// Use a private config, without the host desktop's shortcuts, decorations or autostart.
		const config = join(this.runtime, "openbox.xml");
		writeFileSync(
			config,
			`<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <desktops><number>1</number></desktops>
  <applications><application class="*" type="normal">
    <decor>no</decor><maximized>yes</maximized>
  </application></applications>
</openbox_config>`,
			{ mode: 0o600 },
		);
		const startup = join(this.runtime, "wm-ready");
		writeFileSync(startup, '#!/bin/sh\n: > "$0.ready"\n', { mode: 0o700 });
		this.launch(openbox, ["--sm-disable", "--config-file", config, "--startup", startup], env);
		const wmDeadline = Date.now() + 10_000;
		while (!this.closed && !existsSync(`${startup}.ready`) && Date.now() < wmDeadline) await delay(50);
		if (this.closed || !existsSync(`${startup}.ready`)) throw new Error("远程窗口管理器启动失败，请检查 Openbox");
		mkdirSync(options.profile, { recursive: true, mode: 0o700 });
		const downloads = join(options.profile, "Downloads");
		mkdirSync(downloads, { recursive: true, mode: 0o700 });
		this.browser = await ChromiumBrowser.start(
			options.profile,
			options.url,
			undefined,
			() => {
				void this.close();
			},
			{
				executable,
				env,
				downloadDir: downloads,
				args: REMOTE_BROWSER_ARGS,
			},
		);
		if (this.closed) {
			await this.browser.close();
			throw new Error("远程浏览器已关闭");
		}
		this.port = await freePort();
		if (this.closed) throw new Error("远程浏览器已关闭");
		const rtc = join(this.runtime, "rtc.json");
		writeFileSync(rtc, JSON.stringify({ iceServers: options.iceServers }), { mode: 0o600 });
		this.launch(
			selkies,
			[
				"--addr=127.0.0.1",
				`--port=${this.port}`,
				"--enable-https=false",
				"--enable-basic-auth=false",
				`--mode=${options.transport}`,
				"--enable-dual-mode=true",
				"--encoder=h264enc,vp8enc,jpeg",
				"--framerate=30",
				"--enable-resize=true",
				"--manual-resolution=false|locked",
				"--manual-width=0",
				"--manual-height=0",
				// Match CSS pixels, including Retina clients, so Chrome controls retain their usable size.
				"--use-css-scaling=true|locked",
				"--scaling-dpi=96",
				"--audio-enabled=false",
				"--command-enabled=false",
				"--clipboard-seamless=false",
				`--file-manager-path=${downloads}`,
				"--frame-ancestors='self',tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420",
			],
			{
				...env,
				SELKIES_MASTER_TOKEN: this.master,
				SELKIES_PUBLIC: "false",
				SELKIES_SUBFOLDER: "",
				SELKIES_UNIX_SOCKET: "",
				SELKIES_TOKENS_FILE: "",
				SELKIES_WAYLAND: "false",
				SELKIES_RTC_CONFIG_JSON: process.env.PIER_BROWSER_RTC_CONFIG || rtc,
			},
		);
		const deadline = Date.now() + 25_000;
		while (!this.closed && Date.now() < deadline) {
			try {
				await this.post("/api/tokens", { [this.token]: { role: "controller", slot: null, mk_control: true } });
				return;
			} catch {
				await delay(200);
			}
		}
		throw new Error("Selkies 启动失败或超时，请确认版本至少为 2.1.0，且系统支持 H.264 编码");
	}
	private async post(path: string, body: unknown): Promise<void> {
		const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.master}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(path === "/api/switch" ? 20_000 : 2000),
			redirect: "error",
		});
		await response.body?.cancel();
		if (!response.ok) throw new Error("远程浏览器服务未就绪");
	}
	async setTransport(transport: BrowserTransport): Promise<void> {
		if (this.closed) throw new Error("远程浏览器已关闭");
		await this.post("/api/switch", { mode: transport });
	}
	action(command: BrowserCommand) {
		if (!this.browser || this.closed) return Promise.reject(new Error("远程浏览器已关闭"));
		return this.browser.action(command);
	}
	control(command: BrowserControl) {
		if (!this.browser || this.closed) return Promise.reject(new Error("远程浏览器已关闭"));
		return this.browser.control(command);
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = Promise.resolve().then(async () => {
			// Let Chromium flush cookies and local storage before its X server disappears.
			await this.browser?.close().catch(() => {});
			await Promise.allSettled(this.children.map(stop));
			rmSync(this.runtime, { recursive: true, force: true });
		});
		this.onExit();
		return this.closing;
	}
}
