import type {
	BrowserElement,
	BrowserImage,
	BrowserPageState,
	BrowserPreparation,
	BrowserTransport,
	HostPort,
	LocalBrowserInfo,
	WorkspaceInfo,
} from "@pier/protocol";
import { BROWSER_PICK_TIMEOUT_MS, BrowserPreparationSchema } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { addressToUrl, displayUrl, type Rect, selectionContext } from "../lib/browser-context.ts";
import { portAddress, portTarget, supportsPortFeature } from "../lib/host-ports.ts";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { type AnnotationTool, BrowserAnnotator, renderAnnotated, type Stroke } from "./BrowserAnnotator.tsx";
import { BrowserPreparationStatus } from "./BrowserPreparationStatus.tsx";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition } from "./ContextMenu.tsx";
import {
	IconArrowLeft,
	IconArrowRight,
	IconBrowser,
	IconCamera,
	IconEraser,
	IconExternal,
	IconGlobe,
	IconLoader,
	IconMonitor,
	IconMoreVertical,
	IconMousePointer,
	IconPencil,
	IconPickElement,
	IconPlus,
	IconRefresh,
	IconRegion,
	IconTrash,
	IconX,
} from "./Icons.tsx";
import { Select } from "./Select.tsx";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const code = (error: unknown) => (error as { code?: unknown } | undefined)?.code;

/** How often the panel asks its browser for the tabs and history while on screen. */
const STATE_INTERVAL_MS = 1000;

/** Opens the browser of the workspace's computer in the right-hand panel. */
export function BrowserButton({ workspace }: { workspace?: WorkspaceInfo }) {
	const store = useStore();
	return (
		<button
			type="button"
			className="ghost icon"
			title="打开工作区所在电脑的浏览器"
			disabled={!workspace}
			onClick={() => workspace && store.showRightPanel("browser")}
		>
			<IconBrowser size={15} />
		</button>
	);
}

/** Listening TCP ports worth offering as pages: not the browser's own helpers or databases. */
const NOT_PAGES =
	/^(pier|pier-host|selkies|xvfb|xorg|openbox|chrome|chromium|msedge|sshd|systemd|containerd|dockerd|docker-proxy|postgres|mysqld|mariadbd|redis-server|mongod)/i;

function pagePorts(ports: HostPort[]): Array<{ url: string; label: string; process?: string | undefined }> {
	const seen = new Set<number>();
	const out: Array<{ url: string; label: string; process?: string | undefined }> = [];
	for (const port of [...ports].sort((a, b) => a.port - b.port)) {
		if (port.protocol !== "tcp" || port.port < 1024 || seen.has(port.port)) continue;
		if (port.process && NOT_PAGES.test(port.process)) continue;
		const target = portTarget(port.address);
		const loopback = target === "127.0.0.1" || target === "::1";
		const host = loopback ? "localhost" : target;
		seen.add(port.port);
		out.push({
			url: `http://${portAddress(host, port.port)}/`,
			label: portAddress(host, port.port),
			process: port.process,
		});
		if (out.length >= 8) break;
	}
	return out;
}

interface Annotation {
	tool: AnnotationTool;
	/** A pick is waiting for the user's click on the page. */
	picking: boolean;
	element?: BrowserElement | undefined;
	shot?: (BrowserImage & { page: { url: string; title: string } }) | undefined;
	region?: Rect | undefined;
	strokes: Stroke[];
	note: string;
	/** Capturing the screenshot or preparing the attachment. */
	working?: boolean;
}

const TOOLS: Array<{ id: AnnotationTool; label: string; hint: string; Icon: typeof IconMousePointer }> = [
	{ id: "select", label: "选择", hint: "在页面上点击一个元素", Icon: IconMousePointer },
	{ id: "region", label: "区域", hint: "在截图上框选一块区域", Icon: IconRegion },
	{ id: "draw", label: "画笔", hint: "在截图上标注", Icon: IconPencil },
	{ id: "erase", label: "橡皮", hint: "擦掉标注", Icon: IconEraser },
];

/**
 * The workspace browser as a tab of the right-hand panel, laid out like a browser: back, forward,
 * reload, an address bar, then picking an element or marking up a screenshot for the conversation
 * on screen (`composerKey`). A remote workspace's browser runs on that computer and its picture
 * is embedded here; a local workspace's opens in a Pier-managed window this panel drives. Only
 * one browser runs per workspace; it keeps running while the panel is closed.
 */
export function BrowserView({
	workspace,
	composerKey,
	active,
}: {
	workspace: WorkspaceInfo;
	composerKey?: string | undefined;
	/** The tab is on screen. */
	active: boolean;
}) {
	const store = useStore();
	const node = store.nodeOf(workspace.id);
	const remote = node !== LOCAL_NODE;
	const name = store.nodeName(node);
	const local = store.nodeClient(LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const [sessions, setSessions] = useState<LocalBrowserInfo[]>([]);
	const [preparation, setPreparation] = useState<BrowserPreparation>();
	const [lastPreparation, setLastPreparation] = useState<BrowserPreparation>();
	const preparationRevision = useRef(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [transport, setTransport] = useState<BrowserTransport>("webrtc");
	const [controlled, setControlled] = useState(false);
	const [reload, setReload] = useState(0);
	/** The remote picture is shown in a separate window instead of here. */
	const [external, setExternal] = useState(false);
	const [page, setPage] = useState<BrowserPageState>();
	/** Why the page cannot be driven from here (an older Host), if so. */
	const [uncontrollable, setUncontrollable] = useState("");
	const [address, setAddress] = useState("");
	const [editing, setEditing] = useState(false);
	const [menu, setMenu] = useState<ContextMenuPosition>();
	const [annotation, setAnnotation] = useState<Annotation>();
	const [ports, setPorts] = useState<ReturnType<typeof pagePorts>>([]);
	const addressInput = useRef<HTMLInputElement>(null);
	const noteInput = useRef<HTMLInputElement>(null);

	// Only the browsers Pier drives belong here (not a port opened in the system browser).
	const session = sessions.find((s) => s.mode === "remote" || s.managed);
	const sessionId = session?.browserId;
	const canControl = !!session && store.canControlBrowsers && !uncontrollable;
	const activeTab = page?.tabs.find((tab) => tab.id === page.activeTabId);
	const pageUrl = displayUrl(activeTab?.url ?? session?.url);
	const preparing = Boolean(preparation);
	const progress = preparation?.progress ?? (!session ? lastPreparation?.progress : undefined);

	// The browsers this window opened for the workspace, and the progress of one being prepared.
	useEffect(() => {
		let mounted = true;
		const matches = (item: { workspaceId: string; peerId?: string | undefined }) =>
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
				const rows = result.browsers.filter(matches);
				setSessions(rows);
				if (rows.some((browser) => browser.mode === "remote" || browser.managed)) setLastPreparation(undefined);
			} catch {
				/* A disconnected host is shown by the connection indicator. */
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 3000);
		return () => {
			mounted = false;
			off?.();
			clearInterval(timer);
		};
	}, [local, node, remote, workspace.id]);

	// A new browser starts afresh: its own page, its picture embedded, nothing being picked.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the browser changes.
	useEffect(() => {
		setPage(undefined);
		setUncontrollable("");
		setExternal(false);
		setAnnotation(undefined);
	}, [sessionId]);

	// The tabs and history while on screen.
	useEffect(() => {
		if (!sessionId || !active || !store.canControlBrowsers) return;
		let live = true;
		let pending = false;
		const tick = async () => {
			if (pending) return;
			pending = true;
			try {
				const result = await store.browserControl(sessionId, { op: "state" }, 10_000);
				if (live && result.state) setPage(result.state);
			} catch (error) {
				if (live && code(error) === "UNSUPPORTED") setUncontrollable(message(error));
			} finally {
				pending = false;
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), STATE_INTERVAL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [store, sessionId, active]);

	// The panel's toolbar stands in for the browser's own: hide its tab strip and address bar.
	useEffect(() => {
		if (!sessionId || !remote || external || !store.canControlBrowsers) return;
		store.browserControl(sessionId, { op: "fullscreen", value: true }).catch((error: unknown) => {
			if (code(error) === "UNSUPPORTED") setUncontrollable(message(error));
		});
	}, [store, sessionId, remote, external]);

	// The address bar follows the page unless the user is typing in it.
	useEffect(() => {
		if (!editing) setAddress(pageUrl);
	}, [pageUrl, editing]);

	// Listening ports on the workspace's computer, offered as pages while nothing is open.
	const workspaceClient = store.nodeClient(node);
	const canListPorts = online && supportsPortFeature(workspaceClient?.host, 39);
	useEffect(() => {
		if (session || !active || !canListPorts || !workspaceClient) return;
		let live = true;
		const refresh = async () => {
			try {
				const result = await workspaceClient.request("host.ports", {}, { timeoutMs: 15_000 });
				if (live) setPorts(pagePorts(result.ports));
			} catch {
				if (live) setPorts([]);
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 5000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [session, active, canListPorts, workspaceClient]);

	const control = async (command: Parameters<typeof store.browserControl>[1]) => {
		if (!sessionId) return undefined;
		try {
			const result = await store.browserControl(sessionId, command);
			if (result.state) setPage(result.state);
			setError("");
			return result;
		} catch (error) {
			setError(message(error));
			return undefined;
		}
	};

	const open = async (url: string) => {
		preparationRevision.current++;
		setLastPreparation(undefined);
		setBusy(true);
		setError("");
		try {
			const info = await store.openBrowser(workspace.id, url, controlled, transport, true);
			setLastPreparation(undefined);
			if (info) setSessions((rows) => [...rows.filter((row) => row.browserId !== info.browserId), info]);
		} catch (error) {
			setError(message(error));
		} finally {
			preparationRevision.current++;
			setBusy(false);
			setPreparation(undefined);
		}
	};

	const go = (input: string) => {
		const url = addressToUrl(input);
		if (!url) {
			setError("请输入网址，例如 localhost:3000");
			return;
		}
		setEditing(false);
		addressInput.current?.blur();
		if (!session) void open(url);
		else void control({ op: "navigate", url });
	};

	const closeBrowser = async () => {
		if (!local || !sessionId) return;
		setBusy(true);
		setError("");
		try {
			await local.request("browser.close", { browserId: sessionId }, { timeoutMs: 20_000 });
			setSessions((rows) => rows.filter((row) => row.browserId !== sessionId));
		} catch (error) {
			setError(message(error));
		} finally {
			setBusy(false);
		}
	};

	const switchTransport = async () => {
		if (!session || !local) return;
		setBusy(true);
		setError("");
		try {
			const info = await local.request(
				"browser.setTransport",
				{ browserId: session.browserId, transport: session.transport === "webrtc" ? "websockets" : "webrtc" },
				{ timeoutMs: 30_000 },
			);
			setSessions((rows) => rows.map((row) => (row.browserId === info.browserId ? info : row)));
			setReload((value) => value + 1);
		} catch (error) {
			setError(message(error));
		} finally {
			setBusy(false);
		}
	};

	const cancelPreparation = async () => {
		if (!preparation || !local) return;
		try {
			await local.request("browser.close", { browserId: preparation.browserId }, { timeoutMs: 30_000 });
			preparationRevision.current++;
			setPreparation(undefined);
		} catch (error) {
			setError(message(error));
		}
	};

	// ---- picking an element, marking up a screenshot ------------------------------------------

	const annotationRef = useRef(annotation);
	annotationRef.current = annotation;
	const sessionRef = useRef(sessionId);
	sessionRef.current = sessionId;
	const pickGeneration = useRef(0);

	const startPick = async () => {
		if (!sessionId) return;
		const generation = ++pickGeneration.current;
		setAnnotation((a) => (a ? { ...a, tool: "select", picking: true } : a));
		try {
			const result = await store.browserControl(sessionId, { op: "pick" }, BROWSER_PICK_TIMEOUT_MS + 10_000);
			if (generation !== pickGeneration.current || !annotationRef.current) return;
			const element = result.element;
			setAnnotation((a) => (a ? { ...a, picking: false, ...(element ? { element } : {}) } : a));
			if (element) {
				store.browserControl(sessionId, { op: "highlight", nodeId: element.nodeId }).catch(() => {});
				noteInput.current?.focus();
			}
		} catch (error) {
			if (generation !== pickGeneration.current) return;
			setAnnotation((a) => (a ? { ...a, picking: false } : a));
			setError(message(error));
		}
	};

	const stopPick = () => {
		pickGeneration.current++;
		const id = sessionRef.current;
		if (id && annotationRef.current?.picking) store.browserControl(id, { op: "cancelPick" }).catch(() => {});
	};

	const capture = async () => {
		if (!sessionId) return undefined;
		const element = annotationRef.current?.element;
		// The selection outline is not part of the page.
		if (element) await store.browserControl(sessionId, { op: "clearHighlight" }).catch(() => {});
		try {
			const result = await store.browserControl(sessionId, { op: "capture" });
			return result.image;
		} finally {
			if (element) store.browserControl(sessionId, { op: "highlight", nodeId: element.nodeId }).catch(() => {});
		}
	};

	const chooseTool = async (tool: AnnotationTool) => {
		const current = annotationRef.current;
		if (!current) return;
		if (tool === "select") {
			if (!current.picking) void startPick();
			return;
		}
		stopPick();
		if (current.shot) {
			setAnnotation({ ...current, tool, picking: false });
			return;
		}
		setAnnotation({ ...current, tool, picking: false, working: true });
		try {
			const image = await capture();
			setAnnotation((a) =>
				a && image
					? {
							...a,
							working: false,
							shot: { ...image, page: { url: activeTab?.url ?? session?.url ?? "", title: activeTab?.title ?? "" } },
						}
					: a && { ...a, working: false },
			);
		} catch (error) {
			setError(message(error));
			setAnnotation((a) => a && { ...a, tool: "select", working: false });
		}
	};

	/** Start picking or marking up; `fresh` takes a new screenshot (dropping the marks on the last one). */
	const startAnnotation = (tool: AnnotationTool, fresh = false) => {
		if (!sessionId) return;
		setError("");
		const current: Annotation = annotationRef.current ?? { tool, picking: false, strokes: [], note: "" };
		const next: Annotation = fresh ? { ...current, shot: undefined, region: undefined, strokes: [] } : current;
		annotationRef.current = next;
		setAnnotation(next);
		void chooseTool(tool);
	};

	const endAnnotation = () => {
		stopPick();
		const id = sessionRef.current;
		if (id && annotationRef.current?.element) store.browserControl(id, { op: "clearHighlight" }).catch(() => {});
		annotationRef.current = undefined;
		setAnnotation(undefined);
	};

	// Leaving the tab or the browser ends a pick in progress; the page gets its clicks back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: end it only when these change.
	useEffect(() => {
		if (!active && annotationRef.current) endAnnotation();
	}, [active]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only; it reads refs.
	useEffect(() => () => endAnnotation(), []);
	// A pick follows the tab on screen.
	const activeTabId = page?.activeTabId;
	// biome-ignore lint/correctness/useExhaustiveDependencies: restart only when the tab changes.
	useEffect(() => {
		if (annotationRef.current?.picking) {
			stopPick();
			void startPick();
		}
	}, [activeTabId]);

	const attach = async () => {
		const current = annotation;
		if (!current || !composerKey) return;
		const { element, shot, region, strokes } = current;
		const marked = shot && (region || strokes.length > 0 || !element);
		if (!element && !shot) return;
		setAnnotation({ ...current, working: true });
		try {
			const images: Array<{ data: string; mimeType: string; name: string }> = [];
			let screenshot: Parameters<typeof selectionContext>[0]["screenshot"];
			if (shot && marked) {
				const image = await renderAnnotated(shot, strokes, region);
				images.push({ ...image, name: region ? "区域截图" : "页面截图" });
				screenshot = { size: { width: shot.width, height: shot.height }, region, drawn: strokes.length > 0 };
			} else if (element?.image) {
				images.push({ data: element.image.data, mimeType: element.image.mimeType, name: element.label });
				screenshot = {
					size: { width: element.image.width, height: element.image.height },
					drawn: false,
					elementOnly: true,
				};
			}
			const pageInfo = element ? { url: element.url, title: element.title } : (shot?.page ?? { url: "", title: "" });
			const context = selectionContext(
				{ page: pageInfo, element, screenshot, note: current.note },
				`browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			);
			store.attachToComposer(composerKey, { context, images });
			endAnnotation();
		} catch (error) {
			setError(message(error));
			setAnnotation((a) => a && { ...a, working: false });
		}
	};

	// ---- menus ------------------------------------------------------------------------------

	const openExternally = async () => {
		if (!session) return;
		if (remote) {
			// Show the browser's own tab strip and address bar there; release the embedded viewer first.
			if (canControl) await store.browserControl(session.browserId, { op: "fullscreen", value: false }).catch(() => {});
			endAnnotation();
			setExternal(true);
			store.openExternal(session.localUrl);
		}
	};

	const menuItems: ContextMenuItem[] = [
		canControl && {
			label: "新标签页",
			icon: <IconPlus size={14} />,
			onSelect: () => {
				void control({ op: "newTab" }).then(() => {
					setEditing(true);
					setAddress("");
					addressInput.current?.focus();
				});
			},
		},
		(page?.tabs.length ?? 0) > 1 && "separator",
		...(page && page.tabs.length > 1
			? page.tabs.map((tab) => ({
					label: `${tab.id === page.activeTabId ? "● " : ""}${tab.title || displayUrl(tab.url) || "新标签页"}`,
					onSelect: () => void control({ op: "activateTab", tabId: tab.id }),
				}))
			: []),
		"separator",
		remote &&
			session && {
				label: session.transport === "webrtc" ? "切换为兼容连接" : "切换为低延迟连接",
				icon: <IconRefresh size={14} />,
				disabled: busy || !online,
				onSelect: () => void switchTransport(),
			},
		remote &&
			session && {
				label: external ? "在面板中显示" : "在独立窗口中显示",
				icon: external ? <IconMonitor size={14} /> : <IconExternal size={14} />,
				onSelect: () => {
					if (external) setExternal(false);
					else void openExternally();
				},
			},
		!!pageUrl &&
			/^https?:/.test(pageUrl) && {
				label: "用系统浏览器打开当前网页",
				icon: <IconGlobe size={14} />,
				onSelect: () => void store.openWorkspaceUrl(pageUrl, workspace.id),
			},
		"separator",
		session && {
			label: "关闭浏览器",
			icon: <IconTrash size={14} />,
			danger: true,
			disabled: busy || preparing,
			onSelect: () => void closeBrowser(),
		},
	];

	// ---- view -------------------------------------------------------------------------------

	const annotating = annotation !== undefined;
	const frozen = annotation?.shot && annotation.tool !== "select" ? annotation.shot : undefined;
	const canAttach = !!annotation && !annotation.working && !!composerKey && !!(annotation.element || annotation.shot);
	const navDisabled = !canControl || busy;
	const tabs = page?.tabs ?? [];
	return (
		<div className="browser-view">
			<div className="browser-toolbar">
				<button
					type="button"
					className="ghost icon"
					title="后退"
					disabled={navDisabled || !page?.canGoBack}
					onClick={() => void control({ op: "back" })}
				>
					<IconArrowLeft size={15} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title="前进"
					disabled={navDisabled || !page?.canGoForward}
					onClick={() => void control({ op: "forward" })}
				>
					<IconArrowRight size={15} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title={page?.loading ? "停止加载" : "重新加载"}
					disabled={navDisabled}
					onClick={() => void control({ op: page?.loading ? "stop" : "reload" })}
				>
					{page?.loading ? <IconX size={15} /> : <IconRefresh size={14} />}
				</button>
				<form
					className="browser-address"
					onSubmit={(event) => {
						event.preventDefault();
						go(address);
					}}
				>
					<input
						ref={addressInput}
						value={address}
						placeholder={remote ? `输入网址，localhost 指 ${name}` : "输入网址或搜索"}
						aria-label="网址"
						spellCheck={false}
						autoComplete="off"
						disabled={busy || preparing || (!!session && !canControl)}
						title={session && !canControl ? uncontrollable || "此浏览器不能从这里控制" : undefined}
						onFocus={(event) => {
							setEditing(true);
							event.currentTarget.select();
						}}
						onBlur={() => setEditing(false)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								setAddress(pageUrl);
								event.currentTarget.blur();
							}
						}}
						onChange={(event) => setAddress(event.target.value)}
					/>
					{busy || preparing ? <IconLoader size={14} className="spin" /> : null}
				</form>
				<button
					type="button"
					className={`ghost icon${annotating ? " active" : ""}`}
					title={annotating ? "结束选取" : "选取元素或标注截图，添加到对话"}
					aria-pressed={annotating}
					disabled={!canControl || external}
					onClick={() => (annotating ? endAnnotation() : startAnnotation("select"))}
				>
					<IconPickElement size={15} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title={annotating ? "重新截图" : "截图并标注"}
					disabled={!canControl || external || annotation?.working}
					onClick={() => startAnnotation("region", true)}
				>
					<IconCamera size={15} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title="更多"
					aria-haspopup="menu"
					onClick={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.right - 4, y: rect.bottom + 4, anchor: event.currentTarget });
					}}
				>
					<IconMoreVertical size={15} />
				</button>
			</div>
			{tabs.length > 1 ? (
				<div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
					{tabs.map((tab) => {
						const selected = tab.id === page?.activeTabId;
						const label = tab.title || displayUrl(tab.url) || "新标签页";
						return (
							<div key={tab.id} className={`browser-tab${selected ? " active" : ""}`}>
								<button
									type="button"
									role="tab"
									aria-selected={selected}
									className="browser-tab-label"
									title={`${label}\n${tab.url}`}
									onClick={() => void control({ op: "activateTab", tabId: tab.id })}
									onAuxClick={(event) => {
										if (event.button === 1) void control({ op: "closeTab", tabId: tab.id });
									}}
								>
									{label}
								</button>
								<button
									type="button"
									className="browser-tab-close"
									title="关闭标签页"
									aria-label={`关闭 ${label}`}
									onClick={() => void control({ op: "closeTab", tabId: tab.id })}
								>
									<IconX size={11} />
								</button>
							</div>
						);
					})}
					<button
						type="button"
						className="ghost icon browser-tab-new"
						title="新标签页"
						onClick={() => void control({ op: "newTab" })}
					>
						<IconPlus size={13} />
					</button>
				</div>
			) : null}
			{error ? (
				<div className="banner error browser-banner" role="alert">
					<span>{error}</span>
					<button type="button" className="ghost icon" title="关闭" onClick={() => setError("")}>
						<IconX size={13} />
					</button>
				</div>
			) : null}
			{session && uncontrollable ? <div className="banner browser-banner">{uncontrollable}</div> : null}
			<div className="browser-body">
				{session ? (
					remote ? (
						external ? (
							<div className="browser-empty">
								<IconExternal size={22} />
								<h3>浏览器显示在独立窗口中</h3>
								<p className="muted">关闭那个窗口后，可以回到这里继续使用。</p>
								<button type="button" onClick={() => setExternal(false)}>
									在面板中显示
								</button>
							</div>
						) : online ? (
							<iframe
								key={`${session.browserId}:${reload}`}
								className="browser-frame"
								title={`${name} 的远程浏览器`}
								src={session.localUrl}
								allow="autoplay; fullscreen; clipboard-read; clipboard-write"
								allowFullScreen
								referrerPolicy="no-referrer"
								sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock"
							/>
						) : (
							<div className="browser-empty">
								<p className="muted">主机连接已断开，重新连接后会恢复画面。</p>
							</div>
						)
					) : (
						<div className="browser-empty">
							<IconBrowser size={22} />
							<h3>{activeTab?.title || "浏览器已在独立窗口中打开"}</h3>
							{pageUrl ? <p className="muted browser-empty-url">{pageUrl}</p> : null}
							<p className="muted">
								网页显示在 Pier 打开的浏览器窗口中。这里的地址栏、前进后退、选取元素和截图都作用于那个窗口。
							</p>
						</div>
					)
				) : (
					<div className="browser-empty">
						{progress ? (
							<BrowserPreparationStatus
								progress={progress}
								running={preparing}
								onCancel={() => void cancelPreparation()}
							/>
						) : (
							<>
								<div className="browser-empty-icon">
									<IconGlobe size={22} />
								</div>
								<h3>还没有打开网页</h3>
								<p className="muted">
									{remote
										? `在上方输入网址。浏览器运行在 ${name} 上，localhost 指那台电脑，登录状态和下载也保存在那里。`
										: "在上方输入网址，Pier 会打开一个由它管理的浏览器窗口（Chrome、Chromium 或 Edge），并在这里控制它。"}
								</p>
								{ports.length ? (
									<div className="browser-ports">
										<span className="muted small">
											{remote ? `${name} 上正在监听的端口` : "这台电脑上正在监听的端口"}
										</span>
										<div className="browser-port-list">
											{ports.map((port) => (
												<button
													key={port.url}
													type="button"
													className="browser-port"
													title={port.process ? `${port.process} · ${port.url}` : port.url}
													disabled={busy || !online}
													onClick={() => {
														setAddress(displayUrl(port.url));
														void open(port.url);
													}}
												>
													<span>{port.label}</span>
													{port.process ? <span className="muted">{port.process}</span> : null}
												</button>
											))}
										</div>
									</div>
								) : null}
								<details className="browser-options">
									<summary>打开选项</summary>
									{remote ? (
										<div className="browser-field">
											<span>连接方式</span>
											<Select
												value={transport}
												onChange={setTransport}
												disabled={busy}
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
											disabled={busy}
											onChange={(event) => setControlled(event.target.checked)}
										/>
										允许外部集成通过协议操作浏览器
									</label>
									<p className="muted small">
										外部集成可通过 browser.action 读取页面、点击、输入和截图，审批由调用方负责。内置 Agent
										不提供浏览器工具。
									</p>
								</details>
							</>
						)}
					</div>
				)}
				{frozen && annotation && annotation.tool !== "select" ? (
					<BrowserAnnotator
						shot={frozen}
						tool={annotation.tool}
						region={annotation.region}
						strokes={annotation.strokes}
						onRegion={(region) => setAnnotation((a) => a && { ...a, region })}
						onStrokes={(strokes) => setAnnotation((a) => a && { ...a, strokes })}
					/>
				) : null}
				{annotation ? (
					<>
						<div className="browser-annotate-tools" role="toolbar" aria-label="选取工具">
							{TOOLS.map(({ id, label, hint, Icon }) => (
								<button
									key={id}
									type="button"
									className={annotation.tool === id ? "active" : ""}
									title={hint}
									aria-pressed={annotation.tool === id}
									disabled={annotation.working}
									onClick={() => void chooseTool(id)}
								>
									<Icon size={14} />
									<span>{label}</span>
								</button>
							))}
							<span className="browser-annotate-divider" aria-hidden="true" />
							<button type="button" title="结束选取" aria-label="结束选取" onClick={endAnnotation}>
								<IconX size={14} />
							</button>
						</div>
						<form
							className="browser-annotate-bar"
							onSubmit={(event) => {
								event.preventDefault();
								void attach();
							}}
						>
							<span className="browser-annotate-status">
								{annotation.working ? (
									<IconLoader size={13} className="spin" />
								) : annotation.picking ? (
									remote ? (
										"点击页面上的元素"
									) : (
										"在浏览器窗口中点击元素"
									)
								) : annotation.element ? (
									<span className="browser-annotate-chip" title={annotation.element.selector}>
										<IconMousePointer size={12} />
										{annotation.element.label}
									</span>
								) : annotation.shot ? (
									<span className="browser-annotate-chip">
										<IconRegion size={12} />
										{annotation.region ? "区域截图" : "页面截图"}
									</span>
								) : (
									"选择元素或标注截图"
								)}
							</span>
							<input
								ref={noteInput}
								value={annotation.note}
								placeholder="描述要修改的地方…"
								aria-label="说明"
								onChange={(event) => {
									const note = event.target.value;
									setAnnotation((a) => a && { ...a, note });
								}}
								onKeyDown={(event) => {
									if (event.key === "Escape") endAnnotation();
								}}
							/>
							<button
								type="submit"
								className="primary"
								disabled={!canAttach}
								title={composerKey ? "添加到输入框" : "打开一个会话或新建会话后才能添加"}
							>
								添加到对话
							</button>
						</form>
					</>
				) : null}
			</div>
			{menu ? (
				<ContextMenu position={menu} label="浏览器" items={menuItems} onClose={() => setMenu(undefined)} />
			) : null}
		</div>
	);
}
