import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IceServer } from "@pier/crypto";
import {
	type BrowserControl,
	type BrowserControlResult,
	type BrowserTransport,
	PierProtocolError,
	type RemoteBrowserInfo,
} from "@pier/protocol";
import type { Connection } from "../connection.ts";
import type { BrowserControllers } from "./controllers.ts";
import { BrowserRuntimeInstaller, type BrowserRuntimeInstallerOptions } from "./installation.ts";
import { webUrl } from "./network.ts";
import { type RemoteBrowserLaunch, type RemoteBrowserProcess, SelkiesBrowser } from "./selkies.ts";

export interface RemoteBrowserOptions {
	installation?: BrowserRuntimeInstallerOptions;
	launch?: (options: RemoteBrowserLaunch) => Promise<RemoteBrowserProcess>;
}
interface Session {
	owner: Connection;
	abort: AbortController;
	id: string;
	workspaceId: string;
	transport: BrowserTransport;
	process?: RemoteBrowserProcess;
	starting?: Promise<void>;
	closing?: Promise<void>;
	closed: boolean;
	ready?: boolean;
}

/** Session ownership also covers startup, disconnects, and transport switching. */
export class RemoteBrowsers {
	private readonly sessions = new Map<string, Session>();
	private readonly closing = new Set<Promise<void>>();
	private readonly installer: BrowserRuntimeInstaller;
	constructor(
		private readonly dir: string,
		private readonly controllers: BrowserControllers,
		private readonly iceServers: () => IceServer[],
		private readonly options: RemoteBrowserOptions = {},
	) {
		this.installer = new BrowserRuntimeInstaller(join(dir, "browser-runtime"), options.installation);
	}
	async open(
		owner: Connection,
		params: {
			workspaceId: string;
			url: string;
			controlled?: boolean;
			transport?: BrowserTransport;
		},
	): Promise<RemoteBrowserInfo> {
		const url = webUrl(params.url).href;
		if (owner.isClosed) throw new Error("远程浏览器连接已关闭");
		if (this.sessions.size >= 4) throw new PierProtocolError("CONFLICT", "这台主机最多同时运行 4 个远程浏览器");
		if ([...this.sessions.values()].some((s) => s.workspaceId === params.workspaceId))
			throw new PierProtocolError("CONFLICT", "此工作区已有远程浏览器，请返回现有画面或先关闭连接");
		const session: Session = {
			owner,
			abort: new AbortController(),
			id: randomUUID(),
			workspaceId: params.workspaceId,
			transport: params.transport ?? "webrtc",
			closed: false,
		};
		this.sessions.set(session.id, session);
		session.starting = (async () => {
			session.process = await (this.options.launch ?? SelkiesBrowser.start)({
				profile: join(
					this.dir,
					"browser-profiles",
					`remote-${createHash("sha256").update(params.workspaceId).digest("hex").slice(0, 32)}`,
				),
				url,
				transport: session.transport,
				iceServers: this.iceServers(),
				signal: session.abort.signal,
				installer: this.installer,
				onProgress: (progress) => {
					if (!session.closed && !owner.isClosed)
						owner.send({
							type: "evt",
							event: { type: "browser.preparing", browserId: session.id, workspaceId: params.workspaceId, progress },
						});
				},
				onExit: () => {
					void this.closeSession(session);
				},
			});
		})();
		try {
			await session.starting;
			if (owner.isClosed || session.closed) throw new Error("远程浏览器连接已关闭");
			const browser = session.process as RemoteBrowserProcess;
			if (params.controlled)
				this.controllers.attachLocal(params.workspaceId, session.id, (command) => browser.action(command));
			session.ready = true;
			return {
				browserId: session.id,
				workspaceId: params.workspaceId,
				port: browser.port,
				token: browser.token,
				transport: session.transport,
			};
		} catch (error) {
			await this.closeSession(session);
			throw error;
		}
	}
	async setTransport(
		owner: Connection,
		id: string,
		transport: BrowserTransport,
	): Promise<{ transport: BrowserTransport }> {
		const session = this.sessions.get(id);
		if (!session || session.owner !== owner || session.closed || !session.process)
			throw new PierProtocolError("NOT_FOUND", "远程浏览器连接已关闭");
		await session.process.setTransport(transport);
		session.transport = transport;
		return { transport };
	}
	/** The opening connection's own controls of its browser (`browser.remoteControl`, 1.67). */
	control(owner: Connection, id: string, command: BrowserControl): Promise<BrowserControlResult> {
		const session = this.sessions.get(id);
		if (!session || session.owner !== owner || session.closed || !session.ready || !session.process)
			throw new PierProtocolError("NOT_FOUND", "远程浏览器连接已关闭");
		if (!session.process.control) throw new PierProtocolError("UNSUPPORTED", "这个远程浏览器无法控制");
		return session.process.control(command);
	}
	private closeSession(session: Session): Promise<void> {
		if (session.closing) return session.closing;
		session.closed = true;
		if (session.ready && !session.owner.isClosed)
			session.owner.send({ type: "evt", event: { type: "browser.remoteClosed", browserId: session.id } });
		this.controllers.detach(session.id);
		session.closing = Promise.resolve()
			.then(async () => {
				await session.starting?.catch(() => {});
				await session.process?.close();
			})
			.catch(() => {})
			.finally(() => {
				this.sessions.delete(session.id);
				this.closing.delete(session.closing as Promise<void>);
			});
		this.closing.add(session.closing);
		session.abort.abort();
		return session.closing;
	}
	async close(owner: Connection, id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session || session.owner !== owner) return false;
		await this.closeSession(session);
		return true;
	}
	connectionClosed(owner: Connection): void {
		for (const session of this.sessions.values()) if (session.owner === owner) void this.closeSession(session);
	}
	async shutdown(): Promise<void> {
		for (const session of this.sessions.values()) void this.closeSession(session);
		await Promise.all(this.closing);
		await this.installer.shutdown();
	}
}
