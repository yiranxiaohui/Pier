/**
 * The Android update manifest (`latest-android.json`), attached to every GitHub release by
 * `.github/workflows/release.yml` (built by `apps/mobile/scripts/android-update-manifest.mjs`).
 * Plain data and version logic only, so it can be tested without React Native.
 */

/** `releases/latest` never points at a prerelease, so prereleases are not offered to users. */
export const ANDROID_UPDATE_MANIFEST_URL =
	"https://github.com/yiranxiaohui/Pier/releases/latest/download/latest-android.json";

export interface AndroidUpdate {
	version: string;
	/** Release notes (Markdown, from CHANGELOG.md). */
	notes?: string;
	/** ISO date of the release. */
	date?: string;
	/** HTTPS download URL of the signed APK. */
	url: string;
	/** APK size in bytes. */
	size: number;
	/** Hex digests of the APK. */
	sha256: string;
	md5: string;
}

interface ParsedVersion {
	core: [number, number, number];
	pre: string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version: string): ParsedVersion | undefined {
	const match = VERSION.exec(version.trim());
	if (!match) return undefined;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		pre: match[4] ? match[4].split(".") : [],
	};
}

export function isValidVersion(version: string): boolean {
	return parseVersion(version) !== undefined;
}

/** Semver precedence: negative when `a` is older than `b`. Invalid versions sort first. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
	for (let i = 0; i < 3; i++) {
		const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
		if (diff) return Math.sign(diff);
	}
	// A prerelease is older than its final version.
	if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) return Math.sign(Number(p) - Number(q));
		if (pn !== qn) return pn ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

function field(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Validate a downloaded manifest. Throws an Error with a user-facing message. */
export function parseAndroidUpdate(value: unknown): AndroidUpdate {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("更新清单格式无效");
	const record = value as Record<string, unknown>;
	const version = field(record, "version");
	if (!version || !isValidVersion(version)) throw new Error("更新清单中的版本号无效");
	const url = field(record, "url");
	if (!url || !/^https:\/\/[^\s/]+\/\S+$/.test(url)) throw new Error("更新清单中的下载地址无效");
	const size = record.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new Error("更新清单中的文件大小无效");
	const sha256 = field(record, "sha256")?.toLowerCase();
	const md5 = field(record, "md5")?.toLowerCase();
	if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !md5 || !/^[0-9a-f]{32}$/.test(md5)) {
		throw new Error("更新清单中的校验值无效");
	}
	const notes = field(record, "notes");
	const date = field(record, "pub_date");
	return {
		version: version.replace(/^v/, ""),
		...(notes ? { notes } : {}),
		...(date ? { date } : {}),
		url,
		size,
		sha256,
		md5,
	};
}

/** File name of the downloaded APK for a version (in the app's cache). */
export function apkFileName(version: string): string {
	return `pier-${version}.apk`;
}

/** The version of a downloaded APK, from its file name. */
export function apkFileVersion(name: string): string | undefined {
	const match = /^pier-(?:mobile-)?(.+)\.apk$/.exec(name);
	return match?.[1] && isValidVersion(match[1]) ? match[1] : undefined;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
