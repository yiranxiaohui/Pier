/** Bounded, connection-owned TCP streams. Pull reads provide flow control over Pier's channel. */
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { Duplex } from "node:stream";
import type { PierClient } from "@pier/client";
import { PierProtocolError } from "@pier/protocol";
import type { Connection } from "../connection.ts";

export const TUNNEL_CHUNK = 64 * 1024;
const BUFFER_LIMIT = 512 * 1024;
const MAX_STREAMS = 128;

interface Stream {
	owner: Connection;
	socket: Socket;
	chunks: Buffer[];
	bytes: number;
	ended: boolean;
	error?: Error;
	reading: boolean;
	writing?: boolean;
	wake?: () => void;
}

export class HostTunnels {
	private readonly streams = new Map<string, Stream>();

	async open(owner: Connection, host: string, port: number): Promise<{ tunnelId: string }> {
		if (!/^(?:[a-z\d._:-]+)$/i.test(host) || host.includes("%")) {
			throw new PierProtocolError("BAD_REQUEST", "Invalid tunnel host");
		}
		if (this.streams.size >= MAX_STREAMS || [...this.streams.values()].filter((s) => s.owner === owner).length >= 64) {
			throw new PierProtocolError("CONFLICT", "Too many open network streams");
		}
		const tunnelId = randomUUID();
		const socket = createConnection({ host, port, allowHalfOpen: true });
		const stream: Stream = { owner, socket, chunks: [], bytes: 0, ended: false, reading: false };
		this.streams.set(tunnelId, stream);
		socket.on("data", (data: Buffer) => {
			stream.chunks.push(data);
			stream.bytes += data.length;
			if (stream.bytes >= BUFFER_LIMIT) socket.pause();
			stream.wake?.();
		});
		socket.on("end", () => {
			stream.ended = true;
			stream.wake?.();
		});
		socket.on("error", (error) => {
			stream.error = error;
			stream.ended = true;
			stream.wake?.();
		});
		socket.on("close", () => {
			stream.ended = true;
			stream.wake?.();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					socket.destroy();
					reject(new Error("Connection timed out"));
				}, 10_000);
				const done = () => {
					clearTimeout(timer);
					socket.off("error", fail);
					resolve();
				};
				const fail = (error: Error) => {
					clearTimeout(timer);
					socket.off("connect", done);
					reject(error);
				};
				socket.once("connect", done);
				socket.once("error", fail);
			});
			if (owner.isClosed) throw new Error("Connection closed");
			return { tunnelId };
		} catch (error) {
			this.close(owner, tunnelId);
			throw new PierProtocolError(
				"INTERNAL",
				`Cannot connect to service: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	private own(owner: Connection, id: string): Stream {
		const stream = this.streams.get(id);
		if (!stream || stream.owner !== owner) throw new PierProtocolError("NOT_FOUND", "Network stream not found");
		return stream;
	}

	async read(owner: Connection, id: string): Promise<{ data: string; end: boolean }> {
		const stream = this.own(owner, id);
		if (stream.reading) throw new PierProtocolError("CONFLICT", "A read is already pending");
		stream.reading = true;
		try {
			if (!stream.bytes && !stream.ended) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, 25_000);
					function done() {
						clearTimeout(timer);
						stream.wake = undefined;
						resolve();
					}
					stream.wake = done;
				});
			}
			if (!stream.bytes && stream.error) throw new PierProtocolError("INTERNAL", "Network stream failed");
			const chunk = stream.chunks[0];
			let data: Buffer = Buffer.alloc(0);
			if (chunk) {
				data = chunk.subarray(0, TUNNEL_CHUNK);
				if (data.length === chunk.length) stream.chunks.shift();
				else stream.chunks[0] = chunk.subarray(data.length);
				stream.bytes -= data.length;
				if (stream.bytes < BUFFER_LIMIT / 2 && !stream.ended) stream.socket.resume();
			}
			return { data: data.toString("base64"), end: stream.ended && stream.bytes === 0 };
		} finally {
			stream.reading = false;
		}
	}

	async write(owner: Connection, id: string, data: string, end = false): Promise<{ written: number }> {
		const stream = this.own(owner, id);
		if (stream.writing) throw new PierProtocolError("CONFLICT", "A write is already pending");
		if (data && (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0)) {
			throw new PierProtocolError("BAD_REQUEST", "Invalid stream data");
		}
		const bytes = Buffer.from(data, "base64");
		if (bytes.length > TUNNEL_CHUNK) throw new PierProtocolError("BAD_REQUEST", "Stream chunk too large");
		stream.writing = true;
		try {
			if (bytes.length)
				await new Promise<void>((resolve, reject) => {
					stream.socket.write(bytes, (error) => (error ? reject(error) : resolve()));
				});
			if (end) stream.socket.end();
			return { written: bytes.length };
		} finally {
			stream.writing = false;
		}
	}

	close(owner: Connection, id: string): boolean {
		const stream = this.streams.get(id);
		if (!stream || stream.owner !== owner) return false;
		this.streams.delete(id);
		stream.ended = true;
		stream.chunks = [];
		stream.bytes = 0;
		stream.wake?.();
		stream.socket.destroy();
		return true;
	}

	connectionClosed(owner: Connection): void {
		for (const [id, stream] of this.streams) if (stream.owner === owner) this.close(owner, id);
	}
	shutdown(): void {
		for (const [id, stream] of this.streams) this.close(stream.owner, id);
	}
}

/** A normal Node stream backed by the paired host's TCP socket, with Node backpressure in both directions. */
export class RemoteStream extends Duplex {
	private reading = false;
	private constructor(
		private readonly client: PierClient,
		private readonly tunnelId: string,
	) {
		super({ allowHalfOpen: true, highWaterMark: TUNNEL_CHUNK });
	}
	static async open(client: PierClient, host: string, port: number): Promise<RemoteStream> {
		const { tunnelId } = await client.request("tunnel.open", { host, port });
		return new RemoteStream(client, tunnelId);
	}
	override _read(): void {
		if (this.reading || this.destroyed) return;
		this.reading = true;
		void (async () => {
			try {
				while (!this.destroyed) {
					const result = await this.client.request("tunnel.read", { tunnelId: this.tunnelId }, { timeoutMs: 35_000 });
					const more = result.data ? this.push(Buffer.from(result.data, "base64")) : true;
					if (result.end) {
						this.push(null);
						return;
					}
					if (!more) return;
				}
			} catch (error) {
				if (!this.destroyed) this.destroy(error instanceof Error ? error : new Error(String(error)));
			} finally {
				this.reading = false;
			}
		})();
	}
	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		void (async () => {
			for (let offset = 0; offset < chunk.length; offset += TUNNEL_CHUNK) {
				await this.client.request("tunnel.write", {
					tunnelId: this.tunnelId,
					data: chunk.subarray(offset, offset + TUNNEL_CHUNK).toString("base64"),
				});
			}
		})().then(
			() => callback(),
			(error) => callback(error),
		);
	}
	override _final(callback: (error?: Error | null) => void): void {
		void this.client.request("tunnel.write", { tunnelId: this.tunnelId, data: "", end: true }).then(
			() => callback(),
			(error) => callback(error),
		);
	}
	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		void this.client.request("tunnel.close", { tunnelId: this.tunnelId }).catch(() => {});
		callback(error);
	}
}
