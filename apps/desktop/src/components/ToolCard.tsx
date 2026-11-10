import { editDiff, editReplacements, summarizeToolCall, type ToolBlock, toolOutputText } from "@pier/chat-state";
import type { UiRequest } from "@pier/protocol";
import hljs from "highlight.js/lib/common";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, languageForPath } from "../lib/format.ts";
import {
	IconAlert,
	IconCheck,
	IconChevronRight,
	IconClock,
	IconFile,
	IconFilePen,
	IconFilePlus,
	IconList,
	IconLoader,
	IconSearch,
	IconShieldAlert,
	IconTerminal,
	IconWrench,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";

const STATUS_LABEL: Record<ToolBlock["status"], string> = {
	generating: "生成中",
	pending: "等待执行",
	running: "执行中",
	done: "完成",
	error: "失败",
	interrupted: "已中断",
};

const TOOL_LABEL: Record<string, string> = {
	bash: "终端",
	powershell: "PowerShell",
	read: "读取",
	write: "写入",
	edit: "编辑",
	grep: "搜索",
	find: "查找",
	ls: "列目录",
};

const TOOL_ICON: Record<string, typeof IconTerminal> = {
	bash: IconTerminal,
	powershell: IconTerminal,
	read: IconFile,
	write: IconFilePlus,
	edit: IconFilePen,
	grep: IconSearch,
	find: IconSearch,
	ls: IconList,
};

function StatusIcon({ status, awaiting }: { status: ToolBlock["status"]; awaiting: boolean }) {
	if (awaiting) return <IconShieldAlert size={12} />;
	switch (status) {
		case "generating":
		case "running":
			return <IconLoader size={12} className="spin" />;
		case "pending":
			return <IconClock size={12} />;
		case "done":
			return <IconCheck size={12} />;
		case "error":
			return <IconAlert size={12} />;
		default:
			return <IconX size={12} />;
	}
}

export function Highlighted({ code, language }: { code: string; language?: string | undefined }) {
	const html = useMemo(() => {
		if (!language || !hljs.getLanguage(language) || code.length > 200_000) return undefined;
		try {
			return hljs.highlight(code, { language, ignoreIllegals: true }).value;
		} catch {
			return undefined;
		}
	}, [code, language]);
	return html !== undefined ? (
		// biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes its input.
		<code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
	) : (
		<code>{code}</code>
	);
}

/** Output that follows the tail while it grows (e.g. a running command). */
function Output({ text, error, follow }: { text: string; error?: boolean; follow?: boolean }) {
	const ref = useRef<HTMLPreElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the output grows.
	useEffect(() => {
		const el = ref.current;
		if (follow && el) el.scrollTop = el.scrollHeight;
	}, [text, follow]);
	if (!text) return null;
	return (
		<pre ref={ref} className={`tool-output${error ? " error" : ""}`}>
			{text}
		</pre>
	);
}

export function DiffView({ diff }: { diff: string }) {
	const lines = diff.split("\n");
	return (
		<pre className="diff">
			{lines.map((line, i) => {
				const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: static diff lines.
					<div key={i} className={`diff-line ${kind}`}>
						{line || " "}
					</div>
				);
			})}
		</pre>
	);
}

function ReplacementsView({ edits }: { edits: Array<{ oldText: string; newText: string }> }) {
	const diff = edits
		.map((e) =>
			[...e.oldText.split("\n").map((l) => `- ${l}`), ...e.newText.split("\n").map((l) => `+ ${l}`)].join("\n"),
		)
		.join("\n  ⋯\n");
	return <DiffView diff={diff} />;
}

function ToolBody({ block }: { block: ToolBlock }) {
	const { call, execution, result, status } = block;
	const args = (call.arguments ?? {}) as Record<string, unknown>;
	const running = status === "running";
	const output = result ? toolOutputText(result) : toolOutputText(execution?.partialResult ?? execution?.result);
	const isError = status === "error";

	switch (call.name) {
		case "bash":
		case "powershell":
			return (
				<>
					<pre className="tool-command">
						<span className="prompt">$</span> {String(args.command ?? "")}
					</pre>
					<Output text={output} error={isError} follow={running} />
				</>
			);
		case "edit": {
			const diff = editDiff(result ?? execution?.result);
			const edits = editReplacements(args);
			return (
				<>
					{diff ? <DiffView diff={diff} /> : edits.length ? <ReplacementsView edits={edits} /> : null}
					{isError || (!diff && output) ? <Output text={output} error={isError} /> : null}
				</>
			);
		}
		case "write": {
			const content = typeof args.content === "string" ? args.content : "";
			const path = String(args.path ?? "");
			return (
				<>
					<div className="tool-meta">
						{content.split("\n").length} 行 · {formatBytes(new TextEncoder().encode(content).length)}
					</div>
					<pre className="tool-preview">
						<Highlighted code={content} language={languageForPath(path)} />
					</pre>
					{isError ? <Output text={output} error /> : null}
				</>
			);
		}
		case "read":
			return <Output text={output} error={isError} />;
		default: {
			const json = JSON.stringify(args, null, 2);
			return (
				<>
					{json !== "{}" ? (
						<pre className="tool-preview">
							<Highlighted code={json} language="json" />
						</pre>
					) : null}
					<Output text={output} error={isError} follow={running} />
				</>
			);
		}
	}
}

function defaultOpen(block: ToolBlock): boolean {
	if (block.status === "running" || block.status === "error") return true;
	if (block.call.name === "edit") return true;
	if (block.call.name === "bash" || block.call.name === "powershell") return block.status !== "done";
	return false;
}

export const ToolCard = memo(function ToolCard({
	block,
	approval,
}: {
	block: ToolBlock;
	approval?: UiRequest | undefined;
}) {
	const [openOverride, setOpen] = useState<boolean | undefined>(undefined);
	const open = openOverride ?? (approval ? true : defaultOpen(block));
	const { call, status } = block;
	const summary = summarizeToolCall(call.name, call.arguments);
	const label = TOOL_LABEL[call.name] ?? call.name;
	const Icon = TOOL_ICON[call.name] ?? IconWrench;
	const copyText = call.name === "bash" ? String((call.arguments as { command?: unknown }).command ?? "") : summary;
	return (
		<div className={`tool-card status-${status}${approval ? " awaiting" : ""}`}>
			<button type="button" className="tool-header" onClick={() => setOpen(!open)}>
				<span className="tool-icon">
					<Icon size={16} />
				</span>
				<span className="tool-name">{label}</span>
				<span className="tool-summary" title={summary}>
					{summary || (status === "generating" ? `${call.partialJson?.length ?? 0} 字节…` : "")}
				</span>
				<span className={`tool-status ${approval ? "awaiting" : status}`}>
					<StatusIcon status={status} awaiting={!!approval} />
					{approval ? "等待审批" : STATUS_LABEL[status]}
				</span>
				<IconChevronRight size={14} className={`chevron${open ? " open" : ""}`} />
			</button>
			{open ? (
				<div className="tool-body">
					{copyText ? (
						<div className="tool-actions">
							<CopyButton text={copyText} label={call.name === "bash" ? "复制命令" : "复制路径"} />
						</div>
					) : null}
					<ToolBody block={block} />
				</div>
			) : null}
		</div>
	);
});
