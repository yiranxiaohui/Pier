/**
 * The field model behind the settings forms (pi, Claude Code, Codex): which keys a form edits,
 * how, and their built-in defaults. Anything a form does not describe stays editable as text,
 * and the host keeps unknown keys when a field is changed.
 */

export type SettingsObject = Record<string, unknown>;

export type JsonScalar = string | number | boolean;

export type FieldKind =
	| { type: "boolean"; default: boolean }
	| { type: "enum"; options: Array<{ value: JsonScalar; label: string }>; default?: JsonScalar }
	| { type: "number"; default?: number; min?: number; max?: number; unit?: string }
	| {
			type: "string";
			placeholder?: string;
			mono?: boolean;
			/** A credential: hidden until revealed. */
			secret?: boolean;
			/** Values offered while typing (any other value is allowed too). */
			suggestions?: readonly string[];
			/** Offer suggestions in a dropdown, with an editor for custom values. */
			select?: boolean;
	  }
	| { type: "list"; placeholder?: string }
	/** Pick any of `options` (pi's built-in tools); stores the picked ones in this order. */
	| { type: "tools"; options: readonly string[]; default: string[] }
	/** An environment-variable switch: on stores `"1"`, off removes the variable. */
	| { type: "flag" }
	/** An object of string values edited as name / value rows (environment variables). */
	| { type: "map"; exclude?: readonly string[]; keyPlaceholder?: string; valuePlaceholder?: string };

export interface FieldDef {
	path: string[];
	label: string;
	description?: string;
	kind: FieldKind;
	/** Only read from the user (global) settings file. */
	globalOnly?: boolean;
	/** Only the terminal CLI uses it; Pier's sessions ignore it (and are not reloaded for it). */
	terminal?: boolean;
	/** Shown instead of a default value when the field has none. */
	defaultLabel?: string;
	/** Offer values detected on the host below the control (pi's `npmCommand`). */
	suggest?: "packageManagers";
}

export interface GroupDef {
	id: string;
	title: string;
	description?: string;
	/** Collapsed until opened (terminal-only settings). */
	collapsed?: boolean;
	fields: FieldDef[];
}

export function getPath(settings: SettingsObject | undefined, path: readonly string[]): unknown {
	let node: unknown = settings;
	for (const key of path) {
		if (typeof node !== "object" || node === null || Array.isArray(node) || !Object.hasOwn(node, key)) {
			return undefined;
		}
		node = (node as SettingsObject)[key];
	}
	return node;
}

function isPlainObject(value: unknown): value is SettingsObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is something the field's editor can show. */
export function isValidValue(kind: FieldKind, value: unknown): boolean {
	switch (kind.type) {
		case "boolean":
			return typeof value === "boolean";
		case "enum":
			return kind.options.some((option) => option.value === value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "string":
			return typeof value === "string";
		case "list":
		case "tools":
			return Array.isArray(value) && value.every((item) => typeof item === "string");
		case "flag":
			return typeof value === "string" || typeof value === "boolean" || typeof value === "number";
		case "map":
			return isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");
	}
}

/** Whether an environment-variable switch is on (`1`, `true`, `yes`). */
export function flagOn(value: unknown): boolean {
	return value === true || value === 1 || (typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim()));
}

/** The built-in default, or undefined when the CLI decides at run time. */
export function builtinDefault(field: FieldDef): unknown {
	return "default" in field.kind ? field.kind.default : undefined;
}

/** Human-readable form of a value for the field. */
export function formatValue(field: FieldDef, value: unknown): string {
	if (value === undefined) return field.defaultLabel ?? "未设置";
	const kind = field.kind;
	switch (kind.type) {
		case "boolean":
			return value ? "开启" : "关闭";
		case "flag":
			return flagOn(value) ? "开启" : "关闭";
		case "enum":
			return kind.options.find((option) => option.value === value)?.label ?? JSON.stringify(value);
		case "number":
			return `${value}${kind.unit ? ` ${kind.unit}` : ""}`;
		case "list":
		case "tools":
			return Array.isArray(value) ? (value.length ? value.join(kind.type === "tools" ? "、" : ", ") : "无") : "";
		case "map":
			return isPlainObject(value) ? (Object.keys(value).length ? Object.keys(value).join(", ") : "无") : "";
		case "string":
			return kind.secret && typeof value === "string" && value ? maskSecret(value) : String(value);
	}
}

/** A credential shown without giving it away: its first and last characters. */
export function maskSecret(value: string): string {
	if (value.length <= 8) return "•".repeat(value.length);
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Parse what the user typed into a number field. Returns `undefined` for an empty input
 * (remove the setting) or an error message.
 */
export function parseNumberInput(field: FieldDef, text: string): { value?: number; error?: string } {
	const kind = field.kind;
	if (kind.type !== "number") return { error: "不是数字设置" };
	const trimmed = text.trim();
	if (!trimmed) return {};
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value)) return { error: `${field.label}需要是整数` };
	if (kind.min !== undefined && value < kind.min) return { error: `${field.label}不能小于 ${kind.min}` };
	if (kind.max !== undefined && value > kind.max) return { error: `${field.label}不能大于 ${kind.max}` };
	return { value };
}

/** Lines of a list editor (trimmed, empty lines dropped); undefined when there are none. */
export function parseListInput(text: string): string[] | undefined {
	const items = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return items.length ? items : undefined;
}

export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a field matches the settings search box (label, description or key). */
export function fieldMatches(field: FieldDef, query: string): boolean {
	const q = query.trim().toLowerCase();
	return !q || `${field.label} ${field.description ?? ""} ${field.path.join(".")}`.toLowerCase().includes(q);
}

/** The groups with only the fields that match `query` (groups left empty are dropped). */
export function filterGroups(groups: readonly GroupDef[], query: string): GroupDef[] {
	return groups
		.map((group) => ({ ...group, fields: group.fields.filter((field) => fieldMatches(field, query)) }))
		.filter((group) => group.fields.length);
}

/** One change of a settings file: set `value` at `path`, or remove the key without `value`. */
export interface SettingsChange {
	path: string[];
	value?: unknown;
}

/** The change that stores `value` for a field (removing the key for `undefined`). */
export function fieldChange(field: FieldDef, value: unknown): SettingsChange {
	return value === undefined ? { path: field.path } : { path: field.path, value };
}
