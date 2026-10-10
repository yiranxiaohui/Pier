import { createSocket } from "node:dgram";
import { type AddressInfo, createServer } from "node:net";
import { endianness } from "node:os";
import { describe, expect, it } from "vitest";
import { HostPortSampler, parseLsof, parseProcSockets, parseSs, parseWindowsPorts } from "../src/ports/listening.ts";

describe("listening port discovery", () => {
	it("reads TCP/UDP, IPv4/IPv6 and optional process information from ss", () => {
		expect(
			parseSs(
				[
					'udp UNCONN 0 0 127.0.0.53:53 0.0.0.0:* users:(("systemd-resolve",pid=750,fd=14))',
					'tcp LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=42,fd=20))',
					"tcp LISTEN 0 128 [::1]:8080 [::]:*",
					"tcp LISTEN 0 128 *:22 *:*",
					"tcp ESTAB 0 0 127.0.0.1:55000 127.0.0.1:3000",
					"garbage",
				].join("\n"),
			),
		).toEqual([
			{ protocol: "udp", address: "127.0.0.53", port: 53, process: "systemd-resolve", pid: 750 },
			{ protocol: "tcp", address: "0.0.0.0", port: 3000, process: "node", pid: 42 },
			{ protocol: "tcp", address: "::1", port: 8080 },
			{ protocol: "tcp", address: "*", port: 22 },
		]);
	});

	it("reads macOS lsof fields without losing names with spaces or connected UDP peers", () => {
		const text = "p42\ncGoogle Chrome\nf10\nn[::1]:9222\nf11\nn*:3000\np53\ncDNS\nf12\nn127.0.0.1:53->8.8.8.8:53\n";
		expect(parseLsof(text, "tcp")).toEqual([
			{ protocol: "tcp", address: "::1", port: 9222, pid: 42, process: "Google Chrome" },
			{ protocol: "tcp", address: "*", port: 3000, pid: 42, process: "Google Chrome" },
		]);
	});

	it("preserves the address family of IPv6-only wildcard listeners", () => {
		expect(parseSs("tcp LISTEN 0 128 *:3000 *:*", "::")[0]?.address).toBe("::");
		expect(parseSs("tcp LISTEN 0 128 *:3000 *:*", "0.0.0.0")[0]?.address).toBe("0.0.0.0");
		expect(parseLsof("p42\ncnode\nf10\ntIPv6\nn*:3000\nf11\ntIPv4\nn*:3001", "tcp")).toEqual([
			{ protocol: "tcp", address: "::", port: 3000, pid: 42, process: "node" },
			{ protocol: "tcp", address: "0.0.0.0", port: 3001, pid: 42, process: "node" },
		]);
	});

	it("decodes /proc addresses in native byte order and excludes connected sockets", () => {
		const v4 = endianness() === "LE" ? "0100007F" : "7F000001";
		const v6 = endianness() === "LE" ? "00000000000000000000000001000000" : "00000000000000000000000000000001";
		expect(parseProcSockets(`0: ${v4}:0BB8 00000000:0000 0A\n1: ${v4}:C350 00000000:0BB8 01`, "tcp")).toEqual([
			{ protocol: "tcp", address: "127.0.0.1", port: 3000 },
		]);
		expect(parseProcSockets(`0: ${v6}:0035 00000000000000000000000000000000:0000 07`, "udp")).toEqual([
			{ protocol: "udp", address: "0:0:0:0:0:0:0:1", port: 53 },
		]);
	});

	it("reads Windows structured output including singleton and empty results", () => {
		expect(parseWindowsPorts('{"protocol":"tcp","address":"::","port":8080,"pid":4,"process":"System"}')).toEqual([
			{ protocol: "tcp", address: "::", port: 8080, pid: 4, process: "System" },
		]);
		expect(parseWindowsPorts("[]")).toEqual([]);
		expect(
			parseWindowsPorts(
				'[{"protocol":"udp","address":"0.0.0.0","port":53},{"protocol":"tcp","address":"x","port":70000}]',
			),
		).toEqual([{ protocol: "udp", address: "0.0.0.0", port: 53 }]);
	});

	it("discovers real TCP and UDP listeners and shares concurrent samples", async () => {
		const server = createServer();
		const udp = createSocket("udp4");
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
		try {
			const sampler = new HostPortSampler();
			const sample = sampler.sample();
			expect(sampler.sample()).toBe(sample);
			const result = await sample;
			expect(result.ports).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						protocol: "tcp",
						address: "127.0.0.1",
						port: (server.address() as AddressInfo).port,
					}),
					expect.objectContaining({ protocol: "udp", address: "127.0.0.1", port: udp.address().port }),
				]),
			);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			udp.close();
		}
	});
});
