import type { AgentRuntimeInfo, ModelInfo, WorkspaceInfo } from "@pier/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelMatches, NewChatModelPicker, providerLabel } from "../src/components/ModelPicker.tsx";
import type { AppState } from "../src/lib/store.tsx";

const { state, store } = vi.hoisted(() => ({
	state: {
		workspaceNodes: { workspace: "peer" },
		nodes: { peer: { connection: "open" } },
		newChatRuntime: { local: "pi", peer: "codex" },
		newChatModel: { peer: { fastMode: false } as { fastMode: boolean; model?: ModelInfo } },
	},
	store: { listModels: vi.fn(), setNewChatModel: vi.fn() },
}));

vi.mock("../src/lib/store.tsx", () => ({
	LOCAL_NODE: "local",
	useStore: () => store,
	useAppState: (selector: (value: AppState) => unknown) => selector(state as unknown as AppState),
}));

const workspace: WorkspaceInfo = { id: "workspace", name: "Workspace", path: "/workspace", policy: "ask" };
const codex: AgentRuntimeInfo = {
	id: "codex",
	name: "Codex",
	available: true,
	capabilities: {
		steer: true,
		followUp: true,
		compact: true,
		fork: true,
		rename: true,
		setModel: true,
		thinking: true,
		fastMode: true,
		reload: false,
		images: true,
		piExtensions: false,
	},
};
const render = (runtimes: AgentRuntimeInfo[]) =>
	renderToStaticMarkup(createElement(NewChatModelPicker, { workspace, runtimes }));

beforeEach(() => {
	state.newChatRuntime.peer = "codex";
	state.newChatModel.peer.fastMode = false;
	delete state.newChatModel.peer.model;
});

const claudeDefault: ModelInfo = {
	provider: "claude-code",
	id: "default",
	name: "Default (recommended)",
	description: "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
	reasoning: true,
	input: ["text", "image"],
};

describe("new-chat model picker", () => {
	it("exposes Fast controls before a session exists when the workspace's computer supports them", () => {
		expect(render([codex])).toContain('title="切换模型、思考程度与 Fast 模式"');
		expect(render([codex])).not.toContain('title="Fast 模式已开启"');
		state.newChatModel.peer.fastMode = true;
		expect(render([codex])).toContain('title="Fast 模式已开启"');
	});

	it("hides Fast while capabilities are unknown, unavailable or unsupported", () => {
		state.newChatModel.peer.fastMode = true;
		for (const runtimes of [
			[],
			[{ ...codex, available: false }],
			[{ ...codex, capabilities: { ...codex.capabilities, fastMode: undefined } }],
			[{ ...codex, capabilities: { ...codex.capabilities, fastMode: false } }],
		]) {
			expect(render(runtimes)).not.toContain("Fast");
		}
	});

	it("names the model the chip stands for in its tooltip, with its description", () => {
		state.newChatRuntime.peer = "claude-code";
		state.newChatModel.peer.model = claudeDefault;
		const html = render([codex]);
		// The chip says only "Default"; the tooltip says it runs Opus 5.5.
		expect(html).toContain(">Default</span>");
		expect(html).toContain(
			'title="Default (recommended)：Use the default model (currently Opus 5.5) · $4/$20 per Mtok\n切换模型与思考程度"',
		);
		const { description: _, ...plain } = claudeDefault;
		state.newChatModel.peer.model = plain;
		expect(render([codex])).toContain('title="Default (recommended)\n切换模型与思考程度"');
	});

	it.each(["pi", "claude-code"])("does not reuse Codex controls when %s is selected", (runtime) => {
		state.newChatRuntime.peer = runtime;
		state.newChatModel.peer.fastMode = true;
		expect(render([codex])).not.toContain("Fast");
	});
});

describe("model picker provider labels", () => {
	const names = new Map([
		["yunlian-claude-11r9sb4", "云链API · claude旧名"],
		["anthropic", "Anthropic"],
	]);

	it("shows a provider's name instead of its id", () => {
		expect(providerLabel({ provider: "yunlian-claude-11r9sb4", providerName: "云链API · claude企业级" }, names)).toBe(
			"云链API · claude企业级",
		);
		// Hosts older than 1.60 send only the id: use the names the providers list knows.
		expect(providerLabel({ provider: "yunlian-claude-11r9sb4" }, names)).toBe("云链API · claude旧名");
		expect(providerLabel({ provider: "anthropic" })).toBe("anthropic");
		expect(providerLabel({ provider: "codex" }, names)).toBe("codex");
	});
});

describe("model picker search", () => {
	it("matches a model's description as well as its id, name and provider", () => {
		expect(modelMatches(claudeDefault, "opus 5.5")).toBe(true);
		expect(modelMatches(claudeDefault, " DEFAULT ")).toBe(true);
		expect(modelMatches(claudeDefault, "claude-code/default")).toBe(true);
		expect(modelMatches(claudeDefault, "haiku")).toBe(false);
		const { description: _, ...plain } = claudeDefault;
		expect(modelMatches(plain, "opus")).toBe(false);
		expect(modelMatches({ ...plain, provider: "yunlian" }, "云链", new Map([["yunlian", "云链API"]]))).toBe(true);
	});
});
