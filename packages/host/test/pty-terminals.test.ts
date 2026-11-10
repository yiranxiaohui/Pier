import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAIN_GRACE_MS, IXON, KILL_GRACE_MS, PtyTerminals } from "../src/pty-terminals.ts";
import type { ShellTerminalHandlers } from "../src/shell.ts";
import { type FakePtyChild, fakePtySpawn } from "./fake-pty.ts";

const XOFF = "\x13";
const XON = "\x11";

function recorder() {
	const output: string[] = [];
	const exits: (number | null)[] = [];
	const handlers: ShellTerminalHandlers = {
		output: (data) => output.push(Buffer.from(data, "base64").toString("latin1")),
		exit: (code) => exits.push(code),
	};
	return { handlers, output, exits };
}

describe("PtyTerminals (the host's own terminals)", () => {
	const dirs: string[] = [];
	const temp = () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pier-pty-")));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		vi.useRealTimers();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("starts the user's login shell in the directory with Pier's terminal variables and without the host's secrets", async () => {
		const { spawn, children } = fakePtySpawn();
		const home = temp();
		const work = temp();
		const env = {
			SHELL: "/bin/sh",
			HOME: home,
			PATH: "/usr/bin:/bin",
			USER: "someone",
			LOGNAME: "someone",
			TERM: "dumb",
			PIER_DIR: "/state",
			PIER_LOCAL_TOKEN: "local-secret",
			PIER_RELAY_TOKEN: "relay-secret",
			PI_PACKAGE_DIR: "/state/runtime/pi",
		};
		const terminals = new PtyTerminals({ spawn, version: "1.2.3", env });
		expect(terminals.terminals).toBe(true);
		const terminal = await terminals.openTerminal({ cwd: work, cols: 1, rows: 0 }, recorder().handlers);

		expect(terminal).toMatchObject({ shell: "sh", cwd: work });
		const options = children[0]?.options;
		expect(options).toMatchObject({ file: "/bin/sh", argv0: "-sh", cwd: work, cols: 2, rows: 2 });
		expect(options?.env).toEqual({
			SHELL: "/bin/sh",
			HOME: home,
			PATH: "/usr/bin:/bin",
			USER: "someone",
			LOGNAME: "someone",
			PIER_DIR: "/state",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			TERM_PROGRAM: "Pier",
			TERM_PROGRAM_VERSION: "1.2.3",
		});
	});

	it("falls back to the home directory and a working shell", async () => {
		const { spawn, children } = fakePtySpawn();
		const home = temp();
		const terminals = new PtyTerminals({
			spawn,
			version: "1",
			env: { SHELL: join(home, "missing-shell"), HOME: home },
		});
		const terminal = await terminals.openTerminal({ cwd: join(home, "gone"), cols: 80, rows: 24 }, recorder().handlers);
		expect(terminal.cwd).toBe(home);
		// The account's shell (or /bin/sh) replaces a $SHELL that does not exist.
		expect(children[0]?.options.file).not.toBe(join(home, "missing-shell"));
		expect(children[0]?.options.argv0).toBe(`-${terminal.shell}`);
		expect(children[0]?.options.env.SHELL).toBe(children[0]?.options.file);
	});

	it("streams output, forwards text and binary input and resizes", async () => {
		const { spawn, children } = fakePtySpawn();
		const r = recorder();
		const terminal = await new PtyTerminals({ spawn, version: "1", env: { SHELL: "/bin/sh" } }).openTerminal(
			{ cols: 80, rows: 24 },
			r.handlers,
		);
		const child = children[0] as FakePtyChild;
		child.options.data(new Uint8Array([104, 105, 0xff]).subarray(1));
		expect(r.output).toEqual(["i\xff"]);

		terminal.write("ls\r", false);
		terminal.write("\x1b[M\xe0!!", true);
		expect(child.writes[0]).toBe("ls\r");
		expect([...(child.writes[1] as Uint8Array)]).toEqual([0x1b, 0x5b, 0x4d, 0xe0, 0x21, 0x21]);
		terminal.resize(120.7, 1);
		expect(child.sizes).toEqual([[120, 2]]);
	});

	it("reports the exit once the last output arrived, or after a grace period", async () => {
		vi.useFakeTimers();
		const { spawn, children } = fakePtySpawn();
		const terminals = new PtyTerminals({ spawn, version: "1", env: { SHELL: "/bin/sh" } });

		const ended = recorder();
		const first = await terminals.openTerminal({ cols: 80, rows: 24 }, ended.handlers);
		const a = children[0] as FakePtyChild;
		a.finish(3);
		await vi.advanceTimersByTimeAsync(0);
		expect(ended.exits).toEqual([]);
		a.options.data(new TextEncoder().encode("bye"));
		a.options.end();
		await vi.advanceTimersByTimeAsync(0);
		expect(ended.output).toEqual(["bye"]);
		expect(ended.exits).toEqual([3]);
		expect(a.closed).toBe(true);
		// Nothing after the exit.
		a.options.data(new TextEncoder().encode("late"));
		first.write("x", false);
		first.pause(true);
		expect(ended.output).toEqual(["bye"]);
		expect(a.writes).toEqual([]);

		// A background program keeps the terminal open: the exit follows after the grace period.
		const held = recorder();
		await terminals.openTerminal({ cols: 80, rows: 24 }, held.handlers);
		const b = children[1] as FakePtyChild;
		b.finish(null);
		await vi.advanceTimersByTimeAsync(DRAIN_GRACE_MS - 1);
		expect(held.exits).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(held.exits).toEqual([null]);
		expect(b.closed).toBe(true);
		b.options.end();
		expect(held.exits).toEqual([null]);
	});

	it("pauses with XOFF only while the terminal handles XON / XOFF", async () => {
		const { spawn, children } = fakePtySpawn();
		const terminal = await new PtyTerminals({ spawn, version: "1", env: { SHELL: "/bin/sh" } }).openTerminal(
			{ cols: 80, rows: 24 },
			recorder().handlers,
		);
		const child = children[0] as FakePtyChild;
		terminal.pause(true);
		terminal.pause(true);
		terminal.pause(false);
		terminal.pause(false);
		expect(child.writes).toEqual([XOFF, XON]);

		// A full-screen program turned IXON off: it would read XOFF / XON as typed keys.
		child.writes.length = 0;
		child.flags = 0;
		terminal.pause(true);
		terminal.pause(false);
		expect(child.writes).toEqual([]);

		// It turned IXON off while paused, which restarted the output already.
		child.flags = IXON;
		terminal.pause(true);
		child.flags = 0;
		terminal.pause(false);
		expect(child.writes).toEqual([XOFF]);
	});

	it("hangs up the terminal on kill and kills a shell that does not end", async () => {
		vi.useFakeTimers();
		const { spawn, children } = fakePtySpawn();
		const terminals = new PtyTerminals({ spawn, version: "1", env: { SHELL: "/bin/sh" } });

		const quick = recorder();
		const first = await terminals.openTerminal({ cols: 80, rows: 24 }, quick.handlers);
		const a = children[0] as FakePtyChild;
		first.kill();
		first.kill();
		expect(a.signals).toEqual(["SIGHUP"]);
		expect(a.closed).toBe(true);
		a.finish(null);
		// No waiting for output after a hang-up.
		await vi.advanceTimersByTimeAsync(0);
		expect(quick.exits).toEqual([null]);
		await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
		expect(a.signals).toEqual(["SIGHUP"]);

		const stubborn = recorder();
		const second = await terminals.openTerminal({ cols: 80, rows: 24 }, stubborn.handlers);
		const b = children[1] as FakePtyChild;
		second.kill();
		await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
		expect(b.signals).toEqual(["SIGHUP", "SIGKILL"]);
		b.finish(null);
		await vi.advanceTimersByTimeAsync(0);
		expect(stubborn.exits).toEqual([null]);
	});

	it("fails to open when the shell cannot start", async () => {
		const terminals = new PtyTerminals({
			spawn: () => {
				throw new Error("ENOENT");
			},
			version: "1",
			env: { SHELL: "/bin/sh" },
		});
		await expect(terminals.openTerminal({ cols: 80, rows: 24 }, recorder().handlers)).rejects.toThrow("ENOENT");
	});
});

const bun = process.platform === "win32" ? undefined : spawnSync("bun", ["--version"], { encoding: "utf8" });
const hasBun = bun?.status === 0;

describe.skipIf(!hasBun)("PtyTerminals in Bun's pseudo-terminals", () => {
	it("runs a real login shell, pauses its output with XOFF and hangs it up", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pier-pty-real-")));
		try {
			const fixture = join(import.meta.dirname, "fixtures", "pty-terminal.ts");
			const result = JSON.parse(
				execFileSync("bun", [fixture, dir], {
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, SHELL: "/bin/sh", PIER_LOCAL_TOKEN: "x" },
				}),
			);
			expect(result).toMatchObject({
				supported: true,
				shell: "sh",
				cwd: dir,
				exit: { code: 5 },
				killed: { code: null },
			});
			expect(result.output).toContain("[Pier 9.9.9 xterm-256color]");
			expect(result.output).toMatch(/30 100\r\n/);
			expect(result.output).toContain(`${dir}\r\n`);
			expect(result.grewWhilePaused).toBe(0);
			expect(result.grewAfterResume).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
