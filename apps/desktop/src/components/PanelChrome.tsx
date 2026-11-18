import { useSyncExternalStore } from "react";

/** Changed-path counts last seen per workspace, for the source control tab's badge. */
const changeCounts = new Map<string, number>();
const countListeners = new Set<() => void>();

export function setGitChangeCount(workspaceId: string, count: number | undefined): void {
	if (changeCounts.get(workspaceId) === count) return;
	if (count === undefined) changeCounts.delete(workspaceId);
	else changeCounts.set(workspaceId, count);
	for (const listener of countListeners) listener();
}

export function useGitChangeCount(workspaceId: string | undefined): number | undefined {
	return useSyncExternalStore(
		(listener) => {
			countListeners.add(listener);
			return () => countListeners.delete(listener);
		},
		() => (workspaceId === undefined ? undefined : changeCounts.get(workspaceId)),
	);
}

/**
 * The heading of a right-hand panel view: the workspace it shows. The views themselves are
 * switched by the tabs at the top of the panel (SidePanel.tsx).
 */
export function PanelHeading({
	name,
	title,
}: {
	name: string;
	/** Tooltip of the workspace name, e.g. its path. */
	title: string;
}) {
	return (
		<div className="files-heading">
			<span className="files-workspace" title={title}>
				{name}
			</span>
		</div>
	);
}
