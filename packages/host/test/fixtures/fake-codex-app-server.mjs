// A small stand-in for `codex app-server` (newline-delimited JSON-RPC over stdio) used by the
// Codex runtime tests. State lives in memory; rollout files are created in FAKE_CODEX_DIR.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_CODEX_DIR ?? process.cwd();
const threads = new Map();
const pendingServer = new Map();
let nextServerId = 1;
let seq = 0;
let experimentalApi = false;
const id = (prefix) => `${prefix}-${++seq}`;
const now = () => Math.floor(Date.now() / 1000);

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
const notify = (method, params) => send({ method, params });
function ask(method, params) {
	const requestId = nextServerId++;
	send({ id: requestId, method, params });
	return new Promise((resolve) => pendingServer.set(requestId, resolve));
}

function threadView(thread, withTurns = false) {
	const { turns, archived, ...rest } = thread;
	return { ...rest, turns: withTurns ? turns : [] };
}

function newThread(cwd, extra = {}) {
	const threadId = id("thread");
	const path = join(dir, `rollout-${threadId}.jsonl`);
	writeFileSync(path, "");
	const thread = {
		id: threadId,
		sessionId: threadId,
		forkedFromId: null,
		preview: "",
		ephemeral: false,
		modelProvider: "openai",
		model: "gpt-test",
		reasoningEffort: null,
		serviceTier: null,
		createdAt: now(),
		updatedAt: now(),
		status: { type: "idle" },
		path,
		cwd,
		name: null,
		turns: [],
		archived: false,
		...extra,
	};
	threads.set(threadId, thread);
	return thread;
}

const MODELS = [
	{
		id: "gpt-test",
		model: "gpt-test",
		displayName: "GPT Test",
		hidden: false,
		supportedReasoningEfforts: [
			{ reasoningEffort: "low" },
			{ reasoningEffort: "medium" },
			{ reasoningEffort: "high" },
			{ reasoningEffort: "max" },
			{ reasoningEffort: "ultra" },
		],
		defaultReasoningEffort: "medium",
		inputModalities: ["text", "image"],
		isDefault: true,
	},
	{
		id: "gpt-mini",
		model: "gpt-mini",
		displayName: "GPT Mini",
		hidden: false,
		supportedReasoningEfforts: [{ reasoningEffort: "low" }],
		defaultReasoningEffort: "low",
		inputModalities: ["text"],
		isDefault: false,
	},
];

const active = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a sub-agent's turn: one command, then its report. `mode` "wait" runs until interrupted;
 * `pause` milliseconds pass between steps.
 */
async function runChild(child, rootTurnId, mode, pause = 0) {
	const threadId = child.id;
	const turn = { id: id("turn"), rootTurnId, items: [], status: "inProgress", error: null, startedAt: now() };
	child.turns.push(turn);
	active.set(threadId, { turnId: turn.id, steered: [] });
	const turnId = turn.id;
	const complete = (item) => {
		turn.items.push(item);
		notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
	};
	notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
	notify("turn/started", { threadId, turn: { ...turn, items: [] } });
	const command = {
		type: "commandExecution",
		id: id("cmd"),
		command: "cat a.txt",
		cwd: child.cwd,
		status: "inProgress",
		commandActions: [],
		aggregatedOutput: null,
		exitCode: null,
		durationMs: null,
	};
	await sleep(pause);
	notify("item/started", { threadId, turnId, item: command, startedAtMs: Date.now() });
	await sleep(pause);
	if (mode === "approve") {
		const answer = await ask("item/commandExecution/requestApproval", {
			threadId,
			turnId,
			itemId: command.id,
			command: command.command,
			cwd: child.cwd,
			reason: "needs approval",
		});
		child.approval = answer?.decision ?? null;
	}
	complete({ ...command, status: "completed", exitCode: 0, aggregatedOutput: "hello\n" });
	for (let step = 0; pause && step < 3; step++) {
		await sleep(pause);
		const extra = { ...command, id: id("cmd"), command: `grep -n step${step} *.txt` };
		notify("item/started", { threadId, turnId, item: extra, startedAtMs: Date.now() });
		await sleep(pause);
		complete({ ...extra, status: "completed", exitCode: 0, aggregatedOutput: `step${step}\n` });
	}
	if (mode === "wait") {
		await new Promise((resolve) => {
			const timer = setInterval(() => {
				if (active.get(threadId)?.interrupted) {
					clearInterval(timer);
					resolve();
				}
			}, 10);
		});
	}
	if (active.get(threadId)?.interrupted) {
		turn.status = "interrupted";
	} else {
		await sleep(pause);
		complete({ type: "agentMessage", id: id("msg"), text: "a.txt says hello", phase: "final_answer" });
		notify("thread/tokenUsage/updated", {
			threadId,
			turnId,
			tokenUsage: { total: { totalTokens: 42 }, last: { totalTokens: 42 } },
		});
		turn.status = "completed";
	}
	active.delete(threadId);
	notify("thread/status/changed", { threadId, status: { type: "idle" } });
	notify("turn/completed", { threadId, turn });
	return turn.status;
}

/**
 * The parent's side of sub-agents (prompts with "delegate"): `spawn_agent`, then `wait` until
 * the children end. "delegate-hold" keeps them running until interrupted, "delegate-approve"
 * makes them ask for approval, "team" spawns two and "slow" paces their steps (for UI work).
 */
async function spawnChild(thread, turn, text, complete) {
	const count = text.includes("team") ? 2 : 1;
	const pause = text.includes("slow") ? 1500 : 0;
	const children = [];
	for (let i = 0; i < count; i++) children.push(spawnOne(thread, turn, text, complete, i, pause));
	const wait = {
		type: "collabAgentToolCall",
		id: id("call"),
		tool: "wait",
		status: "inProgress",
		senderThreadId: thread.id,
		receiverThreadIds: [],
		prompt: null,
		model: null,
		reasoningEffort: null,
		agentsStates: {},
	};
	notify("item/started", { threadId: thread.id, turnId: turn.id, item: wait, startedAtMs: Date.now() });
	await Promise.all(children.map((start) => start()));
	complete({ ...wait, status: "completed" });
}

/** Spawn one sub-agent; returns a function that runs it and reports its end to the parent. */
function spawnOne(thread, turn, text, complete, index, pause) {
	const threadId = thread.id;
	const turnId = turn.id;
	const path = index ? `/root/reviewer_${index}` : "/root/reader";
	const child = newThread(thread.cwd, {
		forkedFromId: thread.id,
		parentThreadId: thread.id,
		agentNickname: index ? "Noether" : "Volta",
		agentRole: null,
		source: { subAgent: { thread_spawn: { parent_thread_id: thread.id, depth: 1, agent_path: path } } },
	});
	const spawn = {
		type: "subAgentActivity",
		model: "gpt-test",
		reasoningEffort: "low",
		id: id("call"),
		kind: "started",
		agentThreadId: child.id,
		agentPath: path,
	};
	notify("item/started", { threadId, turnId, item: spawn, startedAtMs: Date.now() });
	complete(spawn);
	const mode = text.includes("delegate-hold") ? "wait" : text.includes("delegate-approve") ? "approve" : "run";
	return async () => {
		const status = await runChild(child, turnId, mode, pause * (index + 1));
		complete({
			type: "subAgentActivity",
			model: null,
			reasoningEffort: null,
			id: `subagent-${status}-${child.id}`,
			kind: status === "completed" ? "completed" : "interrupted",
			agentThreadId: child.id,
			agentPath: path,
		});
	};
}

async function runTurn(thread, turn, text) {
	const threadId = thread.id;
	const turnId = turn.id;
	const cancelled = () => active.get(threadId)?.interrupted === true;
	const complete = (item) => {
		turn.items.push(item);
		notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
	};
	notify("turn/started", { threadId, turn: { ...turn, items: [] } });
	if (text.includes("delegate")) await spawnChild(thread, turn, text, complete);
	if (text.includes("run")) {
		const item = {
			type: "commandExecution",
			id: id("cmd"),
			command: "npm install",
			cwd: thread.cwd,
			status: "inProgress",
			commandActions: [],
			aggregatedOutput: null,
			exitCode: null,
			durationMs: null,
		};
		notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
		const answer = await ask("item/commandExecution/requestApproval", {
			threadId,
			turnId,
			itemId: item.id,
			command: item.command,
			cwd: thread.cwd,
			reason: "needs network",
		});
		if (answer?.decision === "accept" || answer?.decision === "acceptForSession") {
			notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: item.id, delta: "hi\n" });
			complete({ ...item, status: "completed", exitCode: 0, aggregatedOutput: "hi\n" });
		} else {
			complete({ ...item, status: "declined" });
		}
	}
	if (text.includes("progress")) {
		const item = { type: "agentMessage", id: id("msg"), text: "", phase: "commentary" };
		notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
		notify("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: "Progress reported." });
		complete({ ...item, text: "Progress reported." });
	}
	if (text.includes("wait")) {
		await new Promise((resolve) => {
			const timer = setInterval(() => {
				if (cancelled() || active.get(threadId)?.release) {
					clearInterval(timer);
					resolve();
				}
			}, 10);
		});
	}
	if (cancelled()) {
		turn.status = "interrupted";
	} else {
		const steered = active.get(threadId)?.steered ?? [];
		for (const message of steered) {
			const userItem = { type: "userMessage", id: id("user"), clientId: message.clientId, content: message.input };
			notify("item/started", { threadId, turnId, item: userItem, startedAtMs: Date.now() });
			complete(userItem);
		}
		const reasoning = { type: "reasoning", id: id("rs"), summary: [], content: [] };
		notify("item/started", { threadId, turnId, item: reasoning, startedAtMs: Date.now() });
		notify("item/reasoning/summaryTextDelta", {
			threadId,
			turnId,
			itemId: reasoning.id,
			delta: "Thinking",
			summaryIndex: 0,
		});
		complete({ ...reasoning, summary: ["Thinking"] });
		const message = { type: "agentMessage", id: id("msg"), text: "", phase: null };
		notify("item/started", { threadId, turnId, item: message, startedAtMs: Date.now() });
		const reply = `Reply to ${text}${steered.length ? ` + ${steered.length} steer` : ""}`;
		for (const chunk of reply.match(/.{1,5}/g) ?? []) {
			notify("item/agentMessage/delta", { threadId, turnId, itemId: message.id, delta: chunk });
		}
		complete({ ...message, text: reply });
		notify("thread/tokenUsage/updated", {
			threadId,
			turnId,
			tokenUsage: {
				total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 },
				last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 },
				modelContextWindow: 100000,
			},
		});
		turn.status = "completed";
	}
	active.delete(threadId);
	thread.updatedAt = now();
	notify("turn/completed", { threadId, turn });
}

const handlers = {
	initialize: (params) => {
		experimentalApi = params.capabilities?.experimentalApi === true;
		return { userAgent: "fake", codexHome: dir, platformFamily: "unix", platformOs: "linux" };
	},
	"model/list": () => ({ data: MODELS, nextCursor: null }),
	"thread/start": (params) => {
		const thread = newThread(params.cwd);
		notify("thread/started", { thread: threadView(thread) });
		return {
			thread: threadView(thread),
			model: "gpt-test",
			modelProvider: "openai",
			reasoningEffort: null,
			serviceTier: thread.serviceTier,
		};
	},
	"thread/list": (params) => ({
		data: [...threads.values()]
			.filter((t) => !t.archived && !t.parentThreadId && t.cwd === params.cwd && t.turns.length > 0)
			.map((t) => threadView(t)),
		nextCursor: null,
	}),
	"thread/resume": (params) => {
		const thread = threads.get(params.threadId);
		if (!thread) throw new Error("no such thread");
		return {
			thread: threadView(thread),
			model: thread.model,
			reasoningEffort: thread.reasoningEffort,
			serviceTier: thread.serviceTier,
		};
	},
	"thread/turns/list": (params) => ({ data: threads.get(params.threadId)?.turns ?? [], nextCursor: null }),
	"thread/read": (params) => {
		const thread = threads.get(params.threadId);
		if (!thread) throw new Error("no such thread");
		return { thread: { ...threadView(thread), status: { type: active.has(thread.id) ? "active" : "idle" } } };
	},
	"thread/fork": (params) => {
		const source = threads.get(params.threadId);
		const end = source.turns.findIndex((t) => t.id === params.lastTurnId);
		const thread = newThread(source.cwd, {
			forkedFromId: source.id,
			preview: source.preview,
			serviceTier: source.serviceTier,
			turns: structuredClone(source.turns.slice(0, end + 1)),
		});
		return { thread: threadView(thread), model: thread.model, reasoningEffort: null, serviceTier: thread.serviceTier };
	},
	"thread/settings/update": (params) => {
		if (!experimentalApi) throw new Error("thread/settings/update requires experimentalApi capability");
		const thread = threads.get(params.threadId);
		if (thread.rejectSettings) {
			thread.rejectSettings = false;
			throw new Error("Fast mode unavailable");
		}
		thread.serviceTier = params.serviceTier ?? "default";
		notify("thread/settings/updated", { threadId: thread.id, threadSettings: { serviceTier: thread.serviceTier } });
		return {};
	},
	"thread/name/set": (params) => {
		const thread = threads.get(params.threadId);
		thread.name = params.name;
		notify("thread/name/updated", { threadId: thread.id, threadName: params.name });
		return {};
	},
	"thread/archive": (params) => {
		threads.get(params.threadId).archived = true;
		return {};
	},
	"thread/unsubscribe": () => ({}),
	"thread/compact/start": (params) => {
		setTimeout(() => notify("thread/compacted", { threadId: params.threadId, turnId: "compact" }), 10);
		return {};
	},
	"turn/start": (params) => {
		const thread = threads.get(params.threadId);
		const text = params.input.find((i) => i.type === "text")?.text ?? "";
		if (!thread.preview) thread.preview = text;
		const userItem = {
			type: "userMessage",
			id: id("user"),
			clientId: params.clientUserMessageId,
			content: params.input,
		};
		const turn = { id: id("turn"), items: [userItem], status: "inProgress", error: null, startedAt: now() };
		thread.turns.push(turn);
		thread.lastTurnParams = params;
		if (params.serviceTier !== undefined) thread.serviceTier = params.serviceTier ?? "default";
		active.set(thread.id, { turnId: turn.id, steered: [] });
		setTimeout(() => {
			notify("item/started", { threadId: thread.id, turnId: turn.id, item: userItem, startedAtMs: Date.now() });
			void runTurn(thread, turn, text);
		}, 5);
		return { turn: { ...turn, items: [] } };
	},
	"turn/steer": (params) => {
		const run = active.get(params.threadId);
		if (!run || run.turnId !== params.expectedTurnId) throw new Error("no active turn");
		run.steered.push({ clientId: params.clientUserMessageId, input: params.input });
		run.release = true;
		return { turnId: run.turnId };
	},
	"turn/interrupt": (params) => {
		const run = active.get(params.threadId);
		if (run) run.interrupted = true;
		return {};
	},
	// Test helper: the approval decision a sub-agent got.
	"fake/childApproval": () => [...threads.values()].find((t) => t.approval !== undefined)?.approval ?? null,
	// Test helper: what the last turn/start asked for.
	"fake/lastTurn": (params) => threads.get(params.threadId)?.lastTurnParams ?? null,
	"fake/rejectSettings": (params) => {
		threads.get(params.threadId).rejectSettings = true;
		return {};
	},
};

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.method && message.id !== undefined) {
		const handler = handlers[message.method];
		try {
			if (!handler) throw new Error(`unknown method ${message.method}`);
			send({ id: message.id, result: await handler(message.params ?? {}) });
		} catch (error) {
			send({ id: message.id, error: { code: -32000, message: error.message } });
		}
	} else if (message.id !== undefined) {
		pendingServer.get(message.id)?.(message.result);
		pendingServer.delete(message.id);
	}
});
