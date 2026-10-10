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
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type {
	DeviceInfo,
	EventFrame,
	PairingRequest,
	RemoteAccessStatus,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	UiRequest,
	UiResponse,
	WorkspaceInfo,
} from "@pier/protocol";
import { PierClient } from "./client.ts";

export const PIER_CLI_VERSION = "0.2.37";

const HELP = `Commands:
  /ws                        list workspaces
  /ws add <path> [policy]    register a workspace (policy: ask|smart|auto)
  /ws use <n|id>             select a workspace
  /ws policy <ask|smart|auto> set the current workspace's approval policy
  /sessions                  list sessions in the current workspace
  /new [name]                create a session and attach to it
  /open <n|id>               open a session from the last list and attach
  /status                    show the attached session state
  /rename <name>             rename the attached session
  /fork [n]                  list fork points, or fork at point n
  /steer <text>              steer the running agent
  /follow <text>             queue a follow-up
  /abort                     abort the current run
  /compact [instructions]    compact the context
  /models                    list available models
  /model <provider>/<id>     switch model
  /thinking <level>          set thinking level
  /allow [session]           approve the oldest pending approval (once / for session)
  /deny [reason]             deny the oldest pending approval
  /yes, /no                  answer a pending confirm
  /answer <text>             answer a pending select/input/editor
  /cancel                    cancel the oldest pending UI request
  /remote [on|off|port <n>]  show or change remote access (LAN) settings
  /pair                      show a pairing link for the mobile app (see /pair yes|no)
  /pair yes|no               allow or decline the device waiting for confirmation
  /devices                   list paired devices
  /revoke <n|id>             revoke a paired device (disconnects it immediately)
  /drop                      simulate a network drop (tests reconnect + resume)
  /quit                      exit
Anything else is sent as a prompt (as a follow-up while the agent is running).`;

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
		throw new Error(`No running host found (${file}). Start pier-host or pass --url/--token.`);
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

	constructor(
		private readonly client: PierClient,
		private readonly print: (line: string) => void,
	) {}

	private write(text: string): void {
		process.stdout.write(text);
		this.midLine = !text.endsWith("\n");
	}

	private line(text: string): void {
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
	}

	private requireSession(): string {
		if (!this.sessionId) throw new Error("No session attached. Use /new or /open.");
		return this.sessionId;
	}

	private requireWorkspace(): WorkspaceInfo {
		if (!this.workspace) throw new Error("No workspace selected. Use /ws add <path>.");
		return this.workspace;
	}

	private async attach(session: SessionSummary): Promise<void> {
		await this.unsubscribe?.();
		this.pendingUi.clear();
		this.sessionId = session.id;
		const sub = await this.client.subscribe(session.id, (frame) => this.onSessionEvent(frame), {
			workspaceId: session.workspaceId,
		});
		this.unsubscribe = () => sub.unsubscribe();
		this.line(`Attached to session ${bold(session.name ?? session.id)}`);
	}

	private onSessionEvent(frame: EventFrame): void {
		const event = frame.event;
		if (frame.sessionId && frame.sessionId !== this.sessionId && event.type !== "session.replaced") return;
		switch (event.type) {
			case "session.snapshot": {
				const snapshot = event.snapshot as SessionSnapshot;
				this.pendingUi.clear();
				for (const request of snapshot.pendingUi) this.pendingUi.set(request.id, request);
				const visible = (snapshot.messages as Array<{ role: string; content: unknown }>).filter(
					(m) => m.role === "user" || m.role === "assistant",
				);
				this.line(dim(`— snapshot: ${visible.length} messages, seq ${snapshot.seq}, ${snapshot.session.state} —`));
				for (const message of visible.slice(-6)) {
					const text = textOf(message.content).trim();
					if (text) this.line(`${message.role === "user" ? bold("you") : bold("pi")}: ${text.slice(0, 500)}`);
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
				if (message?.role === "assistant") this.line(bold("pi: "));
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
						path,
						...(policy ? { policy: policy as WorkspaceInfo["policy"] } : {}),
					});
					this.workspace = workspace;
					this.line(`Workspace ${bold(workspace.name)} [${workspace.policy}] selected.`);
				} else if (sub === "use") {
					this.workspaces = (await this.client.request("workspace.list")).workspaces;
					this.workspace = this.pick(this.workspaces, wsArgs[0] ?? "");
					this.line(`Workspace ${bold(this.workspace.name)} selected.`);
				} else if (sub === "policy") {
					const { workspace } = await this.client.request("workspace.setPolicy", {
						workspaceId: this.requireWorkspace().id,
						policy: wsArgs[0] as WorkspaceInfo["policy"],
					});
					this.workspace = workspace;
					this.line(`Policy set to ${workspace.policy}.`);
				} else {
					this.workspaces = (await this.client.request("workspace.list")).workspaces;
					for (const [i, w] of this.workspaces.entries()) {
						this.line(`${i + 1}. ${w.id === this.workspace?.id ? "*" : " "} ${w.name} ${dim(w.path)} [${w.policy}]`);
					}
				}
				break;
			}
			case "sessions": {
				const { sessions } = await this.client.request("session.list", { workspaceId: this.requireWorkspace().id });
				this.sessions = sessions;
				for (const [i, s] of sessions.entries()) {
					const title = s.name ?? (s.firstMessage.slice(0, 60) || dim("(empty)"));
					this.line(`${i + 1}. ${title} ${dim(`${s.messageCount} msgs · ${s.state} · ${s.modifiedAt}`)}`);
				}
				break;
			}
			case "new": {
				const { session } = await this.client.request("session.create", {
					workspaceId: this.requireWorkspace().id,
					...(arg ? { name: arg } : {}),
				});
				await this.attach(session);
				break;
			}
			case "open": {
				const target = this.pick(this.sessions, arg);
				const { session } = await this.client.request("session.open", {
					workspaceId: this.requireWorkspace().id,
					sessionId: target.id,
				});
				await this.attach(session);
				break;
			}
			case "status": {
				const snapshot = await this.client.request("session.snapshot", { sessionId: this.requireSession() });
				this.line(
					`${bold(snapshot.session.name ?? snapshot.session.id)} · ${snapshot.session.state} · model ${snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "none"} · thinking ${snapshot.thinkingLevel} · seq ${snapshot.seq} · pending UI ${snapshot.pendingUi.length}`,
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
			case "models": {
				const { models, current } = await this.client.request(
					"model.list",
					this.sessionId ? { sessionId: this.sessionId } : {},
				);
				for (const m of models) {
					const mark = current && current.provider === m.provider && current.id === m.id ? "*" : " ";
					this.line(`${mark} ${m.provider}/${m.id} ${dim(m.name)}`);
				}
				break;
			}
			case "model": {
				const slash = arg.indexOf("/");
				if (slash <= 0) throw new Error("Usage: /model <provider>/<id>");
				const { model } = await this.client.request("model.set", {
					sessionId: this.requireSession(),
					provider: arg.slice(0, slash),
					modelId: arg.slice(slash + 1),
				});
				this.line(`Model: ${model.provider}/${model.id}`);
				break;
			}
			case "thinking": {
				const { level } = await this.client.request("thinking.set", {
					sessionId: this.requireSession(),
					level: arg as ThinkingLevel,
				});
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
				const request = [...this.pendingUi.values()].find((r) => r.kind !== "approval" && r.kind !== "confirm");
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
			case "devices": {
				this.devices = (await this.client.request("device.list")).devices;
				if (!this.devices.length) this.line("No paired devices.");
				this.devices.forEach((d, i) => {
					this.line(
						`${i + 1}. ${bold(d.name)} ${dim(`${d.platform ?? ""} ${d.fingerprint} ${d.id}`)} ${d.connected ? green("online") : dim(d.lastSeenAt ? `last seen ${d.lastSeenAt}` : "")}`,
					);
				});
				break;
			}
			case "revoke": {
				if (!this.devices.length) this.devices = (await this.client.request("device.list")).devices;
				const device = this.pick(this.devices, arg);
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
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(`pier-cli [--url ws://127.0.0.1:<port>] [--token <token>] [--pier-dir <dir>]\n\n${HELP}`);
		return;
	}
	const { url, token } = discover(values);
	const client = new PierClient({
		url,
		...(token ? { token } : {}),
		client: { name: "pier-cli", version: PIER_CLI_VERSION, platform: process.platform },
	});
	await client.connect();

	const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
	let inputClosed = false;
	const prompt = (preserveCursor = false) => {
		if (!inputClosed) rl.prompt(preserveCursor);
	};
	const cli = new Cli(client, (line) => {
		process.stdout.write(`\r\x1b[K${line}\n`);
		prompt(true);
	});
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
			process.exit(0);
		});
	});
}

main().catch((error: unknown) => {
	console.error(red(`pier-cli: ${error instanceof Error ? error.message : String(error)}`));
	process.exit(1);
});
