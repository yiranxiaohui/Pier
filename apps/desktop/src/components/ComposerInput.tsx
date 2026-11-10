import {
	forwardRef,
	type ClipboardEvent as ReactClipboardEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
} from "react";
import { draftToPrompt, fileChipLabel, fileToken, splitDraft, stripMarkers } from "../lib/composer-text.ts";

export interface ComposerInputHandle {
	focus(): void;
	/** Insert a file chip at the caret (or where the caret last was), separated by spaces. */
	insertFile(path: string, directory: boolean): void;
}

interface Props {
	/** The draft, with file chips encoded (see `composer-text.ts`). */
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	disabled?: boolean;
	/** Runs first; call `preventDefault()` to stop the default handling (e.g. Enter sends). */
	onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
	/** Runs first; call `preventDefault()` when the paste was handled (e.g. images). */
	onPaste?: (event: ReactClipboardEvent<HTMLDivElement>) => void;
	/** A file chip was clicked. */
	onOpenFile?: (path: string) => void;
}

// Lucide's file, folder and x, as markup for the contenteditable chips (see Icons.tsx).
const SVG_ATTRS =
	'width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon-svg"';
const FILE_ICON = `<svg ${SVG_ATTRS}><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/></svg>`;
const FOLDER_ICON = `<svg ${SVG_ATTRS}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
const REMOVE_ICON = `<svg ${SVG_ATTRS} width="11" height="11"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

function createChip(path: string): HTMLSpanElement {
	const directory = path.endsWith("/");
	const chip = document.createElement("span");
	chip.className = `composer-chip${directory ? " dir" : ""}`;
	chip.contentEditable = "false";
	chip.dataset.path = path;
	chip.title = directory ? path : `${path}（点击查看）`;
	chip.innerHTML = `${directory ? FOLDER_ICON : FILE_ICON}<span class="composer-chip-name"></span><span class="composer-chip-remove" role="button" title="移除" aria-label="移除">${REMOVE_ICON}</span>`;
	const name = chip.querySelector(".composer-chip-name");
	if (name) name.textContent = fileChipLabel(path);
	return chip;
}

function isChip(node: Node): node is HTMLElement {
	return node instanceof HTMLElement && node.classList.contains("composer-chip");
}

const BLOCKS = new Set(["DIV", "P", "LI"]);

/**
 * Serialize editor content back to a draft string. Line breaks may be `<br>`, "\n" in text
 * (the editor uses `white-space: pre-wrap`) or blocks; browsers create all three. A line
 * break at the very end is not visible, so one trailing line break is dropped: that is the
 * placeholder a browser keeps to show an empty last line.
 */
export function serialize(root: Node): string {
	let out = "";
	let trailingBr = false;
	const walk = (node: Node) => {
		for (const child of node.childNodes) {
			const text =
				child.nodeType === Node.TEXT_NODE ? stripMarkers((child as Text).data.replace(/\u200b/g, "")) : undefined;
			if (text === "") continue;
			trailingBr = false;
			if (text !== undefined) {
				out += text;
				trailingBr = text.endsWith("\n");
			} else if (isChip(child)) {
				out += fileToken(child.dataset.path ?? "", (child.dataset.path ?? "").endsWith("/"));
			} else if (child.nodeName === "BR") {
				out += "\n";
				trailingBr = true;
			} else if (BLOCKS.has(child.nodeName)) {
				if (out && !out.endsWith("\n")) out += "\n";
				walk(child);
				if (!out.endsWith("\n")) {
					out += "\n";
					trailingBr = true;
				}
			} else {
				walk(child);
			}
		}
	};
	walk(root);
	return trailingBr ? out.slice(0, -1) : out;
}

function render(root: HTMLElement, value: string): void {
	root.replaceChildren();
	for (const part of splitDraft(value)) {
		if (part.type === "file") {
			root.append(createChip(part.path));
			continue;
		}
		part.text.split("\n").forEach((line, i) => {
			if (i) root.append(document.createElement("br"));
			if (line) root.append(document.createTextNode(line));
		});
	}
	// A final line break only shows up with a placeholder `<br>` after it.
	if (value.endsWith("\n")) root.append(document.createElement("br"));
}

function caretToEnd(root: HTMLElement): void {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.selectNodeContents(root);
	range.collapse(false);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** Text on each side of `range` inside `root`, as draft strings. */
function around(root: HTMLElement, range: Range): { before: string; after: string } {
	const pre = document.createRange();
	pre.selectNodeContents(root);
	pre.setEnd(range.startContainer, range.startOffset);
	const post = document.createRange();
	post.selectNodeContents(root);
	post.setStart(range.endContainer, range.endOffset);
	return { before: serialize(pre.cloneContents()), after: serialize(post.cloneContents()) };
}

/**
 * The composer's text input: plain text plus inline file chips. Chips behave as single
 * characters (Backspace removes one), have a remove button, and open the file on click.
 * The DOM is only rebuilt when `value` changes from outside (sending, slash commands).
 */
export const ComposerInput = forwardRef<ComposerInputHandle, Props>(function ComposerInput(
	{ value, onChange, placeholder, disabled, onKeyDown, onPaste, onOpenFile },
	ref,
) {
	const rootRef = useRef<HTMLDivElement>(null);
	/** The value the DOM currently shows; `null` until the first render. */
	const shown = useRef<string | null>(null);
	/** Where the caret was last inside the editor, so the file panel can insert there. */
	const lastRange = useRef<Range | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root || shown.current === value) return;
		const focused = document.activeElement === root;
		render(root, value);
		shown.current = value;
		lastRange.current = null;
		if (focused) caretToEnd(root);
	}, [value]);

	useEffect(() => {
		const onSelection = () => {
			const root = rootRef.current;
			const selection = window.getSelection();
			if (!root || !selection?.rangeCount) return;
			const range = selection.getRangeAt(0);
			if (root.contains(range.startContainer) && root.contains(range.endContainer)) {
				lastRange.current = range.cloneRange();
			}
		};
		document.addEventListener("selectionchange", onSelection);
		return () => document.removeEventListener("selectionchange", onSelection);
	}, []);

	const emit = () => {
		const root = rootRef.current;
		if (!root) return;
		const next = serialize(root);
		shown.current = next;
		onChangeRef.current(next);
	};

	useImperativeHandle(ref, () => ({
		focus() {
			const root = rootRef.current;
			if (!root) return;
			root.focus();
			const range = lastRange.current;
			const selection = window.getSelection();
			if (range && root.contains(range.startContainer) && selection) {
				selection.removeAllRanges();
				selection.addRange(range);
			} else caretToEnd(root);
		},
		insertFile(path, directory) {
			const root = rootRef.current;
			if (!root) return;
			let range = lastRange.current;
			if (!range || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
				range = document.createRange();
				range.selectNodeContents(root);
				range.collapse(false);
			}
			const { before, after } = around(root, range);
			range.deleteContents();
			const fragment = document.createDocumentFragment();
			if (before && !/\s$/.test(before)) fragment.append(document.createTextNode(" "));
			fragment.append(createChip(directory ? `${path.replace(/\/+$/, "")}/` : path));
			const trail = document.createTextNode(" ");
			if (!/^\s/.test(after)) fragment.append(trail);
			range.insertNode(fragment);
			root.focus();
			const caret = document.createRange();
			if (trail.parentNode) caret.setStartAfter(trail);
			else caret.setStart(range.endContainer, range.endOffset);
			caret.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(caret);
			lastRange.current = caret.cloneRange();
			emit();
		},
	}));

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		onKeyDown?.(event);
		if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === "Enter") {
			event.preventDefault();
			document.execCommand("insertLineBreak");
			return;
		}
		// Rich-text shortcuts would add markup that the draft cannot hold.
		if ((event.metaKey || event.ctrlKey) && !event.altKey && ["b", "i", "u"].includes(event.key.toLowerCase())) {
			event.preventDefault();
		}
	};

	const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
		onPaste?.(event);
		if (event.defaultPrevented) return;
		event.preventDefault();
		const text = stripMarkers(event.clipboardData.getData("text/plain")).replace(/\r\n?/g, "\n");
		if (text) document.execCommand("insertText", false, text);
	};

	/** Copy the selection as plain text, with chips as their paths. */
	const handleCopy = (event: ReactClipboardEvent<HTMLDivElement>, cut: boolean) => {
		const selection = window.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed) return;
		const draft = serialize(selection.getRangeAt(0).cloneContents());
		event.preventDefault();
		event.clipboardData.setData("text/plain", draftToPrompt(draft));
		if (cut && !disabled) {
			document.execCommand("delete");
		}
	};

	const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
		// Clicking a chip must not move the caret or select the chip.
		if ((event.target as Element).closest(".composer-chip")) event.preventDefault();
	};

	const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
		const target = event.target as Element;
		const chip = target.closest(".composer-chip");
		if (!(chip instanceof HTMLElement) || !rootRef.current?.contains(chip)) return;
		event.preventDefault();
		if (target.closest(".composer-chip-remove")) {
			if (disabled) return;
			// Take the space that followed the chip with it.
			const next = chip.nextSibling;
			if (next?.nodeType === Node.TEXT_NODE && (next as Text).data.startsWith(" ")) {
				(next as Text).deleteData(0, 1);
				if (!(next as Text).data) next.remove();
			}
			chip.remove();
			emit();
			rootRef.current.focus();
			return;
		}
		const path = chip.dataset.path;
		if (path && !path.endsWith("/")) onOpenFile?.(path);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold inline file chips.
		<div
			ref={rootRef}
			className={`composer-input${value ? "" : " empty"}`}
			role="textbox"
			aria-multiline="true"
			aria-placeholder={placeholder}
			aria-disabled={disabled || undefined}
			tabIndex={disabled ? -1 : 0}
			data-placeholder={placeholder}
			contentEditable={!disabled}
			suppressContentEditableWarning
			spellCheck={false}
			onInput={emit}
			onKeyDown={handleKeyDown}
			onPaste={handlePaste}
			onCopy={(e) => handleCopy(e, false)}
			onCut={(e) => handleCopy(e, true)}
			onMouseDown={handleMouseDown}
			onClick={handleClick}
			onDrop={(e) => e.preventDefault()}
		/>
	);
});
