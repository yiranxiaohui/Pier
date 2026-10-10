#!/usr/bin/env node
/** Verify native MCP and codemode in the actual packaged Host using an isolated local model. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (!process.argv[2]) throw new Error("Usage: smoke-mcp.mjs <pier-host executable>");
// Resolve bundled resources before launching the Host in the isolated test directory.
const packageDir = process.env.PI_PACKAGE_DIR ? resolve(process.env.PI_PACKAGE_DIR) : undefined;
const root = mkdtempSync(join(tmpdir(), "pier-mcp-smoke-"));
const agent = join(root, "agent");
mkdirSync(agent);
const fixture = fileURLToPath(new URL("../test/fixtures/mcp-server.mjs", import.meta.url));
let exposure = "direct";
let called = false;
let sawResult = false;
let toolResult = "";
const model = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const request = JSON.parse(body);
	if (called) {
		toolResult = request.messages
			.filter((m) => m.role === "tool")
			.map((m) => m.content)
			.join("\n");
		sawResult = toolResult.includes("echo:packaged");
	}
	const tool = exposure === "direct" ? "mcp__demo__echo" : "codemode";
	const args =
		exposure === "direct" ? { text: "packaged" } : { code: "text(await tools.mcp__demo__echo({text:'packaged'}))" };
	const delta = called
		? { role: "assistant", content: "done" }
		: {
				role: "assistant",
				tool_calls: [
					{ index: 0, id: "call-demo", type: "function", function: { name: tool, arguments: JSON.stringify(args) } },
				],
			};
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (value, finish) =>
		`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
	res.end(`${chunk(delta, null)}${chunk({}, called ? "stop" : "tool_calls")}data: [DONE]\n\n`);
	called = true;
});
const timeout = async (promise, label) => {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), 30_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
let child;
let socket;
try {
	await new Promise((ready) => model.listen(0, "127.0.0.1", ready));
	writeFileSync(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				smoke: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
					apiKey: "local-test-only",
					models: [{ id: "smoke", name: "Smoke" }],
				},
			},
		}),
	);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "smoke", defaultModel: "smoke" }));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	child = spawn(
		resolve(process.argv[2]),
		["--watch-stdin", "--no-login-shell-path", "--pier-dir", join(root, "pier")],
		{
			cwd: root,
			stdio: ["pipe", "pipe", "ignore"],
			env: {
				...process.env,
				...(packageDir ? { PI_PACKAGE_DIR: packageDir } : {}),
				PI_CODING_AGENT_DIR: agent,
				PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
				CLAUDE_CONFIG_DIR: join(root, "claude"),
				CODEX_HOME: join(root, "codex"),
			},
		},
	);
	const exit = new Promise((done) => child.once("exit", done));
	const lines = createInterface({ input: child.stdout });
	const ready = JSON.parse(
		await timeout(
			new Promise((done, reject) => {
				lines.once("line", done);
				child.once("exit", () => reject(new Error("Host exited before readiness")));
			}),
			"readiness",
		),
	);
	socket = new WebSocket(ready.url);
	await timeout(
		new Promise((done, reject) => {
			socket.onopen = done;
			socket.onerror = reject;
		}),
		"WebSocket",
	);
	const pending = new Map();
	let nextId = 1;
	let settled;
	socket.onmessage = ({ data }) => {
		const frame = JSON.parse(String(data));
		if (frame.type === "res") {
			const entry = pending.get(frame.id);
			pending.delete(frame.id);
			if (frame.ok) entry?.resolve(frame.result);
			else entry?.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
		} else if (frame.event?.type === "agent_settled") settled?.();
	};
	const request = (method, params) =>
		timeout(
			new Promise((resolve, reject) => {
				const id = String(nextId++);
				pending.set(id, { resolve, reject });
				socket.send(JSON.stringify({ type: "req", id, method, params }));
			}),
			method,
		);
	await request("host.hello", {
		protocolVersion: ready.protocolVersion,
		client: { name: "mcp-smoke", version: "0" },
		token: ready.token,
	});
	const { workspace: ws } = await request("workspace.add", { path: workspace });
	await request("workspace.setPolicy", { workspaceId: ws.id, policy: "auto" });
	let server;
	for (exposure of ["direct", "codemode"]) {
		server = await request("mcp.save", {
			runtime: "pi",
			scope: "user",
			name: "demo",
			config: { command: process.execPath, args: [fixture], exposure },
			...(server ? { expectedRevision: server.revision } : { create: true }),
		});
		if (!(await request("mcp.test", { runtime: "pi", scope: "user", name: "demo" })).ok)
			throw new Error("MCP connection failed");
		const { session } = await request("session.create", { workspaceId: ws.id });
		await request("session.subscribe", { sessionId: session.id });
		called = false;
		sawResult = false;
		const done = new Promise((resolve) => {
			settled = resolve;
		});
		await request("session.prompt", { sessionId: session.id, text: "Call echo" });
		await timeout(done, exposure);
		if (!sawResult) throw new Error(`Packaged ${exposure} MCP tool failed: ${toolResult}`);
	}
	socket.close();
	child.stdin.end();
	if ((await timeout(exit, "shutdown")) !== 0) throw new Error("Host did not stop cleanly");
	console.log(
		"MCP smoke OK: real stdio handshake, direct tool invocation and codemode invocation in the packaged Host",
	);
} finally {
	socket?.close();
	if (child && child.exitCode === null) child.kill("SIGKILL");
	await new Promise((done) => model.close(done));
	rmSync(root, { recursive: true, force: true });
}
