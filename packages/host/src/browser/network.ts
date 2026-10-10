import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer, type Server } from "node:net";
import type { Duplex } from "node:stream";
import type { PierClient } from "@pier/client";
import { RemoteStream } from "./tunnels.ts";

export function webUrl(raw: string): URL {
	const url = new URL(raw);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("请输入不带用户名和密码的 HTTP 或 HTTPS 地址");
	}
	return url;
}
function hostname(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "");
}

export interface BrowserNetwork {
	port: number;
	close(): void;
}

/** A listener lives only on loopback; no development service or proxy is exposed to the LAN. */
async function listen(server: Server, sockets: Set<Duplex>, port = 0): Promise<BrowserNetwork> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Cannot start browser network listener");
	return {
		port: address.port,
		close: () => {
			server.close();
			for (const socket of sockets) socket.destroy();
			sockets.clear();
		},
	};
}

function track(sockets: Set<Duplex>, socket: Duplex): void {
	sockets.add(socket);
	socket.once("close", () => sockets.delete(socket));
	// Network errors terminate a stream; they must not crash the host.
	socket.on("error", () => {});
}
function bridge(a: Duplex, b: Duplex): void {
	a.once("error", () => b.destroy());
	b.once("error", () => a.destroy());
	a.once("close", () => b.destroy());
	b.once("close", () => a.destroy());
	a.pipe(b).pipe(a);
}

export async function forwardService(client: PierClient, url: URL): Promise<BrowserNetwork> {
	return forwardTcp(client, hostname(url), Number(url.port || (url.protocol === "https:" ? 443 : 80)));
}

/** Raw TCP forwarding is shared by browser previews and independent port mappings. */
export async function forwardTcp(
	client: PierClient,
	host: string,
	port: number,
	localPort = 0,
	onError?: (message: string | undefined) => void,
): Promise<BrowserNetwork> {
	const sockets = new Set<Duplex>();
	let closed = false;
	const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
		if (closed || sockets.size >= 128) {
			socket.destroy();
			return;
		}
		track(sockets, socket);
		socket.pause();
		void RemoteStream.open(client, host, port).then(
			(remote) => {
				track(sockets, remote);
				if (closed || socket.destroyed) {
					remote.destroy();
					return;
				}
				onError?.(undefined);
				bridge(socket, remote);
				socket.resume();
			},
			() => {
				onError?.("无法连接远程端口，请确认服务正在监听且连接正常");
				socket.destroy();
			},
		);
	});
	const network = await listen(server, sockets, localPort);
	return {
		...network,
		close() {
			closed = true;
			network.close();
		},
	};
}

/** HTTP and CONNECT forwarding. DNS and destination TCP connections run on the paired host. */
export async function remoteProxy(client: PierClient): Promise<BrowserNetwork> {
	const sockets = new Set<Duplex>();
	let closed = false;
	const open = async (url: URL) => {
		const remote = await RemoteStream.open(
			client,
			hostname(url),
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
		);
		track(sockets, remote);
		if (closed) {
			remote.destroy();
			throw new Error("Proxy closed");
		}
		return remote;
	};
	const server = createHttpServer(async (req, res) => {
		let remote: RemoteStream | undefined;
		try {
			const url = webUrl(req.url ?? "");
			if (url.protocol !== "http:") throw new Error("Use CONNECT for HTTPS");
			remote = await open(url);
			if (req.destroyed || res.destroyed) {
				remote.destroy();
				return;
			}
			const headers: import("node:http").OutgoingHttpHeaders = { ...req.headers, host: url.host };
			delete headers["proxy-authorization"];
			delete headers["proxy-connection"];
			const upstream = httpRequest(
				{
					hostname: hostname(url),
					port: url.port || 80,
					path: url.pathname + url.search,
					method: req.method,
					headers,
					agent: false,
					createConnection: () => remote as RemoteStream,
				},
				(response) => {
					res.writeHead(response.statusCode ?? 502, response.headers);
					response.pipe(res);
				},
			);
			upstream.on("error", () => {
				if (!res.headersSent) res.writeHead(502);
				res.end("Remote service unavailable");
			});
			res.once("close", () => {
				upstream.destroy();
				remote?.destroy();
			});
			req.pipe(upstream);
		} catch {
			remote?.destroy();
			if (!res.headersSent) res.writeHead(502);
			res.end("Remote service unavailable");
		}
	});
	server.on("connection", (socket) => track(sockets, socket));
	server.on("clientError", (_error, socket) => socket.destroy());
	server.on("connect", (req, socket, head) => {
		void (async () => {
			try {
				const url = webUrl(`https://${req.url ?? ""}`);
				if (url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid CONNECT target");
				const remote = await open(url);
				if (socket.destroyed) {
					remote.destroy();
					return;
				}
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) remote.write(head);
				bridge(socket, remote);
			} catch {
				socket.destroy();
			}
		})();
	});
	// Plain ws:// upgrades are also forwarded, so development hot reload works through the proxy.
	server.on("upgrade", (req, socket, head) => {
		void (async () => {
			try {
				const url = webUrl((req.url ?? "").replace(/^ws:/i, "http:"));
				const remote = await open(url);
				if (socket.destroyed) {
					remote.destroy();
					return;
				}
				const headers: import("node:http").OutgoingHttpHeaders = { ...req.headers, host: url.host };
				delete headers["proxy-authorization"];
				delete headers["proxy-connection"];
				remote.write(
					`${req.method} ${url.pathname + url.search} HTTP/${req.httpVersion}\r\n${Object.entries(headers)
						.flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`))
						.join("\r\n")}\r\n\r\n`,
				);
				if (head.length) remote.write(head);
				bridge(socket, remote);
			} catch {
				socket.destroy();
			}
		})();
	});
	const network = await listen(server as unknown as Server, sockets);
	return {
		...network,
		close() {
			closed = true;
			network.close();
		},
	};
}
