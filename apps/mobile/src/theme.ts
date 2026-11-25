import { Platform, useColorScheme } from "react-native";
import { useThemePreference } from "./theme-preference.ts";

export interface Palette {
	/** Whether this is the dark palette, for colors derived on the fly. */
	dark: boolean;
	bg: string;
	card: string;
	elevated: string;
	border: string;
	text: string;
	muted: string;
	faint: string;
	accent: string;
	accentText: string;
	accentSoft: string;
	accentRing: string;
	onAccent: string;
	danger: string;
	dangerSoft: string;
	warning: string;
	warningSoft: string;
	ok: string;
	okSoft: string;
	code: string;
	codeText: string;
	userBubble: string;
	add: string;
	del: string;
	/** Dimmed backdrop behind sheets. */
	scrim: string;
}

/** Warm ink, as on the desktop: graphite and ivory here, paper and near-black in `light`. The
 *  accent is the ink itself, so the only colours on screen are the states. */
const dark: Palette = {
	dark: true,
	bg: "#0b0b0a",
	card: "#131210",
	elevated: "#1b1a17",
	border: "rgba(255,255,255,0.11)",
	text: "#edebe6",
	muted: "#a29e96",
	faint: "#6d6961",
	accent: "#ebe7df",
	accentText: "#ebe7df",
	accentSoft: "rgba(235,231,223,0.08)",
	accentRing: "rgba(235,231,223,0.32)",
	onAccent: "#1c1b19",
	danger: "#f06464",
	dangerSoft: "rgba(240,100,100,0.12)",
	warning: "#e9b44c",
	warningSoft: "rgba(233,180,76,0.12)",
	ok: "#3fb96f",
	okSoft: "rgba(63,185,111,0.13)",
	code: "#0e0d0c",
	codeText: "#dedbd4",
	userBubble: "#23221f",
	add: "#7ee2a8",
	del: "#ff9b94",
	scrim: "rgba(0,0,0,0.6)",
};

/** Code reads on paper too, like the desktop's light theme. */
const light: Palette = {
	dark: false,
	bg: "#f4f3f0",
	card: "#fdfdfc",
	elevated: "#f7f6f3",
	border: "rgba(40,32,20,0.12)",
	text: "#1c1b19",
	muted: "#57534c",
	faint: "#8f8a81",
	accent: "#1c1b19",
	accentText: "#1c1b19",
	accentSoft: "rgba(40,32,20,0.06)",
	accentRing: "rgba(40,32,20,0.25)",
	onAccent: "#fbfaf7",
	danger: "#d93b3b",
	dangerSoft: "rgba(217,59,59,0.08)",
	warning: "#b7791f",
	warningSoft: "rgba(214,158,46,0.12)",
	ok: "#1f9d55",
	okSoft: "rgba(31,157,85,0.10)",
	code: "#f7f6f3",
	codeText: "#1c1b19",
	userBubble: "#efeee9",
	add: "#1a7f37",
	del: "#b42318",
	scrim: "rgba(28,24,18,0.42)",
};

/** Both palettes, for previews that show the other appearance. */
export const PALETTES = { dark, light } as const;

export function usePalette(): Palette {
	const preference = useThemePreference();
	const system = useColorScheme();
	return (preference === "system" ? system : preference) === "light" ? light : dark;
}

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export const RADIUS = { sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const;

/** Keep list and settings content readable on tablets and the web preview. */
export const PAGE = { width: "100%", maxWidth: 800, alignSelf: "center" } as const;

/** Thinking-level labels use the same purple as the desktop, in both palettes. */
export const THINKING_COLOR = "#8b5cf6";

/** Soft, layered card elevation (React Native's `boxShadow` works on every platform). */
export const SHADOW: object = { boxShadow: "0 1px 2px rgba(40,32,20,0.04), 0 6px 20px rgba(40,32,20,0.05)" };

/** Stronger elevation for floating surfaces such as the composer and toasts. */
export const FLOAT_SHADOW: object = { boxShadow: "0 2px 6px rgba(40,32,20,0.06), 0 12px 32px rgba(40,32,20,0.1)" };

/** Hues for name-derived tiles (hosts, workspaces, agents). */
const HUES = [172, 212, 256, 28, 332, 142, 196, 290];

function hash(text: string): number {
	let h = 0;
	for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	return h;
}

/** A stable, soft color pair for an icon tile, derived from a name. */
export function tileColors(p: Palette, name: string): { bg: string; fg: string } {
	const hue = HUES[hash(name.trim().toLowerCase()) % HUES.length] ?? HUES[0];
	return p.dark
		? { bg: `hsla(${hue}, 70%, 60%, 0.16)`, fg: `hsl(${hue}, 72%, 72%)` }
		: { bg: `hsla(${hue}, 72%, 46%, 0.12)`, fg: `hsl(${hue}, 64%, 36%)` };
}
