import type { AgentRuntimeCapabilities, AgentRuntimeInfo } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import { parseNewArgs, requireAvailable, resolveRuntime, runtimeName } from "../src/cli-agents.ts";

const capabilities: AgentRuntimeCapabilities = {
	steer: true,
	followUp: true,
	compact: true,
	fork: true,
	rename: true,
	setModel: true,
	thinking: true,
	reload: false,
	images: true,
	piExtensions: false,
};

const runtimes: AgentRuntimeInfo[] = [
	{ id: "pi", name: "pi", available: true, capabilities: { ...capabilities, reload: true, piExtensions: true } },
	{ id: "claude-code", name: "Claude Code", available: true, version: "2.1.0", capabilities },
	{ id: "codex", name: "Codex", available: false, reason: "codex was not found", capabilities },
];

describe("pier-cli agents", () => {
	it("parses /new arguments with an optional agent anywhere", () => {
		expect(parseNewArgs("")).toEqual({});
		expect(parseNewArgs("fix the build")).toEqual({ name: "fix the build" });
		expect(parseNewArgs("-a claude")).toEqual({ agent: "claude" });
		expect(parseNewArgs("--agent codex  fix  build")).toEqual({ agent: "codex", name: "fix build" });
		expect(parseNewArgs("fix build --agent=claude-code")).toEqual({ agent: "claude-code", name: "fix build" });
		expect(() => parseNewArgs("fix -a")).toThrow(/Usage/);
		expect(() => parseNewArgs("--agent=")).toThrow(/Usage/);
	});

	it("resolves numbers, ids, names and unique prefixes", () => {
		expect(resolveRuntime(runtimes, "2").id).toBe("claude-code");
		expect(resolveRuntime(runtimes, "codex").id).toBe("codex");
		expect(resolveRuntime(runtimes, "Claude Code").id).toBe("claude-code");
		expect(resolveRuntime(runtimes, "claudecode").id).toBe("claude-code");
		expect(resolveRuntime(runtimes, "claude").id).toBe("claude-code");
		expect(resolveRuntime(runtimes, "PI").id).toBe("pi");
	});

	it("rejects unknown, ambiguous and out-of-range references", () => {
		expect(() => resolveRuntime(runtimes, "4")).toThrow(/No agent 4/);
		expect(() => resolveRuntime(runtimes, "0")).toThrow(/No agent 0/);
		expect(() => resolveRuntime(runtimes, "gemini")).toThrow(/Unknown agent "gemini".*pi, claude-code, codex/);
		expect(() => resolveRuntime(runtimes, "c")).toThrow(/matches claude-code, codex/);
	});

	it("explains why an agent cannot be used", () => {
		expect(requireAvailable(runtimes[1] as AgentRuntimeInfo).id).toBe("claude-code");
		expect(() => requireAvailable(runtimes[2] as AgentRuntimeInfo)).toThrow(
			"Codex is not available on this computer: codex was not found",
		);
	});

	it("names runtimes, falling back to built-in names and pi for old hosts", () => {
		expect(runtimeName(undefined)).toBe("pi");
		expect(runtimeName("codex")).toBe("Codex");
		expect(runtimeName("claude-code", [{ id: "claude-code", name: "Claude" }])).toBe("Claude");
		expect(runtimeName("gemini")).toBe("gemini");
	});
});
