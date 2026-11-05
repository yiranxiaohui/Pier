import type { AgentInstallationStatus } from "@pier/protocol";
import { formatRate, formatSize } from "./format.ts";

/** How many bytes of an agent download the Host reported at a point in time. */
export interface DownloadSample {
	at: number;
	bytes: number;
}

/** The speed averages the downloads of the last few seconds, so it does not jump between polls. */
const RATE_WINDOW_MS = 6000;

/**
 * Adds `sample` to the recent samples of the same download. A smaller byte count means the Host
 * started over (another route or a retry), so older samples no longer describe this download.
 */
export function addDownloadSample(samples: readonly DownloadSample[], sample: DownloadSample): DownloadSample[] {
	const last = samples.at(-1);
	if (last && sample.bytes < last.bytes) return [sample];
	if (last && sample.at <= last.at) return [...samples];
	// Keep the newest sample older than the window, so a slow poll still has a starting point.
	const start = samples.findLastIndex((s) => sample.at - s.at > RATE_WINDOW_MS);
	return [...samples.slice(Math.max(0, start)), sample];
}

/** Bytes per second over the recent samples; undefined until there are two of them. */
export function downloadRate(samples: readonly DownloadSample[]): number | undefined {
	const first = samples[0];
	const last = samples.at(-1);
	if (!first || !last || last.at <= first.at) return undefined;
	return ((last.bytes - first.bytes) * 1000) / (last.at - first.at);
}

/** A rough remaining time, e.g. `约 40 秒` or `约 3 分钟`. */
export function formatRemaining(seconds: number): string {
	if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds / 5) * 5)} 秒`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `约 ${minutes} 分钟`;
	return `约 ${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
}

/** Whole percent downloaded, when the Host knows the size; 100 only once every byte is there. */
export function downloadPercent(status: AgentInstallationStatus | undefined): number | undefined {
	if (status?.state !== "downloading" || !status.totalBytes) return undefined;
	return Math.min(100, Math.floor(((status.downloadedBytes ?? 0) / status.totalBytes) * 100));
}

/** `94.5 MB / 210 MB · 3.2 MB/s · 剩余约 40 秒`, or the downloaded bytes when the size is unknown. */
export function downloadProgressText(status: AgentInstallationStatus, rate?: number): string | undefined {
	if (status.state !== "downloading") return undefined;
	const downloaded = status.downloadedBytes ?? 0;
	const total = status.totalBytes;
	const parts = [total ? `${formatSize(downloaded)} / ${formatSize(total)}` : `已下载 ${formatSize(downloaded)}`];
	if (rate !== undefined) parts.push(formatRate(Math.max(0, rate)));
	if (total && rate && rate > 0 && total > downloaded)
		parts.push(`剩余${formatRemaining((total - downloaded) / rate)}`);
	return parts.join(" · ");
}
