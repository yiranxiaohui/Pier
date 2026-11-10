import type { ChatController, ToolBlock } from "@pier/chat-state";
import type { SubagentInfo, SubagentStatus } from "@pier/protocol";
import { createContext, type KeyboardEvent, memo, useContext, useEffect, useState } from "react";
import { formatDuration, formatTokens } from "../lib/format.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import {
	IconAlert,
	IconBot,
	IconCheck,
	IconChevronRight,
	IconLoader,
	IconNetwork,
	IconStop,
	IconTarget,
	IconX,
} from "./Icons.tsx";

/** The session a transcript belongs to, so subagent cards can open and stop their subagents. */
export interface SubagentScope {
	sessionId: string;
	controller?: ChatController | undefined;
}

export const SubagentScopeContext = createContext<SubagentScope | undefined>(undefined);

export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	stopped: "已停止",
};

/** Re-render every second while `active`, for running clocks. */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

/** How long a subagent ran (or has been running), when known. */
export function subagentElapsed(subagent: SubagentInfo, now: number): number | undefined {
	if (subagent.startedAt !== undefined) {
		const end = subagent.status === "running" ? now : (subagent.endedAt ?? now);
		return Math.max(0, end - subagent.startedAt);
	}
	return subagent.durationMs;
}

/** `model thinking`, e.g. `gpt-5 high`. */
export function subagentModel(subagent: SubagentInfo): string {
	return [subagent.model, subagent.thinkingLevel && subagent.thinkingLevel !== "off" ? subagent.thinkingLevel : ""]
		.filter(Boolean)
		.join(" ");
}

function firstLine(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
}

/** One-line summary of what a subagent was asked to do. */
export function subagentSummary(subagent: SubagentInfo): string | undefined {
	return firstLine(subagent.description) ?? firstLine(subagent.task);
}

function StatusMark({ status }: { status: SubagentStatus }) {
	switch (status) {
		case "running":
			return <IconLoader size={14} className="spin" />;
		case "completed":
			return <IconCheck size={14} />;
		case "failed":
			return <IconAlert size={14} />;
		default:
			return <IconX size={14} />;
	}
}

/** Whether a tool block delegates (or is about to delegate) work to subagents. */
export function delegates(block: ToolBlock): boolean {
	if (!block.subagents) return false;
	if (block.subagents.length) return true;
	// pi-subagents' management actions (status, interrupt, …) start nothing.
	const args = (block.call.arguments ?? {}) as Record<string, unknown>;
	if (block.call.name === "subagent" && (args.action !== undefined || (args.agent ?? args.workflow) === undefined))
		return false;
	return block.status === "generating" || block.status === "pending" || block.status === "running";
}

function SubagentRow({
	subagent,
	now,
	selected,
	onOpen,
	onStop,
}: {
	subagent: SubagentInfo;
	now: number;
	selected: boolean;
	onOpen?: (() => void) | undefined;
	onStop?: (() => void) | undefined;
}) {
	const running = subagent.status === "running";
	const elapsed = subagentElapsed(subagent, now);
	const summary = subagentSummary(subagent);
	const model = subagentModel(subagent);
	const detail = running ? subagent.activity : subagent.status === "failed" ? subagent.error : undefined;
	const interactive = onOpen
		? {
				role: "button",
				tabIndex: 0,
				title: "查看 Subagent 的对话",
				onClick: onOpen,
				onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen();
					}
				},
			}
		: {};
	return (
		<div
			className={`subagent-row status-${subagent.status}${selected ? " selected" : ""}${onOpen ? " clickable" : ""}`}
			{...interactive}
		>
			<div className="subagent-row-head">
				<span className="subagent-avatar">
					<IconBot size={15} />
					<span className="subagent-dot" />
				</span>
				<span className="subagent-name">{subagent.name}</span>
				{model ? <span className="subagent-model">{model}</span> : null}
				<span className="subagent-mark">
					<StatusMark status={subagent.status} />
				</span>
			</div>
			<div className="subagent-row-status">
				{SUBAGENT_STATUS_LABEL[subagent.status]}
				{elapsed !== undefined ? ` · ${formatDuration(elapsed)}` : ""}
				{subagent.tokens ? ` · ${formatTokens(subagent.tokens)} tokens` : ""}
			</div>
			{summary ? <div className="subagent-row-task">{summary}</div> : null}
			<div className="subagent-row-foot">
				<span className="subagent-steps">{subagent.steps} 个步骤</span>
				{detail ? (
					<span className="subagent-activity" title={detail}>
						{firstLine(detail)}
					</span>
				) : (
					<span className="subagent-activity" />
				)}
				{running && onStop ? (
					<button
						type="button"
						className="subagent-stop"
						onClick={(event) => {
							event.stopPropagation();
							onStop();
						}}
					>
						<IconStop size={11} />
						停止
					</button>
				) : null}
			</div>
		</div>
	);
}

/**
 * Subagents started by one or more consecutive tool calls (`Agent`, `spawn_agent`, `subagent`):
 * the main agent and its delegates, each opening its conversation in the right-hand panel.
 */
export const SubagentCard = memo(function SubagentCard({ blocks }: { blocks: ToolBlock[] }) {
	const store = useStore();
	const scope = useContext(SubagentScopeContext);
	const view = useAppState((s) => s.subagentView);
	const subagents = blocks.flatMap((b) => b.subagents ?? []);
	const running = subagents.filter((s) => s.status === "running");
	const launching = blocks.some((b) => !b.subagents?.length);
	const active = running.length > 0 || launching;
	const now = useNow(active);
	const [openOverride, setOpen] = useState<boolean | undefined>(undefined);
	const open = openOverride ?? true;
	const done = subagents.filter((s) => s.status !== "running").length;
	const failed = subagents.some((s) => s.status === "failed");
	const starts = subagents.map((s) => s.startedAt).filter((t): t is number => t !== undefined);
	const ends = subagents.map((s) => (s.status === "running" ? now : s.endedAt)).filter((t): t is number => !!t);
	const elapsed =
		starts.length && ends.length === subagents.length
			? Math.max(...ends) - Math.min(...starts)
			: subagents.reduce((max, s) => Math.max(max, subagentElapsed(s, now) ?? 0), 0) || undefined;
	const stoppable = running.filter((s) => s.stoppable);
	const controller = scope?.controller;
	const title = active ? "Subagent 正在工作" : failed ? "Subagent 已结束" : "Subagent 已完成";
	const meta = [
		subagents.length ? `${subagents.length} 个 Subagent` : "正在派出 Subagent…",
		subagents.length ? `已完成 ${done}/${subagents.length}` : "",
		elapsed !== undefined ? formatDuration(elapsed) : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className={`subagent-card${active ? " active" : ""}${failed ? " failed" : ""}`}>
			<div className="subagent-header">
				<button type="button" className="subagent-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
					<span className="subagent-header-icon">
						<IconNetwork size={15} />
					</span>
					<span className="subagent-heading">
						<span className="subagent-title">
							{title}
							{active ? <span className="subagent-pulse" /> : null}
						</span>
						<span className="subagent-meta">{meta}</span>
					</span>
					<IconChevronRight size={14} className={`chevron${open ? " open" : ""}`} />
				</button>
				{controller && stoppable.length ? (
					<button
						type="button"
						className="subagent-stop-all"
						title="停止这张卡片中所有正在运行的 Subagent"
						onClick={() => {
							for (const subagent of stoppable) void controller.stopSubagent(subagent.id);
						}}
					>
						<IconStop size={11} />
						停止全部
					</button>
				) : null}
			</div>
			{open ? (
				<div className="subagent-tree">
					<div className="subagent-root">
						<span className="subagent-root-icon">
							<IconTarget size={16} />
						</span>
						<span className="subagent-root-text">
							<span className="subagent-root-name">主 Agent</span>
							<span className="subagent-root-state">
								{active
									? `正在协调 ${Math.max(running.length, subagents.length ? running.length : 1)} 个委派任务`
									: `已收到 ${subagents.length} 个委派任务的结果`}
							</span>
						</span>
					</div>
					{subagents.length ? (
						<div className="subagent-children">
							{subagents.map((subagent) => (
								<div key={subagent.id} className="subagent-branch">
									<SubagentRow
										subagent={subagent}
										now={now}
										selected={view?.sessionId === scope?.sessionId && view?.subagentId === subagent.id}
										onOpen={
											scope && subagent.transcript ? () => store.openSubagent(scope.sessionId, subagent.id) : undefined
										}
										onStop={
											controller && subagent.stoppable ? () => void controller.stopSubagent(subagent.id) : undefined
										}
									/>
								</div>
							))}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
});
