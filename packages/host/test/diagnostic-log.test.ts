import { describe, expect, it } from "vitest";
import { DiagnosticLog } from "../src/diagnostic-log.ts";

describe("host diagnostic log", () => {
	it("keeps a bounded tail and returns independent snapshots", () => {
		const log = new DiagnosticLog();
		for (let i = 0; i < 2100; i++) log.append(`line ${i}`);
		const lines = log.read();
		expect(lines).toHaveLength(2000);
		expect(lines[0]).toBe("line 100");
		expect(lines.at(-1)).toBe("line 2099");
		lines.push("not in buffer");
		expect(log.read()).toHaveLength(2000);
		for (let i = 0; i < 100; i++) log.append("x".repeat(5000));
		expect(log.read().join("").length).toBeLessThanOrEqual(256_000);
		expect(log.read().every((line) => line.length <= 4097)).toBe(true);
	});

	it("sanitizes credentials and controls before retention, including oversized lines", () => {
		const log = new DiagnosticLog();
		log.append("\u001b[31mfailed\u001b[0m\r\nhttps://user:pass@host/path?token=query-secret#fragment");
		log.append('Bearer bearer-secret\nBasic basic-secret\n{"api_key":"json-secret"}\npassword="two words"');
		log.append(`secret=${"long-secret".repeat(10_000)}`);
		const text = log.read().join("\n");
		expect(text).toContain("failed\nhttps://[redacted]@host/path?[redacted]");
		expect(text).toContain("[过长日志已省略]");
		expect(text).not.toContain("\u001b");
		expect(text).not.toMatch(
			/user:pass|query-secret|fragment|bearer-secret|basic-secret|json-secret|two words|long-secret/,
		);
	});
});
