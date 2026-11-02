import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkHostKey,
	hostKeyFingerprint,
	hostKeyType,
	knownHostKeyTypes,
	knownHostName,
	rememberHostKey,
} from "../src/peers/ssh/known-hosts.ts";
import { parseChecksums, singleFileNames } from "../src/peers/ssh/release.ts";
import { compareVersions, installedHelper, parseFacts, planRemote } from "../src/peers/ssh/remote.ts";
import { shellQuote } from "../src/peers/ssh/session.ts";

function publicBlob(): Buffer {
	const { public: text } = utils.generateKeyPairSync("ed25519");
	return Buffer.from(text.trim().split(/\s+/)[1] as string, "base64");
}

describe("known_hosts", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function file(text: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pier-known-"));
		dirs.push(dir);
		const path = join(dir, "known_hosts");
		writeFileSync(path, text);
		return path;
	}

	it("names hosts like OpenSSH and fingerprints keys like ssh-keygen", () => {
		expect(knownHostName("Example.com", 22)).toBe("example.com");
		expect(knownHostName("10.0.0.1", 2222)).toBe("[10.0.0.1]:2222");
		expect(knownHostName("[::1]", 2200)).toBe("[::1]:2200");
		const key = publicBlob();
		expect(hostKeyType(key)).toBe("ssh-ed25519");
		expect(hostKeyFingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
	});

	it("matches plain, wildcard and hashed entries and detects changed keys", () => {
		const key = publicBlob();
		const other = publicBlob();
		const salt = Buffer.from("0123456789abcdef0123");
		const hashed = `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("[srv.lan]:2222").digest("base64")}`;
		const known = file(
			[
				"# comment",
				`a.example.com,b.example.com ssh-ed25519 ${key.toString("base64")}`,
				`*.wild.example ssh-ed25519 ${key.toString("base64")}`,
				`${hashed} ssh-ed25519 ${key.toString("base64")}`,
				`changed.example ssh-ed25519 ${other.toString("base64")}`,
				`changed.example ssh-rsa AAAAB3NzaC1yc2E=`,
				`@revoked revoked.example ssh-ed25519 ${key.toString("base64")}`,
				`@cert-authority *.example ssh-ed25519 ${other.toString("base64")}`,
			].join("\n"),
		);
		expect(checkHostKey([known], "b.example.com", key)).toEqual({ status: "known" });
		expect(checkHostKey([known], "x.wild.example", key)).toEqual({ status: "known" });
		expect(checkHostKey([known], "[srv.lan]:2222", key)).toEqual({ status: "known" });
		expect(checkHostKey([known], "srv.lan", key)).toEqual({ status: "unknown" });
		expect(checkHostKey([known], "changed.example", key)).toEqual({ status: "mismatch", file: known });
		expect(checkHostKey([known], "revoked.example", key)).toEqual({ status: "revoked", file: known });
		expect(checkHostKey([known, "/nonexistent/known_hosts"], "new.example", key)).toEqual({ status: "unknown" });
		expect(knownHostKeyTypes([known], "changed.example")).toEqual(["ssh-ed25519", "ssh-rsa"]);
	});

	it("remembers accepted keys in Pier's own file", () => {
		const key = publicBlob();
		const known = file("other ssh-ed25519 AAAA");
		rememberHostKey(known, "[10.0.0.9]:2222", key);
		expect(readFileSync(known, "utf8")).toBe(
			`other ssh-ed25519 AAAA\n[10.0.0.9]:2222 ssh-ed25519 ${key.toString("base64")}\n`,
		);
		expect(checkHostKey([known], "[10.0.0.9]:2222", key)).toEqual({ status: "known" });
	});
});

describe("remote plan", () => {
	const base = [
		"os=Linux",
		"arch=aarch64",
		"uid=1000",
		"user=alice",
		"home=/home/alice",
		"tool=curl",
		"tool=systemctl",
		"systemd=1",
		"state=/home/alice/.pier",
	];
	it("parses the detection output", () => {
		const facts = parseFacts(
			[
				...base,
				"installed=/home/alice/.local/share/pier/current/pier",
				"installedVersion=pier 0.2.50",
				"linger=no",
				"runningPid=42",
				"runningVersion=0.2.50",
				"freeKb=1000000",
				"end=1",
			].join("\n"),
		);
		expect(facts).toMatchObject({
			os: "Linux",
			arch: "arm64",
			supportedArch: true,
			uid: 1000,
			systemd: true,
			installed: { path: "/home/alice/.local/share/pier/current/pier", version: "0.2.50" },
			linger: "no",
			running: { pid: 42, version: "0.2.50" },
			freeKb: 1_000_000,
		});
		expect(facts.tools.has("curl")).toBe(true);
		expect(() => parseFacts(base.join("\n"))).toThrow();
		expect(parseFacts(["os=Linux", "arch=riscv64", "end=1"].join("\n")).supportedArch).toBe(false);
	});

	it("installs, upgrades, starts or only pairs", () => {
		const facts = (lines: string[]) => parseFacts([...base, ...lines, "end=1"].join("\n"));
		const installed = ["installed=/x/current/pier", "installedVersion=pier 0.2.57"];
		const old = ["installed=/x/current/pier", "installedVersion=pier 0.2.50"];
		const running = ["runningPid=7", "runningVersion=0.2.50"];
		expect(planRemote(facts([]), "0.2.57")).toEqual({ kind: "install", upgrade: false });
		expect(planRemote(facts(old), "0.2.57")).toEqual({ kind: "install", upgrade: true });
		expect(planRemote(facts(installed), "0.2.57")).toEqual({ kind: "start" });
		expect(planRemote(facts([...installed, ...running]), "0.2.57")).toEqual({ kind: "existing" });
		expect(planRemote(facts([...old, ...running]), "0.2.57")).toEqual({ kind: "install", upgrade: true });
		// The desktop app or a manual `pier run`: leave it alone.
		expect(planRemote(facts(running), "0.2.57")).toEqual({ kind: "existing" });
		const noSystemd = parseFacts([...base.filter((l) => l !== "systemd=1"), ...old, ...running, "end=1"].join("\n"));
		expect(planRemote(noSystemd, "0.2.57")).toEqual({ kind: "existing" });
		expect(installedHelper(facts(installed), "0.2.57")).toBe(true);
		expect(installedHelper(facts(old), "0.2.57")).toBe(false);
	});

	it("compares versions", () => {
		expect(compareVersions("0.2.57", "0.2.57")).toBe(0);
		expect(compareVersions("0.2.9", "0.2.10")).toBe(-1);
		expect(compareVersions("0.3.0", "0.2.99")).toBe(1);
		expect(compareVersions("0.2.57-beta.1", "0.2.57")).toBe(-1);
	});
});

describe("release assets and quoting", () => {
	it("prefers the unified single file", () => {
		expect(singleFileNames("v0.2.57", "x64")).toEqual(["pier-v0.2.57-linux-x64", "pier-host-v0.2.57-linux-x64"]);
		const sums = parseChecksums(`${"a".repeat(64)}  pier-v1-linux-x64\n${"B".repeat(64)} *other\nbad line\n`);
		expect(sums.get("pier-v1-linux-x64")).toBe("a".repeat(64));
		expect(sums.get("other")).toBe("b".repeat(64));
	});

	it("quotes for sh", () => {
		expect(shellQuote("a b'c")).toBe(`'a b'\\''c'`);
	});
});
