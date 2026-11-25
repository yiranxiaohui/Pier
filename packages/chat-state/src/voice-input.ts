import type { PierClient } from "@pier/client";
import { MAX_SPEECH_SECONDS, parseProtocolVersion, type SpeechAudio } from "@pier/protocol";

export type VoicePhase = "idle" | "preparing" | "recording" | "transcribing" | "cancelling";
export type AudioClip = Omit<SpeechAudio, "id">;
/** Text from a recognizer that listens live, so there is no audio left to transcribe. */
export interface RecognizedText {
	text: string;
}
export type RecordingResult = AudioClip | RecognizedText;
export interface VoiceRecording<Result extends RecordingResult = RecordingResult> {
	stop(): Promise<Result>;
	cancel(): Promise<void>;
}
export type StartRecording<Result extends RecordingResult = RecordingResult> = (
	signal: AbortSignal,
	onError: (error: Error) => void,
) => Promise<VoiceRecording<Result>>;
/** Recognition on the device running the UI, independent of the connected Host. */
export interface DeviceSpeech {
	prepare(signal: AbortSignal): Promise<void>;
	/** Omitted when the recording itself returns recognized text. */
	transcribe?(clip: AudioClip, signal: AbortSignal): Promise<string>;
	maxSeconds?: number;
}
export const VOICE_LABELS: Record<VoicePhase, string> = {
	idle: "语音输入",
	preparing: "正在准备麦克风…",
	recording: "正在录音，点击停止并识别",
	transcribing: "正在识别…",
	cancelling: "正在取消…",
};

export function requireSpeechClient(client: PierClient | undefined): PierClient {
	if (client?.state !== "open") throw new Error("请先连接到电脑");
	const version = parseProtocolVersion(client.host?.protocolVersion ?? "");
	if (version?.major !== 1 || version.minor < 46) throw new Error("语音输入需要更新电脑上的 Pier（协议 1.46+）");
	return client;
}

/** Append to the latest draft, including text edited while recognition was in flight. */
export function appendDictation(draft: string, text: string): string {
	const clean = text.replace(/[\uE000\uE001]/g, "").trim();
	return clean ? `${draft}${draft && !/\s$/.test(draft) ? "\n" : ""}${clean}` : draft;
}

/** Owns one microphone/transcription operation. Cancelled and disposed results are ignored. */
export class VoiceInput {
	phase: VoicePhase = "idle";
	private operation?: AbortController;
	private recording?: VoiceRecording;
	private preparing?: Promise<VoiceRecording>;
	private requestId?: string;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	constructor(
		private readonly options: {
			client: PierClient | undefined;
			deviceSpeech?: DeviceSpeech;
			record: StartRecording;
			onPhase: (phase: VoicePhase) => void;
			onText: (text: string) => void;
			onError: (message: string) => void;
		},
	) {}

	private setPhase(phase: VoicePhase): void {
		this.phase = phase;
		if (!this.disposed) this.options.onPhase(phase);
	}

	async start(): Promise<void> {
		if (this.disposed || this.phase !== "idle") return;
		const operation = new AbortController();
		this.operation = operation;
		this.setPhase("preparing");
		try {
			if (this.options.deviceSpeech) {
				await this.options.deviceSpeech.prepare(operation.signal);
			} else {
				const client = requireSpeechClient(this.options.client);
				const status = await client.request("speech.status");
				if (operation.signal.aborted) return;
				if (!status.configured) throw new Error("请先打开语音设置，填写语音转文字服务的地址与模型");
			}
			if (operation.signal.aborted) return;
			const preparing = this.options.record(operation.signal, (error) => {
				if (!operation.signal.aborted) {
					this.options.onError(error.message);
					void this.cancel();
				}
			});
			this.preparing = preparing;
			const recording = await preparing;
			if (this.preparing === preparing) this.preparing = undefined;
			if (operation.signal.aborted) {
				await recording.cancel();
				return;
			}
			this.recording = recording;
			this.setPhase("recording");
			this.timer = setTimeout(
				() => void this.stop(),
				(this.options.deviceSpeech?.maxSeconds ?? MAX_SPEECH_SECONDS) * 1000,
			);
		} catch (error) {
			if (!operation.signal.aborted) {
				this.options.onError(error instanceof Error ? error.message : "无法开始录音");
				await this.cancel();
			}
		}
	}

	async stop(): Promise<void> {
		const operation = this.operation;
		const recording = this.recording;
		if (this.phase !== "recording" || !recording || !operation) return;
		clearTimeout(this.timer);
		this.setPhase("transcribing");
		try {
			const clip = await recording.stop();
			if (operation.signal.aborted) return;
			this.recording = undefined;
			let text: string;
			if ("text" in clip) {
				text = clip.text;
			} else if (this.options.deviceSpeech) {
				if (!this.options.deviceSpeech.transcribe) throw new Error("语音识别失败");
				text = await this.options.deviceSpeech.transcribe(clip, operation.signal);
			} else {
				const client = requireSpeechClient(this.options.client);
				this.requestId = `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				const result = await client.request(
					"speech.transcribe",
					{ ...clip, id: this.requestId },
					{ timeoutMs: 70_000 },
				);
				text = result.text;
			}
			if (operation.signal.aborted) return;
			if (!text.trim()) throw new Error("没有识别到文字，请重新录音");
			this.options.onText(text);
		} catch (error) {
			if (!operation.signal.aborted) this.options.onError(error instanceof Error ? error.message : "语音识别失败");
		} finally {
			if (this.operation === operation && !operation.signal.aborted) await this.cancel();
		}
	}

	async cancel(): Promise<void> {
		const operation = this.operation;
		if (!operation || operation.signal.aborted) return;
		operation.abort();
		clearTimeout(this.timer);
		this.setPhase("cancelling");
		const recording = this.recording;
		this.recording = undefined;
		const preparing = this.preparing;
		this.preparing = undefined;
		const id = this.requestId;
		this.requestId = undefined;
		if (id && this.options.client?.state === "open") {
			void this.options.client.request("speech.cancel", { id }).catch(() => undefined);
		}
		await recording?.cancel().catch(() => undefined);
		if (preparing)
			await preparing
				.then(
					(capture) => capture.cancel(),
					() => undefined,
				)
				.catch(() => undefined);
		if (this.operation === operation) {
			this.operation = undefined;
			this.setPhase("idle");
		}
	}

	dispose(): void {
		this.disposed = true;
		void this.cancel();
	}
}
