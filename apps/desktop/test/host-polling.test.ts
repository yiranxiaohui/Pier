import { afterEach, describe, expect, it, vi } from "vitest";
import { pollHost } from "../src/lib/use-host-polling.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("settings host polling", () => {
	it("does not overlap slow requests or deliver stale responses after switching hosts", async () => {
		vi.useFakeTimers();
		const old = deferred<string>();
		const receive = vi.fn();
		const load = vi.fn(() => old.promise);
		const stop = pollHost(load, receive, vi.fn(), 1000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(load).toHaveBeenCalledTimes(1);
		stop();
		const next = pollHost(async () => "selected host", receive, vi.fn(), 1000);
		await vi.advanceTimersByTimeAsync(0);
		old.resolve("previous host");
		await vi.advanceTimersByTimeAsync(0);
		expect(receive.mock.calls).toEqual([["selected host"]]);
		next();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(receive).toHaveBeenCalledTimes(1);
	});

	it("reports failures and retries without clearing the last successful snapshot", async () => {
		vi.useFakeTimers();
		const receive = vi.fn();
		const fail = vi.fn();
		const load = vi
			.fn()
			.mockResolvedValueOnce("initial")
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue("recovered");
		const stop = pollHost(load, receive, fail, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(receive.mock.calls).toEqual([["initial"]]);
		expect(fail).toHaveBeenCalledWith("offline");
		await vi.advanceTimersByTimeAsync(1000);
		expect(receive.mock.calls).toEqual([["initial"], ["recovered"]]);
		stop();
	});
});
