import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerInfo, McpTestResult } from "@pier/protocol";
import { validateMcpConfig } from "./mcp.ts";
import { object, strings } from "./resource-files.ts";

function expand(value: string, runtime: McpServerInfo["runtime"]): string {
	if (runtime === "codex") return value;
	// Shell-valued pi secrets and native OAuth remain the agent's responsibility.
	if (runtime === "pi" && value.startsWith("!")) throw new Error("Native secret resolver required");
	return value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
		(_match, name: string, fallback: string | undefined) => {
			const resolved = process.env[name] ?? fallback;
			if (resolved === undefined) throw new Error("Missing environment variable");
			return resolved;
		},
	);
}

export async function connectMcp(server: McpServerInfo, cwd?: string): Promise<{ client: Client; tools: Tool[] }> {
	validateMcpConfig(server.runtime, server.config);
	const config = server.config;
	const client = new Client({ name: "pier", version: "1.0.0" });
	let transport: Transport;
	if (typeof config.command === "string") {
		const env = getDefaultEnvironment();
		for (const entry of Array.isArray(config.env_vars) ? config.env_vars : []) {
			const name = typeof entry === "string" ? entry : object(entry).name;
			if (typeof entry !== "string" && object(entry).source === "remote") throw new Error("Remote executor required");
			if (typeof name === "string" && process.env[name] !== undefined) env[name] = process.env[name];
		}
		for (const [name, value] of Object.entries(object(config.env)))
			if (typeof value === "string") env[name] = expand(value, server.runtime);
		transport = new StdioClientTransport({
			command: expand(config.command, server.runtime),
			args: strings(config.args).map((value) => expand(value, server.runtime)),
			env,
			cwd: typeof config.cwd === "string" ? config.cwd : cwd,
			stderr: "ignore",
		});
	} else {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(object(config.headers ?? config.http_headers)))
			if (typeof value === "string") headers[name] = expand(value, server.runtime);
		for (const [name, value] of Object.entries(object(config.env_http_headers)))
			if (typeof value === "string" && process.env[value] !== undefined) headers[name] = process.env[value];
		if (typeof config.bearer_token_env_var === "string" && process.env[config.bearer_token_env_var])
			headers.Authorization = `Bearer ${process.env[config.bearer_token_env_var]}`;
		const url = new URL(expand(String(config.url), server.runtime));
		const fetchWithTimeout: typeof fetch = (input, init) =>
			fetch(input, {
				...init,
				signal: init?.signal
					? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
					: AbortSignal.timeout(10_000),
			});
		transport =
			config.type === "sse"
				? new SSEClientTransport(url, { requestInit: { headers }, fetch: fetchWithTimeout })
				: new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: fetchWithTimeout });
	}
	try {
		await client.connect(transport, { timeout: 10_000 });
		const tools: Tool[] = [];
		if (client.getServerCapabilities()?.tools) {
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000 });
				tools.push(...page.tools);
				cursor = page.nextCursor;
				if (++pages > 20 || tools.length > 2000) throw new Error("Too many MCP tools");
			} while (cursor);
		}
		return { client, tools };
	} catch (error) {
		await client.close().catch(() => undefined);
		await transport.close().catch(() => undefined);
		throw error;
	}
}

export async function testMcp(server: McpServerInfo, cwd?: string): Promise<McpTestResult> {
	try {
		const { client, tools } = await connectMcp(server, cwd);
		await client.close();
		return { ok: true, tools: tools.map((t) => ({ name: t.name })), message: `连接成功，发现 ${tools.length} 个工具` };
	} catch {
		return { ok: false, tools: [], message: "连接失败：请检查命令、网络、凭据或服务器是否需要 OAuth 登录" };
	}
}
