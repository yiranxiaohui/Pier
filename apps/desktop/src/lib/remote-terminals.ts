/**
 * Terminals on other computers: the store decides where a new terminal runs — this computer's
 * pseudo-terminals, or a paired computer's Pier Host when it can run terminals.
 */

import type { PierClient } from "@pier/client";
import type { WorkspaceInfo } from "@pier/protocol";
import type { TerminalBridge } from "./bridge.ts";
import { remoteTerminalBridge } from "./remote-terminal-bridge.ts";
import { hostRunsTerminals, LOCAL_NODE, type PierStore, useAppState } from "./store.tsx";
import { type TerminalTarget, terminals } from "./terminals.ts";

const bridges = new WeakMap<PierClient, TerminalBridge>();

/**
 * Open terminals on the computer of the workspace: this one through the desktop app, a paired
 * one through its host when it can run terminals.
 */
export function installTerminalResolver(store: PierStore): void {
	terminals.setLinkOpener((url, workspaceId) => {
		void store.openWorkspaceUrl(url, workspaceId);
	});
	terminals.setResolver((workspace: WorkspaceInfo | undefined): TerminalTarget | undefined => {
		const node = workspace ? store.nodeOf(workspace.id) : LOCAL_NODE;
		if (node === LOCAL_NODE) return terminals.local ? { backend: terminals.local } : undefined;
		const state = store.getState().nodes[node];
		const client = store.nodeClient(node);
		if (!client || state?.connection !== "open" || !hostRunsTerminals(state.hostInfo)) return undefined;
		let backend = bridges.get(client);
		if (!backend) {
			backend = remoteTerminalBridge(client, () => store.nodeName(node));
			bridges.set(client, backend);
		}
		return { backend, hostName: store.nodeName(node) };
	});
}

/** Whether a terminal can be opened for a workspace (on its computer), or on this computer without one. */
export function useCanOpenTerminal(workspace: WorkspaceInfo | undefined): boolean {
	return useAppState((s) => {
		const node = workspace ? (s.workspaceNodes[workspace.id] ?? s.node) : LOCAL_NODE;
		if (node === LOCAL_NODE) return terminals.supported;
		const state = s.nodes[node];
		return state?.connection === "open" && hostRunsTerminals(state.hostInfo);
	});
}
