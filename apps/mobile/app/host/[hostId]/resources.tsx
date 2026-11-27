import {
	type McpDraft,
	mcpConfig,
	mcpDraft,
	NEW_SKILL_TEXT,
	pluginContentsLabel,
	RESOURCE_RUNTIME_LABEL,
	RESOURCE_SCOPE_LABEL,
} from "@pier/client";
import {
	type McpServerInfo,
	type McpTestResult,
	type MethodParams,
	type PluginInfo,
	parseProtocolVersion,
	type ResourceRuntime,
	type ResourceScope,
	type SkillDocument,
	type SkillInfo,
} from "@pier/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Button, Card, Muted, Pill, Screen, Sheet } from "../../../src/components/ui.tsx";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, usePalette } from "../../../src/theme.ts";

type Editor = { kind: "skill"; doc?: SkillDocument } | { kind: "import" } | { kind: "mcp"; server?: McpServerInfo };
const RUNTIMES: ResourceRuntime[] = ["pi", "claude-code", "codex"];
type ResourceTab = "skills" | "mcp" | "plugins";
const TAB_LABEL: Record<ResourceTab, string> = { skills: "Skills", mcp: "MCP", plugins: "插件" };
const LIST_METHOD = { skills: "skills.list", mcp: "mcp.list", plugins: "plugins.list" } as const;
const keyOf = (s: McpServerInfo) => `${s.runtime}:${s.scope}:${s.name}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ResourcesScreen() {
	const store = useStore();
	const p = usePalette();
	const { hostId } = useLocalSearchParams<{ hostId: string }>();
	const host = useMobileState((s) => s.host);
	const protocol = parseProtocolVersion(host.info?.protocolVersion ?? "");
	const supported = protocol && (protocol.major > 1 || (protocol.major === 1 && protocol.minor >= 38));
	const online = host.hostId === hostId && host.connection === "open";
	const [runtime, setRuntime] = useState<ResourceRuntime>("pi");
	const [selectedTab, setTab] = useState<ResourceTab>("skills");
	const [workspaceId, setWorkspaceId] = useState("");
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [servers, setServers] = useState<McpServerInfo[]>([]);
	const [plugins, setPlugins] = useState<PluginInfo[]>([]);
	const [errors, setErrors] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const [query, setQuery] = useState("");
	const [tests, setTests] = useState<Record<string, McpTestResult>>({});
	const [editor, setEditor] = useState<Editor>();
	const [deleting, setDeleting] = useState<SkillInfo | McpServerInfo>();
	const [uninstalling, setUninstalling] = useState<PluginInfo>();
	const [keepPluginData, setKeepPluginData] = useState(false);
	const target = { runtime, ...(workspaceId ? { workspaceId } : {}) };
	// Claude Code plugins (protocol 1.74); other agents have no plugin tab.
	const pluginsSupported =
		runtime === "claude-code" && protocol && (protocol.major > 1 || (protocol.major === 1 && protocol.minor >= 74));
	// Uninstalling a plugin with the Host's `claude` CLI (protocol 1.75).
	const uninstallSupported = pluginsSupported && protocol && (protocol.major > 1 || protocol.minor >= 75);
	const tab: ResourceTab = selectedTab === "plugins" && !pluginsSupported ? "skills" : selectedTab;
	const tabs: ResourceTab[] = pluginsSupported ? ["skills", "mcp", "plugins"] : ["skills", "mcp"];
	const loadId = useRef(0);
	const load = useCallback(async () => {
		const id = ++loadId.current;
		if (!online || !supported) return;
		setLoading(true);
		// Errors of the previous agent or tab must not stay up while this list loads.
		setErrors([]);
		try {
			const result = await store.resourceRequest(LIST_METHOD[tab], {
				runtime,
				...(workspaceId ? { workspaceId } : {}),
			});
			if (id !== loadId.current) return;
			if (tab === "skills") setSkills(result.items as SkillInfo[]);
			else if (tab === "mcp") setServers(result.items as McpServerInfo[]);
			else setPlugins(result.items as PluginInfo[]);
			setErrors(result.errors);
		} catch (e) {
			if (id === loadId.current) {
				setSkills([]);
				setServers([]);
				setPlugins([]);
				setErrors([errorText(e)]);
			}
		} finally {
			if (id === loadId.current) setLoading(false);
		}
	}, [store, online, supported, runtime, tab, workspaceId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh when another client changes resources
	useEffect(() => {
		void load();
		return () => {
			loadId.current++;
		};
	}, [load, host.resourcesVersion]);
	useEffect(() => {
		if (workspaceId && !host.workspaces?.some((w) => w.id === workspaceId)) setWorkspaceId("");
	}, [workspaceId, host.workspaces]);
	const run = async (fn: () => Promise<unknown>) => {
		if (busy || !online) return false;
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
	const matches = (s: SkillInfo | McpServerInfo | PluginInfo) =>
		`${s.name} ${s.path} ${"description" in s ? s.description : ""} ${"id" in s ? s.id : ""}`
			.toLowerCase()
			.includes(query.toLowerCase());
	const shownCount = (tab === "skills" ? skills : tab === "mcp" ? servers : plugins).filter(matches).length;
	const scopes: ResourceScope[] = workspaceId
		? runtime === "claude-code" && tab === "mcp"
			? ["user", "project", "local"]
			: ["user", "project"]
		: ["user"];
	const disabled = busy || !online;
	const inputStyle = [styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.elevated }];
	return (
		<Screen>
			<Stack.Screen options={{ title: "Skills 与 MCP" }} />
			<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
				{!supported ? (
					<Muted>需要协议 1.38 或更高，请先更新这台电脑上的 Pier Host。</Muted>
				) : (
					<>
						<View style={styles.row}>
							{RUNTIMES.map((r) => (
								<Button
									key={r}
									title={RESOURCE_RUNTIME_LABEL[r]}
									small
									disabled={disabled}
									variant={r === runtime ? "primary" : "secondary"}
									onPress={() => {
										setRuntime(r);
										setTests({});
									}}
								/>
							))}
						</View>
						<Muted>查看范围</Muted>
						<ScrollView horizontal showsHorizontalScrollIndicator={false}>
							<View style={styles.row}>
								<Button
									title="仅全局"
									small
									disabled={disabled}
									variant={!workspaceId ? "primary" : "secondary"}
									onPress={() => setWorkspaceId("")}
								/>
								{host.workspaces?.map((w) => (
									<Button
										key={w.id}
										title={w.name}
										small
										disabled={disabled}
										variant={w.id === workspaceId ? "primary" : "secondary"}
										onPress={() => setWorkspaceId(w.id)}
									/>
								))}
							</View>
						</ScrollView>
						<View style={styles.row}>
							{tabs.map((t) => (
								<Button
									key={t}
									title={TAB_LABEL[t]}
									small
									disabled={disabled}
									variant={tab === t ? "primary" : "secondary"}
									onPress={() => setTab(t)}
								/>
							))}
							<Button title="刷新" small disabled={disabled || loading} onPress={() => void load()} />
						</View>
						<Muted>
							{tab === "plugins"
								? `插件在 Claude Code 中用 /plugin 或 claude plugin install 安装。${uninstallSupported ? "卸载会在这台电脑上运行 claude plugin uninstall。" : ""}停用或卸载的插件不加载它的技能、命令、Agent、Hooks 与 MCP；修改后新建或重新打开会话。`
								: runtime === "pi"
									? "空闲会话自动重新加载，运行中的会话完成后执行 /reload。"
									: "修改后新建或重新打开 Agent 会话。"}
							{tab === "skills" && runtime === "claude-code" ? " 停用通过技能权限规则生效。" : ""}
							{tab === "skills" && pluginsSupported ? " 插件中的技能只能查看。" : ""}
							{tab === "mcp" && pluginsSupported ? " 插件提供的服务器随插件启用或停用。" : ""}
						</Muted>
						<TextInput
							style={inputStyle}
							placeholder="搜索名称或路径"
							placeholderTextColor={p.muted}
							value={query}
							onChangeText={setQuery}
						/>
						{tab === "plugins" ? null : (
							<View style={styles.row}>
								<Button
									title={tab === "skills" ? "新建技能" : "添加服务器"}
									small
									variant="primary"
									disabled={disabled}
									onPress={() => setEditor(tab === "skills" ? { kind: "skill" } : { kind: "mcp" })}
								/>
								{tab === "skills" ? (
									<Button title="导入技能" small disabled={disabled} onPress={() => setEditor({ kind: "import" })} />
								) : null}
							</View>
						)}
						{errors.map((e) => (
							<Muted key={e}>{e}</Muted>
						))}
						{loading ? (
							<ActivityIndicator color={p.accentText} />
						) : tab === "skills" ? (
							skills.filter(matches).map((skill) => (
								<Card key={skill.path}>
									<Text style={[styles.name, { color: p.text }]}>{skill.name}</Text>
									<View style={styles.row}>
										<Pill text={RESOURCE_SCOPE_LABEL[skill.scope]} />
										{skill.plugin ? <Pill text="插件" /> : null}
										{skill.shared ? <Pill text="共享目录" /> : null}
										<Pill text={skill.enabled ? "已启用" : "已停用"} />
									</View>
									<Muted>{skill.description}</Muted>
									<Text style={[styles.path, { color: p.muted }]}>{skill.path}</Text>
									<View style={styles.row}>
										<Button
											title={skill.editable ? "编辑" : "查看"}
											small
											disabled={disabled}
											onPress={() =>
												void run(async () => {
													const doc = await store.resourceRequest("skills.read", { ...target, path: skill.path });
													setEditor({ kind: "skill", doc });
												})
											}
										/>
										{skill.deletable ? (
											<Button title="删除" small disabled={disabled} onPress={() => setDeleting(skill)} />
										) : null}
										<Switch
											accessibilityLabel={`启用 ${skill.name}`}
											value={skill.enabled}
											disabled={disabled}
											onValueChange={(enabled) =>
												void run(() =>
													store.resourceRequest("skills.setEnabled", { ...target, path: skill.path, enabled }),
												)
											}
										/>
									</View>
								</Card>
							))
						) : tab === "mcp" ? (
							servers.filter(matches).map((server) => (
								<Card key={keyOf(server)}>
									<Text style={[styles.name, { color: p.text }]}>{server.name}</Text>
									<View style={styles.row}>
										<Pill text={RESOURCE_SCOPE_LABEL[server.scope]} />
										{server.plugin ? <Pill text="插件" /> : null}
										<Pill text={server.enabled ? "已配置" : "已停用"} />
									</View>
									<Text style={[styles.path, { color: p.muted }]}>{server.path}</Text>
									{tests[keyOf(server)] ? <Muted>{tests[keyOf(server)]?.message}</Muted> : null}
									{server.plugin ? null : (
										<View style={styles.row}>
											<Button
												title="测试连接"
												small
												disabled={disabled}
												onPress={() =>
													void run(async () => {
														const result = await store.resourceRequest("mcp.test", {
															...target,
															name: server.name,
															scope: server.scope,
														});
														setTests((old) => ({ ...old, [keyOf(server)]: result }));
													})
												}
											/>
											<Button
												title="编辑"
												small
												disabled={disabled}
												onPress={() => setEditor({ kind: "mcp", server })}
											/>
											<Button title="删除" small disabled={disabled} onPress={() => setDeleting(server)} />
											<Switch
												accessibilityLabel={`启用 ${server.name}`}
												value={server.enabled}
												disabled={disabled}
												onValueChange={(enabled) =>
													void run(async () => {
														await store.resourceRequest("mcp.setEnabled", {
															...target,
															name: server.name,
															scope: server.scope,
															enabled,
															expectedRevision: server.revision,
														});
														setTests({});
													})
												}
											/>
										</View>
									)}
								</Card>
							))
						) : (
							plugins.filter(matches).map((plugin) => (
								<Card key={plugin.id}>
									<Text style={[styles.name, { color: p.text }]}>{plugin.name}</Text>
									<View style={styles.row}>
										{plugin.version ? <Pill text={plugin.version} /> : null}
										<Pill text={RESOURCE_SCOPE_LABEL[plugin.scope]} />
										{plugin.marketplace ? <Pill text={plugin.marketplace} /> : null}
										<Pill text={plugin.enabled ? "已启用" : "已停用"} />
									</View>
									{plugin.description ? <Muted>{plugin.description}</Muted> : null}
									<Muted>{pluginContentsLabel(plugin)}</Muted>
									<Text style={[styles.path, { color: p.muted }]}>{plugin.path}</Text>
									<View style={styles.row}>
										{uninstallSupported ? (
											<Button
												title="卸载"
												small
												disabled={disabled}
												onPress={() => {
													setKeepPluginData(false);
													setUninstalling(plugin);
												}}
											/>
										) : null}
										<Switch
											accessibilityLabel={`启用 ${plugin.name}`}
											value={plugin.enabled}
											disabled={disabled}
											onValueChange={(enabled) =>
												void run(() =>
													store.resourceRequest("plugins.setEnabled", { ...target, id: plugin.id, enabled }),
												)
											}
										/>
									</View>
								</Card>
							))
						)}
						{!loading && !shownCount ? (
							<Muted>
								{query
									? "没有匹配的资源"
									: tab === "plugins"
										? "还没有安装 Claude Code 插件。"
										: "还没有资源，点击上方按钮添加。"}
							</Muted>
						) : null}
						{tab === "mcp" ? <Muted>测试连接会连接服务器，stdio 类型会在这台电脑上启动配置的程序。</Muted> : null}
					</>
				)}
			</ScrollView>
			{editor ? (
				<ResourceEditor
					editor={editor}
					runtime={runtime}
					scopes={scopes}
					busy={disabled}
					onClose={() => !busy && setEditor(undefined)}
					onSave={(name, scope, text, draft) =>
						run(async () => {
							if (editor.kind === "import")
								await store.resourceRequest("skills.import", { ...target, scope, sourcePath: text });
							else if (editor.kind === "skill")
								await store.resourceRequest("skills.save", {
									...target,
									scope,
									name,
									text,
									...(editor.doc ? { path: editor.doc.skill.path, expectedRevision: editor.doc.revision } : {}),
								});
							else if (draft) {
								const config = mcpConfig(draft, runtime) as MethodParams<"mcp.save">["config"];
								await store.resourceRequest("mcp.save", {
									...target,
									scope,
									name: draft.name,
									config,
									enabled: editor.server?.enabled ?? true,
									...(editor.server ? { expectedRevision: editor.server.revision } : { create: true }),
								});
								setTests({});
							}
							setEditor(undefined);
						})
					}
				/>
			) : null}
			{deleting ? (
				<Sheet onClose={() => !busy && setDeleting(undefined)}>
					<Text style={[styles.name, { color: p.text }]}>删除 {deleting.name}</Text>
					<Muted>
						{"config" in deleting
							? "移除这个 MCP 服务器的配置。"
							: deleting.shared
								? "将技能目录移入回收站。该共享技能的删除会影响其他读取同一目录的 Agent。"
								: "技能及其脚本、资源将移入 Pier 回收站。"}
					</Muted>
					<View style={styles.row}>
						<Button title="取消" disabled={disabled} onPress={() => setDeleting(undefined)} />
						<Button
							title="确认删除"
							variant="danger"
							disabled={disabled}
							onPress={() =>
								void run(async () => {
									if ("config" in deleting)
										await store.resourceRequest("mcp.delete", {
											...target,
											name: deleting.name,
											scope: deleting.scope,
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
						/>
					</View>
				</Sheet>
			) : null}
			{uninstalling ? (
				<Sheet onClose={() => !busy && setUninstalling(undefined)}>
					<Text style={[styles.name, { color: p.text }]}>卸载 {uninstalling.name}</Text>
					<Muted>
						将在这台电脑上运行 claude plugin uninstall，从{RESOURCE_SCOPE_LABEL[uninstalling.scope]}
						范围卸载这个插件，它的技能、命令、Agent、Hooks 与 MCP 不再加载。已打开的 Claude Code 会话需要重新打开。
					</Muted>
					<View style={styles.row}>
						<Switch
							accessibilityLabel="保留插件数据"
							value={keepPluginData}
							disabled={disabled}
							onValueChange={setKeepPluginData}
						/>
						<Muted>保留插件数据（重新安装后可以继续使用）</Muted>
					</View>
					<View style={styles.row}>
						<Button title="取消" disabled={disabled} onPress={() => setUninstalling(undefined)} />
						<Button
							title={busy ? "正在卸载…" : "确认卸载"}
							variant="danger"
							disabled={disabled}
							onPress={() =>
								void run(async () => {
									await store.resourceRequest("plugins.uninstall", {
										...target,
										id: uninstalling.id,
										keepData: keepPluginData,
									});
									store.toast("info", `已卸载 ${uninstalling.name}`);
									setUninstalling(undefined);
								})
							}
						/>
					</View>
				</Sheet>
			) : null}
		</Screen>
	);
}

function ResourceEditor({
	editor,
	runtime,
	scopes,
	busy,
	onClose,
	onSave,
}: {
	editor: Editor;
	runtime: ResourceRuntime;
	scopes: ResourceScope[];
	busy: boolean;
	onClose: () => void;
	onSave: (name: string, scope: ResourceScope, text: string, draft?: McpDraft) => Promise<boolean>;
}) {
	const p = usePalette();
	const [scope, setScope] = useState<ResourceScope>(
		editor.kind === "skill"
			? (editor.doc?.skill.scope ?? "user")
			: editor.kind === "mcp"
				? (editor.server?.scope ?? "user")
				: "user",
	);
	const [name, setName] = useState(editor.kind === "skill" ? (editor.doc?.skill.name ?? "my-skill") : "");
	const [text, setText] = useState(editor.kind === "skill" ? (editor.doc?.text ?? NEW_SKILL_TEXT) : "");
	const [draft, setDraft] = useState(() => mcpDraft(editor.kind === "mcp" ? editor.server : undefined));
	const readOnly = editor.kind === "skill" && editor.doc && !editor.doc.skill.editable;
	const existing = editor.kind === "skill" ? editor.doc : editor.kind === "mcp" ? editor.server : undefined;
	const inputStyle = [styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.elevated }];
	const field = (key: keyof McpDraft, label: string, multiline = false) => (
		<View key={key}>
			<Muted>{label}</Muted>
			<TextInput
				style={[inputStyle, multiline && styles.code]}
				multiline={multiline}
				value={draft[key]}
				editable={!busy && (key !== "name" || !existing)}
				onChangeText={(value) => setDraft((old) => ({ ...old, [key]: value }))}
				autoCapitalize="none"
				autoCorrect={false}
			/>
		</View>
	);
	return (
		<Sheet onClose={onClose}>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
				<Text style={[styles.name, { color: p.text }]}>
					{editor.kind === "import"
						? "导入技能"
						: editor.kind === "skill"
							? readOnly
								? "查看技能"
								: existing
									? "编辑技能"
									: "新建技能"
							: existing
								? "编辑 MCP"
								: "添加 MCP"}
				</Text>
				{!existing ? (
					<>
						<Muted>保存范围</Muted>
						<View style={styles.row}>
							{scopes.map((s) => (
								<Button
									title={RESOURCE_SCOPE_LABEL[s]}
									key={s}
									small
									disabled={busy}
									variant={scope === s ? "primary" : "secondary"}
									onPress={() => setScope(s)}
								/>
							))}
						</View>
					</>
				) : null}
				{editor.kind === "mcp" ? (
					<>
						{field("name", "服务器名称")}
						<View style={styles.row}>
							{(
								[
									"stdio",
									"http",
									...(runtime === "claude-code" ? ["sse"] : []),
									...(editor.server &&
									runtime === "pi" &&
									editor.server.scope === "project" &&
									!editor.server.config.command &&
									!editor.server.config.url
										? ["inherit"]
										: []),
								] as const
							).map((t) => (
								<Button
									key={t}
									title={t === "inherit" ? "继承全局" : t}
									small
									disabled={busy}
									variant={draft.transport === t ? "primary" : "secondary"}
									onPress={() => setDraft((old) => ({ ...old, transport: t as McpDraft["transport"] }))}
								/>
							))}
						</View>
						{draft.transport === "stdio" ? (
							<>
								{field("command", "启动命令")}
								{field("args", "参数（每行一个）", true)}
								{field("env", "环境变量（JSON）", true)}
							</>
						) : draft.transport === "inherit" ? (
							<Muted>继承同名全局服务器的连接配置。</Muted>
						) : (
							<>
								{field("url", "服务器 URL")}
								{field("headers", "请求头（JSON）", true)}
							</>
						)}
						{field("advanced", "高级配置（JSON，其他选项会保留）", true)}
					</>
				) : (
					<>
						{editor.kind === "skill" && !existing ? (
							<>
								<Muted>技能目录名</Muted>
								<TextInput
									style={inputStyle}
									value={name}
									onChangeText={setName}
									editable={!busy}
									autoCapitalize="none"
								/>
							</>
						) : null}
						<Muted>
							{editor.kind === "import"
								? "这台电脑上的技能目录或 SKILL.md 绝对路径，脚本和资源会一起复制。"
								: "SKILL.md"}
						</Muted>
						<TextInput
							style={[inputStyle, editor.kind === "skill" && styles.skillCode]}
							multiline={editor.kind === "skill"}
							value={text}
							onChangeText={setText}
							editable={!busy && !readOnly}
							autoCapitalize="none"
							autoCorrect={false}
						/>
					</>
				)}
				<View style={styles.row}>
					<Button title="关闭" disabled={busy} onPress={onClose} />
					{!readOnly ? (
						<Button
							title={editor.kind === "import" ? "导入" : "保存"}
							variant="primary"
							loading={busy}
							onPress={() => void onSave(name, scope, text, editor.kind === "mcp" ? draft : undefined)}
						/>
					) : null}
				</View>
			</ScrollView>
		</Sheet>
	);
}

const styles = StyleSheet.create({
	content: { padding: 16, gap: 14, paddingBottom: 32 },
	row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
	name: { fontSize: 17, fontWeight: "600", marginBottom: 8 },
	path: { fontFamily: MONO, fontSize: 11, marginVertical: 8 },
	input: { borderWidth: 1, borderRadius: 8, padding: 10, fontFamily: MONO, fontSize: 13 },
	code: { minHeight: 80, textAlignVertical: "top" },
	skillCode: { minHeight: 240, textAlignVertical: "top" },
	form: { gap: 12, paddingBottom: 12 },
});
