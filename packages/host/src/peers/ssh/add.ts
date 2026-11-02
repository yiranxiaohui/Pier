import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type SshPairOutput, type SshPairRequest, updateDownloadUrl } from "@pier/client";
import {
	PEER_ADDRESS,
	type PeerInfo,
	PierProtocolError,
	type SshAddFailure,
	type SshAddParams,
	type SshAddProgress,
	type SshAddResult,
	type SshAddStep,
} from "@pier/protocol";
import { standaloneExecutable } from "../../standalone/self.ts";
import { rememberHostKey } from "./known-hosts.ts";
import { cachedReleaseFile, fileSha256, findReleaseAsset, releaseFileSize, verifiedCacheFile } from "./release.ts";
import {
	compareVersions,
	DETECT_SCRIPT,
	DOWNLOAD_SCRIPT,
	installedHelper,
	LINGER_SCRIPT,
	parseFacts,
	planRemote,
	type RemoteFacts,
	START_DETACHED_SCRIPT,
	STOP_DOWNLOADS_SCRIPT,
	SUDO_LINGER_SCRIPT,
	VERIFY_SCRIPT,
	WAIT_READY_SCRIPT,
} from "./remote.ts";
import { type ExecResult, SshError, SshSession, shellQuote } from "./session.ts";

export interface SshAddHooks {
	pierDir: string;
	/** This Pier's version; the other computer gets the same release. */
	version: string;
	/** Fingerprint of this host's key, which the other computer accepts as a device. */
	deviceFingerprint(): string;
	/** This host's relay, offered to the other computer when it has none. */
	relay(): { url: string; token?: string } | undefined;
	/** Pair with the other computer's link (`peer.pair`), trying `extraAddresses` first. */
	pair(uri: string, extraAddresses: string[]): Promise<PeerInfo>;
	log(message: string): void;
	fetch?: typeof fetch;
	/** OpenSSH `known_hosts` files to trust (default `~/.ssh/known_hosts`); Pier's own file is always added. */
	knownHostsFiles?: string[];
	sshDir?: string;
	/** Use this file instead of a release download (tests). */
	executable?: { path: string; version: string; arch: string };
}

type Parsed = Omit<SshAddParams, "port"> & { port: number };

const MIN_FREE_KB = 512 * 1024;
const PAIR_TIMEOUT_MS = 3 * 60_000;

function failure(reason: SshAddFailure, message: string, data: Record<string, unknown> = {}): PierProtocolError {
	return new PierProtocolError("CONFLICT", message, { ...data, reason });
}

function tail(result: ExecResult): string {
	const text = `${result.stderr}\n${result.stdout}`
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	return text.slice(-6).join("\n");
}

/** `host:port` for the address the user reached over SSH, when it is usable as a Pier address. */
function sshAddress(host: string, port: number): string | undefined {
	const bare = host.replace(/^\[(.*)\]$/, "$1");
	const address = bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
	return PEER_ADDRESS.test(address) ? address : undefined;
}

/**
 * `peer.sshAdd`: sign in over SSH, make sure Pier runs on that Linux computer (installing the
 * same release as this one when needed), then pair with it. The other side accepts only this
 * host's key, so nobody has to confirm there.
 */
export async function addPeerOverSsh(
	params: Parsed,
	hooks: SshAddHooks,
	progress: (update: Omit<SshAddProgress, "operationId">) => void,
	signal: AbortSignal,
): Promise<SshAddResult> {
	const step = (s: SshAddStep, message: string, extra: { transferred?: number; total?: number } = {}) =>
		progress({ step: s, message, ...extra });
	const checkAbort = () => {
		if (signal.aborted) throw failure("CANCELLED", "已取消");
	};
	const target = `${params.username}@${params.host}${params.port === 22 ? "" : `:${params.port}`}`;
	const pierKnownHosts = join(hooks.pierDir, "ssh_known_hosts");
	step("connect", `正在连接 ${target}…`);
	let session: SshSession;
	try {
		session = await SshSession.connect({
			host: params.host,
			port: params.port,
			username: params.username,
			auth: params.auth,
			knownHostsFiles: [...(hooks.knownHostsFiles ?? [join(homedir(), ".ssh", "known_hosts")]), pierKnownHosts],
			...(params.hostKeyFingerprint ? { acceptFingerprint: params.hostKeyFingerprint } : {}),
			onAcceptedKey: (name, key) => {
				try {
					rememberHostKey(pierKnownHosts, name, key);
				} catch (error) {
					hooks.log(`ssh: could not remember the host key of ${name}: ${String(error)}`);
				}
			},
			signal,
			...(hooks.sshDir ? { sshDir: hooks.sshDir } : {}),
		});
	} catch (error) {
		if (error instanceof SshError) throw failure(error.reason, error.message, error.data);
		throw failure("SSH_UNREACHABLE", error instanceof Error ? error.message : String(error));
	}
	hooks.log(`ssh: signed in to ${target}`);
	const cleanup: string[] = [];
	let downloadDir: string | undefined;
	// Cancelling stops a download running there before hanging up (it would outlive the session).
	let stopping: Promise<void> | undefined;
	const onAbort = () => {
		stopping = (async () => {
			if (downloadDir) {
				await Promise.race([
					session.script(STOP_DOWNLOADS_SCRIPT, [downloadDir]).catch(() => undefined),
					new Promise((done) => setTimeout(done, 3000)),
				]);
			}
			session.close();
		})();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const run = async (script: string, args: string[] = [], stdin?: string) => {
			const result =
				stdin === undefined
					? await session.script(script, args)
					: await session.exec(`sh -c ${shellQuote(script)} sh ${args.map(shellQuote).join(" ")}`, stdin);
			checkAbort();
			return result;
		};
		step("detect", "正在检查远程系统…");
		const detect = async () => {
			const result = await run(DETECT_SCRIPT);
			try {
				return parseFacts(result.stdout);
			} catch {
				throw failure("UNSUPPORTED_SYSTEM", `无法读取远程系统信息：${tail(result) || "没有输出"}`);
			}
		};
		let facts = await detect();
		if (facts.os !== "Linux")
			throw failure("UNSUPPORTED_SYSTEM", `目前只能通过 SSH 安装到 Linux（远程系统为 ${facts.os || "未知"}）`);
		if (!facts.supportedArch)
			throw failure("UNSUPPORTED_SYSTEM", `不支持的处理器架构 ${facts.arch}，仅支持 x86_64 和 arm64`);
		const plan = planRemote(facts, hooks.version);
		const useInstalledHelper = plan.kind !== "install" && installedHelper(facts, hooks.version);
		hooks.log(
			`ssh: ${target} runs ${facts.running ? `Pier ${facts.running.version ?? "?"}` : "no Pier"}${facts.installed ? `, installed ${facts.installed.version ?? "?"}` : ""}; plan ${plan.kind}`,
		);

		let fresh: string | undefined;
		if (plan.kind === "install" || !useInstalledHelper) {
			downloadDir = `${facts.home}/.cache/pier/ssh-install`;
			fresh = await provideExecutable(session, facts, downloadDir, params, hooks, step, run, signal);
			cleanup.push(fresh);
		}
		const warnings: string[] = [];
		if (plan.kind === "install") {
			step("install", plan.upgrade ? "正在升级远程主机上的 Pier…" : "正在远程主机上安装 Pier 服务…");
			const result = await run(`"$1" install${facts.systemd ? "" : " --no-start"}`, [fresh as string]);
			if (result.code !== 0) throw failure("INSTALL_FAILED", `安装失败：${tail(result) || `退出码 ${result.code}`}`);
		}
		if (plan.kind !== "existing") {
			facts = await detect();
			const installed = facts.installed?.path;
			if (!facts.running) {
				step("start", "正在启动 Pier…");
				if (!installed) throw failure("INSTALL_FAILED", "安装后没有找到 Pier");
				let result = facts.systemd
					? await run(`"$1" start`, [installed])
					: await run(START_DETACHED_SCRIPT, [installed, facts.stateDir]);
				if (result.code === 0 && facts.systemd) result = await run(WAIT_READY_SCRIPT, [facts.stateDir]);
				if (result.code !== 0)
					throw failure("START_FAILED", `Pier 没有启动：${tail(result) || `退出码 ${result.code}`}`);
				facts = await detect();
			}
			if (!facts.running) throw failure("START_FAILED", "Pier 没有启动，请在远程主机上运行 pier status 查看原因");
			if (!facts.systemd) warnings.push("远程主机没有可用的 systemd：Pier 已在后台运行，但重启后不会自动启动");
			else if (facts.uid !== 0 && facts.linger !== "yes") {
				const enabled = await enableLinger(facts, params, run);
				if (!enabled)
					warnings.push(
						`没有为 ${facts.user} 开启 linger：退出所有 SSH 会话后 Pier 服务可能停止，开机也不会自动启动。请让管理员执行 sudo loginctl enable-linger ${facts.user}`,
					);
			}
		}
		const helper =
			useInstalledHelper || (plan.kind === "install" && facts.installed)
				? (facts.installed?.path as string)
				: (fresh as string);
		const version = facts.running?.version ?? facts.installed?.version;
		if (version && compareVersions(version, hooks.version) < 0)
			warnings.push(`远程主机运行的是 Pier ${version}，比本机的 ${hooks.version} 旧；可在那台电脑上更新`);

		step("pair", "正在配对…");
		const peer = await pairOverSession(session, helper, facts.stateDir, params, hooks, warnings, signal);
		const action: SshAddResult["action"] =
			plan.kind === "install"
				? plan.upgrade
					? "updated"
					: "installed"
				: plan.kind === "start"
					? "started"
					: "existing";
		hooks.log(`ssh: added ${peer.name} (${peer.id}) from ${target}, ${action}`);
		return { peer, action, ...(version ? { version } : {}), warnings };
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (stopping) await stopping;
		else if (cleanup.length) {
			const files = cleanup.flatMap((f) => [f, `${f}.part`]).map(shellQuote);
			await session
				.exec(`rm -f ${files.join(" ")}; rmdir ${shellQuote(downloadDir ?? "")} 2>/dev/null; true`)
				.catch(() => undefined);
		}
		session.close();
	}
}

async function enableLinger(
	facts: RemoteFacts,
	params: Parsed,
	run: (script: string, args?: string[], stdin?: string) => Promise<ExecResult>,
): Promise<boolean> {
	if (!facts.tools.has("loginctl")) return false;
	if ((await run(LINGER_SCRIPT, [facts.user])).stdout.includes("linger=yes")) return true;
	if (params.auth.type !== "password" || !facts.tools.has("sudo")) return false;
	return (await run(SUDO_LINGER_SCRIPT, [facts.user], `${params.auth.password}\n`)).stdout.includes("linger=yes");
}

/** Put the same Pier release as this one on the other computer; returns its path there. */
async function provideExecutable(
	session: SshSession,
	facts: RemoteFacts,
	directory: string,
	params: Parsed,
	hooks: SshAddHooks,
	step: (s: SshAddStep, message: string, extra?: { transferred?: number; total?: number }) => void,
	run: (script: string, args?: string[]) => Promise<ExecResult>,
	signal: AbortSignal,
): Promise<string> {
	if (facts.freeKb !== undefined && facts.freeKb < MIN_FREE_KB)
		throw failure("INSTALL_FAILED", `远程主机 ${facts.home} 所在磁盘剩余空间不足 512 MB`);
	const tag = `v${hooks.version}`;
	const upload = async (local: string, name: string, sha256: string) => {
		const dest = `${directory}/${name}`;
		step("upload", "正在上传 Pier 到远程主机…", { transferred: 0 });
		const mkdir = await session.exec(`mkdir -p ${shellQuote(directory)}`);
		if (mkdir.code !== 0) throw failure("INSTALL_FAILED", `无法创建 ${directory}：${tail(mkdir)}`);
		try {
			await session.upload(local, `${dest}.part`, (transferred, total) =>
				step("upload", "正在上传 Pier 到远程主机…", { transferred, total }),
			);
		} catch (error) {
			if (signal.aborted) throw failure("CANCELLED", "已取消");
			throw failure("INSTALL_FAILED", `上传失败：${error instanceof Error ? error.message : String(error)}`);
		}
		const verify = await run(VERIFY_SCRIPT, [sha256, dest]);
		if (verify.code !== 0) throw failure("INSTALL_FAILED", `上传的文件无法运行：${tail(verify)}`);
		return dest;
	};

	const self =
		hooks.executable ??
		(standaloneExecutable.path && standaloneExecutable.version
			? {
					path: standaloneExecutable.path,
					version: standaloneExecutable.version,
					arch: process.platform === "linux" ? process.arch : "",
				}
			: undefined);
	if (self && self.version === hooks.version && self.arch === facts.arch) {
		hooks.log(`ssh: copying this executable to ${facts.arch}`);
		return upload(self.path, `pier-${tag}-linux-${facts.arch}`, await fileSha256(self.path));
	}

	const options = {
		...(params.mirrorPrefix ? { mirrorPrefix: params.mirrorPrefix } : {}),
		...(hooks.fetch ? { fetch: hooks.fetch } : {}),
		signal,
	};
	step("download", `正在查找 Pier ${tag}（Linux ${facts.arch}）…`);
	let asset: Awaited<ReturnType<typeof findReleaseAsset>>;
	try {
		asset = await findReleaseAsset(tag, facts.arch, options);
	} catch (error) {
		if (signal.aborted) throw failure("CANCELLED", "已取消");
		throw failure("DOWNLOAD_FAILED", error instanceof Error ? error.message : String(error));
	}
	const cacheDir = join(hooks.pierDir, "cache", "releases");
	// Downloaded here before: upload it again rather than downloading it there.
	const cached = await verifiedCacheFile(asset, cacheDir);
	if (cached) return upload(cached, asset.name, asset.sha256);
	if (facts.tools.has("curl") || facts.tools.has("wget")) {
		const url = updateDownloadUrl(asset.url, params.mirrorPrefix ?? "");
		const total = await releaseFileSize(url, options);
		const message = `远程主机正在下载 ${asset.name}…`;
		step("download", message, { transferred: 0, ...(total ? { total } : {}) });
		const dest = `${directory}/${asset.name}`;
		let polling = false;
		const timer = setInterval(() => {
			if (polling) return;
			polling = true;
			void session
				.exec(`wc -c < ${shellQuote(`${dest}.part`)} 2>/dev/null`)
				.then((r) => {
					const transferred = Number(r.stdout.trim());
					if (r.code === 0 && transferred > 0 && !signal.aborted)
						step("download", message, { transferred, ...(total ? { total } : {}) });
				})
				.catch(() => undefined)
				.finally(() => {
					polling = false;
				});
		}, 2000);
		let result: ExecResult;
		try {
			result = await run(DOWNLOAD_SCRIPT, [url, asset.sha256, dest]);
		} finally {
			clearInterval(timer);
		}
		if (result.code === 0) return dest;
		hooks.log(`ssh: remote download failed (${result.code}): ${tail(result)}`);
		if (result.code !== 2 && result.code !== 3 && result.code !== 4)
			throw failure("DOWNLOAD_FAILED", `远程主机下载失败：${tail(result) || `退出码 ${result.code}`}`);
	}
	step("download", `正在下载 ${asset.name}…`, { transferred: 0 });
	let local: string;
	try {
		local = await cachedReleaseFile(asset, cacheDir, {
			...options,
			onProgress: (transferred, total) =>
				step("download", `正在下载 ${asset.name}…`, { transferred, ...(total ? { total } : {}) }),
		});
	} catch (error) {
		if (signal.aborted) throw failure("CANCELLED", "已取消");
		throw failure(
			"DOWNLOAD_FAILED",
			`下载 ${asset.name} 失败：${error instanceof Error ? error.message : String(error)}。可在「关于与更新」中换一条更新线路后重试`,
		);
	}
	return upload(local, asset.name, asset.sha256);
}

/** Run `pier cli --ssh-pair` there and pair with the link it prints. */
async function pairOverSession(
	session: SshSession,
	helper: string,
	stateDir: string,
	params: Parsed,
	hooks: SshAddHooks,
	warnings: string[],
	signal: AbortSignal,
): Promise<PeerInfo> {
	const relay = params.relay === false ? undefined : hooks.relay();
	const request: SshPairRequest = {
		fingerprint: hooks.deviceFingerprint(),
		...(relay ? { relay } : {}),
		timeoutMs: PAIR_TIMEOUT_MS,
	};
	const channel = await session.open(`exec ${shellQuote(helper)} cli --ssh-pair --pier-dir ${shellQuote(stateDir)}`);
	let stderr = "";
	channel.stderr.on("data", (data: Buffer) => {
		if (stderr.length < 64 * 1024) stderr += data.toString("utf8");
	});
	channel.write(`${JSON.stringify(request)}\n`);
	const lines = createInterface({ input: channel });
	return new Promise<PeerInfo>((resolve, reject) => {
		let pairing: Promise<PeerInfo> | undefined;
		let helperDone = false;
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			try {
				channel.end();
			} catch {
				// Already closed.
			}
			fn();
		};
		const onAbort = () => settle(() => reject(failure("CANCELLED", "已取消")));
		signal.addEventListener("abort", onAbort, { once: true });
		const helperFailed = (message: string) => {
			const text = /Unknown option '--ssh-pair'/.test(message)
				? "远程主机上的 Pier 版本过旧，不支持自动配对"
				: `远程主机上的 Pier 没有完成配对：${message}`;
			settle(() => reject(failure("PAIRING_FAILED", text)));
		};
		lines.on("line", (line) => {
			let output: SshPairOutput;
			try {
				output = JSON.parse(line) as SshPairOutput;
			} catch {
				return;
			}
			if (output.type === "uri") {
				warnings.push(...output.warnings.map((w) => `远程主机：${w}`));
				const extra = sshAddress(params.host, output.port);
				pairing = hooks.pair(output.uri, extra ? [extra] : []);
				pairing.then(
					(peer) => settle(() => resolve(peer)),
					(error) => settle(() => reject(error)),
				);
			} else if (output.type === "done") helperDone = true;
			else if (output.type === "error" && !pairing) helperFailed(output.message);
			else if (output.type === "error") {
				// The local pairing reports the reason (rejected, unreachable…) itself.
				hooks.log(`ssh: pairing helper: ${output.message}`);
			}
		});
		channel.on("close", () => {
			if (!pairing) helperFailed(stderr.trim().split(/\r?\n/).slice(-3).join("\n") || "进程意外退出");
			else if (!helperDone) hooks.log("ssh: pairing helper exited");
		});
	});
}
