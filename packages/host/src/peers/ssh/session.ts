import { createReadStream, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SshAuth } from "@pier/protocol";
import ssh2, {
	type AnyAuthMethod,
	type AuthenticationType,
	type ClientChannel,
	type ConnectConfig,
	type ParsedKey,
} from "ssh2";
import { checkHostKey, hostKeyFingerprint, hostKeyType, knownHostKeyTypes, knownHostName } from "./known-hosts.ts";

// ssh2 is CommonJS: Node only exposes it as a default export.
const { Client, utils } = ssh2;

/** A failure the caller maps to `peer.sshAdd`'s `data.reason`. */
export class SshError extends Error {
	constructor(
		readonly reason:
			| "SSH_UNREACHABLE"
			| "SSH_AUTH_FAILED"
			| "SSH_KEY_INVALID"
			| "HOST_KEY_UNKNOWN"
			| "HOST_KEY_MISMATCH"
			| "CANCELLED",
		message: string,
		readonly data: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "SshError";
	}
}

export interface SshConnectOptions {
	host: string;
	port: number;
	username: string;
	auth: SshAuth;
	/** Files to check the server key against (OpenSSH format). */
	knownHostsFiles: string[];
	/** A server key fingerprint the user accepted although it is not in `knownHostsFiles`. */
	acceptFingerprint?: string;
	/** Called with a newly accepted key, to remember it. */
	onAcceptedKey?(name: string, key: Buffer): void;
	/** Cancels connecting; afterwards the caller closes the session. */
	signal?: AbortSignal;
	readyTimeoutMs?: number;
	/** Where to look for default keys (default `~/.ssh`). */
	sshDir?: string;
}

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

const MAX_OUTPUT = 1024 * 1024;
const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

/** Parse a private key, turning ssh2's errors into user-facing ones. */
export function parsePrivateKey(text: string | Buffer, passphrase: string | undefined, source: string): ParsedKey {
	const parsed = utils.parseKey(text, passphrase);
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	if (!key || key instanceof Error) {
		const message = key instanceof Error ? key.message : "unsupported key";
		if (/passphrase/i.test(message))
			throw new SshError(
				"SSH_KEY_INVALID",
				passphrase ? `私钥密码不正确（${source}）` : `私钥已加密，请填写私钥密码（${source}）`,
			);
		throw new SshError("SSH_KEY_INVALID", `无法读取私钥 ${source}：${message}`);
	}
	return key;
}

function readKeyFile(input: string): Buffer {
	const path = input === "~" || input.startsWith("~/") ? join(homedir(), input.slice(1)) : input;
	try {
		if (statSync(path).size > 64 * 1024) throw new Error("文件过大");
		return readFileSync(path);
	} catch (error) {
		throw new SshError(
			"SSH_KEY_INVALID",
			`无法读取私钥文件 ${path}：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function defaultAgent(): string | undefined {
	if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
	return process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined;
}

/** Authentication attempts in order, for ssh2's `authHandler`. */
function authMethods(options: SshConnectOptions): AnyAuthMethod[] {
	const username = options.username;
	const { auth } = options;
	if (auth.type === "password") {
		return [
			{ type: "password", username, password: auth.password },
			{
				type: "keyboard-interactive",
				username,
				prompt: (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => auth.password)),
			},
		];
	}
	if (auth.privateKey || auth.privateKeyPath) {
		const source = auth.privateKeyPath ?? "粘贴的私钥";
		const text = auth.privateKey ?? readKeyFile(auth.privateKeyPath as string);
		return [{ type: "publickey", username, key: parsePrivateKey(text, auth.passphrase, source) }];
	}
	const methods: AnyAuthMethod[] = [];
	const agent = defaultAgent();
	if (agent) methods.push({ type: "agent", username, agent });
	const dir = options.sshDir ?? join(homedir(), ".ssh");
	for (const name of DEFAULT_KEYS) {
		let text: Buffer;
		try {
			text = readFileSync(join(dir, name));
		} catch {
			continue;
		}
		try {
			methods.push({ type: "publickey", username, key: parsePrivateKey(text, auth.passphrase, join(dir, name)) });
		} catch {
			// Encrypted with another passphrase, or not a key: try the next one.
		}
	}
	if (!methods.length)
		throw new SshError("SSH_KEY_INVALID", `没有可用的密钥：未运行 SSH agent，${dir} 中也没有可读取的默认私钥`);
	return methods;
}

const RSA_ALGORITHMS = ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"];

/** An open SSH connection: run commands and stream files. */
export class SshSession {
	private closed = false;

	private constructor(private readonly client: InstanceType<typeof Client>) {
		client.on("close", () => {
			this.closed = true;
		});
	}

	static connect(options: SshConnectOptions): Promise<SshSession> {
		const name = knownHostName(options.host, options.port);
		const methods = authMethods(options);
		const preferred = knownHostKeyTypes(options.knownHostsFiles, name).flatMap((type) =>
			type === "ssh-rsa" ? RSA_ALGORITHMS : [type],
		);
		return new Promise<SshSession>((resolve, reject) => {
			const client = new Client();
			let hostKeyError: SshError | undefined;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", abort);
				client.end();
				reject(error);
			};
			const abort = () => fail(new SshError("CANCELLED", "已取消"));
			if (options.signal?.aborted) {
				reject(new SshError("CANCELLED", "已取消"));
				return;
			}
			options.signal?.addEventListener("abort", abort, { once: true });
			const config: ConnectConfig = {
				host: options.host.replace(/^\[(.*)\]$/, "$1"),
				port: options.port,
				username: options.username,
				readyTimeout: options.readyTimeoutMs ?? 30_000,
				keepaliveInterval: 15_000,
				keepaliveCountMax: 4,
				hostVerifier: (key: Buffer) => {
					const fingerprint = hostKeyFingerprint(key);
					const keyType = hostKeyType(key);
					const check = checkHostKey(options.knownHostsFiles, name, key);
					if (check.status === "known") return true;
					if (check.status === "unknown" && options.acceptFingerprint === fingerprint) {
						options.onAcceptedKey?.(name, key);
						return true;
					}
					hostKeyError =
						check.status === "unknown"
							? new SshError("HOST_KEY_UNKNOWN", `首次连接 ${name}，请核对服务器密钥指纹 ${fingerprint}`, {
									fingerprint,
									keyType,
								})
							: new SshError(
									"HOST_KEY_MISMATCH",
									check.status === "revoked"
										? `${name} 的服务器密钥已被吊销（${check.file}）`
										: `${name} 的服务器密钥与 ${check.file} 中记录的不一致，可能存在中间人攻击。确认服务器重装过后，请先删除旧记录`,
									{ fingerprint, keyType, knownHostsFile: check.file },
								);
					return false;
				},
				authHandler: (methodsLeft: AuthenticationType[] | null, _partial: boolean, next) => {
					while (methods.length) {
						const method = methods.shift() as AnyAuthMethod;
						const wanted = method.type === "agent" ? "publickey" : method.type;
						if (!methodsLeft || methodsLeft.includes(wanted)) {
							next(method);
							return;
						}
					}
					(next as unknown as (value: false) => void)(false);
				},
				...(preferred.length ? { algorithms: { serverHostKey: { prepend: preferred } } } : {}),
			} as ConnectConfig;
			client.on("ready", () => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", abort);
				resolve(new SshSession(client));
			});
			client.on("error", (error: Error & { level?: string; code?: string }) => {
				if (hostKeyError) return fail(hostKeyError);
				if (error.level === "client-authentication")
					return fail(
						new SshError("SSH_AUTH_FAILED", `${options.username}@${options.host} 登录失败：用户名、密码或密钥不正确`),
					);
				if (error.level === "client-timeout")
					return fail(new SshError("SSH_UNREACHABLE", `连接 ${options.host}:${options.port} 超时`));
				return fail(new SshError("SSH_UNREACHABLE", `无法连接 ${options.host}:${options.port}：${error.message}`));
			});
			client.on("close", () => fail(hostKeyError ?? new SshError("SSH_UNREACHABLE", "SSH 连接已断开")));
			try {
				client.connect(config);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private channel(command: string): Promise<ClientChannel> {
		if (this.closed) return Promise.reject(new SshError("SSH_UNREACHABLE", "SSH 连接已断开"));
		return new Promise((resolve, reject) => {
			this.client.exec(command, (error, stream) => (error ? reject(error) : resolve(stream)));
		});
	}

	/** Run `command` (through the login shell), writing `stdin` and closing it. */
	async exec(command: string, stdin?: string | Buffer): Promise<ExecResult> {
		const stream = await this.channel(command);
		return new Promise<ExecResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			stream.on("data", (data: Buffer) => {
				if (stdout.length < MAX_OUTPUT) stdout += data.toString("utf8");
			});
			stream.stderr.on("data", (data: Buffer) => {
				if (stderr.length < MAX_OUTPUT) stderr += data.toString("utf8");
			});
			stream.on("close", (code: number | null) => resolve({ code: code ?? null, stdout, stderr }));
			stream.end(stdin ?? "");
		});
	}

	/** Run a POSIX `sh` script (sent on stdin, so the login shell does not matter). */
	script(source: string, args: string[] = []): Promise<ExecResult> {
		return this.exec(`sh -s -- ${args.map(shellQuote).join(" ")}`, source);
	}

	/** Start a long-running command and hand its channel to the caller. */
	open(command: string): Promise<ClientChannel> {
		return this.channel(command);
	}

	/** Stream a local file into `remotePath` with `cat` (works without SFTP). */
	async upload(localPath: string, remotePath: string, onProgress?: (sent: number, total: number) => void) {
		const total = statSync(localPath).size;
		const stream = await this.channel(`umask 077 && cat > ${shellQuote(remotePath)}`);
		await new Promise<void>((resolve, reject) => {
			let stderr = "";
			let sent = 0;
			let last = 0;
			stream.stderr.on("data", (data: Buffer) => {
				if (stderr.length < MAX_OUTPUT) stderr += data.toString("utf8");
			});
			// The channel only closes once its output was read.
			stream.resume();
			stream.on("close", (code: number | null) =>
				code === 0 ? resolve() : reject(new Error(stderr.trim() || `上传失败（退出码 ${code}）`)),
			);
			const file = createReadStream(localPath, { highWaterMark: 256 * 1024 });
			file.on("data", (chunk) => {
				sent += chunk.length;
				if (onProgress && (sent - last >= 1024 * 1024 || sent === total)) {
					last = sent;
					onProgress(sent, total);
				}
			});
			file.on("error", (error) => {
				stream.close();
				reject(error);
			});
			file.pipe(stream);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.client.end();
	}
}

/** Quote for POSIX `sh`. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
