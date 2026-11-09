import type { BrowserPreparationProgress } from "@pier/protocol";
import { useEffect, useRef } from "react";
import { formatSize } from "../lib/format.ts";
import { IconLoader } from "./Icons.tsx";

export function BrowserPreparationStatus({
	progress,
	running,
	onCancel,
}: {
	progress: BrowserPreparationProgress;
	running: boolean;
	onCancel(): void;
}) {
	const output = useRef<HTMLElement>(null);
	const follow = useRef(true);
	const percent =
		progress.stage === "downloading" && progress.totalBytes
			? Math.min(100, Math.floor(((progress.downloadedBytes ?? 0) / progress.totalBytes) * 100))
			: undefined;
	useEffect(() => {
		if (progress.logs && follow.current && output.current) output.current.scrollTop = output.current.scrollHeight;
	}, [progress.logs]);
	return (
		<div className="browser-preparation">
			<div className="browser-preparation-heading" role="status" aria-live="polite">
				{running ? <IconLoader size={16} className="spin" /> : null}
				<span>{running ? progress.message : "准备已结束 · 最后一次安装输出"}</span>
				{running && percent !== undefined ? <span>{percent}%</span> : null}
			</div>
			{running && progress.stage === "downloading" ? (
				<>
					<progress aria-label="浏览器组件下载进度" max={100} value={percent} />
					<span className="muted small">
						已下载 {formatSize(progress.downloadedBytes ?? 0)}
						{progress.totalBytes ? ` / ${formatSize(progress.totalBytes)}` : ""}
					</span>
				</>
			) : null}
			{progress.logs ? (
				<details className="browser-preparation-details" open>
					<summary>安装日志（最近输出）</summary>
					<section
						ref={output}
						className="browser-preparation-log"
						aria-label="浏览器安装日志"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the bounded log region.
						tabIndex={0}
						onScroll={() => {
							const element = output.current;
							if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
						}}
					>
						{progress.logs}
					</section>
				</details>
			) : progress.logs === undefined ? (
				<p className="muted small">此主机尚未提供安装日志；更新本机和远程主机的 Pier 后可查看。</p>
			) : null}
			{running ? (
				<button type="button" className="ghost" onClick={onCancel}>
					取消准备
				</button>
			) : null}
		</div>
	);
}
