import type { ExtensionScope, PackageManagerInfo, PiSettingsFile, PiSettingsResult } from "@pier/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type FieldDef, filterGroups, getPath, type SettingsChange, sameValue } from "../lib/config-fields.ts";
import {
	builtinDefault,
	currentPackageManager,
	isValidValue,
	parseSettingsText,
	SETTINGS_GROUPS,
	unhandledKeys,
} from "../lib/pi-settings.ts";
import { useAppState, useSettingsTarget, useSettingsWorkspaces, useStore } from "../lib/store.tsx";
import { AgentInstallCard } from "./AgentInstallCard.tsx";
import { ConfigGroups, FieldRow, TextFileEditor } from "./ConfigFields.tsx";
import { IconAlert, IconBraces, IconLoader, IconRefresh, IconSearch, IconSliders, IconX } from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup } from "./SettingsUi.tsx";

type Mode = "form" | "json";

function errorText(error: unknown): string {
	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message))
		return "当前 Pier Host 版本不支持编辑 pi 设置，请更新 Pier";
	return message;
}

function validateJson(text: string): string | undefined {
	return parseSettingsText(text).error;
}

function formatJson(text: string): string | undefined {
	const { settings } = parseSettingsText(text);
	return settings ? `${JSON.stringify(settings, null, 2)}\n` : undefined;
}

// ---- package manager detection -----------------------------------------------------------

type Detection =
	| { status: "loading"; managers?: PackageManagerInfo[] }
	| { status: "ok"; managers: PackageManagerInfo[] }
	| { status: "error"; error: string };

function detectionError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if ((error as { code?: string } | undefined)?.code === "BAD_REQUEST" && /Unknown method/.test(message))
		return "当前 Pier Host 版本不支持检测包管理器，请更新 Pier";
	return message;
}

/** npm / pnpm / bun found on the managed computer; picking one sets `npmCommand` to its full path. */
function PackageManagerPicker({
	command,
	disabled,
	onPick,
}: {
	/** The `npmCommand` in effect (undefined: pi's default, `npm`). */
	command: string[] | undefined;
	disabled: boolean;
	onPick: (command: string[]) => void;
}) {
	const store = useStore();
	const target = useSettingsTarget();
	const [detection, setDetection] = useState<Detection>({ status: "loading" });
	const detect = useCallback(async () => {
		setDetection((d) => ({ status: "loading", ...(d.status === "ok" ? { managers: d.managers } : {}) }));
		try {
			setDetection({ status: "ok", managers: await store.detectPackageManagers() });
		} catch (error) {
			setDetection({ status: "error", error: detectionError(error) });
		}
	}, [store]);
	useEffect(() => {
		void detect();
	}, [detect]);

	const managers = detection.status === "error" ? undefined : detection.managers;
	const current = managers ? currentPackageManager(command, managers) : undefined;
	return (
		<div className="pi-pm">
			<div className="pi-pm-head">
				<span className="muted small">{target.local ? "本机" : `${target.name} 上`}检测到的包管理器</span>
				<button
					type="button"
					className="ghost small"
					disabled={detection.status === "loading"}
					onClick={() => void detect()}
				>
					{detection.status === "loading" ? <IconLoader size={12} className="spin" /> : <IconRefresh size={12} />}
					重新检测
				</button>
			</div>
			{detection.status === "error" ? (
				<div className="error-text small">检测失败：{detection.error}</div>
			) : !managers ? (
				<div className="muted small">正在检测…</div>
			) : managers.length === 0 ? (
				<div className="muted small">没有找到 npm、pnpm 或 bun。安装后点「重新检测」，或在上方填写完整路径。</div>
			) : (
				<ul className="pi-pm-list">
					{managers.map((manager) => (
						<li key={manager.path} className={`pi-pm-item${manager === current ? " current" : ""}`}>
							<span className="pi-pm-name mono">{manager.name}</span>
							{manager.version ? (
								<span className="muted small mono">{manager.version}</span>
							) : (
								<span className="mini-tag warn" title={manager.error}>
									无法运行
								</span>
							)}
							{manager.name === "npm" && manager.default ? (
								<span className="mini-tag" title="未设置 npm 命令时使用这一个">
									默认
								</span>
							) : null}
							{manager.onPath ? null : (
								<span className="mini-tag" title="所在目录不在 Pier Host 的 PATH 中，需要使用完整路径">
									不在 PATH 中
								</span>
							)}
							<code className="pi-pm-path" title={manager.error ? `${manager.path}\n${manager.error}` : manager.path}>
								{manager.path}
							</code>
							{manager === current ? (
								<span className="mini-tag accent pi-pm-action">正在使用</span>
							) : (
								<button
									type="button"
									className="small pi-pm-action"
									disabled={disabled}
									title={`将 npmCommand 设为 ${manager.path}`}
									onClick={() => onPick([manager.path])}
								>
									使用
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// ---- page --------------------------------------------------------------------------------

export function PiSettings() {
	const store = useStore();
	const workspaces = useSettingsWorkspaces();
	const version = useAppState((s) => s.piSettingsVersion);
	const [workspaceId, setWorkspaceId] = useState("");
	const [mode, setMode] = useState<Mode>("form");
	const [data, setData] = useState<PiSettingsResult>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState<string>();
	const [query, setQuery] = useState("");
	const workspace = workspaces.find((w) => w.id === workspaceId);
	const scope: ExtensionScope = workspace ? "project" : "user";

	useEffect(() => {
		if (workspaceId && !workspaces.some((w) => w.id === workspaceId)) setWorkspaceId("");
	}, [workspaceId, workspaces]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setData(await store.getPiSettings(workspace?.id));
			setError(undefined);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setLoading(false);
		}
	}, [store, workspace?.id]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the host reports a change
	useEffect(() => {
		void load();
	}, [load, version]);

	const file = scope === "project" ? data?.project : data?.user;
	const own = file?.settings;
	const userSettings = data?.user.settings;
	const broken = file !== undefined && file.settings === undefined;

	// A file that cannot be parsed can only be fixed as text.
	useEffect(() => {
		if (broken) setMode("json");
	}, [broken]);

	const onChanges = async (field: FieldDef, changes: SettingsChange[]) => {
		const key = field.path.join(".");
		if (saving || !file) return;
		const change = changes[0];
		if (!change || sameValue(getPath(own, change.path), change.value)) return;
		setSaving(key);
		try {
			const result = await store.updatePiSettings(scope, workspace?.id, changes, !field.terminal);
			if (result) {
				setData((current) =>
					current
						? scope === "project" && current.project
							? { ...current, project: { ...result.file, workspaceId: current.project.workspaceId } }
							: { ...current, user: result.file }
						: current,
				);
			}
		} finally {
			setSaving(undefined);
		}
	};

	const onSaved = (saved: PiSettingsFile) =>
		setData((current) =>
			current
				? scope === "project" && current.project
					? { ...current, project: { ...saved, workspaceId: current.project.workspaceId } }
					: { ...current, user: saved }
				: current,
		);

	const q = query.trim().toLowerCase();
	const groups = useMemo(() => filterGroups(SETTINGS_GROUPS, q), [q]);
	const extraKeys = unhandledKeys(own);

	return (
		<>
			<p className="settings-intro">
				可视化编辑 pi 的 <code>settings.json</code>，与终端中的 pi 共用同一份配置。全局设置对所有工作区生效，工作区的{" "}
				<code>.pi/settings.json</code>{" "}
				覆盖全局中的同名项。修改会立即写入文件，空闲的会话随后重新加载；默认工具、传输方式等少数设置只对新会话生效。
			</p>
			<AgentInstallCard runtime="pi" />

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
								"选择全局设置或某个工作区的项目设置。"
							)
						}
					>
						<Select
							className="setting-select compact"
							value={workspaceId}
							disabled={saving !== undefined}
							onChange={setWorkspaceId}
							options={[
								{ value: "", label: "全局设置" },
								...workspaces.map((w) => ({ value: w.id, label: `工作区「${w.name}」` })),
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
								aria-selected={mode === "json"}
								className={mode === "json" ? "active" : ""}
								onClick={() => setMode("json")}
							>
								<IconBraces size={13} />
								JSON
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
							<span>这个文件不是有效的 JSON 对象（{file.error}），pi 会忽略其中的设置。请在下方修复后保存。</span>
						</div>
					) : null}

					{mode === "json" ? (
						<TextFileEditor
							key={file.path}
							file={file}
							fileName="settings.json"
							validate={validateJson}
							format={formatJson}
							emptyText={"{}\n"}
							placeholder="{}"
							externalHint="可能是终端中的 pi 或其他设备"
							save={async (text, expected) => {
								const result = await store.writePiSettings(scope, workspace?.id, text, expected);
								return result;
							}}
							onSaved={onSaved}
							onReload={load}
						/>
					) : (
						<>
							<ConfigGroups
								groups={groups}
								searching={Boolean(q)}
								row={(field) => {
									const key = field.path.join(".");
									const projectOnlyBlocked = scope === "project" && field.globalOnly;
									const inherited = scope === "project" ? getPath(userSettings, field.path) : undefined;
									const useInherited = inherited !== undefined && isValidValue(field.kind, inherited);
									const ownValue = getPath(own, field.path);
									const fallback = useInherited ? inherited : builtinDefault(field);
									const disabled = Boolean(projectOnlyBlocked) || (saving !== undefined && saving !== key);
									return (
										<FieldRow
											key={key}
											field={field}
											own={ownValue}
											fallback={fallback}
											inheritedFrom={useInherited ? "全局" : undefined}
											fileName="settings.json"
											disabled={disabled}
											disabledReason={projectOnlyBlocked ? "只能在全局设置中配置" : undefined}
											saving={saving === key}
											extra={
												field.suggest === "packageManagers" ? (
													<PackageManagerPicker
														command={
															ownValue !== undefined && isValidValue(field.kind, ownValue)
																? (ownValue as string[])
																: Array.isArray(fallback)
																	? (fallback as string[])
																	: undefined
														}
														disabled={disabled || saving === key}
														onPick={(command) => void onChanges(field, [{ path: field.path, value: command }])}
													/>
												) : undefined
											}
											onChanges={(f, changes) => void onChanges(f, changes)}
										/>
									);
								}}
							/>
							{!groups.length ? (
								<SettingsCard>
									<div className="settings-empty">没有匹配的设置，可以在 JSON 中直接编辑。</div>
								</SettingsCard>
							) : null}
							{!q ? (
								<SettingsGroup title="其他">
									<SettingsCard>
										<SettingRow
											title="扩展、技能、提示词与主题"
											description="settings.json 中的 packages、extensions、skills、prompts、themes 在上方的「扩展」中管理。"
										>
											<button type="button" onClick={() => store.openSettings("extensions")}>
												打开扩展
											</button>
										</SettingRow>
										<SettingRow
											title="默认模型"
											description={
												scope === "user"
													? `defaultProvider / defaultModel：${
															typeof own?.defaultProvider === "string" && typeof own?.defaultModel === "string"
																? `${own.defaultProvider}/${own.defaultModel}`
																: "未设置"
														}`
													: "在上方的「模型与服务商」中设置全局默认模型；工作区的默认模型可以在 JSON 中编辑。"
											}
										>
											<button type="button" onClick={() => store.openSettings("models")}>
												模型与服务商
											</button>
										</SettingRow>
										<SettingRow
											title="其他设置"
											description={
												extraKeys.length
													? `表单中未列出的设置：${extraKeys.join("、")}。可以在 JSON 中编辑（例如 modelThinkingLevels、compaction.modelOverrides）。`
													: "按模型的思考等级（modelThinkingLevels）、按模型的压缩参数（compaction.modelOverrides）等可以在 JSON 中编辑。"
											}
										>
											<button type="button" onClick={() => setMode("json")}>
												<IconBraces size={14} />
												编辑 JSON
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
