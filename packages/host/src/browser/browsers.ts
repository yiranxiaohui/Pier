import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import {
	BROWSER_OPEN_TIMEOUT_MS,
	BROWSER_PICK_TIMEOUT_MS,
	type BrowserCommand,
	type BrowserControl,
	type BrowserControlResult,
	type BrowserPreparationProgress,
	BrowserPreparationProgressSchema,
	type BrowserResult,
	type BrowserTransport,
	type LocalBrowserInfo,
	PierProtocolError,
	parseProtocolVersion,
} from "@pier/protocol";
import type { Connection } from "../connection.ts";
import { ChromiumBrowser } from "./chromium.ts";
import type { BrowserControllers } from "./controllers.ts";
import { type BrowserNetwork, forwardService, remoteProxy, webUrl } from "./network.ts";

export interface BrowserProcess {
	action(command: BrowserCommand): Promise<BrowserResult>;
	/** The opening client's own controls (1.67); absent on test doubles that do not drive a page. */
	control?(command: BrowserControl): Promise<BrowserControlResult>;
	close(): void | Promise<void>;
}
export interface BrowserOptions {
	launch?: (profile: string, url: string, proxyPort: number | undefined, onExit: () => void) => Promise<BrowserProcess>;
}
interface Record {
	owner: Connection;
	info: LocalBrowserInfo;
	client?: PierClient;
	network?: BrowserNetwork;
	browser?: BrowserProcess;
	closed: boolean;
	ready?: boolean;
	remoteId?: string;
	/** A Pier-launched browser process (not the system browser or a forwarded port). */
	dedicated: boolean;
	preparation?: BrowserPreparationProgress;
	closing?: Promise<void>;
}

export class LocalBrowsers {
	private readonly browsers = new Map<string, Record>();
	private readonly closing = new Set<Promise<void>>();
	constructor(
		private readonly dir: string,
		private readonly connect: (peerId: string) => Promise<PierClient>,
		private readonly controllers: BrowserControllers,
		private readonly options: BrowserOptions = {},
	) {}

	list(owner: Connection): LocalBrowserInfo[] {
		return [...this.browsers.values()].filter((r) => r.owner === owner && r.ready).map((r) => r.info);
	}
	preparations(owner: Connection) {
		return [...this.browsers.values()]
			.filter((record) => record.owner === owner && record.preparation && !record.ready && !record.closed)
			.map((record) => ({
				browserId: record.info.browserId,
				workspaceId: record.info.workspaceId,
				peerId: record.info.peerId,
				progress: record.preparation as BrowserPreparationProgress,
			}));
	}
	private progress(record: Record, progress: BrowserPreparationProgress): void {
		if (record.closed || record.owner.isClosed) return;
		progress = { ...progress, logs: progress.logs ?? record.preparation?.logs };
		record.preparation = progress;
		record.owner.send({
			type: "evt",
			event: {
				type: "browser.preparing",
				browserId: record.info.browserId,
				workspaceId: record.info.workspaceId,
				peerId: record.info.peerId,
				progress,
			},
		});
	}
	async open(
		owner: Connection,
		params: {
			workspaceId: string;
			peerId?: string;
			url: string;
			mode: "service" | "network" | "remote";
			controlled?: boolean;
			transport?: BrowserTransport;
			managed?: boolean;
		},
	): Promise<LocalBrowserInfo> {
		const url = webUrl(params.url);
		if (params.mode === "remote" && !params.peerId) throw new PierProtocolError("BAD_REQUEST", "请选择远程主机");
		const controlled = params.controlled === true;
		const dedicated = params.mode !== "remote" && (params.mode === "network" || controlled || params.managed === true);
		if (!dedicated && params.mode !== "remote") {
			const existing = [...this.browsers.values()].find(
				(r) =>
					r.ready &&
					r.owner === owner &&
					r.info.peerId === params.peerId &&
					r.info.workspaceId === params.workspaceId &&
					r.info.mode === "service" &&
					!r.info.controllable &&
					new URL(r.info.url).origin === url.origin,
			);
			if (existing) {
				const local = new URL(url.href);
				if (existing.network) {
					local.hostname = "127.0.0.1";
					local.port = String(existing.network.port);
				}
				existing.info = { ...existing.info, url: url.href, localUrl: local.href };
				return existing.info;
			}
		}
		if (
			dedicated &&
			[...this.browsers.values()].some(
				(r) => r.info.mode !== "remote" && r.dedicated && r.info.peerId === params.peerId,
			)
		) {
			throw new PierProtocolError("CONFLICT", "这台主机已有独立浏览器，请在现有窗口打开标签页，或先在浏览器列表关闭它");
		}
		if (this.browsers.size >= 16) throw new PierProtocolError("CONFLICT", "Too many browser connections");
		const browserId = randomUUID();
		const record: Record = {
			owner,
			closed: false,
			dedicated,
			info: {
				browserId,
				workspaceId: params.workspaceId,
				peerId: params.peerId,
				url: url.href,
				localUrl: url.href,
				mode: params.mode,
				controllable: controlled,
				...(dedicated || params.mode === "remote" ? { managed: true } : {}),
			},
		};
		this.browsers.set(browserId, record);
		if (params.mode === "remote") this.progress(record, { stage: "checking", message: "正在准备远程浏览器…" });
		try {
			if (params.peerId) {
				record.client = await this.connect(params.peerId);
				if (record.closed || owner.isClosed) {
					record.client.close();
					throw new Error("Browser connection closed");
				}
				const version = parseProtocolVersion(record.client.host?.protocolVersion ?? "");
				if (!version || (version.major === 1 && version.minor < 37))
					throw new PierProtocolError("UNSUPPORTED", "请先更新远程主机的 Pier（需要协议 1.37）");
				record.client.onState((state) => {
					if (state !== "open") this.closeRecord(record);
				});
				if (params.mode === "remote") {
					if (version.major === 1 && version.minor < 48)
						throw new PierProtocolError("UNSUPPORTED", "请先更新远程主机的 Pier（自动准备远程浏览器需要协议 1.48）");
					const client = record.client;
					client.onEvent((frame) => {
						if (frame.event.type === "browser.preparing" && frame.event.workspaceId === params.workspaceId) {
							const parsed = BrowserPreparationProgressSchema.safeParse(frame.event.progress);
							if (parsed.success) this.progress(record, parsed.data);
						}
						if (
							frame.event.type === "browser.remoteClosed" &&
							(!record.remoteId || frame.event.browserId === record.remoteId)
						)
							void this.closeRecord(record);
					});
					const remote = await client.request(
						"browser.remoteOpen",
						{
							workspaceId: params.workspaceId,
							url: url.href,
							controlled,
							transport: params.transport,
						},
						{ timeoutMs: BROWSER_OPEN_TIMEOUT_MS },
					);
					record.remoteId = remote.browserId;
					if (record.closed || owner.isClosed) {
						client.close();
						throw new Error("Browser connection closed");
					}
					record.network = await forwardService(client, new URL(`http://127.0.0.1:${remote.port}`));
					if (record.closed || owner.isClosed) {
						record.network.close();
						client.close();
						throw new Error("Browser connection closed");
					}
					record.info.localUrl = `http://127.0.0.1:${record.network.port}/#token=${encodeURIComponent(remote.token)}`;
					record.info.transport = remote.transport;
					record.ready = true;
					return record.info;
				}
				if (params.mode === "network") record.network = await remoteProxy(record.client);
				else {
					record.network = await forwardService(record.client, url);
					const local = new URL(url.href);
					local.hostname = "127.0.0.1";
					local.port = String(record.network.port);
					record.info.localUrl = local.href;
				}
			}
			if (owner.isClosed || record.closed) throw new Error("Browser connection closed");
			if (dedicated) {
				const profile = join(
					this.dir,
					"browser-profiles",
					createHash("sha256")
						.update(params.peerId ?? "local")
						.digest("hex")
						.slice(0, 32),
				);
				record.browser = await (this.options.launch ?? ChromiumBrowser.start)(
					profile,
					record.info.localUrl,
					params.mode === "network" ? record.network?.port : undefined,
					() => {
						void this.closeRecord(record);
					},
				);
				if (record.closed || owner.isClosed) {
					record.browser.close();
					throw new Error("Browser connection closed");
				}
				if (controlled && record.client) {
					record.client.onEvent((frame) => {
						const event = frame.event;
						if (event.type !== "browser.command" || event.browserId !== browserId) return;
						void record.browser
							?.action(event.command as BrowserCommand)
							.then(
								(result) => record.client?.request("browser.result", { requestId: String(event.requestId), result }),
								() =>
									record.client?.request("browser.result", {
										requestId: String(event.requestId),
										error: "本地浏览器操作失败，请检查标签页、选择器和浏览器状态",
									}),
							)
							.catch(() => {});
					});
					await record.client.request("browser.attach", { workspaceId: params.workspaceId, browserId });
				} else if (controlled)
					this.controllers.attachLocal(params.workspaceId, browserId, (command) =>
						(record.browser as BrowserProcess).action(command),
					);
			}
			if (owner.isClosed || record.closed) throw new Error("Browser connection closed");
			record.ready = true;
			return record.info;
		} catch (error) {
			this.closeRecord(record);
			throw error;
		}
	}
	private closeRecord(record: Record): Promise<void> {
		if (record.closing) return record.closing;
		record.closed = true;
		this.browsers.delete(record.info.browserId);
		this.controllers.detach(record.info.browserId);
		const { network, browser, client } = record;
		record.network = undefined;
		record.browser = undefined;
		record.client = undefined;
		network?.close();
		const done = Promise.resolve()
			.then(async () => {
				if (record.remoteId && client?.state === "open")
					await client
						.request("browser.remoteClose", { browserId: record.remoteId }, { timeoutMs: 10_000 })
						.catch(() => {});
				client?.close();
				await browser?.close();
			})
			.catch(() => {});
		record.closing = done;
		this.closing.add(done);
		void done.finally(() => this.closing.delete(done));
		return done;
	}
	async setTransport(owner: Connection, id: string, transport: BrowserTransport): Promise<LocalBrowserInfo> {
		const record = this.browsers.get(id);
		if (!record || record.owner !== owner || record.closed || !record.client || !record.remoteId)
			throw new PierProtocolError("NOT_FOUND", "远程浏览器连接已关闭");
		await record.client.request(
			"browser.remoteTransport",
			{ browserId: record.remoteId, transport },
			{ timeoutMs: 30_000 },
		);
		record.info = { ...record.info, transport };
		return record.info;
	}
	/**
	 * The panel's own controls of a browser this connection opened: the workspace host's for a
	 * remote one (it needs protocol 1.67), the Pier-launched process for a local one.
	 */
	async control(owner: Connection, id: string, command: BrowserControl): Promise<BrowserControlResult> {
		const record = this.browsers.get(id);
		if (!record || record.owner !== owner || record.closed || !record.ready)
			throw new PierProtocolError("NOT_FOUND", "浏览器会话已关闭");
		if (record.remoteId) {
			const client = record.client;
			if (!client) throw new PierProtocolError("NOT_FOUND", "远程浏览器连接已关闭");
			const version = parseProtocolVersion(client.host?.protocolVersion ?? "");
			if (!version || (version.major === 1 && version.minor < 67))
				throw new PierProtocolError("UNSUPPORTED", "请先更新远程主机的 Pier（地址栏和元素选取需要协议 1.67）");
			return client.request(
				"browser.remoteControl",
				{ browserId: record.remoteId, command },
				{ timeoutMs: command.op === "pick" ? BROWSER_PICK_TIMEOUT_MS : 30_000 },
			);
		}
		const browser = record.browser;
		if (!browser?.control) throw new PierProtocolError("UNSUPPORTED", "这个浏览器不由 Pier 管理，无法控制");
		return browser.control(command);
	}
	async close(owner: Connection, id: string): Promise<boolean> {
		const record = this.browsers.get(id);
		if (!record || record.owner !== owner) return false;
		await this.closeRecord(record);
		return true;
	}
	connectionClosed(owner: Connection): void {
		for (const record of this.browsers.values()) if (record.owner === owner) this.closeRecord(record);
	}
	async shutdown(): Promise<void> {
		for (const record of this.browsers.values()) this.closeRecord(record);
		await Promise.all(this.closing);
	}
}
