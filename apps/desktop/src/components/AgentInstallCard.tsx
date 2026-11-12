import {
	AGENT_INSTALL_SOURCES,
	type AgentConfigRuntime,
	type AgentInstallationResult,
	type AgentInstallationStatus,
} from "@pier/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_CONFIG_META } from "../lib/agent-config.ts";
import {
	addDownloadSample,
	type DownloadSample,
	downloadPercent,
	downloadProgressText,
	downloadRate,
} from "../lib/agent-install-progress.ts";
import { agentInstallSourceInfo, readAgentInstallSource, saveAgentInstallSource } from "../lib/agent-install-source.ts";
import { hostSpeaksMinor } from "../lib/settings-target.ts";
import { useAppState, useSettingsTarget, useStore } from "../lib/store.tsx";
import { IconAlert, IconDownload, IconLoader, IconRefresh } from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup } from "./SettingsUi.tsx";

const LABELS: Record<AgentInstallationStatus["state"], string> = {
	idle: "",
	checking: "正在获取最新版本…",
	downloading: "正在下载…",
	verifying: "正在校验下载文件…",
	installing: "正在安装并验证版本…",
	ready: "安装完成",
	error: "安装失败",
};

export function AgentInstallCard({ runtime }: { runtime: AgentConfigRuntime }) {
	const store = useStore();
	const target = useSettingsTarget();
	const version = useAppState((s) => s.agentConfigVersion);
	const [data, setData] = useState<AgentInstallationResult>();
	const [error, setError] = useState<string>();
	const [loadError, setLoadError] = useState<string>();
	const [starting, setStarting] = useState(false);
	const [refresh, setRefresh] = useState(0);
	// Recent byte counts of a running download, so the card can show its speed.
	const samples = useRef<DownloadSample[]>([]);
	const [rate, setRate] = useState<number>();
	const supported = hostSpeaksMinor(target.hostInfo, 32);
	// Hosts before 1.50 only download from the official route.
	const routes = hostSpeaksMinor(target.hostInfo, 50);
	const [source, setSource] = useState(() => readAgentInstallSource(target.node, runtime));
	const identity = `${target.node}:${runtime}`;
	const identityRef = useRef(identity);
	identityRef.current = identity;
	const status = data?.installation;
	const busy = starting || (status !== undefined && !["idle", "ready", "error"].includes(status.state));
	// Choosing another route restarts a download that is still slow, but never a running installation.
	const switchable =
		routes &&
		!starting &&
		status?.source !== undefined &&
		status.source !== source &&
		(status.state === "checking" || status.state === "downloading");
	const name = AGENT_CONFIG_META[runtime].name;

	// biome-ignore lint/correctness/useExhaustiveDependencies: switching computers or agents clears their previous status.
	useEffect(() => {
		setData(undefined);
		setError(undefined);
		setLoadError(undefined);
		setStarting(false);
		setSource(readAgentInstallSource(target.node, runtime));
		samples.current = [];
		setRate(undefined);
	}, [identity]);

	// Polling resumes a running job when a user reopens this page or reconnects to its Host.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh on a completed install and explicit refresh.
	useEffect(() => {
		if (!supported || !target.online) return;
		let live = true;
		let refreshInfo = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async () => {
			try {
				const request = store.getAgentInstallation(runtime, refreshInfo);
				refreshInfo = false;
				const result = await request;
				if (!live) return;
				const { installation } = result;
				samples.current =
					installation.state === "downloading"
						? addDownloadSample(samples.current, { at: Date.now(), bytes: installation.downloadedBytes ?? 0 })
						: [];
				setRate(downloadRate(samples.current));
				setData(result);
				setLoadError(undefined);
				if (!["idle", "ready", "error"].includes(installation.state)) {
					// Downloads refresh more often, so their progress moves smoothly.
					timer = setTimeout(() => void load(), installation.state === "downloading" ? 1000 : 1500);
				}
			} catch (e) {
				if (live) {
					setLoadError(e instanceof Error ? e.message : String(e));
					timer = setTimeout(() => void load(), 5000);
				}
			}
		};
		void load();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [store, runtime, identity, supported, target.online, version, refresh]);

	const install = useCallback(async () => {
		setStarting(true);
		setError(undefined);
		try {
			const result = await store.installAgent(runtime, routes ? source : undefined);
			if (identityRef.current === identity) setData(result);
		} catch (e) {
			if (identityRef.current === identity) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (identityRef.current === identity) {
				setStarting(false);
				setRefresh((n) => n + 1);
			}
		}
	}, [store, runtime, identity, routes, source]);

	const percent = downloadPercent(status);
	const downloading = status?.state === "downloading";
	const working = status !== undefined && !["idle", "ready", "error"].includes(status.state);
	const versionText = status?.version
		? `目标版本 v${status.version}${status.source && routes ? ` · 线路：${agentInstallSourceInfo(runtime, status.source).name}` : ""}`
		: undefined;
	const executable = data?.agent.executable;
	// Both POSIX shells and PowerShell accept single-quoted paths, with different quote escaping.
	const windows = target.hostInfo?.platform === "win32";
	const quoted = executable ? `'${executable.replaceAll("'", windows ? "''" : "'\\''")}'` : "";
	const login = executable ? `${windows ? "& " : ""}${quoted}${runtime === "codex" ? " login" : ""}` : undefined;

	return (
		<SettingsGroup title="安装与更新">
			<SettingsCard>
				<SettingRow
					title={
						data?.agent.available
							? `${name}${data.agent.version ? ` v${data.agent.version}` : " · 已安装"}`
							: data
								? `${name} · 未安装`
								: name
					}
					description={
						supported
							? `在${target.local ? "本机" : target.name}安装官方最新原生版本，无需 Node.js。Pier 与外部终端共用；安装后请重新打开终端。`
							: "请先更新这台电脑上的 Pier，以支持应用内安装和更新。"
					}
				>
					<button
						type="button"
						disabled={!supported || !target.online || !data || (busy && !switchable)}
						onClick={() => void install()}
					>
						{busy && !switchable ? <IconLoader size={14} className="spin" /> : <IconDownload size={14} />}
						{switchable
							? "切换线路重新下载"
							: busy
								? downloading
									? `正在下载${percent === undefined ? "…" : ` ${percent}%`}`
									: "正在安装…"
								: data?.agent.available
									? "更新到最新版本"
									: "安装"}
					</button>
					<button
						type="button"
						className="ghost icon"
						title="重新检测版本"
						disabled={!supported || !target.online || starting}
						onClick={() => setRefresh((n) => n + 1)}
					>
						<IconRefresh size={14} />
					</button>
				</SettingRow>
				{routes ? (
					<SettingRow
						title="下载线路"
						description={
							runtime === "codex"
								? "加速线路转发 GitHub 上的官方发行包，版本与 SHA-256 校验值仍从 GitHub 官方获取。"
								: "npmmirror 镜像提供与官方相同的原生程序，适合国内网络；版本与 SHA-256 校验值仍从官方获取。"
						}
					>
						<Select
							ariaLabel="下载线路"
							value={source}
							disabled={starting}
							options={AGENT_INSTALL_SOURCES[runtime].map((s) => {
								const info = agentInstallSourceInfo(runtime, s);
								return { value: s, label: `${info.name}（${info.host}）` };
							})}
							onChange={(next) => {
								setSource(next);
								saveAgentInstallSource(target.node, runtime, next);
							}}
						/>
					</SettingRow>
				) : null}
				{status && status.state !== "idle" ? (
					<SettingRow
						title={
							<span role="status">
								{downloading && percent !== undefined ? `正在下载 ${percent}%` : LABELS[status.state]}
							</span>
						}
						description={
							status.state === "error" ? (
								status.error
							) : working ? (
								<>
									<InstallProgress status={status} percent={percent} rate={rate} />
									{versionText}
								</>
							) : (
								versionText
							)
						}
					/>
				) : null}
				{error || loadError ? (
					<SettingRow
						title={
							<span className="error">
								<IconAlert size={14} /> {error || loadError}
							</span>
						}
					/>
				) : null}
				{login ? (
					<SettingRow
						title="账号登录"
						description={
							runtime === "codex"
								? "首次使用可在这台电脑的终端运行登录命令；也可以在个人中心配置接口。"
								: "首次使用可运行此命令，在 Claude Code 中执行 /login；也可以在个人中心配置接口。"
						}
					>
						<CopyButton text={login} label="复制登录命令" />
					</SettingRow>
				) : null}
				{executable ? <SettingRow title="当前程序" description={<span className="mono">{executable}</span>} /> : null}
			</SettingsCard>
		</SettingsGroup>
	);
}

/** A bar for the running job: how much is downloaded, or an indeterminate bar while it checks or installs. */
function InstallProgress({
	status,
	percent,
	rate,
}: {
	status: AgentInstallationStatus;
	percent: number | undefined;
	rate: number | undefined;
}) {
	const text = downloadProgressText(status, rate);
	return (
		<div className="agent-install-progress">
			<div className="update-progress-track">
				<div
					className={`update-progress-bar${percent === undefined ? " indeterminate" : ""}`}
					style={percent === undefined ? undefined : { width: `${percent}%` }}
				/>
			</div>
			{text ? <div className="agent-install-progress-text">{text}</div> : null}
		</div>
	);
}
