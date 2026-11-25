/**
 * The terminal screen stays dark in both appearances: warm graphite with an ivory cursor, the
 * dark palette's ink (theme.ts). Kept free of React Native imports so terminal.ts can use it.
 */
export const TERMINAL_COLORS = {
	background: "#0f0e0d",
	foreground: "#d9d5cd",
	/** Header, key labels and typed input. */
	text: "#edebe6",
	/** The working directory and the input placeholder. */
	faint: "#6d6961",
	/** The special-key bar under the screen, its keys and its hairlines. */
	bar: "#181715",
	key: "#282724",
	line: "#33312d",
	input: "#0b0b0a",
	/** The cursor cell and a latched modifier key, and the text on them. */
	cursor: "#ebe7df",
	onCursor: "#1c1b19",
} as const;
