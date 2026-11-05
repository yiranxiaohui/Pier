import type { AgentInstallationStatus } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	addDownloadSample,
	type DownloadSample,
	downloadPercent,
	downloadProgressText,
	downloadRate,
	formatRemaining,
} from "../src/lib/agent-install-progress.ts";

const MB = 1024 * 1024;

function downloading(downloadedBytes: number, totalBytes?: number): AgentInstallationStatus {
	return { runtime: "claude-code", state: "downloading", downloadedBytes, ...(totalBytes ? { totalBytes } : {}) };
}

describe("agent download progress", () => {
	it("averages the speed over the last seconds of the same download", () => {
		let samples: DownloadSample[] = [];
		for (let second = 0; second <= 10; second++) {
			samples = addDownloadSample(samples, { at: second * 1000, bytes: second * 2 * MB });
		}
		// One sample older than the window stays as the starting point.
		expect(samples[0]?.at).toBe(3000);
		expect(downloadRate(samples)).toBe(2 * MB);
	});

	it("starts over when the Host restarts the download", () => {
		let samples = addDownloadSample([], { at: 0, bytes: 0 });
		samples = addDownloadSample(samples, { at: 1000, bytes: 40 * MB });
		samples = addDownloadSample(samples, { at: 2000, bytes: MB });
		expect(samples).toEqual([{ at: 2000, bytes: MB }]);
		expect(downloadRate(samples)).toBeUndefined();
		// A repeated poll result at the same time is ignored.
		expect(addDownloadSample(samples, { at: 2000, bytes: 2 * MB })).toEqual(samples);
	});

	it("reports the percent only while downloading a file of known size", () => {
		expect(downloadPercent(downloading(50 * MB, 200 * MB))).toBe(25);
		expect(downloadPercent(downloading(199.9 * MB, 200 * MB))).toBe(99);
		expect(downloadPercent(downloading(50 * MB))).toBeUndefined();
		expect(
			downloadPercent({ runtime: "codex", state: "installing", downloadedBytes: 1, totalBytes: 1 }),
		).toBeUndefined();
		expect(downloadPercent(undefined)).toBeUndefined();
	});

	it("shows the size, speed, and remaining time", () => {
		expect(downloadProgressText(downloading(50 * MB, 200 * MB))).toBe("50.0 MB / 200 MB");
		expect(downloadProgressText(downloading(50 * MB, 200 * MB), 5 * MB)).toBe(
			"50.0 MB / 200 MB · 5.0 MB/s · 剩余约 30 秒",
		);
		expect(downloadProgressText(downloading(50 * MB, 200 * MB), 0)).toBe("50.0 MB / 200 MB · 0 B/s");
		expect(downloadProgressText(downloading(12 * MB), 1.5 * MB)).toBe("已下载 12.0 MB · 1.5 MB/s");
		expect(downloadProgressText({ runtime: "codex", state: "verifying" })).toBeUndefined();
	});

	it("rounds the remaining time", () => {
		expect(formatRemaining(0.2)).toBe("约 5 秒");
		expect(formatRemaining(42)).toBe("约 45 秒");
		expect(formatRemaining(150)).toBe("约 3 分钟");
		expect(formatRemaining(3 * 3600 + 20 * 60)).toBe("约 3 小时 20 分钟");
		expect(formatRemaining(3599)).toBe("约 1 小时");
	});
});
