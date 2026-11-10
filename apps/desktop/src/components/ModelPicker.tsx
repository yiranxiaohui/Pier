import {
	type ChatController,
	type ChatState,
	clampThinking,
	supportedThinkingLevels,
	thinkingLabel,
} from "@pier/chat-state";
import type { AgentRuntimeInfo, ModelInfo, ThinkingLevel, WorkspaceInfo } from "@pier/protocol";
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import {
	IconArrowLeft,
	IconBrain,
	IconCheck,
	IconChevronRight,
	IconChevronUp,
	IconSearch,
	IconSettings,
	IconSparkles,
	IconZap,
} from "./Icons.tsx";
import { useOutsideClick } from "./SessionControls.tsx";
import { Switch } from "./SettingsUi.tsx";

/**
 * The thinking-level panel: a stepped slider, like a progress bar with one stop per level.
 * The thumb follows the pointer while dragging and glides to the nearest stop on release;
 * the picked stop shows right away instead of waiting for the host to confirm it.
 */
function ThinkingPanel({
	levels,
	value,
	onChange,
}: {
	levels: ThinkingLevel[];
	value: ThinkingLevel;
	onChange: (level: ThinkingLevel) => unknown;
}) {
	const rail = useRef<HTMLDivElement>(null);
	const press = useRef<number | undefined>(undefined);
	const request = useRef(0);
	/** Where the thumb is (0–1) while it's being dragged. */
	const [drag, setDrag] = useState<number | undefined>();
	/** The stop just picked, shown until the change lands. */
	const [pending, setPending] = useState<number | undefined>();
	const last = levels.length - 1;
	const settled = pending ?? Math.max(0, levels.indexOf(value));
	const index = drag !== undefined ? Math.round(drag * last) : settled;
	const position = drag ?? (last > 0 ? settled / last : 0);
	const percent = position * 100;
	const label = thinkingLabel(levels[index] ?? value);

	const ratioAt = (clientX: number): number => {
		const rect = rail.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return 0;
		return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
	};
	const commit = (next: number) => {
		const level = levels[next];
		if (!level) return;
		const id = ++request.current;
		if (level === value) {
			setPending(undefined);
			return;
		}
		setPending(next);
		void Promise.resolve(onChange(level)).finally(() => {
			if (request.current === id) setPending(undefined);
		});
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.currentTarget.focus();
		press.current = e.clientX;
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (press.current === undefined) return;
		// A click just picks a stop; only a real drag makes the thumb follow the pointer.
		if (drag === undefined && Math.abs(e.clientX - press.current) < 3) return;
		setDrag(ratioAt(e.clientX));
	};
	const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
		if (press.current === undefined) return;
		press.current = undefined;
		setDrag(undefined);
		commit(Math.round(ratioAt(e.clientX) * last));
	};
	const onPointerCancel = () => {
		press.current = undefined;
		setDrag(undefined);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step: Record<string, number> = {
			ArrowLeft: -1,
			ArrowDown: -1,
			ArrowRight: 1,
			ArrowUp: 1,
		};
		let next: number | undefined;
		if (e.key in step) next = Math.min(last, Math.max(0, settled + (step[e.key] ?? 0)));
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = last;
		if (next === undefined) return;
		e.preventDefault();
		commit(next);
	};

	return (
		<div className="thinking-panel" data-level={levels[index] ?? value}>
			<div className="thinking-panel-head">
				<span className="thinking-panel-title">
					<IconBrain size={14} />
					思考程度
				</span>
				<span key={label} className="thinking-panel-value">
					{label}
				</span>
			</div>
			<div
				className={`thinking-slider${drag !== undefined ? " dragging" : ""}`}
				data-level={levels[index] ?? value}
				role="slider"
				tabIndex={0}
				aria-label="思考程度"
				aria-valuemin={0}
				aria-valuemax={last}
				aria-valuenow={index}
				aria-valuetext={label}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerCancel}
				onKeyDown={onKeyDown}
			>
				<div ref={rail} className="thinking-slider-rail">
					<div className="thinking-slider-fill" style={{ width: `calc(${percent}% + 24px)` }}>
						<span className="thinking-slider-stars" aria-hidden="true" />
						<span className="thinking-slider-stars secondary" aria-hidden="true" />
					</div>
					{levels.map((level, i) => (
						<span
							key={level}
							className={`thinking-slider-stop${last > 0 && i / last <= position + 1e-6 ? " passed" : ""}`}
							style={{ left: `${last > 0 ? (i / last) * 100 : 0}%` }}
							title={thinkingLabel(level)}
						/>
					))}
					<span className="thinking-slider-thumb" style={{ left: `${percent}%` }} />
				</div>
			</div>
			<div className="thinking-panel-scale">
				<span>更快</span>
				<span>更深入</span>
			</div>
		</div>
	);
}

/**
 * The model's name on the composer chip. Claude Code calls its default model "Default (recommended)";
 * the note helps while choosing, so the list keeps it, but on the chip it only takes room.
 */
function chipName(model: ModelInfo): string {
	return (model.name || model.id).replace(/\s*\(recommended\)$/i, "");
}

interface ModelMenuProps {
	/** The computer whose models these are (for "manage models"). */
	node: string;
	model?: ModelInfo;
	thinkingLevel?: string;
	fastMode?: boolean;
	fastHint?: string;
	/** Still resolving which model will be used (the chip shows a placeholder). */
	loading?: boolean;
	disabled?: boolean;
	loadModels: () => Promise<ModelInfo[]>;
	/** Models come from Pier's providers (pi); other agents bring their own. */
	manageable?: boolean;
	onModel: (model: ModelInfo) => void;
	onThinking: (level: ThinkingLevel) => unknown;
	/** Present only when the selected runtime supports Fast mode. */
	onFast?: (enabled: boolean) => Promise<unknown>;
}

/**
 * The composer's model chip: a popover with the thinking-level slider and the current model,
 * which opens the model list (as in ChatGPT / Codex).
 */
function ModelMenu({
	node,
	model,
	thinkingLevel,
	fastMode,
	fastHint = "从下一轮请求生效",
	loading,
	disabled,
	loadModels,
	manageable = true,
	onModel,
	onThinking,
	onFast,
}: ModelMenuProps) {
	const store = useStore();
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"main" | "models">("main");
	/** Which way the last view switch went, so the new view slides in from that side. */
	const [motion, setMotion] = useState<"forward" | "back" | undefined>();
	/** The open menu's content height, so it can animate when the view or list changes. */
	const [height, setHeight] = useState<number | undefined>();
	const body = useRef<HTMLDivElement>(null);
	const [models, setModels] = useState<ModelInfo[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [filter, setFilter] = useState("");
	const [fastPending, setFastPending] = useState(false);
	const close = () => setOpen(false);
	const ref = useOutsideClick(open, close);
	const levels = supportedThinkingLevels(model);
	const canThink = levels.length > 1;
	const level = clampThinking(thinkingLevel ?? "medium", levels);
	const setFast = async (enabled: boolean) => {
		if (!onFast || fastPending || disabled) return;
		setFastPending(true);
		try {
			await onFast(enabled);
		} finally {
			setFastPending(false);
		}
	};

	useLayoutEffect(() => {
		const el = body.current;
		if (!open || !el) return;
		const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
		observer.observe(el);
		return () => {
			observer.disconnect();
			setHeight(undefined);
		};
	}, [open]);

	const go = (next: "main" | "models") => {
		setMotion(next === "models" ? "forward" : "back");
		setView(next);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per opening.
	useEffect(() => {
		if (!open) return;
		setError(undefined);
		setFilter("");
		loadModels()
			.then(setModels)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, [open]);

	const toggle = () => {
		if (open) {
			close();
			return;
		}
		setMotion(undefined);
		setView(model ? "main" : "models");
		setOpen(true);
	};

	const visible = (models ?? []).filter((m) =>
		`${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	const groups = new Map<string, ModelInfo[]>();
	for (const m of visible) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);

	const manage = manageable ? (
		<button
			type="button"
			className="dropdown-item manage-models"
			onClick={() => {
				close();
				store.openModels(node);
			}}
		>
			<span className="menu-label">
				<IconSettings size={14} />
				{models && !models.length ? "配置模型…" : "管理模型与服务商…"}
			</span>
		</button>
	) : null;

	return (
		<div className="dropdown" ref={ref}>
			<button
				type="button"
				className={`chip composer-model-chip${open ? " open" : ""}`}
				data-level={level}
				disabled={disabled}
				onClick={toggle}
				title={onFast ? "切换模型、思考程度与 Fast 模式" : "切换模型与思考程度"}
			>
				<span className="composer-model-name">{model ? chipName(model) : loading ? "加载模型…" : "选择模型"}</span>
				{model && canThink ? (
					<span key={level} className="composer-model-thinking">
						{thinkingLabel(level)}
					</span>
				) : null}
				{fastMode ? (
					<span className="composer-model-fast" title="Fast 模式已开启">
						<IconZap size={12} />
						Fast
					</span>
				) : null}
				<IconChevronUp size={13} className="chip-caret" />
			</button>
			{open ? (
				<div className={`dropdown-menu up right model-menu${view === "models" ? " list" : ""}`}>
					<div className="model-menu-frame" style={height === undefined ? undefined : { height }}>
						<div ref={body}>
							<div key={view} className={`model-menu-view${motion ? ` ${motion}` : ""}`}>
								{view === "main" && model ? (
									<>
										{canThink ? (
											<ThinkingPanel levels={levels} value={level} onChange={onThinking} />
										) : (
											<div className="thinking-panel-none muted">这个模型不支持调节思考程度</div>
										)}
										{onFast ? (
											<>
												<div className="dropdown-separator" />
												<div className="model-menu-fast" aria-busy={fastPending}>
													<div className="model-menu-current-text">
														<span className="menu-label">
															<IconZap size={14} />
															Fast 模式
														</span>
														<span className="model-menu-fast-hint">{fastPending ? "正在切换…" : fastHint}</span>
													</div>
													<Switch
														checked={fastMode === true}
														onChange={(enabled) => void setFast(enabled)}
														disabled={disabled || fastPending}
														label="Fast 模式"
													/>
												</div>
											</>
										) : null}
										<div className="dropdown-separator" />
										<button type="button" className="dropdown-item model-menu-current" onClick={() => go("models")}>
											<span className="menu-label">
												<IconSparkles size={14} />
												<span className="model-menu-current-text">
													<span className="model-menu-current-name">{model.name || model.id}</span>
													<span className="muted">{model.provider}</span>
												</span>
											</span>
											<span className="model-menu-switch">
												切换模型
												<IconChevronRight size={14} />
											</span>
										</button>
									</>
								) : (
									<>
										<div className="model-menu-header">
											{model ? (
												<button type="button" className="ghost icon" title="返回" onClick={() => go("main")}>
													<IconArrowLeft size={14} />
												</button>
											) : null}
											<span>选择模型</span>
										</div>
										<div className="dropdown-search">
											<IconSearch size={14} />
											<input
												// biome-ignore lint/a11y/noAutofocus: the list was just opened to search.
												autoFocus
												placeholder="搜索模型"
												value={filter}
												onChange={(e) => setFilter(e.target.value)}
											/>
										</div>
										<div className="model-menu-list">
											{error ? <div className="dropdown-empty error">{error}</div> : null}
											{!models && !error ? <div className="dropdown-empty">加载中…</div> : null}
											{models && !visible.length ? (
												<div className="dropdown-empty">
													{models.length ? "没有匹配的模型。" : "还没有可用的模型。"}
												</div>
											) : null}
											{[...groups].map(([provider, list]) => (
												<div key={provider} className="dropdown-group">
													<div className="dropdown-group-title">{provider}</div>
													{list.map((m) => {
														const selected = model?.provider === m.provider && model.id === m.id;
														return (
															<button
																type="button"
																key={m.id}
																className={`dropdown-item${selected ? " selected" : ""}`}
																onClick={() => {
																	go("main");
																	if (!selected) onModel(m);
																}}
															>
																<span className="model-item-text">
																	<span className="model-item-name">
																		{m.name || m.id}
																		{m.reasoning ? <span className="mini-tag">推理</span> : null}
																	</span>
																	<span className="muted">{m.id}</span>
																</span>
																{selected ? <IconCheck size={15} className="policy-check" /> : null}
															</button>
														);
													})}
												</div>
											))}
										</div>
										{manage}
									</>
								)}
							</div>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

/** Model and thinking level of an open session, switched right away. */
export function SessionModelPicker({ chat, controller }: { chat: ChatState; controller: ChatController }) {
	const store = useStore();
	return (
		<ModelMenu
			node={store.nodeOf(controller.workspaceId)}
			model={chat.model}
			thinkingLevel={chat.thinkingLevel}
			fastMode={chat.fastMode}
			loading={!chat.loaded}
			disabled={!!chat.closed || chat.capabilities?.setModel === false}
			manageable={(chat.session?.runtime ?? "pi") === "pi"}
			loadModels={() => controller.listModels().then((r) => r.models)}
			onModel={(m) => void controller.setModel(m.provider, m.id)}
			onThinking={(level) => controller.setThinking(level)}
			onFast={chat.capabilities?.fastMode ? (enabled) => controller.setFast(enabled) : undefined}
		/>
	);
}

/**
 * Model, thinking level and Fast mode for the chat the new-chat screen will create: starts from what the
 * workspace's computer would use, and is applied to the session before its first message.
 */
export function NewChatModelPicker({
	workspace,
	runtimes,
	disabled,
}: {
	workspace: WorkspaceInfo;
	runtimes: readonly AgentRuntimeInfo[];
	disabled?: boolean;
}) {
	const store = useStore();
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? s.node ?? LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const choice = useAppState((s) => s.newChatModel[node]);
	const runtime = useAppState((s) => s.newChatRuntime[node] ?? "pi");
	const canFast =
		runtime === "codex" && runtimes.some((r) => r.id === runtime && r.available && r.capabilities.fastMode);
	// Reload the defaults when this computer's providers or default model change.
	const providers = useAppState((s) => s.providers);
	const [defaults, setDefaults] = useState<
		{ models: ModelInfo[]; model?: ModelInfo; thinkingLevel?: ThinkingLevel } | undefined
	>();

	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the provider list changes.
	useEffect(() => {
		if (!online) return;
		let live = true;
		setDefaults(undefined);
		store
			.listModels(workspace.id, runtime)
			.then((r) => {
				if (!live) return;
				setDefaults({
					models: r.models,
					...(r.current ? { model: r.current } : {}),
					...(r.thinkingLevel ? { thinkingLevel: r.thinkingLevel } : {}),
				});
			})
			.catch(() => {
				if (live) setDefaults({ models: [] });
			});
		return () => {
			live = false;
		};
	}, [store, workspace.id, online, providers, runtime]);

	// A picked model that is no longer available falls back to the default.
	const stale = !!choice?.model && !!defaults && !defaults.models.some((m) => sameModel(m, choice.model));
	useEffect(() => {
		if (stale) store.setNewChatModel(workspace.id, { model: undefined, thinkingLevel: undefined });
	}, [stale, store, workspace.id]);
	const picked =
		choice?.model && !stale ? (defaults?.models.find((m) => sameModel(m, choice.model)) ?? choice.model) : undefined;
	const model = picked ?? defaults?.model;
	const level =
		choice?.thinkingLevel ??
		(defaults?.model && sameModel(model, defaults.model) ? defaults.thinkingLevel : undefined) ??
		"medium";

	return (
		<ModelMenu
			node={node}
			{...(model ? { model } : {})}
			thinkingLevel={level}
			fastMode={canFast ? choice?.fastMode : undefined}
			fastHint="从首条消息生效"
			loading={!defaults}
			{...(disabled ? { disabled } : {})}
			manageable={runtime === "pi"}
			loadModels={() =>
				store.listModels(workspace.id, runtime).then((r) => {
					setDefaults((d) => ({ ...d, models: r.models }));
					return r.models;
				})
			}
			onModel={(m) =>
				// Keep the level shown now (when the previous model could think), so what the chip
				// says is what the session gets; otherwise the new model starts from pi's default.
				store.setNewChatModel(workspace.id, {
					model: m,
					thinkingLevel:
						supportedThinkingLevels(model).length > 1
							? clampThinking(level, supportedThinkingLevels(model))
							: undefined,
				})
			}
			onThinking={(l) => store.setNewChatModel(workspace.id, { ...(model ? { model } : {}), thinkingLevel: l })}
			onFast={canFast ? async (enabled) => store.setNewChatModel(workspace.id, { fastMode: enabled }) : undefined}
		/>
	);
}

function sameModel(a: ModelInfo | undefined, b: ModelInfo | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}
