import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "@decimalturn/toml-patch";
import type { PierClient } from "@pier/client";
import { LOCAL_ONLY_METHODS, type PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	return (error as PierProtocolError | undefined)?.code;
}

describe("agent configuration files", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let claudeDir: string;
	let codexDir: string;
	let opencodeDir: string;

	let configRoot: string;

	beforeEach(async () => {
		configRoot = mkdtempSync(join(tmpdir(), "pier-agent-config-"));
		claudeDir = join(configRoot, "claude");
		codexDir = join(configRoot, "codex");
		opencodeDir = join(configRoot, "opencode");
		t = await startTestHost({
			agentConfigDirs: { "claude-code": claudeDir, codex: codexDir, opencode: opencodeDir },
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
		rmSync(configRoot, { recursive: true, force: true });
	});

	it("is open to paired devices", () => {
		for (const method of ["agentConfig.get", "agentConfig.update", "agentConfig.write"] as const) {
			expect(LOCAL_ONLY_METHODS.has(method), method).toBe(false);
		}
	});

	it("lists Claude Code's user, project and local files", async () => {
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "settings.json"), '{ "model": "opus" }\n');
		const user = await client.request("agentConfig.get", { runtime: "claude-code" });
		expect(user).toMatchObject({
			runtime: "claude-code",
			format: "json",
			configDir: claudeDir,
			scopes: ["user", "project", "local"],
			available: false,
		});
		expect(user.files).toHaveLength(1);
		expect(user.files[0]).toMatchObject({ scope: "user", exists: true, settings: { model: "opus" } });

		const all = await client.request("agentConfig.get", { runtime: "claude-code", workspaceId: workspace.id });
		expect(all.workspaceId).toBe(workspace.id);
		expect(all.files.map((f) => [f.scope, f.path, f.exists])).toEqual([
			["user", join(claudeDir, "settings.json"), true],
			["project", join(workspace.path, ".claude", "settings.json"), false],
			["local", join(workspace.path, ".claude", "settings.local.json"), false],
		]);
	});

	it("updates Claude Code settings, keeping other keys, and tells every connection", async () => {
		mkdirSync(claudeDir, { recursive: true });
		const path = join(claudeDir, "settings.json");
		writeFileSync(path, JSON.stringify({ hooks: { Stop: [] }, env: { KEEP: "1" } }));
		const events = new Recorder();
		client.onEvent(events.handler);
		const changed = events.waitForType("agentConfig.changed");

		const result = await client.request("agentConfig.update", {
			runtime: "claude-code",
			scope: "user",
			changes: [
				{ path: ["env", "ANTHROPIC_BASE_URL"], value: "https://relay.example" },
				{ path: ["permissions", "defaultMode"], value: "acceptEdits" },
				{ path: ["env", "KEEP"] },
			],
		});
		expect(result.changed).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			hooks: { Stop: [] },
			env: { ANTHROPIC_BASE_URL: "https://relay.example" },
			permissions: { defaultMode: "acceptEdits" },
		});
		expect(result.file.settings).toEqual(JSON.parse(readFileSync(path, "utf8")));
		expect((await changed).event).toEqual({ type: "agentConfig.changed", runtime: "claude-code", scope: "user" });

		const again = await client.request("agentConfig.update", {
			runtime: "claude-code",
			scope: "user",
			changes: [{ path: ["permissions", "defaultMode"], value: "acceptEdits" }],
		});
		expect(again.changed).toBe(false);
	});

	it("writes the local settings into the workspace", async () => {
		const result = await client.request("agentConfig.update", {
			runtime: "claude-code",
			scope: "local",
			workspaceId: workspace.id,
			changes: [{ path: ["permissions", "allow"], value: ["Bash(npm test:*)"] }],
		});
		const path = join(workspace.path, ".claude", "settings.local.json");
		expect(result.file.path).toBe(path);
		expect(readFileSync(path, "utf8")).toBe(
			'{\n  "permissions": {\n    "allow": [\n      "Bash(npm test:*)"\n    ]\n  }\n}\n',
		);
		expect(
			await codeOf(
				client.request("agentConfig.update", {
					runtime: "claude-code",
					scope: "local",
					changes: [{ path: ["a"], value: 1 }],
				}),
			),
		).toBe("BAD_REQUEST");
		expect(
			await codeOf(
				client.request("agentConfig.update", {
					runtime: "codex",
					scope: "local",
					workspaceId: workspace.id,
					changes: [{ path: ["a"], value: 1 }],
				}),
			),
		).toBe("BAD_REQUEST");
	});

	it("edits Codex's config.toml without losing comments or formatting", async () => {
		mkdirSync(codexDir, { recursive: true });
		const path = join(codexDir, "config.toml");
		const original = [
			"# my Codex config",
			'model = "gpt-5" # favourite',
			'approval_policy = "on-request"',
			"",
			'[projects."/home/me/app"]',
			'trust_level = "trusted"',
			"",
			"# MCP servers",
			"[mcp_servers.docs]",
			'command = "npx"',
			'args = ["-y", "docs"]',
			"",
		].join("\n");
		writeFileSync(path, original);

		const get = await client.request("agentConfig.get", { runtime: "codex" });
		expect(get).toMatchObject({ format: "toml", configDir: codexDir, scopes: ["user", "project"] });
		expect(get.files[0]?.settings).toMatchObject({ model: "gpt-5", mcp_servers: { docs: { command: "npx" } } });

		const result = await client.request("agentConfig.update", {
			runtime: "codex",
			scope: "user",
			changes: [
				{ path: ["model"], value: "gpt-5-codex" },
				{ path: ["approval_policy"] },
				{ path: ["model_reasoning_effort"], value: "high" },
				{ path: ["sandbox_workspace_write", "network_access"], value: true },
				{ path: ["model_providers", "relay", "name"], value: "Relay" },
				{ path: ["model_providers", "relay", "base_url"], value: "https://relay.example/v1" },
			],
		});
		expect(result.changed).toBe(true);
		const text = readFileSync(path, "utf8");
		expect(text).toContain("# my Codex config");
		expect(text).toContain('model = "gpt-5-codex" # favourite');
		expect(text).toContain("# MCP servers");
		expect(text).not.toContain("approval_policy");
		expect(parseToml(text)).toEqual({
			model: "gpt-5-codex",
			model_reasoning_effort: "high",
			projects: { "/home/me/app": { trust_level: "trusted" } },
			mcp_servers: { docs: { command: "npx", args: ["-y", "docs"] } },
			sandbox_workspace_write: { network_access: true },
			model_providers: { relay: { name: "Relay", base_url: "https://relay.example/v1" } },
		});
		expect(
			await codeOf(
				client.request("agentConfig.update", {
					runtime: "codex",
					scope: "user",
					changes: [{ path: ["a"], value: null }],
				}),
			),
		).toBe("BAD_REQUEST");
	});

	it("writes new tables as sections next to their siblings, keeping inline tables inline", async () => {
		mkdirSync(codexDir, { recursive: true });
		const path = join(codexDir, "config.toml");
		writeFileSync(
			path,
			'model = "x"\n\n[model_providers.relay]\nname = "Relay"\n\n# MCP servers\n[mcp_servers.docs]\nenv = { A = "1" }\n',
		);
		await client.request("agentConfig.update", {
			runtime: "codex",
			scope: "user",
			changes: [
				{ path: ["model_providers", "backup", "name"], value: "Backup" },
				{ path: ["model_providers", "my.relay", "base_url"], value: "https://b/v1" },
				{ path: ["mcp_servers", "docs", "env", "B"], value: "2" },
			],
		});
		expect(readFileSync(path, "utf8")).toBe(
			[
				'model = "x"',
				"",
				"[model_providers.relay]",
				'name = "Relay"',
				"",
				"[model_providers.backup]",
				'name = "Backup"',
				"",
				'[model_providers."my.relay"]',
				'base_url = "https://b/v1"',
				"",
				"# MCP servers",
				"[mcp_servers.docs]",
				'env = { A = "1", B = "2" }',
				"",
			].join("\n"),
		);

		await client.request("agentConfig.update", {
			runtime: "codex",
			scope: "project",
			workspaceId: workspace.id,
			changes: [
				{ path: ["model_providers", "relay", "name"], value: "R" },
				{ path: ["model_provider"], value: "relay" },
			],
		});
		expect(readFileSync(join(workspace.path, ".codex", "config.toml"), "utf8")).toBe(
			'model_provider = "relay"\n\n[model_providers.relay]\nname = "R"\n',
		);
	});

	it("replaces files as text, validating them and detecting concurrent edits", async () => {
		const first = await client.request("agentConfig.write", {
			runtime: "codex",
			scope: "project",
			workspaceId: workspace.id,
			text: 'model = "o3"\n',
		});
		expect(first.changed).toBe(true);
		expect(first.file.path).toBe(join(workspace.path, ".codex", "config.toml"));
		expect(first.file.settings).toEqual({ model: "o3" });

		expect(
			await codeOf(
				client.request("agentConfig.write", {
					runtime: "codex",
					scope: "project",
					workspaceId: workspace.id,
					text: "model = ",
				}),
			),
		).toBe("BAD_REQUEST");
		expect(
			await codeOf(client.request("agentConfig.write", { runtime: "claude-code", scope: "user", text: "[1]" })),
		).toBe("BAD_REQUEST");

		writeFileSync(first.file.path, 'model = "changed elsewhere"\n');
		const stale = new Date(Date.parse(first.file.modifiedAt ?? "") - 5000).toISOString();
		expect(
			await codeOf(
				client.request("agentConfig.write", {
					runtime: "codex",
					scope: "project",
					workspaceId: workspace.id,
					text: 'model = "mine"\n',
					expectedModifiedAt: stale,
				}),
			),
		).toBe("CONFLICT");
	});

	it("lists OpenCode's files, preferring the one whose settings win", async () => {
		const empty = await client.request("agentConfig.get", { runtime: "opencode", workspaceId: workspace.id });
		expect(empty).toMatchObject({ format: "jsonc", configDir: opencodeDir, scopes: ["user", "project"] });
		expect(empty.files.map((f) => [f.scope, f.path, f.exists])).toEqual([
			["user", join(opencodeDir, "opencode.json"), false],
			["project", join(workspace.path, "opencode.json"), false],
		]);

		mkdirSync(opencodeDir, { recursive: true });
		writeFileSync(join(opencodeDir, "config.json"), '{ "model": "legacy/model" }');
		writeFileSync(join(workspace.path, "opencode.jsonc"), '{\n  // mine\n  "model": "a/b",\n}\n');
		const legacy = await client.request("agentConfig.get", { runtime: "opencode", workspaceId: workspace.id });
		expect(legacy.files.map((f) => [f.path, f.settings])).toEqual([
			[join(opencodeDir, "config.json"), { model: "legacy/model" }],
			[join(workspace.path, "opencode.jsonc"), { model: "a/b" }],
		]);

		writeFileSync(join(opencodeDir, "opencode.json"), "{}");
		writeFileSync(join(opencodeDir, "opencode.jsonc"), '{ "small_model": "x/y" }');
		const user = await client.request("agentConfig.get", { runtime: "opencode" });
		expect(user.files[0]).toMatchObject({
			path: join(opencodeDir, "opencode.jsonc"),
			settings: { small_model: "x/y" },
		});
	});

	it("edits OpenCode's JSONC in place, keeping comments and trailing commas", async () => {
		mkdirSync(opencodeDir, { recursive: true });
		const path = join(opencodeDir, "opencode.jsonc");
		writeFileSync(
			path,
			[
				"{",
				'    "$schema": "https://opencode.ai/config.json",',
				"    // The model I like",
				'    "model": "anthropic/claude-sonnet-4-5",',
				'    "mcp": {',
				'        "docs": { "type": "local", "command": ["npx", "docs"] }, // keep me',
				"    },",
				'    "share": "auto",',
				"}",
				"",
			].join("\n"),
		);
		const result = await client.request("agentConfig.update", {
			runtime: "opencode",
			scope: "user",
			changes: [
				{ path: ["model"], value: "relay/gpt-5.1" },
				{ path: ["share"] },
				{ path: ["permission", "bash"], value: "ask" },
				{ path: ["provider", "relay", "npm"], value: "@ai-sdk/openai-compatible" },
				{ path: ["provider", "relay", "options", "baseURL"], value: "https://relay.example/v1" },
				{ path: ["provider", "relay", "models", "gpt-5.1"], value: {} },
			],
		});
		expect(result.changed).toBe(true);
		const text = readFileSync(path, "utf8");
		expect(text).toContain("// The model I like");
		expect(text).toContain("// keep me");
		expect(text).toContain('    "model": "relay/gpt-5.1",');
		expect(text).toContain('        "bash": "ask"');
		expect(text).not.toContain("share");
		expect(text.endsWith("}\n")).toBe(true);
		expect(result.file.settings).toEqual({
			$schema: "https://opencode.ai/config.json",
			model: "relay/gpt-5.1",
			mcp: { docs: { type: "local", command: ["npx", "docs"] } },
			permission: { bash: "ask" },
			provider: {
				relay: {
					npm: "@ai-sdk/openai-compatible",
					options: { baseURL: "https://relay.example/v1" },
					models: { "gpt-5.1": {} },
				},
			},
		});

		// Removing the last model drops the emptied objects too.
		await client.request("agentConfig.update", {
			runtime: "opencode",
			scope: "user",
			changes: [{ path: ["provider", "relay", "models", "gpt-5.1"] }, { path: ["permission", "bash"] }],
		});
		const after = await client.request("agentConfig.get", { runtime: "opencode" });
		expect(after.files[0]?.settings).toMatchObject({ provider: { relay: { npm: "@ai-sdk/openai-compatible" } } });
		expect(after.files[0]?.settings).not.toHaveProperty("permission");
		expect(after.files[0]?.text).toContain("// keep me");
	});

	it("removes OpenCode settings next to trailing commas without breaking the file", async () => {
		mkdirSync(opencodeDir, { recursive: true });
		const path = join(opencodeDir, "opencode.json");
		const remove = (...paths: string[][]) =>
			client.request("agentConfig.update", {
				runtime: "opencode",
				scope: "user",
				changes: paths.map((p) => ({ path: p })),
			});
		writeFileSync(path, '{ "share": "auto", }');
		await remove(["share"]);
		expect(readFileSync(path, "utf8")).toBe("{ }");
		writeFileSync(path, '{\n  "model": "a/b", // mine\n  "permission": { "edit": "ask", "bash": "ask", },\n}\n');
		await remove(["model"], ["permission", "edit"]);
		// The comment on the removed line goes with it; the inline object stays inline.
		expect(readFileSync(path, "utf8")).toBe('{\n  "permission": { "bash": "ask", },\n}\n');
	});

	it("starts new OpenCode files with the schema and validates text as JSONC", async () => {
		const created = await client.request("agentConfig.update", {
			runtime: "opencode",
			scope: "project",
			workspaceId: workspace.id,
			changes: [{ path: ["model"], value: "a/b" }],
		});
		expect(created.file.path).toBe(join(workspace.path, "opencode.json"));
		expect(readFileSync(created.file.path, "utf8")).toBe(
			'{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "a/b"\n}\n',
		);

		const written = await client.request("agentConfig.write", {
			runtime: "opencode",
			scope: "user",
			text: '{\n  // comments are fine\n  "model": "c/d",\n}\n',
		});
		expect(written.file.settings).toEqual({ model: "c/d" });
		for (const text of ["[1]", "{ model: }", "// only a comment\n"]) {
			expect(
				await codeOf(client.request("agentConfig.write", { runtime: "opencode", scope: "user", text })),
				text,
			).toBe("BAD_REQUEST");
		}

		writeFileSync(written.file.path, '{ "model": "c/d" ');
		const broken = await client.request("agentConfig.get", { runtime: "opencode" });
		expect(broken.files[0]?.settings).toBeUndefined();
		expect(broken.files[0]?.error).toMatch(/CloseBraceExpected at 1:/);
		expect(
			await codeOf(
				client.request("agentConfig.update", {
					runtime: "opencode",
					scope: "user",
					changes: [{ path: ["a"], value: 1 }],
				}),
			),
		).toBe("CONFLICT");
	});

	it("reports files it cannot parse and refuses to patch them", async () => {
		mkdirSync(codexDir, { recursive: true });
		writeFileSync(join(codexDir, "config.toml"), "model = \n");
		const get = await client.request("agentConfig.get", { runtime: "codex" });
		expect(get.files[0]?.settings).toBeUndefined();
		expect(get.files[0]?.error).toBeTypeOf("string");
		expect(get.files[0]?.text).toBe("model = \n");
		expect(
			await codeOf(
				client.request("agentConfig.update", { runtime: "codex", scope: "user", changes: [{ path: ["a"], value: 1 }] }),
			),
		).toBe("CONFLICT");
	});
});
