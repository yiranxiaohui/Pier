import { type AssistantMessage, type ChatState, isSubagentTool, summarizeToolCall } from "@pier/chat-state";
import type { SessionSummary, UiRequest } from "@pier/protocol";
import type { PierStore } from "./store.tsx";

/** Whether a session's agent is busy (replying, retrying or compacting). */
export function isRunning(state: SessionSummary["state"]): boolean {
	return state === "streaming" || state === "retrying" || state === "compacting";
}

/**
 * Whether a session runs or waits for an answer: from its live chat once that is loaded (it
 * follows the events), else from the host's session list.
 */
export function sessionActivity(store: PierStore, session: SessionSummary) {
	const live = store.liveChat(session.id)?.chat;
	const state = live?.loaded ? live.runState : session.state;
	const pending = live?.loaded ? live.pendingUi.length : (session.pendingUi ?? 0);
	const running = isRunning(state);
	return { running, pending, active: running || pending > 0 };
}

/**
 * What an agent of the Agent studio is doing, which picks its animation:
 * - `thinking`: waiting for the model, reasoning or planning;
 * - `writing`: streaming its reply;
 * - `reading` / `searching` / `editing` / `command` / `browsing`: running that kind of tool;
 * - `delegating`: waiting on subagents it started;
 * - `tool`: running some other tool;
 * - `waiting`: a dialog or approval waits for the user;
 * - `compacting` / `retrying`: the run state of that name;
 * - `working`: busy, details not known yet (the live chat is loading);
 * - `resting` / `error`: not running, the last run ended well / with an error.
 */
export type StudioMood =
	| "thinking"
	| "writing"
	| "reading"
	| "searching"
	| "editing"
	| "command"
	| "browsing"
	| "delegating"
	| "tool"
	| "waiting"
	| "compacting"
	| "retrying"
	| "working"
	| "resting"
	| "error";

export interface StudioActivity {
	mood: StudioMood;
	/** Short line for the speech bubble, e.g. “编辑文件”. */
	label: string;
	/** What it works on, e.g. a file name or the command; short enough for one line. */
	detail?: string;
}

const DETAIL_MAX = 48;

function clip(text: string, max = DETAIL_MAX): string {
	const line = text.trim().split("\n", 1)[0]?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Last segment of a path, keeping a trailing directory name readable. */
function baseName(path: string): string {
	const trimmed = path.trim().replace(/[\\/]+$/, "");
	const name = trimmed.split(/[\\/]/).at(-1);
	return name || trimmed || path;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function withDetail(mood: StudioMood, label: string, detail: string | undefined): StudioActivity {
	const shown = detail ? clip(detail) : "";
	return shown ? { mood, label, detail: shown } : { mood, label };
}

/** The activity of an agent running tool `name` with `args` (possibly partial, while generated). */
export function toolActivity(name: string, args: unknown): StudioActivity {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const path = str(a.path) ?? str(a.file_path) ?? str(a.notebook_path) ?? str(a.filePath);
	if (isSubagentTool(name) || name === "wait_agent") {
		return withDetail("delegating", "派小帮手干活", str(a.description) ?? str(a.name) ?? str(a.subagent_type));
	}
	switch (name.toLowerCase()) {
		case "bash":
		case "powershell":
		case "shell":
		case "exec_command":
		case "local_shell":
		case "bashoutput":
			return withDetail("command", "运行命令", str(a.command) ?? str(a.cmd));
		case "read":
		case "ls":
		case "view":
		case "notebookread":
		case "read_file":
		case "list_dir":
			return withDetail("reading", "翻阅文件", path ? baseName(path) : undefined);
		case "grep":
		case "find":
		case "glob":
		case "search":
		case "codebase_search":
		case "file_search":
			return withDetail("searching", "四处搜寻", str(a.pattern) ?? str(a.query) ?? str(a.glob));
		case "edit":
		case "write":
		case "multiedit":
		case "apply_patch":
		case "notebookedit":
		case "str_replace":
		case "create_file":
			return withDetail(
				"editing",
				name.toLowerCase() === "write" ? "写新文件" : "改代码",
				path ? baseName(path) : undefined,
			);
		case "webfetch":
		case "web_fetch":
		case "fetch":
			return withDetail("browsing", "上网查资料", str(a.url));
		case "websearch":
		case "web_search":
		case "web_search_preview":
			return withDetail("browsing", "上网搜索", str(a.query));
		case "todowrite":
		case "update_plan":
		case "todo":
			return { mood: "thinking", label: "列计划" };
		default: {
			if (/^(browser|playwright|puppeteer|chrome)/i.test(name)) return withDetail("browsing", "操作浏览器", str(a.url));
			return withDetail("tool", `使用 ${clip(name, 24)}`, summarizeToolCall(name, args));
		}
	}
}

function requestActivity(request: UiRequest): StudioActivity {
	if (request.approval) {
		return withDetail("waiting", "等你批准", request.approval.summary || request.approval.toolName);
	}
	return withDetail("waiting", "等你回答", request.title);
}

/**
 * What the agent of `session` is doing, from its live chat when that is loaded (else the host's
 * session list, which only tells whether it runs).
 */
export function studioActivity(chat: ChatState | undefined, session: SessionSummary): StudioActivity {
	const live = chat?.loaded ? chat : undefined;
	const runState = live ? live.runState : session.state;
	const request = live?.pendingUi[0];
	if (request) return requestActivity(request);
	if (!live && (session.pendingUi ?? 0) > 0) return { mood: "waiting", label: "等你处理" };
	if (runState === "compacting") return { mood: "compacting", label: "整理记忆" };
	if (runState === "retrying") {
		return live?.retry?.attempt
			? { mood: "retrying", label: `第 ${live.retry.attempt} 次重试` }
			: { mood: "retrying", label: "再试一次" };
	}
	if (!isRunning(runState)) {
		return live?.errorMessage
			? withDetail("error", "遇到问题了", live.errorMessage)
			: { mood: "resting", label: "休息中" };
	}
	if (!live) return { mood: "working", label: "工作中" };

	// The newest tool that runs now.
	const running = Object.values(live.tools).filter((tool) => tool.status === "running");
	const tool = running.at(-1);
	const helpers = Object.values(live.subagents).filter((s) => s.status === "running").length;
	if (tool) {
		const activity = toolActivity(tool.toolName, tool.args);
		if (activity.mood === "delegating" && helpers > 1) return { ...activity, label: `派 ${helpers} 个小帮手干活` };
		return activity;
	}

	const part = live.streaming?.content.at(-1);
	if (part?.type === "toolCall") return toolActivity(part.name, part.arguments);
	if (part?.type === "thinking" && part.completed !== true) return { mood: "thinking", label: "思考中" };
	if (part?.type === "text" && part.completed !== true && part.text.trim()) return { mood: "writing", label: "写回复" };

	// A call the model finished that has not started yet (or waits for its result).
	const last = live.messages.at(-1);
	if (!live.streaming && last?.role === "assistant") {
		for (const call of (last as AssistantMessage).content ?? []) {
			if (call?.type !== "toolCall") continue;
			const execution = live.tools[call.id];
			if (!execution || execution.status === "running") return toolActivity(call.name, call.arguments);
		}
	}
	if (helpers > 0) return { mood: "delegating", label: helpers > 1 ? `等 ${helpers} 个小帮手` : "等小帮手" };
	return { mood: "thinking", label: "思考中" };
}

/** Accessories a studio cat may wear, one per session. */
export const CAT_ACCESSORIES = ["sprout", "bow", "headphones", "glasses", "flower", "cap", "none"] as const;
export type CatAccessory = (typeof CAT_ACCESSORIES)[number];

/**
 * Coat patterns: one colour, tabby stripes, a patch over one eye, a white blaze and paws, or dark
 * points (ears, mask, paws and tail tip).
 */
export const CAT_COATS = ["plain", "tabby", "patch", "tuxedo", "points"] as const;
export type CatCoat = (typeof CAT_COATS)[number];

/** Eye colours. */
export const CAT_EYES = ["amber", "emerald", "sky", "violet", "rose", "honey"] as const;
export type CatEyes = (typeof CAT_EYES)[number];

/** Shades of the agent's fur colour, so a team of one agent is not all one colour. */
export const CAT_TINTS = ["base", "milk", "dusk"] as const;
export type CatTint = (typeof CAT_TINTS)[number];

/** What stands on the cat's desk besides its laptop. */
export const DESK_ITEMS = ["mug", "plant", "duck", "none"] as const;
export type DeskItem = (typeof DESK_ITEMS)[number];

/** What hangs on the wall behind the desk. */
export const ROOM_DECORS = ["window", "shelf", "clock", "poster"] as const;
export type RoomDecor = (typeof ROOM_DECORS)[number];

/** The sky in the studio's windows, by the local hour. */
export type SkyPhase = "dawn" | "day" | "dusk" | "night";

export function skyPhase(hour: number): SkyPhase {
	if (hour >= 5 && hour < 8) return "dawn";
	if (hour >= 8 && hour < 17) return "day";
	if (hour >= 17 && hour < 20) return "dusk";
	return "night";
}

const CAT_NAMES = [
	"团子",
	"布丁",
	"麻薯",
	"糯米",
	"可可",
	"奶糖",
	"豆包",
	"年糕",
	"芝麻",
	"汤圆",
	"饭团",
	"果冻",
	"栗子",
	"椰椰",
	"米粒",
	"咕噜",
	"奶茶",
	"雪球",
	"橘子",
	"棉花",
	"布朗",
	"小满",
	"毛豆",
	"樱桃",
];

export interface CatLook {
	name: string;
	accessory: CatAccessory;
	coat: CatCoat;
	eyes: CatEyes;
	tint: CatTint;
	deskItem: DeskItem;
	decor: RoomDecor;
	/** Seconds to offset its idle animations by, so the cats do not blink and sway in step. */
	phase: number;
}

/**
 * A small, stable hash of a session id: FNV-1a, then MurmurHash3's finalizer, so ids that differ
 * only in their last characters (as sequential ones do) still differ in every bit.
 */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/** The look of a session's cat: the same session always gets the same name, coat, eyes and room. */
export function catLook(sessionId: string): CatLook {
	// Each trait takes its own digits of the hash, so the traits vary independently.
	let rest = hash(sessionId);
	const pick = <T>(list: readonly T[], fallback: T): T => {
		const item = list[rest % list.length] ?? fallback;
		rest = Math.floor(rest / list.length);
		return item;
	};
	return {
		name: pick(CAT_NAMES, "团子"),
		accessory: pick(CAT_ACCESSORIES, "none"),
		coat: pick(CAT_COATS, "plain"),
		eyes: pick(CAT_EYES, "amber"),
		tint: pick(CAT_TINTS, "base"),
		deskItem: pick(DESK_ITEMS, "none"),
		decor: pick(ROOM_DECORS, "window"),
		phase: (rest % 40) / 10,
	};
}
