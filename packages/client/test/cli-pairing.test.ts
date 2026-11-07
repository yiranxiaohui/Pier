import { encode } from "uqr";
import { afterEach, describe, expect, it } from "vitest";
import { pairingRows } from "../src/cli-pairing.ts";
import { PlainScreen, TerminalScreen } from "../src/cli-screen.ts";
import { displayWidth, setColorLevel, stripAnsi } from "../src/cli-style.ts";

// Synthetic, non-secret link with several addresses, a relay and a Unicode host name.
const pairing = {
	uri: `pier://pair?v=1&host=00000000-0000-4000-8000-000000000000&name=${encodeURIComponent("测试电脑")}&pk=${"A".repeat(43)}&addr=172.20.0.1%3A7433%2C10.88.0.203%3A7433%2C172.18.0.1%3A7433&relay=wss%3A%2F%2Frelay.example.com&code=${"B".repeat(22)}`,
	expiresAt: "2026-11-07T12:05:00.000Z",
};

function qrLines(rows: readonly string[]): string[] {
	return rows.map(stripAnsi).filter((row) => /^[ █▀▄]+$/.test(row));
}

/** Recover the modules a scanner sees (foreground white, background black). */
function decodeRows(rows: readonly string[]): boolean[][] {
	return rows.flatMap((row) => [
		Array.from(row, (char) => char === " " || char === "▄"),
		Array.from(row, (char) => char === " " || char === "▀"),
	]);
}

afterEach(() => setColorLevel(0));

describe("CLI pairing output", () => {
	it("renders every module of the exact pairing URI with an intact four-module quiet zone", () => {
		setColorLevel(3);
		const qr = encode(pairing.uri, { ecc: "M", border: 4 });
		const rows = pairingRows(pairing, 100, true);
		const lines = qrLines(rows);
		expect(lines).toHaveLength(Math.ceil(qr.size / 2));
		expect(lines.every((line) => displayWidth(line) === qr.size)).toBe(true);
		const modules = decodeRows(lines);
		expect(modules.slice(0, qr.size)).toEqual(qr.data);
		// QR dimensions are odd: the extra half-row is white, not a dark strip at the edge.
		expect(modules[qr.size]?.every((dark) => !dark)).toBe(true);
		expect(modules.slice(0, 4).every((row) => row.every((dark) => !dark))).toBe(true);
		expect(modules.slice(-5).every((row) => row.every((dark) => !dark))).toBe(true);
		expect(modules.every((row) => [...row.slice(0, 4), ...row.slice(-4)].every((dark) => !dark))).toBe(true);
		const styled = rows.filter((row) => row.startsWith("\x1b[0;97;40m"));
		expect(styled).toHaveLength(lines.length);
		expect(styled.every((row) => row.endsWith("\x1b[0m"))).toBe(true);
		expect(rows.map(stripAnsi)).toContain(pairing.uri);
		expect(rows.join("\n")).toContain("Scan with the Pier mobile app");
		expect(rows.join("\n")).toContain("/pair yes");
	});

	it("keeps the QR code when colors are disabled, without ANSI escapes", () => {
		setColorLevel(0);
		const rows = pairingRows(pairing, 100, true);
		expect(qrLines(rows).length).toBeGreaterThan(0);
		expect(rows.join("\n")).not.toContain("\x1b");
	});

	it("fits exactly, but falls back to an intact link instead of wrapping a QR code", () => {
		const { size } = encode(pairing.uri, { ecc: "M", border: 4 });
		expect(qrLines(pairingRows(pairing, size, true)).length).toBeGreaterThan(0);
		const rows = pairingRows(pairing, size - 1, true);
		expect(qrLines(rows)).toEqual([]);
		expect(rows).toContain(pairing.uri);
		expect(rows.join("\n")).toContain(`QR code needs ${size + 1} terminal columns`);
		expect(rows.join("\n")).not.toContain("Scan with");
		expect(rows.filter((row) => row !== pairing.uri).every((row) => displayWidth(row) <= size - 1)).toBe(true);
	});

	it("retains link-based pairing when the URI exceeds QR capacity", () => {
		const large = { ...pairing, uri: `${pairing.uri}&name=${"x".repeat(5000)}` };
		const rows = pairingRows(large, 100, true);
		expect(qrLines(rows)).toEqual([]);
		expect(rows).toContain(large.uri);
		expect(rows.join("\n")).toContain("Could not generate a QR code");
		expect(rows.join("\n")).toContain("/pair yes");
	});

	it("keeps piped output compact and free of QR blocks and escapes", () => {
		let output = "";
		const screen = new PlainScreen({ write: (text) => (output += text) });
		screen.commit(pairingRows(pairing, screen.width, screen.interactive));
		expect(output.split("\n")).toContain(pairing.uri);
		expect(output).toContain("Paste it into the mobile app");
		expect(output).not.toMatch(/[█▀▄]/u);
		expect(output).not.toContain("\x1b");
	});

	it("preserves QR whitespace when committed above the interactive prompt", () => {
		setColorLevel(1);
		let output = "";
		const screen = new TerminalScreen(
			{ columns: 100, write: (text) => (output += text) },
			{ line: "", getPrompt: () => "❯ ", getCursorPos: () => ({ rows: 0, cols: 2 }), prompt: () => {} },
		);
		const rows = pairingRows(pairing, screen.width, screen.interactive);
		screen.setLive(["status"]);
		screen.commit(rows);
		expect(qrLines(output.split("\n"))).toEqual(qrLines(rows));
		expect(output).toContain("/pair yes");
	});
});
