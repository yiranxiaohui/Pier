import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown) => void;

const mock = vi.hoisted(() => ({
	platform: { OS: "android" },
	native: undefined as unknown,
	storage: { getItem: vi.fn(), setItem: vi.fn() },
	startActivity: vi.fn(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => mock.native ?? null }));
vi.mock("react-native", () => ({ Platform: mock.platform }));
vi.mock("../src/storage.ts", () => mock.storage);
vi.mock("expo-intent-launcher", () => ({ startActivityAsync: mock.startActivity }));

function fakeRecognizer(services = ["com.xiaomi.mibrain.speech"], defaultService = "com.xiaomi.mibrain.speech") {
	const listeners = new Map<string, Set<Listener>>();
	return {
		start: vi.fn(),
		stop: vi.fn(),
		abort: vi.fn(),
		requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
		getSpeechRecognitionServices: vi.fn(() => services),
		getDefaultRecognitionService: vi.fn(() => ({ packageName: defaultService })),
		addListener: vi.fn((event: string, listener: Listener) => {
			const set = listeners.get(event) ?? new Set<Listener>();
			listeners.set(event, set);
			set.add(listener);
			return { remove: () => set.delete(listener) };
		}),
		emit(event: string, payload: unknown = null) {
			for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
		},
		listening() {
			return [...listeners.values()].reduce((count, set) => count + set.size, 0);
		},
	};
}

type Fake = ReturnType<typeof fakeRecognizer>;

function result(transcript: string, isFinal: boolean) {
	return { isFinal, results: [{ transcript, confidence: 1, segments: [] }] };
}

async function load(native: Fake | null = fakeRecognizer()) {
	mock.native = native;
	return import("../src/system-speech.ts");
}

/** Start a dictation and wait until the recognizer reports it is listening. */
async function listen(fake: Fake, language = "zh-CN") {
	const speech = await load(fake);
	await speech.setSystemSpeechLanguage(language);
	const operation = new AbortController();
	const onError = vi.fn();
	const starting = speech.startSystemRecognition(operation.signal, onError);
	fake.emit("audiostart", { uri: null, timestamp: 0 });
	fake.emit("start");
	const recording = await starting;
	return { speech, recording, operation, onError };
}

beforeEach(() => {
	vi.resetModules();
	mock.platform.OS = "android";
	mock.storage.getItem.mockReset().mockResolvedValue(null);
	mock.storage.setItem.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe("system speech support", () => {
	it("uses the phone's default recognition service", async () => {
		const speech = await load();
		expect(speech.refreshSystemSpeechSupport()).toEqual({
			available: true,
			servicePackage: "com.xiaomi.mibrain.speech",
		});
	});

	it("binds an installed service when no default is selected", async () => {
		const speech = await load(fakeRecognizer(["com.example.asr", "com.other.asr"], ""));
		expect(speech.refreshSystemSpeechSupport()).toEqual({
			available: true,
			servicePackage: "com.example.asr",
			bindService: true,
		});
	});

	it("reports phones without a recognition service and builds without the native module", async () => {
		const speech = await load(fakeRecognizer([], ""));
		expect(speech.refreshSystemSpeechSupport()).toEqual({
			available: false,
			reason: "这台手机没有可用的系统语音识别服务",
		});
		vi.resetModules();
		const missing = await load(null);
		expect(missing.refreshSystemSpeechSupport().available).toBe(false);
	});

	it("prefers system recognition unless the user chose the computer service", async () => {
		const speech = await load();
		expect(speech.speechProvider()).toBe("system");
		await speech.setSpeechProvider("service");
		expect(speech.speechProvider()).toBe("service");
		expect(mock.storage.setItem).toHaveBeenCalledWith("pier.speech.provider", "service");
		expect(speech.speechProvider({ provider: "system", support: { available: false, reason: "无" } })).toBe("service");
	});

	it("restores saved choices, ignores invalid values and keeps a newer choice", async () => {
		mock.storage.getItem.mockImplementation(async (key: string) =>
			key === "pier.speech.provider" ? "service" : "yue",
		);
		const speech = await load();
		await speech.loadSpeechPreference();
		expect(speech.speechProvider()).toBe("service");

		vi.resetModules();
		mock.storage.getItem.mockResolvedValue("bogus");
		const invalid = await load();
		await invalid.loadSpeechPreference();
		expect(invalid.speechProvider()).toBe("system");

		vi.resetModules();
		let finish!: (value: string) => void;
		mock.storage.getItem.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
		const late = await load();
		const loading = late.loadSpeechPreference();
		await late.setSpeechProvider("system");
		finish("service");
		await loading;
		expect(late.speechProvider()).toBe("system");
	});

	it("normalizes device locales for recognizers", async () => {
		const { normalizeSpeechLanguage } = await load();
		expect(normalizeSpeechLanguage("zh-Hans-CN")).toBe("zh-CN");
		expect(normalizeSpeechLanguage("zh_CN")).toBe("zh-CN");
		expect(normalizeSpeechLanguage("zh-Hant-TW")).toBe("zh-TW");
		expect(normalizeSpeechLanguage("zh-HK-u-nu-latn")).toBe("zh-TW");
		expect(normalizeSpeechLanguage("en-US-u-hc-h23")).toBe("en-US");
		expect(normalizeSpeechLanguage("ja")).toBe("ja");
		expect(normalizeSpeechLanguage("")).toBe("zh-CN");
	});
});

describe("system speech permissions", () => {
	it("sends users to the recognition service's own permissions", async () => {
		const speech = await load();
		mock.startActivity.mockResolvedValueOnce({ resultCode: 0 });
		await speech.openRecognitionServiceSettings("com.xiaomi.mibrain.speech");
		expect(mock.startActivity).toHaveBeenCalledWith("android.settings.APPLICATION_DETAILS_SETTINGS", {
			data: "package:com.xiaomi.mibrain.speech",
		});
		expect(speech.systemSpeechError({ error: "service-not-allowed", message: "" })).toContain("识别服务权限");
		mock.platform.OS = "ios";
		expect(speech.systemSpeechError({ error: "service-not-allowed", message: "" })).toContain("允许 Pier 使用语音识别");
	});

	it("asks for permission and explains a refusal", async () => {
		const fake = fakeRecognizer();
		const speech = await load(fake);
		await speech.systemSpeech.prepare(new AbortController().signal);
		fake.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
		await expect(speech.systemSpeech.prepare(new AbortController().signal)).rejects.toThrow("允许 Pier 使用麦克风");
	});

	it("points to the computer service when the phone has no recognizer", async () => {
		const speech = await load(fakeRecognizer([], ""));
		await expect(speech.systemSpeech.prepare(new AbortController().signal)).rejects.toThrow(
			"这台手机没有可用的系统语音识别服务，可在语音设置中改用电脑语音服务",
		);
	});
});

describe("live system recognition", () => {
	it("keeps listening across pauses and joins the final texts after stop", async () => {
		const fake = fakeRecognizer(["com.example.asr"], "");
		const { recording } = await listen(fake);
		expect(fake.start).toHaveBeenCalledWith(
			expect.objectContaining({
				lang: "zh-CN",
				interimResults: true,
				continuous: false,
				androidRecognitionServicePackage: "com.example.asr",
			}),
		);
		fake.emit("result", result("你好", false));
		fake.emit("result", result("你好，", true));
		fake.emit("end");
		expect(fake.start).toHaveBeenCalledTimes(2);
		fake.emit("start");
		fake.emit("result", result("今天写代码", false));
		const stopping = recording.stop();
		expect(fake.stop).toHaveBeenCalledOnce();
		fake.emit("result", result("今天写代码。", true));
		fake.emit("end");
		await expect(stopping).resolves.toEqual({ text: "你好，今天写代码。" });
		expect(fake.listening()).toBe(0);
	});

	it("joins words with spaces for languages that use them", async () => {
		const fake = fakeRecognizer();
		const { recording } = await listen(fake, "en-US");
		fake.emit("result", result("hello", true));
		fake.emit("end");
		fake.emit("start");
		const stopping = recording.stop();
		fake.emit("result", result("world", true));
		fake.emit("end");
		await expect(stopping).resolves.toEqual({ text: "hello world" });
	});

	it("ignores a late end from an earlier dictation", async () => {
		const fake = fakeRecognizer();
		const speech = await load(fake);
		const starting = speech.startSystemRecognition(new AbortController().signal, vi.fn());
		fake.emit("end");
		expect(fake.start).toHaveBeenCalledOnce();
		fake.emit("start");
		await starting;
	});

	it("restarts after silence but reports real failures", async () => {
		const fake = fakeRecognizer();
		const { onError } = await listen(fake);
		fake.emit("result", result("第一句", true));
		fake.emit("error", { error: "no-speech", message: "No speech" });
		fake.emit("end");
		expect(fake.start).toHaveBeenCalledTimes(2);
		expect(onError).not.toHaveBeenCalled();
		fake.emit("start");
		fake.emit("error", { error: "network", message: "Network error" });
		fake.emit("end");
		expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("系统语音识别需要联网，请检查网络后重试"));
		expect(fake.abort).toHaveBeenCalled();
		expect(fake.listening()).toBe(0);
	});

	it("gives up when the service keeps ending immediately", async () => {
		const fake = fakeRecognizer();
		const { onError } = await listen(fake);
		for (let i = 0; i < 3; i++) {
			fake.emit("start");
			fake.emit("end");
		}
		expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("系统语音识别没有响应，请稍后重试"));
		expect(fake.start).toHaveBeenCalledTimes(3);
	});

	it("rejects the start when the service fails before listening", async () => {
		const fake = fakeRecognizer();
		const speech = await load(fake);
		const starting = speech.startSystemRecognition(new AbortController().signal, vi.fn());
		fake.emit("error", { error: "service-not-allowed", message: "Bind failed" });
		fake.emit("end");
		await expect(starting).rejects.toThrow("识别服务没有获得麦克风授权");
		expect(fake.listening()).toBe(0);
	});

	it("starts listening after a grace period when the service sends no ready event", async () => {
		vi.useFakeTimers();
		const fake = fakeRecognizer();
		const speech = await load(fake);
		const starting = speech.startSystemRecognition(new AbortController().signal, vi.fn());
		await vi.advanceTimersByTimeAsync(1500);
		await expect(starting).resolves.toBeDefined();
	});

	it("explains a failed stop without text, and returns nothing after plain silence", async () => {
		const fake = fakeRecognizer();
		const { recording } = await listen(fake);
		const stopping = recording.stop();
		fake.emit("error", { error: "language-not-supported", message: "" });
		fake.emit("end");
		await expect(stopping).rejects.toThrow("不支持所选语言");

		const silent = fakeRecognizer();
		vi.resetModules();
		const quiet = await listen(silent);
		const stopped = quiet.recording.stop();
		silent.emit("error", { error: "no-speech", message: "" });
		silent.emit("end");
		await expect(stopped).resolves.toEqual({ text: "" });
	});

	it("keeps interim text when the service never answers a stop", async () => {
		vi.useFakeTimers();
		const fake = fakeRecognizer();
		const { recording } = await listen(fake);
		fake.emit("result", result("没说完的话", false));
		const stopping = recording.stop();
		await vi.advanceTimersByTimeAsync(8000);
		expect(fake.abort).toHaveBeenCalled();
		await expect(stopping).resolves.toEqual({ text: "没说完的话" });
	});

	it("aborts when the dictation is cancelled, including while starting", async () => {
		const fake = fakeRecognizer();
		const { recording, operation } = await listen(fake);
		const stopping = recording.stop();
		operation.abort();
		await expect(stopping).rejects.toThrow("已取消");
		expect(fake.abort).toHaveBeenCalledOnce();
		expect(fake.listening()).toBe(0);

		const pending = fakeRecognizer();
		vi.resetModules();
		const speech = await load(pending);
		const cancel = new AbortController();
		const starting = speech.startSystemRecognition(cancel.signal, vi.fn());
		cancel.abort();
		await expect(starting).rejects.toThrow("已取消");
		expect(pending.abort).toHaveBeenCalledOnce();
	});
});

describe("app configuration", () => {
	it("keeps the microphone permission that voice input needs", () => {
		const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as {
			expo: { plugins: Array<string | [string, Record<string, unknown>]> };
		};
		const options = (name: string) =>
			app.expo.plugins.find((plugin): plugin is [string, Record<string, unknown>] => plugin[0] === name)?.[1];
		// `microphonePermission: false` makes expo-image-picker remove RECORD_AUDIO from the merged manifest.
		expect(options("expo-image-picker")?.microphonePermission).not.toBe(false);
		expect(options("expo-speech-recognition")).toBeDefined();
	});
});
