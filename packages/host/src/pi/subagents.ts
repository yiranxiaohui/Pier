import type { SubagentInfo, SubagentStatus } from "@pier/protocol";
import { clip, type SubagentPatch, toolActivity } from "../runtimes/subagents.ts";

/**
 * Subagents of the `pi-subagents` extension's `subagent` tool, from the `details` of its
 * partial and final results (`results` and `progress` per child, matched by `index`).
 */

/** Name of the `pi-subagents` tool. */
export const PI_SUBAGENT_TOOL = "subagent";

type Json = Record<string, unknown>;

export interface PiSubagentUpdate {
	id: string;
	patch: SubagentPatch;
	/** The child's pi session file, for its conversation. */
	sessionFile?: string;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function records(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter((v): v is Json => !!v && typeof v === "object") : [];
}

function progressStatus(status: unknown): SubagentStatus | undefined {
	switch (status) {
		case "pending":
		case "running":
			return "running";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "detached":
			return "stopped";
		default:
			return undefined;
	}
}

function resultStatus(result: Json): Exclude<SubagentStatus, "running"> {
	if (result.interrupted === true || result.stopped === true || result.timedOut === true || result.detached === true)
		return "stopped";
	if (str(result.error)) return "failed";
	const exitCode = num(result.exitCode);
	return exitCode === undefined || exitCode === 0 ? "completed" : "failed";
}

/** pi-subagents keeps the prompt out of details unless asked to. */
function visibleTask(task: string | undefined): string | undefined {
	return task && !/^\[[^\]]*redacted\]$/i.test(task.trim()) ? task : undefined;
}

/** `provider/model:thinking` → `model`; the thinking level is reported on its own. */
function modelName(model: string | undefined): string | undefined {
	return model
		?.replace(/:(off|minimal|low|medium|high|xhigh|max|ultra)$/, "")
		.split("/")
		.at(-1);
}

/** Token count of a pi-subagents `Usage` (input + output). */
function usageTokens(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Json;
	const total = (num(u.input) ?? 0) + (num(u.output) ?? 0) + (num(u.cacheRead) ?? 0) + (num(u.cacheWrite) ?? 0);
	return total > 0 ? total : undefined;
}

/**
 * Updates for the children of one `subagent` tool call. `final` is set for the tool's final
 * result: children without a terminal state then end with their result's outcome.
 */
export function piSubagentUpdates(toolCallId: string, details: unknown, final: boolean): PiSubagentUpdate[] {
	if (!details || typeof details !== "object") return [];
	const d = details as Json;
	const byIndex = new Map<number, { result?: Json; progress?: Json }>();
	for (const result of records(d.results)) {
		const index = num(result.index);
		if (index === undefined) continue;
		byIndex.set(index, { ...byIndex.get(index), result });
	}
	for (const progress of records(d.progress)) {
		const index = num(progress.index);
		if (index === undefined) continue;
		byIndex.set(index, { ...byIndex.get(index), progress });
	}
	const updates: PiSubagentUpdate[] = [];
	for (const [index, { result, progress }] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
		const resultProgress = (result?.progress ?? {}) as Json;
		const p = progress ?? resultProgress;
		const name = str(result?.agent) ?? str(p.agent) ?? "subagent";
		const task = clip(visibleTask(str(result?.task) ?? str(p.task)));
		// Session names read `<agent>: <task excerpt>`.
		const sessionName = str(result?.sessionName) ?? str(p.sessionName);
		const description = clip(
			sessionName?.startsWith(`${name}: `) ? sessionName.slice(name.length + 2) : sessionName,
			500,
		);
		const model = modelName(str(result?.model) ?? str(p.model));
		const thinking = str(result?.thinking) ?? str(p.thinking);
		let status = progressStatus(p.status) ?? "running";
		if (final && status === "running") status = result ? resultStatus(result) : "stopped";
		if (final && result && status === "completed" && resultStatus(result) !== "completed")
			status = resultStatus(result);
		const steps = num(p.toolCount);
		const tokens = num(p.tokens) ?? usageTokens(result?.usage);
		const durationMs = num(p.durationMs);
		const currentTool = str(p.currentTool);
		const recentOutput = Array.isArray(p.recentOutput) ? (p.recentOutput as unknown[]).filter(str) : [];
		const activity = currentTool
			? toolActivity(currentTool, { detail: str(p.currentToolArgs) })
			: clip(str(recentOutput.at(-1) as string | undefined), 200);
		const output = status === "completed" ? clip(str(result?.finalOutput)) : undefined;
		const error =
			status === "failed" ? clip(str(result?.error) ?? str(p.error) ?? str(result?.finalOutput)) : undefined;
		const sessionFile = str(result?.sessionFile);
		updates.push({
			id: `${toolCallId}:${index}`,
			patch: {
				toolCallId,
				name,
				...(task ? { task } : {}),
				...(description ? { description } : {}),
				...(model ? { model } : {}),
				...(thinking ? { thinkingLevel: thinking } : {}),
				status,
				...(steps !== undefined ? { steps } : {}),
				...(tokens !== undefined ? { tokens } : {}),
				...(durationMs !== undefined ? { durationMs } : {}),
				...(activity && status === "running" ? { activity } : {}),
				...(output ? { result: output } : {}),
				...(error ? { error } : {}),
				...(sessionFile ? { transcript: true } : {}),
			},
			...(sessionFile ? { sessionFile } : {}),
		});
	}
	return updates;
}

/** Subagents recorded in a stored pi conversation's `subagent` tool results. */
export function storedPiSubagents(messages: unknown[]): Array<{ info: SubagentInfo; sessionFile?: string }> {
	const stored: Array<{ info: SubagentInfo; sessionFile?: string }> = [];
	for (const message of messages) {
		const m = message as Json;
		if (m?.role !== "toolResult" || m.toolName !== PI_SUBAGENT_TOOL) continue;
		for (const update of piSubagentUpdates(String(m.toolCallId ?? ""), m.details, true)) {
			stored.push({
				info: {
					id: update.id,
					name: update.patch.name ?? "subagent",
					status: update.patch.status ?? "completed",
					steps: 0,
					stoppable: false,
					transcript: false,
					revision: 0,
					...update.patch,
				},
				...(update.sessionFile ? { sessionFile: update.sessionFile } : {}),
			});
		}
	}
	return stored;
}
