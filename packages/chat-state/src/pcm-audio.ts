import { MAX_SPEECH_BYTES } from "@pier/protocol";
import type { AudioClip, StartRecording } from "./voice-input.ts";

const SAMPLE_RATE = 16_000;

/** Mono PCM16 WAV is accepted by both Windows Speech and whisper.cpp. */
export function encodeSpeechWav(samples: Float32Array, sampleRate: number): Uint8Array {
	const length = Math.floor((samples.length * SAMPLE_RATE) / sampleRate);
	const bytes = new Uint8Array(44 + length * 2);
	const view = new DataView(bytes.buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	text(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, length * 2, true);
	// Average the input over each output sample, including fractional boundaries.
	// This preserves duration at 44.1 kHz as well as 48 kHz and reduces aliasing.
	const ratio = sampleRate / SAMPLE_RATE;
	for (let i = 0; i < length; i++) {
		const start = i * ratio;
		const end = Math.min((i + 1) * ratio, samples.length);
		let total = 0;
		for (let j = Math.floor(start); j < end; j++) {
			total += (samples[j] ?? 0) * (Math.min(j + 1, end) - Math.max(j, start));
		}
		const value = Math.max(-1, Math.min(1, total / (end - start)));
		view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
	}
	return bytes;
}

/** Capture PCM without depending on a WebView's MediaRecorder codec support. */
export const startPcmRecording: StartRecording<AudioClip> = async (signal, onError) => {
	if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
		throw new Error("当前环境无法录音，请更新系统或使用自定义语音服务");
	}
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
	} catch (error) {
		throw new Error(
			error instanceof Error && error.name === "NotAllowedError"
				? "麦克风权限被拒绝，请在系统设置中允许 Pier 使用麦克风"
				: "无法访问麦克风，请检查设备是否连接或被占用",
		);
	}
	let context: AudioContext | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let processor: ScriptProcessorNode | undefined;
	let mute: GainNode | undefined;
	let closing: Promise<void> | undefined;
	let stopped = false;
	let size = 0;
	let failure: Error | undefined;
	const chunks: Float32Array[] = [];
	const cleanup = () => {
		stopped = true;
		signal.removeEventListener("abort", abort);
		if (processor) processor.onaudioprocess = null;
		source?.disconnect();
		processor?.disconnect();
		mute?.disconnect();
		for (const track of stream.getTracks()) track.stop();
		closing ??= context?.close().catch(() => undefined) ?? Promise.resolve();
		return closing;
	};
	const abort = () => {
		chunks.length = 0;
		void cleanup();
	};
	const fail = (message: string) => {
		if (stopped) return;
		failure = new Error(message);
		void cleanup();
		onError(failure);
	};
	try {
		if (signal.aborted) throw new Error("录音已取消");
		context = new AudioContext();
		const sampleRate = context.sampleRate;
		source = context.createMediaStreamSource(stream);
		// ScriptProcessor is supported by WebView2 and WebKitGTK, including older
		// supported distributions. AudioWorklet requires an additional secure module URL.
		processor = context.createScriptProcessor(4096, 1, 1);
		mute = context.createGain();
		mute.gain.value = 0;
		processor.onaudioprocess = ({ inputBuffer }) => {
			if (stopped) return;
			const samples = inputBuffer.getChannelData(0);
			size += samples.length;
			if (44 + Math.floor((size * SAMPLE_RATE) / sampleRate) * 2 > MAX_SPEECH_BYTES) {
				fail("录音超过 4 MiB，请缩短录音后重试");
			} else chunks.push(new Float32Array(samples));
		};
		for (const track of stream.getTracks()) track.onended = () => fail("麦克风连接已断开");
		context.onstatechange = () => {
			if (context?.state === "suspended" || context?.state === "closed") fail("录音已中断，请重试");
		};
		source.connect(processor);
		processor.connect(mute);
		mute.connect(context.destination);
		signal.addEventListener("abort", abort, { once: true });
		await context.resume();
		if (signal.aborted) throw new Error("录音已取消");
		return {
			async stop() {
				await cleanup();
				if (failure) throw failure;
				if (signal.aborted) throw new Error("录音已取消");
				if (!chunks.length) throw new Error("录音为空，请重试");
				const samples = new Float32Array(size);
				let offset = 0;
				for (const chunk of chunks) {
					samples.set(chunk, offset);
					offset += chunk.length;
				}
				chunks.length = 0;
				const bytes = encodeSpeechWav(samples, sampleRate);
				let binary = "";
				for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
				return { data: btoa(binary), mimeType: "audio/wav" };
			},
			async cancel() {
				chunks.length = 0;
				await cleanup();
			},
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
};
