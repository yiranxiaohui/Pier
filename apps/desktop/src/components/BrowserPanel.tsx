import type { BrowserPreparation, BrowserTransport, LocalBrowserInfo, WorkspaceInfo } from "@pier/protocol";
import { BrowserPreparationSchema } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { BrowserPreparationStatus } from "./BrowserPreparationStatus.tsx";
import { IconExternal, IconGlobe, IconLoader, IconTrash } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

export function BrowserButton({ workspace }: { workspace?: WorkspaceInfo }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className="ghost icon"
				title="打开工作区主机的浏览器"
				disabled={!workspace}
				onClick={() => setOpen(true)}
			>
				<IconGlobe size={17} />
			</button>
			{open && workspace ? (
				<BrowserPanel key={workspace.id} workspace={workspace} onClose={() => setOpen(false)} />
			) : null}
		</>
	);
}

function BrowserPanel({ workspace, onClose }: { workspace: WorkspaceInfo; onClose(): void }) {
	const store = useStore();
	const node = store.nodeOf(workspace.id);
	const remote = node !== LOCAL_NODE;
	const name = store.nodeName(node);
	const [url, setUrl] = useState("http://localhost:3000");
	const [controlled, setControlled] = useState(false);
	const [transport, setTransport] = useState<BrowserTransport>("webrtc");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [preparation, setPreparation] = useState<BrowserPreparation>();
	const [lastPreparation, setLastPreparation] = useState<BrowserPreparation>();
	const preparationRevision = useRef(0);
	const [browsers, setBrowsers] = useState<LocalBrowserInfo[]>([]);
	const [activeId, setActiveId] = useState<string>();
	const [reload, setReload] = useState(0);
	const local = store.nodeClient(LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const active = browsers.find((browser) => browser.browserId === activeId && browser.mode === "remote");
	useEffect(() => {
		let mounted = true;
		const matches = (item: BrowserPreparation) =>
			item.workspaceId === workspace.id && item.peerId === (remote ? node : undefined);
		const off = local?.onEvent((frame) => {
			if (mounted && frame.event.type === "browser.preparing") {
				const parsed = BrowserPreparationSchema.safeParse(frame.event);
				if (parsed.success && matches(parsed.data)) {
					preparationRevision.current++;
					setPreparation(parsed.data);
					setLastPreparation(parsed.data);
				}
			}
		});
		const refresh = async () => {
			try {
				const revision = preparationRevision.current;
				const result = await local?.request("browser.list");
				if (!mounted || !result) return;
				// Do not overwrite a newer live event with an older in-flight poll.
				if (revision === preparationRevision.current) {
					const current = result.preparations?.find(matches);
					setPreparation(current);
					if (current) setLastPreparation(current);
				}
				const rows = result.browsers.filter(
					(b) => b.workspaceId === workspace.id && b.peerId === (remote ? node : undefined),
				);
				setBrowsers(rows);
				if (rows.some((browser) => browser.mode === "remote")) setLastPreparation(undefined);
				setActiveId((id) =>
					rows.some((b) => b.browserId === id) ? id : rows.find((b) => b.mode === "remote")?.browserId,
				);
			} catch {
				/* A disconnected host is shown by the connection indicator. */
			}
		};
		void refresh();
		const timer = setInterval(() => {
			void refresh();
		}, 3000);
		return () => {
			mounted = false;
			off?.();
			clearInterval(timer);
		};
	}, [local, node, remote, workspace.id]);
	const open = async () => {
		preparationRevision.current++;
		setLastPreparation(undefined);
		setBusy(true);
		setError("");
		try {
			const info = await store.openBrowser(workspace.id, url, controlled, transport);
			setLastPreparation(undefined);
			if (info) {
				setBrowsers((rows) => [...rows.filter((row) => row.browserId !== info.browserId), info]);
				setActiveId(info.browserId);
			} else onClose();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			preparationRevision.current++;
			setBusy(false);
			setPreparation(undefined);
		}
	};
	const switchTransport = async () => {
		if (!active || !local) return;
		setBusy(true);
		setError("");
		try {
			const info = await local.request(
				"browser.setTransport",
				{
					browserId: active.browserId,
					transport: active.transport === "webrtc" ? "websockets" : "webrtc",
				},
				{ timeoutMs: 30_000 },
			);
			setBrowsers((rows) => rows.map((row) => (row.browserId === info.browserId ? info : row)));
			setReload((value) => value + 1);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	const closeBrowser = async (browserId: string) => {
		if (!local) return;
		setBusy(true);
		setError("");
		try {
			await local.request("browser.close", { browserId }, { timeoutMs: 20_000 });
			setBrowsers((rows) => rows.filter((row) => row.browserId !== browserId));
			setActiveId((id) => (id === browserId ? undefined : id));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	const preparing = Boolean(preparation);
	const progress = preparation?.progress ?? (!active ? lastPreparation?.progress : undefined);
	const cancelPreparation = async () => {
		if (!preparation || !local) return;
		try {
			await local.request("browser.close", { browserId: preparation.browserId }, { timeoutMs: 30_000 });
			preparationRevision.current++;
			setPreparation(undefined);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<Modal
			title={`浏览器 · ${name}`}
			onClose={onClose}
			wide={Boolean(active)}
			className={active ? "browser-viewer-modal" : undefined}
		>
			{error ? (
				<div className="banner error" role="alert">
					{error}
				</div>
			) : null}
			{progress ? (
				<BrowserPreparationStatus
					progress={progress}
					running={preparing}
					onCancel={() => {
						void cancelPreparation();
					}}
				/>
			) : null}
			{active ? (
				<>
					<div className="browser-viewer-toolbar">
						<span className="muted">
							浏览器运行在 {name} · {active.transport === "webrtc" ? "低延迟连接" : "兼容连接"}
						</span>
						<button
							type="button"
							className="ghost"
							disabled={busy || !online}
							onClick={() => {
								void switchTransport();
							}}
						>
							{busy ? "正在切换…" : active.transport === "webrtc" ? "切换兼容连接" : "切换低延迟连接"}
						</button>
						<button
							type="button"
							className="ghost icon"
							title="在独立窗口中显示远程浏览器"
							onClick={() => {
								store.openExternal(active.localUrl);
								// Release the embedded controller before the external viewer chooses its size.
								onClose();
							}}
						>
							<IconExternal size={15} />
						</button>
						<button
							type="button"
							className="ghost icon"
							title="关闭浏览器会话"
							disabled={busy || preparing}
							onClick={() => {
								void closeBrowser(active.browserId);
							}}
						>
							<IconTrash size={15} />
						</button>
					</div>
					{online ? (
						<iframe
							key={`${active.browserId}:${reload}`}
							className="browser-viewer"
							title={`${name} 的远程浏览器`}
							src={active.localUrl}
							allow="autoplay; fullscreen; clipboard-read; clipboard-write"
							allowFullScreen
							referrerPolicy="no-referrer"
							sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock"
						/>
					) : (
						<div className="banner">主机连接已断开，请重新连接后打开浏览器。</div>
					)}
				</>
			) : (
				<form
					className="browser-form"
					onSubmit={(event) => {
						event.preventDefault();
						void open();
					}}
				>
					<p className="muted">
						{remote
							? `在 ${name} 上运行浏览器，在这里查看和操作。登录状态与下载文件保存在远程主机。`
							: "使用这台电脑的浏览器打开网页。"}
					</p>
					<label>
						网页地址
						<input
							value={url}
							disabled={busy || preparing}
							placeholder="http://localhost:3000"
							onChange={(event) => setUrl(event.target.value)}
							required
						/>
					</label>
					<p className="muted small">
						localhost 指{remote ? name : "这台电脑"}。{remote ? "首次使用会自动安装所需组件，之后直接启动。" : ""}
					</p>
					{remote ? (
						<div className="browser-field">
							<span>连接方式</span>
							<Select
								value={transport}
								onChange={setTransport}
								disabled={busy || preparing}
								title="连接方式"
								options={[
									{ value: "webrtc", label: "低延迟 · WebRTC" },
									{ value: "websockets", label: "兼容连接 · Pier 加密通道" },
								]}
							/>
						</div>
					) : null}
					<label className="browser-consent">
						<input
							type="checkbox"
							checked={controlled}
							disabled={busy || preparing}
							onChange={(event) => setControlled(event.target.checked)}
						/>
						允许这个工作区的 pi 操作浏览器
					</label>
					{controlled ? (
						<p className="muted small">
							{remote ? "pi 操作同一个远程浏览器。" : "将打开独立浏览器窗口。"}
							可读取页面、点击、输入和截图，沿用工作区审批策略。
						</p>
					) : null}
					<button
						type="submit"
						className="primary"
						disabled={busy || preparing || !online || ((remote || controlled) && !local)}
					>
						{busy ? <IconLoader size={15} className="spin" /> : <IconExternal size={15} />}
						{busy || preparing ? "正在准备…" : remote ? "打开远程浏览器" : "在本机打开"}
					</button>
				</form>
			)}
			{browsers.length ? (
				<details key={active ? "viewer" : "form"} className="browser-connections" open={active ? undefined : true}>
					<summary>已打开的浏览器（{browsers.length}）</summary>
					{browsers.map((browser) => (
						<div key={browser.browserId} className="browser-connection">
							<div>
								<strong>{name}</strong>
								<span title={browser.url}>{browser.url}</span>
								<small className="muted">
									{browser.mode === "remote" ? "运行在远程主机" : "本机浏览器"}
									{browser.controllable ? " · 允许 Agent 操作" : ""}
								</small>
							</div>
							{browser.mode === "remote" ? (
								<button type="button" className="ghost" onClick={() => setActiveId(browser.browserId)}>
									查看
								</button>
							) : null}
							<button
								type="button"
								className="ghost icon"
								title="关闭浏览器会话"
								disabled={busy || preparing}
								onClick={() => {
									void closeBrowser(browser.browserId);
								}}
							>
								<IconTrash size={15} />
							</button>
						</div>
					))}
				</details>
			) : null}
			{!active ? (
				<p className="muted small">
					关闭面板后可再次打开并继续操作。退出 Pier 或连接断开会结束受管理的浏览器会话，登录状态保留。
				</p>
			) : null}
		</Modal>
	);
}
