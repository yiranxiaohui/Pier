import { stripVTControlCharacters } from "node:util";
import { BROWSER_PREPARATION_LOG_LIMIT, type BrowserPreparationProgress } from "@pier/protocol";

/** Do not forward repository credentials, signed URLs or terminal control sequences to the UI. */
function sanitize(text: string): string {
	return (
		stripVTControlCharacters(text)
			.replace(/\r\n?/g, "\n")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal control bytes from untrusted process output.
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
			.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, (url) =>
				url.replace(/(\/\/)[^/]*@/, "$1[redacted]@").replace(/[?#].*$/, "?[redacted]"),
			)
			.replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
			.replace(/\b((?:[\w-]*(?:token|password|secret|api[_-]?key)[\w-]*)\s*[:=]\s*)\S+/gi, "$1[redacted]")
	);
}

/** Retain a small tail and coalesce verbose package/extraction output into at most four updates per second. */
export class BrowserPreparationLog {
	private current: BrowserPreparationProgress = { stage: "checking", message: "正在检查远程浏览器环境…" };
	private logs = "";
	private pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
	private dropping = { stdout: false, stderr: false };
	private timer?: ReturnType<typeof setTimeout>;
	constructor(private readonly send: (progress: BrowserPreparationProgress) => void) {}

	private append(text: string): void {
		const cleaned = sanitize(text);
		if (cleaned) this.logs = `${this.logs}${cleaned}`.slice(-BROWSER_PREPARATION_LOG_LIMIT);
	}
	private emit(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.send({ ...this.current, logs: this.logs });
	}
	progress = (progress: BrowserPreparationProgress): void => {
		if (progress.stage !== this.current.stage || progress.message !== this.current.message)
			this.append(`${progress.message}\n`);
		this.current = progress;
		this.emit();
	};
	output = (text: string, stream: "stdout" | "stderr" = "stdout"): void => {
		// Keep partial lines private: a URL/password may be split across output chunks.
		if (this.dropping[stream]) {
			const end = text.search(/[\r\n]/);
			if (end < 0) return;
			this.dropping[stream] = false;
			text = text.slice(end + 1);
		}
		const combined = this.pending[stream] + text;
		const end = Math.max(combined.lastIndexOf("\n"), combined.lastIndexOf("\r"));
		if (end >= 0) this.append(combined.slice(0, end + 1));
		const rest = combined.slice(end + 1);
		// Drop pathological unterminated lines rather than leaking an unsanitized fragment.
		this.dropping[stream] = rest.length > 64_000;
		this.pending[stream] = this.dropping[stream] ? "" : rest;
		if (this.dropping[stream]) this.append("[过长日志行已省略]\n");
		if ((end >= 0 || this.dropping[stream]) && !this.timer) this.timer = setTimeout(() => this.emit(), 250);
	};
	flush = (): void => {
		for (const stream of ["stdout", "stderr"] as const) {
			if (this.pending[stream]) this.append(`${this.pending[stream]}\n`);
			this.pending[stream] = "";
			this.dropping[stream] = false;
		}
		this.emit();
	};
}
