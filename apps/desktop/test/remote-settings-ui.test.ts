import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogsSettings } from "../src/components/HostPanels.tsx";
import { PairedRemoteSettings } from "../src/components/RemoteOverview.tsx";
import { LocalRemoteSettings } from "../src/components/RemotePanel.tsx";
import { SettingsPage } from "../src/components/Settings.tsx";
import type { AppState, ComputerInfo, SettingsTarget } from "../src/lib/store.tsx";

const { state, target, computers, store, polling } = vi.hoisted(() => ({
	state: {} as AppState,
	target: {} as SettingsTarget,
	computers: [] as ComputerInfo[],
	store: {
		nodeName: () => "Local machine",
		settingsBlocker: vi.fn(),
		remoteOverview: vi.fn(),
		hostLogs: vi.fn(),
		bridgeKind: "tauri",
	},
	polling: { value: undefined as unknown, error: undefined as string | undefined },
}));

vi.mock("../src/lib/store.tsx", () => ({
	LOCAL_NODE: "local",
	useStore: () => store,
	useAppState: (selector: (s: AppState) => unknown) => selector(state),
	useSettingsTarget: () => target,
	useComputers: () => computers,
	useHasPeers: () => true,
}));
vi.mock("../src/lib/use-host-polling.ts", () => ({ useHostPolling: () => polling }));
vi.mock("../src/lib/theme.ts", () => ({ useThemePreference: () => "system", setThemePreference: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	store.settingsBlocker.mockReturnValue(undefined);
	Object.assign(target, { node: "peer", name: "Remote machine", local: false, online: true, revoked: false });
	Object.assign(state, {
		settingsNode: "peer",
		settingsSync: 0,
		host: { state: "ready" },
		localConnection: "open",
		devices: [],
		nodes: {},
		update: {},
		peerUpdates: {},
	});
	computers.length = 0;
	for (const id of ["local", "peer"])
		computers.push({
			id,
			name: id === "local" ? "Local machine" : "Remote machine",
			local: id === "local",
			online: true,
			canManage: true,
			state: { workspaces: [{ id, name: `${id}-workspace-marker`, path: `/${id}`, policy: "ask" }] },
		} as ComputerInfo);
	polling.value = undefined;
	polling.error = undefined;
});

describe("selected host settings UI", () => {
	it("shows remote access, devices and peers without local controls or local badges", () => {
		polling.value = {
			remote: {
				enabled: true,
				port: 7444,
				running: true,
				addresses: ["10.0.0.42:7444"],
				hostFingerprint: "remote-fingerprint",
				mdns: true,
				pairingActive: true,
				relay: { enabled: true, state: "online", url: "wss://relay.test", hasToken: true },
			},
			devices: [{ id: "phone", name: "Remote phone", connected: true, fingerprint: "phone-key", platform: "android" }],
			peers: [
				{
					id: "other",
					name: "Remote peer",
					addresses: ["10.0.0.43:7444"],
					connected: true,
					pairedAt: "2026-01-01T00:00:00Z",
				},
			],
		};
		const html = renderToStaticMarkup(createElement(PairedRemoteSettings, { node: target.node, name: target.name }));
		for (const text of [
			"10.0.0.42:7444",
			"remote-fingerprint",
			"wss://relay.test",
			"Remote phone",
			"Remote peer",
			"已保存（不显示令牌）",
		])
			expect(html).toContain(text);
		expect(html).not.toMatch(/本机设置|这一页只针对本机|重命名|显示配对二维码|清除令牌|保存并重新连接/);
		expect(html).toContain("只能在那台电脑上操作");
	});

	it("shows the remote log tail and never offers the local restart button", () => {
		polling.value = ["remote log marker"];
		const html = renderToStaticMarkup(createElement(LogsSettings));
		expect(html).toContain("Remote machine · Pier Host 日志");
		expect(html).toContain("remote log marker");
		expect(html).not.toMatch(/<button[^>]*>重启 Host/);
	});

	it("filters workspaces to the selected host", () => {
		const html = renderToStaticMarkup(createElement(SettingsPage, { section: "workspaces" }));
		expect(html).toContain("peer-workspace-marker");
		expect(html).not.toContain("local-workspace-marker");
		expect(html).not.toContain("所有电脑");
	});

	it.each(["logs"] as const)("explains old and disconnected hosts on %s without rendering local content", (section) => {
		store.settingsBlocker.mockReturnValue("请先更新远程主机：需要协议 1.55");
		let html = renderToStaticMarkup(createElement(SettingsPage, { section }));
		expect(html).toContain("需要协议 1.55");
		target.online = false;
		html = renderToStaticMarkup(createElement(SettingsPage, { section }));
		expect(html).toContain("Remote machine 未连接");
		expect(html).not.toContain("本机设置");
	});

	it("keeps local access controls and restart available after selecting this computer", () => {
		target.local = true;
		target.node = "local";
		state.settingsNode = "local";
		state.remote = {
			enabled: true,
			running: true,
			port: 7433,
			addresses: ["local-only-address:7433"],
			hostFingerprint: "local-key",
			mdns: false,
			pairingActive: false,
		};
		state.peers = [];
		const html = renderToStaticMarkup(createElement(LocalRemoteSettings));
		expect(html).toContain("local-only-address:7433");
		expect(html).toContain("显示配对二维码");
		expect(renderToStaticMarkup(createElement(LogsSettings))).toContain(">重启 Host</button>");
	});

	it("shows load failures rather than spinning forever", () => {
		polling.error = "connection lost";
		expect(
			renderToStaticMarkup(createElement(PairedRemoteSettings, { node: target.node, name: target.name })),
		).toContain("读取连接设置失败：connection lost");
		expect(renderToStaticMarkup(createElement(LogsSettings))).toContain("读取日志失败：connection lost");
	});
});
