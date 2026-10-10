import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
	type FieldDef,
	fieldChange,
	flagOn,
	formatValue,
	type GroupDef,
	getPath,
	isValidValue,
	type JsonScalar,
	parseListInput,
	parseNumberInput,
	type SettingsChange,
	type SettingsObject,
	sameValue,
} from "../lib/config-fields.ts";
import { useStore } from "../lib/store.tsx";
import {
	IconAlert,
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconEyeOff,
	IconInfo,
	IconLoader,
	IconPlus,
	IconTrash,
	IconUndo,
} from "./Icons.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

/**
 * Form controls for settings files (pi's settings.json, Claude Code's settings.json, Codex's
 * config.toml): one row per field, with the file's own value, what applies without it, and a
 * button that removes it; plus a text editor for the whole file.
 */

// ---- inputs ------------------------------------------------------------------------------

/** A text input that keeps what the user types until it is committed (Enter / blur) or reverted (Esc). */
export function DraftInput({
	value,
	placeholder,
	mono,
	numeric,
	secret,
	suggestions,
	disabled,
	className,
	ariaLabel,
	onCommit,
}: {
	value: string;
	placeholder?: string | undefined;
	mono?: boolean | undefined;
	numeric?: boolean | undefined;
	/** Hide the text (a credential) until revealed with the eye button. */
	secret?: boolean | undefined;
	suggestions?: readonly string[] | undefined;
	disabled?: boolean | undefined;
	className?: string | undefined;
	ariaLabel?: string | undefined;
	onCommit: (text: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const [revealed, setRevealed] = useState(false);
	const focused = useRef(false);
	const listId = useId();
	useEffect(() => {
		if (!focused.current) setDraft(value);
	}, [value]);
	const commit = () => {
		if (draft !== value) onCommit(draft);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			(e.target as HTMLInputElement).blur();
		} else if (e.key === "Escape" && draft !== value) {
			// Keep Esc from leaving the settings screen while reverting.
			e.stopPropagation();
			setDraft(value);
		}
	};
	const input = (
		<input
			className={`pi-setting-input${mono || secret ? " mono" : ""}${numeric ? " numeric" : ""}${className ? ` ${className}` : ""}`}
			type={secret && !revealed ? "password" : "text"}
			value={draft}
			placeholder={placeholder}
			disabled={disabled}
			aria-label={ariaLabel}
			inputMode={numeric ? "numeric" : undefined}
			list={suggestions?.length ? listId : undefined}
			autoComplete="off"
			spellCheck={false}
			autoCapitalize="off"
			autoCorrect="off"
			onFocus={() => {
				focused.current = true;
			}}
			onBlur={() => {
				focused.current = false;
				commit();
			}}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={onKeyDown}
		/>
	);
	const datalist = suggestions?.length ? (
		<datalist id={listId}>
			{suggestions.map((suggestion) => (
				<option key={suggestion} value={suggestion} />
			))}
		</datalist>
	) : null;
	if (!secret) {
		return datalist ? (
			<>
				{input}
				{datalist}
			</>
		) : (
			input
		);
	}
	return (
		<span className="config-secret">
			{input}
			{datalist}
			<button
				type="button"
				className="ghost icon"
				title={revealed ? "隐藏" : "显示"}
				aria-label={revealed ? "隐藏" : "显示"}
				onClick={() => setRevealed((r) => !r)}
			>
				{revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
			</button>
		</span>
	);
}

export function DraftList({
	value,
	placeholder,
	disabled,
	onCommit,
}: {
	value: string[] | undefined;
	placeholder?: string | undefined;
	disabled?: boolean | undefined;
	onCommit: (items: string[] | undefined) => void;
}) {
	const text = (value ?? []).join("\n");
	const [draft, setDraft] = useState(text);
	const focused = useRef(false);
	useEffect(() => {
		if (!focused.current) setDraft(text);
	}, [text]);
	return (
		<textarea
			className="pi-setting-list mono"
			rows={Math.min(8, Math.max(2, draft.split("\n").length))}
			value={draft}
			placeholder={placeholder}
			disabled={disabled}
			spellCheck={false}
			onFocus={() => {
				focused.current = true;
			}}
			onBlur={() => {
				focused.current = false;
				const items = parseListInput(draft);
				if (!sameValue(items, value)) onCommit(items);
				else setDraft(text);
			}}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					setDraft(text);
				}
			}}
		/>
	);
}

/** A dropdown of suggested models that also accepts an arbitrary model id. */
function StringSelect({
	value,
	defaultLabel,
	placeholder,
	suggestions,
	mono,
	disabled,
	ariaLabel,
	onCommit,
}: {
	value: string;
	defaultLabel: string;
	placeholder?: string | undefined;
	suggestions: readonly string[];
	mono?: boolean | undefined;
	disabled: boolean;
	ariaLabel: string;
	onCommit: (text: string) => void;
}) {
	const [custom, setCustom] = useState(false);
	const choices = [...new Set([...(value ? [value] : []), ...suggestions].filter(Boolean))];
	return (
		<div className="config-string-select">
			<Select
				className={`setting-select pi-setting-select${mono ? " mono" : ""}`}
				value={custom ? "custom" : value ? JSON.stringify(value) : ""}
				title={ariaLabel}
				disabled={disabled}
				options={[
					{ value: "", label: defaultLabel },
					...choices.map((choice) => ({ value: JSON.stringify(choice), label: choice })),
					{ value: "custom", label: "自定义模型…" },
				]}
				onChange={(next) => {
					setCustom(next === "custom");
					if (next !== "custom") onCommit(next ? (JSON.parse(next) as string) : "");
				}}
			/>
			{custom ? (
				<DraftInput
					value={value}
					placeholder={placeholder}
					mono={mono}
					disabled={disabled}
					ariaLabel={`自定义${ariaLabel}`}
					onCommit={onCommit}
				/>
			) : null}
		</div>
	);
}

/** Name / value rows of an object of strings (environment variables). */
function MapEditor({
	value,
	exclude,
	keyPlaceholder,
	valuePlaceholder,
	disabled,
	onChanges,
}: {
	value: SettingsObject | undefined;
	exclude: readonly string[];
	keyPlaceholder?: string | undefined;
	valuePlaceholder?: string | undefined;
	disabled: boolean;
	/** Changes relative to the object: `[name]` paths. */
	onChanges: (changes: Array<{ key: string; value?: string }>) => void;
}) {
	const store = useStore();
	const entries = Object.entries(value ?? {}).filter(([key]) => !exclude.includes(key));
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const add = () => {
		const key = newKey.trim();
		if (!key) return;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			store.toast("error", "变量名只能包含字母、数字和下划线，且不能以数字开头");
			return;
		}
		if (Object.hasOwn(value ?? {}, key)) {
			store.toast("error", `${key} 已经存在`);
			return;
		}
		onChanges([{ key, value: newValue }]);
		setNewKey("");
		setNewValue("");
	};
	return (
		<div className="config-map">
			{entries.map(([key, item]) => (
				<div className="config-map-row" key={key}>
					<code className="config-map-key" title={key}>
						{key}
					</code>
					<DraftInput
						value={typeof item === "string" ? item : JSON.stringify(item)}
						mono
						secret={/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)}
						disabled={disabled}
						ariaLabel={key}
						className="config-map-value"
						onCommit={(text) => onChanges([{ key, value: text }])}
					/>
					<button
						type="button"
						className="ghost icon"
						title={`移除 ${key}`}
						disabled={disabled}
						onClick={() => onChanges([{ key }])}
					>
						<IconTrash size={14} />
					</button>
				</div>
			))}
			<div className="config-map-row">
				<input
					className="pi-setting-input mono config-map-key"
					value={newKey}
					placeholder={keyPlaceholder ?? "变量名"}
					disabled={disabled}
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					onChange={(e) => setNewKey(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") add();
					}}
				/>
				<input
					className="pi-setting-input mono config-map-value"
					value={newValue}
					placeholder={valuePlaceholder ?? "值"}
					disabled={disabled}
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					onChange={(e) => setNewValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") add();
					}}
				/>
				<button type="button" className="ghost icon" title="添加" disabled={disabled || !newKey.trim()} onClick={add}>
					<IconPlus size={14} />
				</button>
			</div>
		</div>
	);
}

// ---- field rows --------------------------------------------------------------------------

export interface FieldRowProps {
	field: FieldDef;
	/** Value stored in the edited file. */
	own: unknown;
	/** What applies when the file does not set it (inherited value or built-in default). */
	fallback: unknown;
	/** The fallback comes from a lower-precedence file, named here (`全局`, `项目`). */
	inheritedFrom?: string | undefined;
	/** Name of the edited file, for the reset button's hint. */
	fileName: string;
	disabled: boolean;
	/** Shown instead of the fallback when the field cannot be edited in this file. */
	disabledReason?: string | undefined;
	saving: boolean;
	/** Values offered while typing, replacing the field's own suggestions. */
	suggestions?: readonly string[] | undefined;
	/** Extra content below the control (detected values). */
	extra?: ReactNode;
	onChanges: (field: FieldDef, changes: SettingsChange[]) => void;
}

function FieldControl(props: FieldRowProps) {
	const { field, own, fallback, inheritedFrom, disabled, suggestions, onChanges } = props;
	const store = useStore();
	const kind = field.kind;
	const valid = own !== undefined && isValidValue(kind, own);
	const shown = valid ? own : fallback;
	const set = (value: unknown) => onChanges(field, [fieldChange(field, value)]);
	switch (kind.type) {
		case "boolean":
			return <Switch checked={shown === true} disabled={disabled} label={field.label} onChange={set} />;
		case "flag":
			return (
				<Switch
					checked={flagOn(shown)}
					disabled={disabled}
					label={field.label}
					onChange={(checked) => set(checked ? "1" : undefined)}
				/>
			);
		case "enum": {
			const encode = (value: JsonScalar) => JSON.stringify(value);
			return (
				<Select
					className="setting-select pi-setting-select"
					value={valid ? encode(own as JsonScalar) : ""}
					disabled={disabled}
					onChange={(next) => set(next === "" ? undefined : (JSON.parse(next) as JsonScalar))}
					options={[
						{
							value: "",
							label: `${inheritedFrom ? `继承${inheritedFrom}` : "默认"}（${formatValue(field, fallback)}）`,
						},
						...kind.options.map((option) => ({ value: encode(option.value), label: option.label })),
					]}
				/>
			);
		}
		case "number":
			return (
				<span className="pi-setting-number">
					<DraftInput
						value={valid ? String(own) : ""}
						placeholder={fallback === undefined ? field.defaultLabel : String(fallback)}
						numeric
						disabled={disabled}
						onCommit={(text) => {
							const parsed = parseNumberInput(field, text);
							if (parsed.error) {
								store.toast("error", parsed.error);
								return;
							}
							set(parsed.value);
						}}
					/>
					{kind.unit ? <span className="pi-setting-unit">{kind.unit}</span> : null}
				</span>
			);
		case "string": {
			const placeholder =
				typeof fallback === "string" && fallback
					? kind.secret
						? formatValue(field, fallback)
						: fallback
					: kind.placeholder;
			const commit = (text: string) => set(text.trim() ? text.trim() : undefined);
			if (kind.select) {
				return (
					<StringSelect
						key={valid ? String(own) : ""}
						value={valid ? String(own) : ""}
						defaultLabel={`${inheritedFrom ? `继承${inheritedFrom}` : "默认"}（${formatValue(field, fallback)}）`}
						placeholder={placeholder}
						suggestions={suggestions ?? kind.suggestions ?? []}
						mono={kind.mono}
						disabled={disabled}
						ariaLabel={field.label}
						onCommit={commit}
					/>
				);
			}
			return (
				<DraftInput
					value={valid ? String(own) : ""}
					placeholder={placeholder}
					mono={kind.mono}
					secret={kind.secret}
					suggestions={suggestions ?? kind.suggestions}
					disabled={disabled}
					onCommit={commit}
				/>
			);
		}
		case "list":
			return (
				<DraftList
					value={valid ? (own as string[]) : undefined}
					placeholder={Array.isArray(fallback) && fallback.length ? fallback.join("\n") : kind.placeholder}
					disabled={disabled}
					onCommit={set}
				/>
			);
		case "tools": {
			const selected = new Set((shown as string[] | undefined) ?? []);
			const extra = [...selected].filter((tool) => !kind.options.includes(tool));
			const order = [...kind.options, ...extra];
			return (
				<div className="pi-tool-chips">
					{order.map((tool) => (
						<button
							type="button"
							key={tool}
							className={`pi-tool-chip mono${selected.has(tool) ? " on" : ""}`}
							aria-pressed={selected.has(tool)}
							disabled={disabled}
							onClick={() => {
								const next = new Set(selected);
								if (next.has(tool)) next.delete(tool);
								else next.add(tool);
								set(order.filter((t) => next.has(t)));
							}}
						>
							{tool}
						</button>
					))}
				</div>
			);
		}
		case "map":
			return (
				<MapEditor
					value={valid ? (own as SettingsObject) : undefined}
					exclude={kind.exclude ?? []}
					keyPlaceholder={kind.keyPlaceholder}
					valuePlaceholder={kind.valuePlaceholder}
					disabled={disabled}
					onChanges={(changes) =>
						onChanges(
							field,
							changes.map((c) =>
								c.value === undefined
									? { path: [...field.path, c.key] }
									: { path: [...field.path, c.key], value: c.value },
							),
						)
					}
				/>
			);
	}
}

/** Keys of a map field's object that the field itself shows (not handled by other fields). */
function mapKeys(field: FieldDef, own: unknown): string[] {
	if (field.kind.type !== "map" || typeof own !== "object" || own === null || Array.isArray(own)) return [];
	const exclude = field.kind.exclude ?? [];
	return Object.keys(own).filter((key) => !exclude.includes(key));
}

export function FieldRow(props: FieldRowProps) {
	const { field, own, fallback, inheritedFrom, fileName, disabled, saving, onChanges, disabledReason, extra } = props;
	const isMap = field.kind.type === "map";
	const set = isMap ? mapKeys(field, own).length > 0 : own !== undefined;
	const valid = own === undefined || isValidValue(field.kind, own);
	const stacked = field.kind.type === "list" || field.kind.type === "tools" || isMap;
	const key = field.path.join(".");
	const fallbackText = `${inheritedFrom ? `继承${inheritedFrom}` : "默认"}：${formatValue(field, fallback)}`;
	const control = <FieldControl {...props} disabled={disabled || saving} />;
	const reset = () => {
		if (isMap)
			onChanges(
				field,
				mapKeys(field, own).map((k) => ({ path: [...field.path, k] })),
			);
		else onChanges(field, [{ path: field.path }]);
	};
	return (
		<SettingRow
			stack={stacked}
			title={
				<span className="pi-setting-title">
					{field.label}
					{set ? (
						<span className={`mini-tag${valid ? " accent" : " warn"}`} title={valid ? undefined : JSON.stringify(own)}>
							{valid ? "已设置" : "值无效"}
						</span>
					) : null}
					{field.globalOnly ? <span className="mini-tag">仅全局</span> : null}
					{saving ? <IconLoader size={12} className="spin" /> : null}
				</span>
			}
			description={
				<>
					{field.description ? <span>{field.description} </span> : null}
					<span className="pi-setting-meta">
						<code>{key}</code>
						{isMap && !disabledReason ? null : <> · {disabledReason ?? fallbackText}</>}
					</span>
				</>
			}
		>
			{extra ? (
				<div className="pi-setting-suggested">
					{control}
					{extra}
				</div>
			) : (
				control
			)}
			{set ? (
				<button
					type="button"
					className="ghost icon"
					title={
						isMap
							? `移除这里的全部变量（从 ${fileName} 中删除）`
							: inheritedFrom
								? `移除这一项（改用${inheritedFrom}设置）`
								: `恢复默认（从 ${fileName} 中移除这一项）`
					}
					disabled={disabled || saving}
					onClick={reset}
				>
					<IconUndo size={14} />
				</button>
			) : stacked ? null : (
				<span className="pi-setting-reset-placeholder" />
			)}
		</SettingRow>
	);
}

// ---- groups ------------------------------------------------------------------------------

/** What a field shows when the edited file does not set it. */
export interface FieldFallback {
	value: unknown;
	/** Name of the lower-precedence file the value comes from; undefined for the built-in default. */
	from?: string | undefined;
}

/**
 * The groups of a form, with collapsible terminal-only groups. `rowProps` supplies what each
 * row needs besides the field (the page knows the files and what is being saved).
 */
export function ConfigGroups({
	groups,
	searching,
	row,
}: {
	groups: readonly GroupDef[];
	/** A search is active: show every group expanded. */
	searching: boolean;
	row: (field: FieldDef) => ReactNode;
}) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	return (
		<>
			{groups.map((group) => {
				const collapsed = group.collapsed && !searching && !open[group.id];
				return (
					<SettingsGroup
						key={group.id}
						title={
							group.collapsed && !searching ? (
								<button
									type="button"
									className="ghost pi-group-toggle"
									onClick={() => setOpen((s) => ({ ...s, [group.id]: !s[group.id] }))}
								>
									{collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
									{group.title}
								</button>
							) : (
								group.title
							)
						}
					>
						{group.description ? <p className="muted small settings-note">{group.description}</p> : null}
						{collapsed ? null : <SettingsCard className="pi-settings-card">{group.fields.map(row)}</SettingsCard>}
					</SettingsGroup>
				);
			})}
		</>
	);
}

/**
 * The value that applies when a file does not set `path`: the first valid one in the
 * lower-precedence files (nearest first), else the built-in default.
 */
export function resolveFallback(
	field: FieldDef,
	lower: ReadonlyArray<{ settings: SettingsObject | undefined; name: string }>,
	builtin: unknown,
): FieldFallback {
	for (const file of lower) {
		const value = getPath(file.settings, field.path);
		if (value !== undefined && isValidValue(field.kind, value)) return { value, from: file.name };
	}
	return { value: builtin };
}

// ---- text editor -------------------------------------------------------------------------

interface TextFile {
	path: string;
	text: string;
	exists: boolean;
	modifiedAt?: string;
}

/** The whole file as text, saved only when it parses (and, unless forced, was not changed meanwhile). */
export function TextFileEditor<F extends TextFile>({
	file,
	fileName,
	validate,
	format,
	emptyText,
	placeholder,
	externalHint,
	save,
	onSaved,
	onReload,
}: {
	file: F;
	fileName: string;
	/** Why the text cannot be saved, or undefined. */
	validate: (text: string) => string | undefined;
	/** Pretty-print the text (JSON); without it there is no 格式化 button. */
	format?: ((text: string) => string | undefined) | undefined;
	/** Saved instead of an empty editor. */
	emptyText: string;
	placeholder?: string | undefined;
	/** Who else might have changed the file, for the conflict banner. */
	externalHint: string;
	save: (text: string, expectedModifiedAt: string | undefined) => Promise<{ file: F; changed: boolean }>;
	onSaved: (file: F) => void;
	onReload: () => Promise<void>;
}) {
	const store = useStore();
	const [draft, setDraft] = useState(file.text);
	const [base, setBase] = useState(file.text);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState(false);
	const dirty = draft !== base;
	const external = file.text !== base;

	// Follow the file while there are no unsaved edits.
	useEffect(() => {
		if (!dirty) {
			setDraft(file.text);
			setBase(file.text);
		}
	}, [file.text, dirty]);

	const error = useMemo(() => (draft.trim() ? validate(draft) : undefined), [draft, validate]);

	const doSave = async (force = false) => {
		if (saving || error) return;
		setSaving(true);
		try {
			const text = draft.trim() ? draft : emptyText;
			const expected = force ? undefined : file.exists ? file.modifiedAt : undefined;
			const result = await save(text, expected);
			setConflict(false);
			setBase(result.file.text);
			setDraft(result.file.text);
			onSaved(result.file);
			store.toast("info", result.changed ? `已保存 ${fileName}` : "内容没有变化");
		} catch (e) {
			if ((e as { code?: string }).code === "CONFLICT") setConflict(true);
			else store.toast("error", `保存失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSaving(false);
		}
	};

	const formatted = format && !error ? format(draft) : undefined;

	/** Drop the edits; the effect above then follows the freshly read file. */
	const discard = () => {
		setConflict(false);
		setDraft(base);
		void onReload();
	};

	return (
		<SettingsCard className="pi-json-card">
			<div className="pi-json-head">
				<span className="muted small">
					{file.exists ? "直接编辑文件内容，保存前会检查格式。" : "文件尚不存在，保存时创建。"}
				</span>
				<span className="pi-json-actions">
					{format ? (
						<button
							type="button"
							className="ghost"
							disabled={formatted === undefined || saving}
							onClick={() => formatted !== undefined && setDraft(formatted)}
						>
							格式化
						</button>
					) : null}
					<button
						type="button"
						className="ghost"
						disabled={!dirty || saving}
						onClick={() => {
							setDraft(base);
							setConflict(false);
						}}
					>
						撤销修改
					</button>
					<button
						type="button"
						className="primary"
						disabled={!dirty || saving || Boolean(error)}
						onClick={() => void doSave()}
					>
						{saving ? <IconLoader size={13} className="spin" /> : null}
						保存
					</button>
				</span>
			</div>
			{conflict ? (
				<div className="banner warning inline">
					<IconAlert size={15} />
					<span>文件在读取后被修改过（{externalHint}）。</span>
					<span className="banner-actions">
						<button type="button" onClick={discard}>
							放弃修改并重新读取
						</button>
						<button type="button" className="danger" onClick={() => void doSave(true)}>
							仍然覆盖
						</button>
					</span>
				</div>
			) : dirty && external ? (
				<div className="banner info inline">
					<IconInfo size={15} />
					<span>文件已在别处更新；保存时会提示冲突。</span>
				</div>
			) : null}
			<textarea
				className="pi-json-editor mono"
				value={draft}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				placeholder={placeholder}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
						e.preventDefault();
						void doSave();
					} else if (e.key === "Escape") {
						e.stopPropagation();
					} else if (e.key === "Tab" && !e.shiftKey) {
						e.preventDefault();
						const target = e.currentTarget;
						const { selectionStart, selectionEnd } = target;
						setDraft(`${draft.slice(0, selectionStart)}  ${draft.slice(selectionEnd)}`);
						requestAnimationFrame(() => target.setSelectionRange(selectionStart + 2, selectionStart + 2));
					}
				}}
			/>
			<div className={`pi-json-status small${error ? " error-text" : " muted"}`}>
				{error ? `格式无效：${error}` : dirty ? "有未保存的修改（Ctrl/⌘ + S 保存）" : "与文件一致"}
			</div>
		</SettingsCard>
	);
}
