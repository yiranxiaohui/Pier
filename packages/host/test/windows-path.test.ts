import { describe, expect, it } from "vitest";
import {
	appendWindowsPath,
	expandWindowsVariables,
	parseWindowsEnvironment,
	readWindowsEnvironment,
	refreshWindowsPath,
	type WindowsEnvironment,
	windowsRegistryPath,
} from "../src/windows-path.ts";

const encoded = (value: unknown) =>
	`__PIER_ENVIRONMENT__${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}`;

describe("the user's PATH on Windows", () => {
	it("reads the registry script's output, whatever the console code page", () => {
		const output = `noise\r\n${encoded({
			machine: { Path: "%SystemRoot%\\system32", NUMBER_OF_PROCESSORS: "8" },
			user: { Path: "C:\\Users\\张三\\bin", Odd: 3 },
		})}`;
		expect(parseWindowsEnvironment(output)).toEqual({
			machine: { Path: "%SystemRoot%\\system32", NUMBER_OF_PROCESSORS: "8" },
			user: { Path: "C:\\Users\\张三\\bin" },
		});
		expect(parseWindowsEnvironment("PowerShell is restricted here")).toBeUndefined();
		expect(parseWindowsEnvironment("__PIER_ENVIRONMENT__bm90IGpzb24=")).toBeUndefined();
	});

	it("expands variables case-insensitively and keeps unknown ones", () => {
		const lookup = (name: string) => ({ systemroot: "C:\\Windows" })[name.toLowerCase()];
		expect(expandWindowsVariables("%SystemRoot%\\system32;%SYSTEMROOT%;%MISSING%\\bin", lookup)).toBe(
			"C:\\Windows\\system32;C:\\Windows;%MISSING%\\bin",
		);
	});

	it("builds the PATH a new terminal gets: the system's, then the user's", () => {
		const environment: WindowsEnvironment = {
			machine: {
				Path: "%SystemRoot%\\system32;%NVM_SYMLINK%;C:\\Program Files\\nodejs\\",
				// Set by nvm-windows after the Host started: only the registry knows it.
				NVM_SYMLINK: "C:\\nvm4w\\nodejs",
			},
			user: { PATH: "%USERPROFILE%\\AppData\\Roaming\\npm;%LOCALAPPDATA%\\Volta\\bin", LOCALAPPDATA: "D:\\Local" },
		};
		expect(windowsRegistryPath(environment, { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\u" })).toBe(
			[
				"C:\\Windows\\system32",
				"C:\\nvm4w\\nodejs",
				"C:\\Program Files\\nodejs\\",
				"C:\\Users\\u\\AppData\\Roaming\\npm",
				"D:\\Local\\Volta\\bin",
			].join(";"),
		);
		expect(windowsRegistryPath({ machine: {}, user: {} }, {})).toBe("");
	});

	it("appends only the entries this process lacks, keeping its own order", () => {
		const current = "C:\\Tools;C:\\WINDOWS\\system32;C:\\Program Files\\nodejs";
		expect(
			appendWindowsPath(
				current,
				'C:\\Windows\\System32\\;"C:\\Program Files\\nodejs\\";;C:\\Program Files\\Git\\cmd;%NVM_HOME%;C:\\program files\\git\\cmd\\',
			),
		).toEqual({ path: `${current};C:\\Program Files\\Git\\cmd`, added: ["C:\\Program Files\\Git\\cmd"] });
		expect(appendWindowsPath(undefined, "C:\\a")).toEqual({ path: "C:\\a", added: ["C:\\a"] });
	});

	it("updates the PATH variable of an environment under the name it has", async () => {
		const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows" };
		const added = await refreshWindowsPath({
			env,
			read: async () => ({
				machine: { Path: "%SystemRoot%\\system32;C:\\Program Files\\nodejs\\" },
				user: { Path: "%APPDATA%\\npm" },
			}),
		});
		expect(added).toEqual(["C:\\Program Files\\nodejs\\"]);
		expect(env).toEqual({ Path: "C:\\Windows\\system32;C:\\Program Files\\nodejs\\", SystemRoot: "C:\\Windows" });
		expect(await refreshWindowsPath({ env, read: async () => undefined })).toBeUndefined();
		expect(await refreshWindowsPath({ env, read: async () => ({ machine: {}, user: {} }) })).toEqual([]);
	});

	it.runIf(process.platform === "win32")("reads this computer's registry", async () => {
		const environment = await readWindowsEnvironment();
		expect(environment).toBeDefined();
		const path = windowsRegistryPath(environment as WindowsEnvironment, process.env).toLowerCase();
		expect(path).toContain(`${(process.env.SystemRoot ?? "C:\\Windows").toLowerCase()}\\system32`);
		// Nothing to add right after the start: this process got the same PATH.
		const env = { ...process.env };
		const before = env.Path ?? env.PATH;
		await refreshWindowsPath({ env, read: async () => environment });
		expect((env.Path ?? env.PATH)?.startsWith(before ?? "")).toBe(true);
	});
});
