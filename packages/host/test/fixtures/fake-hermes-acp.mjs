// A small stand-in for `hermes` used by the Hermes runtime tests: `acp` serves the Agent Client
// Protocol (newline-delimited JSON-RPC over stdio) like Hermes Agent's gateway-backed ACP server,
// `sessions delete <id> --yes` deletes a stored session. Sessions are kept in FAKE_HERMES_DIR, so
// they outlive a restarted ACP server; every request is appended to `requests.jsonl` there.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_HERMES_DIR ?? process.cwd();
mkdirSync(dir, { recursive: true });
const storeFile = join(dir, "sessions.json");
const load = () => (existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, "utf8")) : {});
const save = (sessions) => writeFileSync(storeFile, JSON.stringify(sessions, null, 2));

const [command, ...rest] = process.argv.slice(2);
if (command === "sessions" && rest[0] === "delete") {
	const sessions = load();
	if (!sessions[rest[1]]) {
		console.log(`Session '${rest[1]}' not found.`);
		process.exit(1);
	}
	delete sessions[rest[1]];
	save(sessions);
	console.log(`Deleted session '${rest[1]}'.`);
	process.exit(0);
}
if (command === "acp" && rest[0] === "--version") {
	console.log("0.0.0-fake");
	process.exit(0);
}
if (command !== "acp") {
	console.error(`fake hermes: unknown command ${command}`);
	process.exit(2);
}

const MODELS = [
	{ value: "deepseek:deepseek-chat", name: "DeepSeek · deepseek-chat", description: "Provider: DeepSeek" },
	{ value: "deepseek:deepseek-reasoner", name: "DeepSeek · deepseek-reasoner", description: "Provider: DeepSeek" },
	{ value: "custom:proxy:gpt-x", name: "gpt-x", description: "Provider: My Proxy" },
];
const EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** Sessions of this process: the stored ones it attached to and the new ones. */
const live = new Map();
const pendingAgent = new Map();
let nextAgentId = 1;
let nextSession = Object.keys(load()).length + 1;
let seq = 0;

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
function ask(method, params) {
	const id = nextAgentId++;
	send({ id, method, params });
	return new Promise((resolve, reject) => pendingAgent.set(id, { resolve, reject }));
}
function record(entry) {
	appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify(entry)}\n`);
}

function configOptions(session) {
	return [
		{
			id: "edit_approval_policy",
			name: "Edits",
			category: "mode",
			type: "select",
			currentValue: "ask",
			options: [{ value: "ask", name: "Default" }],
		},
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: session.model,
			options: MODELS.map((m) => ({
				...m,
				description: m.value === session.model ? `${m.description} • current` : m.description,
			})),
		},
		{
			id: "reasoning_effort",
			name: "Reasoning effort",
			category: "thought_level",
			type: "select",
			currentValue: session.effort,
			options: EFFORTS.map((value) => ({ value, name: value })),
		},
	];
}
function sessionFields(session) {
	return {
		models: {
			currentModelId: session.model,
			availableModels: MODELS.map((m) => ({ modelId: m.value, name: m.name, description: m.description })),
		},
		configOptions: configOptions(session),
	};
}
function persist(session) {
	const sessions = load();
	sessions[session.id] = {
		id: session.id,
		cwd: session.cwd,
		title: session.title,
		model: session.model,
		effort: session.effort,
		history: session.history,
		usage: session.usage,
		updatedAt: new Date().toISOString(),
	};
	save(sessions);
}
/** Updates to send right after the response to the current request. */
let afterResponse = [];

/** Like Hermes, the commands and context usage follow the response to `session/new`, `load`, `resume`. */
function afterAttach(session) {
	afterResponse.push(() => {
		update(session.id, {
			sessionUpdate: "available_commands_update",
			availableCommands: [
				{ name: "compress", description: "Compress conversation context" },
				{ name: "title", description: "Show or set the session title", input: { hint: "new title" } },
			],
		});
		update(session.id, { sessionUpdate: "usage_update", size: 128000, used: session.used ?? 0 });
	});
}

function replay(session) {
	for (const entry of session.history) {
		if (entry.role === "user")
			update(session.id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.text } });
		else if (entry.role === "assistant") {
			if (entry.thought)
				update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: entry.thought } });
			update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.text } });
		} else if (entry.role === "tool") {
			update(session.id, {
				sessionUpdate: "tool_call",
				toolCallId: entry.id,
				title: entry.title,
				kind: "execute",
				status: "pending",
				content: [{ type: "content", content: { type: "text", text: `$ ${entry.command}` } }],
			});
			update(session.id, {
				sessionUpdate: "tool_call_update",
				toolCallId: entry.id,
				status: entry.failed ? "failed" : "completed",
				content: [{ type: "content", content: { type: "text", text: entry.output } }],
			});
		}
	}
}

function attach(params) {
	const stored = load()[params.sessionId];
	if (!stored) throw Object.assign(new Error("not_found"), { code: -32603 });
	const session = live.get(params.sessionId) ?? { ...stored, used: 2048 };
	live.set(session.id, session);
	session.resumes = (session.resumes ?? 0) + 1;
	replay(session);
	afterAttach(session);
	return sessionFields(session);
}

const chunk = (session, kind, text, messageId) =>
	update(session.id, { sessionUpdate: kind, content: { type: "text", text }, ...(messageId ? { messageId } : {}) });

async function prompt(params) {
	const session = live.get(params.sessionId);
	if (!session) throw new Error("not_found");
	const text = params.prompt
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const images = params.prompt.filter((b) => b.type === "image").length;
	session.prompts = [...(session.prompts ?? []), { text, images }];
	const cancelled = new Promise((resolve) => {
		session.cancel = resolve;
	});
	const title = /^\/title (.+)$/.exec(text);
	if (title) {
		session.title = title[1];
		persist(session);
		update(session.id, { sessionUpdate: "session_info_update", title: session.title });
		chunk(session, "agent_message_chunk", `Session title set: ${session.title}\n`);
		return { stopReason: "end_turn" };
	}
	session.history.push({ role: "user", text });
	const id = `m${++seq}`;
	const finish = (reply, extra = {}) => {
		session.history.push({ role: "assistant", text: reply, ...extra });
		// Like Hermes' gateway: session counters, input without the cached prompt tokens.
		session.usage = {
			inputTokens: session.usage.inputTokens + 60,
			outputTokens: session.usage.outputTokens + 20,
			totalTokens: session.usage.totalTokens + 80,
			cachedReadTokens: session.usage.cachedReadTokens + 40,
		};
		session.used = (session.used ?? 0) + 1000;
		persist(session);
		update(session.id, { sessionUpdate: "usage_update", size: 128000, used: session.used });
		if (!session.title) {
			session.title = `Title of ${text.slice(0, 20)}`;
			persist(session);
			update(session.id, { sessionUpdate: "session_info_update", title: session.title });
		}
		return { stopReason: "end_turn", usage: session.usage };
	};
	if (text.includes("approve")) {
		chunk(session, "agent_message_chunk", "I will clean up.", id);
		const callId = `tc-${++seq}`;
		update(session.id, {
			sessionUpdate: "tool_call",
			toolCallId: callId,
			title: "terminal: rm -rf build",
			kind: "execute",
			status: "pending",
			content: [{ type: "content", content: { type: "text", text: "$ rm -rf build" } }],
			locations: [],
		});
		const answer = await ask("session/request_permission", {
			sessionId: session.id,
			toolCall: {
				toolCallId: "perm-check-1",
				title: "recursive delete: rm -rf build",
				kind: "execute",
				status: "pending",
				rawInput: { command: "rm -rf build", description: "recursive delete" },
			},
			options: [
				{ optionId: "allow_once", kind: "allow_once", name: "Allow once" },
				{ optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
				{ optionId: "deny", kind: "reject_once", name: "Deny" },
			],
		});
		session.answers = [...(session.answers ?? []), answer.outcome];
		update(session.id, { sessionUpdate: "tool_call_update", toolCallId: "perm-check-1", status: "completed" });
		const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId.startsWith("allow");
		const output = allowed ? "removed build" : "BLOCKED: denied by the user";
		update(session.id, {
			sessionUpdate: "tool_call_update",
			toolCallId: callId,
			status: allowed ? "completed" : "failed",
			content: [{ type: "content", content: { type: "text", text: output } }],
		});
		session.history.push({
			role: "tool",
			id: callId,
			title: "terminal: rm -rf build",
			command: "rm -rf build",
			output,
			failed: !allowed,
		});
		chunk(session, "agent_message_chunk", allowed ? "Removed." : "Not removed.", `m${++seq}`);
		return finish(allowed ? "Removed." : "Not removed.");
	}
	if (text.includes("edit")) {
		const callId = `tc-${++seq}`;
		update(session.id, {
			sessionUpdate: "tool_call",
			toolCallId: callId,
			title: "patch: notes.txt",
			kind: "edit",
			status: "pending",
			content: [{ type: "content", content: { type: "text", text: "Preparing replace edit for notes.txt." } }],
			locations: [{ path: "notes.txt" }],
		});
		const answer = await ask("session/request_permission", {
			sessionId: session.id,
			toolCall: {
				toolCallId: "edit-approval-1",
				title: "Approve edit: notes.txt",
				kind: "edit",
				status: "pending",
				content: [{ type: "diff", path: "notes.txt", oldText: "one\ntwo\nthree\n", newText: "one\nTWO\nthree\n" }],
				rawInput: { tool: "patch", arguments: { path: "notes.txt", old_string: "two", new_string: "TWO" } },
			},
			options: [
				{ optionId: "allow_once", kind: "allow_once", name: "Allow edit" },
				{ optionId: "deny", kind: "reject_once", name: "Deny" },
			],
		});
		session.answers = [...(session.answers ?? []), answer.outcome];
		update(session.id, {
			sessionUpdate: "tool_call_update",
			toolCallId: callId,
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "✅ patch completed for `notes.txt`" } }],
		});
		return finish("Edited.");
	}
	if (text.includes("question")) {
		const answer = await ask("elicitation/create", {
			sessionId: session.id,
			mode: "form",
			message: "Which color?",
			requestedSchema: {
				type: "object",
				properties: { answer: { type: "string", enum: ["red", "blue"] } },
				required: ["answer"],
			},
		});
		const reply = answer.action === "accept" ? `You chose ${answer.content.answer}.` : "Skipped.";
		chunk(session, "agent_message_chunk", reply, id);
		return finish(reply);
	}
	if (text.includes("hold")) {
		chunk(session, "agent_message_chunk", "Working", id);
		await cancelled;
		return { stopReason: "cancelled" };
	}
	chunk(session, "agent_thought_chunk", "Let me think.", id);
	chunk(session, "agent_message_chunk", "Hello ", id);
	chunk(session, "agent_message_chunk", `from ${session.model}.`, id);
	return finish(`Hello from ${session.model}.`, { thought: "Let me think." });
}

const handlers = {
	initialize() {
		return {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true },
				sessionCapabilities: { fork: {}, list: {}, resume: {} },
			},
			authMethods: [],
			agentInfo: { name: "hermes-agent", version: "0.0.0-fake" },
		};
	},
	"session/new"(params) {
		const session = {
			id: `fake_${process.pid}_${nextSession++}`,
			cwd: params.cwd,
			model: "deepseek:deepseek-chat",
			effort: "default",
			history: [],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0 },
		};
		live.set(session.id, session);
		afterAttach(session);
		return { sessionId: session.id, ...sessionFields(session) };
	},
	"session/list"(params) {
		const sessions = Object.values(load())
			.filter((s) => s.history.length && (!params.cwd || s.cwd === params.cwd))
			.map((s) => ({ sessionId: s.id, cwd: s.cwd, title: s.title ?? null, updatedAt: s.updatedAt }));
		return { sessions };
	},
	"session/load": attach,
	"session/resume": attach,
	"session/prompt": prompt,
	"session/set_config_option"(params) {
		const session = live.get(params.sessionId);
		if (!session) throw new Error("not_found");
		if (params.configId === "model") {
			if (!MODELS.some((m) => m.value === params.value)) throw new Error("model_switch_refused");
			session.model = params.value;
		} else if (params.configId === "reasoning_effort") session.effort = params.value;
		persist(session);
		return { configOptions: configOptions(session) };
	},
	"session/cancel"(params) {
		live.get(params.sessionId)?.cancel?.();
	},
};

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.method === undefined) {
		const pending = pendingAgent.get(message.id);
		pendingAgent.delete(message.id);
		if (message.error) pending?.reject(new Error(message.error.message));
		else pending?.resolve(message.result);
		return;
	}
	record({ method: message.method, params: message.params });
	const handler = handlers[message.method];
	if (message.id === undefined) {
		handler?.(message.params);
		return;
	}
	try {
		if (!handler) throw Object.assign(new Error("Method not found"), { code: -32601 });
		const result = await handler(message.params ?? {});
		send({ id: message.id, result: result ?? null });
		const after = afterResponse;
		afterResponse = [];
		for (const run of after) run();
	} catch (error) {
		send({
			id: message.id,
			error: { code: error.code ?? -32603, message: "Internal error", data: { details: error.message } },
		});
	}
});
