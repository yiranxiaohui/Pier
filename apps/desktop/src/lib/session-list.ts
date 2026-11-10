/** Sessions a workspace lists before 显示更多. */
export const SESSION_PREVIEW = 6;
/** Sessions each 显示更多 adds. */
export const SESSION_PAGE = 30;

export interface SessionWindow {
	/** Sessions listed, from the top. */
	shown: number;
	/** Sessions below them, behind 显示更多. */
	more: number;
	/** Whether 收起 goes back to the preview. */
	collapsible: boolean;
}

/**
 * How much of a workspace's `total` sessions the sidebar lists: `limit` of them (the preview, then a
 * page more for each 显示更多), and always as far down as the open one at `selectedIndex` (-1 for
 * none), so it never drops out of view.
 */
export function sessionWindow(total: number, limit: number, selectedIndex: number): SessionWindow {
	const shown = Math.min(total, Math.max(limit, selectedIndex + 1));
	return { shown, more: total - shown, collapsible: limit > SESSION_PREVIEW && total > SESSION_PREVIEW };
}
