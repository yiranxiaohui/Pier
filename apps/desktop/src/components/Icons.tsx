import { type ReactNode, type SVGProps, useId } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

/** Minimal stroke icon set (Lucide-style geometry) so the UI does not rely on text glyphs. */
function make(paths: ReactNode) {
	return function Icon({ size = 16, className, ...rest }: IconProps) {
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.9}
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

export const IconPlus = make(<path d="M12 5v14M5 12h14" />);
export const IconX = make(<path d="M18 6 6 18M6 6l12 12" />);
export const IconCheck = make(<path d="M20 6 9 17l-5-5" />);
export const IconChevronRight = make(<path d="m9 18 6-6-6-6" />);
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />);
export const IconChevronUp = make(<path d="m18 15-6-6-6 6" />);
export const IconArrowUp = make(<path d="M12 19V5M5 12l7-7 7 7" />);
export const IconArrowLeft = make(<path d="M19 12H5M12 19l-7-7 7-7" />);
export const IconArrowDown = make(<path d="M12 5v14M19 12l-7 7-7-7" />);
export const IconRefresh = make(<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5" />);
export const IconMore = make(
	<>
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
		<circle cx="5" cy="12" r="1" />
	</>,
);
export const IconSettings = make(
	<>
		<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
		<circle cx="12" cy="12" r="3" />
	</>,
);
export const IconFolder = make(
	<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
);
export const IconFolderPlus = make(
	<>
		<path d="M12 10v6M9 13h6" />
		<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
	</>,
);
export const IconMessage = make(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />);
export const IconMessagePlus = make(
	<>
		<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
		<path d="M8 12h8M12 8v8" />
	</>,
);
export const IconTerminal = make(<path d="m4 17 6-6-6-6M12 19h8" />);
export const IconFile = make(
	<>
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
		<path d="M14 2v4a2 2 0 0 0 2 2h4" />
	</>,
);
export const IconFilePen = make(
	<>
		<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5" />
		<path d="M14 2v4a2 2 0 0 0 2 2h4" />
		<path d="M13.38 12.62a2.12 2.12 0 1 1 3 3L11 21l-4 1 1-4Z" />
	</>,
);
export const IconFilePlus = make(
	<>
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
		<path d="M14 2v4a2 2 0 0 0 2 2h4M9 15h6M12 12v6" />
	</>,
);
export const IconSearch = make(
	<>
		<circle cx="11" cy="11" r="8" />
		<path d="m21 21-4.3-4.3" />
	</>,
);
export const IconList = make(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />);
export const IconWrench = make(
	<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
);
export const IconShield = make(
	<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
);
export const IconShieldAlert = make(
	<>
		<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
		<path d="M12 8v4M12 16h.01" />
	</>,
);
export const IconZap = make(
	<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
);
export const IconSparkles = make(
	<>
		<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" />
		<path d="M20 3v4M22 5h-4" />
	</>,
);
export const IconBrain = make(
	<>
		<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
		<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
		<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
	</>,
);
export const IconCopy = make(
	<>
		<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	</>,
);
export const IconCut = make(
	<>
		<circle cx="6" cy="6" r="3" />
		<circle cx="6" cy="18" r="3" />
		<path d="m8.12 8.12 12 12M8.12 15.88 20 4M14 14l6 6" />
	</>,
);
export const IconPaste = make(
	<>
		<rect x="8" y="2" width="8" height="4" rx="1" />
		<path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 12h6M9 16h6" />
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
export const IconClock = make(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 6v6l4 2" />
	</>,
);
export const IconAlert = make(
	<>
		<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
		<path d="M12 9v4M12 17h.01" />
	</>,
);
export const IconInfo = make(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 16v-4M12 8h.01" />
	</>,
);
export const IconPower = make(<path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04" />);
export const IconLogs = make(<path d="M13 12h8M13 18h8M13 6h8M3 12h1M3 18h1M3 6h1M8 12h1M8 18h1M8 6h1" />);
export const IconGitBranch = make(
	<>
		<path d="M6 3v12" />
		<circle cx="18" cy="6" r="3" />
		<circle cx="6" cy="18" r="3" />
		<path d="M18 9a9 9 0 0 1-9 9" />
	</>,
);
export const IconMinimize = make(
	<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />,
);
export const IconLayers = make(
	<>
		<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
		<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
	</>,
);
export const IconPuzzle = make(
	<path d="M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.47.47.7 1.09.7 1.7s-.23 1.24-.7 1.71l-1.61 1.6a.98.98 0 0 1-.84.28c-.47-.07-.8-.48-.97-.92a2.5 2.5 0 1 0-3.21 3.21c.44.17.85.5.92.97a.98.98 0 0 1-.28.84l-1.6 1.61a2.4 2.4 0 0 1-1.71.7 2.4 2.4 0 0 1-1.7-.7l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.47-.18.9-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.57-1.57A2.4 2.4 0 0 1 2 12c0-.62.24-1.23.7-1.7l1.53-1.53c.24-.24.58-.35.92-.3.51.08.88.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92L10.3 2.7A2.4 2.4 0 0 1 12 2c.62 0 1.23.24 1.7.7l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.47.18-.9.53-.97 1.02Z" />,
);
export const IconImage = make(
	<>
		<rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
		<circle cx="9" cy="9" r="2" />
		<path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
	</>,
);
export const IconSmartphone = make(
	<>
		<rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
		<path d="M12 18h.01" />
	</>,
);
export const IconMonitor = make(
	<>
		<rect width="20" height="14" x="2" y="3" rx="2" />
		<path d="M8 21h8M12 17v4" />
	</>,
);
export const IconPencil = make(
	<>
		<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
		<path d="m15 5 4 4" />
	</>,
);
export const IconSquarePen = make(
	<>
		<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
		<path d="M18.38 2.62a1 1 0 0 1 3 3l-9.01 9.02a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z" />
	</>,
);
export const IconLoader = make(<path d="M21 12a9 9 0 1 1-6.22-8.56" />);
export const IconKey = make(
	<>
		<path d="M2.59 18.41A2 2 0 0 0 2 19.83V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.17a2 2 0 0 0 1.42-.59l.81-.81a6.5 6.5 0 1 0-4.24-4.24z" />
		<circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
	</>,
);
export const IconExternal = make(
	<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
);
export const IconTrash = make(
	<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />,
);
export const IconArchive = make(
	<>
		<rect x="2" y="3" width="20" height="5" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
	</>,
);
export const IconArchiveRestore = make(
	<>
		<rect x="2" y="3" width="20" height="5" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h2M20 8v11a2 2 0 0 1-2 2h-2M9 15l3-3 3 3M12 12v9" />
	</>,
);
export const IconBroom = make(
	<>
		<path d="m16 22-1-4M8 22l1-4" />
		<path d="M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1" />
		<path d="M5 14h14l1.97 6.77A1 1 0 0 1 20 22H4a1 1 0 0 1-.97-1.23z" />
	</>,
);
export const IconDownload = make(<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />);
export const IconUpload = make(<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />);
export const IconPanelRight = make(
	<>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<path d="M15 3v18" />
	</>,
);
export const IconPanelLeft = make(
	<>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<path d="M9 3v18" />
	</>,
);
export const IconFolderOpen = make(
	<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />,
);
export const IconHome = make(
	<>
		<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
		<path d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</>,
);
export const IconLink = make(
	<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />,
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
export const IconUser = make(
	<>
		<circle cx="12" cy="8" r="4" />
		<path d="M4 21a8 8 0 0 1 16 0" />
	</>,
);
export const IconActivity = make(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />);
export const IconWallet = make(
	<>
		<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
		<path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
	</>,
);
export const IconServer = make(
	<>
		<rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
		<rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
		<path d="M6 6h.01M6 18h.01" />
	</>,
);
export const IconSliders = make(
	<>
		<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" />
		<path d="M14 2v4M8 10v4M16 18v4" />
	</>,
);
export const IconUndo = make(
	<>
		<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
		<path d="M3 3v5h5" />
	</>,
);
export const IconBraces = make(
	<>
		<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
		<path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
	</>,
);
export const IconBot = make(
	<>
		<path d="M12 8V4H8" />
		<rect x="4" y="8" width="16" height="12" rx="2" />
		<path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
	</>,
);
export const IconEye = make(
	<>
		<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
		<circle cx="12" cy="12" r="3" />
	</>,
);
export const IconEyeOff = make(
	<>
		<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.3 0 8.17 2.6 9.94 6.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49" />
		<path d="M14.08 14.16a3 3 0 0 1-4.24-4.24" />
		<path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.45-5.14" />
		<path d="m2 2 20 20" />
	</>,
);
export const IconMinus = make(<path d="M5 12h14" />);

export const IconGlobe = make(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M2 12h20M12 2a18 18 0 0 1 0 20 18 18 0 0 1 0-20" />
	</>,
);

export const IconMic = make(
	<>
		<rect x="9" y="2" width="6" height="12" rx="3" />
		<path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
	</>,
);
export const IconNetwork = make(
	<>
		<rect x="16" y="16" width="6" height="6" rx="1" />
		<rect x="2" y="16" width="6" height="6" rx="1" />
		<rect x="9" y="2" width="6" height="6" rx="1" />
		<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
	</>,
);
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
