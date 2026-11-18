import type * as Monaco from "monaco-editor";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cursorStatus, visibleColumn } from "../lib/code-editor.ts";
import { IconLoader, IconLock } from "./Icons.tsx";

type MonacoModule = typeof import("../lib/monaco.ts");

let loading: Promise<MonacoModule> | undefined;

/**
 * Load Monaco once, on first use. The Chinese UI strings go first: Monaco looks them up while it
 * loads. A failed load is forgotten so the next editor tries again.
 */
export function loadMonaco(): Promise<MonacoModule> {
	loading ??= import("monaco-editor/nls/lang/zh-cn")
		.then(() => import("../lib/monaco.ts"))
		.catch((error: unknown) => {
			loading = undefined;
			throw error;
		});
	return loading;
}

/** What the file viewer asks of the editor; the text lives in the editor while it is open. */
export interface CodeEditorHandle {
	/** The text being edited, with the file's line endings. */
	getValue(): string;
	/** Marks the current text; `markSaved` with it after writing that text clears the unsaved state. */
	version(): number;
	markSaved(version: number): void;
	/** Replace the text with `text` as one undoable edit and treat it as saved. */
	revert(text: string): void;
	focus(): void;
}

interface Status {
	line: number;
	column: number;
	selections: number;
	selected: number;
	tabSize: number;
	insertSpaces: boolean;
	crlf: boolean;
	language: string;
	errors: number;
	warnings: number;
}

/** Prose: wrapped, without word completions popping up while typing (VS Code's Markdown defaults). */
const PROSE = new Set(["markdown", "mdx", "plaintext", "restructuredtext"]);

let modelCount = 0;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const SAVE_SHORTCUT = isMac ? "⌘S" : "Ctrl+S";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * VS Code's editor (Monaco) for one file, with a VS Code style status bar: cursor position,
 * indentation, encoding, line endings, language and problems. `value` is read when the editor is
 * created; remount it (change its `key`) to show a newly read file. Ctrl/⌘+S calls `onSave`.
 */
export function CodeEditor({
	ref,
	path,
	value,
	readOnly = false,
	readOnlyReason,
	onDirtyChange,
	onSave,
}: {
	ref?: Ref<CodeEditorHandle> | undefined;
	path: string;
	value: string;
	readOnly?: boolean;
	readOnlyReason?: string | undefined;
	onDirtyChange?: ((dirty: boolean) => void) | undefined;
	onSave?: (() => void) | undefined;
}) {
	const host = useRef<HTMLDivElement>(null);
	const [api, setApi] = useState<MonacoModule>();
	const [loadError, setLoadError] = useState<unknown>();
	const [attempt, setAttempt] = useState(0);
	const [status, setStatus] = useState<Status>();
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor>(undefined);
	const savedVersion = useRef(0);
	const dirty = useRef(false);
	const initialValue = useRef(value);
	const options = useRef({ readOnly, readOnlyReason });
	options.current = { readOnly, readOnlyReason };
	const callbacks = useRef({ onDirtyChange, onSave });
	callbacks.current = { onDirtyChange, onSave };

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` changes to retry a failed load.
	useEffect(() => {
		let live = true;
		setLoadError(undefined);
		loadMonaco().then(
			(module) => live && setApi(module),
			(error: unknown) => live && setLoadError(error),
		);
		return () => {
			live = false;
		};
	}, [attempt]);

	const reportDirty = useCallback(() => {
		const model = editorRef.current?.getModel();
		const next = !!model && model.getAlternativeVersionId() !== savedVersion.current;
		if (next === dirty.current) return;
		dirty.current = next;
		callbacks.current.onDirtyChange?.(next);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once per file; options follow below.
	useEffect(() => {
		const element = host.current;
		if (!api || !element) return;
		const { monaco } = api;
		const text = initialValue.current;
		const language = api.languageFor(path, text);
		const filePath = path.replace(/\\/g, "/").replace(/^\/+/, "");
		const model = monaco.editor.createModel(
			text,
			language,
			monaco.Uri.from({ scheme: "file", path: `/pier/${++modelCount}/${filePath}` }),
		);
		const prose = PROSE.has(language);
		const style = getComputedStyle(document.documentElement);
		const editor = monaco.editor.create(element, {
			model,
			theme: api.THEME,
			readOnly: options.current.readOnly,
			...(options.current.readOnlyReason ? { readOnlyMessage: { value: options.current.readOnlyReason } } : {}),
			automaticLayout: true,
			fontFamily: style.getPropertyValue("--mono").trim() || "monospace",
			fontSize: 13,
			lineHeight: 20,
			padding: { top: 6 },
			minimap: { enabled: true },
			stickyScroll: { enabled: true },
			bracketPairColorization: { enabled: true },
			guides: { bracketPairs: "active", indentation: true },
			renderWhitespace: "selection",
			wordWrap: prose ? "on" : "off",
			quickSuggestions: !prose,
			wordBasedSuggestions: prose ? "off" : "currentDocument",
			// Chinese punctuation in comments and strings is intended, not a look-alike of ASCII.
			unicodeHighlight: { ambiguousCharacters: false },
			scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
		});
		editorRef.current = editor;
		savedVersion.current = model.getAlternativeVersionId();
		dirty.current = false;

		editor.addAction({
			id: "pier.saveFile",
			label: "保存文件",
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
			run: () => {
				if (!options.current.readOnly) callbacks.current.onSave?.();
			},
		});
		let wrapped = prose;
		editor.addAction({
			id: "pier.toggleWordWrap",
			label: "切换自动换行",
			keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
			run: () => {
				wrapped = !wrapped;
				editor.updateOptions({ wordWrap: wrapped ? "on" : "off" });
			},
		});

		const update = () => {
			const position = editor.getPosition();
			const selections = editor.getSelections() ?? [];
			const modelOptions = model.getOptions();
			const markers = monaco.editor.getModelMarkers({ resource: model.uri });
			setStatus({
				line: position?.lineNumber ?? 1,
				column: position
					? visibleColumn(model.getLineContent(position.lineNumber), position.column, modelOptions.tabSize)
					: 1,
				selections: selections.length,
				selected: selections.reduce((sum, selection) => sum + model.getValueLengthInRange(selection), 0),
				tabSize: modelOptions.tabSize,
				insertSpaces: modelOptions.insertSpaces,
				crlf: model.getEOL() === "\r\n",
				language: api.languageName(model.getLanguageId()),
				errors: markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Error).length,
				warnings: markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Warning).length,
			});
		};
		update();
		const uri = model.uri.toString();
		const subscriptions = [
			editor.onDidChangeCursorSelection(update),
			model.onDidChangeOptions(update),
			model.onDidChangeLanguage(update),
			model.onDidChangeContent(() => {
				reportDirty();
				update();
			}),
			monaco.editor.onDidChangeMarkers((uris) => {
				if (uris.some((changed) => changed.toString() === uri)) update();
			}),
		];
		return () => {
			for (const subscription of subscriptions) subscription.dispose();
			editorRef.current = undefined;
			editor.dispose();
			model.dispose();
		};
	}, [api]);

	useEffect(() => {
		editorRef.current?.updateOptions({
			readOnly,
			...(readOnlyReason ? { readOnlyMessage: { value: readOnlyReason } } : {}),
		});
	}, [readOnly, readOnlyReason]);

	useImperativeHandle(
		ref,
		() => ({
			getValue: () => editorRef.current?.getModel()?.getValue() ?? initialValue.current,
			version: () => editorRef.current?.getModel()?.getAlternativeVersionId() ?? savedVersion.current,
			markSaved: (version: number) => {
				savedVersion.current = version;
				reportDirty();
			},
			revert: (text: string) => {
				const editor = editorRef.current;
				const model = editor?.getModel();
				if (!editor || !model || !api) return;
				model.pushStackElement();
				model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
				model.pushEOL(
					text.includes("\r\n") ? api.monaco.editor.EndOfLineSequence.CRLF : api.monaco.editor.EndOfLineSequence.LF,
				);
				model.pushStackElement();
				savedVersion.current = model.getAlternativeVersionId();
				reportDirty();
			},
			focus: () => editorRef.current?.focus(),
		}),
		[api, reportDirty],
	);

	const run = (action: string) => {
		const editor = editorRef.current;
		if (!editor) return;
		editor.focus();
		void editor.getAction(action)?.run();
	};
	const toggleLineEndings = () => {
		const model = editorRef.current?.getModel();
		if (!model || !api || readOnly) return;
		const { EndOfLineSequence } = api.monaco.editor;
		model.pushStackElement();
		model.pushEOL(model.getEOL() === "\r\n" ? EndOfLineSequence.LF : EndOfLineSequence.CRLF);
		model.pushStackElement();
	};

	if (loadError !== undefined) {
		return (
			<div className="code-editor">
				<div className="file-viewer-banner error row">
					<span>代码编辑器加载失败：{errorMessage(loadError)}</span>
					<button type="button" className="ghost small" onClick={() => setAttempt((n) => n + 1)}>
						重试
					</button>
				</div>
				<pre className="code-editor-fallback">{value}</pre>
			</div>
		);
	}

	return (
		<div className="code-editor">
			<div className="code-editor-host">
				<div ref={host} className="code-editor-mount" />
				{api ? null : (
					<div className="code-editor-loading">
						<IconLoader size={16} className="spin" />
						正在加载编辑器…
					</div>
				)}
			</div>
			{status ? (
				<div className="code-editor-status">
					<span className="code-editor-status-group">
						<button
							type="button"
							className="code-editor-status-item"
							title={status.errors || status.warnings ? "转到下一个问题 (F8)" : "没有问题"}
							onClick={() => run("editor.action.marker.next")}
						>
							<span className="codicon codicon-error" aria-hidden="true" />
							{status.errors}
							<span className="codicon codicon-warning" aria-hidden="true" />
							{status.warnings}
						</button>
						{readOnly ? (
							<span className="code-editor-status-item code-editor-readonly" title={readOnlyReason}>
								<IconLock size={12} />
								只读
							</span>
						) : null}
					</span>
					<span className="code-editor-status-group">
						<button
							type="button"
							className="code-editor-status-item"
							title="转到行/列"
							onClick={() => run("editor.action.gotoLine")}
						>
							{cursorStatus(status)}
						</button>
						<span className="code-editor-status-item" title="缩进">
							{status.insertSpaces ? `空格: ${status.tabSize}` : `制表符长度: ${status.tabSize}`}
						</span>
						<span className="code-editor-status-item">UTF-8</span>
						<button
							type="button"
							className="code-editor-status-item"
							title={readOnly ? "行尾序列" : "切换行尾序列"}
							disabled={readOnly}
							onClick={toggleLineEndings}
						>
							{status.crlf ? "CRLF" : "LF"}
						</button>
						<span className="code-editor-status-item">{status.language}</span>
					</span>
				</div>
			) : null}
		</div>
	);
}
