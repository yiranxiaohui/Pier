import { z } from "zod";

/** Native resources shared by the desktop and mobile managers (1.38). */
export const ResourceRuntimeSchema = z.enum(["pi", "claude-code", "codex"]);
export type ResourceRuntime = z.infer<typeof ResourceRuntimeSchema>;
export const ResourceScopeSchema = z.enum(["user", "project", "local"]);
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
export const ResourceNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
	.refine((name) => !["constructor", "prototype", "__proto__"].includes(name), "Reserved name");

export interface SkillInfo {
	runtime: ResourceRuntime;
	scope: ResourceScope;
	name: string;
	description: string;
	path: string;
	enabled: boolean;
	editable: boolean;
	deletable: boolean;
	shared: boolean;
	/**
	 * The Claude Code plugin (`name@marketplace`) that provides the skill (1.74). Plugin skills are
	 * read-only; `name` is the `plugin:skill` name Claude Code uses.
	 */
	plugin?: string;
}

export interface SkillDocument {
	skill: SkillInfo;
	text: string;
	revision: string;
}

export interface McpServerInfo {
	runtime: ResourceRuntime;
	scope: ResourceScope;
	name: string;
	path: string;
	enabled: boolean;
	/** Native server configuration; only delivered over authenticated connections. */
	config: Record<string, unknown>;
	revision: string;
	/**
	 * The Claude Code plugin (`name@marketplace`) that provides the server (1.74). Plugin servers
	 * are read-only and named `plugin:<plugin>:<server>` like Claude Code does.
	 */
	plugin?: string;
}

/** A Claude Code plugin installed with `/plugin` or `claude plugin install` (1.74). */
export interface PluginInfo {
	runtime: ResourceRuntime;
	/** `name@marketplace`, the key of `enabledPlugins`. */
	id: string;
	name: string;
	marketplace: string;
	description: string;
	version?: string;
	author?: string;
	/** Where it was installed: `user`, or `project` / `local` for the selected workspace. */
	scope: ResourceScope;
	/** The installed plugin directory. */
	path: string;
	/** Only enabled plugins load their skills, commands, agents, hooks and MCP servers. */
	enabled: boolean;
	contents: { skills: number; commands: number; agents: number; mcpServers: number; hooks: boolean };
}

export interface ResourceList<T> {
	items: T[];
	/** Per-file errors do not hide resources in other scopes. */
	errors: string[];
}

export interface McpTestResult {
	ok: boolean;
	tools: Array<{ name: string; description?: string }>;
	/** Fixed status text: subprocess output and credentials are never returned. */
	message: string;
}

const Target = { runtime: ResourceRuntimeSchema, workspaceId: z.string().min(1).max(256).optional() };
const SkillRef = { ...Target, path: z.string().min(1).max(4096) };
const McpRef = { ...Target, scope: ResourceScopeSchema, name: ResourceNameSchema };

export const ResourceMethodSchemas = {
	"skills.list": z.object(Target),
	"skills.read": z.object(SkillRef),
	"skills.save": z.object({
		...Target,
		scope: ResourceScopeSchema,
		name: ResourceNameSchema,
		path: z.string().max(4096).optional(),
		text: z.string().min(1).max(1_000_000),
		expectedRevision: z.string().optional(),
	}),
	"skills.import": z.object({
		...Target,
		scope: ResourceScopeSchema,
		sourcePath: z.string().min(1).max(4096),
		name: ResourceNameSchema.optional(),
	}),
	"skills.setEnabled": z.object({ ...SkillRef, enabled: z.boolean() }),
	"skills.delete": z.object({ ...SkillRef, expectedRevision: z.string().optional() }),
	"mcp.list": z.object(Target),
	"mcp.save": z.object({
		...McpRef,
		config: z.record(z.string(), z.json()),
		enabled: z.boolean().default(true),
		expectedRevision: z.string().optional(),
		create: z.boolean().default(false),
	}),
	"mcp.setEnabled": z.object({ ...McpRef, enabled: z.boolean(), expectedRevision: z.string() }),
	"mcp.delete": z.object({ ...McpRef, expectedRevision: z.string() }),
	/** Explicitly connects (and starts stdio processes) only when the user requests a test. */
	"mcp.test": z.object(McpRef),
	/** Claude Code plugins (1.74); other runtimes have none. */
	"plugins.list": z.object(Target),
	"plugins.setEnabled": z.object({ ...Target, id: z.string().min(1).max(300), enabled: z.boolean() }),
} as const;
export type ResourceMethod = keyof typeof ResourceMethodSchemas;
