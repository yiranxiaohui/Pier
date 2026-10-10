import { z } from "zod";
import { PEER_ADDRESS } from "./addresses.ts";
import { BrowserCommandSchema, type BrowserResult, type LocalBrowserInfo } from "./browser.ts";
import {
	type AccountAuthorizeStart,
	type AccountLoginResult,
	type AccountOverview,
	type AccountStatus,
	type AgentConfigChangeResult,
	type AgentConfigResult,
	AgentConfigRuntimeSchema,
	AgentConfigScopeSchema,
	type AgentInstallationResult,
	type AgentRuntimeInfo,
	ApprovalPolicySchema,
	type AppUpdateStatus,
	AuthMethodSchema,
	type ClientInfo,
	type CustomModel,
	CustomProviderApiSchema,
	CustomProviderSchema,
	type DefaultModelRef,
	type DeviceInfo,
	type ExtensionCatalogResult,
	ExtensionCatalogSortSchema,
	ExtensionCatalogTypeSchema,
	type ExtensionListResult,
	type ExtensionPackageInfo,
	type ExtensionReloadSummary,
	type ExtensionResourceInfo,
	ExtensionResourceTypeSchema,
	ExtensionScopeSchema,
	type ExtensionUpdateInfo,
	type GitBranchInfo,
	type GitCommandResult,
	type GitCommitInfo,
	type GitCommitResult,
	type GitDiffResult,
	type GitStatus,
	type HostDirectoryListing,
	type HostInfo,
	type HostStats,
	ImageInputSchema,
	type LoopbackCallbackPage,
	type LoopbackRequest,
	type ModelInfo,
	type NewApiAuthorizeResult,
	type NewApiAuthorizeStart,
	type NewApiLoginResult,
	type NewApiModel,
	type NewApiToken,
	type PackageManagerDetection,
	type PeerInfo,
	type PiSettingsChangeResult,
	type PiSettingsResult,
	type ProviderInfo,
	type ProviderListResult,
	type QueueState,
	type RemoteAccessStatus,
	type SessionCleanupResult,
	type SessionCommandInfo,
	type SessionSnapshot,
	type SessionSummary,
	StreamingBehaviorSchema,
	type TerminalInfo,
	type ThinkingLevel,
	ThinkingLevelSchema,
	UiResponseSchema,
	type WorkspaceFileBytes,
	type WorkspaceFileContent,
	type WorkspaceFilesResult,
	type WorkspaceFileWriteResult,
	type WorkspaceInfo,
	type WorkspacePathDeleteResult,
	type WorkspaceUploadStart,
} from "./domain.ts";
import type { HostPorts, PortForward } from "./ports.ts";
import {
	type McpServerInfo,
	type McpTestResult,
	type ResourceList,
	ResourceMethodSchemas,
	type SkillDocument,
	type SkillInfo,
} from "./resources.ts";
import { type ScheduledTask, ScheduledTaskInputSchema, type ScheduledTaskRun } from "./scheduled-tasks.ts";

const Id = z.string().min(1).max(256);
/** Repository-relative paths for `git.*` (1.28). */
const GitPaths = z.array(z.string().min(1).max(4096)).min(1).max(20_000);
/** A branch name for `git.*`; Git checks the rest of its rules. */
const GitBranchName = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[^-\s][^\s]*$/, "Invalid branch name");
/** Agent runtime id (1.22), e.g. `pi`, `claude-code`, `codex`. */
const RuntimeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SessionRef = { sessionId: Id };
const Text = z.string().max(1_000_000);
const Images = z.array(ImageInputSchema).max(16).optional();
/** Key path into a settings object; prototype keys are rejected. */
const SettingsKeyPath = z
	.array(
		z
			.string()
			.min(1)
			.max(200)
			.refine((key) => key !== "__proto__" && key !== "prototype" && key !== "constructor", "Reserved key"),
	)
	.min(1)
	.max(8);

export const ClientInfoSchema = z.object({
	name: z.string().min(1).max(100),
	version: z.string().max(50),
	platform: z.string().max(50).optional(),
}) satisfies z.ZodType<ClientInfo>;

/**
 * Params schema for every method. Methods not listed here are unknown to the protocol.
 */
export const MethodParamsSchemas = {
	...ResourceMethodSchemas,
	"host.ports": z.object({}).optional(),
	/** Local listeners are managed only by the local desktop, independently of browsers. */
	"portForward.open": z.object({
		peerId: Id,
		remoteHost: z
			.string()
			.min(1)
			.max(253)
			.regex(/^[a-z\d._:-]+$/i),
		remotePort: z.number().int().min(1).max(65535),
		localPort: z.number().int().min(0).max(65535).optional(),
	}),
	"portForward.list": z.object({}).optional(),
	"portForward.close": z.object({ id: Id }),
	/** TCP streams owned by the authenticated connection; used inside the encrypted channel. */
	"tunnel.open": z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535) }),
	"tunnel.read": z.object({ tunnelId: Id }),
	"tunnel.write": z.object({ tunnelId: Id, data: z.string().max(87_384), end: z.boolean().optional() }),
	"tunnel.close": z.object({ tunnelId: Id }),
	/** Launches a browser on this computer. Remote callers cannot launch one here. */
	"browser.open": z.object({
		workspaceId: Id,
		peerId: Id.optional(),
		url: z.string().min(1).max(8192),
		mode: z.enum(["service", "network"]),
		controlled: z.boolean().optional(),
	}),
	"browser.list": z.object({}).optional(),
	"browser.close": z.object({ browserId: Id }),
	/** Register the browser this connection renders locally, for a workspace on this host. */
	"browser.attach": z.object({ workspaceId: Id, browserId: Id }),
	"browser.detach": z.object({ browserId: Id }),
	"browser.action": z.object({ workspaceId: Id, browserId: Id.optional(), command: BrowserCommandSchema }),
	"browser.result": z.object({
		requestId: Id,
		result: z
			.object({
				text: z.string().max(200_000).optional(),
				image: z.object({ data: z.string().max(12_000_000), mimeType: z.literal("image/png") }).optional(),
			})
			.optional(),
		error: z.string().max(4000).optional(),
	}),
	"task.list": z.object({}).optional(),
	"task.create": ScheduledTaskInputSchema,
	"task.update": z.object({ taskId: Id, task: ScheduledTaskInputSchema }),
	"task.setStatus": z.object({ taskId: Id, status: z.enum(["active", "paused"]) }),
	"task.delete": z.object({ taskId: Id }),
	"task.run": z.object({ taskId: Id }),
	"task.stop": z.object({ taskId: Id }),
	"task.runs": z.object({ taskId: Id.optional() }).optional(),
	"task.readRun": z.object({ runId: Id }),
	"host.hello": z.object({
		protocolVersion: z.string(),
		client: ClientInfoSchema,
		/** Local connection token injected by the desktop shell. */
		token: z.string().max(512).optional(),
		/** Merge streaming text deltas that arrive within this window (ms). 0 disables merging. */
		coalesceMs: z.number().int().min(0).max(1000).optional(),
	}),
	"host.info": z.object({}).optional(),
	/**
	 * List the subdirectories of an absolute directory on the host (1.10), so a client can pick
	 * a workspace on another computer. Omit `path` for the user's home directory.
	 */
	"host.listDirectories": z.object({ path: z.string().min(1).max(4096).optional() }).optional(),
	/** CPU, memory, disk and network usage of the host's computer (1.12). */
	"host.stats": z.object({}).optional(),
	/** npm, pnpm and bun on the host's computer, for pi's `npmCommand` setting (1.17). */
	"host.packageManagers": z.object({}).optional(),

	/**
	 * The desktop app's updater on the host's computer (1.13), so a paired computer or phone can
	 * update Pier there. Only signed official releases are installed.
	 */
	"update.status": z.object({}).optional(),
	/** Check for a new release now. */
	"update.check": z.object({}).optional(),
	/**
	 * Download and install the newest release (checking first when needed), then restart Pier on
	 * that computer. Resolves once the install started; the host and every connection to it go
	 * down while it installs. Progress arrives as `update.status` events.
	 */
	"update.install": z.object({}).optional(),

	"workspace.list": z.object({}).optional(),
	"workspace.add": z.object({
		path: z.string().min(1).max(4096),
		name: z.string().min(1).max(200).optional(),
		policy: ApprovalPolicySchema.optional(),
	}),
	"workspace.remove": z.object({ workspaceId: Id }),
	"workspace.setPolicy": z.object({ workspaceId: Id, policy: ApprovalPolicySchema }),
	/** List one directory of a workspace (1.5). `path` is relative to the workspace root; omit for the root. */
	"workspace.files": z.object({ workspaceId: Id, path: z.string().max(4096).optional() }),
	/** Read one workspace file for preview (1.7). `path` is relative to the workspace root. */
	"workspace.readFile": z.object({ workspaceId: Id, path: z.string().min(1).max(4096) }),
	/** Preview a Markdown file reference in the workspace or an absolute path in host temp directories (1.31). */
	"workspace.previewFile": z.object({ workspaceId: Id, path: z.string().min(1).max(4096) }),
	/**
	 * Read one file after explicit user confirmation (local since 1.33, paired devices since 1.35).
	 * `expectedRealPath` is the resolved
	 * path shown in previewFile's OUTSIDE_ALLOWED_ROOTS error; changing targets requires a new
	 * confirmation. Grants no lasting access.
	 */
	"workspace.authorizeFilePreview": z.object({
		workspaceId: Id,
		path: z.string().min(1).max(4096),
		expectedRealPath: z.string().min(1).max(4096),
	}),
	/**
	 * Overwrite an existing workspace file with UTF-8 text (1.8). With `expectedModifiedAt`
	 * (the `modifiedAt` the client read), fails with `CONFLICT` if the file changed since.
	 */
	"workspace.writeFile": z.object({
		workspaceId: Id,
		path: z.string().min(1).max(4096),
		text: z.string().max(4 * 1024 * 1024),
		expectedModifiedAt: z.string().max(64).optional(),
	}),
	/**
	 * Permanently delete a workspace file, directory (recursively) or symlink (1.11). A symlink
	 * is removed itself, never its target; the workspace root cannot be deleted.
	 */
	"workspace.deletePath": z.object({ workspaceId: Id, path: z.string().min(1).max(4096) }),
	/**
	 * Read up to `length` bytes of a workspace file from `offset` (1.21), base64-encoded, e.g.
	 * to download it in chunks.
	 */
	"workspace.readBytes": z.object({
		workspaceId: Id,
		path: z.string().min(1).max(4096),
		offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		length: z
			.number()
			.int()
			.min(1)
			.max(4 * 1024 * 1024),
	}),
	/**
	 * Begin uploading a file of `size` bytes to `path` in a workspace (1.21). Missing parent
	 * directories are created. An existing file is only replaced with `overwrite`.
	 */
	"workspace.uploadStart": z.object({
		workspaceId: Id,
		path: z.string().min(1).max(4096),
		size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		overwrite: z.boolean().optional(),
	}),
	/** Append base64 `data` at `offset` (the bytes received so far) to an upload (1.21). */
	"workspace.uploadChunk": z.object({
		uploadId: Id,
		offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		data: z.string().max(6 * 1024 * 1024),
	}),
	/** Move a complete upload into place (1.21). */
	"workspace.uploadFinish": z.object({ uploadId: Id }),
	/** Abandon an upload and delete what was received (1.21). */
	"workspace.uploadCancel": z.object({ uploadId: Id }),

	/**
	 * Git source control of a workspace (1.28). The repository is the one the workspace is in;
	 * paths are relative to its root (`GitStatus.root`). `git.status` also answers for a
	 * workspace that is not in a repository (`repository: false`).
	 */
	"git.status": z.object({ workspaceId: Id }),
	/**
	 * Diff of one changed path: staged (index against HEAD) or unstaged (work tree against index).
	 * `origPath` is the path before a staged rename, so the rename is diffed as one file.
	 */
	"git.diff": z.object({
		workspaceId: Id,
		path: z.string().min(1).max(4096),
		origPath: z.string().min(1).max(4096).optional(),
		staged: z.boolean().optional(),
	}),
	/** Commits reachable from HEAD, newest first. */
	"git.log": z.object({
		workspaceId: Id,
		limit: z.number().int().min(1).max(500).optional(),
		skip: z.number().int().min(0).max(1_000_000).optional(),
	}),
	/** Message, stats and diff of one commit. */
	"git.show": z.object({ workspaceId: Id, commit: z.string().regex(/^[0-9a-fA-F]{4,64}$/) }),
	"git.branches": z.object({ workspaceId: Id }),
	/** Stage paths (`git add`), or every change when `paths` is omitted. */
	"git.stage": z.object({ workspaceId: Id, paths: GitPaths.optional() }),
	/** Unstage paths, or everything when `paths` is omitted. */
	"git.unstage": z.object({ workspaceId: Id, paths: GitPaths.optional() }),
	/**
	 * Throw away unstaged changes of paths: tracked ones are restored from the index, untracked
	 * ones are deleted. This cannot be undone.
	 */
	"git.discard": z.object({ workspaceId: Id, paths: GitPaths }),
	/** Commit the index; `all` stages changes of tracked files first (`git commit -a`). */
	"git.commit": z.object({
		workspaceId: Id,
		message: z.string().max(100_000),
		amend: z.boolean().optional(),
		all: z.boolean().optional(),
	}),
	/**
	 * Switch to a branch. A remote-tracking branch (`origin/x`) switches to the local branch `x`,
	 * creating it to track the remote one when needed. With `create`, `branch` is a new branch
	 * started at `startPoint` (default HEAD).
	 */
	"git.checkout": z.object({
		workspaceId: Id,
		branch: GitBranchName,
		create: z.boolean().optional(),
		startPoint: GitBranchName.optional(),
	}),
	/** Delete a local branch; `force` deletes it even when it is not merged. */
	"git.deleteBranch": z.object({ workspaceId: Id, branch: GitBranchName, force: z.boolean().optional() }),
	/** Fetch every remote (and prune deleted branches). */
	"git.fetch": z.object({ workspaceId: Id }),
	/** Pull the current branch from its upstream; `rebase` rebases instead of merging. */
	"git.pull": z.object({ workspaceId: Id, rebase: z.boolean().optional() }),
	/**
	 * Push the current branch. One without an upstream is pushed to `origin` (or the only
	 * remote) and tracks it. `force` uses `--force-with-lease`.
	 */
	"git.push": z.object({ workspaceId: Id, force: z.boolean().optional() }),
	/** Stash every change (including untracked files), or apply and drop the latest stash. */
	"git.stash": z.object({
		workspaceId: Id,
		action: z.enum(["push", "pop"]),
		message: z.string().max(1000).optional(),
	}),
	/** Create a repository in the workspace directory. */
	"git.init": z.object({ workspaceId: Id }),

	/** Agent runtimes the host knows and whether they can run sessions (1.22). */
	"runtime.list": z.object({}).optional(),
	/** Native CLI installation and progress on the Host computer (1.32). */
	"runtime.installStatus": z.object({ runtime: AgentConfigRuntimeSchema, refresh: z.boolean().optional() }),
	/** Starts an asynchronous install/update of the latest official native CLI. */
	"runtime.install": z.object({ runtime: AgentConfigRuntimeSchema }),

	"session.list": z.object({ workspaceId: Id }),
	/** `runtime` (1.22) picks the agent runtime; the default is `pi`. */
	"session.create": z.object({
		workspaceId: Id,
		name: z.string().min(1).max(200).optional(),
		runtime: RuntimeId.optional(),
	}),
	"session.open": z.union([
		z.object({ workspaceId: Id, sessionId: Id }),
		z.object({ workspaceId: Id, path: z.string().min(1).max(4096) }),
	]),
	"session.close": z.object({ ...SessionRef, force: z.boolean().optional() }),
	/** Close the session and move its file to Pier's trash (1.6). Running sessions need `force`. */
	"session.delete": z.object({ workspaceId: Id, sessionId: Id, force: z.boolean().optional() }),
	/**
	 * Archive or unarchive a session (1.14). Archiving only marks it on the host; the session
	 * file stays and the session keeps working.
	 */
	"session.archive": z.object({ workspaceId: Id, sessionId: Id, archived: z.boolean() }),
	/**
	 * Archive or delete (to Pier's trash) many sessions of a workspace at once (1.14). Selects
	 * sessions last modified before `modifiedBefore` (all when omitted) in `scope` (default
	 * `all`). Running sessions and ones waiting for an answer are skipped. `dryRun` only reports.
	 */
	"session.cleanup": z.object({
		workspaceId: Id,
		action: z.enum(["archive", "delete"]),
		modifiedBefore: z.iso.datetime({ offset: true }).optional(),
		scope: z.enum(["all", "archived", "unarchived"]).optional(),
		dryRun: z.boolean().optional(),
	}),
	"session.forkPoints": z.object(SessionRef),
	"session.fork": z.object({ ...SessionRef, entryId: Id, position: z.enum(["before", "at"]).optional() }),
	"session.rename": z.object({ ...SessionRef, name: z.string().min(1).max(200) }),
	"session.subscribe": z.object({
		...SessionRef,
		/** Last seq the client has applied. Only honored together with a matching `epoch`. */
		sinceSeq: z.number().int().nonnegative().optional(),
		/** Event-log epoch the `sinceSeq` belongs to (from a previous subscribe result or snapshot). */
		epoch: z.string().max(128).optional(),
		/**
		 * Transcript prefix the client already has (1.27): its first `count` messages, the last with
		 * `fingerprint` (`messageFingerprint`). When a snapshot follows and the prefix matches, it
		 * carries only the messages after it (`messagesFrom`).
		 */
		known: z.object({ count: z.number().int().positive(), fingerprint: z.string().min(1).max(64) }).optional(),
	}),
	"session.unsubscribe": z.object(SessionRef),
	"session.snapshot": z.object(SessionRef),
	/** Slash commands the session's agent runtime handles in `session.prompt` (1.5). */
	"session.commands": z.object(SessionRef),
	/** Reload extensions, skills, prompt templates, themes, and context files (1.5). */
	"session.reload": z.object(SessionRef),

	"session.prompt": z.object({
		...SessionRef,
		text: Text,
		images: Images,
		streamingBehavior: StreamingBehaviorSchema.optional(),
	}),
	"session.steer": z.object({ ...SessionRef, text: Text, images: Images }),
	"session.followUp": z.object({ ...SessionRef, text: Text, images: Images }),
	"session.abort": z.object(SessionRef),
	"session.compact": z.object({ ...SessionRef, instructions: z.string().max(10_000).optional() }),

	/**
	 * `workspaceId` without `sessionId` (1.19): also report the model and thinking level a new
	 * session in that workspace starts with.
	 */
	"model.list": z
		.object({
			sessionId: Id.optional(),
			workspaceId: Id.optional(),
			/** Without `sessionId` (1.22): list the models of this runtime (default `pi`). */
			runtime: RuntimeId.optional(),
		})
		.optional(),
	"model.set": z.object({ ...SessionRef, provider: Id, modelId: Id, persist: z.boolean().optional() }),
	"thinking.set": z.object({ ...SessionRef, level: ThinkingLevelSchema, persist: z.boolean().optional() }),
	"model.setDefault": z.object({ provider: Id, modelId: Id }),

	"provider.list": z.object({}).optional(),
	/** Start an interactive sign-in. Progress arrives as `auth.*` events on this connection. */
	"provider.login": z.object({ providerId: Id, method: AuthMethodSchema }),
	"provider.loginRespond": z.object({
		flowId: Id,
		promptId: Id,
		value: z.string().max(20_000).optional(),
		cancelled: z.boolean().optional(),
	}),
	"provider.loginCancel": z.object({ flowId: Id }),
	"provider.logout": z.object({ providerId: Id }),
	"provider.saveCustom": z.object({
		provider: CustomProviderSchema,
		/** Saved to auth.json. Omit to keep the existing key. */
		apiKey: z.string().trim().min(1).max(20_000).optional(),
		/** A key held by the host (from `newapi.useToken`), used instead of `apiKey`. Added in 1.3. */
		apiKeyRef: Id.optional(),
		/** True when creating: fails if the id is already taken. */
		create: z.boolean().optional(),
	}),
	"provider.removeCustom": z.object({ providerId: Id }),
	/** List the models an endpoint offers (`GET /models`). Uses the saved key of `providerId` when `apiKey` is omitted. */
	"provider.probeModels": z.object({
		api: CustomProviderApiSchema,
		baseUrl: z.string().trim().min(1).max(2000),
		apiKey: z.string().trim().max(20_000).optional(),
		/** A key held by the host (from `newapi.useToken`). Added in 1.3. */
		apiKeyRef: Id.optional(),
		providerId: Id.optional(),
	}),

	/**
	 * Sign in to a NewAPI site (1.3), with a password or a system access token. The host keeps
	 * the login session in memory for this connection only.
	 */
	"newapi.login": z.union([
		z.object({
			baseUrl: z.string().trim().min(1).max(2000),
			username: z.string().trim().min(1).max(200),
			password: z.string().min(1).max(1000),
		}),
		z.object({
			baseUrl: z.string().trim().min(1).max(2000),
			accessToken: z.string().trim().min(1).max(2000),
			/** Numeric user id; older NewAPI versions require it next to an access token. */
			userId: z.number().int().positive().optional(),
		}),
	]),
	/** Answer the two-factor question of a `verify` login result. */
	"newapi.verify": z.object({ sessionId: Id, code: z.string().trim().min(1).max(100) }),
	"newapi.createToken": z.object({
		sessionId: Id,
		name: z.string().trim().min(1).max(50),
		group: z.string().max(100).optional(),
	}),
	/** Fetch the key of a token (kept on the host as `keyRef`) and the models it can use. */
	"newapi.useToken": z.object({ sessionId: Id, tokenId: z.number().int().positive() }),
	"newapi.close": z.object({ sessionId: Id }),
	/**
	 * Browser sign-in (1.4) for sites with NewAPI app authorization: the user signs in with any
	 * method and approves on the site, which creates a token for Pier. Only for local UIs,
	 * because the browser returns to a loopback address on the host's computer.
	 */
	"newapi.authorizeStart": z.object({ baseUrl: z.string().trim().min(1).max(2000) }),
	/** Resolve once the user approves (or reject when they decline, the flow expires or is cancelled). */
	"newapi.authorizeWait": z.object({ flowId: Id }),
	"newapi.authorizeCancel": z.object({ flowId: Id }),

	/**
	 * Loopback relays (1.28, this computer only): catch a browser sign-in's redirect on this
	 * computer for a sign-in that runs on another computer's host. `loopback.open` listens on a
	 * random `http://127.0.0.1:<port>/callback`; `loopback.next` resolves with the next callback,
	 * whose browser waits until `loopback.respond` gives the page to show (or a minute passes).
	 * Relays close after 11 minutes, with `loopback.close`, or when the connection closes.
	 */
	"loopback.open": z.object({}).optional(),
	"loopback.next": z.object({ relayId: Id }),
	"loopback.respond": z.object({
		relayId: Id,
		requestId: Id,
		status: z.number().int().min(200).max(599),
		title: z.string().max(200),
		detail: z.string().max(2000),
	}),
	"loopback.close": z.object({ relayId: Id }),

	/**
	 * 云链API personal center (1.6). The host keeps one login for the site (saved in the Pier
	 * directory, so it survives restarts) and never hands its credentials or token keys to clients.
	 */
	"account.status": z.object({}).optional(),
	/**
	 * Switch the line (1.29), one of `AccountStatus.lines`. The saved login moves along (every line
	 * reaches the same site); a sign-in waiting for its two-factor code is dropped.
	 */
	"account.setLine": z.object({ line: z.string().trim().min(1).max(50) }),
	"account.login": z.union([
		z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(1000) }),
		z.object({ accessToken: z.string().trim().min(1).max(2000), userId: z.number().int().positive().optional() }),
	]),
	"account.verify": z.object({ code: z.string().trim().min(1).max(100) }),
	/**
	 * Browser sign-in (1.16) when `AccountSite.browserLogin`: the user signs in on the website with
	 * any method and approves Pier, which gets a login session of its own. The browser returns to
	 * a loopback address on the host's computer, unless the client passes `redirectUri` (1.28): a
	 * loopback address on the client's computer (`loopback.open`), whose callbacks the client
	 * forwards with `account.authorizeCallback`. That lets the browser of the computer in front of
	 * the user sign in another computer's Pier.
	 */
	"account.authorizeStart": z.object({ redirectUri: z.string().trim().min(1).max(200).optional() }).optional(),
	/** Resolve once the user approves (reject when they decline, the flow expires or is cancelled). */
	"account.authorizeWait": z.object({ flowId: Id }),
	"account.authorizeCancel": z.object({ flowId: Id }),
	/**
	 * Hand over a browser callback of a flow started with `redirectUri` (1.28): the query string
	 * of the redirect. Resolves after the host handled it, with the page the browser should show;
	 * a successful sign-in also settles `account.authorizeWait`.
	 */
	"account.authorizeCallback": z.object({ flowId: Id, query: z.string().max(8000) }),
	/** Email a registration verification code. */
	"account.sendCode": z.object({ email: z.string().trim().min(3).max(50) }),
	/** Register with a password, then sign in. */
	"account.register": z.object({
		username: z.string().trim().min(1).max(20),
		password: z.string().min(8).max(128),
		email: z.string().trim().max(50).optional(),
		code: z.string().trim().max(100).optional(),
		/** Inviter's code. */
		affCode: z.string().trim().max(32).optional(),
	}),
	"account.overview": z.object({}).optional(),
	"account.createToken": z.object({ name: z.string().trim().min(1).max(50), group: z.string().max(100).optional() }),
	/** Fetch a token's key (kept on the host as `keyRef`, usable in `provider.saveCustom`) and its models. */
	"account.useToken": z.object({ tokenId: z.number().int().positive() }),
	"account.logout": z.object({}).optional(),

	/**
	 * pi extensions and packages (1.8). Without `workspaceId` only user settings
	 * (`<agentDir>/settings.json`) apply; with it, also that workspace's `.pi/settings.json`.
	 */
	"extension.list": z.object({ workspaceId: Id.optional() }).optional(),
	/** Install a pi package (`npm:<name>[@version]`, `git:<host>/<path>[@ref]`, a git URL, or an absolute path). */
	"extension.install": z.object({
		source: z.string().trim().min(1).max(4096),
		scope: ExtensionScopeSchema.optional(),
		workspaceId: Id.optional(),
	}),
	/** Remove a package from settings and uninstall it (npm / git). `source` as listed. */
	"extension.remove": z.object({
		source: z.string().min(1).max(4096),
		scope: ExtensionScopeSchema,
		workspaceId: Id.optional(),
	}),
	/** Update one package, or every unpinned package when `source` is omitted. */
	"extension.update": z
		.object({ source: z.string().min(1).max(4096).optional(), workspaceId: Id.optional() })
		.optional(),
	"extension.checkUpdates": z.object({ workspaceId: Id.optional() }).optional(),
	/** Enable or disable one listed resource in the settings of its own scope. */
	"extension.setEnabled": z.object({
		type: ExtensionResourceTypeSchema,
		path: z.string().min(1).max(4096),
		enabled: z.boolean(),
		workspaceId: Id.optional(),
	}),
	/**
	 * Delete a top-level resource: an auto-discovered file or skill/extension directory moves
	 * to Pier's trash; a settings path entry is removed from settings (the files stay).
	 * `type` (1.30) defaults to extensions for older clients.
	 */
	"extension.delete": z.object({
		type: ExtensionResourceTypeSchema.optional(),
		path: z.string().min(1).max(4096),
		workspaceId: Id.optional(),
	}),
	/**
	 * Search the pi package gallery (https://pi.dev/packages, 1.20) from the host's computer,
	 * falling back to the npm registry. `page` starts at 1. Install a result with `extension.install`.
	 */
	"extension.search": z
		.object({
			query: z.string().trim().max(200).optional(),
			type: ExtensionCatalogTypeSchema.optional(),
			sort: ExtensionCatalogSortSchema.optional(),
			page: z.number().int().min(1).max(1000).optional(),
		})
		.optional(),

	/**
	 * pi settings files (1.15): the user settings (`<agentDir>/settings.json`) and, with
	 * `workspaceId`, that workspace's `.pi/settings.json`, as stored (not merged).
	 */
	"settings.get": z.object({ workspaceId: Id.optional() }).optional(),
	/**
	 * Set or remove individual settings, keeping everything else in the file. Each change names
	 * a key path (`["compaction", "enabled"]`); omit `value` to remove the key. `project` scope
	 * needs `workspaceId`. `reload: false` skips reloading open sessions (terminal-only settings).
	 */
	"settings.update": z.object({
		scope: ExtensionScopeSchema,
		workspaceId: Id.optional(),
		changes: z
			.array(z.object({ path: SettingsKeyPath, value: z.unknown().optional() }))
			.min(1)
			.max(200),
		reload: z.boolean().optional(),
	}),
	/**
	 * Replace a settings file with `text`, which must be a JSON object. With `expectedModifiedAt`
	 * fails with `CONFLICT` when the file changed since it was read.
	 */
	"settings.write": z.object({
		scope: ExtensionScopeSchema,
		workspaceId: Id.optional(),
		text: z.string().max(1024 * 1024),
		expectedModifiedAt: z.string().max(64).optional(),
	}),

	/**
	 * Configuration files of Claude Code or Codex (1.23): the user file and, with `workspaceId`,
	 * that workspace's files, as stored (not merged).
	 */
	"agentConfig.get": z.object({ runtime: AgentConfigRuntimeSchema, workspaceId: Id.optional() }),
	/**
	 * Set or remove individual settings of one file, keeping everything else (TOML comments and
	 * formatting included). Like `settings.update`; `project` and `local` scopes need `workspaceId`.
	 * A change with `apiKeyRef` (1.25) sets the key behind a reference from `account.useToken` /
	 * `newapi.useToken` instead of `value`, so the key never reaches the client.
	 */
	"agentConfig.update": z.object({
		runtime: AgentConfigRuntimeSchema,
		scope: AgentConfigScopeSchema,
		workspaceId: Id.optional(),
		changes: z
			.array(
				z
					.object({ path: SettingsKeyPath, value: z.unknown().optional(), apiKeyRef: Id.optional() })
					.refine((c) => c.apiKeyRef === undefined || c.value === undefined, {
						message: "A change sets either value or apiKeyRef",
					}),
			)
			.min(1)
			.max(200),
	}),
	/** Replace one file with `text` (a JSON object, or TOML for Codex). Like `settings.write`. */
	"agentConfig.write": z.object({
		runtime: AgentConfigRuntimeSchema,
		scope: AgentConfigScopeSchema,
		workspaceId: Id.optional(),
		text: z.string().max(1024 * 1024),
		expectedModifiedAt: z.string().max(64).optional(),
	}),

	"ui.respond": z.object({ ...SessionRef, requestId: Id, response: UiResponseSchema }),

	/**
	 * Start the user's shell in a pseudo-terminal on the host's computer (1.18), for this
	 * connection only: output arrives as `terminal.output` events, the end as `terminal.exit`,
	 * and the shell is hung up when the connection closes. `cwd` must be absolute; the shell
	 * starts in the home directory when it is omitted or missing. `UNSUPPORTED` unless
	 * `HostInfo.terminals` is set.
	 */
	"terminal.open": z.object({
		cwd: z.string().min(1).max(4096).optional(),
		cols: z.number().int().min(2).max(1000),
		rows: z.number().int().min(2).max(1000),
	}),
	/** Type into a terminal. `binary` input carries one byte per character (xterm's `onBinary`). */
	"terminal.write": z.object({
		terminalId: Id,
		data: z.string().min(1).max(1_000_000),
		binary: z.boolean().optional(),
	}),
	"terminal.resize": z.object({
		terminalId: Id,
		cols: z.number().int().min(2).max(1000),
		rows: z.number().int().min(2).max(1000),
	}),
	/** Hang up a terminal; its `terminal.exit` event follows. */
	"terminal.close": z.object({ terminalId: Id }),

	"device.list": z.object({}).optional(),
	"device.revoke": z.object({ deviceId: Id }),
	"device.rename": z.object({ deviceId: Id, name: z.string().trim().min(1).max(100) }),
	"pairing.start": z.object({}).optional(),
	"pairing.cancel": z.object({}).optional(),
	"pairing.respond": z.object({ requestId: Id, accept: z.boolean() }),

	"remote.status": z.object({}).optional(),
	"remote.configure": z.object({
		enabled: z.boolean().optional(),
		port: z.number().int().min(1024).max(65535).optional(),
		/** Pier Relay settings (1.26). `token: null` removes the saved token. */
		relay: z
			.object({
				enabled: z.boolean().optional(),
				url: z.string().trim().max(500).optional(),
				token: z.string().max(500).nullable().optional(),
			})
			.optional(),
		/** Let relayed connections move to a peer-to-peer path (1.26). */
		p2p: z.boolean().optional(),
	}),

	/** Computers this host paired with as a device (1.9). */
	"peer.list": z.object({}).optional(),
	/**
	 * Pair with another computer from its `pier://pair?...` link, using this host's key as the
	 * device key. Resolves after the other computer's user allowed (or declined) it.
	 */
	"peer.pair": z.object({ uri: z.string().min(1).max(4096) }),
	/**
	 * Replace the `host:port` addresses used to reach a paired computer (e.g. after its IP
	 * changed). The pinned host key is unchanged, so a different computer at a new address is
	 * still refused.
	 */
	"peer.update": z
		.object({
			peerId: Id,
			addresses: z.array(z.string().trim().max(300).regex(PEER_ADDRESS, "Expected host:port")).max(16),
			/** Pier Relay URLs to try after the addresses (1.26); omitted keeps the saved ones. */
			relays: z.array(z.string().trim().min(1).max(500)).max(4).optional(),
		})
		.refine((p) => p.addresses.length > 0 || (p.relays?.length ?? 0) > 0, {
			message: "At least one address or relay is required",
		}),
	/** Forget a paired computer here (its device list is not changed). */
	"peer.remove": z.object({ peerId: Id }),
} as const;

export type MethodName = keyof typeof MethodParamsSchemas;

export const METHOD_NAMES = Object.keys(MethodParamsSchemas) as MethodName[];

export function isMethodName(method: string): method is MethodName {
	return Object.hasOwn(MethodParamsSchemas, method);
}

/**
 * Methods that only the local desktop UI may call: managing who can reach this computer
 * (paired devices, pairing, remote access, paired computers). A paired device is fully
 * trusted otherwise (1.10): it can manage workspaces and policies, edit files, and
 * configure models, providers, accounts, and extensions.
 */
export const LOCAL_ONLY_METHODS: ReadonlySet<MethodName> = new Set([
	"portForward.open",
	"portForward.list",
	"portForward.close",
	"browser.open",
	"browser.list",
	"browser.close",
	"device.list",
	"device.revoke",
	"device.rename",
	"pairing.start",
	"pairing.cancel",
	"pairing.respond",
	"remote.status",
	"remote.configure",
	"peer.list",
	"peer.pair",
	"peer.update",
	"peer.remove",
	"loopback.open",
	"loopback.next",
	"loopback.respond",
	"loopback.close",
]);

export interface HelloResult {
	protocolVersion: string;
	host: HostInfo;
	connectionId: string;
	/** For remote connections: the paired device this connection authenticated as. */
	device?: { id: string; name: string };
}

export interface ForkPoint {
	entryId: string;
	text: string;
}

export interface SubscribeResult {
	/** `replay`: events after `sinceSeq` follow. `snapshot`: a `session.snapshot` event follows. */
	mode: "replay" | "snapshot";
	currentSeq: number;
	/** Identifies the event log instance; seqs from another epoch are meaningless. */
	epoch: string;
}

export interface MethodResults {
	"host.ports": HostPorts;
	"portForward.open": PortForward;
	"portForward.list": { forwards: PortForward[] };
	"portForward.close": { closed: boolean };
	"skills.list": ResourceList<SkillInfo>;
	"skills.read": SkillDocument;
	"skills.save": SkillDocument;
	"skills.import": SkillDocument;
	"skills.setEnabled": { changed: boolean };
	"skills.delete": { deleted: boolean };
	"mcp.list": ResourceList<McpServerInfo>;
	"mcp.save": McpServerInfo;
	"mcp.setEnabled": McpServerInfo;
	"mcp.delete": { deleted: boolean };
	"mcp.test": McpTestResult;
	"tunnel.open": { tunnelId: string };
	"tunnel.read": { data: string; end: boolean };
	"tunnel.write": { written: number };
	"tunnel.close": { closed: boolean };
	"browser.open": LocalBrowserInfo;
	"browser.list": { browsers: LocalBrowserInfo[] };
	"browser.close": { closed: boolean };
	"browser.attach": { attached: true };
	"browser.detach": { detached: boolean };
	"browser.action": BrowserResult;
	"browser.result": { accepted: boolean };
	"task.list": { tasks: ScheduledTask[] };
	"task.create": { task: ScheduledTask };
	"task.update": { task: ScheduledTask };
	"task.setStatus": { task: ScheduledTask };
	"task.delete": { deleted: boolean };
	"task.run": { run: ScheduledTaskRun };
	"task.stop": { stopped: boolean };
	"task.runs": { runs: ScheduledTaskRun[] };
	"task.readRun": { run: ScheduledTaskRun };
	"host.hello": HelloResult;
	"host.info": HostInfo;
	"host.listDirectories": HostDirectoryListing;
	"host.stats": HostStats;
	"host.packageManagers": PackageManagerDetection;
	"update.status": AppUpdateStatus;
	"update.check": AppUpdateStatus;
	"update.install": AppUpdateStatus;
	"workspace.list": { workspaces: WorkspaceInfo[] };
	"workspace.add": { workspace: WorkspaceInfo };
	"workspace.remove": { removed: boolean };
	"workspace.setPolicy": { workspace: WorkspaceInfo };
	"workspace.files": WorkspaceFilesResult;
	"workspace.readFile": WorkspaceFileContent;
	"workspace.previewFile": WorkspaceFileContent;
	"workspace.authorizeFilePreview": WorkspaceFileContent;
	"workspace.writeFile": WorkspaceFileWriteResult;
	"workspace.deletePath": WorkspacePathDeleteResult;
	"workspace.readBytes": WorkspaceFileBytes;
	"workspace.uploadStart": WorkspaceUploadStart;
	"workspace.uploadChunk": { received: number };
	"workspace.uploadFinish": WorkspaceFileWriteResult;
	"workspace.uploadCancel": { cancelled: boolean };
	"git.status": GitStatus;
	"git.diff": GitDiffResult;
	"git.log": { commits: GitCommitInfo[] };
	"git.show": GitDiffResult;
	"git.branches": { branches: GitBranchInfo[] };
	"git.stage": GitCommandResult;
	"git.unstage": GitCommandResult;
	"git.discard": GitCommandResult;
	"git.commit": GitCommitResult;
	"git.checkout": GitCommandResult;
	"git.deleteBranch": GitCommandResult;
	"git.fetch": GitCommandResult;
	"git.pull": GitCommandResult;
	"git.push": GitCommandResult;
	"git.stash": GitCommandResult;
	"git.init": GitCommandResult;
	"runtime.list": { runtimes: AgentRuntimeInfo[] };
	"runtime.installStatus": AgentInstallationResult;
	"runtime.install": AgentInstallationResult;
	"session.list": { sessions: SessionSummary[] };
	"session.create": { session: SessionSummary };
	"session.open": { session: SessionSummary };
	"session.close": { closed: boolean };
	"session.delete": { deleted: boolean };
	"session.archive": { session: SessionSummary };
	"session.cleanup": SessionCleanupResult;
	"session.forkPoints": { points: ForkPoint[] };
	"session.fork": { session: SessionSummary; selectedText?: string };
	"session.rename": { session: SessionSummary };
	"session.subscribe": SubscribeResult;
	"session.unsubscribe": { unsubscribed: boolean };
	"session.snapshot": SessionSnapshot;
	"session.commands": { commands: SessionCommandInfo[] };
	"session.reload": { reloaded: true };
	"session.prompt": { accepted: true };
	"session.steer": { queue: QueueState };
	"session.followUp": { queue: QueueState };
	"session.abort": { aborted: true };
	"session.compact": { summary: string; tokensBefore: number };
	/**
	 * `current` / `thinkingLevel`: the session's, or with only `workspaceId` (1.19) what a new
	 * session there starts with. `thinkingLevel` is new in 1.19.
	 */
	"model.list": { models: ModelInfo[]; current?: ModelInfo; thinkingLevel?: ThinkingLevel };
	"model.set": { model: ModelInfo };
	"thinking.set": { level: string };
	"model.setDefault": { defaultModel: DefaultModelRef };
	"provider.list": ProviderListResult;
	"provider.login": { flowId: string };
	"provider.loginRespond": { accepted: boolean };
	"provider.loginCancel": { cancelled: boolean };
	"provider.logout": { removed: boolean };
	"provider.saveCustom": { provider: ProviderInfo; defaultModel?: DefaultModelRef };
	"provider.removeCustom": { removed: boolean };
	/** Capabilities pi's model catalog knows for an id are filled in (1.6). */
	"provider.probeModels": { models: CustomModel[] };
	"newapi.login": NewApiLoginResult;
	"newapi.verify": NewApiLoginResult;
	"newapi.createToken": { tokenId: number; tokens: NewApiToken[] };
	"newapi.useToken": {
		keyRef: string;
		/** Models the token can call (`GET /v1/models` with its key), with the detected wire API (1.7). */
		models: NewApiModel[];
		/** Why the model list could not be read, when it could not. */
		modelsError?: string;
	};
	"newapi.close": { closed: boolean };
	"newapi.authorizeStart": NewApiAuthorizeStart;
	"newapi.authorizeWait": NewApiAuthorizeResult;
	"newapi.authorizeCancel": { cancelled: boolean };
	"account.status": AccountStatus;
	"account.setLine": AccountStatus;
	"account.login": AccountLoginResult;
	"account.verify": AccountLoginResult;
	"account.authorizeStart": AccountAuthorizeStart;
	"account.authorizeWait": AccountLoginResult;
	"account.authorizeCancel": { cancelled: boolean };
	"account.authorizeCallback": LoopbackCallbackPage;
	"loopback.open": { relayId: string; redirectUri: string; expiresAt: string };
	"loopback.next": LoopbackRequest;
	"loopback.respond": { responded: boolean };
	"loopback.close": { closed: boolean };
	"account.sendCode": { sent: true };
	"account.register": AccountLoginResult;
	"account.overview": AccountOverview;
	"account.createToken": { tokenId: number; tokens: NewApiToken[] };
	"account.useToken": {
		keyRef: string;
		models: NewApiModel[];
		modelsError?: string;
	};
	"account.logout": { loggedOut: boolean };
	"extension.list": ExtensionListResult;
	"extension.install": { package?: ExtensionPackageInfo; reload: ExtensionReloadSummary };
	"extension.remove": { removed: boolean; reload: ExtensionReloadSummary };
	"extension.update": { reload: ExtensionReloadSummary };
	"extension.checkUpdates": { updates: ExtensionUpdateInfo[] };
	"extension.setEnabled": { resource: ExtensionResourceInfo; reload: ExtensionReloadSummary };
	"extension.delete": { deleted: boolean; reload: ExtensionReloadSummary };
	"extension.search": ExtensionCatalogResult;
	"settings.get": PiSettingsResult;
	"settings.update": PiSettingsChangeResult;
	"settings.write": PiSettingsChangeResult;
	"agentConfig.get": AgentConfigResult;
	"agentConfig.update": AgentConfigChangeResult;
	"agentConfig.write": AgentConfigChangeResult;
	"ui.respond": { accepted: boolean };
	"terminal.open": TerminalInfo;
	"terminal.write": { written: boolean };
	"terminal.resize": { resized: boolean };
	"terminal.close": { closed: boolean };
	"device.list": { devices: DeviceInfo[] };
	"device.revoke": { revoked: boolean };
	"device.rename": { device: DeviceInfo };
	"pairing.start": {
		uri: string;
		expiresAt: string;
		addresses: string[] /** Relays in the pairing code (1.26). */;
		relays?: string[];
	};
	"pairing.cancel": { cancelled: boolean };
	"pairing.respond": { accepted: boolean };
	"remote.status": RemoteAccessStatus;
	"remote.configure": RemoteAccessStatus;
	"peer.list": { peers: PeerInfo[] };
	"peer.pair": { peer: PeerInfo };
	"peer.update": { peer: PeerInfo };
	"peer.remove": { removed: boolean };
}

export type MethodParams<M extends MethodName> = z.input<(typeof MethodParamsSchemas)[M]>;
export type ParsedMethodParams<M extends MethodName> = z.output<(typeof MethodParamsSchemas)[M]>;
export type MethodResult<M extends MethodName> = MethodResults[M];
