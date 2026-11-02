import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { updateDownloadUrl } from "@pier/client";

export const RELEASE_REPOSITORY = "yiranxiaohui/Pier";

/** The Linux single-file Pier of a release, as listed in its `SHA256SUMS.txt`. */
export interface ReleaseAsset {
	tag: string;
	name: string;
	sha256: string;
	/** GitHub download URL (route it with `updateDownloadUrl`). */
	url: string;
}

export interface ReleaseOptions {
	mirrorPrefix?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

/** Asset names to try for `linux-<arch>`: the unified `pier`, then the older `pier-host` single file. */
export function singleFileNames(tag: string, arch: string): string[] {
	return [`pier-${tag}-linux-${arch}`, `pier-host-${tag}-linux-${arch}`];
}

export function parseChecksums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const [sum, file] = line.trim().split(/\s+/);
		if (sum && file && /^[a-f0-9]{64}$/i.test(sum)) sums.set(file.replace(/^\*/, ""), sum.toLowerCase());
	}
	return sums;
}

async function download(url: string, options: ReleaseOptions): Promise<Response> {
	const response = await (options.fetch ?? fetch)(url, {
		redirect: "follow",
		signal: options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(1_800_000)])
			: AbortSignal.timeout(1_800_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response;
}

/** Find the single-file Pier for `tag` (`vX.Y.Z`) and `arch` (`x64` / `arm64`). */
export async function findReleaseAsset(tag: string, arch: string, options: ReleaseOptions = {}): Promise<ReleaseAsset> {
	const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}`;
	let text: string;
	try {
		text = await (
			await download(updateDownloadUrl(`${base}/SHA256SUMS.txt`, options.mirrorPrefix ?? ""), {
				...options,
				signal: options.signal
					? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
					: AbortSignal.timeout(60_000),
			})
		).text();
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new Error(
			`无法获取 Pier ${tag} 的发布信息（${error instanceof Error ? error.message : String(error)}）。请确认该版本已发布，或在「关于与更新」中换一条更新线路`,
		);
	}
	const sums = parseChecksums(text);
	for (const name of singleFileNames(tag, arch)) {
		const sha256 = sums.get(name);
		if (sha256) return { tag, name, sha256, url: `${base}/${name}` };
	}
	throw new Error(`Pier ${tag} 没有 Linux ${arch} 单文件`);
}

/** SHA-256 of a file, hex. */
export async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}

/** The cached copy of `asset`, if there is one and it is intact. */
export async function verifiedCacheFile(asset: ReleaseAsset, cacheDir: string): Promise<string | undefined> {
	const file = join(cacheDir, asset.name);
	if (!existsSync(file)) return undefined;
	if ((await fileSha256(file)) === asset.sha256) return file;
	rmSync(file, { force: true });
	return undefined;
}

/** Size of a download (a `HEAD` request), when the server reports it. */
export async function releaseFileSize(url: string, options: ReleaseOptions = {}): Promise<number | undefined> {
	try {
		const response = await (options.fetch ?? fetch)(url, {
			method: "HEAD",
			redirect: "follow",
			signal: options.signal
				? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
				: AbortSignal.timeout(15_000),
		});
		const size = Number(response.headers.get("content-length"));
		return response.ok && size > 0 ? size : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Download `asset` into `cacheDir` (verified, reused next time) and return its path.
 * `onProgress` receives bytes so far and the total when known.
 */
export async function cachedReleaseFile(
	asset: ReleaseAsset,
	cacheDir: string,
	options: ReleaseOptions & { onProgress?(received: number, total?: number): void } = {},
): Promise<string> {
	const file = join(cacheDir, asset.name);
	if (await verifiedCacheFile(asset, cacheDir)) return file;
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	const partial = `${file}.part`;
	const response = await download(updateDownloadUrl(asset.url, options.mirrorPrefix ?? ""), options);
	if (!response.body) throw new Error("下载内容为空");
	const total = Number(response.headers.get("content-length")) || undefined;
	let received = 0;
	let last = 0;
	const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
	body.on("data", (chunk: Buffer) => {
		received += chunk.length;
		if (received - last >= 1024 * 1024 || received === total) {
			last = received;
			options.onProgress?.(received, total);
		}
	});
	try {
		await pipeline(body, createWriteStream(partial, { mode: 0o600 }));
		if ((await fileSha256(partial)) !== asset.sha256) throw new Error(`${asset.name} 校验失败`);
		renameSync(partial, file);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	}
	return file;
}

export function fileSize(path: string): number {
	return statSync(path).size;
}
