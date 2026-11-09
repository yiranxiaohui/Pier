import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, openSync, writeSync } from "node:fs";
import { parseChecksums, singleFileNames } from "../peers/ssh/release.ts";

const REPOSITORY = "https://github.com/yiranxiaohui/Pier";
export interface StandaloneRelease {
	tag: string;
	notes?: string;
	date?: string;
}

export function validateReleaseTag(tag: string): void {
	if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error("Invalid release tag");
}

async function download(url: string, signal?: AbortSignal, timeout = 600_000): Promise<Response> {
	const response = await fetch(url, {
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
	});
	if (!response.ok || !response.url.startsWith("https://"))
		throw new Error(`Release download failed (${response.status})`);
	return response;
}

export async function latestStandaloneRelease(signal?: AbortSignal): Promise<StandaloneRelease> {
	const data = (await (
		await download("https://api.github.com/repos/yiranxiaohui/Pier/releases/latest", signal, 30_000)
	).json()) as { tag_name?: unknown; body?: unknown; published_at?: unknown; draft?: boolean; prerelease?: boolean };
	if (typeof data.tag_name !== "string" || data.draft || data.prerelease) throw new Error("Invalid release metadata");
	validateReleaseTag(data.tag_name);
	if (data.tag_name.includes("-")) throw new Error("Latest release is not a stable release");
	return {
		tag: data.tag_name,
		...(typeof data.body === "string" ? { notes: data.body.slice(0, 200_000) } : {}),
		...(typeof data.published_at === "string" ? { date: data.published_at } : {}),
	};
}

export function verifyStandaloneVersion(binary: string, tag: string): void {
	const check = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 });
	if (check.status !== 0 || ![`pier ${tag.slice(1)}`, `pier-host ${tag.slice(1)}`].includes(check.stdout?.trim()))
		throw new Error("Downloaded Host version check failed");
}

/** Stream to a private staging file; never execute it until its Release checksum matches. */
export async function downloadStandaloneRelease(
	tag: string,
	binary: string,
	options: { signal?: AbortSignal; onProgress?(received: number, total?: number): void } = {},
): Promise<string> {
	validateReleaseTag(tag);
	const base = `${REPOSITORY}/releases/download/${tag}`;
	const sums = parseChecksums(await (await download(`${base}/SHA256SUMS.txt`, options.signal, 30_000)).text());
	const name = singleFileNames(tag, process.arch).find((candidate) => sums.has(candidate));
	if (!name) throw new Error("No single-binary Pier for this release and architecture");
	const checksum = sums.get(name) as string;
	const response = await download(`${base}/${name}`, options.signal);
	if (!response.body) throw new Error("Empty release download");
	const length = Number(response.headers.get("content-length"));
	const total = Number.isFinite(length) && length > 0 ? length : undefined;
	const hash = createHash("sha256");
	const fd = openSync(binary, "wx", 0o600);
	let received = 0;
	let last = 0;
	try {
		for await (const chunk of response.body) {
			hash.update(chunk);
			let offset = 0;
			while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
			received += chunk.length;
			if (Date.now() - last >= 250) {
				options.onProgress?.(received, total);
				last = Date.now();
			}
		}
	} finally {
		closeSync(fd);
	}
	if (hash.digest("hex") !== checksum) throw new Error("Release checksum mismatch; installation was kept");
	chmodSync(binary, 0o700);
	verifyStandaloneVersion(binary, tag);
	options.onProgress?.(received, total ?? received);
	return checksum;
}
