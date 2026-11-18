/**
 * Spike 1 check: prints what the pi SDK loads through Pier's adapter (extensions,
 * skills, context files, models) using an in-memory session so nothing is persisted.
 *
 *   cd packages/host && bunx tsx spikes/sidecar-check.ts [cwd]
 *   bun build --compile --compile-autoload-package-json spikes/sidecar-check.ts --outfile /tmp/sidecar-check && /tmp/sidecar-check [cwd]
 *
 * pi is loaded from the user's installation (PIER_PI_PATH, or the pi command).
 *
 * An extension file passed via PIER_SPIKE_EXTENSION is loaded in addition to discovery,
 * to prove runtime TypeScript loading (jiti) works inside a compiled binary.
 */
import { PiEnvironment } from "../src/pi/environment.ts";

const cwd = process.argv[2] ?? process.cwd();
const started = Date.now();
const env = await PiEnvironment.create();
const { SessionManager } = (await env.ready()).agent;
const runtime = await env.createRuntime({ cwd, sessionManager: SessionManager.inMemory(cwd), extensions: () => [] });
const session = runtime.session;
await session.bindExtensions({ mode: "rpc" });
const loader = session.resourceLoader;
const extensions = loader.getExtensions();
const report = {
	runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
	agentDir: env.agentDir,
	elapsedMs: Date.now() - started,
	extensions: extensions.extensions.map((e) => ({ path: e.path, tools: [...e.tools.keys()] })),
	extensionErrors: extensions.errors,
	skills: loader.getSkills().skills.map((s) => s.name),
	contextFiles: loader.getAgentsFiles().agentsFiles.map((f) => f.path),
	activeTools: session.getActiveToolNames(),
	model: session.model ? `${session.model.provider}/${session.model.id}` : null,
	availableModels: (await env.listModels()).length,
	diagnostics: runtime.diagnostics,
};
console.log(JSON.stringify(report, null, 2));
await runtime.dispose();
process.exit(0);

declare const Bun: { version: string } | undefined;
