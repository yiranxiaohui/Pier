import {
	type StartRecording,
	startBrowserRecording,
	VoiceInput,
	type VoicePhase,
	type VoiceRecording,
} from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import { MAX_SPEECH_BYTES } from "@pier/protocol";
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { speechProvider, startSystemRecognition, systemSpeech, useSpeechSettings } from "./system-speech.ts";

function useStartRecording(): StartRecording {
	const failure = useRef<(error: Error) => void>(() => {});
	const finishing = useRef(false);
	const recorder = useAudioRecorder(
		{ ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64_000 },
		(status) => {
			if (!finishing.current && (status.hasError || status.isFinished || status.mediaServicesDidReset)) {
				failure.current(new Error("录音已中断，请检查麦克风后重试"));
			}
		},
	);
	return useCallback<StartRecording>(
		async (signal, onError) => {
			if (Platform.OS === "web") return startBrowserRecording(signal, onError);
			const permission = await requestRecordingPermissionsAsync();
			if (!permission.granted) throw new Error("请在系统设置中允许 Pier 使用麦克风后重试");
			if (signal.aborted) throw new Error("录音已取消");
			failure.current = onError;
			finishing.current = false;
			let uri: string | null = null;
			let prepared = false;
			let stopped: Promise<void> | undefined;
			const stop = () => {
				finishing.current = true;
				stopped ??= (async () => {
					try {
						if (prepared) await recorder.stop();
					} finally {
						await setAudioModeAsync({ allowsRecording: false });
					}
				})();
				return stopped;
			};
			const removeFile = () => {
				if (uri) {
					const file = new File(uri);
					if (file.exists) file.delete();
				}
			};
			const abort = () => {
				void recording.cancel().catch(() => undefined);
			};
			const recording: VoiceRecording = {
				async stop() {
					try {
						await stop();
						uri = recorder.uri ?? uri;
						if (signal.aborted) throw new Error("录音已取消");
						if (!uri) throw new Error("录音为空，请重试");
						const file = new File(uri);
						if (!file.size || file.size > MAX_SPEECH_BYTES) throw new Error("录音为空或超过 4 MiB，请重试");
						return { data: await file.base64(), mimeType: "audio/mp4" };
					} finally {
						signal.removeEventListener("abort", abort);
						removeFile();
					}
				},
				async cancel() {
					try {
						await stop();
					} finally {
						signal.removeEventListener("abort", abort);
						removeFile();
					}
				},
			};
			try {
				await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
				if (signal.aborted) throw new Error("录音已取消");
				await recorder.prepareToRecordAsync();
				prepared = true;
				uri = recorder.uri;
				if (signal.aborted) throw new Error("录音已取消");
				recorder.record();
				signal.addEventListener("abort", abort, { once: true });
				return recording;
			} catch (error) {
				await recording.cancel().catch(() => undefined);
				throw error;
			}
		},
		[recorder],
	);
}

export function useVoiceInput(
	client: PierClient | undefined,
	scope: string,
	onText: (text: string) => void,
	onError: (message: string) => void,
) {
	const record = useStartRecording();
	const provider = speechProvider(useSpeechSettings());
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const callbacks = useRef({ onText, onError });
	callbacks.current = { onText, onError };
	const current = useRef<VoiceInput | undefined>(undefined);
	useFocusEffect(
		useCallback(
			() => () => {
				void current.current?.cancel();
			},
			[],
		),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each draft owns its microphone operation.
	useEffect(() => {
		const voice = new VoiceInput({
			client,
			deviceSpeech: provider === "system" ? systemSpeech : undefined,
			record: provider === "system" ? startSystemRecognition : record,
			onPhase: setPhase,
			onText: (text) => callbacks.current.onText(text),
			onError: (message) => callbacks.current.onError(message),
		});
		current.current = voice;
		setPhase("idle");
		const listener = AppState.addEventListener("change", (state) => {
			if (state === "background") void voice.cancel();
		});
		const off = client?.onState((state) => {
			if (provider === "service" && state !== "open") void voice.cancel();
		});
		return () => {
			voice.dispose();
			listener.remove();
			off?.();
		};
	}, [client, scope, record, provider]);
	return {
		phase,
		busy: phase !== "idle",
		start: () => void current.current?.start(),
		stop: () => void current.current?.stop(),
		cancel: () => void current.current?.cancel(),
	};
}
