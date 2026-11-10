import { type ReactNode, type SVGProps, useId } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

/**
 * Stroke icons so the UI does not rely on text glyphs. Each one is a Lucide icon (https://lucide.dev,
 * v1.70.0), named in the comment above it, copied as SVG so the app needs no icon package; draw new
 * ones from the same set. Lucide: ISC License, (c) Lucide Icons and Contributors; the icons it derives
 * from Feather: MIT License, (c) Cole Bemis. Full notices in Icons.LICENSE.txt.
 */
function make(paths: ReactNode) {
	return function Icon({ size = 16, className, ...rest }: IconProps) {
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
				className={`icon-svg${className ? ` ${className}` : ""}`}
				{...rest}
			>
				{paths}
			</svg>
		);
	};
}

// plus
export const IconPlus = make(
	<>
		<path d="M5 12h14" />
		<path d="M12 5v14" />
	</>,
);
// x
export const IconX = make(
	<>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</>,
);
// check
export const IconCheck = make(<path d="M20 6 9 17l-5-5" />);
// chevron-right
export const IconChevronRight = make(<path d="m9 18 6-6-6-6" />);
// chevron-down
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />);
// chevron-up
export const IconChevronUp = make(<path d="m18 15-6-6-6 6" />);
// arrow-up
export const IconArrowUp = make(
	<>
		<path d="m5 12 7-7 7 7" />
		<path d="M12 19V5" />
	</>,
);
// arrow-left
export const IconArrowLeft = make(
	<>
		<path d="m12 19-7-7 7-7" />
		<path d="M19 12H5" />
	</>,
);
// arrow-down
export const IconArrowDown = make(
	<>
		<path d="M12 5v14" />
		<path d="m19 12-7 7-7-7" />
	</>,
);
// rotate-cw
export const IconRefresh = make(
	<>
		<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
		<path d="M21 3v5h-5" />
	</>,
);
// ellipsis
export const IconMore = make(
	<>
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
		<circle cx="5" cy="12" r="1" />
	</>,
);
// settings
export const IconSettings = make(
	<>
		<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
		<circle cx="12" cy="12" r="3" />
	</>,
);
// folder
export const IconFolder = make(
	<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
);
// folder-plus
export const IconFolderPlus = make(
	<>
		<path d="M12 10v6" />
		<path d="M9 13h6" />
		<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
	</>,
);
// message-circle
export const IconMessage = make(
	<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />,
);
// message-circle-plus
export const IconMessagePlus = make(
	<>
		<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
		<path d="M8 12h8" />
		<path d="M12 8v8" />
	</>,
);
// terminal
export const IconTerminal = make(
	<>
		<path d="M12 19h8" />
		<path d="m4 17 6-6-6-6" />
	</>,
);
// file
export const IconFile = make(
	<>
		<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
		<path d="M14 2v5a1 1 0 0 0 1 1h5" />
	</>,
);
// file-pen
export const IconFilePen = make(
	<>
		<path d="M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34" />
		<path d="M14 2v5a1 1 0 0 0 1 1h5" />
		<path d="M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z" />
	</>,
);
// file-plus
export const IconFilePlus = make(
	<>
		<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
		<path d="M14 2v5a1 1 0 0 0 1 1h5" />
		<path d="M9 15h6" />
		<path d="M12 18v-6" />
	</>,
);
// search
export const IconSearch = make(
	<>
		<path d="m21 21-4.34-4.34" />
		<circle cx="11" cy="11" r="8" />
	</>,
);
// list
export const IconList = make(
	<>
		<path d="M3 5h.01" />
		<path d="M3 12h.01" />
		<path d="M3 19h.01" />
		<path d="M8 5h13" />
		<path d="M8 12h13" />
		<path d="M8 19h13" />
	</>,
);
// wrench
export const IconWrench = make(
	<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />,
);
// shield
export const IconShield = make(
	<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
);
// shield-exclamation-point
export const IconShieldAlert = make(
	<>
		<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
		<path d="M12 8v4" />
		<path d="M12 16h.01" />
	</>,
);
// zap
export const IconZap = make(
	<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" />,
);
// sparkles
export const IconSparkles = make(
	<>
		<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
		<path d="M20 2v4" />
		<path d="M22 4h-4" />
		<circle cx="4" cy="20" r="2" />
	</>,
);
// brain
export const IconBrain = make(
	<>
		<path d="M12 18V5" />
		<path d="M15 13a4.17 4.17 0 01-3-4 4.17 4.17 0 01-3 4" />
		<path d="M17.707 6.294A3 3 0 1012 5a3 3 0 10-5.707 1.294" />
		<path d="M17.996 5.125a4 4 0 012.526 5.77" />
		<path d="M18 18a4 4 0 002-7.465" />
		<path d="M19.967 17.482a4 4 0 11-7.967.517 4 4 0 11-7.967-.517" />
		<path d="M6 18a4 4 0 01-2-7.465" />
		<path d="M6.004 5.125a4 4 0 00-2.526 5.77" />
	</>,
);
// copy
export const IconCopy = make(
	<>
		<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	</>,
);
// scissors
export const IconCut = make(
	<>
		<circle cx="6" cy="6" r="3" />
		<path d="M8.12 8.12 12 12" />
		<path d="M20 4 8.12 15.88" />
		<circle cx="6" cy="18" r="3" />
		<path d="M14.8 14.8 20 20" />
	</>,
);
// clipboard-paste
export const IconPaste = make(
	<>
		<path d="M11 14h10" />
		<path d="M16 4h2a2 2 0 0 1 2 2v1.344" />
		<path d="m17 18 4-4-4-4" />
		<path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113" />
		<rect x="8" y="2" width="8" height="4" rx="1" />
	</>,
);
export const IconStop = make(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />);
/** The GitHub mark, filled. */
export const IconGithub = make(
	<path
		fill="currentColor"
		stroke="none"
		d="M12 0.296997C5.37 0.296997 0 5.67 0 12.297C0 17.6 3.438 22.097 8.205 23.682C8.805 23.795 9.025 23.424 9.025 23.105C9.025 22.82 9.015 22.065 9.01 21.065C5.672 21.789 4.968 19.455 4.968 19.455C4.422 18.07 3.633 17.7 3.633 17.7C2.546 16.956 3.717 16.971 3.717 16.971C4.922 17.055 5.555 18.207 5.555 18.207C6.625 20.042 8.364 19.512 9.05 19.205C9.158 18.429 9.467 17.9 9.81 17.6C7.145 17.3 4.344 16.268 4.344 11.67C4.344 10.36 4.809 9.29 5.579 8.45C5.444 8.147 5.039 6.927 5.684 5.274C5.684 5.274 6.689 4.952 8.984 6.504C9.944 6.237 10.964 6.105 11.984 6.099C13.004 6.105 14.024 6.237 14.984 6.504C17.264 4.952 18.269 5.274 18.269 5.274C18.914 6.927 18.509 8.147 18.389 8.45C19.154 9.29 19.619 10.36 19.619 11.67C19.619 16.28 16.814 17.295 14.144 17.59C14.564 17.95 14.954 18.686 14.954 19.81C14.954 21.416 14.939 22.706 14.939 23.096C14.939 23.411 15.149 23.786 15.764 23.666C20.565 22.092 24 17.592 24 12.297C24 5.67 18.627 0.296997 12 0.296997Z"
	/>,
);
// clock
export const IconClock = make(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 6v6l4 2" />
	</>,
);
// triangle-exclamation-point
export const IconAlert = make(
	<>
		<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
		<path d="M12 9v4" />
		<path d="M12 17h.01" />
	</>,
);
// info
export const IconInfo = make(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 16v-4" />
		<path d="M12 8h.01" />
	</>,
);
// power
export const IconPower = make(
	<>
		<path d="M12 2v10" />
		<path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
	</>,
);
// logs
export const IconLogs = make(
	<>
		<path d="M3 5h1" />
		<path d="M3 12h1" />
		<path d="M3 19h1" />
		<path d="M8 5h1" />
		<path d="M8 12h1" />
		<path d="M8 19h1" />
		<path d="M13 5h8" />
		<path d="M13 12h8" />
		<path d="M13 19h8" />
	</>,
);
// git-branch
export const IconGitBranch = make(
	<>
		<path d="M15 6a9 9 0 0 0-9 9V3" />
		<circle cx="18" cy="6" r="3" />
		<circle cx="6" cy="18" r="3" />
	</>,
);
// minimize
export const IconMinimize = make(
	<>
		<path d="M8 3v3a2 2 0 0 1-2 2H3" />
		<path d="M21 8h-3a2 2 0 0 1-2-2V3" />
		<path d="M3 16h3a2 2 0 0 1 2 2v3" />
		<path d="M16 21v-3a2 2 0 0 1 2-2h3" />
	</>,
);
// layers
export const IconLayers = make(
	<>
		<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
		<path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
		<path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
	</>,
);
// puzzle
export const IconPuzzle = make(
	<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />,
);
// image
export const IconImage = make(
	<>
		<rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
		<circle cx="9" cy="9" r="2" />
		<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
	</>,
);
// smartphone
export const IconSmartphone = make(
	<>
		<rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
		<path d="M12 18h.01" />
	</>,
);
// monitor
export const IconMonitor = make(
	<>
		<rect width="20" height="14" x="2" y="3" rx="2" />
		<line x1="8" x2="16" y1="21" y2="21" />
		<line x1="12" x2="12" y1="17" y2="21" />
	</>,
);
// pencil
export const IconPencil = make(
	<>
		<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
		<path d="m15 5 4 4" />
	</>,
);
// square-pen
export const IconSquarePen = make(
	<>
		<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
		<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
	</>,
);
// loader-circle
export const IconLoader = make(<path d="M21 12a9 9 0 1 1-6.219-8.56" />);
// key-round
export const IconKey = make(
	<>
		<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
		<circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
	</>,
);
// external-link
export const IconExternal = make(
	<>
		<path d="M15 3h6v6" />
		<path d="M10 14 21 3" />
		<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
	</>,
);
// trash
export const IconTrash = make(
	<>
		<path d="M10 11v6" />
		<path d="M14 11v6" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
		<path d="M3 6h18" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	</>,
);
// archive
export const IconArchive = make(
	<>
		<rect width="20" height="5" x="2" y="3" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
		<path d="M10 12h4" />
	</>,
);
// archive-arrow-up
export const IconArchiveRestore = make(
	<>
		<rect width="20" height="5" x="2" y="3" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h2" />
		<path d="M20 8v11a2 2 0 0 1-2 2h-2" />
		<path d="m9 15 3-3 3 3" />
		<path d="M12 12v9" />
	</>,
);
// brush-cleaning
export const IconBroom = make(
	<>
		<path d="m16 22-1-4" />
		<path d="M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1" />
		<path d="M19 14H5l-1.973 6.767A1 1 0 0 0 4 22h16a1 1 0 0 0 .973-1.233z" />
		<path d="m8 22 1-4" />
	</>,
);
// download
export const IconDownload = make(
	<>
		<path d="M12 15V3" />
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<path d="m7 10 5 5 5-5" />
	</>,
);
// upload
export const IconUpload = make(
	<>
		<path d="M12 3v12" />
		<path d="m17 8-5-5-5 5" />
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
	</>,
);
// panel-right
export const IconPanelRight = make(
	<>
		<rect width="18" height="18" x="3" y="3" rx="2" />
		<path d="M15 3v18" />
	</>,
);
// panel-left
export const IconPanelLeft = make(
	<>
		<rect width="18" height="18" x="3" y="3" rx="2" />
		<path d="M9 3v18" />
	</>,
);
// folder-open
export const IconFolderOpen = make(
	<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />,
);
// house
export const IconHome = make(
	<>
		<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
		<path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</>,
);
// link
export const IconLink = make(
	<>
		<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
		<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
	</>,
);

/**
 * The brand mark from assets/brand/pier.svg without its tile, inline so the --logo-* theme tokens
 * color it for light and dark surfaces. The view box is cropped to the mark.
 */
export function Logo({ size = 28 }: { size?: number }) {
	// Each instance needs its own gradient ids; React's ids may hold characters url() does not accept.
	const id = useId().replace(/[^\w-]/g, "");
	return (
		<svg className="logo" width={size} height={size} viewBox="234 241 560 560" aria-hidden="true">
			<defs>
				<linearGradient id={`${id}-ink`} x1="356" y1="270" x2="670" y2="720" gradientUnits="userSpaceOnUse">
					<stop style={{ stopColor: "var(--logo-ink-start)" }} />
					<stop offset="1" style={{ stopColor: "var(--logo-ink-end)" }} />
				</linearGradient>
				<linearGradient id={`${id}-signal`} x1="424" y1="390" x2="630" y2="751" gradientUnits="userSpaceOnUse">
					<stop style={{ stopColor: "var(--logo-signal-start)" }} />
					<stop offset="1" style={{ stopColor: "var(--logo-signal-end)" }} />
				</linearGradient>
			</defs>
			<g
				transform="translate(512 512) skewX(-5) translate(-512 -512)"
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M338 713c74 47 156 51 224 18" stroke={`url(#${id}-signal)`} strokeWidth={28} />
				<path
					d="M338 751V315q0-23 23-23h162c113 0 185 61 185 159s-66 160-175 160H338"
					stroke={`url(#${id}-ink)`}
					strokeWidth={70}
				/>
				<path d="m449 401 65 50-65 50" stroke={`url(#${id}-signal)`} strokeWidth={34} />
				<circle cx="608" cy="703" r="30" fill={`url(#${id}-signal)`} />
			</g>
		</svg>
	);
}
// user-round
export const IconUser = make(
	<>
		<circle cx="12" cy="8" r="5" />
		<path d="M20 21a8 8 0 0 0-16 0" />
	</>,
);
// activity
export const IconActivity = make(
	<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />,
);
// wallet
export const IconWallet = make(
	<>
		<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
		<path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
	</>,
);
// server
export const IconServer = make(
	<>
		<rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
		<rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
		<line x1="6" x2="6.01" y1="6" y2="6" />
		<line x1="6" x2="6.01" y1="18" y2="18" />
	</>,
);
// sliders-horizontal
export const IconSliders = make(
	<>
		<path d="M10 5H3" />
		<path d="M12 19H3" />
		<path d="M14 3v4" />
		<path d="M16 17v4" />
		<path d="M21 12h-9" />
		<path d="M21 19h-5" />
		<path d="M21 5h-7" />
		<path d="M8 10v4" />
		<path d="M8 12H3" />
	</>,
);
// undo-2
export const IconUndo = make(
	<>
		<path d="M9 14 4 9l5-5" />
		<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
	</>,
);
// braces
export const IconBraces = make(
	<>
		<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
		<path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
	</>,
);
// bot
export const IconBot = make(
	<>
		<path d="M12 8V4H8" />
		<rect width="16" height="12" x="4" y="8" rx="2" />
		<path d="M2 14h2" />
		<path d="M20 14h2" />
		<path d="M15 13v2" />
		<path d="M9 13v2" />
	</>,
);
// eye
export const IconEye = make(
	<>
		<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
		<circle cx="12" cy="12" r="3" />
	</>,
);
// eye-off
export const IconEyeOff = make(
	<>
		<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
		<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
		<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
		<path d="m2 2 20 20" />
	</>,
);
// minus
export const IconMinus = make(<path d="M5 12h14" />);

// compass
export const IconBrowser = make(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />
	</>,
);

// mic
export const IconMic = make(
	<>
		<path d="M12 19v3" />
		<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
		<rect x="9" y="2" width="6" height="13" rx="3" />
	</>,
);
// network
export const IconNetwork = make(
	<>
		<rect x="16" y="16" width="6" height="6" rx="1" />
		<rect x="2" y="16" width="6" height="6" rx="1" />
		<rect x="9" y="2" width="6" height="6" rx="1" />
		<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
	</>,
);
// target
export const IconTarget = make(
	<>
		<circle cx="12" cy="12" r="10" />
		<circle cx="12" cy="12" r="6" />
		<circle cx="12" cy="12" r="2" />
	</>,
);

/**
 * The script “Pier” wordmark, traced from the brand lettering. It is filled with the text color,
 * so it follows the theme; `height` sets its size (the width follows, about 2.7 × the height).
 */
export function PierWordmark({ height = 24, className }: { height?: number; className?: string }) {
	return (
		<svg
			className={`wordmark${className ? ` ${className}` : ""}`}
			height={height}
			viewBox="0 0 1909 707"
			role="img"
			aria-label="Pier"
		>
			<path
				fill="currentColor"
				fillRule="evenodd"
				d="M 492.5 8.7 C 327.1 17.5,144.9 84.6,61.9 167.2 C 7.2 221.8,-6.3 279.9,25.5 324.4 C 68.9 385.2,191.3 387.6,262.5 329 C 270.2 322.6,279.6 313.3,278.9 312.7 C 278.7 312.4,274.2 312.9,269 313.6 C 212.3 321.6,173.8 303.9,164 265.4 C 153.9 225.9,191.7 169.4,256 127.8 C 367.4 55.6,540.2 39,621.5 92.5 C 660.1 118,676.5 149.7,676.4 199 C 676.4 243,665.2 282.2,643 316 C 606.4 371.6,546.2 403.6,472.1 406.7 C 457.7 407.3,456.7 407.2,457.3 405.6 C 457.7 404.6,459.9 397.5,462.2 389.7 C 466.8 373.8,489.6 305.5,499.1 279 C 502.5 269.4,507 256.8,509 251 C 534.2 180,555.6 140.2,582.7 113.7 C 587.5 109,591.2 104.9,591 104.7 C 590.2 103.9,569 105.9,559.5 107.6 C 476.4 122.4,406.2 166.5,363.2 230.7 C 346.4 255.9,332.6 284.4,313 334.5 C 308.5 346.1,302.6 361.1,300 368 C 297.3 374.9,289.2 395.8,282 414.5 C 248.5 501.7,240.1 521.9,222.5 557.5 C 203.1 596.6,188.2 618.5,165 642 C 144.2 663.1,124.2 676.7,101.1 685.6 C 92.3 689,92.4 689,112 691.4 C 236.6 706.7,324.8 673.9,382.9 590.7 C 404.2 560.2,419.7 526.4,437.6 471.5 L 446.5 444.4 476.7 444.8 C 536.6 445.7,576.2 440.6,629.4 425.4 C 748 391.4,827.5 319.7,845.6 230.2 C 868.7 115.8,777.5 31.1,610.5 12.1 C 577.8 8.3,526.7 6.9,492.5 8.7 M 949.7 92.5 C 904.1 101.2,872 144.3,879.4 186.9 C 890.8 252.2,976.6 274,1023.8 223.5 C 1056 189,1053.3 135.1,1018.1 108.9 C 998.6 94.3,972.8 88.1,949.7 92.5 M 1800.5 262.6 C 1745.8 270.9,1699.7 300.9,1654.7 357.5 C 1641.3 374.3,1623.9 400.1,1612.9 419.3 C 1608.9 426.3,1605.5 431.8,1605.3 431.6 C 1605.1 431.4,1606 428.4,1607.4 424.9 C 1608.8 421.4,1612.9 410.4,1616.5 400.5 C 1620.1 390.6,1624.1 379.8,1625.5 376.5 C 1626.8 373.2,1629.5 366,1631.5 360.5 C 1633.5 355,1636.4 347.1,1638 342.9 C 1648.6 314.5,1648.5 297.5,1637.6 286.6 C 1618.7 267.7,1549.5 275.5,1514.5 300.5 C 1493.5 315.5,1487.5 327.3,1461 405.5 C 1439.6 468.6,1425.4 508.2,1420.9 517.2 C 1396.2 566.6,1348.2 608.8,1297.5 625.8 C 1213.5 654,1147 612.2,1147 531.2 L 1147 522.2 1156.8 521.6 C 1198.2 518.9,1217.7 515.9,1258 506 C 1323.9 489.7,1384.4 458.5,1414.4 425.2 C 1468.1 365.7,1439.1 296.2,1351.4 274.1 C 1312.9 264.4,1269.3 264.9,1226.3 275.5 C 1089 309.4,980.3 431.1,981.1 550 C 981.1 556.9,981.5 565.1,981.9 568.3 L 982.6 574 975.8 581.5 C 957.8 601,933 615,916.4 615 C 903.1 615,896.4 611.4,891.2 601.6 C 888.7 596.8,888.5 595.7,888.5 584 C 888.5 560.3,895.1 540.7,934 447.5 C 936 442.6,941.7 429.5,946.5 418.5 C 951.3 407.5,957.4 393.6,960 387.5 C 962.6 381.4,968.2 369.2,972.4 360.3 C 976.6 351.3,980 343.8,980 343.6 C 980 343.3,986 329.9,993.4 313.8 C 1009.4 278.6,1008.7 280.5,1005.8 279.5 C 1001.5 278.1,959.4 277.7,947.2 279 C 907.6 283,869 296,846 313 C 827 327.2,813.3 346.1,800.5 376 C 794.9 389,776 436.4,768.5 456 C 764.9 465.6,759.7 479.1,757 486 C 731.6 551.3,722.4 586.6,723.3 614.5 C 724.1 639.7,729.8 653.9,745.4 669.6 C 764.3 688.6,790.6 696.9,828.4 695.7 C 881.7 694.1,929.7 670.9,977.8 623.5 L 992 609.5 997.1 618.5 C 1027 671.1,1087 699,1170.5 699 C 1258.1 699,1331.4 669.5,1387.7 611.7 L 1401.8 597.2 1396.3 613.3 C 1391.2 628.4,1385 645.5,1372.8 677.8 C 1370.1 685.2,1368 691.3,1368.2 691.5 C 1371.4 694.7,1441.6 695.5,1462.5 692.6 C 1495.4 688,1512.5 681.5,1525.5 668.5 C 1534.3 659.8,1538.4 652.1,1543.9 634 C 1546.1 626.6,1550.2 612.9,1553.1 603.5 C 1580.9 511.5,1617.6 444.4,1665.1 398.5 C 1686.8 377.6,1702 369.7,1721 369.6 C 1733.7 369.5,1739.5 371.6,1746.3 378.9 C 1755.2 388.4,1758.1 405.5,1753.6 422.8 C 1752.6 426.8,1752 430.3,1752.3 430.6 C 1753.8 432.1,1770.1 433.9,1782 434 C 1843.5 434.1,1890.2 398.7,1899.6 344.8 C 1906.3 306.3,1887 276.5,1848 265.5 C 1838.7 262.9,1810.3 261.1,1800.5 262.6 M 1275 314.6 C 1225.3 324.1,1163.2 410.7,1150.5 488.4 L 1149.9 492.2 1155.2 491.5 C 1228.4 482.4,1288.1 436.7,1306.6 375.5 C 1309.7 365.1,1310.7 341.3,1308.2 333.4 C 1304.3 320.5,1289.1 311.9,1275 314.6"
			/>
		</svg>
	);
}
