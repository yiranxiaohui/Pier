import type { ProviderInfo, ProviderListResult } from "@pier/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsSettings, NoModelsBanner } from "../src/components/ModelsPanel.tsx";
import type { AppState } from "../src/lib/store.tsx";

const { state, store, buttons } = vi.hoisted(() => ({
	state: {} as Pick<AppState, "node" | "settingsNode" | "providers" | "localProviders">,
	store: { openSettings: vi.fn(), openModels: vi.fn(), startLogin: vi.fn() },
	buttons: [] as Array<{ children?: ReactNode; title?: string; onClick?: () => void }>,
}));

vi.mock("../src/lib/store.tsx", () => ({
	LOCAL_NODE: "local",
	useStore: () => store,
	useAppState: (selector: (value: AppState) => unknown) => selector(state as AppState),
	useSettingsTarget: () => ({ local: state.settingsNode === "local", name: "Remote" }),
}));

// Capture the rendered buttons' real handlers without adding a browser/DOM dependency.
vi.mock("react/jsx-runtime", async (importOriginal) => {
	const runtime = await importOriginal<typeof import("react/jsx-runtime")>();
	const capture =
		(render: typeof runtime.jsx): typeof runtime.jsx =>
		(...args) => {
			const element = render(...args);
			if (element.type === "button") buttons.push(element.props);
			return element;
		};
	return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});

vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
	const runtime = await importOriginal<typeof import("react/jsx-dev-runtime")>();
	const jsxDEV: typeof runtime.jsxDEV = (...args) => {
		const element = runtime.jsxDEV(...args);
		if (element.type === "button") buttons.push(element.props);
		return element;
	};
	return { ...runtime, jsxDEV };
});

const emptyProviders = (): ProviderListResult => ({
	providers: [],
	defaultAvailable: false,
	availableCount: 0,
	agentDir: "/home/me/.pi/agent",
});

const configured = (id: string, baseUrl = "https://api.yunnet.top/v1"): ProviderInfo => ({
	id,
	name: id,
	builtin: false,
	stored: false,
	status: { configured: true, source: "models_json_key" },
	modelCount: 1,
	availableCount: 1,
	custom: { id, api: "openai-completions", baseUrl, models: [{ id: "model" }], hasConfiguredKey: true },
});

beforeEach(() => {
	vi.clearAllMocks();
	buttons.length = 0;
	Object.assign(state, {
		node: "local",
		settingsNode: "peer",
		providers: emptyProviders(),
		localProviders: emptyProviders(),
	});
});

describe("model setup uses the personal center", () => {
	it("opens the local personal center from the home banner even if settings last managed a peer", () => {
		const html = renderToStaticMarkup(createElement(NoModelsBanner));
		expect(html).toContain("在个人中心登录云链API并按分组配置模型");
		expect(html).not.toContain("授权");
		// Icons are rendered too, so locate the button through its visible label.
		const account = buttons.find((button) => renderToStaticMarkup(button.children).endsWith("个人中心"));
		expect(account).toBeDefined();
		account?.onClick?.();
		expect(store.openSettings).toHaveBeenCalledExactlyOnceWith("account", "local");
		buttons.find((button) => button.children === "配置模型")?.onClick?.();
		expect(store.openModels).toHaveBeenCalledExactlyOnceWith("local");
	});

	it("does not show the local banner for remote workspaces, unknown providers or usable models", () => {
		state.node = "peer";
		expect(renderToStaticMarkup(createElement(NoModelsBanner))).toBe("");
		state.node = "local";
		state.localProviders = undefined;
		expect(renderToStaticMarkup(createElement(NoModelsBanner))).toBe("");
		state.localProviders = { ...emptyProviders(), availableCount: 1 };
		expect(renderToStaticMarkup(createElement(NoModelsBanner))).toBe("");
	});

	it.each(["local", "peer"])("offers the personal center before configuring any provider on %s", (node) => {
		state.settingsNode = node;
		const html = renderToStaticMarkup(createElement(ModelsSettings));
		expect(html).toContain("在「个人中心」登录并按分组配置模型");
		const account = buttons.filter((button) => renderToStaticMarkup(button.children).endsWith("个人中心"));
		expect(account).toHaveLength(1);
		account[0]?.onClick?.();
		// No explicit node: retain the computer the settings screen currently manages.
		expect(store.openSettings).toHaveBeenCalledExactlyOnceWith("account");
	});

	it.each(["local", "peer"])("routes existing 云链API providers on %s to the personal center", (node) => {
		state.settingsNode = node;
		state.providers = {
			...emptyProviders(),
			providers: [configured("yunlian"), configured("yunlian-vip"), configured("manual", "https://api.syixn.com")],
		};
		const html = renderToStaticMarkup(createElement(ModelsSettings));
		expect(html).not.toContain("重新登录");
		expect(html).not.toContain("重新授权");
		const account = buttons.filter((button) => button.title === "在个人中心登录并按分组管理令牌和模型");
		expect(account).toHaveLength(3);
		for (const button of account) button.onClick?.();
		expect(store.openSettings.mock.calls).toEqual([["account"], ["account"], ["account"]]);
	});

	it("keeps other providers' subscription and API key login actions", () => {
		const provider: ProviderInfo = {
			id: "anthropic",
			name: "Anthropic",
			builtin: true,
			stored: false,
			status: { configured: false },
			modelCount: 1,
			availableCount: 0,
			oauth: { name: "Anthropic", subscription: true },
			apiKey: { name: "Anthropic", interactive: true },
		};
		state.providers = { ...emptyProviders(), providers: [provider] };
		renderToStaticMarkup(createElement(ModelsSettings));
		buttons.find((button) => button.children === "订阅账号登录")?.onClick?.();
		buttons.find((button) => renderToStaticMarkup(button.children).endsWith("API Key"))?.onClick?.();
		expect(store.startLogin.mock.calls).toEqual([
			[provider, "oauth"],
			[provider, "api_key"],
		]);
	});
});
