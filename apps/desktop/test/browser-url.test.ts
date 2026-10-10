import { describe, expect, it } from "vitest";
import { remoteServiceUrl } from "../src/lib/browser-url.ts";

describe("remote conversation service links", () => {
	it("recognizes loopback URLs and normalizes listener addresses without losing the path", () => {
		for (const host of ["localhost", "127.0.0.1", "[::1]"])
			expect(remoteServiceUrl(`http://${host}:5173/app?q=1#view`)).toBe(`http://${host}:5173/app?q=1#view`);
		expect(remoteServiceUrl("http://0.0.0.0:3000/")).toBe("http://127.0.0.1:3000/");
		expect(remoteServiceUrl("https://[::]:8443/")).toBe("https://[::1]:8443/");
	});
	it("leaves regular web links, misleading host names and credentials outside automatic forwarding", () => {
		for (const url of [
			"https://example.com",
			"https://localhost.example.com",
			"https://localhost@evil.example",
			"https://user:pass@localhost",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"localhost:3000",
		])
			expect(remoteServiceUrl(url)).toBeUndefined();
	});
});
