import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { fallbackLanguage } from "./code-editor.ts";
import { onThemeChange } from "./theme.ts";

/**
 * The Monaco editor (VS Code's editor) set up for the file viewer. Loaded on demand by
 * `loadMonaco` in CodeEditor.tsx, after the Chinese UI strings, so it stays out of the start-up bundle.
 */

// Vite bundles each worker; Monaco asks for them by language label.
globalThis.MonacoEnvironment = {
	getWorker(_workerId, label) {
		switch (label) {
			case "json":
				return new JsonWorker();
			case "css":
			case "scss":
			case "less":
				return new CssWorker();
			case "html":
			case "handlebars":
			case "razor":
				return new HtmlWorker();
			case "typescript":
			case "javascript":
				return new TsWorker();
			default:
				return new EditorWorker();
		}
	},
};

// Files are edited one at a time, outside their project: imports and types from other files cannot
// be resolved, so report syntax errors only (as VS Code does for a loose file).
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
	defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSuggestionDiagnostics: true });
	defaults.setCompilerOptions({
		target: monaco.typescript.ScriptTarget.ESNext,
		module: monaco.typescript.ModuleKind.ESNext,
		moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
		jsx: monaco.typescript.JsxEmit.Preserve,
		allowJs: true,
		allowNonTsExtensions: true,
		esModuleInterop: true,
	});
}
// tsconfig.json, VS Code settings and the like carry comments and trailing commas.
monaco.json.jsonDefaults.setDiagnosticsOptions({
	validate: true,
	allowComments: true,
	trailingCommas: "ignore",
	enableSchemaRequest: false,
});

/** The language Monaco registers for a file name (exact names first, then the longest extension). */
function registeredLanguage(name: string, firstLine: string): string | undefined {
	const lower = name.toLowerCase();
	const languages = monaco.languages.getLanguages();
	let best: { id: string; length: number } | undefined;
	for (const language of languages) {
		if (language.filenames?.some((filename) => filename.toLowerCase() === lower)) return language.id;
		for (const ext of language.extensions ?? []) {
			const suffix = ext.toLowerCase();
			if (lower.endsWith(suffix) && suffix.length > (best?.length ?? 0)) {
				best = { id: language.id, length: suffix.length };
			}
		}
	}
	if (best) return best.id;
	for (const language of languages) {
		if (!language.firstLine) continue;
		try {
			if (new RegExp(language.firstLine).test(firstLine)) return language.id;
		} catch {
			// A pattern this engine cannot compile.
		}
	}
	return undefined;
}

/** The language of a file: Monaco's own match by name and first line, else the closest one it has. */
export function languageFor(path: string, text: string): string {
	const name = path.split(/[\\/]/).pop() ?? path;
	const firstLine = text.slice(0, 300).split(/\r?\n/, 1)[0] ?? "";
	const language = registeredLanguage(name, firstLine);
	if (language && language !== "plaintext") return language;
	return fallbackLanguage(name, firstLine);
}

/** The display name of a language, as in VS Code's status bar. */
export function languageName(id: string): string {
	if (id === "plaintext") return "纯文本";
	const info = monaco.languages.getLanguages().find((language) => language.id === id);
	return info?.aliases?.[0] ?? id;
}

/** VS Code's Dark Modern editor on the app's code background. */
export const THEME = "pier-dark";

function cssVariable(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function defineTheme() {
	const background = cssVariable("--bg-code", "#0f1116");
	monaco.editor.defineTheme(THEME, {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": background,
			"editor.foreground": "#D4D4D4",
			"editorGutter.background": background,
			"minimap.background": background,
			"editorStickyScroll.background": background,
			"editorLineNumber.foreground": "#6E7681",
			"editorLineNumber.activeForeground": "#CCCCCC",
			"editor.lineHighlightBackground": "#FFFFFF00",
			"editor.lineHighlightBorder": "#FFFFFF14",
			"editorIndentGuide.background1": "#FFFFFF14",
			"editorIndentGuide.activeBackground1": "#FFFFFF33",
			"editorWidget.background": "#202020",
			"editorWidget.border": "#313131",
			"editorHoverWidget.background": "#202020",
			"editorHoverWidget.border": "#454545",
			"editorSuggestWidget.background": "#202020",
			"editorSuggestWidget.border": "#454545",
			"editorSuggestWidget.selectedBackground": "#04395E",
			"editor.findMatchBackground": "#9E6A03",
			"input.background": "#313131",
			"input.border": "#3C3C3C",
			focusBorder: "#0078D4",
			"widget.border": "#313131",
			"menu.background": "#1F1F1F",
			"menu.border": "#454545",
			"menu.selectionBackground": "#0078D4",
			"quickInput.background": "#222222",
			"textLink.foreground": "#4DAAFC",
		},
	});
}

defineTheme();
// The code background differs slightly between the app's light and dark appearance.
onThemeChange(() => {
	defineTheme();
	monaco.editor.setTheme(THEME);
});

export { monaco };
