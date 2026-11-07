import { agentRuntimeLabel, supportedThinkingLevels, THINKING_LEVEL_LABELS } from "@pier/chat-state";
import {
	type AgentRuntimeInfo,
	type ModelInfo,
	type ScheduledTask,
	type ScheduledTaskInput,
	ScheduledTaskInputSchema,
	type ScheduledTaskRun,
	type TaskSchedule,
	type ThinkingLevel,
} from "@pier/protocol";
import { type ReactNode, useEffect, useState } from "react";
import { hostSupportsScheduledTasks, LOCAL_NODE, useAppState, useComputers, useStore } from "../lib/store.tsx";
import { localTaskDate, taskDate, taskScheduleLabel, WEEKDAYS } from "../lib/task-schedule.ts";
import { AgentIcon } from "./AgentIcons.tsx";
import { IconClock, IconLoader, IconPlus, IconRefresh, IconSearch, IconTrash } from "./Icons.tsx";
import { Markdown, MarkdownFiles } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

type TaskEntry = { node: string; task: ScheduledTask };
type RunEntry = { node: string; run: ScheduledTaskRun };
const STATUS = { active: "已安排", paused: "已暂停", completed: "已完成" };
const RUN_STATUS = {
	running: "执行中",
	waiting: "等待确认",
	succeeded: "已完成",
	failed: "执行失败",
	interrupted: "已中断",
};
const modelKey = (model: { provider: string; id: string }) => JSON.stringify([model.provider, model.id]);

export function ScheduledTasksPage({ footer }: { footer?: ReactNode } = {}) {
	const store = useStore();
	const computers = useComputers();
	const data = useAppState((s) => s.taskData);
	const [tab, setTab] = useState<"tasks" | "runs">("tasks");
	const [query, setQuery] = useState("");
	const [selection, setSelection] = useState<{ node: string; id: string }>();
	const [editor, setEditor] = useState<{ entry?: TaskEntry }>();
	const [deleting, setDeleting] = useState<TaskEntry>();
	const [busy, setBusy] = useState(false);
	const tasks: TaskEntry[] = Object.entries(data).flatMap(([node, value]) =>
		value.tasks.map((task) => ({ node, task })),
	);
	tasks.sort(
		(a, b) =>
			(a.task.status === "active" ? 0 : 1) - (b.task.status === "active" ? 0 : 1) ||
			(a.task.nextRunAt ?? "z").localeCompare(b.task.nextRunAt ?? "z"),
	);
	const runs: RunEntry[] = Object.entries(data).flatMap(([node, value]) => value.runs.map((run) => ({ node, run })));
	runs.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
	const selectedTask =
		tab === "tasks" ? tasks.find((t) => t.node === selection?.node && t.task.id === selection.id) : undefined;
	const selectedRun =
		tab === "runs" ? runs.find((r) => r.node === selection?.node && r.run.id === selection.id) : undefined;
	const unread = runs.filter((r) => !r.run.read).length;
	const canCreate = computers.some(
		(c) => c.online && hostSupportsScheduledTasks(c.state.hostInfo) && c.state.workspaces.length,
	);
	const search = query.trim().toLowerCase();
	const matches = (name: string, node: string) => `${name} ${store.nodeName(node)}`.toLowerCase().includes(search);
	const filteredTasks = tasks.filter((t) => matches(`${t.task.name} ${t.task.prompt}`, t.node));
	const filteredRuns = runs.filter((r) => matches(r.run.taskName, r.node));
	const online = (node: string) => computers.some((c) => c.id === node && c.online);
	const executing = (node: string, id: string) =>
		runs.some(
			(r) => r.node === node && r.run.taskId === id && (r.run.status === "running" || r.run.status === "waiting"),
		);

	async function action(fn: () => Promise<unknown>) {
		setBusy(true);
		try {
			await fn();
		} catch (error) {
			store.toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	function selectRun(entry: RunEntry) {
		setTab("runs");
		setSelection({ node: entry.node, id: entry.run.id });
		if (!entry.run.read && online(entry.node))
			void store
				.requestTask(entry.node, "task.readRun", { runId: entry.run.id })
				.catch((error: unknown) => store.toast("error", error instanceof Error ? error.message : String(error)));
	}

	function runRow(entry: RunEntry) {
		const { node, run } = entry;
		return (
			<button
				type="button"
				key={`${node}:${run.id}`}
				className={`task-run-row${!run.read ? " unread" : ""}`}
				onClick={() => selectRun(entry)}
			>
				<span className={`task-run-dot ${run.status}`} />
				<span className="task-row-content">
					<strong>{run.taskName}</strong>
					<span>
						{taskDate(run.startedAt)} · {RUN_STATUS[run.status]}
					</span>
				</span>
				{!run.read ? <span className="task-unread-dot" /> : null}
			</button>
		);
	}

	return (
		<div className="scheduled-page">
			<aside className="task-sidebar">
				<div className="task-sidebar-heading">
					<h2>定时任务</h2>
					<button
						type="button"
						className="ghost icon"
						title="刷新定时任务"
						disabled={busy}
						onClick={() =>
							void action(() => Promise.all(computers.filter((c) => c.online).map((c) => store.loadTasks(c.id))))
						}
					>
						<IconRefresh size={16} />
					</button>
				</div>
				<div className="task-search">
					<IconSearch size={14} />
					<input
						aria-label="搜索定时任务"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="搜索任务…"
					/>
				</div>
				<div className="task-tabs">
					<button
						type="button"
						className={tab === "tasks" ? "selected" : ""}
						onClick={() => {
							setTab("tasks");
							setSelection(undefined);
						}}
					>
						任务 <span>{tasks.length}</span>
					</button>
					<button
						type="button"
						className={tab === "runs" ? "selected" : ""}
						onClick={() => {
							setTab("runs");
							setSelection(undefined);
						}}
					>
						运行记录 {unread ? <span className="task-count">{unread}</span> : null}
					</button>
				</div>
				<div className="task-sidebar-list">
					{tab === "tasks" ? (
						<>
							<div className="task-list-label">即将执行</div>
							{filteredTasks.length ? (
								filteredTasks.map(({ node, task }) => (
									<button
										type="button"
										key={`${node}:${task.id}`}
										className={`task-list-item${selection?.node === node && selection.id === task.id ? " selected" : ""}`}
										onClick={() => setSelection({ node, id: task.id })}
									>
										<IconClock size={17} />
										<span className="task-row-content">
											<strong>{task.name}</strong>
											<span>
												{executing(node, task.id)
													? "正在执行"
													: task.status !== "active"
														? STATUS[task.status]
														: task.nextRunAt
															? taskDate(task.nextRunAt)
															: "未安排"}
											</span>
											{computers.length > 1 ? (
												<span>
													{store.nodeName(node)}
													{online(node) ? "" : " · 未连接"}
												</span>
											) : null}
										</span>
									</button>
								))
							) : (
								<p className="task-list-empty">{search ? "没有匹配的任务" : "暂无已安排的任务"}</p>
							)}
						</>
					) : filteredRuns.length ? (
						filteredRuns.map(runRow)
					) : (
						<p className="task-list-empty">{search ? "没有匹配的运行记录" : "任务执行后，结果会出现在这里"}</p>
					)}
					{computers.map((computer) => {
						const message = !computer.online
							? `${computer.name} 未连接`
							: !hostSupportsScheduledTasks(computer.state.hostInfo)
								? `${computer.name} 需要更新 Pier 才能使用定时任务`
								: data[computer.id]?.error
									? `${computer.name}：${data[computer.id]?.error}`
									: !data[computer.id]
										? `正在读取 ${computer.name} 的任务…`
										: undefined;
						return message ? (
							<p key={computer.id} className="task-node-note">
								{message}
							</p>
						) : null;
					})}
				</div>
				<button type="button" className="task-sidebar-create" disabled={!canCreate} onClick={() => setEditor({})}>
					<IconPlus size={15} />
					新建任务
				</button>
			</aside>
			<main className="task-main">
				{selectedTask ? (
					<div className="task-detail">
						<div className="task-detail-heading">
							<div>
								<span className="task-eyebrow">
									{STATUS[selectedTask.task.status]} · {agentRuntimeLabel(selectedTask.task.runtime)}
								</span>
								<h1>{selectedTask.task.name}</h1>
							</div>
							<AgentIcon runtime={selectedTask.task.runtime} size={30} />
						</div>
						<div className="task-actions">
							<button
								type="button"
								className="primary"
								disabled={busy || !online(selectedTask.node) || executing(selectedTask.node, selectedTask.task.id)}
								onClick={() =>
									void action(async () => {
										const { run } = await store.requestTask(selectedTask.node, "task.run", {
											taskId: selectedTask.task.id,
										});
										selectRun({ node: selectedTask.node, run });
									})
								}
							>
								立即执行
							</button>
							<button
								type="button"
								disabled={busy || !online(selectedTask.node) || executing(selectedTask.node, selectedTask.task.id)}
								onClick={() => setEditor({ entry: selectedTask })}
							>
								编辑
							</button>
							{selectedTask.task.status !== "completed" ? (
								<button
									type="button"
									disabled={busy || !online(selectedTask.node)}
									onClick={() =>
										void action(() =>
											store.requestTask(selectedTask.node, "task.setStatus", {
												taskId: selectedTask.task.id,
												status: selectedTask.task.status === "active" ? "paused" : "active",
											}),
										)
									}
								>
									{selectedTask.task.status === "active" ? "暂停" : "恢复"}
								</button>
							) : null}
							<button
								type="button"
								className="ghost icon"
								title="删除任务"
								disabled={busy || !online(selectedTask.node) || executing(selectedTask.node, selectedTask.task.id)}
								onClick={() => setDeleting(selectedTask)}
							>
								<IconTrash size={16} />
							</button>
						</div>
						<dl className="task-metadata">
							<div>
								<dt>执行计划</dt>
								<dd>{taskScheduleLabel(selectedTask.task.schedule)}</dd>
							</div>
							<div>
								<dt>下一次</dt>
								<dd>
									{selectedTask.task.status === "active" && selectedTask.task.nextRunAt
										? taskDate(selectedTask.task.nextRunAt)
										: STATUS[selectedTask.task.status]}
								</dd>
							</div>
							<div>
								<dt>工作区</dt>
								<dd>
									{computers
										.find((c) => c.id === selectedTask.node)
										?.state.workspaces.find((w) => w.id === selectedTask.task.workspaceId)?.name ?? "工作区已移除"}{" "}
									· {store.nodeName(selectedTask.node)}
								</dd>
							</div>
							<div>
								<dt>模型</dt>
								<dd>
									{selectedTask.task.model?.modelId ?? "使用默认模型"}
									{selectedTask.task.thinkingLevel
										? ` · ${THINKING_LEVEL_LABELS[selectedTask.task.thinkingLevel]}`
										: ""}
								</dd>
							</div>
						</dl>
						<h3>任务指令</h3>
						<div className="task-prompt">{selectedTask.task.prompt}</div>
						<p className="task-execution-note">
							每次执行都会在该工作区创建一个新会话，沿用工作区的审批策略。需要确认时，可以打开会话继续。
						</p>
						<h3>最近运行</h3>
						<div className="task-recent-runs">
							{runs
								.filter((r) => r.node === selectedTask.node && r.run.taskId === selectedTask.task.id)
								.slice(0, 10)
								.map(runRow)}
							{!runs.some((r) => r.node === selectedTask.node && r.run.taskId === selectedTask.task.id) ? (
								<p className="muted">还没有运行记录，可以先立即执行一次。</p>
							) : null}
						</div>
					</div>
				) : selectedRun ? (
					<div className="task-detail">
						<span className={`task-eyebrow ${selectedRun.run.status}`}>
							{RUN_STATUS[selectedRun.run.status]} · {selectedRun.run.trigger === "manual" ? "手动执行" : "按计划执行"}
						</span>
						<h1>{selectedRun.run.taskName}</h1>
						<p className="muted">
							{taskDate(selectedRun.run.startedAt)} · {store.nodeName(selectedRun.node)} ·{" "}
							{agentRuntimeLabel(selectedRun.run.runtime)}
						</p>
						<div className="task-actions">
							<button
								type="button"
								className="primary"
								disabled={busy || !online(selectedRun.node) || !selectedRun.run.sessionId}
								onClick={() => void action(() => store.openTaskRun(selectedRun.node, selectedRun.run))}
							>
								打开会话{selectedRun.run.status === "waiting" ? "并确认" : ""}
							</button>
							{selectedRun.run.status === "running" || selectedRun.run.status === "waiting" ? (
								<button
									type="button"
									disabled={busy || !online(selectedRun.node)}
									onClick={() =>
										void action(() =>
											store.requestTask(selectedRun.node, "task.stop", { taskId: selectedRun.run.taskId }),
										)
									}
								>
									停止本次运行
								</button>
							) : null}
						</div>
						{selectedRun.run.error ? (
							<div className="task-error" role="alert">
								{selectedRun.run.error}
							</div>
						) : null}
						{selectedRun.run.summary ? (
							<div className="task-result">
								<MarkdownFiles workspaceId={selectedRun.run.workspaceId}>
									<Markdown text={selectedRun.run.summary} />
								</MarkdownFiles>
							</div>
						) : (
							<p className="muted">
								{selectedRun.run.status === "waiting"
									? "Agent 正在等待你的确认。打开会话查看请求。"
									: selectedRun.run.status === "running"
										? "Agent 正在处理任务，完成后结果会出现在这里。"
										: "打开会话查看完整过程。"}
							</p>
						)}
					</div>
				) : (
					<div className="task-empty">
						<div className="task-empty-clock">
							<IconClock size={38} />
						</div>
						<h1>{tab === "runs" ? "查看任务结果" : "安排任务"}</h1>
						<p>
							{tab === "runs"
								? "选择一条运行记录，查看结果或继续会话。"
								: "把重复的工作交给 Agent，让它按计划为你处理。"}
						</p>
						<button type="button" className="primary" disabled={!canCreate} onClick={() => setEditor({})}>
							新建任务
						</button>
						{!canCreate ? (
							<p className="task-empty-note">连接支持定时任务的电脑，并添加一个工作区后即可创建。</p>
						) : (
							<p className="task-empty-note">执行任务时，请保持工作区所在电脑开机并运行 Pier。</p>
						)}
						{tab === "tasks" && !tasks.length && canCreate ? (
							<div className="task-examples">
								<div>
									<strong>每日项目简报</strong>
									<span>汇总最近的提交、待办与值得关注的变化。</span>
								</div>
								<div>
									<strong>定期检查</strong>
									<span>检查构建、依赖或长时间运行的操作。</span>
								</div>
							</div>
						) : null}
					</div>
				)}
			</main>
			{editor ? (
				<TaskEditor
					{...(editor.entry ? { entry: editor.entry } : {})}
					onClose={() => setEditor(undefined)}
					onSaved={(entry) => {
						setEditor(undefined);
						setTab("tasks");
						setSelection({ node: entry.node, id: entry.task.id });
					}}
				/>
			) : null}
			{deleting ? (
				<Modal
					title="删除定时任务"
					onClose={() => {
						if (!busy) setDeleting(undefined);
					}}
				>
					<p>删除“{deleting.task.name}”及其运行记录？已生成的会话会保留。</p>
					<div className="modal-actions">
						<button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>
							取消
						</button>
						<button
							type="button"
							className="danger"
							disabled={busy}
							onClick={() =>
								void action(async () => {
									await store.requestTask(deleting.node, "task.delete", { taskId: deleting.task.id });
									setDeleting(undefined);
									setSelection(undefined);
								})
							}
						>
							删除任务
						</button>
					</div>
				</Modal>
			) : null}
			{footer}
		</div>
	);
}

function TaskEditor({
	entry,
	onClose,
	onSaved,
}: {
	entry?: TaskEntry;
	onClose(): void;
	onSaved(entry: TaskEntry): void;
}) {
	const store = useStore();
	const computers = useComputers();
	const workspaces = useAppState((s) => s.workspaces);
	const selectedWorkspace = useAppState((s) => s.selectedWorkspaceId);
	const available = workspaces.filter((w) =>
		computers.some((c) => c.id === store.nodeOf(w.id) && c.online && hostSupportsScheduledTasks(c.state.hostInfo)),
	);
	const task = entry?.task;
	const [name, setName] = useState(task?.name ?? "");
	const [prompt, setPrompt] = useState(task?.prompt ?? "");
	const [workspaceId, setWorkspaceId] = useState(
		task?.workspaceId ?? available.find((w) => w.id === selectedWorkspace)?.id ?? available[0]?.id ?? "",
	);
	const node = entry?.node ?? store.nodeOf(workspaceId);
	const [runtime, setRuntime] = useState(task?.runtime ?? "pi");
	const [runtimes, setRuntimes] = useState<AgentRuntimeInfo[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [model, setModel] = useState(
		task?.model ? modelKey({ provider: task.model.provider, id: task.model.modelId }) : "",
	);
	const [thinking, setThinking] = useState<ThinkingLevel | "">(task?.thinkingLevel ?? "");
	const [kind, setKind] = useState<TaskSchedule["kind"]>(task?.schedule.kind ?? "daily");
	const [time, setTime] = useState(
		task?.schedule.kind === "daily" || task?.schedule.kind === "weekly" ? task.schedule.time : "09:00",
	);
	const [timeZone, setTimeZone] = useState(
		task?.schedule.kind === "daily" || task?.schedule.kind === "weekly"
			? task.schedule.timeZone
			: Intl.DateTimeFormat().resolvedOptions().timeZone,
	);
	const [days, setDays] = useState(task?.schedule.kind === "weekly" ? task.schedule.days : [1, 2, 3, 4, 5]);
	const [minutes, setMinutes] = useState(task?.schedule.kind === "interval" ? task.schedule.minutes : 60);
	const [at, setAt] = useState(
		localTaskDate(task?.schedule.kind === "once" ? task.schedule.at : new Date(Date.now() + 3600000).toISOString()),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const chosenModel = models.find((m) => modelKey(m) === model);
	const levels = supportedThinkingLevels(chosenModel);
	const online = computers.some((c) => c.id === node && c.online);

	useEffect(() => {
		if (!workspaceId) return;
		let live = true;
		setLoading(true);
		setError(undefined);
		Promise.allSettled([store.listRuntimes(workspaceId), store.listModels(workspaceId, runtime)])
			.then(([agents, catalog]) => {
				if (live) {
					setRuntimes(agents.status === "fulfilled" ? agents.value : []);
					setModels(catalog.status === "fulfilled" ? catalog.value.models : []);
					const failure =
						agents.status === "rejected" ? agents.reason : catalog.status === "rejected" ? catalog.reason : undefined;
					if (failure) setError(failure instanceof Error ? failure.message : String(failure));
				}
			})
			.catch((error: unknown) => {
				if (live) {
					setRuntimes([]);
					setModels([]);
					setError(error instanceof Error ? error.message : String(error));
				}
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [store, workspaceId, runtime]);

	async function save() {
		setError(undefined);
		try {
			const schedule: TaskSchedule =
				kind === "once"
					? { kind, at: new Date(at).toISOString() }
					: kind === "interval"
						? { kind, minutes }
						: kind === "weekly"
							? { kind, time, timeZone: timeZone.trim(), days }
							: { kind, time, timeZone: timeZone.trim() };
			const parsed = ScheduledTaskInputSchema.safeParse({
				name,
				prompt,
				workspaceId,
				runtime,
				schedule,
				...(chosenModel ? { model: { provider: chosenModel.provider, modelId: chosenModel.id } } : {}),
				...(thinking ? { thinkingLevel: thinking } : {}),
			});
			if (!parsed.success) {
				setError(parsed.error.issues[0]?.message ?? "请检查任务内容");
				return;
			}
			if (model && !chosenModel) {
				setError("选择的模型已不可用，请重新选择或使用默认模型");
				return;
			}
			if (thinking && chosenModel && !levels.includes(thinking)) {
				setError("这个模型不支持选择的思考等级");
				return;
			}
			setBusy(true);
			const input: ScheduledTaskInput = parsed.data;
			const result = task
				? await store.requestTask(node, "task.update", { taskId: task.id, task: input })
				: await store.requestTask(node, "task.create", input);
			onSaved({ node, task: result.task });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			title={task ? "编辑定时任务" : "新建定时任务"}
			wide
			className="task-editor"
			onClose={() => {
				if (!busy) onClose();
			}}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<label className="field">
					<span className="field-label">任务名称</span>
					<input
						required
						maxLength={200}
						placeholder="例如：每日项目简报"
						value={name}
						disabled={busy}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label className="field">
					<span className="field-label">任务指令</span>
					<textarea
						required
						maxLength={100000}
						rows={5}
						placeholder="描述每次执行时 Agent 应该做什么，以及需要汇报的结果…"
						value={prompt}
						disabled={busy}
						onChange={(e) => setPrompt(e.target.value)}
					/>
				</label>
				<div className="task-form-grid">
					<div className="field">
						<div className="field-label">工作区</div>
						<Select
							value={workspaceId}
							title="任务工作区"
							disabled={busy}
							options={(entry ? workspaces.filter((w) => store.nodeOf(w.id) === entry.node) : available).map((w) => ({
								value: w.id,
								label: `${w.name}${store.nodeOf(w.id) === LOCAL_NODE ? "" : ` · ${store.nodeName(store.nodeOf(w.id))}`}`,
							}))}
							onChange={(value) => {
								setWorkspaceId(value);
								setModel("");
								setThinking("");
							}}
						/>
					</div>
					<div className="field">
						<div className="field-label">Agent</div>
						<Select
							value={runtime}
							title="任务 Agent"
							disabled={busy || loading}
							options={runtimes.map((r) => ({ value: r.id, label: r.name, disabled: !r.available }))}
							onChange={(value) => {
								setRuntime(value);
								setModel("");
								setThinking("");
							}}
						/>
					</div>
					<div className="field">
						<div className="field-label">模型</div>
						<Select
							value={model}
							title="任务模型"
							disabled={busy || loading}
							options={[
								{ value: "", label: "使用默认模型" },
								...models.map((m) => ({ value: modelKey(m), label: m.name || m.id })),
							]}
							onChange={(value) => {
								setModel(value);
								setThinking("");
							}}
						/>
					</div>
					<div className="field">
						<div className="field-label">思考程度</div>
						<Select
							value={thinking}
							title="任务思考程度"
							disabled={busy || loading || !chosenModel}
							options={[
								{ value: "" as const, label: "使用默认设置" },
								...levels.map((value) => ({ value, label: THINKING_LEVEL_LABELS[value] })),
							]}
							onChange={setThinking}
						/>
					</div>
				</div>
				<div className="task-form-grid">
					<div className="field">
						<div className="field-label">执行频率</div>
						<Select
							value={kind}
							title="执行频率"
							disabled={busy}
							options={[
								{ value: "once", label: "仅一次" },
								{ value: "interval", label: "固定间隔" },
								{ value: "daily", label: "每天" },
								{ value: "weekly", label: "每周" },
							]}
							onChange={setKind}
						/>
					</div>
					{kind === "once" ? (
						<label className="field">
							<span className="field-label">执行时间（本地时间）</span>
							<input
								type="datetime-local"
								required
								value={at}
								disabled={busy}
								onChange={(e) => setAt(e.target.value)}
							/>
						</label>
					) : kind === "interval" ? (
						<label className="field">
							<span className="field-label">间隔（分钟）</span>
							<input
								type="number"
								required
								min={1}
								max={525600}
								value={minutes}
								disabled={busy}
								onChange={(e) => setMinutes(Number(e.target.value))}
							/>
						</label>
					) : (
						<label className="field">
							<span className="field-label">执行时间</span>
							<input type="time" required value={time} disabled={busy} onChange={(e) => setTime(e.target.value)} />
						</label>
					)}
				</div>
				{kind === "daily" || kind === "weekly" ? (
					<label className="field">
						<span className="field-label">时区</span>
						<input
							required
							value={timeZone}
							disabled={busy}
							placeholder="Asia/Shanghai"
							onChange={(e) => setTimeZone(e.target.value)}
						/>
					</label>
				) : null}
				{kind === "weekly" ? (
					<div className="field">
						<div className="field-label">重复日期</div>
						<div className="task-weekdays">
							{[1, 2, 3, 4, 5, 6, 0].map((day) => (
								<button
									type="button"
									key={day}
									className={days.includes(day) ? "selected" : ""}
									aria-pressed={days.includes(day)}
									disabled={busy}
									onClick={() =>
										setDays((previous) =>
											previous.includes(day) ? previous.filter((d) => d !== day) : [...previous, day],
										)
									}
								>
									{WEEKDAYS[day]}
								</button>
							))}
						</div>
					</div>
				) : null}
				<p className="task-execution-note">
					在工作区目录中执行，每次创建新会话。请保持该电脑开机并运行 Pier；离线期间错过的计划会在恢复后执行一次。
				</p>
				{error ? (
					<p className="task-error" role="alert">
						{error}
					</p>
				) : null}
				<div className="modal-actions">
					<button type="button" disabled={busy} onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						className="primary"
						disabled={
							busy ||
							loading ||
							!online ||
							!workspaceId ||
							!name.trim() ||
							!prompt.trim() ||
							!runtimes.some((r) => r.id === runtime && r.available)
						}
					>
						{busy ? <IconLoader size={14} className="spin" /> : null}
						{task ? "保存任务" : "创建任务"}
					</button>
				</div>
			</form>
		</Modal>
	);
}
