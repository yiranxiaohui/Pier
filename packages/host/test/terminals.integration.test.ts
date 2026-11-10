import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { PierClient } from "@pier/client";
import { type EventFrame, type PairingRequest, type PeerInfo, PROTOCOL_VERSION } from "@pier/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Connection, type RequestHandler } from "../src/connection.ts";
import { PtyTerminals } from "../src/pty-terminals.ts";
import type { AppShell, ShellTerminalHandlers } from "../src/shell.ts";
import {
	SHELL_CAPABILITIES,
	SHELL_REQUEST,
	SHELL_RESPONSE,
	SHELL_TERMINAL,
	SHELL_TERMINAL_EXIT,
	SHELL_TERMINAL_OUTPUT,
	StdioShell,
} from "../src/shell.ts";
import { HostTerminals, MAX_TERMINALS_PER_CONNECTION } from "../src/terminals.ts";
import { fakePtySpawn } from "./fake-pty.ts";
import { Recorder, startTestHost, type TestHost, TOKEN } from "./helpers.ts";

const REMOTE = { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } as const;

const b64 = (text: string) => Buffer.from(text).toString("base64");
const unb64 = (data: string) => Buffer.from(data, "base64").toString();

interface FakePty {
	key: string;
	cwd?: string;
	cols: number;
	rows: number;
	input: string[];
	killed: boolean;
}

/**
 * The desktop app's side of the terminal channel: announces terminals, starts fake shells that
 * greet (before answering the spawn request, like the real app can), echo what is typed, and
 * exit with the code typed as `exit <n>`.
 */
class FakeTerminalShell {
	readonly toHost = new PassThrough();
	readonly fromHost = new PassThrough();
	readonly ptys = new Map<number, FakePty>();
	failSpawn: string | undefined;
	private nextId = 100;
	private buffer = "";

	constructor(announce = true) {
		this.fromHost.setEncoding("utf8");
		this.fromHost.on("data", (chunk: string) => {
			this.buffer += chunk;
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf("\n");
				this.receive(JSON.parse(line) as Record<string, unknown>);
			}
		});
		if (announce) this.send({ type: SHELL_CAPABILITIES, terminals: true });
	}

	send(message: unknown): void {
		this.toHost.write(`${JSON.stringify(message)}\n`);
	}

	output(key: string, text: string): void {
		this.send({ type: SHELL_TERMINAL_OUTPUT, key, data: b64(text) });
	}

	private receive(message: Record<string, unknown>): void {
		if (message.type === SHELL_REQUEST && message.method === "terminal.spawn") {
			if (this.failSpawn) {
				this.send({ type: SHELL_RESPONSE, id: message.id, ok: false, error: this.failSpawn });
				return;
			}
			const params = message.params as { key: string; cwd?: string; cols: number; rows: number };
			const id = this.nextId++;
			this.ptys.set(id, { ...params, input: [], killed: false });
			this.output(params.key, "welcome\r\n");
			this.send({
				type: SHELL_RESPONSE,
				id: message.id,
				ok: true,
				result: { id, shell: "fakesh", cwd: params.cwd ?? "/home/fake" },
			});
			return;
		}
		if (message.type !== SHELL_TERMINAL) return;
		const pty = this.ptys.get(message.id as number);
		if (!pty) return;
		if (message.op === "write") {
			const data = message.data as string;
			pty.input.push(data);
			const exit = /^exit (\d+)\r$/.exec(data);
			if (exit) {
				this.send({ type: SHELL_TERMINAL_EXIT, key: pty.key, code: Number(exit[1]) });
				this.ptys.delete(message.id as number);
			} else {
				this.output(pty.key, `echo:${data}`);
			}
		} else if (message.op === "resize") {
			pty.cols = message.cols as number;
			pty.rows = message.rows as number;
		} else if (message.op === "kill") {
			pty.killed = true;
			this.send({ type: SHELL_TERMINAL_EXIT, key: pty.key, code: null });
		}
	}
}

function outputOf(events: Recorder, terminalId: string, from = 0): string {
	return events.frames
		.slice(from)
		.filter((f) => f.event.type === "terminal.output" && f.event.terminalId === terminalId)
		.map((f) => unb64(f.event.data as string))
		.join("");
}

function exitOf(terminalId: string): (f: EventFrame) => boolean {
	return (f) => f.event.type === "terminal.exit" && f.event.terminalId === terminalId;
}

describe("StdioShell terminals", () => {
	it("attributes output that arrives before the spawn answer and forwards input", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		const output: string[] = [];
		let exit: [number | null, string | undefined] | undefined;
		const terminal = await shell.openTerminal(
			{ cwd: "/tmp", cols: 80, rows: 24 },
			{ output: (data) => output.push(unb64(data)), exit: (code, error) => (exit = [code, error]) },
		);
		expect(terminal).toMatchObject({ shell: "fakesh", cwd: "/tmp" });
		expect(output).toEqual(["welcome\r\n"]);
		terminal.write("ls\r", false);
		await expect.poll(() => output.join("")).toContain("echo:ls\r");
		terminal.resize(100, 30);
		await expect.poll(() => [...fake.ptys.values()][0]?.cols).toBe(100);
		terminal.write("exit 3\r", false);
		await expect.poll(() => exit).toEqual([3, undefined]);
		shell.close();
	});

	it("ends open terminals when the app goes away", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		let exit: [number | null, string | undefined] | undefined;
		await shell.openTerminal(
			{ cols: 80, rows: 24 },
			{ output: () => {}, exit: (code, error) => (exit = [code, error]) },
		);
		fake.toHost.end();
		await expect.poll(() => exit?.[1]).toMatch(/not reachable/);
		expect(shell.terminals).toBe(false);
	});

	it("rejects when the app cannot run terminals or fails to start one", async () => {
		const quiet = new FakeTerminalShell(false);
		const old = new StdioShell(quiet.toHost, quiet.fromHost);
		await expect(old.openTerminal({ cols: 80, rows: 24 }, { output: () => {}, exit: () => {} })).rejects.toThrow(
			/cannot run terminals/,
		);
		old.close();

		const fake = new FakeTerminalShell();
		fake.failSpawn = "无法创建伪终端：boom";
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		await expect(shell.openTerminal({ cols: 80, rows: 24 }, { output: () => {}, exit: () => {} })).rejects.toThrow(
			"无法创建伪终端：boom",
		);
		shell.close();
	});

	it("offers terminals declared at start before the app announces them", async () => {
		// A paired computer can reconnect before the app's capabilities line arrives.
		const quiet = new FakeTerminalShell(false);
		const shell = new StdioShell(quiet.toHost, quiet.fromHost, { terminals: true });
		expect(shell.terminals).toBe(true);
		const output: string[] = [];
		const terminal = await shell.openTerminal(
			{ cols: 80, rows: 24 },
			{ output: (data) => output.push(unb64(data)), exit: () => {} },
		);
		expect(terminal.shell).toBe("fakesh");
		quiet.toHost.end();
		await expect.poll(() => shell.terminals).toBe(false);
	});
});

describe("terminal.* (shells for clients)", () => {
	const hosts: TestHost[] = [];
	const clients: PierClient[] = [];
	afterEach(async () => {
		for (const client of clients.splice(0)) client.close();
		await Promise.all(hosts.splice(0).map((h) => h.close()));
	});

	it("is unsupported without a desktop app or its own terminals", async () => {
		const t = await startTestHost();
		hosts.push(t);
		const client = await t.connect();
		expect(client.host?.terminals).toBeUndefined();
		await expect(client.request("terminal.open", { cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "UNSUPPORTED",
		});
	});

	it("runs its own terminals without a desktop app", async () => {
		const { spawn, children } = fakePtySpawn();
		const t = await startTestHost({ terminals: new PtyTerminals({ spawn, version: "1", env: { SHELL: "/bin/sh" } }) });
		hosts.push(t);
		const client = await t.connect();
		expect(client.host?.terminals).toBe(true);
		const events = new Recorder();
		client.onEvent(events.handler);

		const opened = await client.request("terminal.open", { cwd: t.workspaceDir, cols: 90, rows: 30 });
		expect(opened).toMatchObject({ shell: "sh", cwd: t.workspaceDir });
		const child = children[0];
		expect(child?.options).toMatchObject({ argv0: "-sh", cwd: t.workspaceDir, cols: 90, rows: 30 });
		child?.options.data(new TextEncoder().encode("$ "));
		await expect.poll(() => outputOf(events, opened.terminalId)).toBe("$ ");
		await client.request("terminal.write", { terminalId: opened.terminalId, data: "exit 4\r" });
		expect(child?.writes).toEqual(["exit 4\r"]);

		child?.finish(4);
		child?.options.end();
		const exit = await events.waitFor(exitOf(opened.terminalId));
		expect(exit.event).toEqual({ type: "terminal.exit", terminalId: opened.terminalId, code: 4 });
	});

	it("runs a shell for the connection: output after the answer, input, resize, exit", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		const t = await startTestHost({ shell });
		hosts.push(t);
		const client = await t.connect();
		expect(client.host?.terminals).toBe(true);
		const events = new Recorder();
		client.onEvent(events.handler);

		await expect(client.request("terminal.open", { cwd: "relative", cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		const opened = await client.request("terminal.open", { cwd: t.workspaceDir, cols: 80, rows: 24 });
		expect(opened).toMatchObject({ shell: "fakesh", cwd: t.workspaceDir });
		await expect.poll(() => outputOf(events, opened.terminalId)).toBe("welcome\r\n");

		expect(await client.request("terminal.write", { terminalId: opened.terminalId, data: "pwd\r" })).toEqual({
			written: true,
		});
		await expect.poll(() => outputOf(events, opened.terminalId)).toContain("echo:pwd\r");
		await client.request("terminal.resize", { terminalId: opened.terminalId, cols: 120, rows: 40 });
		await expect.poll(() => [...fake.ptys.values()][0]).toMatchObject({ cols: 120, rows: 40 });

		await client.request("terminal.write", { terminalId: opened.terminalId, data: "exit 7\r" });
		const exit = await events.waitFor(exitOf(opened.terminalId));
		expect(exit.event).toEqual({ type: "terminal.exit", terminalId: opened.terminalId, code: 7 });
		await expect(client.request("terminal.write", { terminalId: opened.terminalId, data: "x" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("sends output the shell printed before the app answered only after the response", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		const t = await startTestHost({ shell });
		hosts.push(t);
		const socket = new WebSocket(t.url);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", () => resolve());
			socket.once("error", reject);
		});
		const frames: Array<{ type: string; id?: string; event?: { type: string } }> = [];
		socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
		const hello = { protocolVersion: PROTOCOL_VERSION, client: { name: "raw", version: "0" }, token: TOKEN };
		socket.send(JSON.stringify({ type: "req", id: "h", method: "host.hello", params: hello }));
		socket.send(JSON.stringify({ type: "req", id: "o", method: "terminal.open", params: { cols: 80, rows: 24 } }));
		await expect.poll(() => frames.some((f) => f.event?.type === "terminal.output")).toBe(true);
		socket.close();
		const response = frames.findIndex((f) => f.type === "res" && f.id === "o");
		const output = frames.findIndex((f) => f.event?.type === "terminal.output");
		expect(response).toBeGreaterThanOrEqual(0);
		expect(output).toBeGreaterThan(response);
	});

	it("keeps terminals private to their connection and hangs them up when it closes", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		const t = await startTestHost({ shell });
		hosts.push(t);
		const owner = await t.connect();
		const other = await t.connect();
		const otherEvents = new Recorder();
		other.onEvent(otherEvents.handler);

		const opened = await owner.request("terminal.open", { cols: 80, rows: 24 });
		await expect(other.request("terminal.write", { terminalId: opened.terminalId, data: "hi" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await other.request("terminal.close", { terminalId: opened.terminalId })).toEqual({ closed: false });

		owner.close();
		await expect.poll(() => [...fake.ptys.values()].every((p) => p.killed)).toBe(true);
		expect(otherEvents.types().filter((type) => type.startsWith("terminal."))).toEqual([]);
	});

	it("limits the terminals of one connection", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		const t = await startTestHost({ shell });
		hosts.push(t);
		const client = await t.connect();
		const ids: string[] = [];
		for (let i = 0; i < MAX_TERMINALS_PER_CONNECTION; i++) {
			ids.push((await client.request("terminal.open", { cols: 80, rows: 24 })).terminalId);
		}
		await expect(client.request("terminal.open", { cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		const events = new Recorder();
		client.onEvent(events.handler);
		// Closing one frees a slot once it ended.
		const first = ids[0] as string;
		expect(await client.request("terminal.close", { terminalId: first })).toEqual({ closed: true });
		await events.waitFor(exitOf(first));
		await client.request("terminal.open", { cols: 80, rows: 24 });
	});

	it("reports terminals the app lost", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		const t = await startTestHost({ shell });
		hosts.push(t);
		const client = await t.connect();
		const events = new Recorder();
		client.onEvent(events.handler);
		const opened = await client.request("terminal.open", { cols: 80, rows: 24 });
		fake.toHost.end();
		const exit = await events.waitFor(exitOf(opened.terminalId));
		expect(exit.event).toMatchObject({ code: null, error: expect.stringMatching(/not reachable/) });
	});

	it("lets a paired computer open a shell here and records it in the audit log", async () => {
		const fake = new FakeTerminalShell();
		const shell = new StdioShell(fake.toHost, fake.fromHost);
		await expect.poll(() => shell.terminals).toBe(true);
		const [a, b] = await Promise.all([
			startTestHost({ peers: { openTimeoutMs: 1000 } }),
			startTestHost({ remote: { ...REMOTE, approvalTimeoutMs: 2000 }, shell }),
		]);
		hosts.push(a, b);
		const aDesktop = await a.connect();
		const bDesktop = await b.connect();
		const bEvents = new Recorder();
		bDesktop.onEvent(bEvents.handler);

		const { uri } = await bDesktop.request("pairing.start");
		void bEvents.waitForType("pairing.request").then((frame) =>
			bDesktop.request("pairing.respond", {
				requestId: (frame.event.request as PairingRequest).id,
				accept: true,
			}),
		);
		const peer: PeerInfo = (await aDesktop.request("peer.pair", { uri }, { timeoutMs: 10_000 })).peer;
		const remote = new PierClient({
			url: `${a.url}/peer/${encodeURIComponent(peer.id)}`,
			token: TOKEN,
			client: { name: "pier-desktop", version: "0.0.0" },
		});
		clients.push(remote);
		const hello = await remote.connect();
		expect(hello.host.terminals).toBe(true);
		const events = new Recorder();
		remote.onEvent(events.handler);

		const opened = await remote.request("terminal.open", { cwd: b.workspaceDir, cols: 80, rows: 24 });
		await expect.poll(() => outputOf(events, opened.terminalId)).toBe("welcome\r\n");
		await remote.request("terminal.write", { terminalId: opened.terminalId, data: "whoami\r" });
		await expect.poll(() => outputOf(events, opened.terminalId)).toContain("echo:whoami\r");
		// The local window of that computer does not see the shell's output.
		expect(bEvents.types().filter((type) => type.startsWith("terminal."))).toEqual([]);

		const audit = readFileSync(join(b.root, "pier", "audit.log"), "utf8");
		expect(audit).toContain('"event":"terminal.open"');
		// Paths are JSON strings in the log (backslashes escaped on Windows).
		expect(audit).toContain(JSON.stringify(b.workspaceDir).slice(1, -1));
		expect(audit).not.toContain("whoami");

		remote.close();
		await expect.poll(() => [...fake.ptys.values()].every((p) => p.killed)).toBe(true);
	});
});

describe("HostTerminals flow control", () => {
	it("pauses a terminal while its connection is backed up and resumes once it drained", async () => {
		const calls: string[] = [];
		let handlers: ShellTerminalHandlers | undefined;
		const shell: AppShell = {
			updateStatus: undefined,
			onUpdateStatus: () => () => {},
			request: () => Promise.reject(new Error("no updater")),
			terminals: true,
			openTerminal: async (_options, h) => {
				handlers = h;
				return {
					shell: "sh",
					cwd: "/",
					write: () => {},
					resize: () => {},
					pause: (paused) => calls.push(paused ? "pause" : "resume"),
					kill: () => h.exit(null),
				};
			},
			close: () => {},
		};
		const sent: string[] = [];
		const transport = { bufferedAmount: 0, send: (data: string) => sent.push(data), close: () => {} };
		const handler: RequestHandler = { handle: () => Promise.reject(new Error("unused")), disconnected: () => {} };
		const connection = new Connection("local", transport, handler);
		connection.authenticated = true;
		const terminals = new HostTerminals(shell, { pauseAt: 1000, resumeAt: 100, pollMs: 5 });

		const { start } = await terminals.open(connection, { cols: 80, rows: 24 });
		start();
		handlers?.output(b64("fast"));
		expect(calls).toEqual([]);

		transport.bufferedAmount = 5000;
		handlers?.output(b64("slow network"));
		handlers?.output(b64("more"));
		expect(calls).toEqual(["pause"]);
		transport.bufferedAmount = 500;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(calls).toEqual(["pause"]);
		transport.bufferedAmount = 50;
		await expect.poll(() => calls).toEqual(["pause", "resume"]);
		expect(sent.filter((frame) => frame.includes("terminal.output")).length).toBe(3);

		// A paused terminal that ends stops polling.
		transport.bufferedAmount = 5000;
		handlers?.output(b64("again"));
		expect(calls).toEqual(["pause", "resume", "pause"]);
		terminals.shutdown();
		transport.bufferedAmount = 0;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(calls).toEqual(["pause", "resume", "pause"]);
	});
});
