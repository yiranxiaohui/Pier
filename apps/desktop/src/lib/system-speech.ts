import type { DeviceSpeech } from "@pier/chat-state";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type SpeechProvider = "system" | "service";
const PROVIDER_KEY = "pier.speech.provider";
const LANGUAGE_KEY = "pier.speech.systemLanguage";
const WHISPER_KEY = "pier.speech.whisper";
const listeners = new Set<() => void>();

export function systemSpeechPlatform(): "macos" | "windows" | "linux" | undefined {
	if (!isTauri() || typeof navigator === "undefined") return;
	if (/Mac/.test(navigator.platform)) return "macos";
	if (/Win/.test(navigator.platform)) return "windows";
	if (/Linux/.test(navigator.platform)) return "linux";
}

export function supportsSystemSpeech(): boolean {
	return systemSpeechPlatform() !== undefined;
}

export function speechProvider(): SpeechProvider {
	return supportsSystemSpeech() && localStorage.getItem(PROVIDER_KEY) !== "service" ? "system" : "service";
}

export function setSpeechProvider(provider: SpeechProvider): void {
	localStorage.setItem(PROVIDER_KEY, provider);
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useSpeechProvider(): SpeechProvider {
	return useSyncExternalStore(subscribe, speechProvider);
}

export function systemSpeechLanguage(): string {
	return localStorage.getItem(LANGUAGE_KEY) ?? "";
}

export function setSystemSpeechLanguage(language: string): void {
	localStorage.setItem(LANGUAGE_KEY, language);
}

export function whisperSettings(): { executable: string; model: string } {
	try {
		const saved = JSON.parse(localStorage.getItem(WHISPER_KEY) ?? "null");
		return {
			executable: typeof saved?.executable === "string" ? saved.executable : "whisper-cli",
			model: typeof saved?.model === "string" ? saved.model : "",
		};
	} catch {
		return { executable: "whisper-cli", model: "" };
	}
}

export function setWhisperSettings(settings: ReturnType<typeof whisperSettings>): void {
	localStorage.setItem(WHISPER_KEY, JSON.stringify(settings));
}

function nativeOptions() {
	return {
		language: systemSpeechLanguage(),
		...(systemSpeechPlatform() === "linux" ? whisperSettings() : {}),
	};
}

export const systemSpeech = {
	// Apple's online recognition limits a request to one minute.
	get maxSeconds() {
		return systemSpeechPlatform() === "macos" ? 60 : 120;
	},
	async prepare(signal) {
		if (signal.aborted) return;
		await invoke("system_speech_authorize", nativeOptions()).catch((error: unknown) => {
			throw new Error(String(error));
		});
	},
	async transcribe(clip, signal) {
		if (signal.aborted) throw new Error("语音输入已取消");
		const mac = systemSpeechPlatform() === "macos";
		if (clip.mimeType !== (mac ? "audio/mp4" : "audio/wav")) {
			throw new Error(mac ? "系统语音识别需要 MPEG-4 录音，请更新 macOS 后重试" : "本机语音识别需要 PCM WAV 录音");
		}
		const id = crypto.randomUUID();
		return new Promise<string>((resolve, reject) => {
			const finish = (text: string, error?: string | null) => {
				signal.removeEventListener("abort", abort);
				if (error) reject(new Error(error));
				else resolve(text);
			};
			const output = new Channel<{ text: string; error?: string | null }>(({ text, error }) => finish(text, error));
			const started = invoke<void>("system_speech_transcribe", {
				id,
				data: clip.data,
				...nativeOptions(),
				output,
			});
			const abort = () => {
				finish("", "语音输入已取消");
				// Wait for the native job to be registered before cancelling, including rapid session switches.
				void started.then(() => invoke("system_speech_cancel", { id })).catch(() => undefined);
			};
			signal.addEventListener("abort", abort, { once: true });
			void started.catch((error: unknown) => finish("", String(error)));
		});
	},
} satisfies DeviceSpeech;
