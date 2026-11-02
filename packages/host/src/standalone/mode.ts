/** Host flags and management commands must never start a window, even on a desktop. */
export function launchMode(args: string[], env: NodeJS.ProcessEnv, hasDesktop: boolean): "desktop" | "host" {
	if (["desktop", "--desktop"].includes(args[0] ?? "")) return "desktop";
	if (args.length && args[0] !== "--autostart") return "host";
	return hasDesktop && (env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim()) ? "desktop" : "host";
}
