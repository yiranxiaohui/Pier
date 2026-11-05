#!/usr/bin/env node
/**
 * pier-cli: interactive debug client for a running Pier Host.
 *
 * Connects using <pier-dir>/run/host.json (written by pier-host) unless --url/--token
 * or PIER_URL/PIER_LOCAL_TOKEN are given.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CompleterResult, createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
	type AgentRuntimeInfo,
	type DeviceInfo,
	type EventFrame,
	type MethodResult,
	type ModelInfo,
	type PairingRequest,
	type RemoteAccessStatus,
	type SessionSnapshot,
	type SessionSummary,
	type ThinkingLevel,
	ThinkingLevelSchema,
	type UiRequest,
	type UiResponse,
	type WorkspaceInfo,
} from "@pier/protocol";
import { parseNewArgs, requireAvailable, resolveRuntime, runtimeName } from "./cli-agents.ts";
import { completeCliLine, matchModel, oneLine } from "./cli-complete.ts";
import { exitCli } from "./cli-exit.ts";
import { type PickerOptions, runTerminalPicker } from "./cli-picker.ts";
import { PierClient } from "./client.ts";
import { parseSshPairRequest, runSshPair } from "./ssh-pair.ts";

export const PIER_CLI_VERSION = "0.2.57";

const HELP = `Commands:
  /ws                        list workspaces
  /ws add <path> [policy]    register a workspace (policy: ask|smart|auto; ~ is the home directory)
  /ws use [n|id]             select a workspace (no argument: pick with ↑/↓)
  /ws policy <ask|smart|auto> set the current workspace's approval policy
  /agents                    list the agents on this computer (pi, Claude Code, Codex)
  /sessions                  list sessions in the current workspace
  /new [-a <agent>] [name]   create a session (default agent: pi) and attach to it
  /open [n|id]               open a session of /sessions and attach (no argument: pick with ↑/↓)
  /status                    show the attached session state
  /rename <name>             rename the attached session
  /fork [n]                  list fork points, or fork at point n
  /steer <text>              steer the running agent
  /follow <text>             queue a follow-up
  /abort                     abort the current run
  /compact [instructions]    compact the context
  /models                    list available models (numbered, * = current)
  /models <agent>            list the models of another agent (see /agents)
  /model                     pick a model with ↑/↓ and Enter (type to filter, Esc cancels)
  /model <n|provider/id|id>  switch model directly (a unique part of the id or name also works)
  /thinking [level]          pick or set the thinking level
  /allow [session]           approve the oldest pending approval (once / for session)
  /deny [reason]             deny the oldest pending approval
  /yes, /no                  answer a pending confirm
  /answer <text>             answer a pending select/input/editor
  /cancel                    cancel the oldest pending UI request
  /remote [on|off|port <n>]  show or change remote access (LAN) settings
  /pair                      show a pairing link for the mobile app (see /pair yes|no)
  /pair yes|no               allow or decline the device waiting for confirmation
  /devices                   list paired devices
  /revoke [n|id]             revoke a paired device and disconnect it (no argument: pick with ↑/↓)
  /drop                      simulate a network drop (tests reconnect + resume)
  /quit                      exit
Anything else is sent as a prompt (as a follow-up while the agent is running).
Press Tab to complete commands, models, thinking levels, agents, options and directories, and the
numbers of sessions, workspaces, devices, fork points and answers (press Tab twice to list them).`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

interface Discovery {
	url: string;
	token?: string;
}

function discover(values: { url?: string; token?: string; "pier-dir"?: string }): Discovery {
	const url = values.url ?? process.env.PIER_URL;
	const token = values.token ?? process.env.PIER_LOCAL_TOKEN;
	if (url) return token ? { url, token } : { url };
	const pierDir = values["pier-dir"] ?? process.env.PIER_DIR ?? join(homedir(), ".pier");
	const file = join(pierDir, "run", "host.json");
	try {
		const runtime = JSON.parse(readFileSync(file, "utf8")) as { url: string; token: string };
		return { url: runtime.url, token: token ?? runtime.token };
	} catch {
		throw new Error(`No running host found (${file}). Start one with pier run, or pass --url/--token.`);
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string; name?: string }) => {
			if (part.type === "text") return part.text ?? "";
			if (part.type === "toolCall") return dim(`[tool call: ${part.name}]`);
			return "";
		})
		.join("");
}

/** A session's name, or the start of its first message. */
function sessionTitle(session: SessionSummary): string {
	return session.name ?? oneLine(session.firstMessage, 60);
}

function workspaceLabel(workspace: WorkspaceInfo): string {
	return `${workspace.name} ${workspace.path} [${workspace.policy}]`;
}

function deviceLabel(device: DeviceInfo): string {
	return `${device.name}${device.platform ? ` ${device.platform}` : ""}${device.connected ? " online" : ""}`;
}

const isHomePath = (path: string) => path === "~" || /^~[\\/]/.test(path);

/** Completion lookups run while readline waits for the result, so they must not hang. */
const QUICK = { timeoutMs: 3_000 };

class Cli {
	private workspaces: WorkspaceInfo[] = [];
	private workspace: WorkspaceInfo | undefined;
	private sessions: SessionSummary[] = [];
	private sessionId: string | undefined;
	private unsubscribe: (() => Promise<void>) | undefined;
	private readonly pendingUi = new Map<string, UiRequest>();
	private streaming = false;
	private midLine = false;
	private devices: DeviceInfo[] = [];
	private readonly pairingRequests = new Map<string, PairingRequest>();
	private modelCache: { sessionId: string | undefined; at: number; result: MethodResult<"model.list"> } | undefined;
	/** The last numbered model listing, which `/model <n>` refers to. */
	private listedModels: ModelInfo[] = [];
	/** Agent runtimes from the last `runtime.list`, which `/new -a <n>` and `/models <n>` refer to. */
	private runtimes: AgentRuntimeInfo[] = [];
	/** Display name of the attached session's agent, shown before its messages. */
	private agent = "pi";

	/** Output that arrived while a picker was open, written once it closes. */
	private held: Array<() => void> | undefined;

	constructor(
		private readonly client: PierClient,
		private readonly print: (line: string) => void,
		/** Arrow-key picker; absent when stdin or stdout is not a terminal. */
		private readonly picker?: <T>(options: PickerOptions<T>) => Promise<T | undefined>,
	) {}

	/** Let the user pick with the arrow keys, keeping other output from breaking the list. */
	private async choose<T>(options: PickerOptions<T>): Promise<T | undefined> {
		if (!this.picker) return undefined;
		this.held = [];
		try {
			return await this.picker(options);
		} finally {
			const held = this.held;
			this.held = undefined;
			for (const flush of held) flush();
		}
	}

	private write(text: string): void {
		if (this.held) {
			this.held.push(() => this.write(text));
			return;
		}
		process.stdout.write(text);
		this.midLine = !text.endsWith("\n");
	}

	private line(text: string): void {
		if (this.held) {
			this.held.push(() => this.line(text));
			return;
		}
		if (this.midLine) process.stdout.write("\n");
		this.midLine = false;
		this.print(text);
	}

	async init(): Promise<void> {
		const { workspaces } = await this.client.request("workspace.list");
		this.workspaces = workspaces;
		this.workspace = workspaces[0];
		this.line(`Connected to ${bold(this.client.host?.hostName ?? "host")} (pi ${this.client.host?.piVersion}).`);
		if (this.workspace)
			this.line(`Workspace: ${this.workspace.name} ${dim(this.workspace.path)} [${this.workspace.policy}]`);
		else this.line(`No workspaces yet. Add one with ${bold("/ws add <path>")}.`);
		this.client.onEvent((frame) => {
			if (frame.sessionId) return;
			const event = frame.event;
			if (event.type === "host.notice") this.line(yellow(`[host] ${String(event.message)}`));
			else if (event.type === "pairing.request") {
				const request = event.request as PairingRequest;
				this.pairingRequests.set(request.id, request);
				this.line(
					yellow(
						`[pairing] ${bold(request.device.name)} (${request.device.platform ?? "?"}, fingerprint ${request.fingerprint}${request.address ? `, from ${request.address}` : ""}) wants to connect. Answer with /pair yes or /pair no.`,
					),
				);
			} else if (event.type === "pairing.resolved") {
				this.pairingRequests.delete(String(event.requestId));
				this.line(dim(`[pairing ${String(event.resolution)}]`));
			}
		});
		this.client.onState((state) => {
			if (state === "reconnecting") this.line(yellow("[connection lost, reconnecting…]"));
			if (state === "open") this.line(green("[reconnected; resumed from last seq]"));
			if (state === "closed") this.line(red("[disconnected]"));
		});
		await this.showAgentsHint();
	}

	private requireSession(): string {
		if (!this.sessionId) throw new Error("No session attached. Use /new or /open.");
		return this.sessionId;
	}

	private requireWorkspace(): WorkspaceInfo {
		if (!this.workspace) throw new Error("No workspace selected. Use /ws add <path>.");
		return this.workspace;
	}

	private async fetchRuntimes(): Promise<AgentRuntimeInfo[]> {
		this.runtimes = (await this.client.request("runtime.list")).runtimes;
		return this.runtimes;
	}

	/** One line naming the host's agents, so `/new -a` is discoverable. Skipped for pi-only hosts (before 1.22). */
	private async showAgentsHint(): Promise<void> {
		let runtimes: AgentRuntimeInfo[];
		try {
			runtimes = await this.fetchRuntimes();
		} catch {
			return;
		}
		if (runtimes.length < 2) return;
		const names = runtimes.map((r) => (r.available ? r.name : dim(`${r.name} (unavailable)`)));
		this.line(`Agents: ${names.join(", ")} ${dim("· /agents, /new -a <agent>")}`);
	}

	private async listAgents(): Promise<void> {
		const runtimes = await this.fetchRuntimes();
		for (const [i, r] of runtimes.entries()) {
			const status = r.available ? green("available") : red(`unavailable${r.reason ? `: ${r.reason}` : ""}`);
			this.line(`${i + 1}. ${bold(r.name)} ${dim(`${r.id}${r.version ? ` ${r.version}` : ""}`)} ${status}`);
		}
		this.line(dim("New session: /new -a <n|id|name> [name] (e.g. /new -a claude). Models: /models <agent>."));
	}

	private async attach(session: SessionSummary): Promise<void> {
		await this.unsubscribe?.();
		this.pendingUi.clear();
		this.sessionId = session.id;
		this.agent = runtimeName(session.runtime, this.runtimes);
		// Each runtime has its own models; drop the listing of the previous session.
		this.modelCache = undefined;
		this.listedModels = [];
		const sub = await this.client.subscribe(session.id, (frame) => this.onSessionEvent(frame), {
			workspaceId: session.workspaceId,
		});
		this.unsubscribe = () => sub.unsubscribe();
		this.line(`Attached to session ${bold(session.name ?? session.id)} ${dim(`(${this.agent})`)}`);
	}

	private onSessionEvent(frame: EventFrame): void {
		const event = frame.event;
		if (frame.sessionId && frame.sessionId !== this.sessionId && event.type !== "session.replaced") return;
		switch (event.type) {
			case "session.snapshot": {
				const snapshot = event.snapshot as SessionSnapshot;
				this.agent = runtimeName(snapshot.session.runtime, this.runtimes);
				this.pendingUi.clear();
				for (const request of snapshot.pendingUi) this.pendingUi.set(request.id, request);
				const visible = (snapshot.messages as Array<{ role: string; content: unknown }>).filter(
					(m) => m.role === "user" || m.role === "assistant",
				);
				this.line(dim(`— snapshot: ${visible.length} messages, seq ${snapshot.seq}, ${snapshot.session.state} —`));
				for (const message of visible.slice(-6)) {
					const text = textOf(message.content).trim();
					if (text) this.line(`${message.role === "user" ? bold("you") : bold(this.agent)}: ${text.slice(0, 500)}`);
				}
				for (const request of snapshot.pendingUi) this.showUiRequest(request);
				this.streaming = snapshot.session.state !== "idle";
				break;
			}
			case "message_update": {
				const inner = event.assistantMessageEvent as { type: string; delta?: string };
				if (inner.type === "text_delta" && inner.delta) this.write(inner.delta);
				else if (inner.type === "thinking_delta" && inner.delta) this.write(dim(inner.delta));
				break;
			}
			case "message_start": {
				const message = event.message as { role?: string } | undefined;
				if (message?.role === "assistant") this.line(bold(`${this.agent}: `));
				break;
			}
			case "tool_execution_start": {
				const args = JSON.stringify(event.args ?? {});
				this.line(dim(`⚙ ${String(event.toolName)} ${args.length > 200 ? `${args.slice(0, 200)}…` : args}`));
				break;
			}
			case "tool_execution_end":
				this.line(event.isError ? red(`✗ ${String(event.toolName)} failed`) : dim(`✓ ${String(event.toolName)}`));
				break;
			case "queue_update": {
				const steering = (event.steering as string[]).length;
				const followUp = (event.followUp as string[]).length;
				if (steering + followUp > 0) this.line(dim(`[queue: ${steering} steering, ${followUp} follow-up]`));
				break;
			}
			case "agent_settled":
				this.streaming = false;
				this.line(dim("— done —"));
				break;
			case "session.status":
				this.streaming = event.state !== "idle";
				break;
			case "auto_retry_start":
				this.line(
					yellow(`[retrying ${String(event.attempt)}/${String(event.maxAttempts)}: ${String(event.errorMessage)}]`),
				);
				break;
			case "compaction_end":
				this.line(dim(`[compaction ${event.aborted ? "aborted" : "finished"}]`));
				break;
			case "ui.request":
				this.pendingUi.set((event.request as UiRequest).id, event.request as UiRequest);
				this.showUiRequest(event.request as UiRequest);
				break;
			case "ui.resolved": {
				const request = this.pendingUi.get(String(event.requestId));
				this.pendingUi.delete(String(event.requestId));
				if (request) {
					const response = event.response as UiResponse | undefined;
					const answer = response?.decision ?? response?.value ?? response?.confirmed ?? "";
					this.line(dim(`[${request.kind} ${String(event.resolution)}${answer === "" ? "" : `: ${String(answer)}`}]`));
				}
				break;
			}
			case "ui.notify":
				this.line(yellow(`[${String(event.level)}] ${String(event.message)}`));
				break;
			case "extension.error":
				this.line(red(`[extension error] ${String(event.extensionPath)}: ${String(event.error)}`));
				break;
			case "session.replaced": {
				const next = event.session as SessionSummary;
				this.sessionId = next.id;
				this.agent = runtimeName(next.runtime, this.runtimes);
				this.line(yellow(`[session replaced → ${next.id}]`));
				break;
			}
			case "session.closed":
				this.line(yellow(`[session closed: ${String(event.reason)}]`));
				if (frame.sessionId === this.sessionId) this.sessionId = undefined;
				break;
		}
	}

	private showUiRequest(request: UiRequest): void {
		if (request.kind === "approval" && request.approval) {
			const a = request.approval;
			const tag = a.severity === "high" ? red("HIGH RISK") : yellow("approval");
			this.line(`${tag} ${bold(a.toolName)}: ${a.summary}`);
			this.line(dim(`  reason: ${a.reason}`));
			this.line(
				dim(
					`  /allow  /deny [reason]${a.sessionAllowable ? `  /allow session (${a.sessionScope ?? "same kind"})` : ""}`,
				),
			);
			return;
		}
		this.line(`${yellow(`[${request.kind}]`)} ${request.title}${request.message ? ` — ${request.message}` : ""}`);
		for (const [i, option] of (request.options ?? []).entries()) this.line(dim(`  ${i + 1}. ${option}`));
		this.line(dim(request.kind === "confirm" ? "  /yes or /no" : "  /answer <text> or /cancel"));
	}

	private oldestPending(kind?: UiRequest["kind"]): UiRequest {
		const request = [...this.pendingUi.values()].find((r) => !kind || r.kind === kind);
		if (!request) throw new Error(kind ? `No pending ${kind} request` : "No pending UI request");
		return request;
	}

	private async respond(request: UiRequest, response: UiResponse): Promise<void> {
		const { accepted } = await this.client.request("ui.respond", {
			sessionId: request.sessionId,
			requestId: request.id,
			response,
		});
		if (!accepted) this.line(dim("[already resolved by another client]"));
	}

	private pick<T extends { id: string }>(items: T[], ref: string): T {
		const index = Number(ref);
		const item = Number.isInteger(index) && index >= 1 ? items[index - 1] : items.find((i) => i.id === ref);
		if (!item) throw new Error(`No match for ${ref}`);
		return item;
	}

	/** `model.list` for the attached session, reused for `maxAgeMs`. */
	private async fetchModels(maxAgeMs = 0, timeoutMs?: number): Promise<MethodResult<"model.list">> {
		const sessionId = this.sessionId;
		const cached = this.modelCache;
		if (cached && cached.sessionId === sessionId && Date.now() - cached.at <= maxAgeMs) return cached.result;
		const result = await this.client.request(
			"model.list",
			sessionId ? { sessionId } : {},
			timeoutMs ? { timeoutMs } : undefined,
		);
		this.modelCache = { sessionId, at: Date.now(), result };
		return result;
	}

	private async listModels(): Promise<void> {
		const { models, current } = await this.fetchModels();
		this.listedModels = models;
		if (!models.length) {
			this.line("No models available. Sign in to a provider first.");
			return;
		}
		const width = String(models.length).length;
		for (const [i, m] of models.entries()) {
			const mark = current && current.provider === m.provider && current.id === m.id ? "*" : " ";
			this.line(`${String(i + 1).padStart(width)}. ${mark} ${m.provider}/${m.id} ${dim(m.name)}`);
		}
		this.line(dim("Switch with /model <n>, /model <provider>/<id> or /model <id>; Tab completes."));
	}

	/**
	 * `/models <agent>`: the models of any agent, `*` marking its default for new sessions in this
	 * workspace. Not numbered and not remembered, since `/model <n>` switches the attached session.
	 */
	private async listAgentModels(ref: string): Promise<void> {
		const runtime = requireAvailable(resolveRuntime(await this.fetchRuntimes(), ref));
		const { models, current } = await this.client.request("model.list", {
			runtime: runtime.id,
			...(this.workspace ? { workspaceId: this.workspace.id } : {}),
		});
		if (!models.length) {
			this.line(`${runtime.name} reports no models.`);
			return;
		}
		this.line(dim(`${runtime.name} models (* = default for new sessions):`));
		for (const m of models) {
			const mark = current && current.provider === m.provider && current.id === m.id ? "*" : " ";
			this.line(`${mark} ${m.provider}/${m.id} ${dim(m.name)}`);
		}
		this.line(dim(`Use them in a session created with /new -a ${runtime.id}, then /model.`));
	}

	/** Tab completion. Never throws: a failed lookup just offers nothing. */
	async complete(line: string): Promise<CompleterResult> {
		const lookup = async <T>(load: () => Promise<T>, fallback: T): Promise<T> => {
			try {
				return await load();
			} catch {
				return fallback;
			}
		};
		// readline stops reading keys until completion returns, so keep lookups short.
		const models = () => this.fetchModels(30_000, 3_000);
		return completeCliLine(line, {
			models: () => lookup(async () => (await models()).models, []),
			thinkingLevels: () =>
				lookup(
					async () => (await models()).current?.thinkingLevels ?? ThinkingLevelSchema.options,
					ThinkingLevelSchema.options,
				),
			agents: () =>
				lookup(async () => {
					// Fetched at startup and by /agents; ask again only if that failed.
					if (!this.runtimes.length) this.runtimes = (await this.client.request("runtime.list", {}, QUICK)).runtimes;
					return this.runtimes.filter((r) => r.available).map((r) => r.id);
				}, []),
			// The lists are kept so that `/open <n>` and the others count like the completion did.
			sessions: () =>
				lookup(async () => {
					if (!this.workspace) return [];
					const workspaceId = this.workspace.id;
					this.sessions = (await this.client.request("session.list", { workspaceId }, QUICK)).sessions;
					return this.sessions.map((s) => `${oneLine(sessionTitle(s) || "(empty)", 40)} · ${this.sessionDetail(s)}`);
				}, []),
			workspaces: () =>
				lookup(async () => {
					this.workspaces = (await this.client.request("workspace.list", {}, QUICK)).workspaces;
					return this.workspaces.map(workspaceLabel);
				}, []),
			devices: () =>
				lookup(async () => {
					this.devices = (await this.client.request("device.list", {}, QUICK)).devices;
					return this.devices.map(deviceLabel);
				}, []),
			forkPoints: () =>
				lookup(async () => {
					if (!this.sessionId) return [];
					const { points } = await this.client.request("session.forkPoints", { sessionId: this.sessionId }, QUICK);
					return points.map((p) => p.text);
				}, []),
			answerOptions: async () => {
				const request = this.pendingAnswer();
				return request?.kind === "select" ? (request.options ?? []) : [];
			},
			directories: (path) =>
				lookup(() => this.client.request("host.listDirectories", path ? { path } : {}, QUICK), undefined),
		});
	}

	/** Agent, state and size of a session, as the session lists show them. */
	private sessionDetail(session: SessionSummary): string {
		return `${runtimeName(session.runtime, this.runtimes)} · ${session.state} · ${session.messageCount} msgs`;
	}

	/** The pending select / input / editor request that `/answer` answers. */
	private pendingAnswer(): UiRequest | undefined {
		return [...this.pendingUi.values()].find((r) => r.kind !== "approval" && r.kind !== "confirm");
	}

	private listSessions(): void {
		if (!this.sessions.length) this.line(`No sessions in this workspace yet. Create one with ${bold("/new")}.`);
		for (const [i, s] of this.sessions.entries()) {
			const agent = s.runtime && s.runtime !== "pi" ? ` [${runtimeName(s.runtime, this.runtimes)}]` : "";
			this.line(
				`${i + 1}. ${sessionTitle(s) || dim("(empty)")}${agent} ${dim(`${s.messageCount} msgs · ${s.state} · ${s.modifiedAt}`)}`,
			);
		}
	}

	private listWorkspaces(): void {
		if (!this.workspaces.length) this.line(`No workspaces yet. Add one with ${bold("/ws add <path>")}.`);
		for (const [i, w] of this.workspaces.entries()) {
			this.line(`${i + 1}. ${w.id === this.workspace?.id ? "*" : " "} ${w.name} ${dim(w.path)} [${w.policy}]`);
		}
	}

	private listDevices(): void {
		if (!this.devices.length) this.line("No paired devices.");
		for (const [i, d] of this.devices.entries()) {
			this.line(
				`${i + 1}. ${bold(d.name)} ${dim(`${d.platform ?? ""} ${d.fingerprint} ${d.id}`)} ${d.connected ? green("online") : dim(d.lastSeenAt ? `last seen ${d.lastSeenAt}` : "")}`,
			);
		}
	}

	/** `/open` without an argument: pick a session of the workspace, or list them without a terminal. */
	private async chooseSession(): Promise<SessionSummary | undefined> {
		this.sessions = (await this.client.request("session.list", { workspaceId: this.requireWorkspace().id })).sessions;
		if (!this.picker || !this.sessions.length) {
			this.listSessions();
			if (this.sessions.length) this.line(dim("Open one with /open <n>."));
			return undefined;
		}
		const picked = await this.choose({
			title: "Open a session",
			items: this.sessions.map((s) => ({
				label: sessionTitle(s) || "(empty)",
				detail: this.sessionDetail(s),
				current: s.id === this.sessionId,
				value: s,
			})),
		});
		if (!picked) this.line(dim("No session opened."));
		return picked;
	}

	/** `/ws use` without an argument. */
	private async chooseWorkspace(): Promise<WorkspaceInfo | undefined> {
		if (!this.picker || !this.workspaces.length) {
			this.listWorkspaces();
			if (this.workspaces.length) this.line(dim("Select one with /ws use <n>."));
			return undefined;
		}
		const picked = await this.choose({
			title: "Select a workspace",
			items: this.workspaces.map((w) => ({
				label: w.name,
				detail: `${w.path} [${w.policy}]`,
				current: w.id === this.workspace?.id,
				value: w,
			})),
		});
		if (!picked) this.line(dim("Workspace unchanged."));
		return picked;
	}

	/** `/revoke` without an argument. */
	private async chooseDevice(): Promise<DeviceInfo | undefined> {
		if (!this.picker || !this.devices.length) {
			this.listDevices();
			if (this.devices.length) this.line(dim("Revoke one with /revoke <n>."));
			return undefined;
		}
		const picked = await this.choose({
			title: "Revoke a paired device (it is disconnected immediately)",
			items: this.devices.map((d) => ({
				label: d.name,
				detail: `${d.platform ?? ""} ${d.fingerprint}${d.connected ? " · online" : ""}`.trim(),
				value: d,
			})),
		});
		if (!picked) this.line(dim("No device revoked."));
		return picked;
	}

	private selectWorkspace(workspace: WorkspaceInfo): void {
		if (workspace.id !== this.workspace?.id) this.sessions = []; // numbered for the previous workspace
		this.workspace = workspace;
	}

	/** Expand `~` and `~/…`, which stand for the host's home directory. */
	private async expandHome(path: string): Promise<string> {
		if (!isHomePath(path)) return path;
		const { home } = await this.client.request("host.listDirectories");
		return home + path.slice(1);
	}

	async handle(input: string): Promise<boolean> {
		const trimmed = input.trim();
		if (!trimmed) return true;
		if (!trimmed.startsWith("/")) {
			await this.client.request("session.prompt", {
				sessionId: this.requireSession(),
				text: trimmed,
				...(this.streaming ? { streamingBehavior: "followUp" as const } : {}),
			});
			return true;
		}
		const [command = "", ...rest] = trimmed.slice(1).split(/\s+/);
		const arg = rest.join(" ");
		switch (command) {
			case "help":
				this.line(HELP);
				break;
			case "quit":
			case "exit":
				return false;
			case "ws": {
				const [sub, ...wsArgs] = rest;
				if (sub === "add") {
					const [path, policy] = wsArgs;
					if (!path) throw new Error("Usage: /ws add <path> [policy]");
					const { workspace } = await this.client.request("workspace.add", {
						path: await this.expandHome(path),
						...(policy ? { policy: policy as WorkspaceInfo["policy"] } : {}),
					});
					this.selectWorkspace(workspace);
					this.line(`Workspace ${bold(workspace.name)} [${workspace.policy}] selected.`);
				} else if (sub === "use") {
					this.workspaces = (await this.client.request("workspace.list")).workspaces;
					const workspace = wsArgs[0] ? this.pick(this.workspaces, wsArgs[0]) : await this.chooseWorkspace();
					if (!workspace) break;
					this.selectWorkspace(workspace);
					this.line(`Workspace ${bold(workspace.name)} selected.`);
				} else if (sub === "policy") {
					const { workspace } = await this.client.request("workspace.setPolicy", {
						workspaceId: this.requireWorkspace().id,
						policy: wsArgs[0] as WorkspaceInfo["policy"],
					});
					this.workspace = workspace;
					this.line(`Policy set to ${workspace.policy}.`);
				} else {
					this.workspaces = (await this.client.request("workspace.list")).workspaces;
					this.listWorkspaces();
				}
				break;
			}
			case "agents":
				await this.listAgents();
				break;
			case "sessions":
				this.sessions = (
					await this.client.request("session.list", { workspaceId: this.requireWorkspace().id })
				).sessions;
				this.listSessions();
				break;
			case "new": {
				const { agent, name } = parseNewArgs(arg);
				const workspaceId = this.requireWorkspace().id;
				const runtime = agent ? requireAvailable(resolveRuntime(await this.fetchRuntimes(), agent)).id : undefined;
				const { session } = await this.client.request("session.create", {
					workspaceId,
					...(name ? { name } : {}),
					...(runtime ? { runtime } : {}),
				});
				await this.attach(session);
				break;
			}
			case "open": {
				const workspaceId = this.requireWorkspace().id;
				let target: SessionSummary | undefined;
				if (arg) {
					if (!this.sessions.length)
						this.sessions = (await this.client.request("session.list", { workspaceId })).sessions;
					target = this.pick(this.sessions, arg);
				} else target = await this.chooseSession();
				if (!target) break;
				const { session } = await this.client.request("session.open", { workspaceId, sessionId: target.id });
				await this.attach(session);
				break;
			}
			case "status": {
				const snapshot = await this.client.request("session.snapshot", { sessionId: this.requireSession() });
				this.line(
					`${bold(snapshot.session.name ?? snapshot.session.id)} · ${runtimeName(snapshot.session.runtime, this.runtimes)} · ${snapshot.session.state} · model ${snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "none"} · thinking ${snapshot.thinkingLevel} · seq ${snapshot.seq} · pending UI ${snapshot.pendingUi.length}`,
				);
				break;
			}
			case "rename":
				await this.client.request("session.rename", { sessionId: this.requireSession(), name: arg });
				break;
			case "fork": {
				const sessionId = this.requireSession();
				const { points } = await this.client.request("session.forkPoints", { sessionId });
				if (!arg) {
					for (const [i, p] of points.entries()) this.line(`${i + 1}. ${p.text.slice(0, 80)}`);
					break;
				}
				const point = points[Number(arg) - 1];
				if (!point) throw new Error("No such fork point");
				const { session, selectedText } = await this.client.request("session.fork", {
					sessionId,
					entryId: point.entryId,
				});
				await this.attach(session);
				if (selectedText) this.line(dim(`Forked before: ${selectedText.slice(0, 200)}`));
				break;
			}
			case "steer":
				await this.client.request("session.steer", { sessionId: this.requireSession(), text: arg });
				break;
			case "follow":
				await this.client.request("session.followUp", { sessionId: this.requireSession(), text: arg });
				break;
			case "abort":
				await this.client.request("session.abort", { sessionId: this.requireSession() });
				break;
			case "compact": {
				const result = await this.client.request(
					"session.compact",
					{ sessionId: this.requireSession(), ...(arg ? { instructions: arg } : {}) },
					{ timeoutMs: 10 * 60_000 },
				);
				this.line(dim(`[compacted from ${result.tokensBefore} tokens]`));
				break;
			}
			case "models":
				if (arg) await this.listAgentModels(arg);
				else await this.listModels();
				break;
			case "model": {
				if (!arg) {
					// Without a session (nothing to switch) or a terminal, list them instead.
					if (!this.picker || !this.sessionId) {
						await this.listModels();
						break;
					}
					const sessionId = this.sessionId;
					const { models, current } = await this.fetchModels();
					if (!models.length) {
						this.line("No models available. Sign in to a provider first.");
						break;
					}
					const picked = await this.choose({
						title: "Select a model",
						items: models.map((m) => ({
							label: `${m.provider}/${m.id}`,
							detail: m.name,
							current: current?.provider === m.provider && current.id === m.id,
							value: m,
						})),
					});
					if (!picked) {
						this.line(dim("Model unchanged."));
						break;
					}
					const { model } = await this.client.request("model.set", {
						sessionId,
						provider: picked.provider,
						modelId: picked.id,
					});
					this.modelCache = undefined;
					this.line(`Model: ${model.provider}/${model.id}`);
					break;
				}
				const sessionId = this.requireSession();
				const numbered = /^\d+$/.test(arg);
				const models = numbered && this.listedModels.length ? this.listedModels : (await this.fetchModels()).models;
				const match = matchModel(models, arg);
				let provider: string;
				let modelId: string;
				if ("model" in match) ({ provider, id: modelId } = match.model);
				else {
					// Not in the listing: still let the host decide on an explicit provider/id.
					const slash = arg.indexOf("/");
					if (!match.none || slash <= 0) throw new Error(match.error);
					provider = arg.slice(0, slash);
					modelId = arg.slice(slash + 1);
				}
				const { model } = await this.client.request("model.set", { sessionId, provider, modelId });
				this.modelCache = undefined;
				this.line(`Model: ${model.provider}/${model.id}`);
				break;
			}
			case "thinking": {
				const sessionId = this.requireSession();
				let target = arg as ThinkingLevel;
				if (!arg) {
					const { current, thinkingLevel } = await this.fetchModels();
					const levels = current?.thinkingLevels ?? ThinkingLevelSchema.options;
					const picked = await this.choose({
						title: `Thinking level${current ? ` for ${current.provider}/${current.id}` : ""}`,
						items: levels.map((level) => ({ label: level, current: level === thinkingLevel, value: level })),
					});
					if (!picked) {
						this.line(`Thinking: ${thinkingLevel ?? "unknown"} ${dim(`(available: ${levels.join(", ")})`)}`);
						break;
					}
					target = picked;
				}
				const { level } = await this.client.request("thinking.set", { sessionId, level: target });
				this.modelCache = undefined;
				this.line(`Thinking: ${level}`);
				break;
			}
			case "allow":
				await this.respond(this.oldestPending("approval"), {
					decision: arg === "session" ? "allow_session" : "allow_once",
				});
				break;
			case "deny":
				await this.respond(this.oldestPending("approval"), { decision: "deny", ...(arg ? { reason: arg } : {}) });
				break;
			case "yes":
			case "no":
				await this.respond(this.oldestPending("confirm"), { confirmed: command === "yes" });
				break;
			case "answer": {
				const request = this.pendingAnswer();
				if (!request) throw new Error("No pending select/input/editor request");
				const index = Number(arg);
				const value =
					request.kind === "select" && request.options && Number.isInteger(index) && request.options[index - 1]
						? (request.options[index - 1] as string)
						: arg;
				await this.respond(request, { value });
				break;
			}
			case "cancel":
				await this.respond(this.oldestPending(), { cancelled: true });
				break;
			case "remote": {
				const [sub, value] = rest;
				let status: RemoteAccessStatus;
				if (sub === "on" || sub === "off")
					status = await this.client.request("remote.configure", { enabled: sub === "on" });
				else if (sub === "port") status = await this.client.request("remote.configure", { port: Number(value) });
				else status = await this.client.request("remote.status");
				this.line(
					`Remote access ${status.enabled ? green("on") : "off"}${status.running ? `, listening on port ${status.port}` : ""}${status.error ? red(` (${status.error})`) : ""}`,
				);
				if (status.addresses.length) this.line(dim(`Addresses: ${status.addresses.join(", ")}`));
				this.line(dim(`Host fingerprint: ${status.hostFingerprint}`));
				break;
			}
			case "pair": {
				if (arg === "yes" || arg === "no") {
					const request = [...this.pairingRequests.values()][0];
					if (!request) throw new Error("No device is waiting for confirmation");
					this.pairingRequests.delete(request.id);
					const { accepted } = await this.client.request("pairing.respond", {
						requestId: request.id,
						accept: arg === "yes",
					});
					if (!accepted) this.line(yellow("The request is no longer pending."));
					break;
				}
				const { uri, expiresAt } = await this.client.request("pairing.start");
				this.line(`Pairing link (valid until ${new Date(expiresAt).toLocaleTimeString()}, single use):`);
				this.line(uri);
				this.line(dim("Paste it into the mobile app (Add computer → paste link), then confirm here with /pair yes."));
				break;
			}
			case "devices":
				this.devices = (await this.client.request("device.list")).devices;
				this.listDevices();
				break;
			case "revoke": {
				if (!arg || !this.devices.length) this.devices = (await this.client.request("device.list")).devices;
				const device = arg ? this.pick(this.devices, arg) : await this.chooseDevice();
				if (!device) break;
				const { revoked } = await this.client.request("device.revoke", { deviceId: device.id });
				this.line(revoked ? `Revoked ${bold(device.name)}.` : "Device was already gone.");
				this.devices = this.devices.filter((d) => d.id !== device.id);
				break;
			}
			case "drop":
				this.client.dropConnection();
				break;
			default:
				this.line(`Unknown command /${command}. Try /help.`);
		}
		return true;
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			url: { type: "string" },
			token: { type: "string" },
			"pier-dir": { type: "string" },
			"ssh-pair": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(
			`pier cli [--url ws://127.0.0.1:<port>] [--token <token>] [--pier-dir <dir>]\n         [--ssh-pair]  pair the computer adding this one over SSH (JSON on stdin and stdout)\n\n${HELP}`,
		);
		return;
	}
	const { url, token } = discover(values);
	const client = new PierClient({
		url,
		...(token ? { token } : {}),
		client: { name: "pier-cli", version: PIER_CLI_VERSION, platform: process.platform },
		...(values["ssh-pair"] ? { reconnect: { enabled: false } } : {}),
	});
	await client.connect();
	if (values["ssh-pair"]) {
		await sshPair(client);
		return;
	}

	const terminal = process.stdin.isTTY && process.stdout.isTTY;
	const cli = new Cli(
		client,
		(line) => {
			process.stdout.write(`\r\x1b[K${line}\n`);
			prompt(true);
		},
		terminal ? (options) => runTerminalPicker(process.stdin, process.stdout, options) : undefined,
	);
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "> ",
		// A lone Esc closes the picker; don't wait the default 500 ms for a longer sequence.
		escapeCodeTimeout: 100,
		completer: (line: string, callback: (error: Error | null, result: CompleterResult) => void) => {
			void cli.complete(line).then((result) => callback(null, result));
		},
	});
	let inputClosed = false;
	const prompt = (preserveCursor = false) => {
		if (!inputClosed) rl.prompt(preserveCursor);
	};
	// Attach the line handler before any await so early (piped) input is not lost, and
	// handle lines strictly in order.
	let queue: Promise<unknown> = cli.init().then(() => prompt());
	let closing = false;
	rl.on("line", (input) => {
		queue = queue
			.then(() => (closing ? false : cli.handle(input)))
			.then((keepGoing) => {
				if (keepGoing === false) {
					closing = true;
					rl.close();
				} else prompt();
			})
			.catch((error: unknown) => {
				process.stdout.write(`${red(`error: ${error instanceof Error ? error.message : String(error)}`)}\n`);
				prompt();
			});
	});
	rl.on("close", () => {
		inputClosed = true;
		void queue.finally(() => {
			client.close();
			void exitCli(0);
		});
	});
}

/** Non-interactive pairing driven by `peer.sshAdd` on the other computer. */
async function sshPair(client: PierClient): Promise<void> {
	const controller = new AbortController();
	const rl = createInterface({ input: process.stdin });
	const lines = rl[Symbol.asyncIterator]();
	const first = await lines.next();
	if (first.done) throw new Error("Expected the pairing request on stdin");
	// The SSH session closed: give up instead of leaving a pairing code behind.
	rl.on("close", () => controller.abort());
	const output = await runSshPair(
		client,
		parseSshPairRequest(first.value),
		(line) => process.stdout.write(`${JSON.stringify(line)}\n`),
		controller.signal,
	);
	client.close();
	await exitCli(output.type === "done" ? 0 : 1);
}

main().catch((error: unknown) => {
	console.error(red(`pier cli: ${error instanceof Error ? error.message : String(error)}`));
	void exitCli(1);
});
