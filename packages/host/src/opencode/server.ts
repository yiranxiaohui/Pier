import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

/** npm installations can launch the native CLI through a command shim. */
function stop(child: ChildProcess, force = false): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
			if (error) child.kill();
		});
	} else {
		try {
			process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
		} catch {
			/* Already exited. */
		}
	}
}

/** One private server per Host. Workspace paths are passed on each SDK request. */
export class OpenCodeServer {
	private child?: ChildProcess;
	private ready?: Promise<OpencodeClient>;
	private closed = false;

	constructor(
		private readonly executable: () => string | undefined,
		private readonly env?: NodeJS.ProcessEnv,
	) {}

	client(): Promise<OpencodeClient> {
		if (this.closed) throw new Error("OpenCode runtime is closed");
		const executable = this.executable();
		if (!executable) throw new Error("OpenCode executable not found");
		if (!this.ready) {
			const ready = this.start(executable).catch((error) => {
				// A restart may already have replaced this attempt.
				if (this.ready === ready) this.ready = undefined;
				throw error;
			});
			this.ready = ready;
		}
		return this.ready;
	}

	private start(executable: string): Promise<OpencodeClient> {
		const password = randomBytes(32).toString("hex");
		const shell = process.platform === "win32" && /\.(bat|cmd)$/i.test(executable);
		const child = spawn(
			shell ? `"${executable}"` : executable,
			["serve", "--hostname", "127.0.0.1", "--port", "0", "--no-mdns"],
			{
				cwd: homedir(),
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, ...this.env, OPENCODE_SERVER_USERNAME: "pier", OPENCODE_SERVER_PASSWORD: password },
				windowsHide: true,
				detached: process.platform !== "win32",
				shell,
			},
		);
		this.child = child;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				stop(child, true);
				reject(new Error("OpenCode server did not start in time"));
			}, 30_000);
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				const match = /^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)\s*$/.exec(line);
				if (!match) return;
				clearTimeout(timer);
				const authorization = `Basic ${Buffer.from(`pier:${password}`).toString("base64")}`;
				resolve(
					createOpencodeClient({ baseUrl: match[1], headers: { Authorization: authorization }, redirect: "error" }),
				);
			});
			child.once("error", reject);
			child.once("close", (code) => {
				clearTimeout(timer);
				lines.close();
				if (this.child === child) {
					this.child = undefined;
					this.ready = undefined;
				}
				reject(new Error(`OpenCode server exited (code ${code})`));
			});
		});
	}

	/**
	 * Stop the running server so the next `client()` starts a new one, which reads OpenCode's
	 * configuration again. Requests still running on the old server fail.
	 */
	restart(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.ready = undefined;
		return this.stopChild(child);
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.stopChild(this.child);
	}

	private async stopChild(child: ChildProcess | undefined): Promise<void> {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => stop(child, true), 2000);
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			stop(child);
		});
	}
}
