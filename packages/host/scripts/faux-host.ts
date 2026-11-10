#!/usr/bin/env node
/**
 * Development host backed by pi's faux model: deterministic streaming, tool calls and an
 * approval request, without real credentials or token spend. Useful for UI work:
 *
 *   bun run faux-host                  # prints a pier.ready line and a browser URL
 *   bun run --cwd apps/desktop dev:web
 *   open http://localhost:1420/?url=<url>&token=<token>
 *
 * A prompt containing "demo" / "演示" runs a scripted coding task (bash, write, edit, and a
 * command that needs approval); any other prompt gets a streamed Markdown reply.
 *
 * `--remote [--remote-port <n>]` also turns on remote access (default port 7433) so the
 * mobile app can pair with it; `--remote-address <host:port>` overrides the addresses
 * put into pairing codes (e.g. `10.0.2.2:7433` for the Android emulator).
 * `--relay <url>` registers with a Pier Relay (token from $PIER_RELAY_TOKEN), e.g. one started
 * with `bun run relay -- --mode open`; `--no-p2p` keeps relayed connections on the relay.
 * `--account-site <url>` points the personal center at another NewAPI site (e.g. a local one)
 * instead of 云链API. `--demo-updates` pretends the host runs in a desktop app whose updater
 * finds v9.9.9 and fakes installing it (`update.*`, for the remote update UI).
 * `--agents` also offers the Claude Code and Codex CLIs installed here (real sessions, real tokens);
 * `--fake-codex` instead offers a scripted Codex (the test fixture, no tokens) whose prompts with
 * "delegate" start sub-agents ("delegate slow team" paces two of them, "delegate-hold" runs one
 * until it is stopped).
 * `--demo-terminals` lets clients open terminals (`terminal.*`, for the remote terminal UI):
 * a real `bash` through `script(1)` on Linux (no resizing), a line-echo shell elsewhere. State
 * lives in a temporary directory that is removed on exit.
 *
 * Sample slash commands for the command menu: the extension command `/greet`, the prompt
 * template `/explain <topic>`, and `/skill:faux-skill`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { type AppUpdateStatus, PROTOCOL_VERSION } from "@pier/protocol";
import { PIER_HOST_VERSION } from "../src/host.ts";
import type {
	AppShell,
	ShellMethod,
	ShellTerminal,
	ShellTerminalHandlers,
	ShellTerminalOptions,
} from "../src/shell.ts";
import { startTestHost, TOKEN } from "../test/helpers.ts";

type Context = { messages: Array<{ role: string; content?: unknown }> };

function lastUserText(context: Context): string {
	const user = [...context.messages].reverse().find((m) => m.role === "user");
	if (!user) return "";
	if (typeof user.content === "string") return user.content;
	return Array.isArray(user.content)
		? user.content.map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("")
		: "";
}

/** Assistant turns since the last user message: the step of the scripted task. */
function stepOf(context: Context): number {
	let step = 0;
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const role = context.messages[i]?.role;
		if (role === "user") break;
		if (role === "assistant") step++;
	}
	return step;
}

const DEMO_FILE = "notes/pier-demo.md";

function respond(context: Context) {
	const prompt = lastUserText(context);
	if (!/demo|演示/i.test(prompt)) {
		return fauxAssistantMessage([
			fauxThinking("用户发来了一条消息，我用 Markdown 简单回复一下。"),
			fauxText(
				[
					`收到：**${prompt.slice(0, 80) || "（空）"}**`,
					"",
					"这是 faux 模型的回复，用来演示流式输出与 Markdown 渲染：",
					"",
					"| 功能 | 状态 |",
					"|---|---|",
					"| 流式输出 | ✅ |",
					"| 代码高亮 | ✅ |",
					"",
					"```ts",
					'const greeting: string = "hello from pier";',
					"console.log(greeting);",
					"```",
					"",
					"发送包含 `演示` 的消息可以运行一个带工具调用和审批的脚本任务。更多信息见 [pi 项目](https://github.com/earendil-works/pi)。",
				].join("\n"),
			),
		]);
	}
	switch (stepOf(context)) {
		case 0:
			return fauxAssistantMessage(
				[
					fauxThinking("先看看工作区里有什么文件。"),
					fauxText("我先看一下工作区的目录结构。"),
					fauxToolCall("bash", { command: "ls -la" }),
				],
				{ stopReason: "toolUse" },
			);
		case 1:
			return fauxAssistantMessage(
				[
					fauxText("创建一份说明文档："),
					fauxToolCall("write", {
						path: DEMO_FILE,
						content: "# Pier 演示\n\n这是 faux 模型写入的文件。\n\n- 第一项\n- 第二项\n",
					}),
				],
				{ stopReason: "toolUse" },
			);
		case 2:
			return fauxAssistantMessage(
				[
					fauxText("再修改其中一行："),
					fauxToolCall("edit", {
						path: DEMO_FILE,
						edits: [{ oldText: "- 第二项\n", newText: "- 第二项（已修改）\n- 第三项\n" }],
					}),
				],
				{ stopReason: "toolUse" },
			);
		case 3:
			return fauxAssistantMessage(
				[
					fauxText("最后运行一个需要你批准的命令："),
					fauxToolCall("bash", { command: "touch pier-approved.txt && echo created pier-approved.txt" }),
				],
				{ stopReason: "toolUse" },
			);
		default:
			return fauxAssistantMessage(
				`演示完成 🎉\n\n1. 用 \`ls\` 查看了目录；\n2. 创建并编辑了 \`${DEMO_FILE}\`；\n3. 在你批准（或拒绝）后执行了最后一条命令。`,
			);
	}
}

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Sample prompt template and skill, so the slash-command menu has host commands to show. */
function sampleResources(): string {
	const dir = mkdtempSync(join(tmpdir(), "pier-faux-resources-"));
	mkdirSync(join(dir, "prompts"));
	writeFileSync(
		join(dir, "prompts", "explain.md"),
		'---\ndescription: Explain a topic step by step\nargument-hint: "<topic>"\n---\nExplain $@ step by step.\n',
	);
	mkdirSync(join(dir, "skills", "faux-skill"), { recursive: true });
	writeFileSync(
		join(dir, "skills", "faux-skill", "SKILL.md"),
		"---\nname: faux-skill\ndescription: A sample skill of the faux host\n---\n\nAnswer like a pirate.\n",
	);
	return dir;
}

/**
 * `--demo-updates`: a desktop app updater that finds v9.9.9 and fakes installing it.
 * `--demo-terminals`: terminals for clients.
 */
class DemoShell implements AppShell {
	private status: AppUpdateStatus = {
		state: "idle",
		currentVersion: PIER_HOST_VERSION,
		autoCheck: true,
		downloaded: 0,
	};
	private readonly listeners = new Set<(status: AppUpdateStatus) => void>();

	constructor(
		private readonly updates: boolean,
		readonly terminals: boolean,
	) {}

	get updateStatus(): AppUpdateStatus | undefined {
		return this.updates ? this.status : undefined;
	}

	async openTerminal(options: ShellTerminalOptions, handlers: ShellTerminalHandlers): Promise<ShellTerminal> {
		const cwd = options.cwd ?? homedir();
		const out = (text: string) => handlers.output(Buffer.from(text).toString("base64"));
		if (process.platform === "linux") {
			const child = spawn("script", ["-qfec", "exec bash -i", "/dev/null"], {
				cwd,
				env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(options.cols), LINES: String(options.rows) },
			});
			child.stdout.on("data", (chunk: Buffer) => handlers.output(chunk.toString("base64")));
			child.on("exit", (code) => handlers.exit(code));
			child.on("error", (error) => handlers.exit(null, error.message));
			return {
				shell: "bash",
				cwd,
				write: (data) => child.stdin.write(data),
				resize: () => {},
				pause: (paused) => (paused ? child.stdout.pause() : child.stdout.resume()),
				kill: () => child.kill("SIGHUP"),
			};
		}
		let line = "";
		setTimeout(() => out(`demo shell · ${cwd}\r\n$ `), 20);
		return {
			shell: "demo",
			cwd,
			write: (data) => {
				for (const ch of data) {
					if (ch === "\r") {
						const command = line.trim();
						line = "";
						if (command === "exit") return handlers.exit(0);
						out(`\r\n${command ? `${command}\r\n` : ""}$ `);
					} else {
						line += ch;
						out(ch);
					}
				}
			},
			resize: () => {},
			pause: () => {},
			kill: () => handlers.exit(null),
		};
	}

	onUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private set(patch: Partial<AppUpdateStatus>): AppUpdateStatus {
		this.status = { ...this.status, ...patch };
		for (const listener of this.listeners) listener(this.status);
		return this.status;
	}

	private async check(): Promise<AppUpdateStatus> {
		this.set({ state: "checking" });
		await sleep(800);
		return this.set({
			state: "available",
			version: "9.9.9",
			notes: "### Added\n\n- Demo update for the remote update UI.",
			date: new Date().toISOString(),
			lastChecked: Date.now(),
		});
	}

	async request(method: ShellMethod): Promise<AppUpdateStatus> {
		const busy = ["checking", "downloading", "installing"].includes(this.status.state);
		if (busy) return this.status;
		if (method === "update.check") return this.check();
		if (!this.status.version && (await this.check()).state !== "available") return this.status;
		const total = 48 * 1024 * 1024;
		const status = this.set({ state: "downloading", downloaded: 0, total });
		void (async () => {
			for (let downloaded = total / 20; downloaded <= total; downloaded += total / 20) {
				await sleep(300);
				this.set({ downloaded });
			}
			this.set({ state: "installing" });
			await sleep(1500);
			this.set({ state: "error", error: "安装更新失败：演示模式不会真正安装" });
		})();
		return status;
	}

	close(): void {}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const remote = process.argv.includes("--remote");
const demoUpdates = process.argv.includes("--demo-updates");
const demoTerminals = process.argv.includes("--demo-terminals");
const resources = sampleResources();
const remoteAddress = flag("--remote-address");
const relayUrl = flag("--relay");
const accountSite = flag("--account-site");
const fakeCodexDir = process.argv.includes("--fake-codex")
	? mkdtempSync(join(tmpdir(), "pier-fake-codex-"))
	: undefined;
const t = await startTestHost({
	...(accountSite ? { accountSite } : {}),
	// `--agents`: also offer the Claude Code and Codex CLIs installed on this computer.
	...(process.argv.includes("--agents") ? { agents: {} } : {}),
	...(fakeCodexDir
		? {
				agents: {
					claudeCode: false,
					codex: {
						executable: process.execPath,
						args: [join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-codex-app-server.mjs")],
						env: { ...process.env, FAKE_CODEX_DIR: fakeCodexDir },
					},
				},
			}
		: {}),
	...(demoUpdates || demoTerminals ? { shell: new DemoShell(demoUpdates, demoTerminals) } : {}),
	tokensPerSecond: Number(process.env.FAUX_TPS ?? 400),
	log: (message) => process.stderr.write(`[faux-host] ${message}\n`),
	extraResources: {
		promptTemplatePaths: [join(resources, "prompts")],
		skillPaths: [join(resources, "skills")],
		extensions: [
			{
				name: "faux-commands",
				factory: (pi) => {
					pi.registerCommand("greet", {
						description: "Show a greeting from an extension command",
						handler: async (args, ctx) => {
							ctx.ui.notify(`Hello${args ? `, ${args}` : ""}! (from /greet)`, "info");
						},
					});
				},
			},
		],
	},
	...(remote || relayUrl
		? {
				remote: {
					enabled: remote,
					port: Number(flag("--remote-port") ?? 7433),
					mdns: !process.argv.includes("--no-mdns"),
					...(remoteAddress ? { advertiseAddresses: [remoteAddress] } : {}),
					...(relayUrl
						? {
								relay: {
									url: relayUrl,
									...(process.env.PIER_RELAY_TOKEN ? { token: process.env.PIER_RELAY_TOKEN } : {}),
								},
							}
						: {}),
					...(process.argv.includes("--no-p2p") ? { p2p: false } : {}),
				},
			}
		: {}),
});
writeFileSync(join(t.workspaceDir, "README.md"), "# Faux workspace\n");
t.faux.setResponses(Array.from({ length: 10_000 }, () => (context: unknown) => respond(context as Context)));
// Register the scratch workspace so the UI has something to show.
t.host.config.addWorkspace({ path: t.workspaceDir, name: "faux-workspace" });

// Same shape as pier-host's ready line, so the desktop shell can run this host through
// PIER_HOST_BIN (with a small wrapper script that execs `tsx faux-host.ts "$@"`).
const port = Number(new URL(t.url).port);
process.stdout.write(
	`${JSON.stringify({ type: "pier.ready", url: t.url, port, token: TOKEN, pid: process.pid, version: PIER_HOST_VERSION, protocolVersion: PROTOCOL_VERSION })}\n`,
);
process.stderr.write(
	`[faux-host] workspace ${t.workspaceDir}\n[faux-host] UI: http://localhost:1420/?url=${encodeURIComponent(t.url)}&token=${TOKEN}\n`,
);

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await t.close();
	rmSync(resources, { recursive: true, force: true });
	if (fakeCodexDir) rmSync(fakeCodexDir, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
if (process.argv.includes("--watch-stdin")) {
	process.stdin.on("end", () => void stop());
	process.stdin.on("close", () => void stop());
	process.stdin.resume();
}
