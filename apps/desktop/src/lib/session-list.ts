import type { SessionRunState, SessionSummary } from "@pier/protocol";
import { isRunning } from "./agent-activity.ts";

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
 * none), so it never drops out of view. A single session left over is listed too: a 显示更多 for it
 * would take the same room.
 */
export function sessionWindow(total: number, limit: number, selectedIndex: number): SessionWindow {
	let shown = Math.min(total, Math.max(limit, selectedIndex + 1));
	if (total - shown === 1) shown = total;
	return { shown, more: total - shown, collapsible: limit > SESSION_PREVIEW && total > SESSION_PREVIEW };
}

/** Milliseconds since the epoch of an ISO time; 0 for a missing or broken one, which sorts last. */
function timeOf(iso: string | undefined): number {
	const time = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(time) ? time : 0;
}

/**
 * The time a session's sidebar row shows and the list sorts by: its latest activity when sessions
 * are sorted by activity (设置 → 常规 → 会话列表), otherwise when it was created.
 */
export function sessionListTime(session: SessionSummary, byActivity: boolean): string {
	return byActivity ? session.modifiedAt : session.createdAt;
}

/**
 * A workspace's sessions in sidebar order, newest first: by latest activity (`byActivity`), so a
 * session that starts running moves to the top, or by creation time, so sessions keep their places
 * and only new ones come in at the top. Sessions with the same time keep the host's order.
 */
export function sortSessions(sessions: readonly SessionSummary[], byActivity: boolean): SessionSummary[] {
	return sessions
		.map((session) => ({ session, time: timeOf(sessionListTime(session, byActivity)) }))
		.sort((a, b) => b.time - a.time)
		.map(({ session }) => session);
}

/**
 * A workspace's sessions after the host reported that session `sessionId` is in run `state` with
 * `pendingUi` questions open. A session that starts running is active as of `now`: no earlier than
 * any session of the list, so sorting by activity puts it on top even when the host's clock runs
 * ahead of this one (the next list from the host has the host's own time). Undefined when the
 * session is not listed.
 */
export function withSessionActivity(
	sessions: readonly SessionSummary[],
	sessionId: string,
	state: SessionRunState,
	pendingUi: number,
	now = Date.now(),
): SessionSummary[] | undefined {
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) return undefined;
	const started = isRunning(state) && !isRunning(session.state);
	const latest = started ? sessions.reduce((max, s) => Math.max(max, timeOf(s.modifiedAt)), 0) : 0;
	const next: SessionSummary = {
		...session,
		state,
		pendingUi,
		active: true,
		...(started ? { modifiedAt: new Date(Math.max(now, latest + 1)).toISOString() } : {}),
	};
	return sessions.map((s) => (s.id === sessionId ? next : s));
}
