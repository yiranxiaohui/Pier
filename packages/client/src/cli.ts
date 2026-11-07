#!/usr/bin/env node
/**
 * pier-cli: interactive client for a running Pier Host.
 *
 * Connects using <pier-dir>/run/host.json (written by pier-host) unless --url/--token
 * or PIER_URL/PIER_LOCAL_TOKEN are given.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CompleterResult, createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import {
	type AgentRuntimeInfo,
	type DeviceInfo,
	type EventFrame,
	type MethodResult,
	type ModelInfo,
	type PairingRequest,
	type RemoteAccessStatus,
	type SessionRunState,
	type SessionSnapshot,
	type SessionSummary,
	type ThinkingLevel,
	ThinkingLevelSchema,
	type UiRequest,
	type UiResponse,
	type WorkspaceInfo,
} from "@pier/protocol";
import { parseNewArgs, requireAvailable, resolveRuntime, runtimeName } from "./cli-agents.ts";
import { CLI_COMMANDS, candidateValue, completeCliLine, matchModel, oneLine } from "./cli-complete.ts";
import { exitCli } from "./cli-exit.ts";
import { pairingRows } from "./cli-pairing.ts";
import { type PickerOptions, runTerminalPicker } from "./cli-picker.ts";
import {
	box,
	commandSuggestions,
	commonPrefix,
	completionGrid,
	flatLine,
	formatBlock,
	formatDuration,
	type HelpSection,
	helpRows,
	inlineMarkdown,
	keyValues,
	type ListRow,
	list,
	MessageStream,
	relativeTime,
	resultLine,
	rule,
	type Span,
	span,
	spinnerFrame,
	suggestionChoice,
	suggestionRows,
	toolHeader,
	toolResult,
	toolResultText,
	userMessage,
} from "./cli-render.ts";
import { type CliScreen, PlainScreen, TerminalScreen } from "./cli-screen.ts";
import { c, detectColorLevel, sanitize, setColorLevel } from "./cli-style.ts";
import { PierClient } from "./client.ts";
import { parseSshPairRequest, runSshPair } from "./ssh-pair.ts";

export const PIER_CLI_VERSION = "0.2.60";

const HELP_SECTIONS: HelpSection[] = [
	{
		title: "Sessions",
		commands: [
			["/new [-a <agent>] [name]", "create a session (default agent: pi) and attach to it"],
			["/open [n|id]", "open a session of /sessions and attach (no argument: pick with ↑/↓)"],
			["/sessions", "list sessions in the current workspace"],
			["/status", "show the attached session state"],
			["/rename <name>", "rename the attached session"],
			["/fork [n]", "list fork points, or fork at point n"],
			["/compact [instructions]", "compact the context"],
		],
	},
	{
		title: "While the agent runs",
		commands: [
			["/steer <text>", "steer the running agent"],
			["/follow <text>", "queue a follow-up"],
			["/abort", "abort the current run (or press Esc)"],
		],
	},
	{
		title: "Models and agents",
		commands: [
			["/agents", "list the agents on this computer (pi, Claude Code, Codex)"],
			["/models", "list available models (numbered, ● = current)"],
			["/models <agent>", "list the models of another agent (see /agents)"],
			["/model", "pick a model with ↑/↓ and Enter (type to filter, Esc cancels)"],
			["/model <n|provider/id|id>", "switch model directly (a unique part of the id or name also works)"],
			["/thinking [level]", "pick or set the thinking level"],
		],
	},
	{
		title: "Workspaces",
		commands: [
			["/ws", "list workspaces"],
			["/ws add <path> [policy]", "register a workspace (policy: ask|smart|auto; ~ is the home directory)"],
			["/ws use [n|id]", "select a workspace (no argument: pick with ↑/↓)"],
			["/ws policy <ask|smart|auto>", "set the current workspace's approval policy"],
		],
	},
	{
		title: "Approvals and questions",
		commands: [
			["/allow [session]", "approve the oldest pending approval (once / for session)"],
			["/deny [reason]", "deny the oldest pending approval"],
			["/yes, /no", "answer a pending confirm"],
			["/answer <text>", "answer a pending select/input/editor"],
			["/cancel", "cancel the oldest pending UI request"],
		],
	},
	{
		title: "Remote access",
		commands: [
			["/remote [on|off|port <n>]", "show or change remote access (LAN) settings"],
			["/pair", "show a pairing QR code and link for the mobile app (see /pair yes|no)"],
			["/pair yes|no", "allow or decline the device waiting for confirmation"],
			["/devices", "list paired devices"],
			["/revoke [n|id]", "revoke a paired device and disconnect it (no argument: pick with ↑/↓)"],
		],
	},
	{
		title: "Other",
		commands: [
			["/help", "show this help"],
			["/drop", "simulate a network drop (tests reconnect + resume)"],
			["/quit", "exit (also Ctrl+D, or Ctrl+C twice)"],
		],
	},
];

const HELP_NOTES = [
	"Anything else is sent as a prompt (as a follow-up while the agent is running).",
	"Press Tab to complete commands, models, thinking levels, agents, options and directories, and the numbers of sessions, workspaces, devices, fork points and answers (press Tab twice to list them).",
	"While commands or completions are listed, ↑/↓ select one and Tab or Enter fills it in (Enter also runs a command that needs nothing more); Esc drops the selection.",
	"Esc or Ctrl+C interrupts the agent; Ctrl+C also clears the typed line.",
];

/** How many earlier messages a snapshot shows. */
const HISTORY_MESSAGES = 8;
/** Command suggestions shown above the prompt while a command is typed. */
const SUGGESTIONS = 8;

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

/** The fields of pi transcript messages (`AgentMessage`) the CLI shows. */
interface TranscriptPart {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

interface TranscriptMessage {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	usage?: UsageLike;
	stopReason?: string;
	errorMessage?: string;
}

function partsOf(content: unknown): TranscriptPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as TranscriptPart[]) : [];
}

function textOf(content: unknown): string {
	return partsOf(content)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

/** Tokens in the context after a response, as pi counts them. */
function contextTokens(usage: UsageLike | undefined): number | undefined {
	if (!usage) return undefined;
	const total =
		usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return total > 0 ? total : undefined;
}

const isBusy = (state: SessionRunState) => state === "streaming" || state === "compacting" || state === "retrying";

/** A session's name, or the start of its first message. */
function sessionTitle(session: SessionSummary | undefined): string {
	if (!session) return "";
	return session.name ? sanitize(session.name) : oneLine(sanitize(session.firstMessage), 60);
}

function workspaceLabel(workspace: WorkspaceInfo): string {
	return `${workspace.name} ${workspace.path} [${workspace.policy}]`;
}

function deviceLabel(device: DeviceInfo): string {
	return `${device.name}${device.platform ? ` ${device.platform}` : ""}${device.connected ? " online" : ""}`;
}

const isHomePath = (path: string) => path === "~" || /^~[\\/]/.test(path);

/** Edit distance, for suggesting the command that was meant. */
function distance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++)
			current[j] = Math.min(
				(previous[j] as number) + 1,
				(current[j - 1] as number) + 1,
				(previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		previous = current;
	}
	return previous[b.length] as number;
}

/** Completion lookups run while readline waits for the result, so they must not hang. */
const QUICK = { timeoutMs: 3_000 };

type NoticeLevel = "info" | "success" | "warning" | "error";

const NOTICE_ICONS: Record<NoticeLevel, () => Span> = {
	info: () => span("● ", c.accent),
	success: () => span("✓ ", c.green),
	warning: () => span("▲ ", c.yellow),
	error: () => span("✗ ", c.red),
};

const noticeLevel = (level: unknown): NoticeLevel =>
	level === "error" ? "error" : level === "warning" ? "warning" : "info";

/** How a dialog or approval was answered, e.g. `Allowed once` or `Answered: main`. */
function resolutionText(resolution: unknown, response: UiResponse | undefined): string {
	if (resolution === "timeout") return "Timed out";
	if (resolution === "cancelled" || response?.cancelled) return "Cancelled";
	const decisions: Record<string, string> = {
		allow_once: "Allowed once",
		allow_session: "Allowed for this session",
		deny: "Denied",
	};
	if (response?.decision) {
		const text = decisions[response.decision] ?? response.decision;
		return response.reason ? `${text}: ${sanitize(response.reason)}` : text;
	}
	if (response?.confirmed !== undefined) return response.confirmed ? "Confirmed" : "Declined";
	if (response?.value !== undefined) return `Answered: ${flatLine(String(response.value), 200)}`;
	return "Answered";
}

interface RunningTool {
	name: string;
	args: unknown;
	/** The last line of output so far. */
	output?: string;
}

class Cli {
	private workspaces: WorkspaceInfo[] = [];
	private workspace: WorkspaceInfo | undefined;
	private sessions: SessionSummary[] = [];
	private sessionId: string | undefined;
	private session: SessionSummary | undefined;
	private unsubscribe: (() => Promise<void>) | undefined;
	private readonly pendingUi = new Map<string, UiRequest>();
	private devices: DeviceInfo[] = [];
	private readonly pairingRequests = new Map<string, PairingRequest>();
	private modelCache: { sessionId: string | undefined; at: number; result: MethodResult<"model.list"> } | undefined;
	/** The last numbered model listing, which `/model <n>` refers to. */
	private listedModels: ModelInfo[] = [];
	/** Agent runtimes from the last `runtime.list`, which `/new -a <n>` and `/models <n>` refer to. */
	private runtimes: AgentRuntimeInfo[] = [];
	/** Display name of the attached session's agent. */
	private agent = "pi";

	// What the attached session is doing, for the status line and the rule above the prompt.
	private streaming = false;
	private runStartedAt: number | undefined;
	private compactStartedAt: number | undefined;
	private retry: string | undefined;
	private queued = 0;
	private model: ModelInfo | undefined;
	private thinkingLevel: string | undefined;
	private contextWindow: number | undefined;
	private contextUsed: number | undefined;
	private readonly stream: MessageStream;
	private readonly tools = new Map<string, RunningTool>();
	/** Prompts sent from here, so their echo from the host is not shown twice. */
	private readonly sent: string[] = [];
	private suggestions: Array<readonly [string, string]> = [];
	/** Candidates of the last Tab that matched several, until the line changes. */
	private completions: { line: string; items: string[]; partial: string; cursor: number } | undefined;
	/** The candidate ↑/↓ selected among the listed ones, until the line changes. */
	private selected: { line: string; index: number } | undefined;
	private hint: { text: string; until: number } | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private aborting = false;
	/** Esc / Ctrl+C asked to stop the run, which ends as interrupted rather than done. */
	private interrupted = false;
	/** The CLI is exiting: closing the connection is not news. */
	private exiting = false;

	constructor(
		private readonly client: PierClient,
		private readonly screen: CliScreen,
		/** Arrow-key picker; absent when stdin or stdout is not a terminal. */
		private readonly picker?: <T>(options: PickerOptions<T>) => Promise<T | undefined>,
	) {
		this.stream = new MessageStream({ width: () => this.screen.width, markdown: screen.interactive });
	}

	// ── Output ────────────────────────────────────────────────────────────────

	private get width(): number {
		return this.screen.width;
	}

	/** Width for boxes and rules, which would otherwise span a pipe's unlimited width. */
	private frame(max = 100): number {
		return Math.min(this.screen.width, max);
	}

	/** Print finished rows and redraw the live area in the same pass. */
	private emit(rows: readonly string[]): void {
		this.screen.setLive(this.liveRows(), rows.length === 0);
		if (rows.length) this.screen.commit(rows);
		this.updateTicker();
	}

	/** A line answering the command or prompt above it: `  ⎿  text`. */
	private say(content: string | Span[], style?: (s: string) => string): void {
		this.emit(resultLine(content, this.width, style));
	}

	fail(error: unknown): void {
		this.say(sanitize(error instanceof Error ? error.message : String(error)), c.red);
	}

	/** Something that happened by itself rather than in answer to a command. */
	private notice(level: NoticeLevel, text: string): void {
		const style = level === "error" ? c.red : level === "warning" ? c.yellow : undefined;
		this.emit(["", ...formatBlock([span(sanitize(text), style)], this.width, [NOTICE_ICONS[level]()], [span("  ")])]);
	}

	/** How a typed line stays on screen. */
	echo(input: string): string[] {
		const text = input.trim();
		return text ? userMessage(text, this.width, { command: text.startsWith("/") }) : [];
	}

	/** Let the user pick with the arrow keys, keeping other output from breaking the list. */
	private async choose<T>(options: PickerOptions<T>): Promise<T | undefined> {
		const picker = this.picker;
		if (!picker) return undefined;
		return this.screen.hold(() => picker(options));
	}

	// ── The live area above the prompt ────────────────────────────────────────

	private liveRows(): string[] {
		if (!this.screen.interactive || this.exiting) return [];
		const now = Date.now();
		const width = this.width;
		const rows = this.stream.live(Math.max(3, (process.stdout.rows ?? 24) - 12));
		const frame = spinnerFrame(now);
		for (const tool of this.tools.values()) {
			rows.push("", ...toolHeader(tool.name, tool.args, "running", width, { frame, maxRows: 1 }));
			if (tool.output) rows.push(...resultLine(tool.output, width, c.gray).slice(0, 1));
		}
		rows.push("");
		const status = this.statusRow(now);
		if (status) rows.push(status);
		else if (this.hint && this.hint.until > now) rows.push(c.gray(this.hint.text));
		if (this.completions) {
			if (status) rows.push("");
			rows.push(...completionGrid(this.completions.items, width, 8, this.selected?.index));
		} else if (this.suggestions.length) {
			if (status) rows.push("");
			rows.push(...suggestionRows(this.suggestions, width, SUGGESTIONS, this.selected?.index));
		}
		rows.push(this.ruleRow());
		return rows;
	}

	private statusRow(now: number): string | undefined {
		const compacting = this.compactStartedAt !== undefined;
		if (!this.streaming && !compacting) return undefined;
		const started = this.compactStartedAt ?? this.runStartedAt;
		const elapsed = started ? formatDuration(now - started) : "";
		if (this.pendingUi.size) {
			const details = [elapsed, "/allow · /deny · /answer"].filter(Boolean).join(" · ");
			return `${c.yellow("◆ Waiting for your answer")} ${c.gray(`(${details})`)}`;
		}
		const label = this.interrupted
			? "Interrupting"
			: compacting
				? "Compacting"
				: (this.retry ?? (this.stream.active === "thinking" ? "Thinking" : "Working"));
		const hint = this.interrupted ? "" : "esc to interrupt";
		const details = [elapsed, this.queued ? `${this.queued} queued` : "", hint].filter(Boolean);
		return `${c.accent(`${spinnerFrame(now)} ${label}…`)} ${c.gray(`(${details.join(" · ")})`)}`;
	}

	/** `── workspace › session ──────── agent · model level · 12% context ─` */
	private ruleRow(): string {
		const workspace = this.workspace ? sanitize(this.workspace.name) : "no workspace";
		const left = this.sessionId
			? `${c.gray(`${workspace} ›`)} ${sessionTitle(this.session) || "new session"}`
			: c.gray(workspace);
		const right: string[] = [];
		if (this.sessionId) {
			right.push(this.agent);
			if (this.model) {
				const level = this.thinkingLevel && this.thinkingLevel !== "off" ? ` ${this.thinkingLevel}` : "";
				right.push(`${sanitize(this.model.id)}${level}`);
			}
			const percent = this.contextPercent();
			if (percent !== undefined) right.push(`${percent}% context`);
		} else right.push(this.workspace ? "/new or /open to start" : "/ws add <path> to start");
		return rule(this.width, left, c.gray(right.join(" · ")));
	}

	private contextPercent(): number | undefined {
		if (!this.contextUsed || !this.contextWindow) return undefined;
		return Math.min(100, Math.round((this.contextUsed / this.contextWindow) * 100));
	}

	/** Animate the spinners while something runs; stop when nothing does. */
	private updateTicker(): void {
		const animate =
			this.screen.interactive &&
			!this.exiting &&
			(this.streaming ||
				this.compactStartedAt !== undefined ||
				this.tools.size > 0 ||
				(this.hint !== undefined && this.hint.until > Date.now()));
		if (animate && !this.ticker) {
			this.ticker = setInterval(() => this.emit([]), 100);
			this.ticker.unref?.();
		} else if (!animate && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	/** The typed line changed: suggest the commands it could be. */
	inputChanged(line: string): void {
		const next = this.screen.interactive ? commandSuggestions(HELP_SECTIONS, line) : [];
		const same = next.length === this.suggestions.length && next.every((s, i) => s === this.suggestions[i]);
		const stale = this.completions !== undefined && this.completions.line !== line;
		const moved = this.selected !== undefined && this.selected.line !== line;
		if (same && !stale && !moved) return;
		this.suggestions = next;
		if (stale) this.completions = undefined;
		if (moved) this.selected = undefined;
		this.emit([]);
	}

	/**
	 * What ↑/↓ choose from: the candidates Tab listed, or the suggested commands while the command
	 * itself is typed (not once its arguments are, where ↑/↓ keep walking the history).
	 */
	private choices(line: string): LineChoice[] {
		const listed = this.completions;
		if (listed?.line === line) {
			const head = line.slice(0, Math.max(0, listed.cursor - listed.partial.length));
			const tail = line.slice(listed.cursor);
			return listed.items.map((item) => {
				const text = head + candidateValue(item, listed.partial);
				return { text: text + tail, cursor: text.length, submit: false };
			});
		}
		if (!/^\/\S*\s?$/.test(line)) return [];
		return this.suggestions.map(([usage]) => {
			const choice = suggestionChoice(usage, line);
			return { text: choice.text, cursor: choice.text.length, submit: choice.complete };
		});
	}

	/** ↑/↓: move the selection through the listed candidates. False when none are listed. */
	select(line: string, step: 1 | -1): boolean {
		const count = this.choices(line).length;
		if (!count) return false;
		const current = this.selected?.line === line ? this.selected.index : undefined;
		const index = current === undefined ? (step > 0 ? 0 : count - 1) : (current + step + count) % count;
		this.selected = { line, index };
		this.emit([]);
		return true;
	}

	/** Tab or Enter with a candidate selected: the line to put in its place. */
	takeSelected(line: string): LineChoice | undefined {
		const selected = this.selected;
		if (selected?.line !== line) return undefined;
		this.selected = undefined;
		return this.choices(line)[selected.index];
	}

	/** Esc: drop the selection. False when there was none. */
	dropSelected(): boolean {
		if (!this.selected) return false;
		this.selected = undefined;
		this.emit([]);
		return true;
	}

	/**
	 * Tab matched several candidates: list them above the prompt (rather than letting readline
	 * print them below it). A bare command is left to the suggestions, which list it already.
	 */
	showCompletions(line: string, items: readonly string[], partial: string, cursor: number): void {
		if (/^\/\S*$/.test(line.trimStart())) return;
		this.completions = { line, items: [...items], partial, cursor };
		this.selected = undefined;
		this.emit([]);
	}

	/** Enter was pressed: drop the suggestions without drawing, since the screen redraws next. */
	lineEntered(): void {
		this.suggestions = [];
		this.completions = undefined;
		this.selected = undefined;
		this.hint = undefined;
		this.screen.setLive(this.liveRows(), false);
	}

	/** Esc / Ctrl+C: abort the running agent. False when nothing is running. */
	interrupt(): boolean {
		const sessionId = this.sessionId;
		if (!sessionId || !(this.streaming || this.compactStartedAt !== undefined)) return false;
		if (this.aborting) return true;
		this.aborting = true;
		this.interrupted = true;
		this.emit([]);
		this.client
			.request("session.abort", { sessionId })
			.catch((error: unknown) => {
				this.interrupted = false;
				this.fail(error);
			})
			.finally(() => {
				this.aborting = false;
			});
		return true;
	}

	/** Stop reporting connection changes and animating, before the CLI exits. */
	exit(): void {
		this.exiting = true;
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	/** A short message above the prompt that goes away by itself. */
	flashHint(text: string, ms = 2_000): void {
		this.hint = { text, until: Date.now() + ms };
		this.emit([]);
	}

	// ── Connection ────────────────────────────────────────────────────────────

	async init(): Promise<void> {
		const { workspaces } = await this.client.request("workspace.list");
		this.workspaces = workspaces;
		this.workspace = workspaces[0];
		try {
			await this.fetchRuntimes();
		} catch {
			// Hosts before 1.22 only run pi.
		}
		this.emit(this.banner());
		this.client.onEvent((frame) => {
			if (frame.sessionId) return;
			const event = frame.event;
			if (event.type === "host.notice") this.notice(noticeLevel(event.level), String(event.message));
			else if (event.type === "pairing.request") {
				const request = event.request as PairingRequest;
				this.pairingRequests.set(request.id, request);
				this.showPairingRequest(request);
			} else if (event.type === "pairing.resolved") {
				this.pairingRequests.delete(String(event.requestId));
				this.notice("info", `Pairing ${String(event.resolution)}`);
			}
		});
		this.client.onState((state) => {
			if (this.exiting) return;
			if (state === "reconnecting") this.notice("warning", "Connection lost, reconnecting…");
			if (state === "open") this.notice("success", "Reconnected; resumed from the last event");
			if (state === "closed") this.notice("error", "Disconnected");
		});
	}

	private banner(): string[] {
		const host = this.client.host;
		const width = this.frame(78);
		const hostParts = [
			host?.hostName ?? "host",
			host?.version ? `Pier ${host.version}` : "",
			`pi ${host?.piVersion ?? "?"}`,
		];
		const pairs: Array<[string, string]> = [
			[
				"host",
				hostParts
					.filter(Boolean)
					.map((part) => sanitize(part))
					.join(c.gray(" · ")),
			],
			[
				"workspace",
				this.workspace
					? `${sanitize(this.workspace.name)}  ${c.gray(sanitize(this.workspace.path))}  ${c.gray(this.workspace.policy)}`
					: c.yellow("none yet · /ws add <path>"),
			],
		];
		if (this.runtimes.length > 1)
			pairs.push([
				"agents",
				this.runtimes
					.map((r) => (r.available ? sanitize(r.name) : c.gray(`${sanitize(r.name)} (unavailable)`)))
					.join(c.gray(" · ")),
			]);
		const title = `${c.accent(c.bold("✦ Pier"))} ${c.bold("CLI")} ${c.gray(`v${PIER_CLI_VERSION}`)}`;
		const tips = [
			span("/help", c.accent),
			span(" commands · ", c.gray),
			span("/new", c.accent),
			span(" start a session · ", c.gray),
			span("/open", c.accent),
			span(" resume one · ", c.gray),
			span("Tab", c.accent),
			span(" completes", c.gray),
		];
		if (!this.screen.interactive || width < 48)
			return [title, ...keyValues(pairs, this.width), ...formatBlock(tips, this.width, [span("  ")])];
		const inner = width - 4;
		const rows = [title, "", ...keyValues(pairs, inner), "", ...formatBlock(tips, inner, [span("  ")])];
		return ["", ...box(rows, width, { border: c.accent })];
	}

	private showPairingRequest(request: PairingRequest): void {
		const width = this.frame(80);
		const device = request.device;
		const about = [device.platform, device.model, device.appVersion]
			.filter(Boolean)
			.map((part) => sanitize(String(part)));
		const rows = [
			...formatBlock([span(sanitize(device.name), c.bold), span(" wants to connect")], width - 4),
			...keyValues(
				[
					["device", about.join(" · ") || "?"],
					["fingerprint", request.fingerprint],
					...(request.address ? [["from", request.address] as [string, string]] : []),
				],
				width - 4,
				"",
			),
			"",
			`${c.accent("/pair yes")} ${c.gray("allow")}   ${c.accent("/pair no")} ${c.gray("decline")}`,
		];
		this.emit(["", ...box(rows, width, { border: c.yellow, title: "Pairing request" })]);
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

	private async listAgents(): Promise<void> {
		const runtimes = await this.fetchRuntimes();
		const rows: ListRow[] = runtimes.map((r) => ({
			cells: [
				sanitize(r.name),
				sanitize(`${r.id}${r.version ? ` ${r.version}` : ""}`),
				r.available ? c.green("available") : c.red(`unavailable${r.reason ? `: ${sanitize(r.reason)}` : ""}`),
			],
			muted: !r.available,
		}));
		this.emit([
			...list(rows, this.width),
			...resultLine(
				[
					span("New session: ", c.gray),
					span("/new -a <n|id|name> [name]", c.accent),
					span(" (e.g. /new -a claude). Models: ", c.gray),
					span("/models <agent>", c.accent),
				],
				this.width,
			),
		]);
	}

	// ── Sessions ──────────────────────────────────────────────────────────────

	private resetRun(): void {
		this.stream.finish();
		this.tools.clear();
		this.streaming = false;
		this.runStartedAt = undefined;
		this.compactStartedAt = undefined;
		this.retry = undefined;
		this.queued = 0;
		this.interrupted = false;
	}

	private async attach(session: SessionSummary): Promise<void> {
		await this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.pendingUi.clear();
		this.resetRun();
		this.sessionId = session.id;
		this.session = session;
		this.agent = runtimeName(session.runtime, this.runtimes);
		// Each runtime has its own models; drop the listing of the previous session.
		this.modelCache = undefined;
		this.listedModels = [];
		this.model = undefined;
		this.thinkingLevel = undefined;
		this.contextWindow = undefined;
		this.contextUsed = undefined;
		this.say([
			span("Attached to "),
			span(sessionTitle(session) || "a new session", c.bold),
			span(` · ${this.agent}`, c.gray),
		]);
		const sub = await this.client.subscribe(session.id, (frame) => this.onSessionEvent(frame), {
			workspaceId: session.workspaceId,
		});
		this.unsubscribe = () => sub.unsubscribe();
		this.emit([]);
	}

	private onSessionEvent(frame: EventFrame): void {
		const event = frame.event;
		if (frame.sessionId && frame.sessionId !== this.sessionId && event.type !== "session.replaced") return;
		const width = this.width;
		switch (event.type) {
			case "session.snapshot":
				this.showSnapshot(event.snapshot as SessionSnapshot);
				break;
			case "agent_start":
				this.streaming = true;
				this.runStartedAt ??= Date.now();
				this.emit([]);
				break;
			case "message_start": {
				const message = event.message as TranscriptMessage | undefined;
				if (message?.role === "assistant") this.emit(this.stream.finish());
				else if (message?.role === "user") {
					// Prompts typed here are on screen already; show those sent from other devices.
					const text = textOf(message.content).trim();
					const mine = this.sent.indexOf(text);
					if (mine >= 0) this.sent.splice(mine, 1);
					else if (text) this.emit(userMessage(text, width, { maxRows: 6 }));
				}
				break;
			}
			case "message_update": {
				const inner = event.assistantMessageEvent as { type: string; delta?: string };
				if (inner.type === "text_delta" && inner.delta) this.emit(this.stream.push("text", inner.delta));
				else if (inner.type === "thinking_delta" && inner.delta) this.emit(this.stream.push("thinking", inner.delta));
				break;
			}
			case "message_end": {
				const message = event.message as TranscriptMessage | undefined;
				if (message?.role !== "assistant") break;
				const rows = this.stream.finish();
				const used = contextTokens(message.usage);
				if (used) this.contextUsed = used;
				this.emit(rows);
				// An interrupted run ends with an "aborted" error, which the end of the run reports.
				const aborted = message.stopReason === "aborted" || /\babort/i.test(message.errorMessage ?? "");
				if (message.stopReason === "error" && message.errorMessage && !aborted)
					this.notice("error", message.errorMessage);
				break;
			}
			case "tool_execution_start":
				this.tools.set(String(event.toolCallId), { name: String(event.toolName ?? "tool"), args: event.args });
				this.emit(this.stream.finish());
				break;
			case "tool_execution_update": {
				const tool = this.tools.get(String(event.toolCallId));
				if (!tool) break;
				const lines = sanitize(toolResultText(event.partialResult).text, true).split("\n");
				tool.output = lines
					.map((line) => line.trimEnd())
					.filter(Boolean)
					.at(-1);
				this.emit([]);
				break;
			}
			case "tool_execution_end": {
				const id = String(event.toolCallId);
				const tool = this.tools.get(id);
				this.tools.delete(id);
				const name = tool?.name ?? String(event.toolName ?? "tool");
				const failed = Boolean(event.isError);
				this.emit([
					"",
					...toolHeader(name, tool?.args ?? event.args, failed ? "error" : "ok", width),
					...toolResult(name, event.result, failed, width),
				]);
				break;
			}
			case "queue_update":
				this.queued = (event.steering as string[]).length + (event.followUp as string[]).length;
				this.emit([]);
				break;
			case "agent_settled": {
				const rows = this.stream.finish();
				const elapsed = formatDuration(this.runStartedAt ? Date.now() - this.runStartedAt : 0);
				const end = this.interrupted ? c.yellow(`■ Interrupted after ${elapsed}`) : c.gray(`✓ Worked for ${elapsed}`);
				this.resetRun();
				this.emit([...rows, "", end]);
				break;
			}
			case "session.status": {
				const busy = isBusy(event.state as SessionRunState);
				// A run starting now, even if the last one never reported its end.
				if (busy && !this.streaming) this.runStartedAt = Date.now();
				this.streaming = busy;
				this.emit([]);
				break;
			}
			case "auto_retry_start":
				this.retry = `Retrying ${String(event.attempt)}/${String(event.maxAttempts)}`;
				this.notice("warning", `${this.retry}: ${String(event.errorMessage)}`);
				break;
			case "auto_retry_end":
				this.retry = undefined;
				this.emit([]);
				break;
			case "compaction_start":
				this.compactStartedAt = Date.now();
				this.emit(this.stream.finish());
				break;
			case "compaction_end":
				this.compactStartedAt = undefined;
				this.notice("info", `Compaction ${event.aborted ? "aborted" : "finished"}`);
				break;
			case "ui.request":
				this.pendingUi.set((event.request as UiRequest).id, event.request as UiRequest);
				this.showUiRequest(event.request as UiRequest);
				break;
			case "ui.resolved": {
				const request = this.pendingUi.get(String(event.requestId));
				this.pendingUi.delete(String(event.requestId));
				if (request) this.say(resolutionText(event.resolution, event.response as UiResponse | undefined), c.gray);
				else this.emit([]);
				break;
			}
			case "ui.notify":
				this.notice(noticeLevel(event.level), String(event.message));
				break;
			case "extension.error":
				this.notice("error", `Extension error in ${String(event.extensionPath)}: ${String(event.error)}`);
				break;
			case "session.model": {
				const model = event.model as ModelInfo | undefined;
				if (model) this.model = model;
				this.thinkingLevel = String(event.thinkingLevel);
				const info = event.contextInfo as SessionSnapshot["contextInfo"];
				this.contextWindow = info?.contextWindow ?? this.model?.contextWindow;
				this.emit([]);
				break;
			}
			case "thinking_level_changed":
				if (typeof event.level === "string") this.thinkingLevel = event.level;
				this.emit([]);
				break;
			case "session_info_changed":
				if (typeof event.name === "string" && this.session) this.session = { ...this.session, name: event.name };
				this.emit([]);
				break;
			case "session.replaced": {
				const next = event.session as SessionSummary;
				this.sessionId = next.id;
				this.session = next;
				this.agent = runtimeName(next.runtime, this.runtimes);
				this.notice("warning", `Session replaced → ${next.id}`);
				break;
			}
			case "session.closed":
				if (frame.sessionId === this.sessionId) {
					this.sessionId = undefined;
					this.session = undefined;
					this.resetRun();
				}
				this.notice("warning", `Session closed: ${String(event.reason)}`);
				break;
		}
	}

	private showSnapshot(snapshot: SessionSnapshot): void {
		this.session = snapshot.session;
		this.agent = runtimeName(snapshot.session.runtime, this.runtimes);
		this.model = snapshot.model;
		this.thinkingLevel = snapshot.thinkingLevel;
		this.contextWindow = snapshot.contextInfo?.contextWindow ?? snapshot.model?.contextWindow;
		this.pendingUi.clear();
		for (const request of snapshot.pendingUi) this.pendingUi.set(request.id, request);
		this.resetRun();
		const messages = snapshot.messages as TranscriptMessage[];
		for (const message of [...messages].reverse()) {
			const used = message.role === "assistant" ? contextTokens(message.usage) : undefined;
			if (used) {
				this.contextUsed = used;
				break;
			}
		}
		// Tool calls still running stay in the live area rather than the history.
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		for (const id of snapshot.pendingToolCalls) {
			const call = partsOf(lastAssistant?.content).find((p) => p.type === "toolCall" && p.id === id);
			this.tools.set(id, { name: call?.name ?? "tool", args: call?.arguments });
		}
		this.streaming = isBusy(snapshot.session.state);
		if (this.streaming) this.runStartedAt = Date.now();
		const total = (snapshot.messagesFrom ?? 0) + messages.length;
		if (total) this.emit(this.historyRows(messages, total));
		// The message being written continues with the next deltas.
		const live = snapshot.streamingMessage as TranscriptMessage | undefined;
		if (live?.role === "assistant")
			for (const part of partsOf(live.content)) {
				if (part.type === "text" && part.text) this.emit(this.stream.push("text", part.text));
				else if (part.type === "thinking" && part.thinking) this.emit(this.stream.push("thinking", part.thinking));
			}
		for (const request of snapshot.pendingUi) this.showUiRequest(request);
	}

	/** The last messages of a transcript: prompts, replies and tool calls with their results. */
	private historyRows(messages: TranscriptMessage[], total: number): string[] {
		const width = this.width;
		const visible = (m: TranscriptMessage) => m.role === "user" || m.role === "assistant";
		let start = messages.length;
		for (let i = messages.length - 1, shown = 0; i >= 0 && shown < HISTORY_MESSAGES; i--) {
			if (!visible(messages[i] as TranscriptMessage)) continue;
			shown++;
			start = i;
		}
		const results = new Map<string, TranscriptMessage>();
		for (const m of messages) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
		const rows = [
			"",
			rule(
				this.frame(),
				c.bold(sessionTitle(this.session) || "New session"),
				c.gray(`${this.agent} · ${total} message${total === 1 ? "" : "s"}`),
			),
		];
		const earlier = messages.slice(0, start).filter(visible).length + (total - messages.length);
		if (earlier) rows.push(c.gray(`  … ${earlier} earlier message${earlier === 1 ? "" : "s"}`));
		for (const message of messages.slice(start)) {
			if (message.role === "user") rows.push(...userMessage(textOf(message.content), width, { maxRows: 6 }));
			if (message.role !== "assistant") continue;
			for (const part of partsOf(message.content)) {
				if (part.type === "text" && part.text?.trim()) rows.push(...this.markdownRows(part.text, 20));
				if (part.type !== "toolCall" || (part.id && this.tools.has(part.id))) continue;
				const result = part.id ? results.get(part.id) : undefined;
				const name = part.name ?? "tool";
				rows.push(
					"",
					...toolHeader(name, part.arguments, result?.isError ? "error" : "ok", width, { maxRows: 1 }),
					...(result ? toolResult(result.toolName ?? name, result, Boolean(result.isError), width, 2) : []),
				);
			}
			if (message.stopReason === "error" && message.errorMessage)
				rows.push(...resultLine(sanitize(message.errorMessage), width, c.red));
		}
		return rows;
	}

	/** A finished reply, as at most `maxRows` rows. */
	private markdownRows(text: string, maxRows: number): string[] {
		const stream = new MessageStream({ width: () => this.width, markdown: this.screen.interactive });
		const rows = [...stream.push("text", `${text}\n`), ...stream.finish()];
		if (rows.length <= maxRows + 1) return rows;
		return [...rows.slice(0, maxRows + 1), c.gray(`  … +${rows.length - maxRows - 1} lines`)];
	}

	private showUiRequest(request: UiRequest): void {
		const width = this.frame(90);
		const inner = width - 4;
		if (request.kind === "approval" && request.approval) {
			const a = request.approval;
			const high = a.severity === "high";
			const actions = [
				span("/allow", c.accent),
				span(" once", c.gray),
				...(a.sessionAllowable
					? [
							span("   /allow session", c.accent),
							span(" "),
							...inlineMarkdown(sanitize(a.sessionScope ?? "same kind"), c.gray),
						]
					: []),
				span("   /deny", c.accent),
				span(" [reason]", c.gray),
			];
			const rows = [
				...formatBlock([span(sanitize(a.toolName), c.bold), span("  "), span(sanitize(a.summary))], inner),
				...(a.reason ? formatBlock(inlineMarkdown(sanitize(a.reason), c.gray), inner) : []),
				"",
				...formatBlock(actions, inner),
			];
			const title = high ? "High-risk approval" : "Approval needed";
			this.emit(["", ...box(rows, width, { border: high ? c.red : c.yellow, title })]);
			return;
		}
		const rows = formatBlock([span(sanitize(request.title), c.bold)], inner);
		if (request.message) rows.push(...formatBlock([span(sanitize(request.message))], inner));
		for (const [i, option] of (request.options ?? []).entries())
			rows.push(...formatBlock([span(sanitize(option))], inner, [span(`${i + 1}. `, c.accent)]));
		rows.push(
			"",
			request.kind === "confirm"
				? `${c.accent("/yes")}   ${c.accent("/no")}`
				: `${c.accent("/answer")} ${c.gray(request.kind === "select" ? "<n|text>" : "<text>")}   ${c.accent("/cancel")}`,
		);
		const titles: Record<string, string> = { confirm: "Confirm", select: "Choose", input: "Input", editor: "Editor" };
		this.emit(["", ...box(rows, width, { border: c.accent, title: titles[request.kind] ?? request.kind })]);
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
		if (!accepted) this.say("Already resolved by another client", c.gray);
	}

	private pick<T extends { id: string }>(items: T[], ref: string): T {
		const index = Number(ref);
		const item = Number.isInteger(index) && index >= 1 ? items[index - 1] : items.find((i) => i.id === ref);
		if (!item) throw new Error(`No match for ${ref}`);
		return item;
	}

	// ── Models ────────────────────────────────────────────────────────────────

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

	private modelRows(models: readonly ModelInfo[], current: ModelInfo | undefined | null, numbered: boolean): string[] {
		return list(
			models.map((m) => ({
				cells: [sanitize(`${m.provider}/${m.id}`), sanitize(m.name)],
				current: Boolean(current && current.provider === m.provider && current.id === m.id),
			})),
			this.width,
			{ numbered },
		);
	}

	private async listModels(): Promise<void> {
		const { models, current } = await this.fetchModels();
		this.listedModels = models;
		if (!models.length) {
			this.say("No models available. Sign in to a provider first.");
			return;
		}
		this.emit([
			...this.modelRows(models, current, true),
			...resultLine(
				[
					span("Switch with ", c.gray),
					span("/model <n>", c.accent),
					span(", ", c.gray),
					span("/model <provider>/<id>", c.accent),
					span(" or ", c.gray),
					span("/model <id>", c.accent),
					span("; Tab completes.", c.gray),
				],
				this.width,
			),
		]);
	}

	/**
	 * `/models <agent>`: the models of any agent, `●` marking its default for new sessions in this
	 * workspace. Not numbered and not remembered, since `/model <n>` switches the attached session.
	 */
	private async listAgentModels(ref: string): Promise<void> {
		const runtime = requireAvailable(resolveRuntime(await this.fetchRuntimes(), ref));
		const { models, current } = await this.client.request("model.list", {
			runtime: runtime.id,
			...(this.workspace ? { workspaceId: this.workspace.id } : {}),
		});
		if (!models.length) {
			this.say(`${runtime.name} reports no models.`);
			return;
		}
		this.emit([
			...resultLine(`${runtime.name} models (● = default for new sessions):`, this.width, c.gray),
			...this.modelRows(models, current, false),
			...resultLine(
				[
					span("Use them in a session created with ", c.gray),
					span(`/new -a ${runtime.id}`, c.accent),
					span(", then ", c.gray),
					span("/model", c.accent),
					span(".", c.gray),
				],
				this.width,
			),
		]);
	}

	private modelChanged(model: { provider: string; id: string }): void {
		this.modelCache = undefined;
		if ("name" in model) this.model = model as ModelInfo;
		else if (this.model) this.model = { ...this.model, provider: model.provider, id: model.id };
		this.say([span("Model: ", c.gray), span(sanitize(`${model.provider}/${model.id}`), c.bold)]);
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

	// ── Lists ─────────────────────────────────────────────────────────────────

	private listSessions(): void {
		if (!this.sessions.length) {
			this.say([span("No sessions in this workspace yet. Create one with "), span("/new", c.accent), span(".")]);
			return;
		}
		this.emit(
			list(
				this.sessions.map((s) => ({
					cells: [
						flatLine(sessionTitle(s) || "(empty)", 60),
						`${this.sessionDetail(s)} · ${relativeTime(s.modifiedAt)}`,
					],
					current: s.id === this.sessionId,
					muted: !sessionTitle(s),
				})),
				this.width,
			),
		);
	}

	private listWorkspaces(): void {
		if (!this.workspaces.length) {
			this.say([span("No workspaces yet. Add one with "), span("/ws add <path>", c.accent), span(".")]);
			return;
		}
		this.emit(
			list(
				this.workspaces.map((w) => ({
					cells: [sanitize(w.name), sanitize(w.path), w.policy],
					current: w.id === this.workspace?.id,
				})),
				this.width,
			),
		);
	}

	private listDevices(): void {
		if (!this.devices.length) {
			this.say("No paired devices.");
			return;
		}
		this.emit(
			list(
				this.devices.map((d) => ({
					cells: [
						sanitize(d.name),
						sanitize([d.platform, d.fingerprint].filter(Boolean).join(" · ")),
						d.connected ? c.green("online") : d.lastSeenAt ? `last seen ${relativeTime(d.lastSeenAt)}` : "",
					],
				})),
				this.width,
			),
		);
	}

	/** `/open` without an argument: pick a session of the workspace, or list them without a terminal. */
	private async chooseSession(): Promise<SessionSummary | undefined> {
		this.sessions = (await this.client.request("session.list", { workspaceId: this.requireWorkspace().id })).sessions;
		if (!this.picker || !this.sessions.length) {
			this.listSessions();
			if (this.sessions.length) this.say([span("Open one with ", c.gray), span("/open <n>", c.accent)]);
			return undefined;
		}
		const picked = await this.choose({
			title: "Open a session",
			items: this.sessions.map((s) => ({
				label: sessionTitle(s) || "(empty)",
				detail: `${this.sessionDetail(s)} · ${relativeTime(s.modifiedAt)}`,
				current: s.id === this.sessionId,
				value: s,
			})),
		});
		if (!picked) this.say("No session opened.", c.gray);
		return picked;
	}

	/** `/ws use` without an argument. */
	private async chooseWorkspace(): Promise<WorkspaceInfo | undefined> {
		if (!this.picker || !this.workspaces.length) {
			this.listWorkspaces();
			if (this.workspaces.length) this.say([span("Select one with ", c.gray), span("/ws use <n>", c.accent)]);
			return undefined;
		}
		const picked = await this.choose({
			title: "Select a workspace",
			items: this.workspaces.map((w) => ({
				label: sanitize(w.name),
				detail: sanitize(`${w.path} [${w.policy}]`),
				current: w.id === this.workspace?.id,
				value: w,
			})),
		});
		if (!picked) this.say("Workspace unchanged.", c.gray);
		return picked;
	}

	/** `/revoke` without an argument. */
	private async chooseDevice(): Promise<DeviceInfo | undefined> {
		if (!this.picker || !this.devices.length) {
			this.listDevices();
			if (this.devices.length) this.say([span("Revoke one with ", c.gray), span("/revoke <n>", c.accent)]);
			return undefined;
		}
		const picked = await this.choose({
			title: "Revoke a paired device (it is disconnected immediately)",
			items: this.devices.map((d) => ({
				label: sanitize(d.name),
				detail: sanitize(`${d.platform ?? ""} ${d.fingerprint}${d.connected ? " · online" : ""}`.trim()),
				value: d,
			})),
		});
		if (!picked) this.say("No device revoked.", c.gray);
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

	/** Remember a message sent from here, so the host's echo of it is not shown again. */
	private remember(text: string): void {
		this.sent.push(text.trim());
		if (this.sent.length > 20) this.sent.shift();
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	async handle(input: string): Promise<boolean> {
		const trimmed = input.trim();
		if (!trimmed) return true;
		if (!trimmed.startsWith("/")) {
			const sessionId = this.requireSession();
			const followUp = this.streaming;
			this.remember(trimmed);
			if (this.session && !this.session.name && !this.session.firstMessage)
				this.session = { ...this.session, firstMessage: trimmed };
			await this.client.request("session.prompt", {
				sessionId,
				text: trimmed,
				...(followUp ? { streamingBehavior: "followUp" as const } : {}),
			});
			if (followUp) this.say("Queued as a follow-up", c.gray);
			return true;
		}
		const [command = "", ...rest] = trimmed.slice(1).split(/\s+/);
		const arg = rest.join(" ");
		switch (command) {
			case "help":
				this.emit(helpRows(HELP_SECTIONS, HELP_NOTES, this.width));
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
					this.say([
						span("Workspace "),
						span(sanitize(workspace.name), c.bold),
						span(` · ${workspace.policy} · selected`, c.gray),
					]);
				} else if (sub === "use") {
					this.workspaces = (await this.client.request("workspace.list")).workspaces;
					const workspace = wsArgs[0] ? this.pick(this.workspaces, wsArgs[0]) : await this.chooseWorkspace();
					if (!workspace) break;
					this.selectWorkspace(workspace);
					this.say([span("Workspace "), span(sanitize(workspace.name), c.bold), span(" selected", c.gray)]);
				} else if (sub === "policy") {
					const { workspace } = await this.client.request("workspace.setPolicy", {
						workspaceId: this.requireWorkspace().id,
						policy: wsArgs[0] as WorkspaceInfo["policy"],
					});
					this.workspace = workspace;
					this.say([span("Approval policy: ", c.gray), span(workspace.policy, c.bold)]);
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
				const s = snapshot.session;
				this.model = snapshot.model;
				this.thinkingLevel = snapshot.thinkingLevel;
				this.contextWindow = snapshot.contextInfo?.contextWindow ?? snapshot.model?.contextWindow;
				const percent = this.contextPercent();
				const context =
					percent === undefined
						? "unknown"
						: `${this.contextUsed?.toLocaleString("en-US")} / ${this.contextWindow?.toLocaleString("en-US")} tokens (${percent}%)`;
				const pending = snapshot.pendingUi.length;
				this.emit(
					keyValues(
						[
							["session", `${c.bold(sessionTitle(s) || "new session")}  ${c.gray(s.id)}`],
							["agent", runtimeName(s.runtime, this.runtimes)],
							["state", isBusy(s.state) ? c.accent(s.state) : s.state],
							["model", snapshot.model ? sanitize(`${snapshot.model.provider}/${snapshot.model.id}`) : "none"],
							["thinking", snapshot.thinkingLevel],
							["context", context],
							["directory", sanitize(s.cwd)],
							["pending", `${pending} UI request${pending === 1 ? "" : "s"}`],
							["seq", String(snapshot.seq)],
						],
						this.width,
						"    ",
					),
				);
				break;
			}
			case "rename":
				await this.client.request("session.rename", { sessionId: this.requireSession(), name: arg });
				if (this.session) this.session = { ...this.session, name: arg };
				this.say([span("Renamed to "), span(sanitize(arg), c.bold)]);
				break;
			case "fork": {
				const sessionId = this.requireSession();
				const { points } = await this.client.request("session.forkPoints", { sessionId });
				if (!arg) {
					if (!points.length) this.say("No fork points yet.", c.gray);
					else
						this.emit(
							list(
								points.map((p) => ({ cells: [flatLine(p.text, 80)] })),
								this.width,
							),
						);
					break;
				}
				const point = points[Number(arg) - 1];
				if (!point) throw new Error("No such fork point");
				const { session, selectedText } = await this.client.request("session.fork", {
					sessionId,
					entryId: point.entryId,
				});
				await this.attach(session);
				if (selectedText) this.say(`Forked before: ${flatLine(selectedText, 200)}`, c.gray);
				break;
			}
			case "steer":
				this.remember(arg);
				await this.client.request("session.steer", { sessionId: this.requireSession(), text: arg });
				this.say("Steering the agent", c.gray);
				break;
			case "follow":
				this.remember(arg);
				await this.client.request("session.followUp", { sessionId: this.requireSession(), text: arg });
				this.say("Follow-up queued", c.gray);
				break;
			case "abort": {
				const sessionId = this.requireSession();
				// A run that was going reports its end itself.
				const running = this.streaming;
				if (running) this.interrupted = true;
				try {
					await this.client.request("session.abort", { sessionId });
				} catch (error) {
					this.interrupted = false;
					throw error;
				}
				if (!running) this.say("Aborted", c.gray);
				break;
			}
			case "compact": {
				const result = await this.client.request(
					"session.compact",
					{ sessionId: this.requireSession(), ...(arg ? { instructions: arg } : {}) },
					{ timeoutMs: 10 * 60_000 },
				);
				this.contextUsed = undefined;
				this.say(`Compacted from ${result.tokensBefore.toLocaleString("en-US")} tokens`, c.gray);
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
						this.say("No models available. Sign in to a provider first.");
						break;
					}
					const picked = await this.choose({
						title: "Select a model",
						items: models.map((m) => ({
							label: sanitize(`${m.provider}/${m.id}`),
							detail: sanitize(m.name),
							current: current?.provider === m.provider && current.id === m.id,
							value: m,
						})),
					});
					if (!picked) {
						this.say("Model unchanged.", c.gray);
						break;
					}
					const { model } = await this.client.request("model.set", {
						sessionId,
						provider: picked.provider,
						modelId: picked.id,
					});
					this.modelChanged(model);
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
				this.modelChanged(model);
				break;
			}
			case "thinking": {
				const sessionId = this.requireSession();
				let target = arg as ThinkingLevel;
				if (!arg) {
					const { current, thinkingLevel } = await this.fetchModels();
					const levels = current?.thinkingLevels ?? ThinkingLevelSchema.options;
					const picked = await this.choose({
						title: `Thinking level${current ? ` for ${sanitize(`${current.provider}/${current.id}`)}` : ""}`,
						items: levels.map((level) => ({ label: level, current: level === thinkingLevel, value: level })),
					});
					if (!picked) {
						this.say([
							span("Thinking: ", c.gray),
							span(thinkingLevel ?? "unknown", c.bold),
							span(` (available: ${levels.join(", ")})`, c.gray),
						]);
						break;
					}
					target = picked;
				}
				const { level } = await this.client.request("thinking.set", { sessionId, level: target });
				this.modelCache = undefined;
				this.thinkingLevel = level;
				this.say([span("Thinking: ", c.gray), span(level, c.bold)]);
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
				const listening = status.running ? c.gray(` · listening on port ${status.port}`) : "";
				const failure = status.error ? c.red(` (${sanitize(status.error)})`) : "";
				this.emit(
					keyValues(
						[
							["remote access", `${status.enabled ? c.green("on") : "off"}${listening}${failure}`],
							["addresses", status.addresses.length ? status.addresses.join(", ") : c.gray("none")],
							["fingerprint", status.hostFingerprint],
						],
						this.width,
						"    ",
					),
				);
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
					if (!accepted) this.say("The request is no longer pending.", c.yellow);
					break;
				}
				const pairing = await this.client.request("pairing.start");
				this.emit(pairingRows(pairing, this.width, this.screen.interactive));
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
				if (revoked) this.say([span("Revoked "), span(sanitize(device.name), c.bold)]);
				else this.say("Device was already gone.", c.gray);
				this.devices = this.devices.filter((d) => d.id !== device.id);
				break;
			}
			case "drop":
				this.client.dropConnection();
				break;
			default: {
				const names = CLI_COMMANDS.map((cmd) => cmd.name);
				const guess =
					names.find((name) => command && name.startsWith(command)) ??
					names.find((name) => distance(name, command) <= 2);
				this.say([
					span(`Unknown command /${sanitize(command)}.`),
					...(guess
						? [span(" Did you mean "), span(`/${guess}`, c.accent), span("?")]
						: [span(" Try "), span("/help", c.accent), span(".")]),
				]);
			}
		}
		return true;
	}
}

/**
 * `stream` as readline's output, offering each write to `take` first: what it takes is written
 * later as part of the screen's frame.
 */
function routeWrites(stream: NodeJS.WriteStream, take: (text: string) => boolean): NodeJS.WriteStream {
	return new Proxy(stream, {
		get(target, property) {
			if (property === "write")
				return (chunk: string | Uint8Array, ...rest: unknown[]) => {
					if (take(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))) {
						const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
						if (callback) queueMicrotask(callback);
						return true;
					}
					return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A line offered for a selected candidate. */
interface LineChoice {
	text: string;
	/** Where the cursor goes in `text`. */
	cursor: number;
	/** Enter runs the line right away instead of only filling it in. */
	submit: boolean;
}

interface ReadlineKey {
	name?: string;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
}

/**
 * While candidates are listed, ↑/↓ select one and Tab or Enter fills it in. readline handles
 * every key in `_ttyWrite` (Node and Bun alike), so the keys are taken there before it sees them;
 * otherwise they keep their meaning, and ↑/↓ keep walking the history once they started to.
 */
function chooseWithArrows(rl: Interface, cli: Cli): void {
	const keys = rl as unknown as { _ttyWrite(sequence: string | undefined, key: ReadlineKey | undefined): void };
	const ttyWrite = keys._ttyWrite;
	if (typeof ttyWrite !== "function") return;
	let browsingHistory = false;
	const replaceLine = (choice: LineChoice) => {
		rl.write(null, { ctrl: true, name: "e" });
		rl.write(null, { ctrl: true, name: "u" });
		rl.write(choice.text);
		for (let n = [...choice.text.slice(choice.cursor)].length; n > 0; n--) rl.write(null, { name: "left" });
	};
	keys._ttyWrite = (sequence, key) => {
		const name = key?.ctrl || key?.meta || key?.shift ? undefined : key?.name;
		if (name === "up" || name === "down") {
			if (!browsingHistory && cli.select(rl.line, name === "up" ? -1 : 1)) return;
			browsingHistory = true;
		} else if (key) {
			browsingHistory = false;
			const enter = name === "return" || name === "enter";
			const choice = name === "tab" || enter ? cli.takeSelected(rl.line) : undefined;
			// Enter on what is typed already just runs it.
			if (choice && !(enter && choice.text === rl.line)) {
				replaceLine(choice);
				if (!(enter && choice.submit)) return;
			}
		}
		ttyWrite.call(rl, sequence, key);
	};
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
	setColorLevel(detectColorLevel(process.env, Boolean(process.stdout.isTTY)));
	if (values.help) {
		const width = process.stdout.columns ? process.stdout.columns - 1 : 100;
		console.log(
			[
				"pier cli [--url ws://127.0.0.1:<port>] [--token <token>] [--pier-dir <dir>]",
				"         [--ssh-pair]  pair the computer adding this one over SSH (JSON on stdin and stdout)",
				...helpRows(HELP_SECTIONS, HELP_NOTES, width),
			].join("\n"),
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

	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	let screen: CliScreen | undefined;
	const rl = createInterface({
		input: process.stdin,
		output: interactive ? routeWrites(process.stdout, (text) => screen?.readlineWrite(text) ?? false) : process.stdout,
		terminal: interactive,
		prompt: interactive ? `${c.accent(c.bold("❯"))} ` : "",
		// A lone Esc closes the picker and interrupts the agent; don't wait 500 ms for a longer sequence.
		escapeCodeTimeout: 100,
		completer: (line: string, callback: (error: Error | null, result: CompleterResult) => void) => {
			void cli.complete(line).then(([hits, partial]) => {
				if (!interactive || hits.length < 2) return callback(null, [hits, partial]);
				// Insert what all candidates share; list them only when that adds nothing.
				const shared = commonPrefix(hits);
				if (shared.length > partial.length) return callback(null, [[shared], partial]);
				cli.showCompletions(rl.line, hits, partial, rl.cursor);
				callback(null, [[], partial]);
			});
		},
	});
	const view: CliScreen = interactive ? new TerminalScreen(process.stdout, rl) : new PlainScreen(process.stdout);
	screen = view;
	const cli = new Cli(
		client,
		view,
		interactive ? (options) => runTerminalPicker(process.stdin, process.stdout, options) : undefined,
	);
	// Attach the line handler before any await so early (piped) input is not lost, and
	// handle lines strictly in order.
	let queue: Promise<unknown> = cli
		.init()
		.then(() => view.showPrompt())
		.catch((error: unknown) => cli.fail(error));
	let closing = false;
	rl.on("line", (input) => {
		cli.lineEntered();
		view.acceptLine(input, cli.echo(input));
		queue = queue
			.then(() => (closing ? false : cli.handle(input)))
			.then((keepGoing) => {
				if (keepGoing === false && !closing) {
					closing = true;
					rl.close();
				}
			})
			.catch((error: unknown) => cli.fail(error));
	});
	if (interactive) {
		chooseWithArrows(rl, cli);
		process.stdin.on(
			"keypress",
			(_sequence: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
				if (key?.name === "escape" && !cli.dropSelected()) cli.interrupt();
				if (key?.ctrl && key.name === "l") view.cleared();
				cli.inputChanged(rl.line);
			},
		);
		let lastCtrlC = 0;
		rl.on("SIGINT", () => {
			if (rl.line) {
				rl.write(null, { ctrl: true, name: "e" });
				rl.write(null, { ctrl: true, name: "u" });
				cli.inputChanged("");
				return;
			}
			if (cli.interrupt()) return;
			if (Date.now() - lastCtrlC < 2_000) {
				rl.close();
				return;
			}
			lastCtrlC = Date.now();
			cli.flashHint("Press Ctrl+C again to exit");
		});
	}
	rl.on("close", () => {
		const finish = () => {
			closing = true;
			cli.exit();
			view.close();
		};
		// Ctrl+C, Ctrl+D and /quit end the CLI right away. Piped input arrives with its end before
		// the CLI has connected, so the commands queued before the end still run first.
		if (interactive) finish();
		void queue.finally(() => {
			finish();
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
	console.error(c.red(`pier cli: ${error instanceof Error ? error.message : String(error)}`));
	void exitCli(1);
});
