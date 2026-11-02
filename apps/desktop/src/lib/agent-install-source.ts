import { UPDATE_ROUTES } from "@pier/client";
import { AGENT_INSTALL_SOURCES, type AgentConfigRuntime, type AgentInstallSource } from "@pier/protocol";

/** `localStorage[STORAGE_KEY]`: the download route chosen for each computer and agent. */
const STORAGE_KEY = "pier.agentInstallSources";

/** The name and download host of a route, as shown in the route picker. */
export function agentInstallSourceInfo(
	runtime: AgentConfigRuntime,
	source: AgentInstallSource,
): { name: string; host: string } {
	if (source === "official") {
		return runtime === "codex"
			? { name: "GitHub 直连", host: "github.com" }
			: { name: "官方", host: "downloads.claude.ai" };
	}
	if (source === "npmmirror") return { name: "npmmirror 国内镜像", host: "registry.npmmirror.com" };
	const route = UPDATE_ROUTES.find((route) => route.id === source);
	return { name: route?.label ?? source, host: route?.prefix ? new URL(route.prefix).hostname : "" };
}

function readSources(): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The saved route of an agent on a computer; routes the agent no longer offers fall back to the default. */
export function readAgentInstallSource(node: string, runtime: AgentConfigRuntime): AgentInstallSource {
	const saved = readSources()[JSON.stringify([node, runtime])];
	const sources = AGENT_INSTALL_SOURCES[runtime];
	return sources.find((source) => source === saved) ?? sources[0] ?? "official";
}

export function saveAgentInstallSource(node: string, runtime: AgentConfigRuntime, source: AgentInstallSource): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readSources(), [JSON.stringify([node, runtime])]: source }));
	} catch {
		// The current page still keeps its choice if storage is unavailable.
	}
}
