import {
	BROWSER_PREPARATION_LOG_LIMIT,
	type BrowserPreparationProgress,
	BrowserPreparationProgressSchema,
} from "@pier/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPreparationLog } from "../src/browser/preparation-log.ts";

describe("browser preparation log snapshots", () => {
	afterEach(() => vi.useRealTimers());
	it("coalesces output, bounds the snapshot and flushes the final partial line", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const log = new BrowserPreparationLog(send);
		log.progress({ stage: "installing", message: "Installing" });
		for (let i = 0; i < 1000; i++) log.output(`package-${i} ${"x".repeat(100)}\n`);
		expect(send).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(250);
		expect(send).toHaveBeenCalledTimes(2);
		log.output("last error", "stderr");
		log.flush();
		const snapshot = send.mock.lastCall?.[0] as BrowserPreparationProgress;
		expect(snapshot.logs?.length).toBeLessThanOrEqual(BROWSER_PREPARATION_LOG_LIMIT);
		expect(snapshot.logs).not.toContain("package-0 ");
		expect(snapshot.logs).toContain("package-999 ");
		expect(snapshot.logs).toContain("last error");
		expect(BrowserPreparationProgressSchema.safeParse(snapshot).success).toBe(true);
		vi.advanceTimersByTime(1000);
		expect(send).toHaveBeenCalledTimes(3);
	});
	it("redacts credentials split across chunks before any snapshot leaves the host", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const log = new BrowserPreparationLog(send);
		log.output("\x1b[31mhttps://user:pass");
		vi.advanceTimersByTime(500);
		expect(send).not.toHaveBeenCalled();
		log.output("word@repo.example/debian?token=private\x1b[0m\n");
		log.output("Authorization: Bearer secret-value\napi_key=key-value\n", "stderr");
		log.flush();
		const text = send.mock.lastCall?.[0].logs;
		expect(text).toContain("https://[redacted]@repo.example/debian?[redacted]");
		for (const secret of ["password", "private", "secret-value", "key-value", "\x1b"])
			expect(text).not.toContain(secret);
	});
	it("keeps stdout/stderr partial lines separate and discards oversized unterminated lines", () => {
		const send = vi.fn();
		const log = new BrowserPreparationLog(send);
		log.output("https://user:pass");
		log.output("warning\n", "stderr");
		log.output("word@repo.example/path\n");
		log.output(`token=${"x".repeat(70_000)}`);
		log.output("secret-suffix\nnext line\n");
		log.flush();
		const text = send.mock.lastCall?.[0].logs;
		expect(text).toContain("warning");
		expect(text).toContain("https://[redacted]@repo.example/path");
		expect(text).toContain("过长日志行已省略");
		expect(text).toContain("next line");
		expect(text).not.toContain("secret-suffix");
	});
	it("accepts old progress messages but rejects unbounded log payloads", () => {
		expect(BrowserPreparationProgressSchema.safeParse({ stage: "checking", message: "Checking" }).success).toBe(true);
		expect(
			BrowserPreparationProgressSchema.safeParse({
				stage: "installing",
				message: "Installing",
				logs: "x".repeat(BROWSER_PREPARATION_LOG_LIMIT + 1),
			}).success,
		).toBe(false);
	});
});
