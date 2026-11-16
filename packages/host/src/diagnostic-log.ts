import { stripVTControlCharacters } from "node:util";

/** In-memory process diagnostics, not session contents or arbitrary log files. */
export class DiagnosticLog {
	private lines: string[] = [];
	private size = 0;

	append(message: string): void {
		// Do not retain a fragment of an oversized credential/URL before redacting it.
		if (message.length > 64_000) message = "[过长日志已省略]";
		const sanitized = stripVTControlCharacters(message)
			.replace(/\r\n?/g, "\n")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip untrusted terminal control bytes.
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
			.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, (url) =>
				url.replace(/(\/\/)[^/]*@/, "$1[redacted]@").replace(/[?#].*$/, "?[redacted]"),
			)
			.replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
			.replace(/\b([\w-]*(?:token|password|secret|api[_-]?key)[\w-]*["']?\s*[:=]\s*)[^\n,}]+/gi, "$1[redacted]");
		for (const line of sanitized.split("\n")) {
			if (!line) continue;
			const bounded = line.length > 4096 ? `${line.slice(0, 4096)}…` : line;
			this.lines.push(bounded);
			this.size += bounded.length;
			while (this.lines.length > 2000 || this.size > 256_000) this.size -= this.lines.shift()?.length ?? 0;
		}
	}

	read(): string[] {
		return [...this.lines];
	}
}
