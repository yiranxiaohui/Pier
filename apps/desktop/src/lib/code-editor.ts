/** Helpers of the code editor (components/CodeEditor.tsx) that do not need Monaco itself. */

/** File types Monaco has no grammar for, shown with the closest one it has. */
const EXTRA_LANGUAGES: Record<string, string> = {
	toml: "ini",
	env: "ini",
	conf: "ini",
	cfg: "ini",
	properties: "ini",
	editorconfig: "ini",
	gitconfig: "ini",
	npmrc: "ini",
	zsh: "shell",
	fish: "shell",
	bashrc: "shell",
	zshrc: "shell",
	profile: "shell",
	jsonc: "json",
	json5: "json",
	jsonl: "json",
	webmanifest: "json",
	vue: "html",
	svelte: "html",
	astro: "html",
	svg: "xml",
	plist: "xml",
	csproj: "xml",
	gradle: "java",
	hpp: "cpp",
	mm: "objective-c",
	tf: "hcl",
};

/**
 * The language of a file Monaco does not recognise by its name: from a shebang line, a few well
 * known file names, else the closest relative of its extension ("plaintext" when there is none).
 */
export function fallbackLanguage(name: string, firstLine: string): string {
	if (/^#!.*\b(?:ba|z|da|k)?sh\b/.test(firstLine)) return "shell";
	if (/^#!.*\b(?:node|deno|bun)\b/.test(firstLine)) return "javascript";
	if (/^#!.*\bpython/.test(firstLine)) return "python";
	if (/^(?:Makefile|GNUmakefile|Justfile)$/i.test(name)) return "shell";
	const dot = name.lastIndexOf(".");
	// ".env" and "id_rsa.toml" alike: the part after the last dot, or the whole dotfile name.
	const ext = (dot >= 0 ? name.slice(dot + 1) : "").toLowerCase();
	return EXTRA_LANGUAGES[ext] ?? "plaintext";
}

/** The column as VS Code's status bar counts it: tabs expanded to the next tab stop. */
export function visibleColumn(line: string, column: number, tabSize: number): number {
	let width = 0;
	for (let i = 0; i < column - 1 && i < line.length; i++) {
		width = line[i] === "\t" ? width + tabSize - (width % tabSize) : width + 1;
	}
	return width + 1;
}

/** The cursor part of the status bar, worded as VS Code's Chinese status bar. */
export function cursorStatus(status: { line: number; column: number; selections: number; selected: number }): string {
	if (status.selections > 1) return `${status.selections} 个选择（已选择 ${status.selected} 个字符）`;
	const selected = status.selected ? `（已选择 ${status.selected}）` : "";
	return `行 ${status.line}，列 ${status.column}${selected}`;
}
