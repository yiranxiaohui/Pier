import { agentRuntimeLabel, sessionTitle } from "@pier/chat-state";
import {
	type AgentRuntimeId,
	DEFAULT_AGENT_RUNTIME,
	type SessionSummary,
	type SubagentInfo,
	type WorkspaceInfo,
} from "@pier/protocol";
import { type ComponentType, type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
	type CatAccessory,
	type CatCoat,
	type CatLook,
	catLook,
	type DeskItem,
	type StudioMood,
	sessionActivity,
	studioActivity,
} from "../lib/agent-activity.ts";
import { relativeTime } from "../lib/format.ts";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { AgentIcon } from "./AgentIcons.tsx";
import {
	IconAlert,
	IconBrain,
	IconCat,
	IconFile,
	IconFilePen,
	IconGlobe,
	IconLayers,
	IconLoader,
	IconMessage,
	IconNetwork,
	IconRefresh,
	IconSearch,
	IconShieldAlert,
	IconSparkles,
	IconSquarePen,
	IconTerminal,
	IconWrench,
} from "./Icons.tsx";

/** How long a cat that just finished stays at its desk to cheer before it goes to rest. */
const CHEER_MS = 4500;
/** Cats shown in the lounge at most, the most recently active first. */
const LOUNGE_MAX = 8;
/** Subagent helpers drawn next to a desk at most; the rest are counted. */
const HELPERS_MAX = 3;

/** What a desk shows: what the agent does, or the cheer (or sigh) right after it finished. */
type DeskMood = StudioMood | "done";

interface StudioAgent {
	session: SessionSummary;
	workspace: WorkspaceInfo;
	node: string;
}

const MOOD_ICON: Partial<Record<DeskMood, ComponentType<{ size?: number; className?: string }>>> = {
	thinking: IconBrain,
	writing: IconMessage,
	reading: IconFile,
	searching: IconSearch,
	editing: IconFilePen,
	command: IconTerminal,
	browsing: IconGlobe,
	delegating: IconNetwork,
	tool: IconWrench,
	waiting: IconShieldAlert,
	compacting: IconLayers,
	retrying: IconRefresh,
	working: IconLoader,
	error: IconAlert,
	done: IconSparkles,
};

/** Little things that float up from the laptop, by mood. */
const FLOATERS: Partial<Record<DeskMood, ReactNode[]>> = {
	writing: ["文", "A", "…"],
	editing: ["</>", "{ }", ";"],
	command: [">_", "$", "&&"],
	tool: ["⚙", "✦", "⚙"],
	reading: [<IconFile key="a" size={13} />, "¶", <IconFile key="b" size={13} />],
	searching: [<IconSearch key="a" size={13} />, "?", <IconSearch key="b" size={13} />],
	browsing: [<IconGlobe key="a" size={13} />, "www", <IconGlobe key="b" size={13} />],
	compacting: [<IconLayers key="a" size={13} />, "≡", <IconLayers key="b" size={13} />],
	resting: ["z", "Z", "z"],
};

/** Agents on connected computers: busy ones at their desks (oldest first, so desks do not swap), the others resting. */
function useStudioAgents(): { busy: StudioAgent[]; resting: StudioAgent[]; waiting: number } {
	const store = useStore();
	const workspaces = useAppState((s) => s.workspaces);
	const sessions = useAppState((s) => s.sessions);
	const nodes = useAppState((s) => s.nodes);
	const workspaceNodes = useAppState((s) => s.workspaceNodes);
	useAppState((s) => s.chatsVersion);
	const busy: StudioAgent[] = [];
	const resting: StudioAgent[] = [];
	let waiting = 0;
	for (const workspace of workspaces) {
		const node = workspaceNodes[workspace.id] ?? LOCAL_NODE;
		if (nodes[node]?.connection !== "open") continue;
		for (const session of sessions[workspace.id] ?? []) {
			const activity = sessionActivity(store, session);
			if (activity.pending) waiting++;
			if (activity.active) busy.push({ session, workspace, node });
			else if (session.active) resting.push({ session, workspace, node });
		}
	}
	busy.sort(
		(a, b) => a.session.createdAt.localeCompare(b.session.createdAt) || a.session.id.localeCompare(b.session.id),
	);
	resting.sort((a, b) => b.session.modifiedAt.localeCompare(a.session.modifiedAt));
	return { busy, resting: resting.slice(0, LOUNGE_MAX), waiting };
}

/** Whether an agent waits for an answer somewhere, for the navigation rail's badge. */
export function useStudioAttention(): boolean {
	const store = useStore();
	const workspaces = useAppState((s) => s.workspaces);
	const sessions = useAppState((s) => s.sessions);
	const nodes = useAppState((s) => s.nodes);
	const workspaceNodes = useAppState((s) => s.workspaceNodes);
	useAppState((s) => s.chatsVersion);
	return workspaces.some(
		(workspace) =>
			nodes[workspaceNodes[workspace.id] ?? LOCAL_NODE]?.connection === "open" &&
			(sessions[workspace.id] ?? []).some((session) => sessionActivity(store, session).pending > 0),
	);
}

/**
 * Agents that just finished, kept at their desks for a moment to cheer. A run counts as finished
 * when its session leaves the busy list while its computer stays connected and still lists it.
 */
function useCheers(busy: StudioAgent[]): StudioAgent[] {
	const store = useStore();
	const [cheers, setCheers] = useState<StudioAgent[]>([]);
	const previous = useRef<StudioAgent[]>([]);
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	const busyKey = busy.map((agent) => agent.session.id).join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the busy list changes (`busyKey`).
	useEffect(() => {
		const ids = new Set(busy.map((agent) => agent.session.id));
		const state = store.getState();
		const finished = previous.current.filter(
			(agent) =>
				!ids.has(agent.session.id) &&
				state.nodes[agent.node]?.connection === "open" &&
				store.findSession(agent.session.id) !== undefined,
		);
		previous.current = busy;
		if (!finished.length) return;
		const done = new Set(finished.map((agent) => agent.session.id));
		setCheers((list) => [...list.filter((agent) => !done.has(agent.session.id)), ...finished]);
		const timer = setTimeout(() => {
			timers.current.delete(timer);
			setCheers((list) => list.filter((agent) => !done.has(agent.session.id)));
		}, CHEER_MS);
		timers.current.add(timer);
	}, [store, busyKey]);
	useEffect(() => {
		const pending = timers.current;
		return () => {
			for (const timer of pending) clearTimeout(timer);
		};
	}, []);
	// A session that starts again leaves the cheer at once.
	return cheers.filter((agent) => !busy.some((b) => b.session.id === agent.session.id));
}

export function AgentStudioPage({ footer }: { footer?: ReactNode } = {}) {
	const store = useStore();
	const { busy, resting, waiting } = useStudioAgents();
	const cheers = useCheers(busy);
	const busyKey = busy.map((agent) => agent.session.id).join("\n");

	// Follow the busy sessions, so their desks show the tool, file or command of the moment.
	useEffect(() => {
		for (const id of busyKey ? busyKey.split("\n") : []) {
			const session = store.findSession(id);
			if (session) store.chat(session);
		}
	}, [store, busyKey]);

	const cheering = new Set(cheers.map((agent) => agent.session.id));
	const desks = [...busy, ...cheers];
	const lounge = resting.filter((agent) => !cheering.has(agent.session.id));
	// An agent waiting for an answer counts as waiting, not busy.
	const working = Math.max(busy.length - waiting, 0);

	return (
		<div className="studio-page">
			<div className="studio-scroll">
				<div className="studio-content">
					<header className="studio-header">
						<div className="studio-heading">
							<h2>
								<IconCat size={20} />
								Agent 工作室
							</h2>
							<p>每只小猫是一个 Agent，看看它们正在忙什么；点一下就进入那个会话</p>
						</div>
						<div className="studio-stats">
							<span className={`studio-stat busy${working > 0 ? " on" : ""}`}>
								<span className="studio-stat-dot" />
								忙碌 {working}
							</span>
							<span className={`studio-stat waiting${waiting ? " on" : ""}`}>
								<span className="studio-stat-dot" />
								等你处理 {waiting}
							</span>
							<span className="studio-stat resting">
								<span className="studio-stat-dot" />
								休息 {lounge.length}
							</span>
						</div>
					</header>

					<section className="studio-floor" aria-label="工位">
						{desks.length ? (
							desks.map((agent) => (
								<Desk key={agent.session.id} agent={agent} cheering={cheering.has(agent.session.id)} />
							))
						) : (
							<div className="studio-empty">
								<EmptyDesk />
								<div className="studio-empty-text">
									<strong>工位空着，大家都在摸鱼～</strong>
									<span>派个任务给它们，小猫就会来上班</span>
								</div>
								<button
									type="button"
									className="studio-empty-button"
									onClick={() => {
										store.closeSettings();
										store.startNewChat();
									}}
								>
									<IconSquarePen size={14} />
									新建会话
								</button>
							</div>
						)}
					</section>

					{lounge.length ? (
						<section className="studio-lounge" aria-label="休息区">
							<h3>休息区</h3>
							<div className="studio-lounge-grid">
								{lounge.map((agent) => (
									<LoungeSpot key={agent.session.id} agent={agent} />
								))}
							</div>
						</section>
					) : null}
				</div>
			</div>
			{footer}
		</div>
	);
}

function locationText(agent: StudioAgent, nodeName: (node: string) => string): string {
	return agent.node === LOCAL_NODE ? agent.workspace.name : `${agent.workspace.name} · ${nodeName(agent.node)}`;
}

function Desk({ agent, cheering }: { agent: StudioAgent; cheering: boolean }) {
	const store = useStore();
	useAppState((s) => s.chatsVersion);
	const chat = store.liveChat(agent.session.id)?.chat;
	const activity = studioActivity(chat, agent.session);
	const mood: DeskMood = cheering ? (activity.mood === "error" ? "error" : "done") : activity.mood;
	const label = mood === "done" ? "搞定啦！" : activity.label;
	const detail = mood === "done" ? undefined : activity.detail;
	const look = catLook(agent.session.id);
	const runtime = agent.session.runtime ?? DEFAULT_AGENT_RUNTIME;
	const runtimeLabel = agentRuntimeLabel(runtime);
	const helpers = chat ? Object.values(chat.subagents).filter((s) => s.status === "running") : [];
	const title = sessionTitle(agent.session);
	const location = locationText(agent, (node) => store.nodeName(node));
	const model = chat?.model?.name;
	const MoodIcon = MOOD_ICON[mood];
	return (
		<button
			type="button"
			className={`studio-desk mood-${mood} runtime-${runtime}`}
			style={{ "--cat-phase": `-${look.phase}s` } as CSSProperties}
			onClick={() => store.selectSession(agent.session)}
			title={`${sessionTitle(agent.session, { full: true })} · ${location}`}
			aria-label={`${look.name}（${runtimeLabel}）${label}${detail ? `：${detail}` : ""}。会话：${title}，${location}`}
		>
			<span className="studio-bubble" key={`${mood}:${label}`}>
				{MoodIcon ? <MoodIcon size={13} className={mood === "working" ? "spin" : undefined} /> : null}
				<span className="studio-bubble-label">{label}</span>
				{detail ? <span className="studio-bubble-detail">{detail}</span> : null}
			</span>
			<span className="studio-scene">
				<CatFigure mood={mood} look={look} runtime={runtime} seat="desk" />
				<Floaters mood={mood} />
				{mood === "thinking" ? <ThoughtCloud /> : null}
				{mood === "waiting" ? <span className="studio-alert">!</span> : null}
				{mood === "error" ? <span className="studio-sweat" /> : null}
				{mood === "done" ? <Confetti /> : null}
				{helpers.length ? <Helpers helpers={helpers} /> : null}
			</span>
			<span className="studio-plate">
				<span className="studio-nick">{look.name}</span>
				<span className={`session-agent agent-${runtime} studio-agent-badge`}>
					<AgentIcon runtime={runtime} size={11} />
					{runtimeLabel}
				</span>
			</span>
			<span className="studio-title">{title}</span>
			<span className="studio-location">{model ? `${location} · ${model}` : location}</span>
		</button>
	);
}

function LoungeSpot({ agent }: { agent: StudioAgent }) {
	const store = useStore();
	const chat = store.liveChat(agent.session.id)?.chat;
	const activity = studioActivity(chat, agent.session);
	const mood: DeskMood = activity.mood === "error" ? "error" : "resting";
	const look = catLook(agent.session.id);
	const runtime = agent.session.runtime ?? DEFAULT_AGENT_RUNTIME;
	const title = sessionTitle(agent.session);
	return (
		<button
			type="button"
			className={`studio-spot mood-${mood} runtime-${runtime}`}
			style={{ "--cat-phase": `-${look.phase}s` } as CSSProperties}
			onClick={() => store.selectSession(agent.session)}
			title={`${sessionTitle(agent.session, { full: true })} · ${locationText(agent, (node) => store.nodeName(node))}${
				activity.detail ? `\n${activity.label}：${activity.detail}` : ""
			}`}
			aria-label={`${look.name}（${agentRuntimeLabel(runtime)}）${activity.label}。会话：${title}`}
		>
			<span className="studio-scene">
				<CatFigure mood={mood} look={look} runtime={runtime} seat="cushion" />
				<Floaters mood={mood} />
			</span>
			<span className="studio-spot-text">
				<span className="studio-nick">
					<AgentIcon runtime={runtime} size={12} />
					{look.name}
				</span>
				<span className="studio-title">{title}</span>
				<span className="studio-location">
					{mood === "error" ? "上次出错了 · " : ""}
					{relativeTime(agent.session.modifiedAt)}
				</span>
			</span>
		</button>
	);
}

function Floaters({ mood }: { mood: DeskMood }) {
	const items = FLOATERS[mood];
	if (!items) return null;
	return (
		<span className="studio-floaters" aria-hidden="true">
			{items.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list per mood.
				<span key={i} className={`studio-floater f${i}`}>
					{item}
				</span>
			))}
		</span>
	);
}

function ThoughtCloud() {
	return (
		<span className="studio-thought" aria-hidden="true">
			<span className="studio-thought-trail" />
			<span className="studio-thought-cloud">
				<i />
				<i />
				<i />
			</span>
		</span>
	);
}

const CONFETTI = [
	{ x: -70, r: 200, c: "#ff8fa3", d: 0 },
	{ x: -48, r: -160, c: "#ffd36e", d: 0.15 },
	{ x: -24, r: 260, c: "#7fd8cc", d: 0.05 },
	{ x: -6, r: -220, c: "#93b8f7", d: 0.25 },
	{ x: 14, r: 180, c: "#f5a3c4", d: 0.1 },
	{ x: 34, r: -250, c: "#ffd36e", d: 0.3 },
	{ x: 52, r: 210, c: "#7fd8cc", d: 0.2 },
	{ x: 72, r: -190, c: "#ff8fa3", d: 0.05 },
];

function Confetti() {
	return (
		<span className="studio-confetti" aria-hidden="true">
			{CONFETTI.map((piece) => (
				<i
					key={piece.x}
					style={
						{
							"--x": `${piece.x}px`,
							"--r": `${piece.r}deg`,
							"--c": piece.c,
							animationDelay: `${piece.d}s`,
						} as CSSProperties
					}
				/>
			))}
		</span>
	);
}

/** Subagents the agent started, as small cats hopping next to its desk. */
function Helpers({ helpers }: { helpers: SubagentInfo[] }) {
	const shown = helpers.slice(0, HELPERS_MAX);
	const more = helpers.length - shown.length;
	return (
		<span className="studio-helpers">
			{shown.map((helper, i) => (
				<span
					key={helper.id}
					className={`studio-helper h${i}`}
					title={`Subagent · ${helper.name}${helper.activity ? ` · ${helper.activity}` : helper.description ? ` · ${helper.description}` : ""}`}
				>
					<MiniCat />
				</span>
			))}
			{more > 0 ? <span className="studio-helper-more">+{more}</span> : null}
		</span>
	);
}

function MiniCat() {
	return (
		<svg viewBox="0 0 40 36" width="30" height="27" aria-hidden="true" className="studio-minicat">
			<path className="cat-fill" d="M7 15 C6 9 7 4 10 2.5 C12 2 15 5 18 8.5 Z" />
			<path className="cat-fill" d="M33 15 C34 9 33 4 30 2.5 C28 2 25 5 22 8.5 Z" />
			<ellipse className="cat-fill" cx="20" cy="20" rx="15" ry="12.5" />
			<ellipse className="cat-muzzle" cx="20" cy="25" rx="5.5" ry="3.6" />
			<ellipse className="cat-cheek-mini" cx="10.5" cy="23.5" rx="2.6" ry="1.6" />
			<ellipse className="cat-cheek-mini" cx="29.5" cy="23.5" rx="2.6" ry="1.6" />
			<ellipse className="cat-ink" cx="14.5" cy="19.5" rx="2.2" ry="2.6" />
			<ellipse className="cat-ink" cx="25.5" cy="19.5" rx="2.2" ry="2.6" />
			<circle className="cat-shine" cx="15.3" cy="18.6" r="0.85" />
			<circle className="cat-shine" cx="26.3" cy="18.6" r="0.85" />
			<path className="cat-line thin" d="M18 24.4 q1 1.2 2 0 q1 1.2 2 0" />
		</svg>
	);
}

function Eyes({ mood }: { mood: DeskMood }) {
	switch (mood) {
		case "resting":
			return (
				<g className="cat-eyes">
					<path className="cat-line thick" d="M78 78 q6 5 12 0" />
					<path className="cat-line thick" d="M110 78 q6 5 12 0" />
				</g>
			);
		case "done":
			return (
				<g className="cat-eyes">
					<path className="cat-line thick" d="M78 80 q6 -7 12 0" />
					<path className="cat-line thick" d="M110 80 q6 -7 12 0" />
				</g>
			);
		case "error":
			return (
				<g className="cat-eyes">
					<path className="cat-line thick" d="M79.5 72.5 l8.5 4.5 l-8.5 4.5" />
					<path className="cat-line thick" d="M120.5 72.5 l-8.5 4.5 l8.5 4.5" />
				</g>
			);
		default:
			return (
				<g className="cat-eyes">
					<g className="cat-eye">
						<ellipse className="cat-ink" cx="84" cy="77" rx="6.1" ry="7.3" />
						<circle className="cat-shine" cx="86.3" cy="74.2" r="2.4" />
						<circle className="cat-shine" cx="82.3" cy="80" r="1.1" />
					</g>
					<g className="cat-eye">
						<ellipse className="cat-ink" cx="116" cy="77" rx="6.1" ry="7.3" />
						<circle className="cat-shine" cx="118.3" cy="74.2" r="2.4" />
						<circle className="cat-shine" cx="114.3" cy="80" r="1.1" />
					</g>
				</g>
			);
	}
}

function Mouth({ mood }: { mood: DeskMood }) {
	switch (mood) {
		case "waiting":
			return <ellipse className="cat-mouth-open" cx="100" cy="92" rx="2.4" ry="3" />;
		case "done":
			return (
				<g>
					<path className="cat-mouth-open" d="M94.5 89.5 q5.5 8.5 11 0 z" />
					<ellipse className="cat-tongue" cx="100" cy="93.6" rx="2.6" ry="1.5" />
				</g>
			);
		case "error":
			return <path className="cat-line" d="M94.5 92.5 q2.75 -2.6 5.5 0 q2.75 2.6 5.5 0" />;
		default:
			return <path className="cat-line" d="M100 88 v1 M95.6 89 q2.2 2.6 4.4 0 q2.2 2.6 4.4 0" />;
	}
}

function Accessory({ kind }: { kind: CatAccessory }) {
	switch (kind) {
		case "sprout":
			return (
				<g className="cat-accessory sprout">
					<path className="acc-stem" d="M100 41 q0 -6 0 -10" />
					<path className="acc-leaf" d="M100 33 q-10 -6 -14 2 q8 4 14 -2 Z" />
					<path className="acc-leaf" d="M100 31 q9 -9 15 -2 q-7 6 -15 2 Z" />
				</g>
			);
		case "bow":
			return (
				<g className="cat-accessory bow">
					<path className="acc-bow" d="M121 44 l-10 -6.5 v13 Z M121 44 l10 -6.5 v13 Z" />
					<circle className="acc-bow-knot" cx="121" cy="44" r="3.2" />
				</g>
			);
		case "headphones":
			return (
				<g className="cat-accessory headphones">
					<path className="acc-band" d="M62 78 C59 29 141 29 138 78" />
					<rect className="acc-cup" x="53" y="68" width="12" height="19" rx="5" />
					<rect className="acc-cup" x="135" y="68" width="12" height="19" rx="5" />
				</g>
			);
		case "glasses":
			return (
				<g className="cat-accessory glasses">
					<circle className="acc-frame" cx="84" cy="77" r="10" />
					<circle className="acc-frame" cx="116" cy="77" r="10" />
					<path className="acc-frame" d="M94 76 q6 -3.5 12 0 M74 75 l-12 -3 M126 75 l12 -3" />
				</g>
			);
		case "flower":
			return (
				<g className="cat-accessory flower">
					{[0, 72, 144, 216, 288].map((angle) => (
						<circle
							key={angle}
							className="acc-petal"
							cx={127 + 5 * Math.cos((angle * Math.PI) / 180)}
							cy={47 + 5 * Math.sin((angle * Math.PI) / 180)}
							r="3.6"
						/>
					))}
					<circle className="acc-center" cx="127" cy="47" r="2.8" />
				</g>
			);
		case "cap":
			return (
				<g className="cat-accessory cap">
					<path className="acc-cap" d="M74 54 C75 33 125 33 126 54 C116 50 84 50 74 54 Z" />
					<path className="acc-brim" d="M118 52 q15 -2 20 3.5 q-9 3.5 -22 1 Z" />
					<circle className="acc-cap-button" cx="100" cy="37.5" r="2.4" />
				</g>
			);
		default:
			return null;
	}
}

/** The coat's markings, on top of the head: stripes, an eye patch, or a white blaze. */
function Markings({ coat }: { coat: CatCoat }) {
	switch (coat) {
		case "tabby":
			return (
				<path
					className="cat-stripes"
					d="M100 44.5 v8 M91.5 46 l2 7 M108.5 46 l-2 7 M61.5 70 h6 M61 76 h5.5 M138.5 70 h-6 M139 76 h-5.5"
				/>
			);
		case "patch":
			return <ellipse className="cat-dark-fill" cx="117" cy="69" rx="14" ry="12.5" transform="rotate(-12 117 69)" />;
		case "tuxedo":
			return (
				<path
					className="cat-light-fill"
					d="M96.5 58 C97.5 67 96.5 76 92 83 L108 83 C103.5 76 102.5 67 103.5 58 Q100 55.5 96.5 58 Z"
				/>
			);
		default:
			return null;
	}
}

/** A paw resting on the desk or the cushion, with its toes drawn. */
function Paw({ x, y, side }: { x: number; y: number; side: "left" | "right" }) {
	return (
		<g className={`cat-paw ${side}`}>
			<ellipse className="cat-fill cat-paw-pad" cx={x} cy={y} rx="9.5" ry="6.2" />
			<path className="cat-toe" d={`M${x - 3.5} ${y - 1.6} v2.6 M${x + 3.5} ${y - 1.6} v2.6`} />
		</g>
	);
}

/** The desk, its laptop (the agent's mark on the lid, or a light on an empty desk) and an item beside it. */
function Furniture({ runtime, item }: { runtime?: AgentRuntimeId; item: DeskItem }) {
	return (
		<>
			<ellipse className="studio-screen-glow" cx="100" cy="99" rx="30" ry="9" />
			<rect className="studio-desk-top" x="22" y="118" width="156" height="9" rx="4.5" />
			<rect className="studio-desk-shine" x="27" y="119.2" width="146" height="1.8" rx="0.9" />
			<rect className="studio-desk-front" x="32" y="127" width="136" height="14" rx="3" />
			<rect className="studio-desk-handle" x="91" y="132" width="18" height="3" rx="1.5" />
			{item === "mug" ? (
				<g className="studio-mug-item">
					<path className="studio-steam" d="M38.5 100 q-2.5 -4 0 -8 M44 100 q-2.5 -4 0 -8" />
					<path className="studio-mug" d="M34 104 h14 v11 a3 3 0 0 1 -3 3 h-8 a3 3 0 0 1 -3 -3 Z" />
					<path className="studio-mug-handle" d="M48 107 a3.5 3.5 0 0 1 0 7" />
					<rect className="studio-mug-band" x="34" y="108" width="14" height="2.4" />
				</g>
			) : item === "plant" ? (
				<g className="studio-plant">
					<path className="studio-plant-leaf" d="M41 108 C37 101 32 99 30 92 C37 93 41 99 41 108 Z" />
					<path className="studio-plant-leaf" d="M41 108 C43 99 47 95 52 93 C51 100 46 104 41 108 Z" />
					<path className="studio-plant-leaf" d="M41 108 C39 100 40 94 42 88 C45 94 44 101 41 108 Z" />
					<path className="studio-plant-pot" d="M33 107 h16 l-2 11 h-12 Z" />
					<rect className="studio-plant-rim" x="32" y="105.5" width="18" height="3.5" rx="1.5" />
				</g>
			) : null}
			<rect className="studio-laptop" x="76" y="97" width="48" height="21" rx="3.5" />
			<rect className="studio-laptop-shine" x="78.5" y="98.4" width="43" height="1.6" rx="0.8" />
			{runtime ? (
				// The agent's own mark on the lid, where a laptop maker's logo would be.
				<g className="studio-laptop-mark" transform="translate(92.5 100)">
					<AgentIcon runtime={runtime} size={15} />
				</g>
			) : (
				<circle className="studio-laptop-logo" cx="100" cy="107.5" r="3.4" />
			)}
			<rect className="studio-laptop-base" x="68" y="116" width="64" height="3.6" rx="1.8" />
		</>
	);
}

/**
 * A cat at its desk (behind a laptop) or curled on a cushion in the lounge. CSS animates it by the
 * `mood-*` class of the desk and colours it by the `runtime-*` class; the agent's mark is on the laptop.
 */
function CatFigure({
	mood,
	look,
	runtime,
	seat,
}: {
	mood: DeskMood;
	look: CatLook;
	runtime: AgentRuntimeId;
	seat: "desk" | "cushion";
}) {
	const id = useId().replace(/[^\w-]/g, "");
	const desk = seat === "desk";
	const tail = desk ? "M128 115 C150 118 165 105 160 88" : "M128 124 C150 128 162 114 152 102";
	const blush = `url(#${id}-blush)`;
	return (
		<svg viewBox="0 0 200 150" className={`studio-cat seat-${seat} coat-${look.coat}`} aria-hidden="true">
			<defs>
				<radialGradient id={`${id}-blush`}>
					<stop offset="0" className="cat-blush-core" />
					<stop offset="1" className="cat-blush-edge" />
				</radialGradient>
			</defs>
			<ellipse className="studio-shadow" cx="100" cy="142" rx={desk ? 82 : 64} ry="6.5" />
			{desk ? null : (
				<>
					<ellipse className="studio-cushion" cx="100" cy="127" rx="62" ry="16" />
					<ellipse className="studio-cushion-shine" cx="88" cy="120" rx="34" ry="5" />
				</>
			)}
			<g className="cat-tail">
				<path className="cat-tail-line" d={tail} />
				<path className="cat-tail-fur" d={tail} />
				{look.coat === "tabby" ? <path className="cat-tail-stripes" d={tail} /> : null}
			</g>
			<g className="cat-body">
				<path className="cat-fill" d="M70 130 C70 110 82 101 100 101 C118 101 130 110 130 130 Z" />
				{look.coat === "tuxedo" ? (
					<path className="cat-light-fill" d="M87 130 C87 114 93 107 100 107 C107 107 113 114 113 130 Z" />
				) : null}
				<path className="cat-fill cat-ear left" d="M64 60 C61 45 63 33 69 28.5 C73 26.5 83 33 92 42.5 Z" />
				<path className="cat-fill cat-ear right" d="M136 60 C139 45 137 33 131 28.5 C127 26.5 117 33 108 42.5 Z" />
				<path className="cat-ear-inner" d="M68.5 53 C67.5 44 68.5 37 71 34 C73.5 33 79 37 84.5 42.5 Z" />
				<path className="cat-ear-inner" d="M131.5 53 C132.5 44 131.5 37 129 34 C126.5 33 121 37 115.5 42.5 Z" />
				<path
					className="cat-fill"
					d="M60 76 C60 53 78 40 100 40 C122 40 140 53 140 76 C140 95 122 105 100 105 C78 105 60 95 60 76 Z"
				/>
				<Markings coat={look.coat} />
				<path
					className="cat-shade"
					d="M64 86 C72 99 87 104.5 100 104.5 C113 104.5 128 99 136 86 C127 96 114 100.5 100 100.5 C86 100.5 73 96 64 86 Z"
				/>
				<ellipse className="cat-shine-soft" cx="80" cy="52" rx="11" ry="4.8" transform="rotate(-24 80 52)" />
				<ellipse className="cat-muzzle" cx="100" cy="89" rx={look.coat === "tuxedo" ? 15 : 12.5} ry="8" />
				<ellipse cx="73.5" cy="86" rx="7.5" ry="4.6" fill={blush} />
				<ellipse cx="126.5" cy="86" rx="7.5" ry="4.6" fill={blush} />
				<path
					className="cat-whisker"
					d="M60.5 81.5 l-10 -2.2 M61 86.5 l-10 1.2 M139.5 81.5 l10 -2.2 M139 86.5 l10 1.2"
				/>
				<Eyes mood={mood} />
				<path
					className="cat-nose"
					d="M97.3 84 h5.4 c1 0 1.4 1 .7 1.6 l-2.3 2 c-.6 .5 -1.5 .5 -2.1 0 l-2.3 -2 c-.7 -.6 -.3 -1.6 .7 -1.6 z"
				/>
				<Mouth mood={mood} />
				<Accessory kind={look.accessory} />
			</g>
			{desk ? (
				<>
					<Furniture runtime={runtime} item={look.deskItem} />
					<Paw x={69} y={118} side="left" />
					<Paw x={131} y={118} side="right" />
					<g className="cat-wave">
						<path className="cat-limb-line" d="M126 104 C137 98 145 82 147 66" />
						<path className="cat-limb-fur" d="M126 104 C137 98 145 82 147 66" />
						<ellipse className="cat-fill cat-paw-pad" cx="147.5" cy="60" rx="7.6" ry="7.2" />
						<path className="cat-toe" d="M144.6 57.8 v3 M150.4 57.8 v3" />
					</g>
				</>
			) : (
				<>
					<Paw x={85} y={122} side="left" />
					<Paw x={115} y={122} side="right" />
				</>
			)}
		</svg>
	);
}

/** The empty floor: a desk with nobody at it, and a mug of something warm. */
function EmptyDesk() {
	return (
		<svg viewBox="0 0 200 150" className="studio-cat seat-desk studio-empty-desk" aria-hidden="true">
			<ellipse className="studio-shadow" cx="100" cy="142" rx="82" ry="6.5" />
			<Furniture item="mug" />
		</svg>
	);
}
