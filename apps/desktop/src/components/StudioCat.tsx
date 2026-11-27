import type { AgentRuntimeId } from "@pier/protocol";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useSyncExternalStore } from "react";
import type {
	CatAccessory,
	CatCoat,
	CatEyes,
	CatLook,
	DeskItem,
	RoomDecor,
	SkyPhase,
	StudioMood,
} from "../lib/agent-activity.ts";
import { AgentIcon } from "./AgentIcons.tsx";

/** What a desk shows: what the agent does, or the cheer (or sigh) right after it finished. */
export type DeskMood = StudioMood | "done";

/** A cat in the lounge: asleep, looking up at the pointer, or sulking after a failed run. */
export type LoungeMood = "asleep" | "awake" | "upset";

/** Angles of a wall clock's hands, in degrees. */
export interface ClockHands {
	hour: number;
	minute: number;
}

const IRIS: Record<CatEyes, string> = {
	amber: "#ffb43a",
	emerald: "#42d68a",
	sky: "#4cb8ff",
	violet: "#a98aff",
	rose: "#ff7fb2",
	honey: "#ffdc5e",
};

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMotion(listener: () => void): () => void {
	const query = window.matchMedia(MOTION_QUERY);
	query.addEventListener("change", listener);
	return () => query.removeEventListener("change", listener);
}

/** Whether the system asks for less motion; the stylesheet stops CSS animations, this stops the SVG ones. */
function useReducedMotion(): boolean {
	return useSyncExternalStore(subscribeMotion, () => window.matchMedia(MOTION_QUERY).matches);
}

// ---- expressions ---------------------------------------------------------------------------

type EyeShape = "open" | "closed" | "happy" | "squeeze";
type MouthShape = "smile" | "o" | "grin" | "wavy" | "pout";
type BrowShape = "none" | "raised" | "firm" | "sad" | "ponder";

interface Face {
	eyes: EyeShape;
	mouth: MouthShape;
	brows: BrowShape;
}

function faceOf(mood: DeskMood | LoungeMood): Face {
	switch (mood) {
		case "done":
			return { eyes: "happy", mouth: "grin", brows: "none" };
		case "error":
		case "upset":
			return { eyes: "squeeze", mouth: "wavy", brows: "sad" };
		case "resting":
		case "asleep":
			return { eyes: "closed", mouth: "smile", brows: "none" };
		case "waiting":
			return { eyes: "open", mouth: "o", brows: "raised" };
		case "thinking":
			return { eyes: "open", mouth: "pout", brows: "ponder" };
		case "retrying":
			return { eyes: "open", mouth: "pout", brows: "firm" };
		default:
			return { eyes: "open", mouth: "smile", brows: "none" };
	}
}

// ---- shared paint ---------------------------------------------------------------------------

/** Gradients a cat is painted with; `id` keeps them apart from the other cats on the page. */
function CatDefs({ id }: { id: string }) {
	return (
		<>
			<radialGradient id={`${id}-fur`} cx="0.36" cy="0.24" r="0.95">
				<stop offset="0" className="fur-hi" />
				<stop offset="0.5" className="fur-mid" />
				<stop offset="1" className="fur-lo" />
			</radialGradient>
			<radialGradient id={`${id}-blush`}>
				<stop offset="0" className="blush-core" />
				<stop offset="1" className="blush-edge" />
			</radialGradient>
			<linearGradient id={`${id}-iris`} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" className="iris-top" />
				<stop offset="0.42" className="iris-mid" />
				<stop offset="1" className="iris-bottom" />
			</linearGradient>
			<linearGradient id={`${id}-ear`} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" className="ear-top" />
				<stop offset="1" className="ear-bottom" />
			</linearGradient>
			<radialGradient id={`${id}-mask`}>
				<stop offset="0.2" className="mask-core" />
				<stop offset="1" className="mask-edge" />
			</radialGradient>
		</>
	);
}

/** The rest of a desk scene's paint: lamp light on the wall, the laptop's light, the sky and the wood. */
function RoomDefs({ id }: { id: string }) {
	return (
		<>
			<radialGradient id={`${id}-glow`}>
				<stop offset="0" className="glow-core" />
				<stop offset="1" className="glow-edge" />
			</radialGradient>
			<radialGradient id={`${id}-screen`}>
				<stop offset="0" className="screen-core" />
				<stop offset="1" className="screen-edge" />
			</radialGradient>
			<linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" className="sky-top" />
				<stop offset="1" className="sky-bottom" />
			</linearGradient>
			<linearGradient id={`${id}-wood`} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" className="wood-top" />
				<stop offset="1" className="wood-bottom" />
			</linearGradient>
			<linearGradient id={`${id}-lid`} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" className="lid-top" />
				<stop offset="1" className="lid-bottom" />
			</linearGradient>
			<clipPath id={`${id}-above`}>
				<rect x="-40" y="-80" width="280" height="204" />
			</clipPath>
			<clipPath id={`${id}-pane`}>
				<rect x="3.6" y="3.6" width="32.8" height="37.8" rx="3.4" />
			</clipPath>
		</>
	);
}

// ---- the head --------------------------------------------------------------------------------

function Eye({ id, cx }: { id: string; cx: number }) {
	const cy = 76;
	return (
		<g className="cat-eye" style={{ transformOrigin: `${cx}px ${cy}px` }}>
			<ellipse className="eye-base" cx={cx} cy={cy} rx="7.1" ry="8.5" />
			<g className="cat-pupil">
				<ellipse cx={cx} cy={cy + 1.3} rx="5.6" ry="6.6" fill={`url(#${id}-iris)`} />
				<ellipse className="eye-pupil" cx={cx} cy={cy + 0.2} rx="2.7" ry="3.9" />
			</g>
			<circle className="eye-shine" cx={cx + 2.6} cy={cy - 3.4} r="2.5" />
			<circle className="eye-shine" cx={cx - 2.8} cy={cy + 3.6} r="1.2" />
		</g>
	);
}

/** `lens`: a magnifier covers the right eye (it draws its own, bigger one). */
function Eyes({ id, shape, lens }: { id: string; shape: EyeShape; lens: boolean }) {
	switch (shape) {
		case "closed":
			return (
				<g className="cat-eyes">
					<path className="cat-ink-line thick" d="M76 77.4 q7 5.8 14 0" />
					<path className="cat-ink-line thick" d="M110 77.4 q7 5.8 14 0" />
				</g>
			);
		case "happy":
			return (
				<g className="cat-eyes">
					<path className="cat-ink-line thick" d="M76 79.6 q7 -8.4 14 0" />
					<path className="cat-ink-line thick" d="M110 79.6 q7 -8.4 14 0" />
				</g>
			);
		case "squeeze":
			return (
				<g className="cat-eyes">
					<path className="cat-ink-line thick" d="M77.6 71.4 l9.4 5 l-9.4 5" />
					<path className="cat-ink-line thick" d="M122.4 71.4 l-9.4 5 l9.4 5" />
				</g>
			);
		default:
			return (
				<g className="cat-eyes">
					<g className="cat-gaze">
						<Eye id={id} cx={83} />
						{lens ? null : <Eye id={id} cx={117} />}
					</g>
				</g>
			);
	}
}

function Brows({ shape }: { shape: BrowShape }) {
	switch (shape) {
		case "raised":
			return <path className="cat-brow" d="M77 62.6 q6 -3.2 12 -0.6 M123 62.6 q-6 -3.2 -12 -0.6" />;
		case "firm":
			return <path className="cat-brow" d="M76.4 61.8 l12 4.2 M123.6 61.8 l-12 4.2" />;
		case "sad":
			return <path className="cat-brow" d="M76.4 66 l11.6 -3.8 M123.6 66 l-11.6 -3.8" />;
		case "ponder":
			return <path className="cat-brow" d="M77 64.4 h11 M112 61.6 q6 -3.6 11.6 -0.4" />;
		default:
			return null;
	}
}

function Mouth({ shape }: { shape: MouthShape }) {
	switch (shape) {
		case "o":
			return <ellipse className="cat-mouth-open" cx="100" cy="92.6" rx="2.3" ry="2.9" />;
		case "grin":
			return (
				<g>
					<path className="cat-mouth-open" d="M94.4 90.2 q5.6 8.8 11.2 0 z" />
					<ellipse className="cat-tongue" cx="100" cy="94.4" rx="2.7" ry="1.5" />
				</g>
			);
		case "wavy":
			return <path className="cat-ink-line" d="M94.4 93 q2.8 -2.8 5.6 0 q2.8 2.8 5.6 0" />;
		case "pout":
			return <path className="cat-ink-line" d="M100 88.8 v1.4 M96.8 91.6 q3.4 1.6 6.4 -0.8" />;
		default:
			return <path className="cat-ink-line" d="M100 88.8 v1.2 M95.2 90 q2.4 2.9 4.8 0 q2.4 2.9 4.8 0" />;
	}
}

function Accessory({ kind }: { kind: CatAccessory }) {
	switch (kind) {
		case "sprout":
			return (
				<g className="cat-accessory sprout">
					<path className="acc-stem" d="M100 40.5 C100 36.5 100.6 33.5 101.4 30.5" />
					<path className="acc-leaf" d="M101 32.6 C95 26.4 87 27.2 85 33.2 C91 36.8 97 36.2 101 32.6 Z" />
					<path className="acc-leaf" d="M101.4 30.4 C105 22.4 114 21.4 118 26.4 C113 32.4 106 33.4 101.4 30.4 Z" />
				</g>
			);
		case "bow":
			return (
				<g className="cat-accessory bow" transform="rotate(16 124 45)">
					<path className="acc-bow-tail" d="M122.6 47 l-3.4 7 M125.4 47 l3.4 7" />
					<path className="acc-bow" d="M124 45 C118 37.6 110.6 38 110.4 44.6 C110.2 51.4 117.4 52 124 45 Z" />
					<path className="acc-bow" d="M124 45 C130 37.6 137.4 38 137.6 44.6 C137.8 51.4 130.6 52 124 45 Z" />
					<circle className="acc-bow-knot" cx="124" cy="45" r="3.2" />
				</g>
			);
		case "headphones":
			return (
				<g className="cat-accessory headphones">
					<path className="acc-band" d="M60.6 76 C57 26 143 26 139.4 76" />
					<rect className="acc-cup" x="50.4" y="65" width="13.2" height="21.6" rx="5.8" />
					<rect className="acc-cup" x="136.4" y="65" width="13.2" height="21.6" rx="5.8" />
					<path className="acc-cup-shine" d="M53.6 70 v8 M146.4 70 v8" />
				</g>
			);
		case "glasses":
			return (
				<g className="cat-accessory glasses">
					<circle className="acc-lens" cx="83" cy="76" r="10.8" />
					<circle className="acc-lens" cx="117" cy="76" r="10.8" />
					<path className="acc-frame" d="M93.6 74.6 q6.4 -3.8 12.8 0 M72.4 73.8 l-11 -3.4 M127.6 73.8 l11 -3.4" />
					<path className="acc-glint" d="M76.4 70.6 l3 -3 M110.4 70.6 l3 -3" />
				</g>
			);
		case "flower":
			return (
				<g className="cat-accessory flower">
					{[0, 72, 144, 216, 288].map((angle) => (
						<circle
							key={angle}
							className="acc-petal"
							cx={127 + 5.2 * Math.cos((angle * Math.PI) / 180)}
							cy={47 + 5.2 * Math.sin((angle * Math.PI) / 180)}
							r="3.8"
						/>
					))}
					<circle className="acc-center" cx="127" cy="47" r="2.9" />
				</g>
			);
		case "cap":
			return (
				<g className="cat-accessory cap">
					<path className="acc-cap" d="M71 55 C72 31 128 31 129 55 C118 50 82 50 71 55 Z" />
					<path className="acc-cap-seam" d="M100 34 C96.4 39.6 95.2 45.6 95.6 51" />
					<path className="acc-brim" d="M119 52.4 q16 -2.6 21.6 3.6 q-10 3.8 -23.6 1 Z" />
					<circle className="acc-cap-button" cx="100" cy="35.6" r="2.4" />
				</g>
			);
		default:
			return null;
	}
}

/** The coat's markings on the head: stripes, an eye patch, a white blaze or a dark mask. */
function Markings({ id, coat }: { id: string; coat: CatCoat }) {
	switch (coat) {
		case "tabby":
			return (
				<path
					className="cat-stripes"
					d="M100 43.4 v8.6 M91 45 l2.2 7.4 M109 45 l-2.2 7.4 M60.6 70.4 h6.4 M60 76.4 h5.8 M139.4 70.4 h-6.4 M140 76.4 h-5.8"
				/>
			);
		case "patch":
			return (
				<ellipse className="cat-dark-fill" cx="118.4" cy="69.6" rx="15" ry="13.4" transform="rotate(-12 118.4 69.6)" />
			);
		case "tuxedo":
			return (
				<path
					className="cat-light-fill"
					d="M96.4 57 C97.6 66 96.6 76 91.4 84.6 L108.6 84.6 C103.4 76 102.4 66 103.6 57 Q100 54.2 96.4 57 Z"
				/>
			);
		case "points":
			return <ellipse cx="100" cy="82" rx="33" ry="26" fill={`url(#${id}-mask)`} />;
		default:
			return null;
	}
}

function Ear({ id, side }: { id: string; side: "left" | "right" }) {
	return (
		<g className={`cat-ear ${side}`}>
			<path
				className="cat-furry cat-ear-shell"
				d="M62.5 62 C58.5 46 60.5 33 67 28 C71.5 26 83 33 93.5 43.5 Z"
				fill={`url(#${id}-fur)`}
			/>
			<path d="M67.6 54.5 C66.6 45.4 67.6 38.2 70.4 35.2 C73 34.2 79.4 38.4 85.6 44.4 Z" fill={`url(#${id}-ear)`} />
			<path className="cat-ear-fluff" d="M71.6 51 l2.6 -6.6 M75.8 51.8 l1.6 -4.8" />
		</g>
	);
}

/**
 * A cat's head, about 94 wide and 80 tall around (100, 73): ears, cheek tufts, face and accessory.
 * The stylesheet animates it by the scene's `mood-*` class.
 */
function Head({ id, face, look, lens = false }: { id: string; face: Face; look: CatLook; lens?: boolean }) {
	const fur = `url(#${id}-fur)`;
	const blush = `url(#${id}-blush)`;
	return (
		<g className="cat-head">
			<Ear id={id} side="left" />
			<g transform="translate(200 0) scale(-1 1)">
				<Ear id={id} side="right" />
			</g>
			<path
				className="cat-furry"
				fill={fur}
				d="M100 39 C124 39 142 53 142 75 C142 79.6 141.3 83.8 139.9 87.6 L147.2 90.6 L138.2 93.6 L143.4 98.8 L132 99 C123.4 104.2 112.2 107 100 107 C87.8 107 76.6 104.2 68 99 L56.6 98.8 L61.8 93.6 L52.8 90.6 L60.1 87.6 C58.7 83.8 58 79.6 58 75 C58 53 76 39 100 39 Z"
			/>
			<Markings id={id} coat={look.coat} />
			<path
				className="cat-shade"
				d="M63.4 88.4 C72 100.8 86.6 106.6 100 106.6 C113.4 106.6 128 100.8 136.6 88.4 C128 97.8 114 102.6 100 102.6 C86 102.6 72 97.8 63.4 88.4 Z"
			/>
			<ellipse className="cat-gloss" cx="79.4" cy="51" rx="12" ry="5" transform="rotate(-25 79.4 51)" />
			<ellipse className="cat-muzzle" cx="100" cy="90.4" rx={look.coat === "tuxedo" ? 15.6 : 13} ry="8.4" />
			<ellipse cx="72.4" cy="87.6" rx="8.6" ry="5.2" fill={blush} />
			<ellipse cx="127.6" cy="87.6" rx="8.6" ry="5.2" fill={blush} />
			<path
				className="cat-whisker"
				d="M62.6 80.6 q-7.6 -3.2 -14.2 -2.8 M61.6 85 q-8 -1 -14.6 1 M137.4 80.6 q7.6 -3.2 14.2 -2.8 M138.4 85 q8 -1 14.6 1"
			/>
			<Brows shape={face.brows} />
			<Eyes id={id} shape={face.eyes} lens={lens} />
			<path
				className="cat-nose"
				d="M97.2 84.6 h5.6 c1 0 1.5 1.1 .7 1.8 l-2.4 2 c-.6 .5 -1.6 .5 -2.2 0 l-2.4 -2 c-.8 -.7 -.3 -1.8 .7 -1.8 z"
			/>
			<Mouth shape={face.mouth} />
			<Accessory kind={look.accessory} />
		</g>
	);
}

// ---- tails ------------------------------------------------------------------------------------

/** Poses a tail sways between: the rest pose, a swing out and a swing in (same commands in each). */
const TAILS = {
	// Curled up beside the cat at its desk.
	up: [
		"M127 119 C152 125 170 109 164 89 C162 80 153 78 151 86",
		"M127 119 C154 122 176 103 172 83 C170 74 161 73 160 81",
		"M127 119 C150 126 164 113 157 94 C154 86 146 86 145 93",
	],
	// Low over the desk's end, out of the way of a raised paw.
	low: [
		"M127 119 C150 124 172 121 181 107 C185 99 180 93 175 97",
		"M127 119 C152 122 177 116 187 101 C191 93 186 87 181 91",
		"M127 119 C148 126 168 125 175 112 C179 105 174 99 169 103",
	],
	// Wrapped around the front of a cat lying on its cushion.
	lounge: [
		"M138 88 C154 91 153 105 133 104 C120 103.4 110 101.6 102 101",
		"M138 88 C155 90 155 104 134 104.8 C121 105 111 103.6 103 104",
		"M138 88 C153 92 151 106 132 103.4 C119 101.8 110 99.4 102 98.2",
	],
} as const;

const TAIL_EASE = "0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1";

/**
 * A tail that sways by morphing its curve; `seconds` is about one full sway. `phase` (0 to 4) keeps
 * the cats out of step: each starts a moment apart and at a pace of its own.
 *
 * The sway is started from script. In Chromium an animation that begins with its element, or in the
 * past, stays on its first frame until its first repeat; one begun by `beginElementAt` at or after
 * the present runs at once.
 */
function Tail({
	pose,
	seconds,
	phase,
	coat,
	still,
}: {
	pose: keyof typeof TAILS;
	seconds: number;
	phase: number;
	coat: CatCoat;
	still: boolean;
}) {
	const group = useRef<SVGGElement>(null);
	const [rest, out, back] = TAILS[pose];
	const pace = seconds * (0.86 + (phase % 1) * 0.28);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new pose or pace makes new animations to begin.
	useEffect(() => {
		if (still) return;
		const wait = (phase / 4) * Math.min(seconds, 1.2) * 0.5;
		for (const sway of group.current?.querySelectorAll("animate") ?? []) sway.beginElementAt(wait);
	}, [still, phase, pose, seconds]);
	const sway = still ? null : (
		<animate
			key={`${pose}:${seconds}`}
			attributeName="d"
			dur={`${pace.toFixed(2)}s`}
			begin="indefinite"
			repeatCount="indefinite"
			calcMode="spline"
			keyTimes="0;0.25;0.5;0.75;1"
			keySplines={TAIL_EASE}
			values={`${rest};${out};${rest};${back};${rest}`}
		/>
	);
	return (
		<g className="cat-tail" ref={group}>
			<path className="cat-limb-line" d={rest}>
				{sway}
			</path>
			<path className="cat-limb-fur" d={rest}>
				{sway}
			</path>
			{coat === "tabby" ? (
				<path className="cat-tail-stripes" d={rest}>
					{sway}
				</path>
			) : null}
			{coat === "points" || coat === "tuxedo" ? (
				<path className="cat-tail-tip" d={rest} pathLength={100}>
					{sway}
				</path>
			) : null}
		</g>
	);
}

// ---- limbs and props ----------------------------------------------------------------------------

/** A paw resting on the desk or the cushion, with its toes drawn. */
function Paw({ id, x, y, side }: { id: string; x: number; y: number; side: "left" | "right" }) {
	return (
		<g className={`cat-paw ${side}`}>
			<ellipse className="cat-furry cat-paw-pad" cx={x} cy={y} rx="9.6" ry="6.4" fill={`url(#${id}-fur)`} />
			<path className="cat-toe" d={`M${x - 3.5} ${y - 1.8} v2.8 M${x + 3.5} ${y - 1.8} v2.8`} />
		</g>
	);
}

/** A raised right arm showing its palm, pink beans and all; mirror it for the left one. */
function RaisedArm({ id, className }: { id: string; className: string }) {
	return (
		<g className={`cat-arm ${className}`}>
			<path className="cat-limb-line" d="M129 108 C144 104 154 87 157 69" />
			<path className="cat-limb-fur" d="M129 108 C144 104 154 87 157 69" />
			<ellipse className="cat-furry cat-paw-pad" cx="158" cy="61.6" rx="8.4" ry="8" fill={`url(#${id}-fur)`} />
			<ellipse className="cat-bean" cx="158" cy="63.8" rx="3.3" ry="2.6" />
			<circle className="cat-bean" cx="153.6" cy="58.8" r="1.35" />
			<circle className="cat-bean" cx="158" cy="56.8" r="1.4" />
			<circle className="cat-bean" cx="162.4" cy="58.8" r="1.35" />
		</g>
	);
}

/** Searching: a magnifying glass held up to the right eye, which looks huge through it. */
function Magnifier({ id }: { id: string }) {
	return (
		<g className="cat-arm magnify">
			<path className="cat-limb-line" d="M128 109 C134 106 138 102 139.6 97" />
			<path className="cat-limb-fur" d="M128 109 C134 106 138 102 139.6 97" />
			<path className="lens-handle" d="M127.6 85.2 L138.6 96.8" />
			<circle className="lens-glass" cx="118.4" cy="75.4" r="12.6" />
			<g className="lens-eye">
				<ellipse className="eye-base" cx="118.4" cy="75.8" rx="9.4" ry="11" />
				<ellipse cx="118.4" cy="77.4" rx="7.4" ry="8.6" fill={`url(#${id}-iris)`} />
				<ellipse className="eye-pupil" cx="118.4" cy="76" rx="3.6" ry="5" />
				<circle className="eye-shine" cx="121.8" cy="71.4" r="3.3" />
				<circle className="eye-shine" cx="114.8" cy="80.6" r="1.6" />
			</g>
			<circle className="lens-ring" cx="118.4" cy="75.4" r="12.6" />
			<path className="lens-glint" d="M108.8 71.4 a10.4 10.4 0 0 1 6 -6" />
			<ellipse className="cat-furry cat-paw-pad" cx="139.8" cy="97.6" rx="7.2" ry="6.6" fill={`url(#${id}-fur)`} />
			<path className="cat-toe" d="M137.6 95.6 v2.8 M142 95.6 v2.8" />
		</g>
	);
}

/** Reading: a sheet held up in the left paw; a highlight runs down its lines. */
function Paper({ id }: { id: string }) {
	return (
		<g className="cat-arm paper">
			<path className="cat-limb-line" d="M73 107 C66 103 61 98 59.6 93" />
			<path className="cat-limb-fur" d="M73 107 C66 103 61 98 59.6 93" />
			<g transform="rotate(-9 40 72)">
				<rect className="paper-page" x="22" y="48" width="35" height="46" rx="3.2" />
				<rect className="paper-scan" x="25.6" y="54.6" width="27.8" height="5.4" rx="1.6" />
				<path className="paper-lines" d="M28 57.4 h22 M28 63.8 h23 M28 70.2 h17 M28 76.6 h23 M28 83 h13" />
			</g>
			<ellipse className="cat-furry cat-paw-pad" cx="58.8" cy="92.6" rx="7.2" ry="6.6" fill={`url(#${id}-fur)`} />
			<path className="cat-toe" d="M56.6 90.6 v2.8 M61 90.6 v2.8" />
		</g>
	);
}

// ---- the little screen ---------------------------------------------------------------------------

type ScreenKind = "code" | "text" | "terminal" | "web" | "gear" | "layers" | "retry" | "dots";

/** What the laptop shows, mirrored on a little screen beside the cat (the lid faces us). */
const SCREEN: Partial<Record<DeskMood, ScreenKind>> = {
	editing: "code",
	writing: "text",
	command: "terminal",
	browsing: "web",
	tool: "gear",
	compacting: "layers",
	retrying: "retry",
	working: "dots",
};

/** Lines of the code screen: `[x, width, colour class]` of each token. */
const CODE_LINES: ReadonlyArray<ReadonlyArray<readonly [number, number, string]>> = [
	[
		[-7, 9, "kw"],
		[4, 15, "fn"],
	],
	[
		[-3, 7, "kw"],
		[6, 12, "str"],
		[20, 9, "txt"],
	],
	[
		[-3, 17, "txt"],
		[16, 9, "num"],
	],
	[
		[-3, 8, "fn"],
		[7, 14, "str"],
	],
];

const TEXT_LINES = [40, 34, 42, 24];

function ScreenLines({ children }: { children: ReactNode[] }) {
	return (
		<>
			{children.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of lines.
				<g key={i} className="screen-line" style={{ animationDelay: `${i * 0.55}s` }}>
					{line}
				</g>
			))}
		</>
	);
}

function ScreenContent({ kind }: { kind: ScreenKind }) {
	switch (kind) {
		case "code":
			return (
				<>
					<path className="screen-added" d="M-9.6 58.6 v4.4 M-9.6 64.2 v4.4" />
					<ScreenLines>
						{CODE_LINES.map((tokens, i) =>
							tokens.map(([x, width, tone]) => (
								<rect
									key={x}
									className={`screen-token ${tone}`}
									x={x}
									y={52.6 + i * 5.6}
									width={width}
									height="2.6"
									rx="1.3"
								/>
							)),
						)}
					</ScreenLines>
				</>
			);
		case "text":
			return (
				<>
					<ScreenLines>
						{TEXT_LINES.map((width, i) => [
							<rect
								key={width}
								className="screen-token txt"
								x="-7"
								y={52.6 + i * 5.6}
								width={width}
								height="2.6"
								rx="1.3"
							/>,
						])}
					</ScreenLines>
					<rect className="screen-cursor" x="19" y="68.4" width="1.8" height="4" rx="0.6" />
				</>
			);
		case "terminal":
			return (
				<>
					<path className="screen-prompt" d="M-7 52.2 l2.4 1.9 l-2.4 1.9" />
					<rect className="screen-token txt" x="-2" y="52.8" width="20" height="2.6" rx="1.3" />
					<g className="screen-output">
						<rect className="screen-token dim" x="-7" y="58.4" width="34" height="2.6" rx="1.3" />
						<rect className="screen-token dim" x="-7" y="64" width="26" height="2.6" rx="1.3" />
					</g>
					<path className="screen-prompt" d="M-7 69 l2.4 1.9 l-2.4 1.9" />
					<rect className="screen-cursor block" x="-2" y="68.8" width="3.4" height="4.2" rx="0.6" />
				</>
			);
		case "web":
			return (
				<>
					<rect className="screen-token dim" x="-7" y="51.6" width="42" height="3.6" rx="1.8" />
					<circle className="screen-stroke" cx="14" cy="66.6" r="8" />
					<ellipse className="screen-stroke screen-meridian" cx="14" cy="66.6" rx="8" ry="8" />
					<ellipse className="screen-stroke" cx="14" cy="66.6" rx="3.4" ry="8" />
					<path className="screen-stroke" d="M6 66.6 h16" />
				</>
			);
		case "gear":
			return (
				<g className="screen-spin" style={{ transformOrigin: "14px 64.4px" }}>
					<circle className="screen-gear" cx="14" cy="64.4" r="7.4" />
					<circle className="screen-stroke" cx="14" cy="64.4" r="2.8" />
				</g>
			);
		case "layers":
			return (
				<>
					<rect className="screen-token kw screen-layer top" x="-3" y="54" width="34" height="4" rx="2" />
					<rect className="screen-token fn" x="-3" y="62.4" width="34" height="4" rx="2" />
					<rect className="screen-token str screen-layer bottom" x="-3" y="70.8" width="34" height="4" rx="2" />
				</>
			);
		case "retry":
			return (
				<g className="screen-spin" style={{ transformOrigin: "14px 64.4px" }}>
					<path className="screen-stroke thick" d="M21.4 64.4 a7.4 7.4 0 1 1 -2.2 -5.2" />
					<path className="screen-stroke thick" d="M19.6 54.6 v4.8 h-4.8" />
				</g>
			);
		default:
			return (
				<>
					<circle className="screen-dot-big" cx="4" cy="64.4" r="2.6" />
					<circle className="screen-dot-big" cx="14" cy="64.4" r="2.6" />
					<circle className="screen-dot-big" cx="24" cy="64.4" r="2.6" />
				</>
			);
	}
}

function MiniScreen({ kind }: { kind: ScreenKind }) {
	return (
		<g className={`studio-screen kind-${kind}`}>
			<path className="screen-beam" d="M77 97 L2 79 L30 79 Z" />
			<g className="screen-float">
				<rect className="screen-frame" x="-12" y="40" width="52" height="40" rx="6.4" />
				<circle className="screen-light red" cx="-6.2" cy="45.4" r="1.3" />
				<circle className="screen-light yellow" cx="-2.2" cy="45.4" r="1.3" />
				<circle className="screen-light green" cx="1.8" cy="45.4" r="1.3" />
				<ScreenContent kind={kind} />
			</g>
		</g>
	);
}

// ---- things in the air ----------------------------------------------------------------------------

const CLOUD = [
	[30, 4, 9.4],
	[19.4, 7.4, 7],
	[40.6, 7.4, 7],
	[25, -2, 6.4],
	[35.6, -1.4, 6],
] as const;

/** Thinking: a cloud drifting up from the cat's head. */
function ThoughtCloud() {
	return (
		<g className="studio-thought">
			<circle className="thought-puff" cx="56.6" cy="27" r="2.3" />
			<circle className="thought-puff" cx="48.4" cy="19" r="3.5" />
			<g className="thought-cloud">
				{CLOUD.map(([cx, cy, r]) => (
					<circle key={cx} className="thought-rim" cx={cx} cy={cy} r={r} />
				))}
				{CLOUD.map(([cx, cy, r]) => (
					<circle key={cx} className="thought-fill" cx={cx} cy={cy} r={r} />
				))}
				<circle className="thought-dot" cx="23" cy="4.4" r="2" />
				<circle className="thought-dot" cx="30" cy="4.4" r="2" />
				<circle className="thought-dot" cx="37" cy="4.4" r="2" />
			</g>
		</g>
	);
}

/** Waiting for the user: an exclamation mark that hops. */
function AlertMark() {
	return (
		<g className="studio-alert-mark">
			<circle className="alert-halo" cx="38" cy="16" r="13.4" />
			<circle className="alert-disc" cx="38" cy="16" r="9.6" />
			<path className="alert-bang" d="M38 10.6 v6.2" />
			<circle className="alert-bang-dot" cx="38" cy="21" r="1.4" />
		</g>
	);
}

/** A failed run: a little rain cloud, and a drop of sweat. */
function Gloom() {
	return (
		<>
			<g className="studio-gloom">
				<path className="gloom-rain" d="M27 16 l-1.6 5 M34 16.6 l-1.6 5 M41 16 l-1.6 5" />
				<path
					className="gloom-cloud"
					d="M22 13.4 a6 6 0 0 1 1.6 -11.6 a8 8 0 0 1 15 -1.4 a6.4 6.4 0 0 1 4.6 12.2 q-.8 .8 -2 .8 h-17.2 q-1.2 0 -2 0 z"
				/>
			</g>
			<path
				className="studio-sweat-drop"
				d="M141 46 c2.6 3.6 3.6 5.4 3.6 7.2 a3.6 3.6 0 0 1 -7.2 0 c0 -1.8 1 -3.6 3.6 -7.2 z"
			/>
		</>
	);
}

const CONFETTI = [
	{ x: 28, drift: -22, turn: 200, tone: "a", delay: 0 },
	{ x: 48, drift: -10, turn: -160, tone: "b", delay: 0.15 },
	{ x: 70, drift: -6, turn: 260, tone: "c", delay: 0.05 },
	{ x: 92, drift: 4, turn: -220, tone: "d", delay: 0.25 },
	{ x: 110, drift: -4, turn: 180, tone: "e", delay: 0.1 },
	{ x: 130, drift: 8, turn: -250, tone: "b", delay: 0.3 },
	{ x: 150, drift: 14, turn: 210, tone: "c", delay: 0.2 },
	{ x: 172, drift: 22, turn: -190, tone: "a", delay: 0.05 },
];

const SPARKLES = [
	{ x: 44, y: 28, size: 1, delay: 0 },
	{ x: 158, y: 30, size: 0.8, delay: 0.3 },
	{ x: 30, y: 66, size: 0.7, delay: 0.55 },
	{ x: 170, y: 74, size: 0.9, delay: 0.15 },
];

/** A finished run: confetti and twinkling stars. */
function Celebration() {
	return (
		<g className="studio-celebration">
			{CONFETTI.map((piece) => (
				<rect
					key={piece.x}
					className={`confetti tone-${piece.tone}`}
					x={piece.x}
					y="-16"
					width="5"
					height="8.4"
					rx="1.6"
					style={
						{
							"--drift": `${piece.drift}px`,
							"--turn": `${piece.turn}deg`,
							animationDelay: `${piece.delay}s`,
						} as CSSProperties
					}
				/>
			))}
			{SPARKLES.map((star) => (
				<g key={star.x} transform={`translate(${star.x} ${star.y}) scale(${star.size})`}>
					<path
						className="sparkle"
						style={{ animationDelay: `${star.delay}s` }}
						d="M0 -8 C0.8 -2.6 2.6 -0.8 8 0 C2.6 0.8 0.8 2.6 0 8 C-0.8 2.6 -2.6 0.8 -8 0 C-2.6 -0.8 -0.8 -2.6 0 -8 Z"
					/>
				</g>
			))}
		</g>
	);
}

// ---- the room --------------------------------------------------------------------------------------

function Sky({ sky }: { sky: SkyPhase }) {
	switch (sky) {
		case "night":
			return (
				<>
					<circle className="sky-moon" cx="27" cy="14" r="5.8" />
					<circle className="sky-moon-bite" cx="24.2" cy="12.2" r="5" />
					<circle className="sky-star" cx="10" cy="11" r="1" />
					<circle className="sky-star" cx="16" cy="23" r="0.8" style={{ animationDelay: "0.8s" }} />
					<circle className="sky-star" cx="30" cy="30" r="0.9" style={{ animationDelay: "1.6s" }} />
					<circle className="sky-star" cx="9" cy="33" r="0.7" style={{ animationDelay: "2.2s" }} />
				</>
			);
		case "day":
			return (
				<>
					<circle className="sky-sun-halo" cx="29" cy="12" r="8" />
					<circle className="sky-sun" cx="29" cy="12" r="4.6" />
					<g className="sky-cloud">
						<ellipse cx="12" cy="24" rx="8" ry="3.6" />
						<circle cx="9.4" cy="21.6" r="3.4" />
						<circle cx="14.4" cy="20.6" r="4" />
					</g>
					<g className="sky-cloud far">
						<ellipse cx="24" cy="35" rx="6" ry="2.6" />
						<circle cx="25.4" cy="33" r="2.8" />
					</g>
				</>
			);
		default:
			return (
				<>
					<circle className="sky-sun-halo" cx="20" cy="40" r="15" />
					<circle className="sky-sun" cx="20" cy="40" r="9" />
					<g className="sky-cloud">
						<ellipse cx="12" cy="18" rx="8" ry="3" />
						<circle cx="14.4" cy="16" r="3.2" />
					</g>
				</>
			);
	}
}

/** What hangs on the wall, top right: a window on the real sky, a shelf, a clock on real time, a poster. */
function Decor({ id, decor, sky, clock }: { id: string; decor: RoomDecor; sky: SkyPhase; clock: ClockHands }) {
	switch (decor) {
		case "window":
			return (
				<g className="studio-window" transform="translate(173 -13)">
					<rect className="decor-frame" x="0" y="0" width="40" height="45" rx="6" />
					<g clipPath={`url(#${id}-pane)`}>
						<rect x="3.6" y="3.6" width="32.8" height="37.8" fill={`url(#${id}-sky)`} />
						<Sky sky={sky} />
					</g>
					<path className="decor-bars" d="M20 3.6 v37.8 M3.6 22.5 h32.8" />
					<rect className="decor-frame" x="-3" y="43.4" width="46" height="4.2" rx="2.1" />
				</g>
			);
		case "shelf":
			return (
				<g className="studio-shelf" transform="translate(170 -10)">
					<rect className="shelf-book b0" x="5" y="14" width="5.6" height="18" rx="1.2" />
					<rect className="shelf-book b1" x="11.2" y="18" width="5" height="14" rx="1.2" />
					<rect className="shelf-book b2" x="16.8" y="15.6" width="5.6" height="16.4" rx="1.2" />
					<rect
						className="shelf-book b3"
						x="23.4"
						y="19"
						width="4.8"
						height="13"
						rx="1.2"
						transform="rotate(13 25.8 32)"
					/>
					<rect className="shelf-cactus" x="35" y="13.6" width="6" height="12.4" rx="3" />
					<circle className="shelf-flower" cx="38" cy="13.4" r="1.7" />
					<path className="shelf-pot" d="M33.4 25 h9.2 l-1.3 7 h-6.6 z" />
					<rect className="decor-frame" x="0" y="32" width="46" height="3.8" rx="1.9" />
				</g>
			);
		case "clock":
			return (
				<g className="studio-clock" transform="translate(193 11)">
					<path className="decor-frame" d="M-13.4 -9 l1 -10.4 l9 5.4 z M13.4 -9 l-1 -10.4 l-9 5.4 z" />
					<circle className="decor-frame" r="16.4" />
					<circle className="clock-face" r="13.2" />
					<path className="clock-ticks" d="M0 -11.2 v2.4 M11.2 0 h-2.4 M0 11.2 v-2.4 M-11.2 0 h2.4" />
					<path className="clock-hand hour" d="M0 1.2 V-6.4" transform={`rotate(${clock.hour})`} />
					<path className="clock-hand" d="M0 1.6 V-9.6" transform={`rotate(${clock.minute})`} />
					<circle className="clock-pin" r="1.4" />
				</g>
			);
		default:
			return (
				<g className="studio-poster" transform="translate(175 -12) rotate(3 18 22)">
					<rect className="poster-paper" x="0" y="0" width="36" height="44" rx="3" />
					<ellipse className="poster-ink" cx="18" cy="26.6" rx="7" ry="5.6" />
					<circle className="poster-ink" cx="9.4" cy="19.4" r="2.6" />
					<circle className="poster-ink" cx="14.8" cy="15.4" r="2.8" />
					<circle className="poster-ink" cx="21.2" cy="15.4" r="2.8" />
					<circle className="poster-ink" cx="26.6" cy="19.4" r="2.6" />
					<path className="poster-line" d="M9 36.4 h18 M12.4 39.8 h11.2" />
					<circle className="poster-pin" cx="18" cy="3.4" r="1.9" />
				</g>
			);
	}
}

function DeskThing({ item }: { item: DeskItem }) {
	switch (item) {
		case "mug":
			return (
				<g className="studio-mug-item">
					<path className="studio-steam" d="M38.4 100.6 q-2.6 -4 0 -8 M44 100.6 q-2.6 -4 0 -8" />
					<path className="studio-mug" d="M34 104.4 h14 v11 a3 3 0 0 1 -3 3 h-8 a3 3 0 0 1 -3 -3 Z" />
					<path className="studio-mug-handle" d="M48 107.4 a3.5 3.5 0 0 1 0 7" />
					<rect className="studio-mug-band" x="34" y="108.4" width="14" height="2.4" />
				</g>
			);
		case "plant":
			return (
				<g className="studio-plant">
					<path className="studio-plant-leaf" d="M41 108.4 C37 101.4 32 99.4 30 92.4 C37 93.4 41 99.4 41 108.4 Z" />
					<path className="studio-plant-leaf" d="M41 108.4 C43 99.4 47 95.4 52 93.4 C51 100.4 46 104.4 41 108.4 Z" />
					<path className="studio-plant-leaf" d="M41 108.4 C39 100.4 40 94.4 42 88.4 C45 94.4 44 101.4 41 108.4 Z" />
					<path className="studio-plant-pot" d="M33 107.4 h16 l-2 11 h-12 Z" />
					<rect className="studio-plant-rim" x="32" y="105.8" width="18" height="3.6" rx="1.6" />
				</g>
			);
		case "duck":
			return (
				<g className="studio-duck">
					<path
						className="duck-body"
						d="M31 111.4 c0 -4 4 -6 9 -6 c5.4 0 9.6 2.2 9.6 6.4 c0 3.8 -4.2 6.4 -9.6 6.4 c-5.6 0 -9 -2.6 -9 -6.8 z"
					/>
					<circle className="duck-body" cx="45" cy="104" r="4.6" />
					<path className="duck-beak" d="M48.8 103 l4 1.2 l-4 1.6 z" />
					<circle className="duck-eye" cx="46.2" cy="103" r="0.8" />
					<path className="duck-wing" d="M35.6 110.6 q3.6 3.4 7.6 0.4" />
				</g>
			);
		default:
			return null;
	}
}

/** The desk and the laptop on it: the agent's mark on the lid, or a light when nobody sits there. */
function Furniture({ id, runtime, item }: { id: string; runtime?: AgentRuntimeId; item: DeskItem }) {
	return (
		<g className="studio-furniture">
			<ellipse className="studio-screen-glow" cx="100" cy="98" rx="42" ry="15" fill={`url(#${id}-screen)`} />
			<rect className="studio-desk-top" x="20" y="118" width="160" height="9.4" rx="4.7" fill={`url(#${id}-wood)`} />
			<rect className="studio-desk-shine" x="26" y="119.3" width="148" height="1.7" rx="0.85" />
			<path className="studio-desk-front" d="M30 127 h140 v11 a4 4 0 0 1 -4 4 h-132 a4 4 0 0 1 -4 -4 z" />
			<rect className="studio-desk-drawer" x="78" y="130.4" width="44" height="8" rx="2.4" />
			<circle className="studio-desk-knob" cx="100" cy="134.4" r="1.7" />
			<DeskThing item={item} />
			<rect className="studio-laptop" x="75" y="96" width="50" height="22.4" rx="3.6" fill={`url(#${id}-lid)`} />
			<rect className="studio-laptop-shine" x="77.6" y="97.5" width="44.8" height="1.6" rx="0.8" />
			{runtime ? (
				// The agent's own mark on the lid, where a laptop maker's logo would be.
				<g className="studio-laptop-mark" transform="translate(92.5 99.6)">
					<AgentIcon runtime={runtime} size={15} />
				</g>
			) : (
				<circle className="studio-laptop-logo" cx="100" cy="107.2" r="3.4" />
			)}
			<rect className="studio-laptop-base" x="66.5" y="116.4" width="67" height="3.6" rx="1.8" />
		</g>
	);
}

// ---- scenes ------------------------------------------------------------------------------------------

const TYPING: ReadonlySet<DeskMood> = new Set(["writing", "editing", "command", "tool", "browsing", "working"]);

/**
 * A cat at its desk, in its room. The laptop's lid faces us, so a little screen beside the cat shows
 * what is on it; the cat holds a sheet to read and a magnifier to search, waves when it needs the
 * user and throws its paws up when it is done. The stylesheet animates the parts by the `mood-*`
 * class of the desk and colours them by its `runtime-*` and `tint-*` classes.
 */
export function DeskCat({
	mood,
	look,
	runtime,
	sky,
	clock,
}: {
	mood: DeskMood;
	look: CatLook;
	runtime: AgentRuntimeId;
	sky: SkyPhase;
	clock: ClockHands;
}) {
	const id = useId().replace(/[^\w-]/g, "");
	const still = useReducedMotion();
	const face = faceOf(mood);
	const cheering = mood === "done";
	const rightUp = cheering || mood === "waiting" || mood === "searching";
	const leftUp = cheering || mood === "reading";
	const lively = cheering || mood === "waiting";
	const screen = SCREEN[mood];
	return (
		<svg
			viewBox="0 0 240 174"
			className={`studio-cat seat-desk coat-${look.coat} sky-${sky}`}
			style={{ "--cat-iris": IRIS[look.eyes] } as CSSProperties}
			data-gaze="0.5 0.546"
			aria-hidden="true"
		>
			<defs>
				<CatDefs id={id} />
				<RoomDefs id={id} />
			</defs>
			<g transform="translate(20 22)">
				<ellipse className="studio-wall-glow" cx="100" cy="66" rx="128" ry="100" fill={`url(#${id}-glow)`} />
				<rect className="studio-floor-band" x="-20" y="131" width="240" height="21" />
				<rect className="studio-baseboard" x="-20" y="129" width="240" height="2.4" />
				<ellipse className="studio-rug" cx="100" cy="143" rx="98" ry="8.4" />
				<ellipse className="studio-rug-ring" cx="100" cy="143" rx="88" ry="6.4" />
				<Decor id={id} decor={look.decor} sky={sky} clock={clock} />
				<g clipPath={`url(#${id}-above)`}>
					<g className="cat-rise">
						<Tail
							pose={rightUp ? "low" : "up"}
							seconds={lively ? 0.9 : mood === "error" ? 7 : 3.2}
							phase={look.phase}
							coat={look.coat}
							still={still}
						/>
						<g className="cat-body">
							<path
								className="cat-furry"
								d="M67 134 C66 113 80 100 100 100 C120 100 134 113 133 134 Z"
								fill={`url(#${id}-fur)`}
							/>
							<g className="cat-pose">
								<g className="cat-look">
									<Head id={id} face={face} look={look} lens={mood === "searching"} />
								</g>
							</g>
							{mood === "searching" ? <Magnifier id={id} /> : null}
							{mood === "reading" ? <Paper id={id} /> : null}
							{mood === "waiting" ? <RaisedArm id={id} className="wave" /> : null}
							{cheering ? (
								<>
									<RaisedArm id={id} className="cheer" />
									<g transform="translate(200 0) scale(-1 1)">
										<RaisedArm id={id} className="cheer other" />
									</g>
								</>
							) : null}
						</g>
					</g>
				</g>
				<Furniture id={id} runtime={runtime} item={look.deskItem} />
				<g className="cat-front">
					{leftUp ? null : <Paw id={id} x={67.5} y={118.4} side="left" />}
					{rightUp ? null : <Paw id={id} x={132.5} y={118.4} side="right" />}
					{TYPING.has(mood) ? (
						<path
							className="key-sparks"
							d="M58 108.6 l-2.6 -3.4 M64 106.4 v-4.2 M70 108.6 l2.6 -3.4 M130 108.6 l-2.6 -3.4 M136 106.4 v-4.2 M142 108.6 l2.6 -3.4"
						/>
					) : null}
				</g>
				{screen ? <MiniScreen kind={screen} /> : null}
				{mood === "thinking" ? <ThoughtCloud /> : null}
				{mood === "waiting" ? <AlertMark /> : null}
				{mood === "error" ? <Gloom /> : null}
				{cheering ? <Celebration /> : null}
			</g>
		</svg>
	);
}

/**
 * A cat lying on its cushion in the lounge: asleep with its chin on its paws (a bubble at its
 * nose), or with its head up, looking at the pointer.
 */
export function LoungeCat({ mood, look }: { mood: LoungeMood; look: CatLook }) {
	const id = useId().replace(/[^\w-]/g, "");
	const still = useReducedMotion();
	const fur = `url(#${id}-fur)`;
	return (
		<svg
			viewBox="0 0 160 116"
			className={`studio-cat seat-cushion lounge-${mood} coat-${look.coat}`}
			style={{ "--cat-iris": IRIS[look.eyes] } as CSSProperties}
			data-gaze="0.39 0.55"
			aria-hidden="true"
		>
			<defs>
				<CatDefs id={id} />
			</defs>
			<ellipse className="studio-shadow" cx="80" cy="105" rx="64" ry="6.5" />
			<ellipse className="studio-cushion" cx="80" cy="94" rx="66" ry="15.5" />
			<ellipse className="studio-cushion-shine" cx="64" cy="88.6" rx="40" ry="5" />
			<path className="studio-cushion-seam" d="M20 97 C48 108 112 108 140 97" />
			<g className="lounge-body">
				<path className="cat-furry" d="M62 95 C58 66 84 51 108 52 C133 53 146 73 141 95 Z" fill={fur} />
				{look.coat === "tabby" ? (
					<path className="cat-stripes" d="M108 53.6 v7.6 M118.6 55.4 l-1.4 7 M128.4 60.4 l-3 6" />
				) : null}
			</g>
			<Tail
				pose="lounge"
				seconds={mood === "awake" ? 1.4 : 5.5}
				phase={look.phase}
				coat={look.coat}
				still={still || mood === "upset"}
			/>
			<Paw id={id} x={46} y={99.4} side="left" />
			<Paw id={id} x={72} y={101} side="right" />
			<g className="lounge-head">
				<g className="lounge-breath">
					<g transform="translate(62 64) scale(0.86) translate(-100 -73)">
						<g className="cat-look">
							<Head id={id} face={faceOf(mood)} look={look} />
						</g>
						{mood === "asleep" ? (
							<g className="lounge-snot">
								<circle className="snot-bubble" cx="107.4" cy="86.6" r="5.4" />
								<path className="snot-glint" d="M104.6 84.4 a3.6 3.6 0 0 1 2.8 -1.6" />
							</g>
						) : null}
					</g>
				</g>
			</g>
			{mood === "asleep" ? (
				<g className="lounge-zzz">
					<path className="zzz z0" d="M104 36 h5 l-5 6 h5" />
					<path className="zzz z1" d="M113 24 h6.4 l-6.4 7.6 h6.4" />
					<path className="zzz z2" d="M124 10 h8 l-8 9.4 h8" />
				</g>
			) : null}
			{mood === "awake" ? <path className="lounge-notice" d="M104 26 l4 -7 M111 33 l8 -4.4 M113 42 l8.4 0.4" /> : null}
			{mood === "upset" ? (
				<path
					className="studio-sweat-drop"
					d="M100 30 c2.6 3.6 3.6 5.4 3.6 7.2 a3.6 3.6 0 0 1 -7.2 0 c0 -1.8 1 -3.6 3.6 -7.2 z"
				/>
			) : null}
		</svg>
	);
}

/** A kitten for a subagent: just a head, hopping beside the desk. */
export function MiniCat() {
	return (
		<svg viewBox="0 0 40 36" width="30" height="27" aria-hidden="true" className="studio-minicat">
			<path className="cat-furry cat-flat" d="M7 15 C6 9 7 4 10 2.5 C12 2 15 5 18 8.5 Z" />
			<path className="cat-furry cat-flat" d="M33 15 C34 9 33 4 30 2.5 C28 2 25 5 22 8.5 Z" />
			<ellipse className="cat-furry cat-flat" cx="20" cy="20" rx="15" ry="12.5" />
			<ellipse className="cat-muzzle" cx="20" cy="25" rx="5.5" ry="3.6" />
			<ellipse className="cat-cheek-mini" cx="10.5" cy="23.5" rx="2.6" ry="1.6" />
			<ellipse className="cat-cheek-mini" cx="29.5" cy="23.5" rx="2.6" ry="1.6" />
			<ellipse className="eye-base" cx="14.5" cy="19.5" rx="2.3" ry="2.8" />
			<ellipse className="eye-base" cx="25.5" cy="19.5" rx="2.3" ry="2.8" />
			<circle className="eye-shine" cx="15.3" cy="18.5" r="0.9" />
			<circle className="eye-shine" cx="26.3" cy="18.5" r="0.9" />
			<path className="cat-ink-line thin" d="M18 24.4 q1 1.2 2 0 q1 1.2 2 0" />
		</svg>
	);
}

/** The empty floor: a desk with nobody at it, a warm mug, and a fish going round its bowl. */
export function EmptyDesk() {
	const id = useId().replace(/[^\w-]/g, "");
	return (
		<svg viewBox="0 0 200 110" className="studio-cat studio-empty-desk" aria-hidden="true">
			<defs>
				<RoomDefs id={id} />
			</defs>
			<g transform="translate(0 -44)">
				<ellipse className="studio-shadow" cx="100" cy="144" rx="88" ry="6.5" />
				<Furniture id={id} item="mug" />
				<g className="studio-fishbowl">
					<path
						className="bowl-water"
						d="M137.2 100 H162.8 C164.6 106.6 163.4 113.4 158.4 117.8 H141.6 C136.6 113.4 135.4 106.6 137.2 100 Z"
					/>
					<g className="bowl-fish">
						<g className="bowl-fish-turn">
							<path className="fish-body" d="M146 108 c2.4 -3.2 6.8 -3.2 9.2 0 c-2.4 3.2 -6.8 3.2 -9.2 0 z" />
							<path className="fish-body" d="M146.6 108 l-3.6 -2.8 v5.6 z" />
							<circle className="fish-eye" cx="152.8" cy="107.4" r="0.7" />
						</g>
					</g>
					<circle className="bowl-bubble" cx="156" cy="104" r="1" />
					<circle className="bowl-bubble" cx="153" cy="102" r="0.7" style={{ animationDelay: "1.1s" }} />
					<path className="bowl-glass" d="M141 93.4 C134 99 133.6 111 141.6 117.8 H158.4 C166.4 111 166 99 159 93.4" />
					<path className="bowl-rim" d="M139.4 93 H160.6" />
					<path className="bowl-glint" d="M140.4 101 a12 12 0 0 0 2.4 10" />
				</g>
			</g>
		</svg>
	);
}
