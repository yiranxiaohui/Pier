import {
	PierProtocolError,
	type SshAddFailure,
	type SshAddProgress,
	type SshAddResult,
	type SshAddStep,
	type SshHostKeyInfo,
} from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../lib/format.ts";
import { parseSshTarget } from "../lib/ssh-target.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { IconAlert, IconCheck, IconLoader } from "./Icons.tsx";

const STEPS: { step: SshAddStep; label: string }[] = [
	{ step: "connect", label: "登录" },
	{ step: "detect", label: "检查系统" },
	{ step: "download", label: "下载" },
	{ step: "upload", label: "上传" },
	{ step: "install", label: "安装" },
	{ step: "start", label: "启动" },
	{ step: "pair", label: "配对" },
];

type AuthKind = "password" | "key";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Sign in to a Linux computer over SSH; Pier installs itself there when needed and pairs. */
export function SshAddPeerForm({ onClose, onBusyChange }: { onClose: () => void; onBusyChange(busy: boolean): void }) {
	const store = useStore();
	const remote = useAppState((s) => s.remote);
	const [target, setTarget] = useState("");
	const [portText, setPortText] = useState("22");
	const [username, setUsername] = useState("root");
	const [authKind, setAuthKind] = useState<AuthKind>("password");
	const [password, setPassword] = useState("");
	const [keyPath, setKeyPath] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [useRelay, setUseRelay] = useState(true);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<SshAddProgress | undefined>();
	const [reached, setReached] = useState<Set<SshAddStep>>(new Set());
	const [error, setError] = useState<string | undefined>();
	const [hostKey, setHostKey] = useState<SshHostKeyInfo | undefined>();
	const [result, setResult] = useState<SshAddResult | undefined>();
	const operation = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (!remote) void store.loadRemote();
	}, [remote, store]);
	useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
	// Closing the dialog stops a running operation.
	useEffect(
		() => () => {
			if (operation.current) store.cancelSshAddPeer(operation.current);
		},
		[store],
	);

	const relay = remote?.relay?.enabled && remote.relay.url ? remote.relay : undefined;
	const parsed = parseSshTarget(target);
	const port = parsed.port ?? Number(portText);
	const user = parsed.username ?? username.trim();
	const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
	const ready =
		parsed.host.length > 0 &&
		/^[\w.:%-]+$/.test(parsed.host) &&
		portValid &&
		/^[\w.@-]+$/.test(user) &&
		(authKind === "key" || password.length > 0);

	const submit = async (acceptFingerprint?: string) => {
		if (!ready || busy) return;
		const operationId = crypto.randomUUID();
		operation.current = operationId;
		setBusy(true);
		setError(undefined);
		setHostKey(undefined);
		setProgress(undefined);
		setReached(new Set());
		try {
			const auth =
				authKind === "password"
					? { type: "password" as const, password }
					: {
							type: "key" as const,
							...(keyPath.trim() ? { privateKeyPath: keyPath.trim() } : {}),
							...(passphrase ? { passphrase } : {}),
						};
			const done = await store.sshAddPeer(
				{
					host: parsed.host,
					port,
					username: user,
					auth,
					relay: useRelay,
					...(acceptFingerprint ? { hostKeyFingerprint: acceptFingerprint } : {}),
				},
				operationId,
				(update) => {
					setProgress(update);
					setReached((steps) => (steps.has(update.step) ? steps : new Set([...steps, update.step])));
				},
			);
			if (done.warnings.length) setResult(done);
			else onClose();
		} catch (e) {
			if (operation.current !== operationId) return;
			const data =
				e instanceof PierProtocolError
					? (e.data as (Partial<Omit<SshHostKeyInfo, "reason">> & { reason?: SshAddFailure }) | undefined)
					: undefined;
			if (data?.reason === "HOST_KEY_UNKNOWN" && data.fingerprint) setHostKey(data as SshHostKeyInfo);
			else if (data?.reason !== "CANCELLED") setError(errorMessage(e));
		} finally {
			if (operation.current === operationId) {
				operation.current = undefined;
				setBusy(false);
			}
		}
	};
	const cancel = () => {
		if (operation.current) store.cancelSshAddPeer(operation.current);
	};
	const chooseKey = async () => {
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const path = await open({ multiple: false, title: "选择 SSH 私钥文件" });
			if (typeof path === "string") setKeyPath(path);
		} catch {
			setError("无法打开文件选择器，请直接填写私钥文件的完整路径");
		}
	};

	if (result) {
		return (
			<>
				<div className="ssh-add">
					<div className="ssh-add-done">
						<IconCheck size={16} />
						已添加 {result.peer.name}
						{result.version ? `（Pier ${result.version}）` : ""}
					</div>
					{result.warnings.map((warning) => (
						<div key={warning} className="banner warning inline">
							{warning}
						</div>
					))}
				</div>
				<div className="modal-actions">
					<button type="button" className="primary" onClick={onClose}>
						完成
					</button>
				</div>
			</>
		);
	}

	const percent =
		progress?.total && progress.transferred !== undefined
			? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
			: undefined;
	return (
		<>
			<div className="ssh-add">
				<p className="muted">
					通过 SSH 登录一台 Linux 电脑（x86_64 / arm64）：没有 Pier 时自动安装与本机相同版本的 Pier
					后台服务，开启它的局域网访问并自动完成配对，无需在那台电脑上确认。密码和私钥只用于这次登录，不会保存。
				</p>
				<div className="form-grid ssh-add-grid">
					<label className="form-field ssh-add-host">
						<span className="field-label">主机</span>
						<input
							className="mono"
							placeholder="192.168.1.20 或 user@host"
							value={target}
							disabled={busy}
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => setTarget(e.target.value)}
						/>
					</label>
					<label className="form-field">
						<span className="field-label">端口</span>
						<input
							className="mono"
							inputMode="numeric"
							value={parsed.port ? String(parsed.port) : portText}
							disabled={busy || parsed.port !== undefined}
							onChange={(e) => setPortText(e.target.value.replace(/\D/g, ""))}
						/>
					</label>
					<label className="form-field">
						<span className="field-label">用户名</span>
						<input
							className="mono"
							value={parsed.username ?? username}
							disabled={busy || parsed.username !== undefined}
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => setUsername(e.target.value)}
						/>
					</label>
					<div className="form-field">
						<span className="field-label">认证方式</span>
						<div className="segmented" role="tablist" aria-label="认证方式">
							{(["password", "key"] as const).map((kind) => (
								<button
									key={kind}
									type="button"
									role="tab"
									aria-selected={authKind === kind}
									className={authKind === kind ? "active" : ""}
									disabled={busy}
									onClick={() => setAuthKind(kind)}
								>
									{kind === "password" ? "密码" : "密钥"}
								</button>
							))}
						</div>
					</div>
					{authKind === "password" ? (
						<label className="form-field wide">
							<span className="field-label">密码</span>
							<input
								type="password"
								autoComplete="off"
								value={password}
								disabled={busy}
								onChange={(e) => setPassword(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void submit();
								}}
							/>
						</label>
					) : (
						<>
							<div className="form-field wide">
								<span className="field-label">私钥文件（留空时使用 SSH agent 和 ~/.ssh 中的默认密钥）</span>
								<div className="port-row">
									<input
										className="mono"
										placeholder="~/.ssh/id_ed25519"
										value={keyPath}
										disabled={busy}
										spellCheck={false}
										onChange={(e) => setKeyPath(e.target.value)}
									/>
									<button type="button" disabled={busy} onClick={() => void chooseKey()}>
										选择…
									</button>
								</div>
							</div>
							<label className="form-field wide">
								<span className="field-label">私钥密码（私钥未加密时留空）</span>
								<input
									type="password"
									autoComplete="off"
									value={passphrase}
									disabled={busy}
									onChange={(e) => setPassphrase(e.target.value)}
								/>
							</label>
						</>
					)}
				</div>
				<label className="ssh-add-relay">
					<input
						type="checkbox"
						checked={Boolean(relay) && useRelay}
						disabled={busy || !relay}
						onChange={(e) => setUseRelay(e.target.checked)}
					/>
					<span>
						直连不通时经中继连接
						<span className="muted small">
							{relay
								? `：那台电脑没有开启中继时，使用本机的中继服务器 ${relay.url}${relay.hasToken ? "（包括访问令牌）" : ""}`
								: "：本机还没有开启中继服务器，可在「设置 → 设备与远程 → 中继服务器」中设置"}
						</span>
					</span>
				</label>

				{busy ? (
					<div className="ssh-add-progress">
						<ol className="ssh-add-steps">
							{STEPS.filter(({ step }) => reached.has(step) || ["connect", "detect", "pair"].includes(step)).map(
								({ step, label }) => {
									const current = progress?.step === step;
									const done = reached.has(step) && !current;
									return (
										<li key={step} className={current ? "current" : done ? "done" : ""}>
											{current ? (
												<IconLoader size={12} className="spin" />
											) : done ? (
												<IconCheck size={12} />
											) : (
												<span className="ssh-add-dot" />
											)}
											{label}
										</li>
									);
								},
							)}
						</ol>
						{progress ? (
							<div className="muted small">
								{progress.message}
								{progress.transferred !== undefined
									? ` ${formatBytes(progress.transferred)}${progress.total ? ` / ${formatBytes(progress.total)}` : ""}`
									: ""}
							</div>
						) : null}
						{progress?.step === "download" || progress?.step === "upload" ? (
							<div className="update-progress-track">
								<div
									className={`update-progress-bar${percent === undefined ? " indeterminate" : ""}`}
									style={percent === undefined ? undefined : { width: `${percent}%` }}
								/>
							</div>
						) : null}
					</div>
				) : null}

				{hostKey ? (
					<div className="banner warning inline ssh-add-hostkey">
						<div>
							<IconAlert size={14} /> 首次连接这台服务器，请核对它的 SSH 密钥指纹（{hostKey.keyType}）：
						</div>
						<div className="mono">{hostKey.fingerprint}</div>
						<div className="small">
							可在服务器上运行 <span className="mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</span>{" "}
							查看。确认一致后继续，Pier 会记住这台服务器。
						</div>
					</div>
				) : null}
				{error ? <div className="banner error inline ssh-add-error">{error}</div> : null}
			</div>
			<div className="modal-actions">
				{busy ? (
					<button type="button" onClick={cancel}>
						停止
					</button>
				) : (
					<button type="button" onClick={onClose}>
						取消
					</button>
				)}
				{hostKey && !busy ? (
					<button type="button" className="primary" onClick={() => void submit(hostKey.fingerprint)}>
						信任并继续
					</button>
				) : (
					<button type="button" className="primary" disabled={!ready || busy} onClick={() => void submit()}>
						{busy ? "正在添加…" : "连接并添加"}
					</button>
				)}
			</div>
		</>
	);
}
