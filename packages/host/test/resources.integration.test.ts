import {
	chmodSync,
	existsSync,
	lstatSync,
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
import { homedir, tmpdir } from "node:os";
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
	it.each([
		{ runtime: "claude-code" as const, directory: ".claude" },
		{ runtime: "codex" as const, directory: ".codex" },
		{ runtime: "codex" as const, directory: ".agents" },
	])("keeps scanning $directory skills past broken links and recovers after repair", async ({ runtime, directory }) => {
		const skills = join(root, directory, "skills");
		const source = join(root, "external");
		const missing = join(root, "missing");
		mkdirSync(join(skills, "normal"), { recursive: true });
		writeFileSync(join(skills, "normal", "SKILL.md"), body);
		mkdirSync(source);
		writeFileSync(join(source, "SKILL.md"), body);
		const broken = [join(skills, "a-broken"), join(skills, "z-broken")];
		for (const path of broken) symlinkSync(missing, path, "dir");
		symlinkSync(source, join(skills, "linked"), "dir");
		const listed = await client.request("skills.list", { runtime });
		expect(listed.items.map((s) => s.path).sort()).toEqual(
			[join(skills, "linked", "SKILL.md"), join(skills, "normal", "SKILL.md")].sort(),
		);
		expect(listed.items.find((s) => s.path === join(skills, "linked", "SKILL.md"))).toMatchObject({
			editable: false,
			deletable: false,
		});
		expect(listed.errors).toHaveLength(2);
		for (const path of broken) {
			expect(listed.errors.some((error) => error.includes(path) && error.includes("目标已失效"))).toBe(true);
			expect(lstatSync(path).isSymbolicLink()).toBe(true);
		}
		// Restoring the shared target must make the skill discoverable on the next refresh.
		mkdirSync(missing);
		writeFileSync(join(missing, "SKILL.md"), body);
		const repaired = await client.request("skills.list", { runtime });
		expect(repaired.errors).toEqual([]);
		expect(repaired.items).toHaveLength(3);
		expect(repaired.items.some((s) => broken.some((path) => s.path === join(path, "SKILL.md")))).toBe(true);
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
	describe("Claude Code plugins", () => {
		const mkt = "local-mkt";
		let cache: string;
		const plugin = (name: string, files: Record<string, string>) => {
			const dir = join(cache, name, "1.0.0");
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(join(dir, path)), { recursive: true });
				writeFileSync(join(dir, path), text);
			}
			return dir;
		};
		const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} from a plugin\n---\n\nBody.\n`;
		const settings = (path: string, value: Record<string, unknown>) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(value));
		};
		let projectSettings: string;
		let localSettings: string;
		beforeEach(() => {
			cache = join(claude, "plugins", "cache", mkt);
			projectSettings = join(t.workspaceDir, ".claude", "settings.json");
			localSettings = join(t.workspaceDir, ".claude", "settings.local.json");
			const kit = plugin("demo-kit", {
				".claude-plugin/plugin.json": JSON.stringify({
					name: "demo-kit",
					version: "1.2.0",
					description: "Demo plugin",
					author: { name: "Pier" },
				}),
				"skills/review/SKILL.md": skill("review"),
				"skills/notes.txt": "not a skill",
				"commands/a.md": "a",
				"commands/sub/b.md": "b",
				"agents/helper.md": "helper",
				"hooks/hooks.json": "{}",
				".mcp.json": JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } } }),
			});
			const project = plugin("proj-kit", {
				".claude-plugin/plugin.json": JSON.stringify({ name: "proj-kit", skills: "./extra/solo" }),
				"extra/solo/skill.md": skill("solo"),
				".mcp.json": JSON.stringify({ tool: { command: "node", args: ["server.js"] } }),
			});
			const other = plugin("other-kit", { "skills/x/SKILL.md": skill("x") });
			const entry = (installPath: string, scope = "user", projectPath?: string) => [
				{ scope, installPath, version: "unknown", ...(projectPath ? { projectPath } : {}) },
			];
			settings(join(claude, "plugins", "installed_plugins.json"), {
				version: 2,
				plugins: {
					[`demo-kit@${mkt}`]: entry(kit),
					[`proj-kit@${mkt}`]: entry(project, "project", t.workspaceDir),
					[`other-kit@${mkt}`]: entry(other, "local", join(root, "elsewhere")),
					[`gone@${mkt}`]: entry(join(cache, "gone", "1.0.0")),
				},
			});
			settings(join(claude, "settings.json"), { enabledPlugins: { [`demo-kit@${mkt}`]: true } });
			settings(projectSettings, { enabledPlugins: { [`proj-kit@${mkt}`]: true } });
		});

		it("lists user installs globally and the workspace's own installs with it", async () => {
			const global = await client.request("plugins.list", { runtime: "claude-code" });
			expect(global.items).toEqual([
				{
					runtime: "claude-code",
					id: `demo-kit@${mkt}`,
					name: "demo-kit",
					marketplace: mkt,
					description: "Demo plugin",
					version: "1.2.0",
					author: "Pier",
					scope: "user",
					path: join(cache, "demo-kit", "1.0.0"),
					enabled: true,
					contents: { skills: 1, commands: 2, agents: 1, mcpServers: 1, hooks: true },
				},
			]);
			expect(global.errors.some((e) => e.includes(`gone@${mkt}`))).toBe(true);
			const scoped = await client.request("plugins.list", { runtime: "claude-code", workspaceId: workspace.id });
			expect(scoped.items.map((p) => [p.id, p.scope, p.enabled])).toEqual([
				[`demo-kit@${mkt}`, "user", true],
				[`proj-kit@${mkt}`, "project", true],
			]);
			expect((await client.request("plugins.list", { runtime: "codex" })).items).toEqual([]);
		});

		it("lists enabled plugins' skills and MCP servers read-only", async () => {
			const skills = await client.request("skills.list", { runtime: "claude-code", workspaceId: workspace.id });
			const review = skills.items.find((s) => s.name === "demo-kit:review");
			expect(review).toMatchObject({
				plugin: `demo-kit@${mkt}`,
				scope: "user",
				description: "review from a plugin",
				enabled: true,
				editable: false,
				deletable: false,
			});
			expect(skills.items.find((s) => s.name === "proj-kit:solo")).toMatchObject({ scope: "project" });
			expect(skills.items.some((s) => s.name.startsWith("other-kit:"))).toBe(false);
			if (!review) throw new Error("Expected the plugin skill");
			expect((await client.request("skills.read", { runtime: "claude-code", path: review.path })).text).toBe(
				skill("review"),
			);
			await expect(
				client.request("skills.delete", { runtime: "claude-code", path: review.path }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			// Claude Code switches plugin skills off by their `plugin:skill` name.
			await client.request("skills.setEnabled", { runtime: "claude-code", path: review.path, enabled: false });
			expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).permissions.deny).toEqual([
				"Skill(demo-kit:review)",
				"Skill(demo-kit:review *)",
			]);

			const servers = await client.request("mcp.list", { runtime: "claude-code", workspaceId: workspace.id });
			expect(servers.items.filter((s) => s.plugin).map((s) => [s.name, s.scope, s.config])).toEqual([
				["plugin:demo-kit:docs", "user", { type: "http", url: "https://example.com/mcp" }],
				["plugin:proj-kit:tool", "project", { command: "node", args: ["server.js"] }],
			]);
		});

		it("switches enabledPlugins where it takes effect", async () => {
			await client.request("plugins.setEnabled", { runtime: "claude-code", id: `demo-kit@${mkt}`, enabled: false });
			expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).enabledPlugins).toEqual({
				[`demo-kit@${mkt}`]: false,
			});
			expect((await client.request("plugins.list", { runtime: "claude-code" })).items[0]?.enabled).toBe(false);
			const skills = await client.request("skills.list", { runtime: "claude-code" });
			expect(skills.items.some((s) => s.plugin)).toBe(false);
			const servers = await client.request("mcp.list", { runtime: "claude-code" });
			expect(servers.items.some((s) => s.plugin)).toBe(false);

			// The local settings outrank the project's: they decide, so the switch writes there.
			settings(localSettings, { enabledPlugins: { [`proj-kit@${mkt}`]: false } });
			const target = { runtime: "claude-code" as const, workspaceId: workspace.id };
			const listed = await client.request("plugins.list", target);
			expect(listed.items.find((p) => p.id === `proj-kit@${mkt}`)?.enabled).toBe(false);
			await client.request("plugins.setEnabled", { ...target, id: `proj-kit@${mkt}`, enabled: true });
			expect(JSON.parse(readFileSync(localSettings, "utf8")).enabledPlugins[`proj-kit@${mkt}`]).toBe(true);
			expect(JSON.parse(readFileSync(projectSettings, "utf8")).enabledPlugins[`proj-kit@${mkt}`]).toBe(true);
			expect(
				(await client.request("plugins.list", target)).items.every((p) => p.id !== `proj-kit@${mkt}` || p.enabled),
			).toBe(true);

			await expect(
				client.request("plugins.setEnabled", { runtime: "claude-code", id: `other-kit@${mkt}`, enabled: true }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				client.request("plugins.setEnabled", { runtime: "codex", id: `demo-kit@${mkt}`, enabled: true }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("needs the claude CLI to uninstall", async () => {
			// This Host runs without Claude Code, so there is no `claude` to uninstall with.
			const registry = readFileSync(join(claude, "plugins", "installed_plugins.json"), "utf8");
			await expect(
				client.request("plugins.uninstall", { runtime: "claude-code", id: `demo-kit@${mkt}` }),
			).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("未找到 Claude Code") });
			await expect(
				client.request("plugins.uninstall", { runtime: "claude-code", id: `other-kit@${mkt}` }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				client.request("plugins.uninstall", { runtime: "codex", id: `demo-kit@${mkt}` }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(readFileSync(join(claude, "plugins", "installed_plugins.json"), "utf8")).toBe(registry);
		});
	});
});

describe.runIf(process.platform !== "win32")("uninstalling Claude Code plugins", () => {
	const mkt = "local-mkt";
	let root: string;
	let claude: string;
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	/** What the fake `claude` does next: `ok`, `failed`, `plain` or `old`. */
	const mode = (value: string) => writeFileSync(join(root, "mode"), value);
	/** The fake's last call: its working directory, `CLAUDE_CONFIG_DIR` and arguments. */
	const call = () => {
		const [cwd, configDir, ...args] = readFileSync(join(root, "call.log"), "utf8").trimEnd().split("\n");
		return { cwd, configDir, args };
	};

	beforeEach(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pier-plugin-uninstall-")));
		claude = join(root, ".claude");
		const fake = join(root, "bin", "claude");
		mkdirSync(dirname(fake), { recursive: true });
		// Like `claude plugin uninstall --json`: one result line on stdout, the message on stderr.
		writeFileSync(
			fake,
			`#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
{ pwd -P; printf '%s\\n' "$CLAUDE_CONFIG_DIR"; printf '%s\\n' "$@"; } > "${root}/call.log"
case "$(cat "${root}/mode")" in
ok) echo '{"command":"uninstall","outcome":"ok","plugin":"'"$3"'","scope":"'"$5"'","message":"Successfully uninstalled"}' ;;
failed)
	echo '{"command":"uninstall","outcome":"failed","plugin":"'"$3"'","message":"Plugin is installed in user scope, not project.","failureCode":"not_installed_at_scope"}'
	echo "Failed to uninstall plugin" >&2; exit 1 ;;
plain) echo "Successfully uninstalled plugin" ;;
old) echo "error: unknown option '--json'" >&2; exit 1 ;;
esac
`,
		);
		chmodSync(fake, 0o755);
		t = await startTestHost({
			fileSettings: true,
			resourceHome: root,
			agentConfigDirs: { "claude-code": claude },
			agents: { claudeCode: { executable: fake, configDir: claude } },
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
		const kit = (name: string) => {
			const dir = join(claude, "plugins", "cache", mkt, name, "1.0.0");
			mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
			writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
			return dir;
		};
		const plugins = {
			[`demo-kit@${mkt}`]: [{ scope: "user", installPath: kit("demo-kit") }],
			[`proj-kit@${mkt}`]: [{ scope: "project", installPath: kit("proj-kit"), projectPath: t.workspaceDir }],
			[`org-kit@${mkt}`]: [{ scope: "managed", installPath: kit("org-kit") }],
			[`-x@${mkt}`]: [{ scope: "user", installPath: kit("dash-kit") }],
		};
		writeFileSync(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
	});
	afterEach(async () => {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("runs `claude plugin uninstall` for the listed installation", async () => {
		mode("ok");
		const target = { runtime: "claude-code" as const, workspaceId: workspace.id };
		expect(await client.request("plugins.uninstall", { runtime: "claude-code", id: `demo-kit@${mkt}` })).toEqual({
			uninstalled: true,
		});
		// The user installation is removed from the home directory, in the configuration Pier lists.
		expect(call()).toEqual({
			cwd: realpathSync(homedir()),
			configDir: claude,
			args: ["plugin", "uninstall", `demo-kit@${mkt}`, "--scope", "user", "--json"],
		});

		// A project installation is found through the workspace; `keepData` keeps the plugin's data.
		await client.request("plugins.uninstall", { ...target, id: `proj-kit@${mkt}`, keepData: true });
		expect(call()).toMatchObject({
			cwd: t.workspaceDir,
			args: ["plugin", "uninstall", `proj-kit@${mkt}`, "--scope", "project", "--json", "--keep-data"],
		});
	});

	it("reports what Claude Code says when it cannot uninstall", async () => {
		mode("failed");
		await expect(
			client.request("plugins.uninstall", { runtime: "claude-code", id: `demo-kit@${mkt}` }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Claude Code 未能卸载 demo-kit：Plugin is installed in user scope, not project.",
		});
		mode("old");
		await expect(
			client.request("plugins.uninstall", { runtime: "claude-code", id: `demo-kit@${mkt}` }),
		).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("请先更新 Claude Code") });
		// Without `--json`, a Claude Code that exits cleanly has uninstalled the plugin.
		mode("plain");
		await expect(
			client.request("plugins.uninstall", { runtime: "claude-code", id: `demo-kit@${mkt}` }),
		).resolves.toEqual({ uninstalled: true });
	});

	it("does not run Claude Code for managed or unlisted plugins or unsafe IDs", async () => {
		mode("ok");
		await expect(
			client.request("plugins.uninstall", { runtime: "claude-code", id: `org-kit@${mkt}` }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// A project installation is only listed, and uninstalled, with its workspace.
		await expect(
			client.request("plugins.uninstall", { runtime: "claude-code", id: `proj-kit@${mkt}` }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client.request("plugins.uninstall", { runtime: "claude-code", id: `-x@${mkt}` }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(existsSync(join(root, "call.log"))).toBe(false);
	});
});
