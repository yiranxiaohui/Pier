import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findNodeToolchain,
	findOnPath,
	isNodeVersionAtLeast,
	nodeInstallCommand,
	nodeRequirement,
	nodeRequirementMessage,
} from "../src/pi/node-requirement.ts";

describe("Node.js for pi's installer", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-node-requirement-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("compares versions like pi's installers", () => {
		expect(isNodeVersionAtLeast("22.19.0")).toBe(true);
		expect(isNodeVersionAtLeast("v22.19.1")).toBe(true);
		expect(isNodeVersionAtLeast("22.20.0")).toBe(true);
		expect(isNodeVersionAtLeast("24.0.0")).toBe(true);
		expect(isNodeVersionAtLeast("22.18.9")).toBe(false);
		expect(isNodeVersionAtLeast("20.19.5")).toBe(false);
		expect(isNodeVersionAtLeast("v100.0.0-nightly")).toBe(true);
		expect(isNodeVersionAtLeast("unknown")).toBe(false);
	});

	it("suggests a command only where one fits", () => {
		expect(nodeInstallCommand("win32", {})).toBe("winget install OpenJS.NodeJS.LTS");
		expect(nodeInstallCommand("darwin", { brew: "/opt/homebrew/bin/brew" })).toBe("brew install node");
		expect(nodeInstallCommand("darwin", {})).toBeUndefined();
		expect(nodeInstallCommand("linux", {})).toBeUndefined();
	});

	it("is satisfied by a recent Node.js with npm", () => {
		expect(nodeRequirement({ node: { path: "/n", version: "22.19.0" }, npm: "/npm" }, "linux")).toBeUndefined();
		expect(nodeRequirement({ node: { path: "/n", version: "22.19.0" } }, "linux")?.problem).toBe("npm-missing");
		expect(nodeRequirement({ npm: "/npm" }, "linux")?.problem).toBe("missing");
	});

	it("words what to do for each computer", () => {
		const missing = nodeRequirement({}, "linux");
		expect(missing).toEqual({ minimum: "22.19.0", problem: "missing" });
		const message = missing ? nodeRequirementMessage(missing, {}, "linux", true) : "";
		expect(message).toContain("Node.js 22.19 或更新版本及 npm");
		expect(message).toContain("nvm、fnm");
		expect(message).toContain("无需重启");
	});

	it.runIf(process.platform !== "win32")(
		"finds node and npm on the PATH it is given and reads the version",
		async () => {
			const old = join(root, "old");
			const current = join(root, "current");
			const empty = join(root, "empty");
			for (const dir of [old, current, empty]) mkdirSync(dir);
			const script = (path: string, body: string) => {
				writeFileSync(path, `#!/bin/sh\n${body}\n`);
				chmodSync(path, 0o755);
			};
			script(join(current, "node"), "echo v24.1.0");
			script(join(current, "npm"), "echo 11.0.0");
			script(join(old, "node"), "echo v20.11.1");
			// Not executable: a shell would skip it.
			writeFileSync(join(empty, "node"), "");

			expect(findOnPath(["node"], { PATH: `${empty}:${current}` }, "linux")).toBe(join(current, "node"));
			expect(await findNodeToolchain({ PATH: `${empty}:${current}` }, "linux")).toEqual({
				node: { path: join(current, "node"), version: "24.1.0" },
				npm: join(current, "npm"),
			});
			const older = await findNodeToolchain({ PATH: `${old}:${current}` }, "linux");
			expect(older.node).toEqual({ path: join(old, "node"), version: "20.11.1" });
			expect(nodeRequirement(older, "linux")).toMatchObject({ problem: "outdated", nodeVersion: "20.11.1" });
			expect(await findNodeToolchain({ PATH: empty }, "linux")).toEqual({});
			expect(await findNodeToolchain({}, "linux")).toEqual({});
		},
	);

	it.runIf(process.platform === "win32")("finds node.exe and npm.cmd like install.ps1", async () => {
		const dir = join(root, "nodejs");
		mkdirSync(dir);
		writeFileSync(join(dir, "node.exe"), "");
		writeFileSync(join(dir, "npm"), "");
		writeFileSync(join(dir, "npm.cmd"), "@echo 11.0.0");
		const env = { Path: `${join(root, "missing")};"${dir}"` };
		expect(findOnPath(["node.exe", "node.cmd"], env, "win32")).toBe(join(dir, "node.exe"));
		expect(findOnPath(["npm.cmd", "npm.exe"], env, "win32")).toBe(join(dir, "npm.cmd"));
	});
});
