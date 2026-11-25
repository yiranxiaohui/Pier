import type { DeviceSpeech, RecognizedText, StartRecording, VoiceRecording } from "@pier/chat-state";
import { MAX_SPEECH_SECONDS } from "@pier/protocol";
import { requireOptionalNativeModule } from "expo";
import { startActivityAsync } from "expo-intent-launcher";
import type {
	ExpoSpeechRecognitionErrorEvent,
	ExpoSpeechRecognitionNativeEventMap,
	ExpoSpeechRecognitionOptions,
} from "expo-speech-recognition";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { getItem, setItem } from "./storage.ts";

type EventMap = ExpoSpeechRecognitionNativeEventMap;

/** The parts of the `expo-speech-recognition` native module Pier uses. */
export interface Recognizer {
	start(options: ExpoSpeechRecognitionOptions): void;
	stop(): void;
	abort(): void;
	requestPermissionsAsync(): Promise<{ granted: boolean }>;
	getSpeechRecognitionServices(): string[];
	getDefaultRecognitionService(): { packageName: string };
	addListener<E extends keyof EventMap>(event: E, listener: (event: EventMap[E]) => void): { remove(): void };
}

export type SpeechProvider = "system" | "service";
export type SystemSpeechSupport =
	| {
			available: true;
			/** Android recognition service package that will handle requests. */
			servicePackage?: string;
			/** Bind `servicePackage` explicitly because the phone has no usable default service. */
			bindService?: boolean;
	  }
	| { available: false; reason: string };

export const SYSTEM_SPEECH_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "", label: "跟随系统" },
	{ value: "zh-CN", label: "普通话（简体）" },
	{ value: "zh-TW", label: "普通话（繁体）" },
	{ value: "yue", label: "粤语" },
	{ value: "en-US", label: "英语" },
	{ value: "ja-JP", label: "日语" },
];

const PROVIDER_KEY = "pier.speech.provider";
const LANGUAGE_KEY = "pier.speech.language";
/** Ends without results this soon after starting mean the service is refusing work. */
const QUICK_END_MS = 1000;
const MAX_QUICK_ENDS = 3;
/** Treat a request as listening if it has not failed by then, even without a ready event. */
const READY_GRACE_MS = 1500;
const STOP_TIMEOUT_MS = 8000;
const BENIGN_ERRORS = new Set(["no-speech", "speech-timeout"]);

let native: Recognizer | null | undefined;

function recognizer(): Recognizer | null {
	if (native === undefined) {
		try {
			native =
				Platform.OS === "android" || Platform.OS === "ios"
					? requireOptionalNativeModule<Recognizer>("ExpoSpeechRecognition")
					: null;
		} catch {
			native = null;
		}
	}
	return native;
}

function detectSupport(): SystemSpeechSupport {
	const speech = recognizer();
	if (!speech) return { available: false, reason: "当前版本的 Pier 不支持手机系统语音识别" };
	if (Platform.OS !== "android") return { available: true };
	try {
		const services = speech.getSpeechRecognitionServices();
		if (!services.length) return { available: false, reason: "这台手机没有可用的系统语音识别服务" };
		const preferred = speech.getDefaultRecognitionService().packageName;
		return services.includes(preferred)
			? { available: true, servicePackage: preferred }
			: { available: true, servicePackage: services[0], bindService: true };
	} catch {
		return { available: false, reason: "无法读取这台手机的系统语音识别服务" };
	}
}

interface State {
	/** Undefined until the user chooses: the system recognizer is used when available. */
	provider?: SpeechProvider;
	language: string;
	support: SystemSpeechSupport;
}

let state: State | undefined;
let revision = 0;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function current(): State {
	state ??= { language: "", support: detectSupport() };
	return state;
}

function update(next: Partial<State>): void {
	state = { ...current(), ...next };
	for (const listener of listeners) listener();
}

/** Restore this phone's choice without replacing one made while storage was being read. */
export function loadSpeechPreference(): Promise<void> {
	loading ??= (async () => {
		const startedAt = revision;
		try {
			const [provider, language] = await Promise.all([getItem(PROVIDER_KEY), getItem(LANGUAGE_KEY)]);
			if (revision !== startedAt) return;
			update({
				provider: provider === "system" || provider === "service" ? provider : undefined,
				language: SYSTEM_SPEECH_LANGUAGES.some((option) => option.value === language) ? (language ?? "") : "",
			});
		} catch {
			// Storage can be unavailable; the defaults still work.
		}
	})();
	return loading;
}

export async function setSpeechProvider(provider: SpeechProvider): Promise<void> {
	revision++;
	update({ provider });
	await setItem(PROVIDER_KEY, provider);
}

export async function setSystemSpeechLanguage(language: string): Promise<void> {
	revision++;
	update({ language });
	await setItem(LANGUAGE_KEY, language);
}

/** Look again for recognition services, e.g. after the user installed one. */
export function refreshSystemSpeechSupport(): SystemSpeechSupport {
	const support = detectSupport();
	update({ support });
	return support;
}

export function speechProvider(settings: Pick<State, "provider" | "support"> = current()): SpeechProvider {
	return settings.support.available && settings.provider !== "service" ? "system" : "service";
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useSpeechSettings(): State {
	useEffect(() => {
		void loadSpeechPreference();
	}, []);
	return useSyncExternalStore(subscribe, current);
}

/** A BCP 47 tag recognizers understand, from a device locale such as `zh-Hans-CN` or `en_US`. */
export function normalizeSpeechLanguage(locale: string): string {
	const parts: string[] = [];
	for (const part of locale.replace(/_/g, "-").split("-")) {
		if (part.length <= 1) break; // Unicode extensions (`-u-…`) carry no language information.
		parts.push(part);
	}
	const language = parts[0]?.toLowerCase();
	if (!language || !/^[a-z]{2,3}$/.test(language)) return "zh-CN";
	const rest = parts.slice(1);
	const script = rest.find((part) => /^[a-z]{4}$/i.test(part))?.toLowerCase();
	const region = rest.find((part) => /^([a-z]{2}|\d{3})$/i.test(part))?.toUpperCase();
	if (language === "zh") {
		return script === "hant" || region === "TW" || region === "HK" || region === "MO" ? "zh-TW" : "zh-CN";
	}
	return region ? `${language}-${region}` : language;
}

function recognitionLanguage(language: string): string {
	// Android services name Cantonese yue-Hant-HK; Apple's recognizer calls it zh-HK.
	if (language === "yue") return Platform.OS === "ios" ? "zh-HK" : "yue-Hant-HK";
	if (language) return language;
	let locale = "";
	try {
		locale = Intl.DateTimeFormat().resolvedOptions().locale;
	} catch {
		// Fall back to Mandarin below.
	}
	return normalizeSpeechLanguage(locale);
}

export function systemSpeechError(event: Pick<ExpoSpeechRecognitionErrorEvent, "error" | "message">): string {
	switch (event.error) {
		case "not-allowed":
			return "请在系统设置中允许 Pier 使用麦克风和语音识别后重试";
		case "service-not-allowed":
			// Android's ERROR_INSUFFICIENT_PERMISSIONS: usually the recognition service itself (for example
			// Xiaomi's 系统语音引擎, which is not granted the microphone by default) may not record.
			return Platform.OS === "android"
				? "识别服务没有获得麦克风授权：请在语音设置中点「识别服务权限」，允许它使用麦克风后重试，也可以改用电脑语音服务"
				: "系统语音识别被限制，请在系统设置中允许 Pier 使用语音识别后重试";
		case "network":
			return "系统语音识别需要联网，请检查网络后重试";
		case "language-not-supported":
			return "系统语音识别不支持所选语言，请在语音设置中更换识别语言";
		case "audio-capture":
			return "无法使用麦克风，请检查是否被其他应用占用";
		case "busy":
			return "系统语音识别正忙，请稍后重试";
		case "interrupted":
			return "录音被来电或其他应用打断，请重试";
		default:
			return `系统语音识别失败（${event.error}${event.message ? `：${event.message}` : ""}）`;
	}
}

/**
 * One dictation with the phone's recognizer. Recognizers end a request at the first pause, so
 * requests are chained until the user stops, and their final texts are joined.
 */
class LiveRecognition implements VoiceRecording<RecognizedText> {
	private readonly finals: string[] = [];
	private partial = "";
	/** The current request has produced events (older requests can still deliver a late `end`). */
	private begun = false;
	private heard = false;
	private startedAt = 0;
	private quickEnds = 0;
	private error?: ExpoSpeechRecognitionErrorEvent;
	private closed = false;
	private ready?: { resolve: () => void; reject: (error: Error) => void };
	private stopping?: { resolve: (result: RecognizedText) => void; reject: (error: Error) => void };
	private timer?: ReturnType<typeof setTimeout>;
	private readonly subscriptions: Array<{ remove(): void }> = [];
	private readonly abort = () => void this.cancel();

	constructor(
		private readonly speech: Recognizer,
		private readonly options: ExpoSpeechRecognitionOptions,
		private readonly signal: AbortSignal,
		private readonly onError: (error: Error) => void,
	) {}

	begin(): Promise<VoiceRecording<RecognizedText>> {
		const on = <E extends keyof EventMap>(event: E, listener: (event: EventMap[E]) => void) =>
			this.subscriptions.push(this.speech.addListener(event, listener));
		on("start", () => {
			this.markBegun();
			this.markReady();
		});
		on("audiostart", () => this.markBegun());
		on("result", (event) => this.onResult(event));
		on("error", (event) => {
			if (event.error === "aborted") return;
			this.markBegun();
			this.error = event;
		});
		on("end", () => this.onEnd());
		this.signal.addEventListener("abort", this.abort, { once: true });
		return new Promise<VoiceRecording<RecognizedText>>((resolve, reject) => {
			this.ready = { resolve: () => resolve(this), reject };
			this.timer = setTimeout(() => this.markReady(), READY_GRACE_MS);
			this.request();
		});
	}

	stop(): Promise<RecognizedText> {
		if (this.closed) return Promise.reject(new Error("语音输入已结束"));
		return new Promise<RecognizedText>((resolve, reject) => {
			this.stopping = { resolve, reject };
			// Some services never answer a stop; keep what was already recognized.
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				this.speech.abort();
				this.finish();
			}, STOP_TIMEOUT_MS);
			this.speech.stop();
		});
	}

	async cancel(): Promise<void> {
		if (this.closed) return;
		this.close();
		this.speech.abort();
		this.ready?.reject(new Error("语音输入已取消"));
		this.stopping?.reject(new Error("语音输入已取消"));
	}

	private request(): void {
		this.begun = false;
		this.heard = false;
		this.error = undefined;
		this.startedAt = Date.now();
		try {
			this.speech.start(this.options);
		} catch (error) {
			this.fail(new Error(systemSpeechError({ error: "client", message: String(error) })));
		}
	}

	private markBegun(): void {
		this.begun = true;
	}

	private onResult(event: EventMap["result"]): void {
		this.markBegun();
		const text = event.results[0]?.transcript.trim() ?? "";
		if (text) this.heard = true;
		if (event.isFinal) {
			if (text) this.finals.push(text);
			this.partial = "";
		} else {
			this.partial = text;
		}
	}

	private markReady(): void {
		const ready = this.ready;
		if (!ready) return;
		this.ready = undefined;
		clearTimeout(this.timer);
		ready.resolve();
	}

	/** Keep interim text when a request ends without a final result, e.g. when the network drops. */
	private keepPartial(): void {
		if (this.partial) this.finals.push(this.partial);
		this.partial = "";
	}

	private onEnd(): void {
		if (this.closed || !this.begun) return;
		this.keepPartial();
		const fatal = this.error && !BENIGN_ERRORS.has(this.error.error) ? this.error : undefined;
		if (this.stopping) {
			this.finish(fatal);
			return;
		}
		if (fatal) {
			this.fail(new Error(systemSpeechError(fatal)));
			return;
		}
		this.quickEnds = !this.heard && Date.now() - this.startedAt < QUICK_END_MS ? this.quickEnds + 1 : 0;
		if (this.quickEnds >= MAX_QUICK_ENDS) {
			this.fail(new Error("系统语音识别没有响应，请稍后重试"));
			return;
		}
		this.request();
	}

	private text(): string {
		const cjk = /^(zh|ja|yue)/i.test(this.options.lang ?? "");
		return this.finals.join(cjk ? "" : " ");
	}

	private finish(fatal?: ExpoSpeechRecognitionErrorEvent): void {
		const stopping = this.stopping;
		this.keepPartial();
		const text = this.text();
		this.close();
		if (!text && fatal) stopping?.reject(new Error(systemSpeechError(fatal)));
		else stopping?.resolve({ text });
	}

	/** Report a failure while listening; `VoiceInput` then cancels this recording. */
	private fail(error: Error): void {
		if (this.closed) return;
		const ready = this.ready;
		this.close();
		this.speech.abort();
		if (ready) ready.reject(error);
		else this.onError(error);
	}

	private close(): void {
		this.closed = true;
		clearTimeout(this.timer);
		this.signal.removeEventListener("abort", this.abort);
		for (const subscription of this.subscriptions.splice(0)) subscription.remove();
	}
}

function availableRecognizer(): { speech: Recognizer; support: SystemSpeechSupport & { available: true } } {
	const speech = recognizer();
	const support = current().support;
	if (!speech || !support.available) {
		throw new Error(
			`${support.available ? "当前版本的 Pier 不支持手机系统语音识别" : support.reason}，可在语音设置中改用电脑语音服务`,
		);
	}
	return { speech, support };
}

/** Open the recognition service's Android app page, where its own microphone permission is granted. */
export async function openRecognitionServiceSettings(servicePackage: string): Promise<void> {
	await startActivityAsync("android.settings.APPLICATION_DETAILS_SETTINGS", { data: `package:${servicePackage}` });
}

export const startSystemRecognition: StartRecording<RecognizedText> = async (signal, onError) => {
	const { speech, support } = availableRecognizer();
	if (signal.aborted) throw new Error("语音输入已取消");
	const options: ExpoSpeechRecognitionOptions = {
		lang: recognitionLanguage(current().language),
		interimResults: true,
		maxAlternatives: 1,
		continuous: false,
		addsPunctuation: true,
		...(support.bindService ? { androidRecognitionServicePackage: support.servicePackage } : {}),
	};
	return new LiveRecognition(speech, options, signal, onError).begin();
};

export const systemSpeech: DeviceSpeech = {
	maxSeconds: MAX_SPEECH_SECONDS,
	async prepare(signal) {
		const { speech } = availableRecognizer();
		const permission = await speech.requestPermissionsAsync();
		if (signal.aborted) return;
		if (!permission.granted) throw new Error("请在系统设置中允许 Pier 使用麦克风和语音识别后重试");
	},
};
