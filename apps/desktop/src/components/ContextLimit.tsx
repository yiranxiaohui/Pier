import {
	agentRuntimeLabel,
	type ChatController,
	type ChatState,
	contextLimitPresets,
	parseContextLimit,
} from "@pier/chat-state";
import type { AgentRuntimeInfo, ContextLimitSupport } from "@pier/protocol";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { formatTokens } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";
import { AnchoredMenu } from "./AnchoredMenu.tsx";
import { IconCheck } from "./Icons.tsx";

/** How the session's agent keeps to the limit, for the menu's note. */
function enforcementNote(runtime: string | undefined, support: ContextLimitSupport): string {
	if (support.enforcement === "turn") {
		return "每轮结束后检查，超过上限就压缩上下文；一轮之内仍可能暂时超过上限。";
	}
	switch (runtime) {
		case "claude-code":
			return "Claude Code 在上下文接近上限时自动压缩，正在运行时修改会在这一轮结束后生效。";
		case "codex":
			return "Codex 在上下文达到上限时自动压缩，正在运行时修改会在这一轮结束后生效。";
		default:
			return "每次请求模型前检查，上下文接近上限时自动压缩，修改立即生效。";
	}
}

/**
 * The status bar's context figure: a button that opens a menu to limit the session's context
 * (`contextLimit.set`, 1.64). Without the capability (older hosts) it is the plain figure.
 */
export function ContextLimitControl({
	chat,
	controller,
	title,
	children,
}: {
	chat: ChatState;
	controller: ChatController;
	title: string;
	children: ReactNode;
}) {
	const support = chat.capabilities?.contextLimit;
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	if (!support) return <span title={title}>{children}</span>;
	return (
		<>
			<button
				ref={anchor}
				type="button"
				className={`context-limit-trigger${open ? " open" : ""}${chat.contextInfo?.contextLimit !== undefined ? " limited" : ""}`}
				title={`${title}\n\n点击设置上下文上限`}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{children}
			</button>
			{open ? (
				<ContextLimitMenu
					anchor={anchor}
					chat={chat}
					controller={controller}
					support={support}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</>
	);
}

function ContextLimitMenu({
	anchor,
	chat,
	controller,
	support,
	onClose,
}: {
	anchor: RefObject<HTMLButtonElement | null>;
	chat: ChatState;
	controller: ChatController;
	support: ContextLimitSupport;
	onClose(): void;
}) {
	const store = useStore();
	const runtimeId = chat.session?.runtime;
	const [runtime, setRuntime] = useState<AgentRuntimeInfo>();
	const [asDefault, setAsDefault] = useState(false);
	const [custom, setCustom] = useState("");
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const modelWindow = chat.contextInfo?.contextWindow ?? chat.model?.contextWindow;
	const current = chat.contextInfo?.contextLimit;
	const presets = contextLimitPresets(support.min, modelWindow);
	if (current !== undefined && !presets.includes(current)) presets.push(current);
	presets.sort((a, b) => a - b);
	const agent = runtime?.name ?? agentRuntimeLabel(runtimeId);
	const defaultLimit = runtime?.contextLimitDefault;

	useEffect(() => {
		let alive = true;
		store
			.listRuntimes(controller.workspaceId)
			.then((runtimes) => {
				if (alive) setRuntime(runtimes.find((r) => r.id === (runtimeId ?? "pi")));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [store, controller.workspaceId, runtimeId]);

	const apply = async (limit: number | null) => {
		if (limit !== null && limit < support.min) {
			setError(`${agent} 的上下文上限至少为 ${formatTokens(support.min)}`);
			return;
		}
		setSaving(true);
		const result = await controller.setContextLimit(limit, asDefault);
		setSaving(false);
		if (result) onClose();
	};

	const submitCustom = () => {
		const limit = parseContextLimit(custom);
		if (limit === undefined) {
			setError("请输入 token 数，例如 200k、150000 或 1.5m");
			return;
		}
		void apply(limit);
	};

	// Keys the menu uses to move between its buttons edit the custom value here.
	const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			submitCustom();
		}
		if (["ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(event.key)) event.stopPropagation();
	};

	const item = (limit: number | null, label: string, detail?: string) => {
		const selected = limit === null ? current === undefined : current === limit;
		return (
			<button
				type="button"
				role="menuitemradio"
				aria-checked={selected}
				key={limit ?? "model"}
				className={`dropdown-item context-limit-item${selected ? " selected" : ""}`}
				disabled={saving}
				onClick={() => void apply(limit)}
			>
				<span className="context-limit-label">
					{label}
					{detail ? <span className="muted">{detail}</span> : null}
				</span>
				{selected ? <IconCheck size={14} /> : null}
			</button>
		);
	};

	return (
		<AnchoredMenu anchor={anchor} onClose={onClose} className="context-limit-menu" label="上下文上限">
			<div className="dropdown-group-title no-caps">上下文上限</div>
			{item(null, "跟随模型", modelWindow ? `窗口 ${formatTokens(modelWindow)}` : "使用模型的上下文窗口")}
			{presets.map((limit) =>
				item(limit, formatTokens(limit), defaultLimit === limit ? `${agent} 新会话默认` : undefined),
			)}
			<div className="context-limit-custom">
				<input
					value={custom}
					placeholder={`自定义，如 ${formatTokens(Math.max(support.min, 150_000))}`}
					aria-label="自定义上下文上限"
					disabled={saving}
					onChange={(e) => {
						setCustom(e.target.value);
						setError(undefined);
					}}
					onKeyDown={onInputKey}
				/>
				<button type="button" className="ghost" disabled={saving || !custom.trim()} onClick={submitCustom}>
					设置
				</button>
			</div>
			{error ? <div className="context-limit-error">{error}</div> : null}
			<label className="context-limit-default">
				<input type="checkbox" checked={asDefault} disabled={saving} onChange={(e) => setAsDefault(e.target.checked)} />
				同时作为 {agent} 新会话的默认上限
				{defaultLimit !== undefined ? <span className="muted">（当前 {formatTokens(defaultLimit)}）</span> : null}
			</label>
			<div className="dropdown-note">
				{enforcementNote(runtimeId, support)}上限不会超过模型窗口，最小 {formatTokens(support.min)}。
			</div>
		</AnchoredMenu>
	);
}
