import type { HostInfo } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	HOST_SETTINGS_PAGES,
	hostSpeaksMinor,
	pageDescribesHost,
	pageFollowsHost,
	pageIsReadOnly,
	remotePageBlocker,
} from "../src/lib/settings-target.ts";

const host = (protocolVersion: string): HostInfo => ({
	hostId: "h",
	hostName: "studio",
	version: "0.2.5",
	protocolVersion,
	platform: "linux",
	piVersion: "1.0.0",
	agentDir: "/home/me/.pi/agent",
});

describe("settings pages of the managed computer", () => {
	it("makes every settings page follow the selected computer", () => {
		for (const page of [
			"general",
			"account",
			"models",
			"workspaces",
			"extensions",
			"resources",
			"pi",
			"claude",
			"codex",
			"about",
			"remote",
			"logs",
		]) {
			expect(pageFollowsHost(page)).toBe(true);
			expect(pageIsReadOnly(page)).toBe(page === "remote" || page === "logs");
		}
		expect(pageFollowsHost("toString")).toBe(false);
	});

	it("lets the general and about pages describe a paired computer themselves", () => {
		expect(pageDescribesHost("general")).toBe(true);
		expect(pageDescribesHost("about")).toBe(true);
		for (const page of ["models", "pi", "workspaces", "logs", "toString"]) {
			expect(pageDescribesHost(page)).toBe(false);
		}
	});

	it("compares protocol versions", () => {
		expect(hostSpeaksMinor(host("1.10"), 10)).toBe(true);
		expect(hostSpeaksMinor(host("1.9"), 10)).toBe(false);
		expect(hostSpeaksMinor(host("2.0"), 15)).toBe(true);
		expect(hostSpeaksMinor(host("bogus"), 0)).toBe(false);
		expect(hostSpeaksMinor(undefined, 0)).toBe(false);
	});

	it("blocks pages a paired computer's Pier is too old to be managed remotely for", () => {
		expect(HOST_SETTINGS_PAGES.pi).toBe(15);
		expect(remotePageBlocker("models", "studio", host("1.9"))).toMatch(/studio.*版本过旧.*1\.10/);
		expect(remotePageBlocker("models", "studio", host("1.10"))).toBeUndefined();
		expect(remotePageBlocker("pi", "studio", host("1.14"))).toMatch(/1\.15/);
		expect(remotePageBlocker("pi", "studio", host("1.18"))).toBeUndefined();
		expect(remotePageBlocker("claude", "studio", host("1.22"))).toMatch(/1\.23/);
		expect(remotePageBlocker("codex", "studio", host("1.23"))).toBeUndefined();
		// The general and about pages explain compatibility on their own.
		expect(remotePageBlocker("general", "studio", host("1.0"))).toBeUndefined();
		expect(remotePageBlocker("about", "studio", host("1.0"))).toBeUndefined();
		for (const page of ["remote", "logs"]) {
			expect(remotePageBlocker(page, "studio", host("1.54"))).toMatch(/查看.*1\.55/);
			expect(remotePageBlocker(page, "studio", host("1.55"))).toBeUndefined();
		}
		expect(remotePageBlocker("workspaces", "studio", host("1.9"))).toMatch(/1\.10/);
		// Not connected yet: the connection state explains it instead.
		expect(remotePageBlocker("models", "studio", undefined)).toBeUndefined();
	});
});
