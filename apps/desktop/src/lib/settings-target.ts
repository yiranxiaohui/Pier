import type { HostInfo } from "@pier/protocol";
import { parseProtocolVersion } from "@pier/protocol";

/**
 * Settings pages that manage the Pier of the computer chosen in the settings screen (this one
 * or a paired one), with the protocol minor version that computer needs for this computer to
 * manage the page remotely: paired devices may manage providers, the 云链API account and
 * extensions since 1.10, pi's settings files since 1.15, and Claude Code's and Codex's
 * configuration files since 1.23.
 *
 * Every other page is about this computer only (pairing, remote access, logs, this app's
 * updates) or already lists every computer (workspaces).
 */
export const HOST_SETTINGS_PAGES = {
	general: 0,
	account: 10,
	models: 10,
	extensions: 10,
	resources: 38,
	pi: 15,
	claude: 23,
	codex: 23,
} as const;

export type HostSettingsPage = keyof typeof HOST_SETTINGS_PAGES;

/** Pages that list every computer at once (workspaces, updates), so the chosen computer does not matter. */
const ALL_COMPUTER_PAGES: ReadonlySet<string> = new Set(["workspaces", "about"]);

/** Whether a settings page manages the chosen computer (rather than always this one). */
export function pageFollowsHost(page: string): page is HostSettingsPage {
	return Object.hasOwn(HOST_SETTINGS_PAGES, page);
}

/** Whether a settings page only concerns this computer, whichever computer is chosen. */
export function pageIsLocalOnly(page: string): boolean {
	return !pageFollowsHost(page) && !ALL_COMPUTER_PAGES.has(page);
}

/** Whether a host speaks protocol `1.<minor>` or a later version. */
export function hostSpeaksMinor(info: HostInfo | undefined, minor: number): boolean {
	const version = info ? parseProtocolVersion(info.protocolVersion) : undefined;
	return version !== undefined && (version.major > 1 || (version.major === 1 && version.minor >= minor));
}

/**
 * Why a page cannot manage a paired computer's Pier from here (its Pier is too old), or
 * undefined when it can. Pages that do not follow the chosen computer are never blocked.
 */
export function remotePageBlocker(page: string, name: string, info: HostInfo | undefined): string | undefined {
	if (!pageFollowsHost(page) || !info) return undefined;
	const minor = HOST_SETTINGS_PAGES[page];
	if (hostSpeaksMinor(info, minor)) return undefined;
	return `${name} 上的 Pier v${info.version}（协议 ${info.protocolVersion}）版本过旧，不支持从这台电脑修改这一页的设置（需要协议 1.${minor} 或更高）。请先在「关于与更新」中更新那台电脑。`;
}
