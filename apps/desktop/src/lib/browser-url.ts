/** Loopback links in a remote conversation refer to that conversation's computer. */
export function remoteServiceUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
		if (!["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"].includes(url.hostname.toLowerCase())) return undefined;
		if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
		if (url.hostname === "[::]") url.hostname = "[::1]";
		return url.href;
	} catch {
		return undefined;
	}
}
