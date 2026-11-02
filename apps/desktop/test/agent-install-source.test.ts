import { AGENT_INSTALL_SOURCES } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentInstallSourceInfo,
	readAgentInstallSource,
	saveAgentInstallSource,
} from "../src/lib/agent-install-source.ts";

let storage: Map<string, string>;

beforeEach(() => {
	storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("agent download routes", () => {
	it("remembers the route per computer and agent, defaulting to the official route", () => {
		expect(readAgentInstallSource("ubuntu", "claude-code")).toBe("official");
		saveAgentInstallSource("ubuntu", "claude-code", "npmmirror");
		saveAgentInstallSource("ubuntu", "codex", "gh-proxy");
		expect(readAgentInstallSource("ubuntu", "claude-code")).toBe("npmmirror");
		expect(readAgentInstallSource("ubuntu", "codex")).toBe("gh-proxy");
		expect(readAgentInstallSource("local", "claude-code")).toBe("official");
	});

	it("ignores routes an agent does not offer and unreadable storage", () => {
		storage.set("pier.agentInstallSources", JSON.stringify({ [JSON.stringify(["ubuntu", "codex"])]: "npmmirror" }));
		expect(readAgentInstallSource("ubuntu", "codex")).toBe("official");
		storage.set("pier.agentInstallSources", "not json");
		expect(readAgentInstallSource("ubuntu", "claude-code")).toBe("official");
	});

	it("names every route with the host it downloads from", () => {
		for (const [runtime, sources] of Object.entries(AGENT_INSTALL_SOURCES)) {
			for (const source of sources) {
				const info = agentInstallSourceInfo(runtime as keyof typeof AGENT_INSTALL_SOURCES, source);
				expect(info.name).not.toBe("");
				expect(info.host).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
			}
		}
		expect(agentInstallSourceInfo("claude-code", "official")).toEqual({ name: "官方", host: "downloads.claude.ai" });
		expect(agentInstallSourceInfo("codex", "ghfast")).toEqual({ name: "GHFast", host: "ghfast.top" });
	});
});
