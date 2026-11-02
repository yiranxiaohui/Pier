import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAndroidManifest } from "../scripts/android-update-manifest.mjs";
import {
	ANDROID_UPDATE_MANIFEST_URL,
	apkFileName,
	apkFileVersion,
	compareVersions,
	parseAndroidUpdate,
} from "../src/update-manifest.ts";

const apk = new TextEncoder().encode("not really an apk");
const manifest = buildAndroidManifest({
	apkName: "pier-v1.2.3-android.apk",
	apk,
	version: "1.2.3",
	tag: "v1.2.3",
	repo: "owner/Pier",
	notes: "\n### 新增\n\n- 应用内更新。\n",
	pubDate: "2026-10-01T00:00:00Z",
});

describe("android update manifest", () => {
	it("describes the release APK", () => {
		expect(manifest).toEqual({
			version: "1.2.3",
			notes: "### 新增\n\n- 应用内更新。",
			pub_date: "2026-10-01T00:00:00Z",
			url: "https://github.com/owner/Pier/releases/download/v1.2.3/pier-v1.2.3-android.apk",
			size: apk.length,
			sha256: createHash("sha256").update(apk).digest("hex"),
			md5: createHash("md5").update(apk).digest("hex"),
		});
	});

	it("rejects unexpected or empty APKs", () => {
		const base = { apk, version: "1.2.3", tag: "v1.2.3", repo: "o/P", notes: "", pubDate: "" };
		expect(() => buildAndroidManifest({ ...base, apkName: "app-release.apk" })).toThrow(/Unexpected APK name/);
		expect(() => buildAndroidManifest({ ...base, apkName: "pier-v1.2.3-android.apk", apk: new Uint8Array() })).toThrow(
			/empty/,
		);
	});

	it("is read by the app", () => {
		const update = parseAndroidUpdate(JSON.parse(JSON.stringify(manifest)));
		expect(update).toEqual({
			version: "1.2.3",
			notes: manifest.notes,
			date: manifest.pub_date,
			url: manifest.url,
			size: manifest.size,
			sha256: manifest.sha256,
			md5: manifest.md5,
		});
		expect(ANDROID_UPDATE_MANIFEST_URL).toMatch(/\/releases\/latest\/download\/latest-android\.json$/);
	});

	it("rejects invalid manifests", () => {
		const bad = [
			null,
			[],
			{ ...manifest, version: "1.2" },
			{ ...manifest, url: "http://example.com/pier.apk" },
			{ ...manifest, url: undefined },
			{ ...manifest, size: 0 },
			{ ...manifest, size: "12" },
			{ ...manifest, sha256: "abc" },
			{ ...manifest, md5: undefined },
		];
		for (const value of bad) expect(() => parseAndroidUpdate(value)).toThrow();
		const minimal = parseAndroidUpdate({ ...manifest, notes: "  ", pub_date: undefined, version: "v1.2.4" });
		expect(minimal.version).toBe("1.2.4");
		expect(minimal.notes).toBeUndefined();
		expect(minimal.date).toBeUndefined();
	});
});

describe("versions", () => {
	it("orders versions by semver precedence", () => {
		const ordered = ["0.2.9", "0.2.15", "0.10.0-rc.1", "0.10.0-rc.2", "0.10.0-rc.10", "0.10.0", "1.0.0-alpha", "1.0.0"];
		for (let i = 0; i < ordered.length - 1; i++) {
			const [a, b] = [ordered[i] as string, ordered[i + 1] as string];
			expect(compareVersions(a, b), `${a} < ${b}`).toBeLessThan(0);
			expect(compareVersions(b, a), `${b} > ${a}`).toBeGreaterThan(0);
		}
		expect(compareVersions("0.2.15", "v0.2.15")).toBe(0);
		expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
		expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
		expect(compareVersions("garbage", "0.0.1")).toBeLessThan(0);
	});

	it("names downloaded APKs by version", () => {
		expect(apkFileName("0.2.16")).toBe("pier-0.2.16.apk");
		expect(apkFileVersion("pier-mobile-0.2.16.apk")).toBe("0.2.16");
		expect(apkFileVersion(apkFileName("0.2.16"))).toBe("0.2.16");
		expect(apkFileVersion(apkFileName("1.0.0-rc.1"))).toBe("1.0.0-rc.1");
		expect(apkFileVersion("pier-mobile-latest.apk")).toBeUndefined();
		expect(apkFileVersion("other.apk")).toBeUndefined();
	});
});
