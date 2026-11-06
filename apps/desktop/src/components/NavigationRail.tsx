import { type ComponentType, useEffect, useState } from "react";
import { useAccountQuota } from "../lib/account-quota.ts";
import { type SettingsSection, useAppState, useStore } from "../lib/store.tsx";
import { useHostStatus } from "./HostPanels.tsx";
import {
	IconBot,
	IconClock,
	IconDownload,
	IconHome,
	IconLoader,
	IconPuzzle,
	IconSettings,
	IconSmartphone,
	IconSparkles,
	IconUser,
	Logo,
} from "./Icons.tsx";
import { useOutsideClick } from "./SessionControls.tsx";
import { SIDEBAR_SHORTCUT } from "./Sidebar.tsx";
import { SidebarUpdate, updatePending } from "./UpdatePanel.tsx";

const SHORTCUTS: Array<{
	section: SettingsSection;
	label: string;
	icon: ComponentType<{ size?: number }>;
	pages?: SettingsSection[];
}> = [
	{ section: "models", label: "模型与服务商", icon: IconSparkles },
	{ section: "extensions", label: "扩展", icon: IconPuzzle },
	{ section: "pi", label: "Agent 配置", icon: IconBot, pages: ["pi", "claude", "codex"] },
	{ section: "remote", label: "设备与远程", icon: IconSmartphone },
];

/** App navigation stays available even when the workspace list is collapsed or settings are open. */
export function NavigationRail() {
	const store = useStore();
	const settings = useAppState((s) => s.settings);
	const scheduled = useAppState((s) => s.scheduledTasksOpen);
	const unread = useAppState((s) => Object.values(s.taskData).some((data) => data.runs.some((run) => !run.read)));
	const sidebar = useAppState((s) => s.sidebar);
	const noModels = useAppState((s) => s.localProviders?.availableCount === 0);
	const update = useAppState((s) => s.update);
	const status = useHostStatus();
	const quota = useAccountQuota();
	const [updateOpen, setUpdateOpen] = useState(false);
	const updateRef = useOutsideClick(updateOpen, () => setUpdateOpen(false));
	const pending = updatePending(update) && !!update.version;
	const updating = update.state === "downloading" || update.state === "installing";
	const settingsActive =
		!!settings &&
		settings !== "account" &&
		settings !== "about" &&
		!SHORTCUTS.some((item) => (item.pages ? item.pages.includes(settings) : item.section === settings));

	// Navigating away or completing an update dismisses the update card.
	// biome-ignore lint/correctness/useExhaustiveDependencies: every navigation change closes the card.
	useEffect(() => setUpdateOpen(false), [settings, pending]);

	const utilities = (
		<div className="navigation-utilities">
			<button
				type="button"
				className={`navigation-button${settings === "account" ? " selected" : ""}`}
				aria-label="个人中心"
				aria-current={settings === "account" ? "page" : undefined}
				title="个人中心"
				onClick={() => store.openSettings("account")}
			>
				<IconUser size={20} />
			</button>
			<div className="navigation-update" ref={updateRef}>
				<button
					type="button"
					className={`navigation-button${settings === "about" || updateOpen ? " selected" : ""}${pending ? " has-update" : ""}`}
					aria-label="关于与更新"
					aria-current={settings === "about" ? "page" : undefined}
					aria-expanded={pending ? updateOpen : undefined}
					title={pending ? `${updating ? "正在更新" : "有可用更新"} · Pier v${update.version}` : "关于与更新"}
					onClick={() => (pending ? setUpdateOpen(!updateOpen) : store.openSettings("about"))}
				>
					{updating ? <IconLoader size={20} className="spin" /> : <IconDownload size={20} />}
					{pending ? <span className={`navigation-badge${update.state === "error" ? " warning" : ""}`} /> : null}
				</button>
				{updateOpen && pending ? (
					<div className="navigation-update-popover">
						<SidebarUpdate />
					</div>
				) : null}
			</div>
			<button
				type="button"
				className={`navigation-button${settingsActive ? " selected" : ""}`}
				aria-label="设置"
				aria-current={settingsActive ? "page" : undefined}
				title={`设置 · ${status.text}`}
				onClick={() => store.openSettings("general")}
			>
				<IconSettings size={20} />
				<span className={`navigation-connection ${status.dot}`} />
			</button>
		</div>
	);

	return (
		<nav className="navigation-rail" data-quota={quota?.level} aria-label="主导航">
			<div className="navigation-brand" title="Pier">
				<Logo size={28} />
			</div>
			<div className="navigation-links">
				<button
					type="button"
					className={`navigation-button${settings || scheduled ? "" : " selected"}`}
					aria-label="工作区与会话"
					aria-current={settings || scheduled ? undefined : "page"}
					aria-expanded={!settings && !scheduled && sidebar}
					title={`工作区与会话 · ${!settings && !scheduled && sidebar ? "收起" : "展开"}列表（${SIDEBAR_SHORTCUT}）`}
					onClick={() => {
						if (settings || scheduled) {
							store.closeSettings();
							store.toggleSidebar(true);
						} else store.toggleSidebar();
					}}
				>
					<IconHome size={20} />
				</button>
				<button
					type="button"
					className={`navigation-button${scheduled ? " selected" : ""}`}
					aria-label="定时任务"
					aria-current={scheduled ? "page" : undefined}
					title="定时任务"
					onClick={() => store.openScheduledTasks()}
				>
					<IconClock size={20} />
					{unread ? <span className="navigation-badge" /> : null}
				</button>
				<div className="navigation-divider" />
				{SHORTCUTS.map((item) => {
					const selected = !!settings && (item.pages ? item.pages.includes(settings) : settings === item.section);
					const attention = item.section === "models" && noModels;
					return (
						<button
							type="button"
							key={item.section}
							className={`navigation-button${selected ? " selected" : ""}`}
							aria-label={item.label}
							aria-current={selected ? "page" : undefined}
							title={`${item.label}${attention ? " · 还没有可用模型" : ""}`}
							onClick={() => store.openSettings(item.section)}
						>
							<item.icon size={20} />
							{attention ? <span className="navigation-badge warning" /> : null}
						</button>
					);
				})}
			</div>
			{quota ? (
				// The account balance fills the rail below the links like a water tank, down to its bottom edge.
				<div className="quota-tank">
					<span className="quota-tank-water" style={{ height: `${quota.percent}%` }} />
					<button
						type="button"
						className="quota-tank-readout"
						title={quota.title}
						aria-label={quota.title.replace("\n", "，")}
						onClick={() => store.openSettings("account")}
					>
						<span className="quota-tank-value">
							{quota.percent}
							<small>%</small>
						</span>
					</button>
					{utilities}
				</div>
			) : (
				utilities
			)}
		</nav>
	);
}
