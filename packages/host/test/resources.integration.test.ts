import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "@decimalturn/toml-patch";
import type { PierClient } from "@pier/client";
import { LOCAL_ONLY_METHODS, type ResourceRuntime, type UiRequest, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiManagedSession } from "../src/pi/pi-session.ts";
import {
	fauxAssistantMessage,
	fauxToolCall,
	lastToolResultText,
	Recorder,
	startTestHost,
	type TestHost,
} from "./helpers.ts";

const body = "---\nname: demo\ndescription: Demo skill\n---\n\nUse the demo.\n";
const runtimes: ResourceRuntime[] = ["pi", "claude-code", "codex"];
const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

describe("unified Skills and MCP", () => {
	let root: string;
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let claude: string;
	let codex: string;
	let http: Server | undefined;
	beforeEach(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pier-resources-")));
		claude = join(root, ".claude");
		codex = join(root, ".codex");
		t = await startTestHost({
			fileSettings: true,
			resourceHome: root,
			agentConfigDirs: { "claude-code": claude, codex },
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
		if (http) {
			const server = http;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			http = undefined;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("allows paired clients to manage resources without making mutations local-only", () => {
		for (const method of [
			"skills.list",
			"skills.save",
			"skills.import",
			"skills.delete",
			"mcp.list",
			"mcp.save",
			"mcp.test",
		] as const)
			expect(LOCAL_ONLY_METHODS.has(method)).toBe(false);
	});
	it.each(runtimes)("creates, disables, edits and deletes %s skills while preserving assets", async (runtime) => {
		const created = await client.request("skills.save", {
			runtime,
			scope: "project",
			workspaceId: workspace.id,
			name: "demo",
			text: body,
		});
		const path = created.skill.path;
		mkdirSync(join(dirname(path), "scripts"));
		writeFileSync(join(dirname(path), "scripts", "helper.js"), "keep");
		await client.request("skills.setEnabled", { runtime, workspaceId: workspace.id, path, enabled: false });
		expect(
			(await client.request("skills.list", { runtime, workspaceId: workspace.id })).items.find((s) => s.path === path)
				?.enabled,
		).toBe(false);
		await client.request("skills.setEnabled", { runtime, workspaceId: workspace.id, path, enabled: true });
		const edited = await client.request("skills.save", {
			runtime,
			scope: "project",
			workspaceId: workspace.id,
			name: "demo",
			path,
			text: `${body}Updated.\n`,
			expectedRevision: created.revision,
		});
		expect(readFileSync(join(dirname(path), "scripts", "helper.js"), "utf8")).toBe("keep");
		await expect(
			client.request("skills.save", {
				runtime,
				scope: "project",
				workspaceId: workspace.id,
				name: "demo",
				path,
				text: body,
				expectedRevision: created.revision,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await client.request("skills.delete", {
			runtime,
			workspaceId: workspace.id,
			path,
			expectedRevision: edited.revision,
		});
		expect(existsSync(path)).toBe(false);
		const trashDir = join(t.host.pierDir, "trash", runtime === "pi" ? "extensions" : "skills");
		expect(readdirSync(trashDir).length).toBeGreaterThan(0);
	});
	it.each(runtimes)("imports a %s skill directory with scripts and refuses collisions", async (runtime) => {
		const source = join(root, "source");
		mkdirSync(join(source, "assets"), { recursive: true });
		writeFileSync(join(source, "SKILL.md"), body);
		writeFileSync(join(source, "assets", "reference.txt"), "asset");
		const doc = await client.request("skills.import", { runtime, scope: "user", sourcePath: source });
		expect(readFileSync(join(dirname(doc.skill.path), "assets", "reference.txt"), "utf8")).toBe("asset");
		await expect(client.request("skills.import", { runtime, scope: "user", sourcePath: source })).rejects.toMatchObject(
			{ code: "CONFLICT" },
		);
		expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(body);
	});
	it("refuses undiscovered paths, invalid skills, absent workspaces and symlink mutations", async () => {
		await expect(client.request("skills.read", { runtime: "codex", path: join(root, "secret") })).rejects.toMatchObject(
			{ code: "NOT_FOUND" },
		);
		await expect(
			client.request("skills.save", { runtime: "codex", scope: "project", name: "demo", text: body }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client.request("skills.save", { runtime: "codex", scope: "user", name: "demo", text: "no frontmatter" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const source = join(root, "external");
		mkdirSync(source);
		writeFileSync(join(source, "SKILL.md"), body);
		mkdirSync(join(claude, "skills"), { recursive: true });
		symlinkSync(source, join(claude, "skills", "linked"), "dir");
		const linked = (await client.request("skills.list", { runtime: "claude-code" })).items[0];
		if (!linked) throw new Error("Expected the symlinked skill to be listed");
		expect(linked).toMatchObject({ editable: false, deletable: false });
		await expect(client.request("skills.delete", { runtime: "claude-code", path: linked.path })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(existsSync(join(source, "SKILL.md"))).toBe(true);
	});
	it.each(runtimes)("preserves unrelated config while managing %s MCP servers", async (runtime) => {
		const configPath =
			runtime === "pi"
				? join(t.host.env.agentDir, "mcp.json")
				: runtime === "codex"
					? join(codex, "config.toml")
					: join(root, ".claude.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			runtime === "codex" ? '# keep comment\nmodel = "my-model"\n' : JSON.stringify({ keep: { nested: 42 } }),
		);
		const saved = await client.request("mcp.save", {
			runtime,
			scope: "user",
			name: "demo",
			create: true,
			config: {
				command: process.execPath,
				args: [fixture],
				env: { PIER_MCP_TEST_MARKER: join(root, "marker") },
				startup_timeout_sec: 20,
			},
		});
		await expect(
			client.request("mcp.save", { runtime, scope: "user", name: "demo", create: true, config: { command: "other" } }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const disabled = await client.request("mcp.setEnabled", {
			runtime,
			scope: "user",
			name: "demo",
			enabled: false,
			expectedRevision: saved.revision,
		});
		expect(disabled.enabled).toBe(false);
		expect(disabled.config.startup_timeout_sec).toBe(20);
		await expect(
			client.request("mcp.delete", { runtime, scope: "user", name: "demo", expectedRevision: saved.revision }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const enabled = await client.request("mcp.setEnabled", {
			runtime,
			scope: "user",
			name: "demo",
			enabled: true,
			expectedRevision: disabled.revision,
		});
		expect(enabled.enabled).toBe(true);
		await client.request("mcp.delete", { runtime, scope: "user", name: "demo", expectedRevision: enabled.revision });
		const text = readFileSync(configPath, "utf8");
		if (runtime === "codex") {
			expect(text).toContain("# keep comment");
			expect(parseToml(text).model).toBe("my-model");
		} else expect(JSON.parse(text).keep).toEqual({ nested: 42 });
	});
	it("keeps same-named Claude user and local servers separate when disabled", async () => {
		const user = await client.request("mcp.save", {
			runtime: "claude-code",
			scope: "user",
			name: "demo",
			config: { command: "user-command" },
			create: true,
		});
		const local = await client.request("mcp.save", {
			runtime: "claude-code",
			scope: "local",
			workspaceId: workspace.id,
			name: "demo",
			config: { command: "local-command" },
			create: true,
		});
		await client.request("mcp.setEnabled", {
			runtime: "claude-code",
			scope: "user",
			name: "demo",
			enabled: false,
			expectedRevision: user.revision,
		});
		await client.request("mcp.setEnabled", {
			runtime: "claude-code",
			scope: "local",
			workspaceId: workspace.id,
			name: "demo",
			enabled: false,
			expectedRevision: local.revision,
		});
		const list = await client.request("mcp.list", { runtime: "claude-code", workspaceId: workspace.id });
		expect(list.items.map((s) => [s.scope, s.config.command, s.enabled])).toEqual([
			["user", "user-command", false],
			["local", "local-command", false],
		]);
	});
	it("preserves a pi project's enablement-only override without copying global credentials", async () => {
		await client.request("mcp.save", {
			runtime: "pi",
			scope: "user",
			name: "demo",
			config: {
				command: process.execPath,
				args: [fixture],
				exposure: "deferred",
				env: { TOKEN: "sample-private-value" },
			},
			create: true,
		});
		const project = await client.request("mcp.save", {
			runtime: "pi",
			scope: "project",
			workspaceId: workspace.id,
			name: "demo",
			config: {},
			enabled: false,
			create: true,
		});
		const merged = t.host.mcp.piConfig(workspace.path).servers[0];
		expect(merged?.config).toMatchObject({ command: process.execPath, enabled: false, exposure: "deferred" });
		expect(project.config).toEqual({ enabled: false });
		expect(readFileSync(project.path, "utf8")).not.toContain("sample-private-value");
		const enabled = await client.request("mcp.setEnabled", {
			runtime: "pi",
			scope: "project",
			workspaceId: workspace.id,
			name: "demo",
			enabled: true,
			expectedRevision: project.revision,
		});
		expect(enabled.config.command).toBeUndefined();
		expect(
			(await client.request("mcp.test", { runtime: "pi", scope: "project", workspaceId: workspace.id, name: "demo" }))
				.ok,
		).toBe(true);
	});
	it("preserves pi codemode precedence and rejects unsafe manual project overrides", () => {
		const global = join(t.host.env.agentDir, "mcp.json");
		const project = join(workspace.path, ".pi", "mcp.json");
		mkdirSync(dirname(project), { recursive: true });
		writeFileSync(
			global,
			JSON.stringify({
				autoEnableCodemode: false,
				mcpServers: {
					demo: { url: "https://example.com/mcp", type: "streamable-http", exposure: "codemode-deferred" },
				},
			}),
		);
		expect(t.host.mcp.piConfig(workspace.path)).toMatchObject({
			autoEnableCodemode: false,
			servers: [{ config: { exposure: "codemode" } }],
		});
		writeFileSync(
			project,
			JSON.stringify({ autoEnableCodemode: true, mcpServers: { demo: { headers: { Authorization: "sample" } } } }),
		);
		const merged = t.host.mcp.piConfig(workspace.path);
		expect(merged.autoEnableCodemode).toBe(true);
		expect(merged.errors).toHaveLength(1);
		expect(merged.servers[0]?.config).not.toHaveProperty("headers");
	});
	it("does not change Claude MCP sources when settings are invalid or globally reject the server", async () => {
		const request = {
			runtime: "claude-code" as const,
			scope: "project" as const,
			workspaceId: workspace.id,
			name: "demo",
			config: { command: "node" },
			create: true,
		};
		mkdirSync(claude, { recursive: true });
		const settings = join(claude, "settings.json");
		writeFileSync(settings, '{"disabledMcpjsonServers":["demo"]}');
		await expect(client.request("mcp.save", request)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(existsSync(join(workspace.path, ".mcp.json"))).toBe(false);
		expect(JSON.parse(readFileSync(settings, "utf8")).disabledMcpjsonServers).toEqual(["demo"]);
		writeFileSync(settings, "{");
		await expect(client.request("mcp.save", request)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(existsSync(join(workspace.path, ".mcp.json"))).toBe(false);
	});
	it("clears only Claude's selected project disable state while retaining server definitions", async () => {
		const path = join(root, ".claude.json");
		writeFileSync(
			path,
			JSON.stringify({
				projects: {
					[workspace.path]: { disabledMcpServers: ["demo", "other"] },
					elsewhere: { disabledMcpServers: ["demo"] },
				},
			}),
		);
		const saved = await client.request("mcp.save", {
			runtime: "claude-code",
			scope: "local",
			workspaceId: workspace.id,
			name: "demo",
			config: { command: "node" },
			create: true,
		});
		expect(saved.enabled).toBe(true);
		const projects = JSON.parse(readFileSync(path, "utf8")).projects;
		expect(projects[workspace.path]).toMatchObject({
			disabledMcpServers: ["other"],
			mcpServers: { demo: { command: "node" } },
		});
		expect(projects.elsewhere.disabledMcpServers).toEqual(["demo"]);
	});
	it("preserves symlinked JSON configuration files", async () => {
		const actual = join(root, "mcp-config.json");
		writeFileSync(actual, '{"keep":true}');
		const path = join(t.host.env.agentDir, "mcp.json");
		symlinkSync(actual, path, "file");
		await client.request("mcp.save", {
			runtime: "pi",
			scope: "user",
			name: "demo",
			config: { command: "node" },
			create: true,
		});
		expect(JSON.parse(readFileSync(actual, "utf8"))).toMatchObject({
			keep: true,
			mcpServers: { demo: { command: "node" } },
		});
	});
	it("does not overwrite invalid MCP config or silently accept invalid transports", async () => {
		mkdirSync(codex);
		const path = join(codex, "config.toml");
		writeFileSync(path, "invalid = [");
		expect((await client.request("mcp.list", { runtime: "codex" })).errors).toHaveLength(1);
		await expect(
			client.request("mcp.save", {
				runtime: "codex",
				scope: "user",
				name: "demo",
				config: { command: "node" },
				create: true,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(readFileSync(path, "utf8")).toBe("invalid = [");
		await expect(
			client.request("mcp.save", {
				runtime: "pi",
				scope: "user",
				name: "demo",
				config: { command: "node", url: "https://example.com" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client.request("mcp.save", {
				runtime: "codex",
				scope: "user",
				name: "demo",
				config: { type: "sse", url: "https://example.com" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client.request("mcp.save", {
				runtime: "pi",
				scope: "user",
				name: "demo",
				config: { type: "sse", url: "https://example.com" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client.request("mcp.save", { runtime: "pi", scope: "user", name: "constructor", config: { command: "node" } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const piPath = join(t.host.env.agentDir, "mcp.json");
		writeFileSync(piPath, '{"mcpServers":[]}');
		await expect(
			client.request("mcp.save", { runtime: "pi", scope: "user", name: "demo", config: { command: "node" } }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(readFileSync(piPath, "utf8")).toBe('{"mcpServers":[]}');
	});
	it("tests a real stdio MCP connection and returns a sanitized failure", async () => {
		await client.request("mcp.save", {
			runtime: "pi",
			scope: "user",
			name: "demo",
			config: { command: process.execPath, args: [fixture] },
			create: true,
		});
		expect(await client.request("mcp.test", { runtime: "pi", scope: "user", name: "demo" })).toMatchObject({
			ok: true,
			tools: [{ name: "echo" }],
		});
		await client.request("mcp.save", {
			runtime: "pi",
			scope: "user",
			name: "broken",
			config: { command: "pier-nonexistent-command", env: { SECRET: "do-not-display" } },
			create: true,
		});
		const failed = await client.request("mcp.test", { runtime: "pi", scope: "user", name: "broken" });
		expect(failed.ok).toBe(false);
		expect(JSON.stringify(failed)).not.toContain("do-not-display");
	});
	it("tests Streamable HTTP with configured headers", async () => {
		let header: string | string[] | undefined;
		http = createServer((req, res) => {
			header = req.headers["x-test"];
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			let text = "";
			req.on("data", (chunk) => {
				text += chunk;
			});
			req.on("end", () => {
				const request = JSON.parse(text);
				if (request.id === undefined) {
					res.writeHead(202).end();
					return;
				}
				const result =
					request.method === "initialize"
						? {
								protocolVersion: request.params.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name: "test", version: "1" },
							}
						: { tools: [] };
				res
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
			});
		});
		const server = http;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (http.address() as { port: number }).port;
		await client.request("mcp.save", {
			runtime: "codex",
			scope: "user",
			name: "web",
			config: { url: `http://127.0.0.1:${port}/mcp`, http_headers: { "X-Test": "sample" } },
			create: true,
		});
		expect((await client.request("mcp.test", { runtime: "codex", scope: "user", name: "web" })).ok).toBe(true);
		expect(header).toBe("sample");
	});
	it.each(["direct", "codemode"])(
		"runs pi %s MCP tools through approval and removes them after disabling",
		async (exposure) => {
			await client.request("mcp.save", {
				runtime: "pi",
				scope: "user",
				name: "demo",
				config: { command: process.execPath, args: [fixture], exposure },
				create: true,
			});
			const { session } = await client.request("session.create", { workspaceId: workspace.id });
			const rec = new Recorder();
			await client.subscribe(session.id, rec.handler);
			const managed = t.host.pool.require(session.id) as PiManagedSession;
			let toolName = "";
			let seenResult = "";
			t.faux.setResponses([
				() => {
					toolName = "mcp__demo__echo";
					return fauxAssistantMessage(
						exposure === "codemode"
							? fauxToolCall("codemode", { code: "text(await tools.mcp__demo__echo({text:'hello'}))" })
							: fauxToolCall(toolName, { text: "hello" }),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					seenResult = lastToolResultText(context);
					return fauxAssistantMessage("done");
				},
			]);
			await client.request("session.prompt", { sessionId: session.id, text: "use echo" });
			const request = (await rec.waitForType("ui.request")).event.request as UiRequest;
			expect(request.approval?.toolName).toBe(toolName);
			await client.request("ui.respond", {
				sessionId: session.id,
				requestId: request.id,
				response: { decision: "allow_once" },
			});
			await rec.waitForType("agent_settled");
			expect(seenResult).toContain("echo:hello");
			const server = (await client.request("mcp.list", { runtime: "pi" })).items[0];
			if (!server) throw new Error("Expected the pi MCP server to be listed");
			await client.request("mcp.setEnabled", {
				runtime: "pi",
				scope: "user",
				name: "demo",
				enabled: false,
				expectedRevision: server.revision,
			});
			let stillPresent = true;
			t.faux.setResponses([
				() => {
					stillPresent = managed.session.getAllTools().some((tool) => tool.name === toolName);
					return fauxAssistantMessage("done");
				},
			]);
			const mark = rec.mark();
			await client.request("session.prompt", { sessionId: session.id, text: "check tools" });
			await rec.waitForType("agent_settled", mark);
			expect(stillPresent).toBe(false);
		},
	);
});
