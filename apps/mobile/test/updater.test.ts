import { UPDATE_ROUTES } from "@pier/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubGlobal("__DEV__", false));

const mock = vi.hoisted(() => ({
	settings: JSON.stringify({ autoCheck: false }),
	downloaded: false,
	md5: "a".repeat(32),
	getItem: vi.fn(),
	setItem: vi.fn(),
	download: vi.fn(),
	install: vi.fn(),
	appState: { currentState: "active" },
	prepareNotification: vi.fn(),
	showNotification: vi.fn(),
	dismissNotification: vi.fn(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: mock.appState }));
vi.mock("../src/store.ts", () => ({ APP_VERSION: "1.0.0" }));
vi.mock("../src/storage.ts", () => ({ getItem: mock.getItem, setItem: mock.setItem }));
vi.mock("expo-intent-launcher", () => ({ startActivityAsync: mock.install }));
vi.mock("../src/update-notification.ts", () => ({
	prepareUpdateNotification: mock.prepareNotification,
	showUpdateNotification: mock.showNotification,
	dismissUpdateNotification: mock.dismissNotification,
}));
vi.mock("expo-file-system", () => ({
	Paths: { cache: "cache" },
	Directory: class {
		exists = false;
		create() {}
		list() {
			return [];
		}
	},
	File: class {
		static downloadFileAsync = mock.download;
		contentUri = "content://pier/update.apk";
		get exists() {
			return mock.downloaded;
		}
		get size() {
			return 42;
		}
		get md5() {
			return mock.md5;
		}
		delete() {
			mock.downloaded = false;
		}
	},
}));

import { ANDROID_UPDATE_MANIFEST_URL } from "../src/update-manifest.ts";
import { MobileUpdater } from "../src/updater.ts";

const manifest = {
	version: "1.2.3",
	url: "https://github.com/yiranxiaohui/Pier/releases/download/v1.2.3/pier-v1.2.3-android.apk",
	size: 42,
	sha256: "b".repeat(64),
	md5: "a".repeat(32),
};

beforeEach(() => {
	vi.stubGlobal("__DEV__", false);
	vi.clearAllMocks();
	mock.settings = JSON.stringify({ autoCheck: false });
	mock.downloaded = false;
	mock.md5 = manifest.md5;
	mock.appState.currentState = "active";
	mock.prepareNotification.mockResolvedValue(undefined);
	mock.getItem.mockImplementation(async () => mock.settings);
	mock.setItem.mockImplementation(async (_key: string, value: string) => {
		mock.settings = value;
	});
	mock.download.mockImplementation(async () => {
		mock.downloaded = true;
	});
	mock.install.mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => manifest })),
	);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("mobile update routes", () => {
	it.each(UPDATE_ROUTES.filter((route) => route.prefix))(
		"saves and uses the $label preset for checks and downloads",
		async (route) => {
			const updater = new MobileUpdater();
			await updater.init();
			await updater.setMirror(route.prefix);
			await vi.waitFor(() => expect(updater.getStatus().state).toBe("available"));
			expect(fetch).toHaveBeenLastCalledWith(`${route.prefix}${ANDROID_UPDATE_MANIFEST_URL}`, expect.anything());
			await updater.install();
			expect(mock.download).toHaveBeenCalledWith(
				`${route.prefix}${manifest.url}`,
				expect.anything(),
				expect.anything(),
			);
			const restored = new MobileUpdater();
			await restored.init();
			expect(restored.getStatus().mirrorPrefix).toBe(route.prefix);
		},
	);

	it("loads old settings with GitHub direct and retains other preferences", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		expect(updater.getStatus()).toMatchObject({ autoCheck: false, mirrorPrefix: "" });
		await updater.check();
		expect(fetch).toHaveBeenCalledWith(ANDROID_UPDATE_MANIFEST_URL, expect.anything());
	});

	it("uses the saved route for both the manifest and APK and preserves it across preference changes", async () => {
		mock.settings = JSON.stringify({
			autoCheck: false,
			mirrorPrefix: "https://mirror.example/",
			skippedVersion: "1.1.0",
		});
		const updater = new MobileUpdater();
		await updater.init();
		await updater.check();
		expect(fetch).toHaveBeenCalledWith(`https://mirror.example/${ANDROID_UPDATE_MANIFEST_URL}`, expect.anything());
		await updater.install();
		expect(mock.download).toHaveBeenCalledWith(
			`https://mirror.example/${manifest.url}`,
			expect.anything(),
			expect.anything(),
		);
		expect(mock.install).toHaveBeenCalledOnce();
		await updater.setAutoCheck(false);
		await updater.skip("1.2.3");
		expect(JSON.parse(mock.settings)).toEqual({
			autoCheck: false,
			mirrorPrefix: "https://mirror.example/",
			skippedVersion: "1.2.3",
		});
	});

	it("switches from a failed direct check to a mirror and can switch back", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		vi.mocked(fetch).mockRejectedValueOnce(new Error("unreachable"));
		await updater.check();
		expect(updater.getStatus().state).toBe("error");
		await updater.setMirror(" https://mirror.example/proxy ");
		await vi.waitFor(() => expect(updater.getStatus().state).toBe("available"));
		expect(fetch).toHaveBeenLastCalledWith(
			`https://mirror.example/proxy/${ANDROID_UPDATE_MANIFEST_URL}`,
			expect.anything(),
		);
		await updater.setMirror("");
		await vi.waitFor(() => expect(updater.getStatus().state).toBe("available"));
		expect(fetch).toHaveBeenLastCalledWith(ANDROID_UPDATE_MANIFEST_URL, expect.anything());
		expect(JSON.parse(mock.settings).mirrorPrefix).toBe("");
	});

	it("still rejects a damaged APK downloaded through a mirror", async () => {
		mock.settings = JSON.stringify({ autoCheck: false, mirrorPrefix: "https://mirror.example/" });
		const updater = new MobileUpdater();
		await updater.init();
		await updater.check();
		mock.md5 = "0".repeat(32);
		await updater.install();
		expect(updater.getStatus()).toMatchObject({ state: "error", error: expect.stringContaining("校验失败") });
		expect(mock.downloaded).toBe(false);
		expect(mock.install).not.toHaveBeenCalled();
	});

	it.each(["success", "failure"])("switches a stalled check and ignores its late %s", async (result) => {
		const updater = new MobileUpdater();
		await updater.init();
		let finish!: () => void;
		let signal!: AbortSignal;
		vi.mocked(fetch).mockImplementationOnce((_url, options) => {
			signal = options?.signal as AbortSignal;
			return new Promise<Response>((resolve, reject) => {
				finish = () =>
					result === "failure"
						? reject(new Error("old connection failed"))
						: resolve({ ok: true, json: async () => ({ ...manifest, version: "9.9.9" }) } as Response);
			});
		});
		const checking = updater.check();
		expect(updater.getStatus().state).toBe("checking");
		await updater.setMirror("https://mirror.example/");
		expect(signal.aborted).toBe(true);
		await checking;
		await vi.waitFor(() => expect(updater.getStatus().state).toBe("available"));
		finish();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(updater.getStatus()).toMatchObject({
			state: "available",
			mirrorPrefix: "https://mirror.example/",
			update: { version: manifest.version },
		});
		expect(fetch).toHaveBeenLastCalledWith(`https://mirror.example/${ANDROID_UPDATE_MANIFEST_URL}`, expect.anything());
	});

	it.each(["connection", "body"])("ends a stalled %s after 30 seconds even when abort is ignored", async (stage) => {
		vi.useFakeTimers();
		const updater = new MobileUpdater();
		await updater.init();
		const stalled = new Promise<Response>(() => {});
		vi.mocked(fetch).mockImplementationOnce(() =>
			stage === "connection"
				? stalled
				: Promise.resolve({
						ok: true,
						json: () => new Promise(() => {}),
					} as Response),
		);
		const checking = updater.check();
		await vi.advanceTimersByTimeAsync(29_999);
		expect(updater.getStatus().state).toBe("checking");
		await vi.advanceTimersByTimeAsync(1);
		await checking;
		expect(updater.getStatus()).toMatchObject({ state: "error", error: expect.stringContaining("连接超时") });
		expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		await updater.check();
		expect(updater.getStatus().state).toBe("available");
	});

	it.each([false, true])("cancels promptly and retains a known update (downloaded: %s)", async (downloaded) => {
		const updater = new MobileUpdater();
		await updater.init();
		mock.downloaded = downloaded;
		await updater.check();
		const previous = updater.getStatus();
		vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
		const checking = updater.check();
		updater.cancelCheck();
		await checking;
		expect(updater.getStatus()).toEqual(previous);
		await updater.check();
		expect(updater.getStatus().state).toBe(downloaded ? "ready" : "available");
	});

	it("does not let a canceled request retire a subsequent pending check", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
		const first = updater.check();
		updater.cancelCheck();
		const second = updater.check();
		await first;
		expect(updater.getStatus().state).toBe("checking");
		updater.cancelCheck();
		await second;
		expect(updater.getStatus().state).toBe("idle");
	});

	it("disabling auto-check cancels an active check and retains the preference", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
		const checking = updater.check();
		await updater.setAutoCheck(false);
		await checking;
		expect(updater.getStatus()).toMatchObject({ state: "idle", autoCheck: false });
		expect(JSON.parse(mock.settings).autoCheck).toBe(false);
	});

	it("disabling auto-check before the startup timer prevents its check", async () => {
		vi.useFakeTimers();
		mock.settings = JSON.stringify({ autoCheck: true });
		const updater = new MobileUpdater();
		await updater.init();
		await updater.setAutoCheck(false);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(fetch).not.toHaveBeenCalled();
		expect(updater.getStatus().state).toBe("idle");
	});

	it("keeps an active check when saving a new route fails", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		let signal!: AbortSignal;
		vi.mocked(fetch).mockImplementationOnce((_url, options) => {
			signal = options?.signal as AbortSignal;
			return new Promise(() => {});
		});
		const checking = updater.check();
		mock.setItem.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(updater.setMirror("https://mirror.example/")).rejects.toThrow("storage unavailable");
		expect(updater.getStatus()).toMatchObject({ state: "checking", mirrorPrefix: "" });
		expect(signal.aborted).toBe(false);
		updater.cancelCheck();
		await checking;
	});

	it("rejects route changes during a download", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		await updater.check();
		let finish!: () => void;
		mock.download.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = () => {
						mock.downloaded = true;
						resolve();
					};
				}),
		);
		const installing = updater.install();
		expect(updater.getStatus().state).toBe("downloading");
		await expect(updater.setMirror("https://mirror.example/")).rejects.toThrow("等待");
		await vi.waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
		finish();
		await installing;
		expect(mock.install).toHaveBeenCalledOnce();
	});

	it("keeps the current route when saving settings fails", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		mock.setItem.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(updater.setMirror("https://mirror.example/")).rejects.toThrow("storage unavailable");
		expect(updater.getStatus().mirrorPrefix).toBe("");
		expect(fetch).not.toHaveBeenCalled();
		await updater.check();
		expect(updater.getStatus().state).toBe("available");
	});

	it("retains preferences when a stored route is invalid and rejects invalid new routes", async () => {
		mock.settings = JSON.stringify({
			autoCheck: false,
			mirrorPrefix: "http://mirror.example/",
			skippedVersion: "1.1.0",
		});
		const updater = new MobileUpdater();
		await updater.init();
		expect(updater.getStatus()).toMatchObject({ autoCheck: false, mirrorPrefix: "", skippedVersion: "1.1.0" });
		await expect(updater.setMirror("http://mirror.example/")).rejects.toThrow("HTTPS");
		expect(mock.setItem).not.toHaveBeenCalled();
	});
});

describe("mobile update notifications", () => {
	async function availableUpdater() {
		const updater = new MobileUpdater();
		await updater.init();
		await updater.check();
		return updater;
	}

	it("clears stale progress at startup and reports download, verification and installer states", async () => {
		const updater = await availableUpdater();
		expect(mock.dismissNotification).toHaveBeenCalledOnce();
		expect(mock.prepareNotification).not.toHaveBeenCalled();
		mock.download.mockImplementationOnce(async (_url, _file, options) => {
			options.onProgress({ bytesWritten: 21, totalBytes: 42 });
			mock.downloaded = true;
		});
		await updater.install();
		expect(mock.prepareNotification).toHaveBeenCalledOnce();
		expect(mock.showNotification.mock.calls).toEqual([
			[manifest.version, "downloading", 0, 42],
			[manifest.version, "downloading", 21, 42],
			[manifest.version, "ready"],
			[manifest.version, "installing"],
			[manifest.version, "ready"],
		]);
	});

	it("uses manifest size when the server omits Content-Length", async () => {
		const updater = await availableUpdater();
		mock.download.mockImplementationOnce(async (_url, _file, options) => {
			options.onProgress({ bytesWritten: 10, totalBytes: -1 });
			mock.downloaded = true;
		});
		await updater.install();
		expect(mock.showNotification).toHaveBeenCalledWith(manifest.version, "downloading", 10, 42);
	});

	it("cancels while notification permission is pending without starting a download", async () => {
		const updater = await availableUpdater();
		let finish!: () => void;
		mock.prepareNotification.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const installing = updater.install();
		updater.cancel();
		finish();
		await installing;
		expect(mock.download).not.toHaveBeenCalled();
		expect(mock.showNotification).not.toHaveBeenCalled();
		expect(mock.install).not.toHaveBeenCalled();
		expect(updater.getStatus().state).toBe("available");
	});

	it("clears canceled downloads and ignores late progress and completion even if native abort is ignored", async () => {
		const updater = await availableUpdater();
		let finish!: () => void;
		let progress!: () => void;
		mock.download.mockImplementationOnce(
			(_url, _file, options) =>
				new Promise<void>((resolve) => {
					progress = () => options.onProgress({ bytesWritten: 42, totalBytes: 42 });
					finish = () => {
						mock.downloaded = true;
						resolve();
					};
				}),
		);
		const installing = updater.install();
		await vi.waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
		updater.cancel();
		expect(mock.dismissNotification).toHaveBeenCalledTimes(2);
		mock.showNotification.mockClear();
		progress();
		finish();
		await installing;
		expect(mock.showNotification).not.toHaveBeenCalled();
		expect(mock.install).not.toHaveBeenCalled();
		expect(mock.downloaded).toBe(false);
		expect(updater.getStatus().state).toBe("available");
	});

	it("keeps a verified background download ready and installs after the user returns", async () => {
		const updater = await availableUpdater();
		mock.download.mockImplementationOnce(async () => {
			mock.downloaded = true;
			mock.appState.currentState = "background";
		});
		await updater.install();
		expect(updater.getStatus().state).toBe("ready");
		expect(mock.showNotification).toHaveBeenLastCalledWith(manifest.version, "ready");
		expect(mock.install).not.toHaveBeenCalled();
		mock.appState.currentState = "active";
		await updater.install();
		expect(mock.download).toHaveBeenCalledOnce();
		expect(mock.install).toHaveBeenCalledOnce();
	});

	it.each(["download", "verification", "installer"])("reports %s failures in the notification", async (stage) => {
		const updater = await availableUpdater();
		if (stage === "download") mock.download.mockRejectedValueOnce(new Error("network error"));
		if (stage === "verification") mock.md5 = "0".repeat(32);
		if (stage === "installer") mock.install.mockRejectedValueOnce(new Error("installer error"));
		await updater.install();
		expect(mock.showNotification).toHaveBeenLastCalledWith(manifest.version, "error");
		expect(updater.getStatus().state).toBe("error");
		if (stage !== "installer") expect(mock.install).not.toHaveBeenCalled();
	});
});
