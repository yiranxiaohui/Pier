import { UPDATE_ROUTES } from "@pier/client";
import type { AppUpdateStatus } from "@pier/protocol";
import { type ReactNode, useEffect, useState } from "react";
import type { UpdateStatus } from "../lib/bridge.ts";
import { formatBytes, relativeTime } from "../lib/format.ts";
import { type AppState, LOCAL_NODE, useAppState, useSettingsTarget, useStore } from "../lib/store.tsx";
import { IconAlert, IconCheck, IconDownload, IconGithub, IconLoader, IconRefresh, Logo } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

export const RELEASES_URL = "https://github.com/yiranxiaohui/Pier/releases";

/** An update is waiting for the user (or being installed). */
export function updatePending(update: UpdateStatus | AppUpdateStatus): boolean {
	return (
		update.state === "available" ||
		update.state === "downloading" ||
		update.state === "installing" ||
		(update.state === "error" && !!update.version)
	);
}

/** Download progress in percent, when the size is known. */
function downloadPercent(update: UpdateStatus | AppUpdateStatus): number | undefined {
	const total = update.total ?? 0;
	return total ? Math.min(100, Math.round((update.downloaded / total) * 100)) : undefined;
}

/** Part of the pending update is downloaded already; installing continues from there. */
function downloadPaused(update: UpdateStatus | AppUpdateStatus): boolean {
	return (update.state === "available" || update.state === "error") && !!update.version && update.downloaded > 0;
}

/**
 * The update card in the navigation rail: shows that a new version is out, its
 * download / install progress, and a one-click install, so nobody has to look for it in the
 * settings. Renders nothing while no update is pending.
 */
export function SidebarUpdate() {
	const store = useStore();
	const update = useAppState((s) => s.update);
	const [busySessions, setBusySessions] = useState<number | undefined>(undefined);
	const [checking, setChecking] = useState(false);
	const pending = updatePending(update) && !!update.version;
	const working = update.state === "downloading" || update.state === "installing";
	const confirm = !!busySessions && !working;

	// A new pending version (or a finished install attempt) starts over without the warning.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the version or state changes.
	useEffect(() => setBusySessions(undefined), [update.version, update.state]);

	if (!pending) return null;

	const install = async () => {
		if (!confirm) {
			// Warn before stopping agents that are still working.
			setChecking(true);
			const count = await store.busySessionCount().catch(() => 0);
			setChecking(false);
			if (count) {
				setBusySessions(count);
				return;
			}
		}
		setBusySessions(undefined);
		void store.installUpdate();
	};

	const percent = downloadPercent(update);
	const paused = downloadPaused(update);
	let title: string;
	let detail: string;
	let tone = "";
	if (update.state === "downloading") {
		title = percent === undefined ? "正在下载更新…" : `正在下载 ${percent}%`;
		detail = update.error ?? `Pier v${update.version}`;
	} else if (update.state === "installing") {
		title = "正在安装更新…";
		detail = "完成后 Pier 会自动重启";
	} else if (update.state === "error") {
		title = "更新失败";
		detail = update.error ?? `Pier v${update.version} 安装失败`;
		tone = " error";
	} else if (confirm) {
		title = `${busySessions} 个会话正在运行`;
		detail = "更新会中断它们，重启后可继续";
		tone = " warning";
	} else if (paused) {
		title = `新版本 v${update.version}`;
		detail =
			percent === undefined
				? "下载已暂停，可继续下载"
				: update.downloaded >= (update.total ?? 0)
					? "更新包已下载"
					: `已下载 ${percent}%，可继续下载`;
	} else {
		title = `新版本 v${update.version}`;
		detail = `当前 v${update.currentVersion}`;
	}

	return (
		<div className={`sidebar-update${tone}`}>
			<button
				type="button"
				className="sidebar-update-info"
				title="查看更新详情"
				onClick={() => store.openSettings("about", LOCAL_NODE)}
			>
				<span className="sidebar-update-icon">
					{working ? (
						<IconLoader size={14} className="spin" />
					) : update.state === "error" || confirm ? (
						<IconAlert size={14} />
					) : (
						<IconDownload size={14} />
					)}
				</span>
				<span className="sidebar-update-text">
					<span className="sidebar-update-title">{title}</span>
					<span className="sidebar-update-detail">{detail}</span>
				</span>
			</button>
			{update.state === "downloading" ? (
				<button
					type="button"
					className="sidebar-update-action"
					title="暂停下载，之后可以从中断处继续"
					onClick={() => void store.pauseUpdate()}
				>
					暂停
				</button>
			) : working ? null : (
				<button
					type="button"
					className={`sidebar-update-action ${confirm ? "danger" : "primary"}`}
					disabled={checking}
					title={
						confirm
							? "中断正在运行的会话并更新"
							: paused
								? "从中断处继续下载并安装更新，完成后自动重启"
								: "下载并安装更新，完成后自动重启"
					}
					onClick={() => void install()}
					onBlur={() => setBusySessions(undefined)}
				>
					{confirm ? "仍然更新" : update.state === "error" ? "重试" : paused ? "继续" : "更新"}
				</button>
			)}
			{update.state === "downloading" ? (
				<div className="sidebar-update-track">
					<div
						className={`update-progress-bar${percent === undefined ? " indeterminate" : ""}`}
						style={percent === undefined ? undefined : { width: `${percent}%` }}
					/>
				</div>
			) : null}
		</div>
	);
}

/**
 * Download / install progress, or how much of a paused download is already there. `where` names
 * the Pier that restarts once installed (this one by default).
 */
function Progress({ update, where = " Pier " }: { update: UpdateStatus | AppUpdateStatus; where?: string }) {
	const total = update.total ?? 0;
	const percent = downloadPercent(update);
	const working = update.state === "downloading" || update.state === "installing";
	const amount = total
		? `${formatBytes(update.downloaded)} / ${formatBytes(total)}（${percent}%）`
		: formatBytes(update.downloaded);
	let text: string;
	if (update.state === "installing") text = `正在安装，完成后${where}会自动重启…`;
	else if (update.state === "downloading") text = total ? `正在下载 ${amount}` : `正在下载 ${amount}…`;
	else if (total && update.downloaded >= total) text = `更新包已下载（${formatBytes(total)}），重试时直接安装`;
	else text = `已下载 ${amount}，继续更新时从中断处接着下载`;
	return (
		<div className="update-progress">
			{working || percent !== undefined ? (
				<div className="update-progress-track">
					<div
						className={`update-progress-bar${percent === undefined ? " indeterminate" : ""}`}
						style={percent === undefined ? undefined : { width: `${percent}%` }}
					/>
				</div>
			) : null}
			<div className="muted small">{text}</div>
			{update.state === "downloading" && update.error ? (
				<div className="small update-warning">{update.error}</div>
			) : null}
		</div>
	);
}

/**
 * The updater status of a computer: this one's, or a paired one's while it is online and can be
 * updated from here. Returns the stored objects, so it can be used as a store selector.
 */
export function computerUpdateStatus(
	node: string,
	state: Pick<AppState, "update" | "peerUpdates" | "nodes">,
): UpdateStatus | AppUpdateStatus | undefined {
	if (node === LOCAL_NODE) return state.update;
	const entry = state.peerUpdates[node];
	return state.nodes[node]?.connection === "open" && !entry?.tooOld ? entry?.status : undefined;
}

/** Opens the GitHub Releases page; the button flips to name GitHub on hover. */
function ReleasesRow() {
	const store = useStore();
	return (
		<SettingRow title="发布说明" description="在 GitHub Releases 查看所有版本和安装包。">
			<button
				type="button"
				className="github-flip"
				// Both faces' words, the front one first, so the name holds what is on screen.
				aria-label="查看版本（前往 GitHub）"
				onClick={() => store.openExternal(RELEASES_URL)}
			>
				<span className="github-flip-icon">
					<IconGithub size={16} />
				</span>
				{/* Hover or focus rolls the front face up and the GitHub face into view. */}
				<span className="github-flip-cube" aria-hidden="true">
					<span className="github-flip-face front">查看版本</span>
					<span className="github-flip-face top">前往 GitHub</span>
				</span>
			</button>
		</SettingRow>
	);
}

/**
 * The “about and updates” page of a paired computer: its Pier's version, and checking for and
 * installing updates there through its host.
 */
function RemoteUpdateSettings() {
	const store = useStore();
	const target = useSettingsTarget();
	const node = target.node;
	const online = target.online;
	const entry = useAppState((s) => s.peerUpdates[node]);
	// The version it reported when last paired or connected, while it cannot be reached now.
	const knownVersion = useAppState((s) => s.peers.find((peer) => peer.id === node)?.version);
	const [busySessions, setBusySessions] = useState(0);
	const [confirm, setConfirm] = useState(false);
	const status = online && !entry?.tooOld ? entry?.status : undefined;
	const checking = status?.state === "checking" || entry?.busy === "check";
	const installing = status?.state === "downloading" || status?.state === "installing";
	const working = installing || entry?.busy === "install";
	const pending = !!status && updatePending(status);
	const paused = !!status && downloadPaused(status);
	const version = status?.currentVersion ?? target.hostInfo?.version ?? knownVersion;

	// Read its updater state once it is reachable, then look for a newer release, as this
	// computer's page does when it opens.
	useEffect(() => {
		if (!online) return;
		let alive = true;
		void store.loadPeerUpdate(node).then(() => {
			const current = store.getState().peerUpdates[node];
			const state = current?.status?.state;
			if (!alive || !state || current.tooOld || current.busy || current.installing) return;
			if (state === "downloading" || state === "installing" || state === "checking" || state === "unsupported") {
				return;
			}
			void store.checkPeerUpdate(node, true);
		});
		return () => {
			alive = false;
		};
	}, [store, node, online]);

	// Warn before stopping agents that are still working there.
	useEffect(() => {
		if (!pending || working) return;
		let alive = true;
		void store.busySessionCount(node).then((count) => {
			if (alive) setBusySessions(count);
		});
		return () => {
			alive = false;
		};
	}, [store, node, pending, working]);

	const install = () => {
		if (busySessions && !confirm) {
			setConfirm(true);
			return;
		}
		setConfirm(false);
		void store.installPeerUpdate(node);
	};

	let body: ReactNode = null;
	if (!online) {
		body = entry?.installing ? (
			<div className="update-state">
				<IconLoader size={18} className="spin" />
				<span>
					正在安装{entry.installing.to ? ` Pier v${entry.installing.to}` : "更新"}，那台电脑上的 Pier
					重启后会自动重新连接…
				</span>
			</div>
		) : (
			<p className="muted">
				{target.revoked
					? `${target.name} 已移除这台电脑（或重置了 Pier），需要重新配对后才能检查和安装它的更新。`
					: target.connectError
						? `无法连接到 ${target.name}：${target.connectError}。重新连接后才能检查和安装更新。`
						: `正在连接 ${target.name}，连接后会读取它的更新状态…`}
			</p>
		);
	} else if (entry?.tooOld) {
		body = (
			<div className="banner warning inline">
				{`${target.name} 上的 Pier ${version ? `v${version} ` : ""}版本较旧，不支持远程更新（需要协议 1.13 或更高）。请先在那台电脑上更新一次，之后即可在这里更新。`}
			</div>
		);
	} else if (!status) {
		body = (
			<div className="update-state">
				<IconLoader size={18} className="spin" />
				<span>正在读取更新状态…</span>
			</div>
		);
	} else if (status.state === "unsupported") {
		body = (
			<p className="muted">
				{status.error ??
					"那台电脑的 Pier 不能在这里远程更新（单文件版、开发版本或未经打包的构建）。单文件版请在那台电脑上运行 pier update，下载慢时可加 --mirror ghfast 选择线路。"}
			</p>
		);
	} else if (checking && !working) {
		body = (
			<div className="update-state">
				<IconLoader size={18} className="spin" />
				<span>正在检查更新…</span>
			</div>
		);
	} else if (pending) {
		body = (
			<>
				<div className="update-headline">
					<span className="update-badge">
						<IconDownload size={18} />
					</span>
					<div>
						<div className="update-title">Pier {status.version ? `v${status.version}` : "新版本"} 可以更新</div>
						<div className="muted small">
							当前版本 v{status.currentVersion}
							{status.date ? ` · 发布于 ${relativeTime(status.date)}` : ""}
						</div>
					</div>
				</div>
				{status.notes ? (
					<div className="update-notes">
						<Markdown text={status.notes} />
					</div>
				) : null}
				{installing || paused ? <Progress update={status} where="那台电脑上的 Pier " /> : null}
				{status.state === "error" && status.error ? <div className="banner error inline">{status.error}</div> : null}
				{!working ? (
					<p className={`muted small${confirm ? " update-warning" : ""}`}>
						{busySessions
							? `那台电脑上有 ${busySessions} 个会话正在运行或等待审批。安装更新会停止那里的 Pier Host 并中断它们，Pier 重启后可以继续这些会话。`
							: "安装时会停止那台电脑上的 Pier Host，完成后 Pier 自动重启，本机随后自动重新连接，会话记录不受影响。"}
						{status.installNeedsAuth ? "安装时需要有人在那台电脑上输入管理员密码。" : ""}
					</p>
				) : null}
			</>
		);
	} else if (status.state === "upToDate") {
		body = (
			<div className="update-state ok">
				<IconCheck size={18} />
				<span>Pier v{status.currentVersion} 已是最新版本</span>
			</div>
		);
	} else if (status.state === "error") {
		body = <div className="banner error inline">{status.error ?? "检查更新失败"}</div>;
	}

	let action: ReactNode = null;
	if (!online) {
		if (entry?.installing || target.connection === "connecting") action = <IconLoader size={16} className="spin" />;
		else if (target.revoked) {
			action = (
				<button type="button" onClick={() => store.openAddPeer()}>
					重新配对
				</button>
			);
		} else {
			action = (
				<button type="button" onClick={() => store.retryNode(node)}>
					<IconRefresh size={14} />
					重新连接
				</button>
			);
		}
	} else if (!status || status.state === "unsupported" || working || checking) {
		action = null;
	} else if (pending) {
		action = (
			<>
				<button type="button" onClick={() => void store.checkPeerUpdate(node)}>
					<IconRefresh size={14} />
					重新检查
				</button>
				<button
					type="button"
					className={confirm ? "danger" : "primary"}
					onClick={install}
					onBlur={() => setConfirm(false)}
				>
					<IconDownload size={14} />
					{confirm ? "仍然更新" : status.state === "error" ? "重试安装" : paused ? "继续更新" : "更新并重启"}
				</button>
			</>
		);
	} else {
		action = (
			<button type="button" onClick={() => void store.checkPeerUpdate(node)}>
				{status.state === "error" ? <IconAlert size={14} /> : <IconRefresh size={14} />}
				{status.state === "error" ? "重试" : "检查更新"}
			</button>
		);
	}

	return (
		<>
			<SettingsCard className="about-card">
				<div className="about-head">
					<Logo size={44} />
					<div className="about-text">
						<div className="about-name">Pier</div>
						<div className="muted small">运行在 {target.name} 上</div>
						<div className="muted small">
							{version ? `版本 v${version}` : "版本未知"}
							{status?.lastChecked && !checking ? ` · 上次检查 ${relativeTime(status.lastChecked)}` : ""}
						</div>
					</div>
					{action}
				</div>
				{body ? <div className="about-body">{body}</div> : null}
			</SettingsCard>
			<SettingsGroup title="更新">
				<SettingsCard>
					{status && status.state !== "unsupported" ? (
						<SettingRow
							title="自动检查更新"
							description="开启后，那台电脑上的 Pier 启动时及每 6 小时检查一次。这一开关和更新线路只能在那台电脑上修改。"
						>
							<span className="setting-value">{status.autoCheck ? "已开启" : "已关闭"}</span>
						</SettingRow>
					) : null}
					<ReleasesRow />
				</SettingsCard>
				<p className="muted small settings-note">
					在这里更新时，那台电脑上的 Pier
					会下载并校验官方发布的更新包、安装，然后自动重启，本机随后自动重新连接。重启或退出 Pier 只能在那台电脑上进行。
				</p>
			</SettingsGroup>
		</>
	);
}

function UpdateRouteSettings() {
	const store = useStore();
	const update = useAppState((s) => s.update);
	const current = update.mirrorPrefix ?? "";
	const selected = UPDATE_ROUTES.find((route) => route.prefix === current)?.id ?? "custom";
	const [prefix, setPrefix] = useState(current);
	const [editing, setEditing] = useState(false);
	const busy = update.state === "downloading" || update.state === "installing";

	useEffect(() => setPrefix(current), [current]);

	return (
		<>
			<SettingRow title="更新线路" description="检查更新和下载安装包都使用所选线路，自动检查也会沿用此设置。">
				<Select
					ariaLabel="更新线路"
					value={editing ? "custom" : selected}
					disabled={busy}
					options={[
						...UPDATE_ROUTES.map((route) => ({
							value: route.id,
							label: route.prefix ? `${route.label}（${new URL(route.prefix).hostname}）` : route.label,
						})),
						{ value: "custom" as const, label: "自定义加速线路" },
					]}
					onChange={(value) => {
						if (value === "custom") {
							setEditing(true);
						} else {
							const route = UPDATE_ROUTES.find((route) => route.id === value);
							if (!route) return;
							setEditing(false);
							void store.setUpdateMirror(route.prefix);
						}
					}}
				/>
			</SettingRow>
			{editing || selected === "custom" ? (
				<SettingRow
					title="加速地址"
					description="填写支持在地址后附加完整 GitHub 链接的 HTTPS 加速服务，保存后生效并重新检查更新。"
					stack
				>
					<form
						className="update-route-form"
						onSubmit={(event) => {
							event.preventDefault();
							void store.setUpdateMirror(prefix).then((saved) => {
								if (saved) setEditing(false);
							});
						}}
					>
						<input
							type="url"
							aria-label="更新加速地址"
							placeholder="https://mirror.example/"
							value={prefix}
							disabled={busy}
							onChange={(event) => setPrefix(event.target.value)}
						/>
						<button type="submit" disabled={busy || !prefix.trim()}>
							保存并检查
						</button>
					</form>
				</SettingRow>
			) : null}
		</>
	);
}

/** The “about and updates” settings page of the computer chosen in the settings screen. */
export function UpdateSettings() {
	const target = useSettingsTarget();
	return target.local ? <LocalUpdateSettings /> : <RemoteUpdateSettings />;
}

/** The “about and updates” page of this computer: this app's own updater. */
function LocalUpdateSettings() {
	const store = useStore();
	const update = useAppState((s) => s.update);
	const [busySessions, setBusySessions] = useState(0);
	const [confirm, setConfirm] = useState(false);
	const pending = updatePending(update);
	const working = update.state === "downloading" || update.state === "installing";
	const paused = downloadPaused(update);

	// Refresh cached releases when opening the page, including an already pending update.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the page opens.
	useEffect(() => {
		if (!working && update.state !== "unsupported" && update.state !== "checking") {
			void store.checkForUpdates();
		}
	}, []);

	// Warn before stopping agents that are still working.
	useEffect(() => {
		if (!pending || working) return;
		let alive = true;
		void store.busySessionCount().then((count) => {
			if (alive) setBusySessions(count);
		});
		return () => {
			alive = false;
		};
	}, [store, pending, working]);

	const install = () => {
		if (busySessions && !confirm) {
			setConfirm(true);
			return;
		}
		setConfirm(false);
		void store.installUpdate();
	};

	let body: ReactNode = null;
	if (update.state === "unsupported") {
		body = (
			<p className="muted">
				{update.error ??
					"当前是开发版本或未经打包的构建，无法自动更新。正式版本请从 GitHub Releases 下载安装包，之后即可在应用内更新。"}
			</p>
		);
	} else if (update.state === "checking") {
		body = (
			<div className="update-state">
				<IconLoader size={18} className="spin" />
				<span>正在检查更新…</span>
			</div>
		);
	} else if (pending && update.version) {
		body = (
			<>
				<div className="update-headline">
					<span className="update-badge">
						<IconDownload size={18} />
					</span>
					<div>
						<div className="update-title">Pier v{update.version} 可以更新</div>
						<div className="muted small">
							当前版本 v{update.currentVersion}
							{update.date ? ` · 发布于 ${relativeTime(update.date)}` : ""}
						</div>
					</div>
				</div>
				{update.notes ? (
					<div className="update-notes">
						<Markdown text={update.notes} />
					</div>
				) : null}
				{working || paused ? <Progress update={update} /> : null}
				{update.state === "error" && update.error ? <div className="banner error inline">{update.error}</div> : null}
				{!working ? (
					<p className={`muted small${confirm ? " update-warning" : ""}`}>
						{busySessions
							? `有 ${busySessions} 个会话正在运行或等待审批。安装更新会停止 Pier Host 并中断它们，Pier 重启后可以继续这些会话。`
							: "安装时会停止 Pier Host，完成后 Pier 自动重启，会话记录不受影响。"}
					</p>
				) : null}
			</>
		);
	} else if (update.state === "upToDate") {
		body = (
			<div className="update-state ok">
				<IconCheck size={18} />
				<span>Pier v{update.currentVersion} 已是最新版本</span>
			</div>
		);
	} else if (update.state === "error") {
		body = <div className="banner error inline">{update.error ?? "检查更新失败"}</div>;
	}

	const action =
		pending && !working ? (
			<>
				<button type="button" onClick={() => void store.checkForUpdates()}>
					<IconRefresh size={14} />
					重新检查
				</button>
				<button type="button" className={confirm ? "danger" : "primary"} onClick={install}>
					<IconDownload size={14} />
					{confirm ? "仍然更新" : update.state === "error" ? "重试安装" : paused ? "继续更新" : "更新并重启"}
				</button>
			</>
		) : update.state === "downloading" ? (
			<button type="button" onClick={() => void store.pauseUpdate()}>
				暂停下载
			</button>
		) : working || update.state === "unsupported" ? null : update.state === "checking" ? (
			<button type="button" onClick={() => void store.cancelUpdateCheck()}>
				取消检查
			</button>
		) : (
			<button type="button" onClick={() => void store.checkForUpdates()}>
				{update.state === "error" ? <IconAlert size={14} /> : <IconRefresh size={14} />}
				{update.state === "error" ? "重试" : "检查更新"}
			</button>
		);

	return (
		<>
			<SettingsCard className="about-card">
				<div className="about-head">
					<Logo size={44} />
					<div className="about-text">
						<div className="about-name">Pier</div>
						<div className="muted small">编码 Agent 的跨设备工作台</div>
						<div className="muted small">
							版本 v{update.currentVersion}
							{update.lastChecked && update.state !== "checking"
								? ` · 上次检查 ${relativeTime(update.lastChecked)}`
								: ""}
						</div>
					</div>
					{action}
				</div>
				{body ? <div className="about-body">{body}</div> : null}
			</SettingsCard>
			<SettingsGroup title="更新">
				<SettingsCard>
					{update.state !== "unsupported" ? <UpdateRouteSettings /> : null}
					{update.state !== "unsupported" ? (
						<SettingRow title="自动检查更新" description="启动时及每 6 小时检查一次，发现新版本时提醒你。">
							<Switch
								label="自动检查更新"
								checked={update.autoCheck}
								onChange={(checked) => void store.setUpdateAutoCheck(checked)}
							/>
						</SettingRow>
					) : null}
					<ReleasesRow />
				</SettingsCard>
			</SettingsGroup>
		</>
	);
}
