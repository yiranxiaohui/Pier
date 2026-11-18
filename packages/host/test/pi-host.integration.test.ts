import { describe, expect, it } from "vitest";
import { PiLoader, type PiLocation } from "../src/pi/sdk.ts";
import { DEV_PI_PACKAGE_DIR, Recorder, startTestHost, testPiSdk } from "./helpers.ts";

describe("a Host without pi", () => {
	it("starts, reports why pi is unavailable, and loads pi once it is installed", async () => {
		let location: PiLocation = { state: "missing" };
		const loader = new PiLoader({ locate: () => location, load: async () => testPiSdk() });
		const host = await startTestHost({ piLoader: loader });
		try {
			const client = await host.connect();
			const recorder = new Recorder();
			client.onEvent(recorder.handler);
			expect(client.host?.piVersion).toBe("");

			const pi = (await client.request("runtime.list")).runtimes.find((r) => r.id === "pi");
			expect(pi).toMatchObject({ available: false, reason: expect.stringContaining("pi.dev/install.sh") });
			const { workspace } = await client.request("workspace.add", { path: host.workspaceDir });
			expect((await client.request("session.list", { workspaceId: workspace.id })).sessions).toEqual([]);
			expect(await client.request("model.list", { runtime: "pi" })).toEqual({ models: [] });
			await expect(client.request("session.create", { workspaceId: workspace.id })).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining("未找到 pi"),
			});
			await expect(client.request("provider.list")).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(client.request("extension.list")).rejects.toMatchObject({ code: "CONFLICT" });
			// pi's settings files do not need pi.
			expect((await client.request("settings.get")).user.exists).toBe(false);
			expect(await client.request("runtime.installStatus", { runtime: "pi" })).toMatchObject({
				installation: { runtime: "pi", state: "idle" },
				agent: { id: "pi", available: false },
			});

			// Installed in a terminal while the Host runs: picked up on the next use.
			location = { state: "found", installation: { packageDir: DEV_PI_PACKAGE_DIR, version: testPiSdk().version } };
			const changed = recorder.waitForType("runtime.changed", recorder.mark());
			const listed = (await client.request("runtime.list")).runtimes.find((r) => r.id === "pi");
			expect(listed).toMatchObject({ available: true, version: testPiSdk().version });
			expect(await changed).toMatchObject({ event: { type: "runtime.changed", runtime: "pi" } });
			expect((await client.request("provider.list")).providers.length).toBeGreaterThan(0);
			const { session } = await client.request("session.create", { workspaceId: workspace.id });
			expect(session.runtime).toBe("pi");

			// A newer pi on disk waits for a Host restart.
			location = { state: "found", installation: { packageDir: DEV_PI_PACKAGE_DIR, version: "99.0.0" } };
			expect(await client.request("runtime.installStatus", { runtime: "pi" })).toMatchObject({
				agent: { available: true, version: testPiSdk().version },
				installedVersion: "99.0.0",
			});
		} finally {
			await host.close();
		}
	});
});
