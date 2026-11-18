import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, openSync, writeSync } from "node:fs";
import { updateDownloadUrl } from "@pier/client";
import { parseChecksums, singleFileNames } from "../peers/ssh/release.ts";

const REPOSITORY = "https://github.com/yiranxiaohui/Pier";
const LATEST_RELEASE = "https://api.github.com/repos/yiranxiaohui/Pier/releases/latest";
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

export async function latestStandaloneRelease(signal?: AbortSignal, mirrorPrefix = ""): Promise<StandaloneRelease> {
	const url = mirrorPrefix
		? updateDownloadUrl(`${REPOSITORY}/releases/latest/download/latest.json`, mirrorPrefix)
		: LATEST_RELEASE;
	const data = await (await download(url, signal, 30_000)).json();
	const tag = mirrorPrefix ? `v${data.version}` : data.tag_name;
	if (typeof tag !== "string" || data.draft || data.prerelease) throw new Error("Invalid release metadata");
	validateReleaseTag(tag);
	if (tag.includes("-")) throw new Error("Latest release is not a stable release");
	const notes = mirrorPrefix ? data.notes : data.body;
	const date = mirrorPrefix ? data.pub_date : data.published_at;
	return {
		tag,
		...(typeof notes === "string" ? { notes: notes.slice(0, 200_000) } : {}),
		...(typeof date === "string" ? { date } : {}),
	};
}

/** The mirror may relay executable bytes, but only GitHub may vouch for their digest. */
async function officialAssetDigest(tag: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const release = await (await download(LATEST_RELEASE, signal, 30_000)).json();
	if (release.tag_name !== tag || release.draft || release.prerelease || !Array.isArray(release.assets)) {
		throw new Error("更新线路报告的版本与 GitHub 最新正式版不一致，请重新检查更新");
	}
	const sums = new Map<string, string>();
	for (const asset of release.assets) {
		if (
			typeof asset.name === "string" &&
			typeof asset.digest === "string" &&
			/^sha256:[a-f0-9]{64}$/.test(asset.digest)
		) {
			sums.set(asset.name, asset.digest.slice(7));
		}
	}
	return sums;
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
	options: { signal?: AbortSignal; mirrorPrefix?: string; onProgress?(received: number, total?: number): void } = {},
): Promise<string> {
	validateReleaseTag(tag);
	const base = `${REPOSITORY}/releases/download/${tag}`;
	const sums = options.mirrorPrefix
		? await officialAssetDigest(tag, options.signal)
		: parseChecksums(await (await download(`${base}/SHA256SUMS.txt`, options.signal, 30_000)).text());
	const name = singleFileNames(tag, process.arch).find((candidate) => sums.has(candidate));
	if (!name) throw new Error("No single-binary Pier for this release and architecture");
	const checksum = sums.get(name) as string;
	const response = await download(updateDownloadUrl(`${base}/${name}`, options.mirrorPrefix ?? ""), options.signal);
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
