import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import {
	type BrowserCommand,
	type BrowserResult,
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
		return [...this.browsers.values()].filter((r) => r.owner === owner).map((r) => r.info);
	}
	async open(
		owner: Connection,
		params: { workspaceId: string; peerId?: string; url: string; mode: "service" | "network"; controlled?: boolean },
	): Promise<LocalBrowserInfo> {
		const url = webUrl(params.url);
		const controlled = params.controlled === true;
		const dedicated = params.mode === "network" || controlled;
		if (!dedicated) {
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
				(r) => (r.info.mode === "network" || r.info.controllable) && r.info.peerId === params.peerId,
			)
		) {
			throw new PierProtocolError("CONFLICT", "这台主机已有独立浏览器，请在现有窗口打开标签页，或先在浏览器列表关闭它");
		}
		if (this.browsers.size >= 16) throw new PierProtocolError("CONFLICT", "Too many browser connections");
		const browserId = randomUUID();
		const record: Record = {
			owner,
			closed: false,
			info: {
				browserId,
				workspaceId: params.workspaceId,
				peerId: params.peerId,
				url: url.href,
				localUrl: url.href,
				mode: params.mode,
				controllable: controlled,
			},
		};
		this.browsers.set(browserId, record);
		try {
			if (params.peerId) {
				record.client = await this.connect(params.peerId);
				const version = parseProtocolVersion(record.client.host?.protocolVersion ?? "");
				if (!version || (version.major === 1 && version.minor < 37))
					throw new PierProtocolError("UNSUPPORTED", "请先更新远程主机的 Pier（需要协议 1.37）");
				record.client.onState((state) => {
					if (state !== "open") this.closeRecord(record);
				});
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
					() => this.closeRecord(record),
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
		record.closed = true;
		this.browsers.delete(record.info.browserId);
		this.controllers.detach(record.info.browserId);
		const { network, browser, client } = record;
		record.network = undefined;
		record.browser = undefined;
		record.client = undefined;
		network?.close();
		client?.close();
		const done = Promise.resolve(browser?.close()).catch(() => {});
		this.closing.add(done);
		void done.finally(() => this.closing.delete(done));
		return done;
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
