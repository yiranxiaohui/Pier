import type { SessionCleanupResult, WorkspaceInfo } from "@pier/protocol";
import { useEffect, useState } from "react";
import { sessionTitle } from "../lib/format.ts";
import { type SessionCleanupProgress, type SessionCleanupRequest, useAppState, useStore } from "../lib/store.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

type Action = SessionCleanupRequest["action"];

/** Age choices: sessions not updated for at least this many days (0 = every session). */
const AGE_OPTIONS: Array<{ days: number; label: string }> = [
	{ days: 1, label: "超过 1 天未更新" },
	{ days: 3, label: "超过 3 天未更新" },
	{ days: 7, label: "超过 7 天未更新" },
	{ days: 30, label: "超过 30 天未更新" },
	{ days: 0, label: "全部会话" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
const PREVIEW_TITLES = 5;

/** The `session.cleanup` request for the dialog's choices, relative to `now`. */
export function cleanupRequest(action: Action, days: number, archivedOnly: boolean, now = Date.now()) {
	const request: SessionCleanupRequest = { action };
	if (days > 0) request.modifiedBefore = new Date(now - days * DAY_MS).toISOString();
	if (action === "delete" && archivedOnly) request.scope = "archived";
	return request;
}

/** Percentage of a cleanup done, or undefined while the host has not reported a total. */
export function cleanupPercent(progress: SessionCleanupProgress | undefined): number | undefined {
	if (!progress?.total) return undefined;
	return Math.min(100, Math.round((progress.done / progress.total) * 100));
}

/**
 * Archive or delete a workspace's sessions in bulk. Shows a preview (a `dryRun`) of the
 * sessions affected before anything changes.
 */
export function SessionCleanupDialog({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
	const store = useStore();
	const sessions = useAppState((s) => s.sessions[workspace.id]);
	const [action, setAction] = useState<Action>("archive");
	const [days, setDays] = useState(7);
	const [archivedOnly, setArchivedOnly] = useState(false);
	const [preview, setPreview] = useState<SessionCleanupResult | undefined>();
	const [previewError, setPreviewError] = useState<string | undefined>();
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState<SessionCleanupProgress | undefined>();

	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh the preview when the list changes.
	useEffect(() => {
		let cancelled = false;
		setPreview(undefined);
		setPreviewError(undefined);
		store
			.cleanupSessions(workspace.id, cleanupRequest(action, days, archivedOnly), true)
			.then((result) => {
				if (!cancelled) setPreview(result);
			})
			.catch((error: unknown) => {
				if (!cancelled) setPreviewError(errorText(error));
			});
		return () => {
			cancelled = true;
		};
	}, [store, workspace.id, action, days, archivedOnly, sessions]);

	const count = preview?.sessionIds.length ?? 0;
	const skipped = preview?.skipped.length ?? 0;
	const titles = (preview?.sessionIds ?? [])
		.slice(0, PREVIEW_TITLES)
		.map((id) => sessions?.find((s) => s.id === id))
		.filter((s) => s !== undefined)
		.map((s) => ({ id: s.id, title: sessionTitle(s) }));
	const verb = action === "archive" ? "归档" : "删除";
	const percent = cleanupPercent(progress);
	const progressText = progress?.total ? `${Math.min(progress.done, progress.total)} / ${progress.total}` : undefined;

	return (
		<Modal title={`清理会话 · ${workspace.name}`} onClose={onClose}>
			<div className="field">
				<div className="field-label">操作</div>
				<label className={`policy-option${action === "archive" ? " selected" : ""}`}>
					<input
						type="radio"
						name="cleanup-action"
						checked={action === "archive"}
						disabled={running}
						onChange={() => setAction("archive")}
					/>
					<div>
						<div className="policy-title">归档</div>
						<div className="muted">移到侧边栏的“已归档”中，随时可以取消归档，会话文件保持不变</div>
					</div>
				</label>
				<label className={`policy-option${action === "delete" ? " selected" : ""}`}>
					<input
						type="radio"
						name="cleanup-action"
						checked={action === "delete"}
						disabled={running}
						onChange={() => setAction("delete")}
					/>
					<div>
						<div className="policy-title">删除</div>
						<div className="muted">会话文件移到 Pier 的回收目录（~/.pier/trash/sessions），运行中的会话会被跳过</div>
					</div>
				</label>
			</div>
			<div className="field">
				<div className="field-label">范围</div>
				<Select
					value={days}
					onChange={setDays}
					disabled={running}
					options={AGE_OPTIONS.map((option) => ({ value: option.days, label: option.label }))}
				/>
				{action === "delete" ? (
					<label className="cleanup-checkbox">
						<input
							type="checkbox"
							checked={archivedOnly}
							disabled={running}
							onChange={(e) => setArchivedOnly(e.target.checked)}
						/>
						只删除已归档的会话
					</label>
				) : null}
			</div>
			<div className="cleanup-preview">
				{running ? (
					<div className="cleanup-progress" role="status" aria-live="polite">
						<div>
							正在{verb}
							{progressText ? (
								<>
									{" "}
									<strong>{progressText}</strong> 个会话
								</>
							) : (
								` ${count} 个会话…`
							)}
						</div>
						<div
							className="update-progress-track"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={percent}
						>
							<div
								className={`update-progress-bar${percent === undefined ? " indeterminate" : ""}`}
								style={percent === undefined ? undefined : { width: `${percent}%` }}
							/>
						</div>
						<div className="muted small">关闭窗口不会中断{verb}，完成后会有提示</div>
					</div>
				) : previewError ? (
					<span className="error-text">无法预览：{previewError}</span>
				) : !preview ? (
					<span className="muted">正在统计…</span>
				) : count ? (
					<>
						<div>
							将{verb} <strong>{count}</strong> 个会话
							{skipped ? <span className="muted">，{skipped} 个运行中的会话会被跳过</span> : null}
						</div>
						<ul>
							{titles.map((t) => (
								<li key={t.id}>{t.title}</li>
							))}
							{count > titles.length ? <li className="muted">等 {count} 个会话</li> : null}
						</ul>
					</>
				) : (
					<span className="muted">没有符合条件的会话{skipped ? `（${skipped} 个运行中的会话会被跳过）` : ""}</span>
				)}
			</div>
			<div className="modal-actions">
				<button type="button" onClick={onClose}>
					{running ? "关闭" : "取消"}
				</button>
				<button
					type="button"
					className={action === "delete" ? "danger" : "primary"}
					disabled={!count || running}
					onClick={async () => {
						setRunning(true);
						setProgress(undefined);
						const result = await store.cleanupSessions(
							workspace.id,
							cleanupRequest(action, days, archivedOnly),
							false,
							setProgress,
						);
						setRunning(false);
						setProgress(undefined);
						if (result) onClose();
					}}
				>
					{running ? `正在${verb}${progressText ? ` ${progressText}` : "…"}` : count ? `${verb} ${count} 个会话` : verb}
				</button>
			</div>
		</Modal>
	);
}
