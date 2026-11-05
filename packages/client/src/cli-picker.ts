/**
 * Arrow-key picker for pier-cli: pure state and rendering, plus a small driver that
 * borrows the terminal's keypress events from readline while the list is open.
 */
import type { EventEmitter } from "node:events";
import { c, displayWidth, fitWidth } from "./cli-style.ts";

export interface PickerItem<T> {
	label: string;
	detail?: string;
	/** Marked as the current choice; the cursor starts here. */
	current?: boolean;
	value: T;
}

export interface PickerOptions<T> {
	title: string;
	items: readonly PickerItem<T>[];
	/** At most this many rows of items are shown at once. */
	maxRows?: number;
}

export interface PickerState<T> {
	items: readonly PickerItem<T>[];
	filter: string;
	/** Selected position among the filtered items. */
	index: number;
	/** First filtered item shown. */
	top: number;
}

/** The subset of readline's keypress `key` the picker reads. */
export interface PickerKey {
	name?: string;
	ctrl?: boolean;
	meta?: boolean;
	sequence?: string;
}

export type PickerStep<T> = { state: PickerState<T> } | { done: PickerItem<T> } | { cancelled: true };

/** Items containing every whitespace-separated term of `filter`, case-insensitively. */
export function filterPickerItems<T>(items: readonly PickerItem<T>[], filter: string): PickerItem<T>[] {
	const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return [...items];
	return items.filter((item) => {
		const text = `${item.label} ${item.detail ?? ""}`.toLowerCase();
		return terms.every((term) => text.includes(term));
	});
}

export function initialPickerState<T>(items: readonly PickerItem<T>[], rows: number): PickerState<T> {
	const index = Math.max(
		0,
		items.findIndex((item) => item.current),
	);
	// Open with the current choice in the middle, so its neighbours show on both sides.
	return scrollTo({ items, filter: "", index, top: index - Math.floor(rows / 2) }, rows);
}

function scrollTo<T>(state: PickerState<T>, rows: number): PickerState<T> {
	let top = state.top;
	if (state.index < top) top = state.index;
	if (state.index >= top + rows) top = state.index - rows + 1;
	const count = filterPickerItems(state.items, state.filter).length;
	top = Math.max(0, Math.min(top, count - rows));
	return { ...state, top };
}

function isPrintable(sequence: string | undefined): sequence is string {
	if (!sequence) return false;
	for (const char of sequence) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/** Apply one keypress. `rows` is how many items are visible. */
export function stepPicker<T>(state: PickerState<T>, key: PickerKey, rows: number): PickerStep<T> {
	const visible = filterPickerItems(state.items, state.filter);
	const count = visible.length;
	const move = (index: number): PickerStep<T> => ({ state: scrollTo({ ...state, index }, rows) });
	const refilter = (filter: string): PickerStep<T> => {
		// Keep the cursor on the current choice when it still matches, otherwise go to the top.
		const index = Math.max(
			0,
			filterPickerItems(state.items, filter).findIndex((item) => item.current),
		);
		return { state: scrollTo({ ...state, filter, index, top: 0 }, rows) };
	};
	if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) return { cancelled: true };
	if (key.name === "return" || key.name === "enter") {
		const item = visible[state.index];
		return item ? { done: item } : { state };
	}
	if (key.name === "up" || (key.ctrl && key.name === "p"))
		return count ? move((state.index - 1 + count) % count) : { state };
	if (key.name === "down" || (key.ctrl && key.name === "n")) return count ? move((state.index + 1) % count) : { state };
	if (key.name === "pageup") return move(Math.max(0, state.index - rows));
	if (key.name === "pagedown") return move(Math.max(0, Math.min(count - 1, state.index + rows)));
	if (key.name === "home") return move(0);
	if (key.name === "end") return move(Math.max(0, count - 1));
	if (key.name === "backspace") return state.filter ? refilter([...state.filter].slice(0, -1).join("")) : { state };
	if (key.ctrl && key.name === "u") return state.filter ? refilter("") : { state };
	if (!key.ctrl && !key.meta && isPrintable(key.sequence)) return refilter(state.filter + key.sequence);
	return { state };
}

export { displayWidth, fitWidth };

const style = {
	dim: c.gray,
	bold: c.bold,
	cyan: c.accent,
	green: c.green,
};

/** The picker's lines, each at most `columns - 1` wide so none of them wraps. */
export function renderPicker<T>(state: PickerState<T>, title: string, columns: number, rows: number): string[] {
	const width = Math.max(10, columns - 1);
	const visible = filterPickerItems(state.items, state.filter);
	const lines = [
		style.bold(style.cyan(fitWidth(title, width))),
		style.dim(fitWidth("↑/↓ move · type to filter · Enter select · Esc cancel", width)),
		state.filter
			? `${style.cyan("filter:")} ${fitWidth(state.filter, width - 8)}`
			: style.dim("filter: (type to narrow the list)"),
	];
	if (!visible.length) lines.push(style.dim("  no matches"));
	for (const [offset, item] of visible.slice(state.top, state.top + rows).entries()) {
		const selected = state.top + offset === state.index;
		const mark = item.current ? " ✓" : "";
		const label = fitWidth(`${selected ? "❯" : " "} ${item.label}${mark}`, width);
		const room = width - displayWidth(label) - 2;
		const detail = item.detail && room > 3 ? `  ${fitWidth(item.detail, room)}` : "";
		lines.push(
			`${selected ? style.cyan(style.bold(label)) : item.current ? style.green(label) : label}${style.dim(detail)}`,
		);
	}
	if (visible.length > rows || state.filter)
		lines.push(
			style.dim(
				`${visible.length ? state.index + 1 : 0}/${visible.length}${visible.length < state.items.length ? ` of ${state.items.length}` : ""}`,
			),
		);
	return lines;
}

interface PickerOutput {
	write(text: string): unknown;
	columns?: number;
	rows?: number;
}

type KeypressListener = (sequence: string | undefined, key: PickerKey | undefined) => void;

/**
 * Show a picker below the cursor and resolve with the chosen value, or `undefined` when
 * cancelled. While open it takes the `keypress` listeners off `input` (readline's among
 * them) so typing does not reach the prompt, and restores them afterwards.
 */
export function runTerminalPicker<T>(
	input: EventEmitter,
	output: PickerOutput,
	options: PickerOptions<T>,
): Promise<T | undefined> {
	const rows = () => Math.max(3, Math.min(options.maxRows ?? 10, (output.rows ?? 24) - 6, options.items.length));
	let state = initialPickerState(options.items, rows());
	let drawn = 0;
	const erase = () => {
		if (drawn > 1) output.write(`\x1b[${drawn - 1}A`);
		output.write("\r\x1b[J");
		drawn = 0;
	};
	const draw = () => {
		erase();
		const lines = renderPicker(state, options.title, output.columns ?? 80, rows());
		output.write(lines.join("\n"));
		drawn = lines.length;
	};
	const saved = input.listeners("keypress") as KeypressListener[];
	for (const listener of saved) input.removeListener("keypress", listener);
	output.write("\x1b[?25l");
	draw();
	return new Promise((resolve) => {
		const finish = (value: T | undefined) => {
			erase();
			output.write("\x1b[?25h");
			input.removeListener("keypress", onKey);
			for (const listener of saved) input.on("keypress", listener);
			resolve(value);
		};
		const onKey: KeypressListener = (sequence, key) => {
			const step = stepPicker(state, key ?? { sequence }, rows());
			if ("cancelled" in step) finish(undefined);
			else if ("done" in step) finish(step.done.value);
			else {
				state = step.state;
				draw();
			}
		};
		input.on("keypress", onKey);
	});
}
