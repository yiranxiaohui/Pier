/**
 * Download routes for `pier update`, matching `scripts/install.sh`: GitHub itself or a GitHub
 * acceleration mirror that receives the full GitHub URL as its path.
 *
 * - In a terminal without `--mirror`, a menu asks for the route (`chooseRoute`).
 * - `auto` (`--mirror auto`, or no terminal) uses GitHub when it is fast, otherwise starts
 *   with the fastest mirror, and moves to the next route when one fails or stays too slow.
 * - A chosen route (from the menu, `--mirror ghfast`, an `https://` prefix, ...) comes first
 *   and retries in place.
 * - Pressing `s` while downloading in a terminal asks for another route. Every switch
 *   continues from the bytes already downloaded when the route supports ranges.
 * - Checksums come from GitHub whenever it answers, so a mirror only relays the file.
 */
import { closeSync, existsSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { normalizeUpdateMirror } from "@pier/client";

export interface Route {
	/** `github`, a built-in mirror id, or a custom `https://` prefix ending in `/`. */
	id: string;
	name: string;
	/** Empty for GitHub. */
	prefix: string;
}

export const BUILTIN_ROUTES: readonly Route[] = [
	{ id: "github", name: "GitHub", prefix: "" },
	{ id: "ghfast", name: "GHFast", prefix: "https://ghfast.top/" },
	{ id: "gh-proxy", name: "GH-Proxy", prefix: "https://gh-proxy.com/" },
	{ id: "ghproxy", name: "GHProxy", prefix: "https://ghproxy.net/" },
];

export const MIRROR_CHOICES = "auto, github, ghfast, gh-proxy, ghproxy or an https:// prefix";

/** The route chosen by `--mirror` / `PIER_MIRROR`; `undefined` for `auto`. */
export function parseMirror(option: string | undefined): Route | undefined {
	const value = option?.trim() ?? "";
	if (value === "" || value === "auto") return undefined;
	const builtin = BUILTIN_ROUTES.find((route) => route.id === value);
	if (builtin) return builtin;
	if (!value.includes("://")) throw new Error(`Unknown mirror: ${value} (use ${MIRROR_CHOICES})`);
	let prefix: string;
	try {
		prefix = normalizeUpdateMirror(value);
	} catch {
		throw new Error(`Invalid mirror: ${value} (an https:// prefix without credentials, query or fragment)`);
	}
	return { id: prefix, name: prefix, prefix };
}

/** The pinned route first, then the other built-in routes in their order. */
export function routeOrder(pinned: Route | undefined): Route[] {
	return pinned ? [pinned, ...BUILTIN_ROUTES.filter((route) => route.id !== pinned.id)] : [...BUILTIN_ROUTES];
}

export function routeUrl(route: Route, url: string): string {
	return `${route.prefix}${url}`;
}

export function routeWhere(route: Route): string {
	return route.id === "github" ? "from GitHub" : `through ${route.name}`;
}

export function speedText(bytesPerSecond: number): string {
	if (bytesPerSecond <= 0) return "failed";
	if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
	return `${Math.ceil(bytesPerSecond / 1024)} KB/s`;
}

function megabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sizeText(bytes: number): string {
	return bytes >= 1024 * 1024 ? megabytes(bytes) : `${Math.ceil(bytes / 1024)} KB`;
}

export interface Output {
	say(text: string): void;
	warn(text: string): void;
	/** A progress line that the next line replaces; only in a terminal. */
	progress?(text: string): void;
}

function checkedResponse(response: Response, url: string): Response {
	// Redirects must stay on HTTPS (a mock or exotic runtime may leave `url` empty).
	if (response.url && !response.url.startsWith("https://")) throw new Error(`${url} redirected away from HTTPS`);
	return response;
}

/** A small file, with an overall timeout. */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
	const response = checkedResponse(
		await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) }),
		url,
	);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return await response.text();
}

/**
 * The release's `SHA256SUMS.txt`: from GitHub first (quickly, when there are other routes to
 * try), then through the mirrors (`auto`) or the chosen mirror.
 */
export async function fetchChecksums(
	url: string,
	pinned: Route | undefined,
	output: Output,
	release: string,
): Promise<{ text: string; from: Route }> {
	const github = BUILTIN_ROUTES[0] as Route;
	const routes = !pinned ? [...BUILTIN_ROUTES] : pinned.id === "github" ? [github] : [github, pinned];
	let lastError = "";
	for (const [index, route] of routes.entries()) {
		try {
			const text = await fetchText(routeUrl(route, url), index < routes.length - 1 ? 10_000 : 60_000);
			if (route.id !== "github") output.warn(`GitHub did not answer, so the checksums came through ${route.name}`);
			return { text, from: route };
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	const hint = !pinned
		? "from GitHub or its mirrors. Check the network and the version"
		: pinned.id === "github"
			? "from GitHub. Check the network and the version, or leave out --mirror github to try the mirrors"
			: `from GitHub or through ${pinned.name}`;
	throw new Error(`Could not download the checksums of ${release} ${hint} (${lastError})`);
}

/**
 * Bytes per second once data flows, over up to 4 MiB of the file, so a slow redirect or TLS
 * setup does not hide the bandwidth; 0 when less than 256 KiB arrived in `seconds`.
 */
export async function probe(url: string, seconds = 5): Promise<number> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), seconds * 1000);
	let received = 0;
	let first = 0;
	let last = 0;
	try {
		const response = checkedResponse(
			await fetch(url, {
				redirect: "follow",
				headers: { Range: "bytes=0-4194303" },
				signal: controller.signal,
			}),
			url,
		);
		if (!response.ok || !response.body) return 0;
		const reader = response.body.getReader();
		try {
			while (received < 4 * 1024 * 1024) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!first) first = performance.now();
				received += value.byteLength;
				last = performance.now();
			}
		} finally {
			void reader.cancel().catch(() => {});
		}
	} catch {
		/* Timed out or failed: measure what arrived. */
	} finally {
		clearTimeout(timer);
	}
	if (received < 256 * 1024) return 0;
	return Math.floor(received / Math.max(0.1, (last - first) / 1000));
}

/**
 * Order `routes` by measured speed. A GitHub faster than 2 MB/s is used without contacting the
 * mirrors; unusable routes stay last, in their order.
 */
export async function rankRoutes(routes: Route[], url: string, githubOk: boolean, output: Output): Promise<Route[]> {
	const speeds = new Map<string, number>();
	if (githubOk) {
		const speed = await probe(url);
		speeds.set("github", speed);
		if (speed >= 2 * 1024 * 1024) {
			output.say(`Route speed: GitHub ${speedText(speed)}`);
			return routes;
		}
	}
	output.say("Measuring the download routes…");
	await Promise.all(
		routes
			.filter((route) => route.id !== "github")
			.map(async (route) => speeds.set(route.id, await probe(routeUrl(route, url)))),
	);
	output.say(
		`Route speed: ${routes.map((route) => `${route.name} ${speedText(speeds.get(route.id) ?? 0)}`).join(", ")}`,
	);
	return routes
		.map((route, index) => ({ route, index, speed: speeds.get(route.id) ?? 0 }))
		.sort((a, b) => b.speed - a.speed || a.index - b.index)
		.map(({ route }) => route);
}

type Floor = "slow" | "stall";

/** Why a download attempt ended without the whole file. */
type Outcome =
	| { kind: "done" }
	| { kind: "switch" }
	| { kind: "restart" }
	| { kind: "failed"; reason: string; slow?: boolean };

const INTERRUPTED = "Update interrupted; nothing was changed";

/**
 * The terminal during an update: the route menu reads a line, and while a download runs, `s`
 * picks another route and Ctrl+C stops (raw mode turns Ctrl+C into a byte instead of SIGINT).
 */
export interface KeyControl {
	readonly enabled: boolean;
	/** Called with `switch` or `interrupt` while listening for keys. */
	onKey?: (key: "switch" | "interrupt") => void;
	/** Start listening for keys. */
	listen?(): void;
	/** Read a line (keys pause meanwhile); `undefined` when the terminal closed. Throws on Ctrl+C. */
	ask?(prompt: string): Promise<string | undefined>;
	close(): void;
}

function readLine(prompt: string): Promise<string | undefined> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		let buffer = "";
		const finish = (settle: () => void) => {
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			process.off("SIGINT", onInterrupt);
			stdin.pause();
			settle();
		};
		const onData = (data: Buffer) => {
			buffer += data.toString("utf8");
			const end = buffer.indexOf("\n");
			if (end >= 0) finish(() => resolve(buffer.slice(0, end).replace(/\r$/, "")));
		};
		const onEnd = () => finish(() => resolve(undefined));
		const onInterrupt = () => finish(() => reject(new Error(INTERRUPTED)));
		process.stderr.write(prompt);
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		process.once("SIGINT", onInterrupt);
		stdin.resume();
	});
}

export function terminalKeys(): KeyControl {
	const stdin = process.stdin;
	if (!stdin.isTTY || !process.stderr.isTTY || typeof stdin.setRawMode !== "function") {
		return { enabled: false, close() {} };
	}
	let raw = false;
	const listener = (data: Buffer) => {
		const text = data.toString("utf8");
		if (text.includes("\x03")) control.onKey?.("interrupt");
		else if (/[sS]/.test(text)) control.onKey?.("switch");
	};
	const enter = () => {
		if (raw) return;
		stdin.setRawMode(true);
		stdin.on("data", listener);
		stdin.resume();
		raw = true;
	};
	const leave = () => {
		if (!raw) return;
		stdin.off("data", listener);
		try {
			stdin.setRawMode(false);
		} catch {
			/* The terminal went away. */
		}
		stdin.pause();
		raw = false;
	};
	const control: KeyControl = {
		enabled: true,
		listen: enter,
		async ask(prompt) {
			const listening = raw;
			leave();
			try {
				return await readLine(prompt);
			} finally {
				if (listening) enter();
			}
		},
		close: leave,
	};
	return control;
}

function routeHost(route: Route): string {
	return route.prefix ? route.prefix.replace(/^https:\/\//, "").replace(/\/$/, "") : "github.com";
}

/**
 * Ask which route to download through, like `install.sh`: Enter takes `suggested`, a number
 * picks a listed route, `a` (when offered) measures the routes automatically, and an
 * `https://` prefix adds a mirror. `undefined` when the terminal gave no answer.
 */
export async function chooseRoute(
	ask: (prompt: string) => Promise<string | undefined>,
	suggested: Route,
	offerAuto: boolean,
	output: Output,
): Promise<Route | "auto" | undefined> {
	const menu = BUILTIN_ROUTES.some((route) => route.id === suggested.id)
		? [...BUILTIN_ROUTES]
		: [...BUILTIN_ROUTES, suggested];
	output.say("Choose the download route:");
	for (const [index, route] of menu.entries())
		output.say(
			`  ${index + 1}) ${route.name.padEnd(9)} ${routeHost(route)}${route.id === suggested.id ? "  (default)" : ""}`,
		);
	if (offerAuto) output.say("  a) Automatic: measure the routes and use the fastest");
	output.say("  Or paste another https:// mirror prefix.");
	while (true) {
		const line = await ask(`Route [Enter = ${suggested.name}]: `);
		if (line === undefined) return undefined;
		const answer = line.replace(/\s+/g, "");
		if (!answer) return suggested;
		if (/^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= menu.length)
			return menu[Number(answer) - 1] as Route;
		if (offerAuto && /^(a|auto)$/i.test(answer)) return "auto";
		if (answer.includes("://")) {
			try {
				const route = parseMirror(answer);
				if (route) return route;
			} catch {
				/* Ask again. */
			}
		}
		output.say(
			`Enter 1-${menu.length}${offerAuto ? ", a" : ""}, or an https:// prefix without credentials, query or fragment.`,
		);
	}
}

const SLOW_BYTES_PER_SECOND = 100 * 1024;
const SLOW_SECONDS = 20;
const STALL_BYTES_PER_SECOND = 1024;
const STALL_SECONDS = 60;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Continue downloading `url` into `file`. With `slow`, give up when it averages under 100 KB/s
 * for 20 s; with `stall`, under 1 KB/s for a minute.
 */
async function downloadOnce(
	url: string,
	file: string,
	floor: Floor,
	keys: KeyControl,
	report: (received: number, total: number | undefined, speed: number) => void,
	output: Output,
	routeName: string,
): Promise<Outcome> {
	const controller = new AbortController();
	let outcome: Outcome | undefined;
	const stop = (result: Outcome) => {
		outcome ??= result;
		controller.abort();
	};
	keys.onKey = (key) => {
		if (key === "switch") stop({ kind: "switch" });
		else stop({ kind: "failed", reason: INTERRUPTED });
	};
	let offset = existsSync(file) ? statSync(file).size : 0;
	const connect = setTimeout(
		() => stop({ kind: "failed", reason: "did not answer in 20 s", slow: true }),
		CONNECT_TIMEOUT_MS,
	);
	let watchdog: ReturnType<typeof setInterval> | undefined;
	let fd: number | undefined;
	try {
		const response = checkedResponse(
			await fetch(url, {
				redirect: "follow",
				headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
				signal: controller.signal,
			}),
			url,
		);
		clearTimeout(connect);
		if (offset > 0 && response.status === 416) {
			void response.body?.cancel().catch(() => {});
			return { kind: "restart" };
		}
		if (!response.ok || !response.body) return { kind: "failed", reason: `failed (HTTP ${response.status})` };
		let total: number | undefined;
		if (response.status === 206) {
			total = Number(/\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "")?.[1]) || undefined;
		} else {
			if (offset > 0) {
				output.warn(`${routeName} cannot continue a partial download; starting over`);
				offset = 0;
			}
			total = Number(response.headers.get("content-length")) || undefined;
		}
		fd = openSync(file, offset > 0 ? "a" : "w", 0o600);
		let received = offset;
		const samples: Array<[number, number]> = [[performance.now(), received]];
		const limit = floor === "slow" ? SLOW_BYTES_PER_SECOND : STALL_BYTES_PER_SECOND;
		const seconds = floor === "slow" ? SLOW_SECONDS : STALL_SECONDS;
		let speed = 0;
		watchdog = setInterval(() => {
			const now = performance.now();
			samples.push([now, received]);
			while (samples.length > 1 && now - (samples[1]?.[0] ?? now) >= seconds * 1000) samples.shift();
			const [since, from] = samples[0] as [number, number];
			const recent = samples[Math.max(0, samples.length - 4)] as [number, number];
			speed = (received - recent[1]) / Math.max(0.001, (now - recent[0]) / 1000);
			report(received, total, speed);
			if (now - since >= seconds * 1000 && (received - from) / ((now - since) / 1000) < limit)
				stop({ kind: "failed", reason: "was too slow", slow: true });
		}, 1000);
		report(received, total, 0);
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			writeSync(fd, value);
			received += value.byteLength;
		}
		report(received, total, speed);
		if (total !== undefined && received !== total)
			return { kind: "failed", reason: `ended early (${megabytes(received)} of ${megabytes(total)})` };
		return { kind: "done" };
	} catch (error) {
		if (outcome) return outcome;
		return { kind: "failed", reason: `failed (${error instanceof Error ? error.message : String(error)})` };
	} finally {
		clearTimeout(connect);
		if (watchdog) clearInterval(watchdog);
		if (fd !== undefined) closeSync(fd);
		keys.onKey = undefined;
	}
}

/**
 * Download `url` (a GitHub URL) into `file` over `routes`, as `install.sh` does: `auto` tries
 * each route quickly once and then again waiting out slow ones; a chosen route retries in
 * place. Pressing `s` asks `choose` for another route (the next one without a menu), which
 * is then kept like a route chosen by `--mirror`. Throws when every attempt failed or Ctrl+C
 * was pressed.
 */
export async function downloadWithRoutes(options: {
	url: string;
	file: string;
	routes: Route[];
	pinned: boolean;
	keys: KeyControl;
	output: Output;
	asset: string;
	/** Ask for the route after `s`, suggesting `next`; `undefined` when nobody answered. */
	choose?: (next: Route) => Promise<Route | undefined>;
}): Promise<void> {
	const { url, file, keys, output, asset, choose } = options;
	let { routes, pinned } = options;
	let count = routes.length;
	let limit = pinned ? 3 : 2 * count;
	const kept = () => {
		const bytes = existsSync(file) ? statSync(file).size : 0;
		return bytes > 0 ? `, keeping ${sizeText(bytes)}` : "";
	};
	let index = 0;
	let failures = 0;
	while (true) {
		const current = routes[index] as Route;
		const floor: Floor = !pinned && failures < count - 1 ? "slow" : "stall";
		const outcome = await downloadOnce(
			routeUrl(current, url),
			file,
			floor,
			keys,
			(received, total, speed) => {
				const size = total
					? `${megabytes(received)} / ${megabytes(total)} (${Math.floor((received / total) * 100)}%)`
					: megabytes(received);
				output.progress?.(`  ${size}  ${speedText(speed).replace("failed", "…")}  ${current.name}`);
			},
			output,
			current.name,
		);
		if (outcome.kind === "done") return;
		if (outcome.kind === "switch") {
			const next = routes[(index + 1) % count] as Route;
			const chosen = choose ? await choose(next) : undefined;
			if (chosen) {
				routes = routeOrder(chosen);
				pinned = true;
				count = routes.length;
				limit = 3;
				index = 0;
				failures = 0;
			} else {
				index = (index + 1) % count;
			}
			output.say(`Switching to ${(routes[index] as Route).name}${kept()}…`);
			continue;
		}
		if (outcome.kind === "restart") {
			output.warn(`${current.name} cannot continue a partial download; starting over`);
			rmSync(file, { force: true });
			continue;
		}
		if (outcome.reason === INTERRUPTED) throw new Error(INTERRUPTED);
		failures += 1;
		if (failures >= limit) {
			throw new Error(
				pinned
					? `Downloading ${asset} ${routeWhere(current)} ${outcome.reason}; nothing was changed. Retry and choose another route, or use --mirror auto to try every route`
					: `Downloading ${asset} failed on every route; nothing was changed. Check the network and retry`,
			);
		}
		if (!pinned) index = (index + 1) % count;
		const next = routes[index] as Route;
		output.warn(
			next === current
				? `${current.name} ${outcome.reason}; retrying${kept()}`
				: `${current.name} ${outcome.reason}; continuing through ${next.name}${kept()}`,
		);
	}
}
