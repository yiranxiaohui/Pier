import { MAX_SPEECH_BYTES } from "@pier/protocol";
import type { AudioClip, StartRecording } from "./voice-input.ts";

const FORMATS = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

export const startBrowserRecording: StartRecording<AudioClip> = (signal, onError) =>
	recordBrowserAudio(signal, onError);

/** Apple Speech reads MPEG-4 audio; modern WebKit can also offer WebM, so choose explicitly. */
export const startSystemSpeechRecording: StartRecording<AudioClip> = (signal, onError) =>
	recordBrowserAudio(signal, onError, ["audio/mp4"]);

async function recordBrowserAudio(
	signal: AbortSignal,
	onError: (error: Error) => void,
	formats?: string[],
): ReturnType<StartRecording<AudioClip>> {
	if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
		throw new Error("当前环境无法录音，请使用支持麦克风的 Pier 客户端或 HTTPS / localhost 浏览器");
	}
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (error) {
		throw new Error(
			error instanceof Error && error.name === "NotAllowedError"
				? "麦克风权限被拒绝，请在系统或浏览器设置中允许 Pier 使用麦克风"
				: "无法访问麦克风，请检查设备是否连接或被占用",
		);
	}
	const release = () => {
		for (const track of stream.getTracks()) track.stop();
	};
	if (signal.aborted) {
		release();
		throw new Error("录音已取消");
	}
	const mimeType = (formats ?? FORMATS).find((type) => MediaRecorder.isTypeSupported(type));
	if (formats && !mimeType) {
		release();
		throw new Error("当前环境不支持所需录音格式，请更新系统或切换自定义语音服务");
	}
	let recorder: MediaRecorder;
	try {
		recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined);
	} catch {
		release();
		throw new Error("当前环境不支持录音格式");
	}
	let cancelled = false;
	let stopping = false;
	let size = 0;
	let failure: Error | undefined;
	const chunks: Blob[] = [];
	let finished!: () => void;
	const done = new Promise<void>((resolve) => {
		finished = resolve;
	});
	const cleanup = () => {
		release();
		signal.removeEventListener("abort", abort);
	};
	const stop = () => {
		stopping = true;
		if (recorder.state !== "inactive") recorder.stop();
		else {
			cleanup();
			finished();
		}
	};
	const abort = () => {
		cancelled = true;
		stop();
		release();
	};
	signal.addEventListener("abort", abort, { once: true });
	const fail = (message: string) => {
		if (cancelled || failure) return;
		failure = new Error(message);
		onError(failure);
		stop();
	};
	recorder.ondataavailable = ({ data }) => {
		if (cancelled || failure) return;
		size += data.size;
		if (size > MAX_SPEECH_BYTES) fail("录音超过 4 MiB，请缩短录音后重试");
		else if (data.size) chunks.push(data);
	};
	recorder.onerror = () => fail("录音中断，请检查麦克风后重试");
	recorder.onstop = () => {
		cleanup();
		finished();
		if (!stopping) fail("录音已中断，请重试");
	};
	for (const track of stream.getTracks())
		track.onended = () => {
			if (!stopping) fail("麦克风连接已断开");
		};
	try {
		recorder.start(1000);
	} catch {
		cleanup();
		throw new Error("无法开始录音，请检查麦克风权限");
	}
	return {
		async stop() {
			stop();
			await done;
			if (failure) throw failure;
			if (cancelled) throw new Error("录音已取消");
			const type = recorder.mimeType.split(";")[0] as AudioClip["mimeType"];
			if (!["audio/webm", "audio/mp4", "audio/wav", "audio/ogg", "audio/mpeg"].includes(type))
				throw new Error("录音格式不受支持");
			const blob = new Blob(chunks, { type });
			chunks.length = 0;
			if (!blob.size) throw new Error("录音为空，请重试");
			const data = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
				reader.onerror = () => reject(new Error("无法读取录音"));
				reader.readAsDataURL(blob);
			});
			return { data, mimeType: type };
		},
		async cancel() {
			abort();
			await done;
			chunks.length = 0;
		},
	};
}
