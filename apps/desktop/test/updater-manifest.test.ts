import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../scripts/updater-manifest.mjs";

const tag = "v1.2.3";
const base = {
	version: "1.2.3",
	tag,
	repo: "owner/Pier",
	notes: "\n### Added\n\n- Things.\n",
	pubDate: "2026-09-29T00:00:00Z",
};
const bundles = [
	`pier-${tag}-linux-x64.AppImage`,
	`pier-${tag}-linux-x64.deb`,
	`pier-${tag}-linux-arm64.AppImage`,
	`pier-${tag}-linux-arm64.deb`,
	`pier-${tag}-darwin-arm64.app.tar.gz`,
	`pier-${tag}-darwin-arm64.dmg`,
	`pier-${tag}-darwin-x64.app.tar.gz`,
	`pier-${tag}-darwin-x64.dmg`,
	`pier-${tag}-windows-x64.setup.exe`,
	`pier-host-${tag}-linux-x64.tar.gz`,
	"SHA256SUMS.txt",
];
const signatures = Object.fromEntries(
	bundles.filter((name) => !/\.(dmg|txt)$|pier-host/.test(name)).map((name) => [`${name}.sig`, `sig:${name}\n`]),
);

describe("updater manifest", () => {
	it("maps every signed bundle to its updater targets", () => {
		const manifest = buildManifest({ ...base, assets: bundles, signatures });
		expect(manifest.version).toBe("1.2.3");
		expect(manifest.notes).toBe("### Added\n\n- Things.");
		expect(manifest.pub_date).toBe("2026-09-29T00:00:00Z");
		expect(Object.keys(manifest.platforms).sort()).toEqual([
			"darwin-aarch64",
			"darwin-aarch64-app",
			"darwin-x86_64",
			"darwin-x86_64-app",
			"linux-aarch64",
			"linux-aarch64-appimage",
			"linux-aarch64-deb",
			"linux-x86_64",
			"linux-x86_64-appimage",
			"linux-x86_64-deb",
			"windows-x86_64",
			"windows-x86_64-nsis",
		]);
		// The generic Linux target is the AppImage (a deb needs root to install).
		expect(manifest.platforms["linux-x86_64"]).toEqual(manifest.platforms["linux-x86_64-appimage"]);
		expect(manifest.platforms["linux-x86_64-deb"]).toEqual({
			signature: `sig:pier-${tag}-linux-x64.deb`,
			url: `https://github.com/owner/Pier/releases/download/${tag}/pier-${tag}-linux-x64.deb`,
		});
		expect(manifest.platforms["linux-aarch64"]).toEqual(manifest.platforms["linux-aarch64-appimage"]);
		expect(manifest.platforms["linux-aarch64-appimage"]).toEqual({
			signature: `sig:pier-${tag}-linux-arm64.AppImage`,
			url: `https://github.com/owner/Pier/releases/download/${tag}/pier-${tag}-linux-arm64.AppImage`,
		});
		expect(manifest.platforms["linux-aarch64-deb"]).toEqual({
			signature: `sig:pier-${tag}-linux-arm64.deb`,
			url: `https://github.com/owner/Pier/releases/download/${tag}/pier-${tag}-linux-arm64.deb`,
		});
		expect(manifest.platforms["windows-x86_64"].url).toMatch(/windows-x64\.setup\.exe$/);
	});

	it("rejects an unsigned ARM64 update even when x64 bundles are signed", () => {
		const { [`pier-${tag}-linux-arm64.AppImage.sig`]: _, ...rest } = signatures;
		expect(() => buildManifest({ ...base, assets: bundles, signatures: rest })).toThrow(/linux-arm64\.AppImage\.sig/);
	});

	it("fails when a bundle has no signature", () => {
		const { [`pier-${tag}-windows-x64.setup.exe.sig`]: _, ...rest } = signatures;
		expect(() => buildManifest({ ...base, assets: bundles, signatures: rest })).toThrow(/setup\.exe\.sig/);
	});

	it("fails when there is nothing to update to", () => {
		expect(() => buildManifest({ ...base, assets: ["SHA256SUMS.txt"], signatures: {} })).toThrow(/No updater bundles/);
	});
});

describe("updater configuration", () => {
	const conf = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json"), "utf8")) as {
		bundle: { createUpdaterArtifacts?: boolean };
		plugins: { updater: { pubkey: string; endpoints: string[] } };
	};

	it("creates signed updater artifacts and reads the latest GitHub release", () => {
		expect(conf.bundle.createUpdaterArtifacts).toBe(true);
		expect(conf.plugins.updater.endpoints).toEqual([
			"https://github.com/yiranxiaohui/Pier/releases/latest/download/latest.json",
		]);
		const pubkey = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
		expect(pubkey).toMatch(/^untrusted comment: minisign public key/);
	});
});
