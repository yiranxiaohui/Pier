import type {
	AgentConfigFile,
	AgentConfigResult,
	AgentConfigRuntime,
	AgentConfigScope,
	WorkspaceInfo,
} from "@pier/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	AGENT_CONFIG_META,
	agentUnhandledKeys,
	CLAUDE_ENV_GROUP,
	CODEX_BUILTIN_PROVIDERS,
	codexProfileIds,
	codexProviderFields,
	codexProviderIds,
	SCOPE_LABEL,
	validateConfigText,
	validProviderId,
} from "../lib/agent-config.ts";
import {
	builtinDefault,
	type FieldDef,
	fieldMatches,
	filterGroups,
	getPath,
	type SettingsChange,
	type SettingsObject,
	sameValue,
} from "../lib/config-fields.ts";
import { useAppState, useSettingsWorkspaces, useStore } from "../lib/store.tsx";
import { AgentInstallCard } from "./AgentInstallCard.tsx";
import { ConfigGroups, FieldRow, resolveFallback, TextFileEditor } from "./ConfigFields.tsx";
import {
	IconAlert,
	IconBraces,
	IconInfo,
	IconLoader,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconSliders,
	IconTrash,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

type Mode = "form" | "text";

function errorText(error: unknown): string {
	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message))
		return "当前 Pier Host 版本不支持编辑这些配置，请更新 Pier";
	return message;
}

/** The file picker's value: `user`, or `<scope>:<workspaceId>`. */
function parseTarget(value: string): { scope: AgentConfigScope; workspaceId?: string } {
	const index = value.indexOf(":");
	if (index < 0) return { scope: "user" };
	return { scope: value.slice(0, index) as AgentConfigScope, workspaceId: value.slice(index + 1) };
}

function formatJson(text: string): string | undefined {
	try {
		return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
	} catch {
		return undefined;
	}
}

const WORKSPACE_FILES: Record<AgentConfigRuntime, Array<{ scope: AgentConfigScope; label: string; file: string }>> = {
	"claude-code": [
		{ scope: "project", label: "项目设置", file: ".claude/settings.json" },
		{ scope: "local", label: "本地设置", file: ".claude/settings.local.json" },
	],
	codex: [{ scope: "project", label: "项目设置", file: ".codex/config.toml" }],
};

function Intro({ runtime }: { runtime: AgentConfigRuntime }) {
	if (runtime === "claude-code") {
		return (
			<p className="settings-intro">
				可视化编辑 Claude Code 的 <code>settings.json</code>，与终端中的 <code>claude</code> 共用同一份配置。全局设置（
				<code>~/.claude/settings.json</code>）对所有项目生效，工作区的 <code>.claude/settings.json</code>{" "}
				（项目设置，通常随代码提交）覆盖全局，<code>.claude/settings.local.json</code>
				（本地设置，不提交）再覆盖项目设置。 修改会立即写入文件，对之后新建或重新打开的会话生效。
			</p>
		);
	}
	return (
		<p className="settings-intro">
			可视化编辑 Codex 的 <code>config.toml</code>，与终端中的 <code>codex</code>{" "}
			共用同一份配置，文件中的注释与格式会保留。全局设置（<code>~/.codex/config.toml</code>）对所有项目生效，工作区的{" "}
			<code>.codex/config.toml</code> 在 Codex 信任该项目时覆盖全局设置。修改会立即写入文件，对之后新建的会话生效。
		</p>
	);
}

export function ClaudeSettings() {
	return <AgentConfigPage runtime="claude-code" />;
}

export function CodexSettings() {
	return <AgentConfigPage runtime="codex" />;
}

function AgentConfigPage({ runtime }: { runtime: AgentConfigRuntime }) {
	const store = useStore();
	const meta = AGENT_CONFIG_META[runtime];
	const workspaces = useSettingsWorkspaces();
	const version = useAppState((s) => s.agentConfigVersion);
	const [target, setTarget] = useState("user");
	const [mode, setMode] = useState<Mode>("form");
	const [data, setData] = useState<AgentConfigResult>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState<string>();
	const [query, setQuery] = useState("");
	const [modelIds, setModelIds] = useState<string[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState(false);
	const { scope, workspaceId } = parseTarget(target);
	const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
	const format = data?.format ?? (runtime === "codex" ? "toml" : "json");
	const textLabel = format === "toml" ? "TOML" : "JSON";

	useEffect(() => {
		if (workspaceId && !workspaces.some((w) => w.id === workspaceId)) setTarget("user");
	}, [workspaceId, workspaces]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setData(await store.getAgentConfig(runtime, workspace?.id));
			setError(undefined);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setLoading(false);
		}
	}, [store, runtime, workspace?.id]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the host reports a change
	useEffect(() => {
		void load();
	}, [load, version]);

	const files = data && (scope === "user" || data.workspaceId === workspace?.id) ? data.files : undefined;
	const index = files ? files.findIndex((f) => f.scope === scope) : -1;
	const file = files && index >= 0 ? files[index] : undefined;
	const own = file?.settings;
	const broken = file !== undefined && file.settings === undefined;

	// Load from the managed computer, including when no workspace has been added there.
	// Config edits and refreshes can change the provider and the models its CLI offers.
	useEffect(() => {
		if (!files) return;
		let live = true;
		setModelsLoading(true);
		setModelsError(false);
		store
			.listAgentModels(runtime)
			.then((result) => {
				if (live) setModelIds(result.models.map((model) => model.id));
			})
			.catch(() => {
				if (live) setModelsError(true);
			})
			.finally(() => {
				if (live) setModelsLoading(false);
			});
		return () => {
			live = false;
		};
	}, [store, runtime, files]);
	/** Lower-precedence files, nearest first: where values come from when this file does not set them. */
	const lower = useMemo(
		() =>
			(files ?? [])
				.slice(0, Math.max(index, 0))
				.reverse()
				.map((f) => ({ settings: f.settings, name: SCOPE_LABEL[f.scope] })),
		[files, index],
	);

	// A file that cannot be parsed can only be fixed as text.
	useEffect(() => {
		if (broken) setMode("text");
	}, [broken]);

	const replaceFile = useCallback(
		(saved: AgentConfigFile) =>
			setData((current) =>
				current ? { ...current, files: current.files.map((f) => (f.scope === saved.scope ? saved : f)) } : current,
			),
		[],
	);

	/** Save changes to the edited file; `key` marks what shows the spinner. */
	const apply = async (key: string, changes: SettingsChange[]): Promise<boolean> => {
		if (saving || !file) return false;
		if (changes.every((c) => sameValue(getPath(own, c.path), c.value))) return true;
		setSaving(key);
		try {
			const result = await store.updateAgentConfig(runtime, scope, workspace?.id, changes);
			if (result) replaceFile(result.file);
			return Boolean(result);
		} finally {
			setSaving(undefined);
		}
	};

	const q = query.trim().toLowerCase();
	const groups = useMemo(
		() => filterGroups(runtime === "claude-code" ? [...meta.groups, CLAUDE_ENV_GROUP] : meta.groups, q),
		[runtime, meta.groups, q],
	);
	const extraKeys = agentUnhandledKeys(runtime, own);

	/** Values offered for Codex's provider and profile ids, from every file shown. */
	const allSettings = (files ?? []).map((f) => f.settings);
	const providerIds = [...new Set(allSettings.flatMap((s) => codexProviderIds(s)))];
	const profileIds = [...new Set(allSettings.flatMap((s) => codexProfileIds(s)))];

	const row = (field: FieldDef) => {
		const key = field.path.join(".");
		const blocked = scope !== "user" && field.globalOnly;
		const fallback = resolveFallback(field, lower, builtinDefault(field));
		const suggestions =
			key === "model" && field.kind.type === "string"
				? [...(field.kind.suggestions ?? []), ...modelIds]
				: key === "model_provider"
					? [...CODEX_BUILTIN_PROVIDERS, ...providerIds]
					: key === "profile"
						? profileIds
						: undefined;
		return (
			<FieldRow
				key={key}
				field={field}
				own={getPath(own, field.path)}
				fallback={fallback.value}
				inheritedFrom={fallback.from}
				fileName={meta.fileName}
				disabled={Boolean(blocked) || (saving !== undefined && saving !== key)}
				disabledReason={blocked ? "只能在全局设置中配置" : undefined}
				saving={saving === key}
				suggestions={suggestions}
				extra={
					key === "model" ? (
						<span className="muted small" role="status" hidden={!modelsLoading && !modelsError}>
							{modelsLoading ? "正在加载模型…" : modelsError ? "模型列表加载失败，可选择“自定义模型…”手动填写。" : null}
						</span>
					) : undefined
				}
				onChanges={(f, changes) => void apply(f.path.join("."), changes)}
			/>
		);
	};

	return (
		<>
			<Intro runtime={runtime} />
			<AgentInstallCard runtime={runtime} />

			<SettingsGroup>
				<SettingsCard>
					<SettingRow
						title="编辑的文件"
						description={
							file ? (
								<span className="mono" title={file.path}>
									{file.path}
									{file.exists ? "" : "（尚不存在，修改时创建）"}
								</span>
							) : (
								"选择全局设置或某个工作区的设置。"
							)
						}
					>
						<Select
							className="setting-select compact"
							value={target}
							disabled={saving !== undefined}
							onChange={setTarget}
							options={[
								{ value: "user", label: "全局设置" },
								...workspaces.map((w) => ({
									label: `工作区「${w.name}」`,
									options: WORKSPACE_FILES[runtime].map((option) => ({
										value: `${option.scope}:${w.id}`,
										label: `${option.label}（${option.file}）`,
									})),
								})),
							]}
						/>
						{file ? <CopyButton text={file.path} label="复制路径" iconOnly /> : null}
						<button
							type="button"
							className="ghost icon"
							title="重新读取"
							disabled={loading}
							onClick={() => void load()}
						>
							{loading ? <IconLoader size={14} className="spin" /> : <IconRefresh size={14} />}
						</button>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>

			{data && !data.available ? (
				<div className="banner info inline models-error">
					<IconInfo size={15} />
					<span>
						这台电脑上没有找到 {meta.name}（<code>{runtime === "codex" ? "codex" : "claude"}</code>{" "}
						命令）。仍然可以编辑配置文件，安装后生效。
					</span>
				</div>
			) : null}

			{error ? (
				<div className="banner error inline models-error">
					<IconAlert size={15} />
					<span>读取设置失败：{error}</span>
				</div>
			) : null}

			{file ? (
				<>
					<div className="pi-settings-toolbar">
						<div className="segmented" role="tablist" aria-label="编辑方式">
							<button
								type="button"
								role="tab"
								aria-selected={mode === "form"}
								className={mode === "form" ? "active" : ""}
								disabled={broken}
								onClick={() => setMode("form")}
							>
								<IconSliders size={13} />
								表单
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={mode === "text"}
								className={mode === "text" ? "active" : ""}
								onClick={() => setMode("text")}
							>
								<IconBraces size={13} />
								{textLabel}
							</button>
						</div>
						{mode === "form" ? (
							<div className="provider-search pi-settings-search">
								<IconSearch size={14} />
								<input placeholder="搜索设置" value={query} onChange={(e) => setQuery(e.target.value)} />
								{query ? (
									<button type="button" className="ghost icon" title="清除" onClick={() => setQuery("")}>
										<IconX size={13} />
									</button>
								) : null}
							</div>
						) : null}
					</div>

					{broken ? (
						<div className="banner error inline models-error">
							<IconAlert size={15} />
							<span>
								这个文件无法解析（{file.error}），{meta.name} 会报错或忽略其中的设置。请在下方修复后保存。
							</span>
						</div>
					) : null}

					{mode === "text" ? (
						<TextFileEditor
							key={file.path}
							file={file}
							fileName={meta.fileName}
							validate={(text) => validateConfigText(format, text)}
							format={format === "json" ? formatJson : undefined}
							emptyText={format === "json" ? "{}\n" : ""}
							placeholder={format === "json" ? "{}" : 'model = "gpt-5-codex"'}
							externalHint={`可能是终端中的 ${meta.name} 或其他设备`}
							save={(text, expected) => store.writeAgentConfig(runtime, scope, workspace?.id, text, expected)}
							onSaved={replaceFile}
							onReload={load}
						/>
					) : (
						<>
							{runtime === "codex" && scope === "project" && workspace ? (
								<CodexTrust
									workspace={workspace}
									user={files?.[0]}
									saving={saving}
									onApply={async (changes) => {
										if (saving) return;
										setSaving("trust");
										try {
											const result = await store.updateAgentConfig("codex", "user", undefined, changes);
											if (result) replaceFile(result.file);
										} finally {
											setSaving(undefined);
										}
									}}
								/>
							) : null}
							<ConfigGroups groups={groups} searching={Boolean(q)} row={row} />
							{runtime === "codex" ? (
								<CodexProviders
									own={own}
									lower={lower}
									query={q}
									saving={saving}
									fileName={meta.fileName}
									apply={apply}
								/>
							) : null}
							{!groups.length && !(runtime === "codex" && !q) ? (
								<SettingsCard>
									<div className="settings-empty">没有匹配的设置，可以在 {textLabel} 中直接编辑。</div>
								</SettingsCard>
							) : null}
							{!q ? (
								<SettingsGroup title="其他">
									<SettingsCard>
										<SettingRow
											title="其他设置"
											description={
												extraKeys.length
													? `表单中未列出的设置：${extraKeys.join("、")}。可以在 ${textLabel} 中编辑。`
													: runtime === "claude-code"
														? "Hooks（hooks）、状态栏（statusLine）、署名（attribution）等可以在 JSON 中编辑。"
														: "MCP 服务器（mcp_servers）、配置档（profiles）、功能开关（features）等可以在 TOML 中编辑。"
											}
										>
											<button type="button" onClick={() => setMode("text")}>
												<IconBraces size={14} />
												编辑 {textLabel}
											</button>
										</SettingRow>
									</SettingsCard>
								</SettingsGroup>
							) : null}
						</>
					)}
				</>
			) : !error ? (
				<p className="muted">正在读取设置…</p>
			) : null}
		</>
	);
}

/** Codex reads a workspace's `.codex/config.toml` only for projects the user config trusts. */
function CodexTrust({
	workspace,
	user,
	saving,
	onApply,
}: {
	workspace: WorkspaceInfo;
	user: AgentConfigFile | undefined;
	saving: string | undefined;
	onApply: (changes: SettingsChange[]) => Promise<void>;
}) {
	const path = ["projects", workspace.path, "trust_level"];
	const level = getPath(user?.settings, path);
	const trusted = level === "trusted";
	const tooLong = workspace.path.length > 200;
	return (
		<SettingsGroup title="项目信任">
			<SettingsCard>
				<SettingRow
					title={
						<span className="pi-setting-title">
							信任这个项目
							{saving === "trust" ? <IconLoader size={12} className="spin" /> : null}
						</span>
					}
					description={
						<>
							<span>Codex 只在信任的项目中读取 .codex/config.toml。保存在全局设置的 </span>
							<code>projects."{workspace.path}"</code>
							<span>{user?.settings ? "" : "（全局设置无法解析，请先修复）"}</span>
						</>
					}
				>
					<Switch
						checked={trusted}
						label="信任这个项目"
						disabled={saving !== undefined || tooLong || !user?.settings}
						onChange={(checked) => void onApply([checked ? { path, value: "trusted" } : { path }])}
					/>
				</SettingRow>
			</SettingsCard>
		</SettingsGroup>
	);
}

/** Codex's `model_providers`: custom OpenAI-compatible endpoints, one card each. */
function CodexProviders({
	own,
	lower,
	query,
	saving,
	fileName,
	apply,
}: {
	own: SettingsObject | undefined;
	lower: ReadonlyArray<{ settings: SettingsObject | undefined; name: string }>;
	query: string;
	saving: string | undefined;
	fileName: string;
	apply: (key: string, changes: SettingsChange[]) => Promise<boolean>;
}) {
	const store = useStore();
	const [newId, setNewId] = useState("");
	const [confirm, setConfirm] = useState<string>();
	const ids = codexProviderIds(own);
	const inheritedIds = [...new Set(lower.flatMap((f) => codexProviderIds(f.settings)))].filter(
		(id) => !ids.includes(id),
	);
	const current =
		(typeof own?.model_provider === "string" ? own.model_provider : undefined) ??
		lower.map((f) => f.settings?.model_provider).find((v): v is string => typeof v === "string") ??
		"openai";
	const matches = (id: string) =>
		!query || id.toLowerCase().includes(query) || codexProviderFields(id).some((f) => fieldMatches(f, query));
	if (query && !"服务商 model_providers provider base_url api".includes(query) && !ids.some(matches)) return null;

	const add = async () => {
		const id = newId.trim();
		if (!validProviderId(id)) {
			store.toast("error", "服务商 ID 只能包含字母、数字、- 和 _，且以字母或数字开头");
			return;
		}
		if (ids.includes(id) || CODEX_BUILTIN_PROVIDERS.includes(id)) {
			store.toast("error", `服务商 ${id} 已经存在`);
			return;
		}
		const ok = await apply(`provider:${id}`, [
			{ path: ["model_providers", id, "name"], value: id },
			{ path: ["model_providers", id, "wire_api"], value: "responses" },
		]);
		if (ok) setNewId("");
	};

	return (
		<SettingsGroup title="服务商">
			<p className="muted small settings-note">
				兼容 OpenAI 接口的中转或自建服务（model_providers）。添加后在上方「服务商」中填写它的 ID，或点「设为当前」。
				{inheritedIds.length ? ` 其他文件中还定义了：${inheritedIds.join("、")}。` : ""}
			</p>
			{ids.filter(matches).map((id) => {
				const busy = saving !== undefined;
				return (
					<SettingsCard key={id} className="pi-settings-card config-provider">
						<SettingRow
							title={
								<span className="pi-setting-title">
									<code>{id}</code>
									{current === id ? <span className="mini-tag accent">当前使用</span> : null}
									{saving === `provider:${id}` ? <IconLoader size={12} className="spin" /> : null}
								</span>
							}
							description={<code>[model_providers.{id}]</code>}
						>
							{current === id ? null : (
								<button
									type="button"
									disabled={busy}
									onClick={() => void apply(`provider:${id}`, [{ path: ["model_provider"], value: id }])}
								>
									设为当前
								</button>
							)}
							<button
								type="button"
								className={confirm === id ? "danger" : "ghost"}
								disabled={busy}
								onClick={() => {
									if (confirm !== id) {
										setConfirm(id);
										return;
									}
									setConfirm(undefined);
									const changes: SettingsChange[] = [{ path: ["model_providers", id] }];
									if (own?.model_provider === id) changes.push({ path: ["model_provider"] });
									void apply(`provider:${id}`, changes);
								}}
								onBlur={() => setConfirm((c) => (c === id ? undefined : c))}
							>
								<IconTrash size={14} />
								{confirm === id ? "确认删除" : "删除"}
							</button>
						</SettingRow>
						{codexProviderFields(id).map((field) => {
							const key = field.path.join(".");
							return (
								<FieldRow
									key={key}
									field={field}
									own={getPath(own, field.path)}
									fallback={builtinDefault(field)}
									fileName={fileName}
									disabled={saving !== undefined && saving !== key}
									saving={saving === key}
									onChanges={(f, changes) => void apply(f.path.join("."), changes)}
								/>
							);
						})}
					</SettingsCard>
				);
			})}
			<SettingsCard>
				<SettingRow title="添加服务商" description="服务商 ID，例如 relay、azure；用于 model_provider。">
					<input
						className="pi-setting-input mono"
						value={newId}
						placeholder="relay"
						disabled={saving !== undefined}
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						onChange={(e) => setNewId(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void add();
						}}
					/>
					<button type="button" disabled={!newId.trim() || saving !== undefined} onClick={() => void add()}>
						<IconPlus size={14} />
						添加
					</button>
				</SettingRow>
			</SettingsCard>
		</SettingsGroup>
	);
}
