/**
 * Bridge between the UI and its shell.
 *
 * In the Tauri app the Rust side owns the Pier Host sidecar and reports its status.
 * In a plain browser (UI development, automated tests) the UI connects to an already
 * running host given by `?url=ws://127.0.0.1:<port>&token=<token>`.
 */

import { normalizeUpdateMirror } from "@pier/client";
import { imagePixels, imagePngBlob } from "./image-clipboard.ts";

export type HostState = "starting" | "ready" | "restarting" | "failed" | "stopped";

export interface HostStatus {
	state: HostState;
	url?: string | null;
	token?: string | null;
	pid?: number | null;
	version?: string | null;
	protocolVersion?: string | null;
	error?: string | null;
	restarts: number;
	generation: number;
}

export interface Bridge {
	kind: "tauri" | "browser";
	status(): Promise<HostStatus>;
	onStatus(listener: (status: HostStatus) => void): () => void;
	logs(): Promise<string[]>;
	onLog(listener: (line: string) => void): () => void;
	restartHost(): Promise<void>;
	/** Ask the user for a directory. Resolves to an absolute path, or null when cancelled. */
	pickDirectory(): Promise<string | null>;
	/** Ask the user for files to upload to a web page: absolute paths, empty when cancelled. */
	pickFiles(multiple: boolean): Promise<string[]>;
	openExternal(url: string): Promise<void>;
	/**
	 * The clipboard's text, for pasting outside a native paste (a menu item, a custom shortcut). The
	 * desktop app reads it natively: WebView2 asks the user before every `navigator.clipboard.readText()`.
	 */
	readClipboardText(): Promise<string>;
	/**
	 * Put the image at `src` (a data or blob URL) on the clipboard. The desktop app writes it
	 * natively, as the WebViews differ in which images their clipboard API takes.
	 */
	copyImage(src: string): Promise<void>;
	/** Show a local file or directory in the system file manager; only the desktop app can. */
	revealPath?(path: string): Promise<void>;
	/**
	 * Ask where to save a downloaded file named `name` and open it for writing. Resolves to null
	 * when the user cancels.
	 */
	saveFile(name: string): Promise<LocalFileSink | null>;
	quit(): Promise<void>;
	updates: UpdateBridge;
	/** System login startup for this desktop app; unavailable in a browser. */
	autostart?: AutostartBridge;
	/** Integrated terminals; only the desktop app can run local shells. */
	terminal?: TerminalBridge;
}

export interface AutostartBridge {
	status(): Promise<boolean>;
	/** Update the system entry and return its actual enabled state. */
	setEnabled(enabled: boolean): Promise<boolean>;
}

/** A local file being written by a download. */
export interface LocalFileSink {
	/** Where the file will be saved, when known (the desktop app). */
	path?: string;
	/** Append base64-encoded bytes. */
	write(base64: string): Promise<void>;
	/** Save the complete file; resolves to where it was saved, when known. */
	finish(): Promise<string | undefined>;
	/** Discard what was written. */
	abort(): Promise<void>;
}

/** Mirrors `SpawnedTerminal` in `src-tauri/src/terminal.rs`. */
export interface SpawnedTerminal {
	id: number;
	/** The shell program name, e.g. `zsh` or `powershell`. */
	shell: string;
	/** The directory the shell started in (the home directory if the requested one is gone). */
	cwd: string;
}

export interface TerminalHandlers {
	/** Raw PTY output; may end in the middle of a UTF-8 sequence. */
	output(data: Uint8Array): void;
	/**
	 * The shell exited (`code` is null when it was killed by a signal). `error` is set when the
	 * terminal was lost rather than ended, e.g. the connection to its computer dropped.
	 */
	exit(code: number | null, error?: string): void;
}

/**
 * Runs shells: this computer's pseudo-terminals (the Tauri bridge), or another computer's
 * through its Pier Host (`terminal.*`, see `remote-terminals.ts`).
 */
export interface TerminalBridge {
	spawn(options: { cwd?: string; cols: number; rows: number }, handlers: TerminalHandlers): Promise<SpawnedTerminal>;
	/** `binary` input carries one byte per character (xterm's `onBinary`). */
	write(id: number, data: string, binary?: boolean): Promise<void>;
	resize(id: number, cols: number, rows: number): Promise<void>;
	kill(id: number): Promise<void>;
	/** Hang up every terminal, e.g. ones left over from before the page reloaded. */
	killAll(): Promise<void>;
}

export type UpdateState =
	| "unsupported"
	| "idle"
	| "checking"
	| "upToDate"
	| "available"
	| "downloading"
	| "installing"
	| "error";

/** Mirrors `UpdateStatus` in `src-tauri/src/updater.rs`. */
export interface UpdateStatus {
	state: UpdateState;
	currentVersion: string;
	autoCheck: boolean;
	/** Empty for GitHub direct; otherwise an HTTPS acceleration prefix. */
	mirrorPrefix?: string;
	/** The available (or still pending, after a failed install) update. */
	version?: string | null;
	notes?: string | null;
	date?: string | null;
	/**
	 * Bytes downloaded so far: while `downloading`, and for a paused or interrupted download of
	 * the pending update, which installing continues.
	 */
	downloaded: number;
	total?: number | null;
	/** While `downloading`: why the download is being retried. */
	error?: string | null;
	/** Unix time (ms) of the last successful check. */
	lastChecked?: number | null;
	/** Installing asks for an administrator password (Linux .deb / .rpm). */
	installNeedsAuth?: boolean;
}

export interface UpdateBridge {
	status(): Promise<UpdateStatus>;
	onStatus(listener: (status: UpdateStatus) => void): () => void;
	/** The tray menu asks for the update dialog. */
	onOpen(listener: () => void): () => void;
	check(): Promise<UpdateStatus>;
	cancelCheck(): Promise<UpdateStatus>;
	/**
	 * Download, install, and relaunch. Rejects with the reason when it fails; resolves without
	 * relaunching when the download is paused.
	 */
	install(): Promise<void>;
	/** Pause the running download; installing again continues where it stopped. */
	cancelInstall(): Promise<UpdateStatus>;
	setAutoCheck(enabled: boolean): Promise<UpdateStatus>;
	setMirror(prefix: string): Promise<UpdateStatus>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function tauriBridge(): Bridge {
	const core = import("@tauri-apps/api/core");
	const event = import("@tauri-apps/api/event");
	const listen = <T>(name: string, listener: (payload: T) => void) => {
		let unlisten: (() => void) | undefined;
		let disposed = false;
		void event.then(({ listen }) =>
			listen<T>(name, (e) => listener(e.payload)).then((fn) => {
				if (disposed) fn();
				else unlisten = fn;
			}),
		);
		return () => {
			disposed = true;
			unlisten?.();
		};
	};
	return {
		kind: "tauri",
		status: async () => (await core).invoke<HostStatus>("host_status"),
		onStatus: (listener) => listen<HostStatus>("pier://host-status", listener),
		logs: async () => (await core).invoke<string[]>("host_logs"),
		onLog: (listener) => listen<string>("pier://host-log", listener),
		restartHost: async () => (await core).invoke("host_restart"),
		pickDirectory: async () => {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const result = await open({ directory: true, multiple: false, title: "选择工作区目录" });
			return typeof result === "string" ? result : null;
		},
		pickFiles: async (multiple) => {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const result = await open({ directory: false, multiple, title: "选择要上传的文件" });
			return Array.isArray(result) ? result : typeof result === "string" ? [result] : [];
		},
		openExternal: async (url) => {
			const { openUrl } = await import("@tauri-apps/plugin-opener");
			await openUrl(url);
		},
		readClipboardText: async () => {
			const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
			return readText();
		},
		copyImage: async (src) => {
			const { width, height, rgba } = await imagePixels(src);
			// The pixels go as the raw request body; see `src-tauri/src/clipboard.rs`.
			await (await core).invoke("clipboard_write_image", rgba, {
				headers: { "Pier-Image-Width": String(width), "Pier-Image-Height": String(height) },
			});
		},
		revealPath: async (path) => {
			const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
			await revealItemInDir(path);
		},
		saveFile: async (name) => {
			const { invoke } = await core;
			const target = await invoke<{ id: number; path: string } | null>("download_begin", { name });
			if (!target) return null;
			const { id } = target;
			return {
				path: target.path,
				write: (data) => invoke("download_write", { id, data }),
				finish: () => invoke<string>("download_finish", { id }),
				abort: () => invoke("download_abort", { id }),
			};
		},
		quit: async () => (await core).invoke("quit_app"),
		autostart: {
			status: async () => (await core).invoke<boolean>("autostart_status"),
			setEnabled: async (enabled) => (await core).invoke<boolean>("autostart_set_enabled", { enabled }),
		},
		updates: {
			status: async () => (await core).invoke<UpdateStatus>("update_status"),
			onStatus: (listener) => listen<UpdateStatus>("pier://update-status", listener),
			onOpen: (listener) => listen<null>("pier://update-open", () => listener()),
			check: async () => (await core).invoke<UpdateStatus>("update_check"),
			cancelCheck: async () => (await core).invoke<UpdateStatus>("update_cancel_check"),
			install: async () => (await core).invoke("update_install"),
			cancelInstall: async () => (await core).invoke<UpdateStatus>("update_cancel_install"),
			setAutoCheck: async (enabled) => (await core).invoke<UpdateStatus>("update_set_auto_check", { enabled }),
			setMirror: async (prefix) => (await core).invoke<UpdateStatus>("update_set_mirror", { prefix }),
		},
		terminal: {
			spawn: async ({ cwd, cols, rows }, handlers) => {
				const { Channel, invoke } = await core;
				const output = new Channel<ArrayBuffer | { type: "exit"; code?: number | null }>((message) => {
					if (message instanceof ArrayBuffer) handlers.output(new Uint8Array(message));
					else if (message.type === "exit") handlers.exit(message.code ?? null);
				});
				return invoke<SpawnedTerminal>("terminal_spawn", { cwd: cwd ?? null, cols, rows, output });
			},
			write: async (id, data, binary) => (await core).invoke("terminal_write", { id, data, binary: binary ?? false }),
			resize: async (id, cols, rows) => (await core).invoke("terminal_resize", { id, cols, rows }),
			kill: async (id) => (await core).invoke("terminal_kill", { id }),
			killAll: async () => (await core).invoke("terminal_kill_all"),
		},
	};
}

function browserBridge(): Bridge {
	const params = new URLSearchParams(window.location.search);
	const url = params.get("url") ?? import.meta.env.VITE_PIER_URL ?? null;
	const token = params.get("token") ?? import.meta.env.VITE_PIER_TOKEN ?? null;
	const status: HostStatus = url
		? { state: "ready", url, token, restarts: 0, generation: 1 }
		: {
				state: "stopped",
				error: "浏览器模式：请在地址后附加 ?url=ws://127.0.0.1:<端口>&token=<token>（见 ~/.pier/run/host.json）",
				restarts: 0,
				generation: 0,
			};
	return {
		kind: "browser",
		status: async () => status,
		onStatus: () => () => {},
		logs: async () => ["浏览器模式下没有 Host 日志；Host 由外部进程运行。"],
		onLog: () => () => {},
		restartHost: async () => window.location.reload(),
		pickDirectory: async () => window.prompt("工作区目录的绝对路径")?.trim() || null,
		pickFiles: async () => {
			const path = window.prompt("要上传的文件的绝对路径")?.trim();
			return path ? [path] : [];
		},
		openExternal: async (target) => {
			window.open(target, "_blank", "noopener,noreferrer");
		},
		readClipboardText: () => navigator.clipboard.readText(),
		// The blob is passed as a promise so converting it keeps the click's user activation.
		copyImage: (src) => navigator.clipboard.write([new ClipboardItem({ "image/png": imagePngBlob(src) })]),
		saveFile: async (name) => browserDownload(name),
		quit: async () => window.close(),
		updates: params.get("updates") === "demo" ? demoUpdates() : unsupportedUpdates,
		...(params.get("terminal") === "demo" ? { terminal: demoTerminal() } : {}),
	};
}

/** Collect a download in memory and hand it to the browser's own download. */
function browserDownload(name: string): LocalFileSink {
	const parts: Uint8Array<ArrayBuffer>[] = [];
	return {
		write: async (data) => {
			const binary = atob(data);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			parts.push(bytes);
		},
		finish: async () => {
			const url = URL.createObjectURL(new Blob(parts));
			const link = document.createElement("a");
			link.href = url;
			link.download = name;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			return undefined;
		},
		abort: async () => {
			parts.length = 0;
		},
	};
}

/**
 * `?terminal=demo`: a fake line-echo shell for working on the terminal UI in a browser.
 */
function demoTerminal(): TerminalBridge {
	const encoder = new TextEncoder();
	const shells = new Map<number, { handlers: TerminalHandlers; line: string }>();
	let nextId = 0;
	const prompt = "\x1b[36mdemo\x1b[0m $ ";
	return {
		spawn: async ({ cwd, cols, rows }, handlers) => {
			const id = ++nextId;
			shells.set(id, { handlers, line: "" });
			const out = (text: string) => handlers.output(encoder.encode(text));
			setTimeout(() => {
				out(`演示终端（浏览器模式）· ${cols}×${rows} · ${cwd ?? "~"}\r\n`);
				out("输入 exit 退出，fail 以非零代码退出。\r\n");
				out(prompt);
			}, 50);
			return { id, shell: "demo", cwd: cwd ?? "~" };
		},
		write: async (id, data) => {
			const shell = shells.get(id);
			if (!shell) throw new Error("终端已关闭");
			const out = (text: string) => shell.handlers.output(encoder.encode(text));
			for (const ch of data) {
				if (ch === "\r") {
					const line = shell.line.trim();
					shell.line = "";
					out("\r\n");
					if (line === "exit" || line === "fail") {
						shells.delete(id);
						shell.handlers.exit(line === "exit" ? 0 : 1);
						return;
					}
					if (line) out(`${line}\r\n`);
					out(prompt);
				} else if (ch === "\x7f") {
					if (shell.line) {
						shell.line = shell.line.slice(0, -1);
						out("\b \b");
					}
				} else if (ch >= " ") {
					shell.line += ch;
					out(ch);
				}
			}
		},
		resize: async () => {},
		kill: async (id) => {
			shells.delete(id);
		},
		killAll: async () => shells.clear(),
	};
}

const unsupported: UpdateStatus = {
	state: "unsupported",
	currentVersion: "dev",
	autoCheck: false,
	downloaded: 0,
};

const unsupportedUpdates: UpdateBridge = {
	status: async () => unsupported,
	onStatus: () => () => {},
	onOpen: () => () => {},
	check: async () => unsupported,
	cancelCheck: async () => unsupported,
	install: async () => {
		throw new Error("浏览器模式不支持自动更新");
	},
	cancelInstall: async () => unsupported,
	setAutoCheck: async () => unsupported,
	setMirror: async () => unsupported,
};

/** `?updates=demo`: a fake update feed for working on the update UI in a browser. */
function demoUpdates(): UpdateBridge {
	const listeners = new Set<(status: UpdateStatus) => void>();
	let status: UpdateStatus = { state: "idle", currentVersion: "0.1.0", autoCheck: true, downloaded: 0 };
	const set = (patch: Partial<UpdateStatus>) => {
		status = { ...status, ...patch };
		for (const listener of listeners) listener(status);
		return status;
	};
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	let checkId = 0;
	let installId = 0;
	let dropped = false;
	let previousState: UpdateState = "idle";
	const cancelCheck = () => {
		checkId++;
		return status.state === "checking" ? set({ state: previousState }) : status;
	};
	return {
		status: async () => status,
		onStatus: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onOpen: () => () => {},
		check: async () => {
			if (status.state === "checking" || status.state === "downloading" || status.state === "installing") return status;
			const id = ++checkId;
			previousState = status.state;
			set({ state: "checking" });
			await sleep(800);
			if (id !== checkId) return status;
			return set({
				state: "available",
				version: "9.9.9",
				date: new Date().toISOString(),
				notes:
					"### Added\n\n- **Auto update** for the desktop app.\n- Faster session loading.\n\n### Fixed\n\n- Reconnects after sleep.",
				error: null,
				lastChecked: Date.now(),
			});
		},
		cancelCheck: async () => cancelCheck(),
		cancelInstall: async () => {
			if (status.state !== "downloading") return status;
			installId++;
			return set({ state: "available", error: null });
		},
		install: async () => {
			if (status.state === "downloading" || status.state === "installing") return;
			const id = ++installId;
			const total = 48 * 1024 * 1024;
			// Continue a paused download, with one simulated connection drop at 40%.
			for (let downloaded = status.total ? status.downloaded : 0; downloaded < total; downloaded += total / 20) {
				set({ state: "downloading", downloaded, total, error: null });
				await sleep(120);
				if (id !== installId) return;
				if (!dropped && downloaded >= total * 0.4) {
					dropped = true;
					set({ error: "网络连接中断，1 秒后自动重试（第 1/5 次）" });
					await sleep(1000);
					if (id !== installId) return;
				}
			}
			set({ state: "downloading", downloaded: total, total, error: null });
			set({ state: "installing" });
			await sleep(1000);
			const error = "安装更新失败：浏览器演示模式不会真正安装";
			set({ state: "error", error });
			throw new Error(error);
		},
		setAutoCheck: async (enabled) => {
			if (!enabled) cancelCheck();
			return set({ autoCheck: enabled });
		},
		setMirror: async (prefix) => {
			const mirrorPrefix = normalizeUpdateMirror(prefix);
			cancelCheck();
			return set({ mirrorPrefix });
		},
	};
}

export const bridge: Bridge = isTauri ? tauriBridge() : browserBridge();
