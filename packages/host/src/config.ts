import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import {
	type AgentInstallSource,
	AgentInstallSourceSchema,
	type ApprovalPolicy,
	ApprovalPolicySchema,
	type NativeAgentRuntime,
	NativeAgentRuntimeSchema,
	type WorkspaceInfo,
} from "@pier/protocol";
import { z } from "zod";

const WorkspaceSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	path: z.string().min(1),
	policy: ApprovalPolicySchema,
	addedAt: z.string(),
});

/** Default TCP port of the remote (LAN) listener. */
export const DEFAULT_REMOTE_PORT = 7433;

const RelayConfigSchema = z.object({
	enabled: z.boolean(),
	/** Normalized `ws://` / `wss://` URL (empty until set). */
	url: z.string(),
	/** Access token for relays in private mode. */
	token: z.string().optional(),
});
export type RelayConfig = z.infer<typeof RelayConfigSchema>;

const RemoteConfigSchema = z.object({
	enabled: z.boolean(),
	port: z.number().int().min(1).max(65535),
	/** Added in 0.3: register with a Pier Relay so devices can connect from anywhere. */
	relay: RelayConfigSchema.optional(),
	/** Added in 0.3: let relayed connections move to a peer-to-peer path (default on). */
	p2p: z.boolean().optional(),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export const PierConfigSchema = z.object({
	version: z.literal(1),
	hostId: z.string().min(1),
	hostName: z.string().min(1),
	defaultPolicy: ApprovalPolicySchema,
	workspaces: z.array(WorkspaceSchema),
	/** Added in 0.2; absent in older files means remote access off. */
	remote: RemoteConfigSchema.optional(),
	agentUpdates: z
		.partialRecord(NativeAgentRuntimeSchema, z.object({ enabled: z.boolean(), source: AgentInstallSourceSchema }))
		.optional(),
});

export type PierConfig = z.infer<typeof PierConfigSchema>;

export function createDefaultConfig(): PierConfig {
	return {
		version: 1,
		hostId: randomUUID(),
		hostName: hostname() || "pier-host",
		defaultPolicy: "smart",
		workspaces: [],
	};
}

/** Write a file atomically with owner-only permissions. */
export function writePrivateFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, { mode: 0o600 });
	renameSync(tmp, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort on platforms without POSIX permissions.
	}
}

/** Persistent Pier configuration in `~/.pier/config.json`. */
export class ConfigStore {
	private config: PierConfig;

	constructor(private readonly path: string) {
		this.config = this.load();
	}

	private load(): PierConfig {
		if (!existsSync(this.path)) {
			const config = createDefaultConfig();
			writePrivateFile(this.path, `${JSON.stringify(config, null, 2)}\n`);
			return config;
		}
		const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
		const parsed = PierConfigSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`Invalid Pier config at ${this.path}: ${parsed.error.message}`);
		}
		return parsed.data;
	}

	private save(config = this.config): void {
		writePrivateFile(this.path, `${JSON.stringify(config, null, 2)}\n`);
		this.config = config;
	}

	get hostId(): string {
		return this.config.hostId;
	}

	get hostName(): string {
		return this.config.hostName;
	}

	get defaultPolicy(): ApprovalPolicy {
		return this.config.defaultPolicy;
	}

	agentUpdate(runtime: NativeAgentRuntime): { enabled: boolean; source: AgentInstallSource } {
		return this.config.agentUpdates?.[runtime] ?? { enabled: true, source: "official" };
	}

	setAgentUpdate(runtime: NativeAgentRuntime, patch: { enabled?: boolean; source?: AgentInstallSource }): void {
		const previous = this.agentUpdate(runtime);
		const next = { ...previous, ...patch };
		if (next.enabled === previous.enabled && next.source === previous.source) return;
		this.save({ ...this.config, agentUpdates: { ...this.config.agentUpdates, [runtime]: next } });
	}

	get remote(): RemoteConfig {
		return { enabled: false, port: DEFAULT_REMOTE_PORT, ...this.config.remote };
	}

	setRemote(patch: Partial<RemoteConfig>): RemoteConfig {
		this.config.remote = { ...this.remote, ...patch };
		this.save();
		return this.remote;
	}

	listWorkspaces(): WorkspaceInfo[] {
		return this.config.workspaces.map((w) => ({ ...w }));
	}

	getWorkspace(id: string): WorkspaceInfo | undefined {
		const workspace = this.config.workspaces.find((w) => w.id === id);
		return workspace ? { ...workspace } : undefined;
	}

	findWorkspaceByPath(path: string): WorkspaceInfo | undefined {
		const workspace = this.config.workspaces.find((w) => w.path === path);
		return workspace ? { ...workspace } : undefined;
	}

	addWorkspace(input: { path: string; name: string; policy?: ApprovalPolicy }): WorkspaceInfo {
		const existing = this.findWorkspaceByPath(input.path);
		if (existing) return existing;
		const workspace: WorkspaceInfo = {
			id: randomUUID(),
			name: input.name,
			path: input.path,
			policy: input.policy ?? this.config.defaultPolicy,
			addedAt: new Date().toISOString(),
		};
		this.config.workspaces.push(workspace);
		this.save();
		return { ...workspace };
	}

	removeWorkspace(id: string): boolean {
		const before = this.config.workspaces.length;
		this.config.workspaces = this.config.workspaces.filter((w) => w.id !== id);
		if (this.config.workspaces.length === before) return false;
		this.save();
		return true;
	}

	setWorkspacePolicy(id: string, policy: ApprovalPolicy): WorkspaceInfo | undefined {
		const workspace = this.config.workspaces.find((w) => w.id === id);
		if (!workspace) return undefined;
		workspace.policy = policy;
		this.save();
		return { ...workspace };
	}
}
