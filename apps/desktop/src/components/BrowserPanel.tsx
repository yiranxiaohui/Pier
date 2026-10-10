import type { LocalBrowserInfo, WorkspaceInfo } from "@pier/protocol";
import { useEffect, useState } from "react";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { IconExternal, IconGlobe, IconLoader, IconTrash } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

/** Open pages locally while the workspace computer serves their data or supplies the network. */
export function BrowserButton({ workspace }: { workspace?: WorkspaceInfo }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className="ghost icon"
				title="浏览器：在本地操作这台电脑上的网页"
				disabled={!workspace}
				onClick={() => setOpen(true)}
			>
				<IconGlobe size={17} />
			</button>
			{open && workspace ? <BrowserPanel workspace={workspace} onClose={() => setOpen(false)} /> : null}
		</>
	);
}

function BrowserPanel({ workspace, onClose }: { workspace: WorkspaceInfo; onClose(): void }) {
	const store = useStore();
	const node = store.nodeOf(workspace.id);
	const name = store.nodeName(node);
	const [mode, setMode] = useState<"service" | "network">("service");
	const [url, setUrl] = useState("http://localhost:3000");
	const [controlled, setControlled] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [browsers, setBrowsers] = useState<LocalBrowserInfo[]>([]);
	const local = store.nodeClient(LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	useEffect(() => {
		let active = true;
		const refresh = () => {
			void local?.request("browser.list").then(
				(result) => {
					if (active) setBrowsers(result.browsers);
				},
				() => {},
			);
		};
		refresh();
		const timer = setInterval(refresh, 3000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [local]);
	const openBrowser = async () => {
		if (!local) return;
		setBusy(true);
		setError("");
		try {
			const info = await local.request(
				"browser.open",
				{
					workspaceId: workspace.id,
					...(node === LOCAL_NODE ? {} : { peerId: node }),
					url,
					mode,
					controlled,
				},
				{ timeoutMs: 60_000 },
			);
			setBrowsers((result) => [...result.filter((row) => row.browserId !== info.browserId), info]);
			if (mode === "service" && !controlled) store.openExternal(info.localUrl);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal title={`浏览器 · ${name}`} onClose={onClose}>
			<form
				className="browser-form"
				onSubmit={(e) => {
					e.preventDefault();
					void openBrowser();
				}}
			>
				<p className="muted">网页在当前电脑渲染和操作，{name} 负责提供服务或转发网络。</p>
				<div className="browser-field">
					<span>打开方式</span>
					<Select
						value={mode}
						disabled={busy}
						onChange={setMode}
						title="打开方式"
						options={[
							{ value: "service", label: "开发服务 · 转发指定端口" },
							{ value: "network", label: "远程网络 · 独立浏览器" },
						]}
					/>
				</div>
				<label>
					网页地址
					<input
						value={url}
						disabled={busy}
						placeholder="http://localhost:3000"
						onChange={(e) => setUrl(e.target.value)}
						required
					/>
				</label>
				<p className="muted small">
					{mode === "service"
						? "localhost 指工作区所在电脑。支持 WebSocket 和热更新；依赖多个端口、原始域名或 HTTPS 证书的网页，请选择远程网络方式。"
						: "使用本地 Chrome / Chromium / Edge，通过所选电脑访问网页。保留网页原地址，登录状态按主机保存在本地。"}
				</p>
				<label className="browser-consent">
					<input
						type="checkbox"
						checked={controlled}
						disabled={busy}
						onChange={(e) => setControlled(e.target.checked)}
					/>
					允许这个工作区的 pi 操作独立浏览器
				</label>
				{controlled ? <p className="muted small">pi 可以读取页面、点击、输入和截图，沿用工作区审批策略。</p> : null}
				{error ? (
					<div className="banner error" role="alert">
						{error}
					</div>
				) : null}
				<button type="submit" className="primary" disabled={busy || !local || !online}>
					{busy ? <IconLoader size={15} className="spin" /> : <IconExternal size={15} />}
					{busy ? "正在打开…" : "在本地打开"}
				</button>
			</form>
			{browsers.length ? (
				<div className="browser-connections">
					<h4>已打开的连接</h4>
					{browsers.map((browser) => (
						<div key={browser.browserId} className="browser-connection">
							<div>
								<strong>{browser.peerId ? store.nodeName(browser.peerId) : "本机"}</strong>
								<span title={browser.url}>{browser.url}</span>
								<small className="muted">
									{browser.controllable ? "允许 Agent 操作" : browser.mode === "service" ? "端口转发" : "独立浏览器"}
								</small>
							</div>
							{browser.mode === "service" && !browser.controllable ? (
								<button
									type="button"
									className="ghost icon"
									title="重新打开网页"
									onClick={() => store.openExternal(browser.localUrl)}
								>
									<IconExternal size={15} />
								</button>
							) : null}
							<button
								type="button"
								className="ghost icon"
								title="关闭连接和独立浏览器"
								onClick={() => {
									void local?.request("browser.close", { browserId: browser.browserId }).then(
										() => setBrowsers((rows) => rows.filter((r) => r.browserId !== browser.browserId)),
										(error) => setError(String(error)),
									);
								}}
							>
								<IconTrash size={15} />
							</button>
						</div>
					))}
				</div>
			) : null}
			<p className="muted small">关闭此面板不影响网页；退出 Pier 或远程连接断开会关闭转发和独立浏览器。</p>
		</Modal>
	);
}
