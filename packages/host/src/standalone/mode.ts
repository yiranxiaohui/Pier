/**
 * What a `pier` command line starts. Host flags and management commands must never start a
 * window, even on a desktop. A bare `pier` opens the window on a graphical desktop, the CLI in
 * an interactive terminal (an SSH login, a server console), and the Host otherwise (a script,
 * `nohup`, a service manager).
 */
export function launchMode(
	args: string[],
	env: NodeJS.ProcessEnv,
	hasDesktop: boolean,
	interactive = false,
): "desktop" | "host" | "cli" {
	if (["desktop", "--desktop"].includes(args[0] ?? "")) return "desktop";
	if (args[0] === "--autostart") return hasDesktop && graphical(env) ? "desktop" : "host";
	if (args.length) return "host";
	if (hasDesktop && graphical(env)) return "desktop";
	return interactive ? "cli" : "host";
}

function graphical(env: NodeJS.ProcessEnv): boolean {
	return !!(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}
