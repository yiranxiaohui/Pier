export interface PointerSelectionModifiers {
	shiftKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
}

export interface SelectionUpdate {
	selected: Set<string>;
	anchor: string;
	focus: string;
}

/** Return the visible paths between two entries, including both endpoints. */
export function selectionRange(paths: readonly string[], from: string, to: string): string[] {
	const start = paths.indexOf(from);
	const end = paths.indexOf(to);
	if (start < 0 || end < 0) return [to];
	const low = Math.min(start, end);
	const high = Math.max(start, end);
	return paths.slice(low, high + 1);
}

/** Apply the conventional plain, range, and additive pointer selection rules. */
export function selectByPointer(
	paths: readonly string[],
	current: ReadonlySet<string>,
	anchor: string | undefined,
	path: string,
	modifiers: PointerSelectionModifiers = {},
): SelectionUpdate {
	const additive = Boolean(modifiers.metaKey || modifiers.ctrlKey);
	if (modifiers.shiftKey) {
		const next = new Set(additive ? current : undefined);
		for (const selected of selectionRange(paths, anchor ?? path, path)) next.add(selected);
		return { selected: next, anchor: anchor ?? path, focus: path };
	}
	if (additive) {
		const next = new Set(current);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		return { selected: next, anchor: path, focus: path };
	}
	return { selected: new Set([path]), anchor: path, focus: path };
}

/** Apply Shift+Arrow range extension from the existing anchor. */
export function selectByKeyboard(
	paths: readonly string[],
	anchor: string | undefined,
	path: string,
	extend: boolean,
): SelectionUpdate {
	if (!extend) return { selected: new Set([path]), anchor: path, focus: path };
	const next = new Set<string>();
	for (const selected of selectionRange(paths, anchor ?? path, path)) next.add(selected);
	return { selected: next, anchor: anchor ?? path, focus: path };
}
