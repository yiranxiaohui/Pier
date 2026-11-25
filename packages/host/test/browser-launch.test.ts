import { describe, expect, it } from "vitest";
import { launchSettings } from "../src/browser/chromium.ts";

describe("browser launch settings", () => {
	it("keeps Windows Chrome and Edge from relaunching away from the CDP pipe", () => {
		const env = {
			PATH: "C:\\Windows",
			__compat_layer: "Installer",
			__COMPAT_LAYER: "DetectorsAppHealth",
			TEMP: "C:\\t",
		};
		const settings = launchSettings("win32", env);
		expect(settings.args).toEqual(["--do-not-de-elevate", "--edge-skip-compat-layer-relaunch"]);
		expect(settings.env).toEqual({ PATH: "C:\\Windows", TEMP: "C:\\t" });
		// The caller's environment is left alone.
		expect(env.__COMPAT_LAYER).toBe("DetectorsAppHealth");
	});

	it("changes nothing elsewhere", () => {
		const env = { PATH: "/usr/bin", __COMPAT_LAYER: "Installer" };
		expect(launchSettings("linux", env)).toEqual({ args: [], env });
		expect(launchSettings("darwin", env).env).toBe(env);
	});
});
