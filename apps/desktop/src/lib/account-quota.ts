import type { AccountOverview } from "@pier/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_NODE, useAppState, useStore } from "./store.tsx";
import { formatQuota } from "./yunlian.ts";

/** How often the balance is read again while the window is visible. */
const REFRESH_MS = 5 * 60_000;
/** Coming back to the window reads it again when the last reading is older than this. */
const STALE_MS = 60_000;

/** Color bands of the navigation rail's tank, from full to nearly empty. */
export type QuotaLevel = "full" | "half" | "low" | "empty";

export interface AccountQuota {
	/** Share of the account's quota still left: remaining ÷ (remaining + used), 0–100. */
	percent: number;
	level: QuotaLevel;
	/** Balance details for the tooltip. */
	title: string;
}

function levelOf(percent: number): QuotaLevel {
	if (percent >= 60) return "full";
	if (percent >= 30) return "half";
	if (percent >= 10) return "low";
	return "empty";
}

export function accountQuota(overview: AccountOverview): AccountQuota {
	const { site, user } = overview;
	const remain = Math.max(0, user.quota);
	const total = remain + Math.max(0, user.usedQuota);
	let percent = total > 0 ? Math.round((remain / total) * 100) : 0;
	// Never round a little balance to empty, or an almost full one to full.
	if (remain > 0 && percent === 0) percent = 1;
	if (remain < total && percent === 100) percent = 99;
	const quota = (value: number) => formatQuota(value, site.quota);
	return {
		percent,
		level: levelOf(percent),
		title: `${site.name} 余额 ${quota(user.quota)} · 剩余 ${percent}%（历史消耗 ${quota(user.usedQuota)}）\n点击打开个人中心`,
	};
}

/**
 * The 云链API balance of the computer the settings screen manages, or undefined while signed out
 * (or unknown). Read again every few minutes, when the window comes back, and after leaving the
 * personal center, where the user may have signed in, out or topped up.
 */
export function useAccountQuota(): AccountQuota | undefined {
	const store = useStore();
	const node = useAppState((s) => s.settingsNode);
	const open = useAppState((s) =>
		s.settingsNode === LOCAL_NODE
			? s.host.state === "ready" && s.localConnection === "open"
			: s.nodes[s.settingsNode]?.connection === "open",
	);
	const onAccountPage = useAppState((s) => s.settings === "account");
	const sync = useAppState((s) => s.settingsSync);
	const [quota, setQuota] = useState<AccountQuota | undefined>();
	const seq = useRef(0);
	const readAt = useRef(0);

	const refresh = useCallback(async () => {
		const id = ++seq.current;
		readAt.current = Date.now();
		try {
			const overview = await store.account("account.overview", {});
			if (id === seq.current) setQuota(accountQuota(overview));
		} catch {
			// Signed out, or the login expired: hide the tank. Other failures keep the last reading.
			const status = await store.account("account.status", {}).catch(() => undefined);
			if (id === seq.current && status && !status.user) setQuota(undefined);
		}
	}, [store]);

	// Another computer's account: forget this one's reading.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the computer changes.
	useEffect(() => {
		seq.current++;
		setQuota(undefined);
	}, [node]);

	// The personal center reads the account itself; read it again once the user leaves it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: also reread when the computer or its settings sync again.
	useEffect(() => {
		if (open && !onAccountPage) void refresh();
	}, [open, onAccountPage, node, sync, refresh]);

	useEffect(() => {
		if (!open) return;
		const visible = () => document.visibilityState === "visible";
		const back = () => {
			if (visible() && Date.now() - readAt.current >= STALE_MS) void refresh();
		};
		const timer = window.setInterval(() => {
			if (visible()) void refresh();
		}, REFRESH_MS);
		window.addEventListener("focus", back);
		document.addEventListener("visibilitychange", back);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", back);
			document.removeEventListener("visibilitychange", back);
		};
	}, [open, refresh]);

	return quota;
}
