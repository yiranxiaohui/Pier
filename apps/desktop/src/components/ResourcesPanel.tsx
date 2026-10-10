import {
	type McpDraft,
	mcpConfig,
	mcpDraft,
	NEW_SKILL_TEXT,
	RESOURCE_RUNTIME_LABEL,
	RESOURCE_SCOPE_LABEL,
} from "@pier/client";
import type {
	McpServerInfo,
	McpTestResult,
	MethodParams,
	ResourceRuntime,
	ResourceScope,
	SkillDocument,
	SkillInfo,
} from "@pier/protocol";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { hostSpeaksMinor } from "../lib/settings-target.ts";
import { useAppState, useSettingsWorkspaces, useStore } from "../lib/store.tsx";
import { IconDownload, IconLoader, IconPencil, IconPlus, IconRefresh, IconSearch, IconTrash } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

const RUNTIMES: ResourceRuntime[] = ["pi", "claude-code", "codex"];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const serverKey = (s: McpServerInfo) => `${s.runtime}:${s.scope}:${s.name}`;

export function ResourcesSettings() {
	const store = useStore();
	const workspaces = useSettingsWorkspaces();
	const version = useAppState((s) => s.agentConfigVersion + s.extensionsVersion);
	const info = useAppState((s) => s.nodes[s.settingsNode]?.hostInfo);
	const [runtime, setRuntime] = useState<ResourceRuntime>("pi");
	const [tab, setTab] = useState<"skills" | "mcp">("skills");
	const [workspaceId, setWorkspaceId] = useState("");
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [servers, setServers] = useState<McpServerInfo[]>([]);
	const [errors, setErrors] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const [query, setQuery] = useState("");
	const [tests, setTests] = useState<Record<string, McpTestResult>>({});
	const [skillEditor, setSkillEditor] = useState<{ doc?: SkillDocument }>();
	const [mcpEditor, setMcpEditor] = useState<{ server?: McpServerInfo }>();
	const [importing, setImporting] = useState(false);
	const [deleting, setDeleting] = useState<SkillInfo | McpServerInfo>();
	const target = { runtime, ...(workspaceId ? { workspaceId } : {}) };
	const supported = hostSpeaksMinor(info, 38);
	const loadId = useRef(0);

	useEffect(() => {
		if (workspaceId && !workspaces.some((w) => w.id === workspaceId)) setWorkspaceId("");
	}, [workspaceId, workspaces]);
	const load = useCallback(async () => {
		const id = ++loadId.current;
		if (!supported) return;
		setLoading(true);
		try {
			const result = await store.resourceRequest(tab === "skills" ? "skills.list" : "mcp.list", {
				runtime,
				...(workspaceId ? { workspaceId } : {}),
			});
			if (id !== loadId.current) return;
			if (tab === "skills") setSkills(result.items as SkillInfo[]);
			else setServers(result.items as McpServerInfo[]);
			setErrors(result.errors);
		} catch (e) {
			if (id === loadId.current) {
				setSkills([]);
				setServers([]);
				setErrors([errorText(e)]);
			}
		} finally {
			if (id === loadId.current) setLoading(false);
		}
	}, [store, runtime, workspaceId, tab, supported]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when another client changes resources
	useEffect(() => {
		void load();
		return () => {
			loadId.current++;
		};
	}, [load, version]);

	const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
		if (busy) return false;
		setBusy(true);
		try {
			await fn();
			await load();
			return true;
		} catch (e) {
			store.toast("error", errorText(e));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const q = query.trim().toLowerCase();
	const matches = (s: SkillInfo | McpServerInfo) =>
		`${s.name} ${s.path} ${"description" in s ? s.description : ""}`.toLowerCase().includes(q);
	const scopes = [
		{ value: "user" as const, label: "全局（所有工作区）" },
		...(workspaceId
			? [
					{ value: "project" as const, label: "项目（当前工作区）" },
					...(runtime === "claude-code" && tab === "mcp"
						? [{ value: "local" as const, label: "本地（当前项目，不共享）" }]
						: []),
				]
			: []),
	];

	if (!supported)
		return (
			<p className="settings-intro">统一 Skills 与 MCP 管理需要协议 1.38 或更高，请先更新这台电脑上的 Pier Host。</p>
		);
	return (
		<>
			<p className="settings-intro">
				管理这台电脑上 pi、Claude Code 与 Codex 的技能和 MCP 服务器。选择 Agent 后可查看全局配置及工作区配置。
			</p>
			<div className="segmented extension-tabs" role="tablist" aria-label="Agent">
				{RUNTIMES.map((r) => (
					<button
						type="button"
						role="tab"
						aria-selected={r === runtime}
						className={r === runtime ? "active" : ""}
						key={r}
						disabled={busy}
						onClick={() => {
							setRuntime(r);
							setTests({});
						}}
					>
						{RESOURCE_RUNTIME_LABEL[r]}
					</button>
				))}
			</div>
			<SettingsCard>
				<SettingRow title="查看范围" description="选择工作区后同时显示全局与项目资源。">
					<Select
						value={workspaceId}
						onChange={setWorkspaceId}
						disabled={busy}
						options={[
							{ value: "", label: "仅全局" },
							...workspaces.map((w) => ({ value: w.id, label: `全局 + ${w.name}` })),
						]}
					/>
					<button type="button" className="ghost" disabled={busy || loading} onClick={() => void load()}>
						<IconRefresh size={14} />
						刷新
					</button>
				</SettingRow>
			</SettingsCard>
			<div className="resource-toolbar">
				<div className="segmented" role="tablist" aria-label="资源类型">
					{(["skills", "mcp"] as const).map((t) => (
						<button
							type="button"
							role="tab"
							aria-selected={tab === t}
							className={tab === t ? "active" : ""}
							key={t}
							disabled={busy}
							onClick={() => setTab(t)}
						>
							{t === "skills" ? "Skills" : "MCP"}
						</button>
					))}
				</div>
				<button
					type="button"
					className="primary"
					disabled={busy}
					onClick={() => (tab === "skills" ? setSkillEditor({}) : setMcpEditor({}))}
				>
					<IconPlus size={14} />
					{tab === "skills" ? "新建技能" : "添加服务器"}
				</button>
				{tab === "skills" ? (
					<button type="button" disabled={busy} onClick={() => setImporting(true)}>
						<IconDownload size={14} />
						导入技能
					</button>
				) : null}
			</div>
			<p className="muted small">
				{runtime === "pi"
					? "修改后空闲的 pi 会话会重新加载，运行中的会话完成后执行 /reload。"
					: "修改后请新建或重新打开该 Agent 的会话。"}
				{tab === "skills" && runtime === "claude-code" ? " 停用技能通过 Claude Code 的技能权限规则生效。" : ""}
				{tab === "mcp" ? " 连接测试会在这台电脑上连接服务器，stdio 类型会启动配置的程序。" : ""}
			</p>
			<div className="provider-search extension-search">
				<IconSearch size={14} />
				<input placeholder="搜索名称或路径" value={query} onChange={(e) => setQuery(e.target.value)} />
			</div>
			{errors.map((e) => (
				<div className="banner error" key={e}>
					{e}
				</div>
			))}
			{loading ? (
				<div className="settings-empty">
					<IconLoader size={16} className="spin" />
					正在读取…
				</div>
			) : (
				<SettingsGroup>
					<SettingsCard>
						{tab === "skills"
							? skills.filter(matches).map((skill) => (
									<div className="provider-row" key={skill.path}>
										<div className="provider-main">
											<div className="provider-name">
												{skill.name}
												<span className="mini-tag">{RESOURCE_SCOPE_LABEL[skill.scope]}</span>
												{skill.shared ? <span className="mini-tag">共享目录</span> : null}
												{!skill.enabled ? <span className="mini-tag warn">已停用</span> : null}
											</div>
											<div className="muted small">{skill.description}</div>
											<div className="muted small mono resource-path">{skill.path}</div>
										</div>
										<div className="row-actions">
											<button
												type="button"
												className="ghost"
												disabled={busy}
												onClick={() =>
													void run(async () => {
														const doc = await store.resourceRequest("skills.read", { ...target, path: skill.path });
														setSkillEditor({ doc });
													})
												}
											>
												<IconPencil size={14} />
												{skill.editable ? "编辑" : "查看"}
											</button>
											{skill.deletable ? (
												<button
													type="button"
													className="ghost icon"
													title="删除技能"
													disabled={busy}
													onClick={() => setDeleting(skill)}
												>
													<IconTrash size={14} />
												</button>
											) : null}
											<Switch
												checked={skill.enabled}
												disabled={busy}
												label={skill.enabled ? `停用 ${skill.name}` : `启用 ${skill.name}`}
												onChange={(enabled) =>
													void run(() =>
														store.resourceRequest("skills.setEnabled", { ...target, path: skill.path, enabled }),
													)
												}
											/>
										</div>
									</div>
								))
							: servers.filter(matches).map((server) => (
									<div className="provider-row" key={serverKey(server)}>
										<div className="provider-main">
											<div className="provider-name">
												{server.name}
												<span className="mini-tag">{RESOURCE_SCOPE_LABEL[server.scope]}</span>
												<span className={`mini-tag${server.enabled ? "" : " warn"}`}>
													{server.enabled ? "已配置" : "已停用"}
												</span>
											</div>
											<div className="muted small">
												{server.config.command ? "stdio" : server.config.type === "sse" ? "SSE" : "HTTP"}
											</div>
											<div className="muted small mono resource-path">{server.path}</div>
											{tests[serverKey(server)] ? (
												<div className={`small ${tests[serverKey(server)]?.ok ? "muted" : "error-text"}`}>
													{tests[serverKey(server)]?.message}
												</div>
											) : null}
										</div>
										<div className="row-actions">
											<button
												type="button"
												disabled={busy}
												onClick={() =>
													void run(async () => {
														const result = await store.resourceRequest("mcp.test", {
															...target,
															scope: server.scope,
															name: server.name,
														});
														setTests((old) => ({ ...old, [serverKey(server)]: result }));
													})
												}
											>
												测试连接
											</button>
											<button type="button" className="ghost" disabled={busy} onClick={() => setMcpEditor({ server })}>
												<IconPencil size={14} />
												编辑
											</button>
											<button
												type="button"
												className="ghost icon"
												title="删除服务器"
												disabled={busy}
												onClick={() => setDeleting(server)}
											>
												<IconTrash size={14} />
											</button>
											<Switch
												checked={server.enabled}
												disabled={busy}
												label={server.enabled ? `停用 ${server.name}` : `启用 ${server.name}`}
												onChange={(enabled) =>
													void run(async () => {
														await store.resourceRequest("mcp.setEnabled", {
															...target,
															scope: server.scope,
															name: server.name,
															enabled,
															expectedRevision: server.revision,
														});
														setTests({});
													})
												}
											/>
										</div>
									</div>
								))}
						{!(tab === "skills" ? skills : servers).filter(matches).length ? (
							<div className="settings-empty">
								{q ? "没有匹配的资源" : `还没有${tab === "skills" ? "技能" : "MCP 服务器"}`}
							</div>
						) : null}
					</SettingsCard>
				</SettingsGroup>
			)}
			{skillEditor ? (
				<SkillEditor
					doc={skillEditor.doc}
					scopes={scopes.filter((s) => s.value !== "local")}
					busy={busy}
					onClose={() => !busy && setSkillEditor(undefined)}
					onSave={(name, scope, text) =>
						run(async () => {
							const doc = skillEditor.doc;
							await store.resourceRequest("skills.save", {
								...target,
								scope,
								name,
								text,
								...(doc ? { path: doc.skill.path, expectedRevision: doc.revision } : {}),
							});
							setSkillEditor(undefined);
						})
					}
				/>
			) : null}
			{importing ? (
				<ImportSkill
					scopes={scopes.filter((s) => s.value !== "local")}
					busy={busy}
					onClose={() => !busy && setImporting(false)}
					onSave={(sourcePath, scope) =>
						run(async () => {
							await store.resourceRequest("skills.import", { ...target, scope, sourcePath });
							setImporting(false);
						})
					}
				/>
			) : null}
			{mcpEditor ? (
				<McpEditor
					runtime={runtime}
					server={mcpEditor.server}
					scopes={scopes}
					busy={busy}
					onClose={() => !busy && setMcpEditor(undefined)}
					onSave={(draft, scope) =>
						run(async () => {
							const config = mcpConfig(draft, runtime) as MethodParams<"mcp.save">["config"];
							await store.resourceRequest("mcp.save", {
								...target,
								scope,
								name: draft.name,
								config,
								enabled: mcpEditor.server?.enabled ?? true,
								...(mcpEditor.server ? { expectedRevision: mcpEditor.server.revision } : { create: true }),
							});
							setTests({});
							setMcpEditor(undefined);
						})
					}
				/>
			) : null}
			{deleting ? (
				<Modal title={`删除 ${deleting.name}`} onClose={() => !busy && setDeleting(undefined)}>
					<p>{"config" in deleting ? "移除这个 MCP 服务器的配置。" : "技能目录及其脚本、资源将移入 Pier 回收站。"}</p>
					{"shared" in deleting && deleting.shared ? (
						<p>该技能位于共享目录，删除会影响读取同一目录的其他 Agent。</p>
					) : null}
					<p className="muted small mono resource-path">{deleting.path}</p>
					<div className="modal-actions">
						<button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>
							取消
						</button>
						<button
							type="button"
							className="danger"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									if ("config" in deleting)
										await store.resourceRequest("mcp.delete", {
											...target,
											scope: deleting.scope,
											name: deleting.name,
											expectedRevision: deleting.revision,
										});
									else {
										const doc = await store.resourceRequest("skills.read", { ...target, path: deleting.path });
										await store.resourceRequest("skills.delete", {
											...target,
											path: deleting.path,
											expectedRevision: doc.revision,
										});
									}
									setDeleting(undefined);
								})
							}
						>
							确认删除
						</button>
					</div>
				</Modal>
			) : null}
		</>
	);
}

type ScopeOption = { value: ResourceScope; label: string };
function SkillEditor({
	doc,
	scopes,
	busy,
	onClose,
	onSave,
}: {
	doc?: SkillDocument;
	scopes: ScopeOption[];
	busy: boolean;
	onClose: () => void;
	onSave: (name: string, scope: ResourceScope, text: string) => Promise<boolean>;
}) {
	const [name, setName] = useState(doc?.skill.name ?? "my-skill");
	const [scope, setScope] = useState<ResourceScope>(doc?.skill.scope ?? "user");
	const [text, setText] = useState(doc?.text ?? NEW_SKILL_TEXT);
	const readOnly = doc && !doc.skill.editable;
	return (
		<Modal title={doc ? `${readOnly ? "查看" : "编辑"}技能` : "新建技能"} wide onClose={onClose}>
			<form
				className="resource-form"
				onSubmit={(e) => {
					e.preventDefault();
					void onSave(name, scope, text);
				}}
			>
				{!doc ? (
					<>
						<label>
							技能目录名
							<input value={name} onChange={(e) => setName(e.target.value)} required disabled={busy} />
						</label>
						<div className="resource-field">
							<span>保存范围</span>
							<Select ariaLabel="保存范围" value={scope} options={scopes} onChange={setScope} disabled={busy} />
						</div>
					</>
				) : (
					<p className="muted small mono resource-path">{doc.skill.path}</p>
				)}
				<label>
					SKILL.md
					<textarea
						aria-label="SKILL.md"
						className="mono resource-code"
						value={text}
						onChange={(e) => setText(e.target.value)}
						readOnly={readOnly}
						disabled={busy}
						spellCheck={false}
					/>
				</label>
				<div className="modal-actions">
					<button type="button" disabled={busy} onClick={onClose}>
						关闭
					</button>
					{!readOnly ? (
						<button type="submit" className="primary" disabled={busy || !name.trim() || !text.trim()}>
							{busy ? "保存中…" : "保存"}
						</button>
					) : null}
				</div>
			</form>
		</Modal>
	);
}
function ImportSkill({
	scopes,
	busy,
	onClose,
	onSave,
}: {
	scopes: ScopeOption[];
	busy: boolean;
	onClose: () => void;
	onSave: (path: string, scope: ResourceScope) => Promise<boolean>;
}) {
	const [path, setPath] = useState("");
	const [scope, setScope] = useState<ResourceScope>("user");
	return (
		<Modal title="导入技能" onClose={onClose}>
			<form
				className="resource-form"
				onSubmit={(e) => {
					e.preventDefault();
					void onSave(path, scope);
				}}
			>
				<p className="muted small">复制这台电脑上的技能目录，包含 SKILL.md、脚本与资源。</p>
				<label>
					技能目录或 SKILL.md 路径
					<input
						className="mono"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder="/path/to/my-skill"
						required
						disabled={busy}
					/>
				</label>
				<div className="resource-field">
					<span>保存范围</span>
					<Select ariaLabel="保存范围" value={scope} options={scopes} onChange={setScope} disabled={busy} />
				</div>
				<div className="modal-actions">
					<button type="button" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button type="submit" className="primary" disabled={busy || !path.trim()}>
						导入
					</button>
				</div>
			</form>
		</Modal>
	);
}
function McpEditor({
	runtime,
	server,
	scopes,
	busy,
	onClose,
	onSave,
}: {
	runtime: ResourceRuntime;
	server?: McpServerInfo;
	scopes: ScopeOption[];
	busy: boolean;
	onClose: () => void;
	onSave: (draft: McpDraft, scope: ResourceScope) => Promise<boolean>;
}) {
	const [draft, setDraft] = useState(() => mcpDraft(server));
	const formId = useId();
	const [scope, setScope] = useState<ResourceScope>(server?.scope ?? "user");
	const field = (key: keyof McpDraft, label: string, multiline = false, placeholder?: string) => (
		<label key={key} htmlFor={`${formId}-${key}`}>
			{label}
			{multiline ? (
				<textarea
					id={`${formId}-${key}`}
					className="mono"
					value={draft[key]}
					placeholder={placeholder}
					rows={4}
					disabled={busy}
					onChange={(e) => setDraft((old) => ({ ...old, [key]: e.target.value }))}
					spellCheck={false}
				/>
			) : (
				<input
					id={`${formId}-${key}`}
					className="mono"
					value={draft[key]}
					placeholder={placeholder}
					disabled={busy || (key === "name" && Boolean(server))}
					onChange={(e) => setDraft((old) => ({ ...old, [key]: e.target.value }))}
				/>
			)}
		</label>
	);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		void onSave(draft, scope);
	};
	return (
		<Modal title={server ? "编辑 MCP 服务器" : "添加 MCP 服务器"} wide onClose={onClose}>
			<form className="resource-form" onSubmit={submit}>
				{field("name", "服务器名称", false, "filesystem")}
				{!server ? (
					<div className="resource-field">
						<span>保存范围</span>
						<Select ariaLabel="保存范围" value={scope} options={scopes} onChange={setScope} disabled={busy} />
					</div>
				) : null}
				<div className="resource-field">
					<span>连接方式</span>
					<Select
						ariaLabel="连接方式"
						value={draft.transport}
						disabled={busy}
						onChange={(transport) => setDraft((old) => ({ ...old, transport }))}
						options={[
							...(server &&
							runtime === "pi" &&
							server.scope === "project" &&
							!server.config.command &&
							!server.config.url
								? [{ value: "inherit" as const, label: "继承同名全局服务器" }]
								: []),
							{ value: "stdio", label: "stdio（启动本地程序）" },
							{ value: "http", label: "Streamable HTTP" },
							...(runtime === "claude-code" ? [{ value: "sse" as const, label: "SSE" }] : []),
						]}
					/>
				</div>
				{draft.transport === "stdio" ? (
					<>
						{field("command", "启动命令", false, "npx")}
						{field("args", "参数（每行一个）", true, "-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace")}
						{field("env", "环境变量（JSON）", true)}
					</>
				) : draft.transport === "inherit" ? (
					<p className="muted small">继承全局连接配置，仅修改启用状态与工具展示方式。</p>
				) : (
					<>
						{field("url", "服务器 URL", false, "https://example.com/mcp")}
						{field("headers", "请求头（JSON）", true)}
					</>
				)}
				<details>
					<summary>高级配置（JSON）</summary>
					{field("advanced", "其他选项，保存时保留", true)}
				</details>
				<div className="modal-actions">
					<button type="button" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button type="submit" className="primary" disabled={busy || !draft.name.trim()}>
						{busy ? "保存中…" : "保存"}
					</button>
				</div>
			</form>
		</Modal>
	);
}
