import { describe, expect, it } from "vitest";
import { parseSshTarget } from "../src/lib/ssh-target.ts";

describe("parseSshTarget", () => {
	it("splits user, host and port like ssh", () => {
		expect(parseSshTarget(" 192.168.1.20 ")).toEqual({ host: "192.168.1.20" });
		expect(parseSshTarget("root@server.example.com")).toEqual({ host: "server.example.com", username: "root" });
		expect(parseSshTarget("alice@10.0.0.2:2222")).toEqual({ host: "10.0.0.2", username: "alice", port: 2222 });
		expect(parseSshTarget("[fe80::1%eth0]:22")).toEqual({ host: "fe80::1%eth0", port: 22 });
		expect(parseSshTarget("fe80::1")).toEqual({ host: "fe80::1" });
	});
});
