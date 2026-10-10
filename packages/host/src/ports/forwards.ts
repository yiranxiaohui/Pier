import { randomUUID } from "node:crypto";
import type { PierClient } from "@pier/client";
import { type MethodParams, PierProtocolError, type PortForward, parseProtocolVersion } from "@pier/protocol";
import { type BrowserNetwork, forwardTcp } from "../browser/network.ts";
import type { Connection } from "../connection.ts";

interface ForwardRecord {
	owner: Connection;
	info: PortForward;
	closed: boolean;
	ready: boolean;
	client?: PierClient;
	network?: BrowserNetwork;
}

/** Each mapping owns a separate paired channel and lives until explicitly closed or disconnected. */
export class LocalPortForwards {
	private readonly records = new Map<string, ForwardRecord>();

	constructor(private readonly connect: (peerId: string) => Promise<PierClient>) {}

	list(owner: Connection): PortForward[] {
		return [...this.records.values()].filter((r) => r.owner === owner && r.ready).map((r) => ({ ...r.info }));
	}

	async open(owner: Connection, params: MethodParams<"portForward.open">): Promise<PortForward> {
		if (this.records.size >= 32) throw new PierProtocolError("CONFLICT", "最多同时创建 32 个端口映射");
		const record: ForwardRecord = {
			owner,
			ready: false,
			closed: false,
			info: {
				id: randomUUID(),
				peerId: params.peerId,
				remoteHost: params.remoteHost,
				remotePort: params.remotePort,
				localHost: "127.0.0.1",
				localPort: params.localPort ?? 0,
			},
		};
		this.records.set(record.info.id, record);
		try {
			record.client = await this.connect(params.peerId);
			const version = parseProtocolVersion(record.client.host?.protocolVersion ?? "");
			if (version?.major !== 1 || version.minor < 37)
				throw new PierProtocolError("UNSUPPORTED", "请先更新远程主机的 Pier（端口映射需要协议 1.37）");
			if (record.closed || owner.isClosed) throw new Error("Connection closed");
			record.client.onState((state) => {
				if (state !== "open") this.closeRecord(record);
			});
			record.network = await forwardTcp(
				record.client,
				params.remoteHost,
				params.remotePort,
				params.localPort,
				(error) => {
					record.info.lastError = error;
				},
			);
			if (record.closed || owner.isClosed) throw new Error("Connection closed");
			record.info.localPort = record.network.port;
			record.ready = true;
			return { ...record.info };
		} catch (error) {
			this.closeRecord(record);
			if (error instanceof PierProtocolError) throw error;
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === "EADDRINUSE")
				throw new PierProtocolError("CONFLICT", `本地端口 ${params.localPort} 已被占用，请选择其他端口`);
			if (code === "EACCES") throw new PierProtocolError("FORBIDDEN", "没有权限监听这个本地端口，请选择其他端口");
			throw new PierProtocolError("INTERNAL", "无法创建端口映射，请检查主机连接和本地端口");
		}
	}

	private closeRecord(record: ForwardRecord): void {
		record.closed = true;
		this.records.delete(record.info.id);
		const { network, client } = record;
		record.network = undefined;
		record.client = undefined;
		network?.close();
		client?.close();
	}

	close(owner: Connection, id: string): boolean {
		const record = this.records.get(id);
		if (!record || record.owner !== owner) return false;
		this.closeRecord(record);
		return true;
	}

	connectionClosed(owner: Connection): void {
		for (const record of this.records.values()) if (record.owner === owner) this.closeRecord(record);
	}

	shutdown(): void {
		for (const record of this.records.values()) this.closeRecord(record);
	}
}
