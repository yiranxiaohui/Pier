import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Installation, updateHost } from "../src/standalone/service.ts";
import {
	BUILTIN_ROUTES,
	chooseRoute,
	downloadWithRoutes,
	fetchChecksums,
	type KeyControl,
	type Output,
	parseMirror,
	rankRoutes,
	routeOrder,
} from "../src/standalone/update-download.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pier-update-route-test-"));
	roots.push(directory);
	return directory;
}

function recorder(): Output & { lines: string[] } {
	const lines: string[] = [];
	return { lines, say: (text) => lines.push(text), warn: (text) => lines.push(`warning: ${text}`) };
}

const noKeys: KeyControl = { enabled: false, close() {} };

function respond(url: string, body: BodyInit | null, init?: ResponseInit): Response {
	const response = new Response(body, init);
	Object.defineProperty(response, "url", { value: url });
	return response;
}

/** A body that sends `bytes` and then fails, as a dropped connection does. */
function dropping(bytes: Uint8Array): ReadableStream<Uint8Array> {
	let sent = false;
	return new ReadableStream({
		pull(controller) {
			if (sent) controller.error(new Error("connection reset"));
			else controller.enqueue(bytes);
			sent = true;
		},
	});
}

function rangeStart(init?: RequestInit): number {
	const range = new Headers(init?.headers).get("range");
	return range ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0;
}

describe("pier update routes", () => {
	it("parses --mirror like install.sh", () => {
		expect(parseMirror(undefined)).toBeUndefined();
		expect(parseMirror("auto")).toBeUndefined();
		expect(parseMirror("ghfast")).toEqual(BUILTIN_ROUTES[1]);
		expect(parseMirror(" https://mirror.example/proxy// ")).toMatchObject({
			prefix: "https://mirror.example/proxy/",
		});
		expect(() => parseMirror("fast")).toThrow("Unknown mirror");
		expect(() => parseMirror("http://mirror.example")).toThrow("Invalid mirror");
		expect(() => parseMirror("https://user:pass@mirror.example")).toThrow("Invalid mirror");
		expect(routeOrder(parseMirror("gh-proxy")).map((route) => route.id)).toEqual([
			"gh-proxy",
			"github",
			"ghfast",
			"ghproxy",
		]);
		expect(routeOrder(undefined).map((route) => route.id)).toEqual(["github", "ghfast", "gh-proxy", "ghproxy"]);
	});

	it("takes checksums from GitHub first and falls back to the mirrors", async () => {
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requested.push(url);
			if (!url.startsWith("https://gh-proxy.com/")) throw new Error("unreachable");
			return respond(url, "sums");
		});
		const output = recorder();
		const sums = await fetchChecksums("https://github.com/o/r/SHA256SUMS.txt", undefined, output, "v1");
		expect(sums).toMatchObject({ text: "sums", from: { id: "gh-proxy" } });
		expect(requested).toEqual([
			"https://github.com/o/r/SHA256SUMS.txt",
			"https://ghfast.top/https://github.com/o/r/SHA256SUMS.txt",
			"https://gh-proxy.com/https://github.com/o/r/SHA256SUMS.txt",
		]);
		expect(output.lines).toEqual(["warning: GitHub did not answer, so the checksums came through GH-Proxy"]);

		requested.length = 0;
		await expect(fetchChecksums("https://github.com/o/r/S", parseMirror("ghproxy"), output, "v1")).rejects.toThrow(
			"from GitHub or through GHProxy",
		);
		expect(requested).toEqual(["https://github.com/o/r/S", "https://ghproxy.net/https://github.com/o/r/S"]);
	});

	it("ranks routes by measured speed, skipping the mirrors when GitHub is fast", async () => {
		const big = new Uint8Array(512 * 1024);
		vi.stubGlobal("fetch", async (url: string) =>
			respond(url, url.startsWith("https://ghproxy.net/") ? big : new Uint8Array(10), { status: 206 }),
		);
		const output = recorder();
		const ranked = await rankRoutes(routeOrder(undefined), "https://github.com/o/r/a", true, output);
		expect(ranked.map((route) => route.id)).toEqual(["ghproxy", "github", "ghfast", "gh-proxy"]);
		expect(output.lines.at(-1)).toMatch(/^Route speed: GitHub failed, GHFast failed, GH-Proxy failed, GHProxy \d/);

		vi.stubGlobal("fetch", async (url: string) => respond(url, big, { status: 206 }));
		const fast = recorder();
		expect(
			(await rankRoutes(routeOrder(undefined), "https://github.com/o/r/a", true, fast)).map((route) => route.id),
		).toEqual(["github", "ghfast", "gh-proxy", "ghproxy"]);
		expect(fast.lines).toEqual([expect.stringMatching(/^Route speed: GitHub /)]);
	});

	it("continues a dropped download on the next route from the bytes already received", async () => {
		const file = join(root(), "pier");
		const content = new TextEncoder().encode("0123456789abcdef");
		const requests: Array<{ url: string; from: number }> = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			const from = rangeStart(init);
			requests.push({ url, from });
			if (url.startsWith("https://github.com/")) return respond(url, dropping(content.slice(0, 6)));
			return respond(url, content.slice(from), {
				status: from ? 206 : 200,
				headers: from ? { "content-range": `bytes ${from}-${content.length - 1}/${content.length}` } : {},
			});
		});
		const output = recorder();
		await downloadWithRoutes({
			url: "https://github.com/o/r/a",
			file,
			routes: routeOrder(undefined),
			pinned: false,
			keys: noKeys,
			output,
			asset: "a",
		});
		expect(readFileSync(file, "utf8")).toBe("0123456789abcdef");
		expect(requests).toEqual([
			{ url: "https://github.com/o/r/a", from: 0 },
			{ url: "https://ghfast.top/https://github.com/o/r/a", from: 6 },
		]);
		expect(output.lines).toEqual([
			"warning: GitHub failed (connection reset); continuing through GHFast, keeping 1 KB",
		]);
	});

	it("starts over when a route ignores the range, and retries a chosen route in place", async () => {
		const file = join(root(), "pier");
		let attempt = 0;
		const requests: Array<{ url: string; from: number }> = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			requests.push({ url, from: rangeStart(init) });
			attempt += 1;
			if (attempt === 1) return respond(url, dropping(new TextEncoder().encode("par")));
			return respond(url, "complete"); // 200 without honouring the range
		});
		const output = recorder();
		await downloadWithRoutes({
			url: "https://github.com/o/r/a",
			file,
			routes: routeOrder(parseMirror("ghfast")),
			pinned: true,
			keys: noKeys,
			output,
			asset: "a",
		});
		expect(readFileSync(file, "utf8")).toBe("complete");
		expect(requests.map((request) => request.url)).toEqual([
			"https://ghfast.top/https://github.com/o/r/a",
			"https://ghfast.top/https://github.com/o/r/a",
		]);
		expect(requests[1]?.from).toBe(3);
		expect(output.lines).toEqual([
			expect.stringMatching(/^warning: GHFast failed .*; retrying, keeping/),
			"warning: GHFast cannot continue a partial download; starting over",
		]);
	});

	it("switches routes when s is pressed and stops on Ctrl+C", async () => {
		const file = join(root(), "pier");
		const keys: KeyControl = { enabled: true, close() {} };
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			requests.push(url);
			if (requests.length === 1) {
				// A stalled route: wait for the switch.
				setTimeout(() => keys.onKey?.("switch"), 10);
				return await new Promise<Response>((_, reject) =>
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				);
			}
			return respond(url, "done");
		});
		const output = recorder();
		await downloadWithRoutes({
			url: "https://github.com/o/r/a",
			file,
			routes: routeOrder(undefined),
			pinned: false,
			keys,
			output,
			asset: "a",
		});
		expect(requests).toEqual(["https://github.com/o/r/a", "https://ghfast.top/https://github.com/o/r/a"]);
		expect(output.lines).toEqual(["Switching to GHFast…"]);

		vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
			setTimeout(() => keys.onKey?.("interrupt"), 10);
			return await new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
			);
		});
		await expect(
			downloadWithRoutes({
				url: "https://github.com/o/r/a",
				file,
				routes: routeOrder(undefined),
				pinned: false,
				keys,
				output,
				asset: "a",
			}),
		).rejects.toThrow("Update interrupted");
	});
});

describe("the route menu", () => {
	function answers(...lines: Array<string | undefined>) {
		const prompts: string[] = [];
		return {
			prompts,
			ask: async (prompt: string) => {
				prompts.push(prompt);
				return lines.shift();
			},
		};
	}

	it("lists the routes and takes Enter, a number, a, or an https:// prefix", async () => {
		const output = recorder();
		const github = BUILTIN_ROUTES[0] as (typeof BUILTIN_ROUTES)[number];
		const ghfast = BUILTIN_ROUTES[1] as (typeof BUILTIN_ROUTES)[number];
		expect(await chooseRoute(answers("").ask, github, true, output)).toBe(github);
		expect(output.lines).toEqual([
			"Choose the download route:",
			"  1) GitHub    github.com  (default)",
			"  2) GHFast    ghfast.top",
			"  3) GH-Proxy  gh-proxy.com",
			"  4) GHProxy   ghproxy.net",
			"  a) Automatic: measure the routes and use the fastest",
			"  Or paste another https:// mirror prefix.",
		]);
		expect(await chooseRoute(answers(" 4 ").ask, github, true, recorder())).toBe(BUILTIN_ROUTES[3]);
		expect(await chooseRoute(answers("A").ask, ghfast, true, recorder())).toBe("auto");
		expect(await chooseRoute(answers("https://mirror.example/x/").ask, github, true, recorder())).toMatchObject({
			prefix: "https://mirror.example/x/",
		});
		expect(await chooseRoute(answers(undefined).ask, github, true, recorder())).toBeUndefined();

		const retry = recorder();
		const input = answers("9", "a", "http://insecure.example", "2");
		expect(await chooseRoute(input.ask, ghfast, false, retry)).toBe(ghfast);
		expect(input.prompts).toEqual(Array(4).fill("Route [Enter = GHFast]: "));
		expect(retry.lines.filter((line) => line.startsWith("Enter 1-4"))).toHaveLength(3);
		expect(retry.lines).not.toContain("  a) Automatic: measure the routes and use the fastest");

		const custom = {
			id: "https://mirror.example/",
			name: "https://mirror.example/",
			prefix: "https://mirror.example/",
		};
		const listed = recorder();
		expect(await chooseRoute(answers("5").ask, custom, false, listed)).toBe(custom);
		expect(listed.lines).toContain("  5) https://mirror.example/ mirror.example  (default)");
	});

	it("keeps the route chosen after s, retrying it in place", async () => {
		const file = join(root(), "pier");
		const keys: KeyControl = { enabled: true, close() {} };
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			requests.push(url);
			if (requests.length === 1) {
				setTimeout(() => keys.onKey?.("switch"), 10);
				return await new Promise<Response>((_, reject) =>
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				);
			}
			if (requests.length === 2) return respond(url, dropping(new TextEncoder().encode("pa")));
			return respond(url, "rt", { status: 206, headers: { "content-range": "bytes 2-3/4" } });
		});
		const suggested: string[] = [];
		const output = recorder();
		await downloadWithRoutes({
			url: "https://github.com/o/r/a",
			file,
			routes: routeOrder(undefined),
			pinned: false,
			keys,
			output,
			asset: "a",
			choose: async (next) => {
				suggested.push(next.id);
				return parseMirror("ghproxy");
			},
		});
		expect(readFileSync(file, "utf8")).toBe("part");
		expect(suggested).toEqual(["ghfast"]);
		expect(requests).toEqual([
			"https://github.com/o/r/a",
			"https://ghproxy.net/https://github.com/o/r/a",
			"https://ghproxy.net/https://github.com/o/r/a",
		]);
		expect(output.lines).toEqual([
			"Switching to GHProxy…",
			"warning: GHProxy failed (connection reset); retrying, keeping 1 KB",
		]);
	});
});

describe("pier update", () => {
	function installation(version: string): Installation {
		const directory = root();
		const installDir = join(directory, "prefix/share/pier");
		mkdirSync(installDir, { recursive: true });
		return {
			format: 1,
			app: "pier",
			scope: "user",
			prefix: join(directory, "prefix"),
			stateDir: join(directory, "state"),
			configHome: join(directory, "config"),
			installDir,
			binDir: join(directory, "prefix/bin"),
			serviceFile: join(directory, "config/systemd/user/pier.service"),
			version,
		};
	}

	it("finds the latest release from its checksums and stops when it is already installed", async () => {
		vi.stubEnv("XDG_CACHE_HOME", root());
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const requested: string[] = [];
		const binary = "binary";
		const sum = createHash("sha256").update(binary).digest("hex");
		vi.stubGlobal("fetch", async (url: string) => {
			requested.push(url);
			return respond(url, `${sum}  pier-v1.0.1-linux-${process.arch}\n${sum}  pier-v1.0.1-darwin-arm64.dmg\n`);
		});
		await updateHost(installation("1.0.1"), ["--mirror", "ghfast"]);
		expect(requested).toEqual(["https://github.com/yiranxiaohui/Pier/releases/latest/download/SHA256SUMS.txt"]);
	});

	it("downloads through the chosen route and rejects a corrupt file before installing", async () => {
		vi.stubEnv("XDG_CACHE_HOME", root());
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requested.push(url);
			return respond(
				url,
				url.endsWith("SHA256SUMS.txt") ? `${"f".repeat(64)}  pier-v1.0.2-linux-${process.arch}\n` : "corrupt",
			);
		});
		const config = installation("1.0.1");
		await expect(updateHost(config, ["--version", "1.0.2", "--mirror", "gh-proxy"])).rejects.toThrow(
			"checksum mismatch",
		);
		expect(requested).toEqual([
			"https://github.com/yiranxiaohui/Pier/releases/download/v1.0.2/SHA256SUMS.txt",
			`https://gh-proxy.com/https://github.com/yiranxiaohui/Pier/releases/download/v1.0.2/pier-v1.0.2-linux-${process.arch}`,
		]);
		await expect(updateHost(config, ["--mirror", "nope"])).rejects.toThrow("Unknown mirror");
	});
});
