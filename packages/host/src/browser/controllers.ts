/** Routes workspace browser actions back to the paired computer doing the rendering. */
import { randomUUID } from "node:crypto";
import { type BrowserCommand, type BrowserResult, PierProtocolError } from "@pier/protocol";
import type { Connection } from "../connection.ts";

interface Controller {
	workspaceId: string;
	connection?: Connection;
	run?: (command: BrowserCommand) => Promise<BrowserResult>;
}
interface Pending {
	connection: Connection;
	browserId: string;
	resolve(result: BrowserResult): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export class BrowserControllers {
	private readonly browsers = new Map<string, Controller>();
	private readonly pending = new Map<string, Pending>();

	attach(connection: Connection, workspaceId: string, browserId: string): void {
		if (this.browsers.size >= 64 && !this.browsers.has(browserId))
			throw new PierProtocolError("CONFLICT", "Too many browser controllers");
		const existing = this.browsers.get(browserId);
		if (existing && existing.connection !== connection)
			throw new PierProtocolError("CONFLICT", "Browser already registered");
		this.browsers.set(browserId, { workspaceId, connection });
	}
	attachLocal(workspaceId: string, browserId: string, run: (command: BrowserCommand) => Promise<BrowserResult>): void {
		this.browsers.set(browserId, { workspaceId, run });
	}
	detach(browserId: string, connection?: Connection): boolean {
		const existing = this.browsers.get(browserId);
		if (!existing || existing.connection !== connection) return false;
		this.browsers.delete(browserId);
		for (const [id, pending] of this.pending)
			if (pending.browserId === browserId) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(new PierProtocolError("NOT_FOUND", "Browser disconnected"));
			}
		return true;
	}
	async action(
		workspaceId: string,
		command: BrowserCommand,
		browserId?: string,
		signal?: AbortSignal,
	): Promise<BrowserResult> {
		signal?.throwIfAborted();
		const matches = [...this.browsers].filter(
			([id, c]) => c.workspaceId === workspaceId && (!browserId || id === browserId),
		);
		if (matches.length !== 1)
			throw new PierProtocolError(
				"CONFLICT",
				matches.length
					? "Multiple browsers open: specify browserId"
					: "请先在工作区的「浏览器」中打开独立浏览器并允许 Agent 操作",
			);
		const [id, controller] = matches[0] as [string, Controller];
		if (controller.run) return controller.run(command);
		const connection = controller.connection;
		if (!connection || connection.isClosed) throw new PierProtocolError("NOT_FOUND", "Browser disconnected");
		if (this.pending.size >= 64) throw new PierProtocolError("CONFLICT", "Too many browser commands");
		const requestId = randomUUID();
		return new Promise<BrowserResult>((resolve, reject) => {
			const finish = () => {
				this.pending.delete(requestId);
				signal?.removeEventListener("abort", abort);
			};
			const timer = setTimeout(() => {
				finish();
				reject(new PierProtocolError("CONFLICT", "Browser command timed out"));
			}, 30_000);
			const abort = () => {
				clearTimeout(timer);
				finish();
				reject(new PierProtocolError("CONFLICT", "Browser command cancelled"));
			};
			this.pending.set(requestId, {
				connection,
				browserId: id,
				timer,
				resolve: (result) => {
					finish();
					resolve(result);
				},
				reject: (error) => {
					finish();
					reject(error);
				},
			});
			signal?.addEventListener("abort", abort, { once: true });
			connection.send({ type: "evt", event: { type: "browser.command", browserId: id, requestId, command } });
		});
	}
	respond(connection: Connection, requestId: string, result?: BrowserResult, error?: string): boolean {
		const pending = this.pending.get(requestId);
		if (!pending || pending.connection !== connection) return false;
		clearTimeout(pending.timer);
		if (error) pending.reject(new PierProtocolError("INTERNAL", error));
		else pending.resolve(result ?? {});
		return true;
	}
	connectionClosed(connection: Connection): void {
		for (const [id, controller] of this.browsers) if (controller.connection === connection) this.detach(id, connection);
	}
	shutdown(): void {
		for (const [id, controller] of this.browsers) this.detach(id, controller.connection);
	}
}
