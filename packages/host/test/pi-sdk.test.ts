import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piAgent from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareVersions } from "../src/peers/ssh/remote.ts";
import {
	dropForeignPiPackageDir,
	exportedFile,
	loadPiSdk,
	locatePi,
	MIN_PI_VERSION,
	PI_PACKAGE,
	PiLoader,
	type PiLocation,
	piAgentDir,
	piPackageForCommand,
} from "../src/pi/sdk.ts";
import { DEV_PI_PACKAGE_DIR, testPiSdk } from "./helpers.ts";

const posix = process.platform !== "win32";

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pier-pi-sdk-")));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** A minimal pi package (what discovery looks at) in `dir`. */
function fakePi(dir: string, version = "9.1.0"): string {
	mkdirSync(join(dir, "dist", "bundle"), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: PI_PACKAGE, version, bin: { pi: "dist/bundle/cli.js" } }),
	);
	writeFileSync(join(dir, "dist", "index.js"), "export const VERSION = 'fake';\n");
	writeFileSync(join(dir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
	return dir;
}

const packagePath = (prefix: string) => join(prefix, "node_modules", ...PI_PACKAGE.split("/"));
const found = (location: PiLocation) => (location.state === "found" ? location.installation : undefined);

describe("finding the user's pi", () => {
	it.runIf(posix)("follows npm's and bun's command symlink into the package", () => {
		const pkg = fakePi(join(root, "lib", packagePath("")));
		mkdirSync(join(root, "bin"));
		symlinkSync(join(pkg, "dist", "bundle", "cli.js"), join(root, "bin", "pi"));
		const command = join(root, "bin", "pi");
		expect(piPackageForCommand(command)).toEqual({ packageDir: pkg, version: "9.1.0" });
		const location = locatePi({ env: {}, home: root, findCommand: () => command });
		expect(found(location)).toEqual({ packageDir: pkg, version: "9.1.0", command });
	});

	it.runIf(posix)("follows pi's managed installer launcher to the current release", () => {
		const agentDir = join(root, ".pi", "agent");
		const release = fakePi(packagePath(join(agentDir, "install", "releases", "9.2.0")), "9.2.0");
		fakePi(packagePath(join(agentDir, "install", "releases", "9.1.0")), "9.1.0");
		writeFileSync(join(agentDir, "install", "current-version"), "9.2.0\n");
		mkdirSync(join(agentDir, "bin"));
		writeFileSync(join(agentDir, "bin", "pi"), "#!/bin/sh\nexec node launcher\n", { mode: 0o755 });
		mkdirSync(join(root, ".local", "bin"), { recursive: true });
		const command = join(root, ".local", "bin", "pi");
		symlinkSync(join(agentDir, "bin", "pi"), command);
		expect(found(locatePi({ env: {}, home: root, findCommand: () => command }))).toEqual({
			packageDir: release,
			version: "9.2.0",
			command,
		});
	});

	it("finds pi's managed install when no pi is on PATH (apps started outside a terminal)", () => {
		const agentDir = join(root, "custom-agent");
		const release = fakePi(packagePath(join(agentDir, "install", "releases", "9.3.0")), "9.3.0");
		writeFileSync(join(agentDir, "install", "current-version"), "9.3.0");
		mkdirSync(join(agentDir, "bin"));
		const launcher = join(agentDir, "bin", process.platform === "win32" ? "pi.cmd" : "pi");
		writeFileSync(launcher, "launcher");
		const location = locatePi({ env: { PI_CODING_AGENT_DIR: agentDir }, home: root, findCommand: () => undefined });
		expect(found(location)).toEqual({ packageDir: release, version: "9.3.0", command: launcher });
	});

	it("finds the package next to npm's Windows shims", () => {
		const pkg = fakePi(packagePath(root));
		writeFileSync(
			join(root, "pi.cmd"),
			'@"%dp0%\\node.exe" "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
		);
		expect(piPackageForCommand(join(root, "pi.cmd"))).toEqual({ packageDir: pkg, version: "9.1.0" });
	});

	it("reads the package path out of a wrapper script (Nix, pnpm)", () => {
		const pkg = fakePi(join(root, "store", "lib", packagePath("")));
		mkdirSync(join(root, "wrapper"));
		writeFileSync(join(root, "wrapper", "pi"), `#!/bin/sh\nexec node "${pkg}/dist/bundle/cli.js" "$@"\n`);
		expect(piPackageForCommand(join(root, "wrapper", "pi"))).toEqual({ packageDir: pkg, version: "9.1.0" });
	});

	it("reports a pi command that is not an npm installation, and no pi at all", () => {
		const command = join(root, "pi");
		writeFileSync(command, "\u007fELF compiled binary");
		const location = locatePi({ env: {}, home: root, findCommand: () => command });
		expect(location).toMatchObject({ state: "invalid", command });
		expect(locatePi({ env: {}, home: root, findCommand: () => undefined })).toEqual({ state: "missing" });
	});

	it("uses PIER_PI_PATH: pi's package directory or a pi command, and nothing else", () => {
		const pkg = fakePi(join(root, "pkg"));
		expect(found(locatePi({ env: { PIER_PI_PATH: pkg }, home: root, findCommand: () => undefined }))).toEqual({
			packageDir: pkg,
			version: "9.1.0",
		});
		expect(
			found(locatePi({ env: { PIER_PI_PATH: join(pkg, "dist") }, home: root, findCommand: () => undefined }))
				?.packageDir,
		).toBe(pkg);
		expect(locatePi({ env: { PIER_PI_PATH: join(root, "nope") }, home: root })).toMatchObject({ state: "invalid" });
		mkdirSync(join(root, "empty"));
		expect(locatePi({ env: { PIER_PI_PATH: join(root, "empty") }, home: root })).toMatchObject({ state: "invalid" });
	});

	it("resolves pi's agent directory like pi", () => {
		expect(piAgentDir({}, "/home/u")).toBe(join("/home/u", ".pi", "agent"));
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/agents/pi" }, "/home/u")).toBe(join("/home/u", "agents/pi"));
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "/srv/pi" }, "/home/u")).toBe("/srv/pi");
	});
});

describe("loading pi", () => {
	it("follows package exports, including subpath patterns", () => {
		const dir = join(root, "pkg");
		mkdirSync(join(dir, "dist", "providers"), { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: "x",
				exports: {
					".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
					"./providers/*": { types: "./dist/providers/*.d.ts", import: "./dist/providers/*.js" },
				},
			}),
		);
		writeFileSync(join(dir, "dist", "index.js"), "");
		writeFileSync(join(dir, "dist", "providers", "all.js"), "");
		expect(exportedFile(dir, ".")).toBe(join(dir, "dist", "index.js"));
		expect(exportedFile(dir, "./providers/all")).toBe(join(dir, "dist", "providers", "all.js"));
		expect(() => exportedFile(dir, "./missing")).toThrow(/does not export/);
	});

	it("loads the SDK of an installation, sharing pi's own module instances", async () => {
		const sdk = await loadPiSdk({ packageDir: DEV_PI_PACKAGE_DIR });
		expect(sdk.version).toBe(piAgent.VERSION);
		expect(sdk.packageDir).toBe(realpathSync(DEV_PI_PACKAGE_DIR));
		expect(sdk.builtinProviders()).toContain("anthropic");
		expect(typeof sdk.ai.getSupportedThinkingLevels).toBe("function");
		expect(sdk.agent.SessionManager).toBe(piAgent.SessionManager);
	});

	it("is built against a pi at least as new as the oldest one it accepts", () => {
		expect(compareVersions(piAgent.VERSION, MIN_PI_VERSION)).toBeGreaterThanOrEqual(0);
	});

	it("refuses a pi older than MIN_PI_VERSION without loading it", async () => {
		const load = vi.fn();
		const loader = new PiLoader({
			locate: () => ({ state: "found", installation: { packageDir: root, version: "1.0.0", command: "/bin/pi" } }),
			load,
		});
		await expect(loader.load()).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("版本过旧"),
		});
		expect(load).not.toHaveBeenCalled();
		expect(loader.state().reason).toContain(MIN_PI_VERSION);
	});

	it("loads once, remembers a failed installation, and retries a changed one", async () => {
		let version = "99.0.0";
		const load = vi.fn(async () => {
			if (version === "99.0.0") throw new Error("broken");
			return { ...testPiSdk(), version };
		});
		const loader = new PiLoader({
			locate: () => ({ state: "found", installation: { packageDir: root, version } }),
			load,
		});
		await expect(loader.load()).rejects.toMatchObject({ message: expect.stringContaining("broken") });
		await expect(loader.load()).rejects.toMatchObject({ message: expect.stringContaining("broken") });
		expect(load).toHaveBeenCalledTimes(1);
		version = "99.0.1";
		expect((await loader.load()).version).toBe("99.0.1");
		version = "99.0.2";
		expect((await loader.load()).version).toBe("99.0.1");
		expect(load).toHaveBeenCalledTimes(2);
		expect(loader.state()).toMatchObject({ sdk: { version: "99.0.1" }, location: { state: "found" } });
	});

	it("explains how to install pi when there is none", async () => {
		const loader = new PiLoader({ locate: () => ({ state: "missing" }) });
		await expect(loader.load()).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("pi.dev/install.sh"),
		});
	});

	it("drops a PI_PACKAGE_DIR that names other pi assets", async () => {
		const assets = join(root, "assets");
		mkdirSync(assets);
		writeFileSync(join(assets, "package.json"), JSON.stringify({ name: PI_PACKAGE, version: "0.0.1" }));
		vi.stubEnv("PI_PACKAGE_DIR", assets);
		const loader = new PiLoader({
			locate: () => ({ state: "found", installation: { packageDir: root, version: "99.0.0" } }),
			load: async () => testPiSdk(),
		});
		await loader.load();
		expect(process.env.PI_PACKAGE_DIR).toBeUndefined();
	});

	it("keeps a PI_PACKAGE_DIR that is pi's own package, drops older Pier's asset bundles", () => {
		const pkg = fakePi(join(root, "pkg"), "9.1.0");
		const assets = join(root, "pi-assets");
		mkdirSync(assets);
		writeFileSync(join(assets, "package.json"), JSON.stringify({ name: PI_PACKAGE, version: "9.1.0" }));
		const env: NodeJS.ProcessEnv = { PI_PACKAGE_DIR: pkg };
		expect(dropForeignPiPackageDir(env)).toBeUndefined();
		expect(env.PI_PACKAGE_DIR).toBe(pkg);
		expect(dropForeignPiPackageDir(env, { version: "9.2.0" })).toBe(pkg);
		expect(env.PI_PACKAGE_DIR).toBeUndefined();
		env.PI_PACKAGE_DIR = assets;
		expect(dropForeignPiPackageDir(env)).toBe(assets);
		expect(env).toEqual({});
	});
});
