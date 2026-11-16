import type { HostInfo } from "@pier/protocol";
import { parseProtocolVersion } from "@pier/protocol";

/**
 * Settings pages that manage the Pier of the computer chosen in the settings screen (this one
 * or a paired one), with the protocol minor version that computer needs for this computer to
 * manage the page remotely: paired devices may manage providers, the 云链API account and
 * extensions since 1.10, pi's settings files since 1.15, and Claude Code's and Codex's
 * configuration files since 1.23. The general and about pages show any computer's Pier (about
 * updates it since 1.13 and explains older versions itself). Remote access, devices and peers
 * can be inspected (not modified) and diagnostic logs read since 1.55.
 */
export const HOST_SETTINGS_PAGES = {
	general: 0,
	account: 10,
	models: 10,
	workspaces: 10,
	extensions: 10,
	resources: 38,
	pi: 15,
	claude: 23,
	codex: 23,
	about: 0,
	remote: 55,
	logs: 55,
} as const;

export type HostSettingsPage = keyof typeof HOST_SETTINGS_PAGES;

/**
 * Pages that show a paired computer's connection and version themselves (offline, too old,
 * restarting after an update), instead of the generic “not connected” card and the “changes are
 * saved on that computer” banner.
 */
const SELF_DESCRIBING_PAGES: ReadonlySet<string> = new Set(["general", "about"]);

/** These pages follow the target but never change its access controls or restart it. */
export function pageIsReadOnly(page: string): boolean {
	return page === "remote" || page === "logs";
}

/** Whether a settings page manages the chosen computer (rather than always this one). */
export function pageFollowsHost(page: string): page is HostSettingsPage {
	return Object.hasOwn(HOST_SETTINGS_PAGES, page);
}

/** Whether a page that follows the chosen computer shows that computer's state on its own. */
export function pageDescribesHost(page: string): boolean {
	return pageFollowsHost(page) && SELF_DESCRIBING_PAGES.has(page);
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
	return `${name} 上的 Pier v${info.version}（协议 ${info.protocolVersion}）版本过旧，不支持从这台电脑${pageIsReadOnly(page) ? "查看" : "管理"}这一页（需要协议 1.${minor} 或更高）。请先在「关于与更新」中更新那台电脑。`;
}
