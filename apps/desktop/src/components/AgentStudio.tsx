import { agentRuntimeLabel, sessionTitle } from "@pier/chat-state";
import {
	type AgentRuntimeId,
	DEFAULT_AGENT_RUNTIME,
	type SessionSummary,
	type SubagentInfo,
	type WorkspaceInfo,
} from "@pier/protocol";
import { type ComponentType, type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { type CatAccessory, catLook, type StudioMood, sessionActivity, studioActivity } from "../lib/agent-activity.ts";
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
				<CatFigure mood={mood} accessory={look.accessory} runtime={runtime} seat="desk" />
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
				<CatFigure mood={mood} accessory={look.accessory} runtime={runtime} seat="cushion" />
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
			<path className="cat-fill" d="M8 16 L9 3 L17 9 Z M32 16 L31 3 L23 9 Z" strokeLinejoin="round" strokeWidth="3" />
			<ellipse className="cat-fill" cx="20" cy="22" rx="14" ry="12" />
			<ellipse className="cat-ink" cx="15" cy="21" rx="1.8" ry="2.2" />
			<ellipse className="cat-ink" cx="25" cy="21" rx="1.8" ry="2.2" />
			<ellipse className="cat-cheek" cx="12" cy="25" rx="2.6" ry="1.5" />
			<ellipse className="cat-cheek" cx="28" cy="25" rx="2.6" ry="1.5" />
			<path className="cat-line" d="M17.5 25.5 q1.25 1.4 2.5 0 q1.25 1.4 2.5 0" />
		</svg>
	);
}

function Eyes({ mood }: { mood: DeskMood }) {
	switch (mood) {
		case "resting":
			return (
				<g className="cat-eyes">
					<path className="cat-line thick" d="M80 75 q6 5 12 0" />
					<path className="cat-line thick" d="M108 75 q6 5 12 0" />
				</g>
			);
		case "done":
			return (
				<g className="cat-eyes">
					<path className="cat-line thick" d="M80 77 q6 -7 12 0" />
					<path className="cat-line thick" d="M108 77 q6 -7 12 0" />
				</g>
			);
		case "error":
			return (
				<g className="cat-eyes">
					<path className="cat-line thick" d="M81 70 l9 5 l-9 5" />
					<path className="cat-line thick" d="M119 70 l-9 5 l9 5" />
				</g>
			);
		default:
			return (
				<g className="cat-eyes">
					<g className="cat-eye">
						<ellipse className="cat-ink" cx="86" cy="74" rx="5.2" ry="6.4" />
						<circle className="cat-shine" cx="88" cy="71.5" r="1.9" />
					</g>
					<g className="cat-eye">
						<ellipse className="cat-ink" cx="114" cy="74" rx="5.2" ry="6.4" />
						<circle className="cat-shine" cx="116" cy="71.5" r="1.9" />
					</g>
				</g>
			);
	}
}

function Mouth({ mood }: { mood: DeskMood }) {
	switch (mood) {
		case "waiting":
			return <ellipse className="cat-ink" cx="100" cy="88" rx="2.6" ry="3.2" />;
		case "done":
			return <path className="cat-mouth-open" d="M93 85 q7 9 14 0 z" />;
		case "error":
			return <path className="cat-line" d="M93 88 q3.5 -3 7 0 q3.5 3 7 0" />;
		default:
			return <path className="cat-line" d="M94 85 q3 3 6 0 q3 3 6 0" />;
	}
}

function Accessory({ kind }: { kind: CatAccessory }) {
	switch (kind) {
		case "sprout":
			return (
				<g className="cat-accessory sprout">
					<path className="acc-stem" d="M100 48 q0 -8 0 -12" />
					<path className="acc-leaf" d="M100 38 q-10 -6 -14 2 q8 4 14 -2 Z" />
					<path className="acc-leaf" d="M100 36 q9 -9 15 -2 q-7 6 -15 2 Z" />
				</g>
			);
		case "bow":
			return (
				<g className="cat-accessory bow">
					<path className="acc-bow" d="M120 46 l-11 -7 v14 Z M120 46 l11 -7 v14 Z" />
					<circle className="acc-bow-knot" cx="120" cy="46" r="3.4" />
				</g>
			);
		case "headphones":
			return (
				<g className="cat-accessory headphones">
					<path className="acc-band" d="M62 74 C60 40 140 40 138 74" />
					<rect className="acc-cup" x="54" y="66" width="12" height="18" rx="5" />
					<rect className="acc-cup" x="134" y="66" width="12" height="18" rx="5" />
				</g>
			);
		case "glasses":
			return (
				<g className="cat-accessory glasses">
					<circle className="acc-frame" cx="86" cy="74" r="9.5" />
					<circle className="acc-frame" cx="114" cy="74" r="9.5" />
					<path className="acc-frame" d="M95.5 73 q4.5 -3 9 0" />
				</g>
			);
		case "flower":
			return (
				<g className="cat-accessory flower">
					{[0, 72, 144, 216, 288].map((angle) => (
						<circle
							key={angle}
							className="acc-petal"
							cx={124 + 5 * Math.cos((angle * Math.PI) / 180)}
							cy={44 + 5 * Math.sin((angle * Math.PI) / 180)}
							r="3.6"
						/>
					))}
					<circle className="acc-center" cx="124" cy="44" r="2.8" />
				</g>
			);
		case "cap":
			return (
				<g className="cat-accessory cap">
					<path className="acc-cap" d="M78 52 C80 36 120 36 122 52 Z" />
					<path className="acc-brim" d="M116 50 q14 -1 18 4 q-8 3 -20 1 Z" />
					<circle className="acc-cap-button" cx="100" cy="39.5" r="2.4" />
				</g>
			);
		default:
			return null;
	}
}

/**
 * A cat at its desk (behind a laptop) or curled on a cushion in the lounge. CSS animates it by the
 * `mood-*` class of the desk and colours it by the `runtime-*` class; the agent's mark is on the laptop.
 */
function CatFigure({
	mood,
	accessory,
	runtime,
	seat,
}: {
	mood: DeskMood;
	accessory: CatAccessory;
	runtime: AgentRuntimeId;
	seat: "desk" | "cushion";
}) {
	const desk = seat === "desk";
	return (
		<svg viewBox="0 0 200 150" className={`studio-cat seat-${seat}`} aria-hidden="true">
			<ellipse className="studio-shadow" cx="100" cy="141" rx={desk ? 80 : 64} ry="7" />
			{desk ? null : <ellipse className="studio-cushion" cx="100" cy="126" rx="62" ry="16" />}
			<path
				className="cat-tail cat-stroke"
				d={desk ? "M134 110 C154 106 160 88 152 72" : "M140 122 C160 124 164 108 152 100"}
			/>
			<g className="cat-body">
				<path className="cat-fill cat-ear" d="M66 60 L70 32 L91 47 Z" />
				<path className="cat-fill cat-ear" d="M134 60 L130 32 L109 47 Z" />
				<path className="cat-ear-inner" d="M71 54 L73 39 L84 47 Z" />
				<path className="cat-ear-inner" d="M129 54 L127 39 L116 47 Z" />
				<path className="cat-fill" d="M56 120 C54 84 70 46 100 46 C130 46 146 84 144 120 Z" />
				<ellipse className="cat-belly" cx="100" cy="112" rx="26" ry="14" />
				<ellipse className="cat-cheek" cx="75" cy="84" rx="6.5" ry="3.8" />
				<ellipse className="cat-cheek" cx="125" cy="84" rx="6.5" ry="3.8" />
				<path className="cat-whisker" d="M70 80 l-14 -2 M70 85 l-14 2 M130 80 l14 -2 M130 85 l14 2" />
				<Eyes mood={mood} />
				<path className="cat-nose" d="M97 80.5 h6 l-3 3.2 z" />
				<Mouth mood={mood} />
				<Accessory kind={accessory} />
			</g>
			{desk ? (
				<g className="studio-furniture">
					<ellipse className="studio-screen-glow" cx="100" cy="98" rx="34" ry="11" />
					<rect className="studio-desk-top" x="26" y="116" width="148" height="10" rx="5" />
					<rect className="studio-desk-front" x="36" y="126" width="128" height="14" rx="3" />
					<rect className="studio-laptop" x="77" y="93" width="46" height="24" rx="4" />
					{/* The agent's own mark on the lid, where a laptop maker's logo would be. */}
					<g className="studio-laptop-mark" transform="translate(92.5 97.5)">
						<AgentIcon runtime={runtime} size={15} />
					</g>
					<rect className="studio-laptop-base" x="70" y="114.5" width="60" height="4" rx="2" />
					<g className="cat-paws">
						<ellipse className="cat-fill cat-paw left" cx="66" cy="116" rx="9.5" ry="6.5" />
						<ellipse className="cat-fill cat-paw right" cx="134" cy="116" rx="9.5" ry="6.5" />
					</g>
					<g className="cat-wave">
						<path className="cat-stroke" d="M136 104 C146 96 150 82 146 72" />
						<circle className="cat-fill" cx="146" cy="68" r="7.5" />
					</g>
				</g>
			) : (
				<g className="cat-paws">
					<ellipse className="cat-fill cat-paw left" cx="84" cy="121" rx="10" ry="6" />
					<ellipse className="cat-fill cat-paw right" cx="116" cy="121" rx="10" ry="6" />
				</g>
			)}
		</svg>
	);
}

/** The empty floor: a desk with nobody at it. */
function EmptyDesk() {
	return (
		<svg viewBox="0 0 200 150" className="studio-cat seat-desk studio-empty-desk" aria-hidden="true">
			<ellipse className="studio-shadow" cx="100" cy="141" rx="80" ry="7" />
			<rect className="studio-desk-top" x="26" y="116" width="148" height="10" rx="5" />
			<rect className="studio-desk-front" x="36" y="126" width="128" height="14" rx="3" />
			<rect className="studio-laptop" x="77" y="93" width="46" height="24" rx="4" />
			<circle className="studio-laptop-logo" cx="100" cy="105" r="3.6" />
			<rect className="studio-laptop-base" x="70" y="114.5" width="60" height="4" rx="2" />
			<path className="studio-mug" d="M140 100 h14 v14 a3 3 0 0 1 -3 3 h-8 a3 3 0 0 1 -3 -3 Z" />
			<path className="studio-mug-handle" d="M154 104 a4 4 0 0 1 0 8" />
			<path className="studio-steam" d="M144 96 q-3 -5 0 -10 M150 96 q-3 -5 0 -10" />
		</svg>
	);
}
