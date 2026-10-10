import { describe, expect, it } from "vitest";
import { portAddress, portTarget } from "../src/lib/host-ports.ts";

describe("port mapping addresses", () => {
	it("connects to loopback for wildcard listeners and preserves specific bind addresses", () => {
		expect(portTarget("*")).toBe("127.0.0.1");
		expect(portTarget("0.0.0.0")).toBe("127.0.0.1");
		expect(portTarget("::")).toBe("::1");
		expect(portTarget("0:0:0:0:0:0:0:0")).toBe("::1");
		expect(portTarget("192.168.1.5")).toBe("192.168.1.5");
		expect(portTarget("127.0.0.53%lo")).toBe("127.0.0.53");
		expect(portTarget("::1")).toBe("::1");
	});
	it("formats IPv6 endpoints without ambiguous colons", () => {
		expect(portAddress("127.0.0.1", 3000)).toBe("127.0.0.1:3000");
		expect(portAddress("::1", 3000)).toBe("[::1]:3000");
	});
});
