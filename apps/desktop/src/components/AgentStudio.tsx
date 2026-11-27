import { agentRuntimeLabel, sessionTitle } from "@pier/chat-state";
import { DEFAULT_AGENT_RUNTIME, type SessionSummary, type SubagentInfo, type WorkspaceInfo } from "@pier/protocol";
import {
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { catLook, type SkyPhase, sessionActivity, skyPhase, studioActivity } from "../lib/agent-activity.ts";
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
import {
	type ClockHands,
	DeskCat,
	type DeskMood,
	EmptyDesk,
	LoungeCat,
	type LoungeMood,
	MiniCat,
} from "./StudioCat.tsx";

/** How long a cat that just finished stays at its desk to cheer before it goes to rest. */
const CHEER_MS = 4500;
/** Cats shown in the lounge at most, the most recently active first. */
const LOUNGE_MAX = 8;
/** Subagent helpers drawn next to a desk at most; the rest are counted. */
const HELPERS_MAX = 3;

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

/** The time shown by the studio's windows and wall clocks; they follow the real one. */
interface StudioTime {
	sky: SkyPhase;
	clock: ClockHands;
}

function useStudioTime(): StudioTime {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const minutes = now.getMinutes();
	return {
		sky: skyPhase(now.getHours()),
		clock: { hour: ((now.getHours() % 12) + minutes / 60) * 30, minute: minutes * 6 },
	};
}

/**
 * The cats look at the pointer. Every cat (`svg[data-gaze]`, the attribute being where its head is in
 * its box) gets `--gaze-x` and `--gaze-y`, from -1 to 1, which the stylesheet turns into a tilt of the
 * head and a shift of the eyes; they ease back when the pointer leaves the page.
 */
function useGaze(root: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const page = root.current;
		if (!page) return;
		let frame = 0;
		let point: { x: number; y: number } | undefined;
		const apply = () => {
			frame = 0;
			const cats = [...page.querySelectorAll<SVGSVGElement>("svg[data-gaze]")];
			// Every box is read before any style is written, so the layout is computed once.
			const boxes = cats.map((cat) => cat.getBoundingClientRect());
			for (const [i, cat] of cats.entries()) {
				const box = boxes[i];
				if (!point || !box?.width) {
					cat.style.removeProperty("--gaze-x");
					cat.style.removeProperty("--gaze-y");
					continue;
				}
				const [fx = 0.5, fy = 0.5] = (cat.dataset.gaze ?? "").split(" ").map(Number);
				const dx = point.x - (box.left + box.width * fx);
				const dy = point.y - (box.top + box.height * fy);
				// Nearby, the eyes turn only as far as the pointer is; far away, all the way toward it.
				const reach = Math.max(Math.hypot(dx, dy), box.width * 0.4);
				cat.style.setProperty("--gaze-x", (dx / reach).toFixed(3));
				cat.style.setProperty("--gaze-y", (dy / reach).toFixed(3));
			}
		};
		const schedule = () => {
			frame ||= requestAnimationFrame(apply);
		};
		const move = (event: PointerEvent) => {
			point = { x: event.clientX, y: event.clientY };
			schedule();
		};
		const leave = () => {
			point = undefined;
			schedule();
		};
		page.addEventListener("pointermove", move);
		page.addEventListener("pointerleave", leave);
		return () => {
			page.removeEventListener("pointermove", move);
			page.removeEventListener("pointerleave", leave);
			cancelAnimationFrame(frame);
		};
	}, [root]);
}

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
	const time = useStudioTime();
	const page = useRef<HTMLDivElement>(null);
	useGaze(page);
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
		<div className="studio-page" ref={page}>
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
							desks.map((agent, index) => (
								<Desk
									key={agent.session.id}
									agent={agent}
									cheering={cheering.has(agent.session.id)}
									time={time}
									index={index}
								/>
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
								{lounge.map((agent, index) => (
									<LoungeSpot key={agent.session.id} agent={agent} index={index} />
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

/** Cards come in one after another, the first ones sooner. */
function enterDelay(index: number): string {
	return `${Math.min(index, 10) * 70}ms`;
}

function Desk({
	agent,
	cheering,
	time,
	index,
}: {
	agent: StudioAgent;
	cheering: boolean;
	time: StudioTime;
	index: number;
}) {
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
			className={`studio-desk mood-${mood} runtime-${runtime} tint-${look.tint}`}
			style={{ "--cat-phase": `-${look.phase}s`, "--enter-delay": enterDelay(index) } as CSSProperties}
			onClick={() => store.selectSession(agent.session)}
			title={`${sessionTitle(agent.session, { full: true })} · ${location}`}
			aria-label={`${look.name}（${runtimeLabel}）${label}${detail ? `：${detail}` : ""}。会话：${title}，${location}`}
		>
			<span className="studio-room">
				<span className="studio-bubble" key={`${mood}:${label}`}>
					{MoodIcon ? <MoodIcon size={13} className={mood === "working" ? "spin" : undefined} /> : null}
					<span className="studio-bubble-label">{label}</span>
					{detail ? <span className="studio-bubble-detail">{detail}</span> : null}
				</span>
				<span className="studio-scene">
					<DeskCat mood={mood} look={look} runtime={runtime} sky={time.sky} clock={time.clock} />
					{helpers.length ? <Helpers helpers={helpers} /> : null}
				</span>
			</span>
			<span className="studio-info">
				<span className="studio-plate">
					<span className="studio-nick">{look.name}</span>
					<span className={`session-agent agent-${runtime} studio-agent-badge`}>
						<AgentIcon runtime={runtime} size={11} />
						{runtimeLabel}
					</span>
				</span>
				<span className="studio-title">{title}</span>
				<span className="studio-location">{model ? `${location} · ${model}` : location}</span>
			</span>
		</button>
	);
}

function LoungeSpot({ agent, index }: { agent: StudioAgent; index: number }) {
	const store = useStore();
	const chat = store.liveChat(agent.session.id)?.chat;
	const activity = studioActivity(chat, agent.session);
	// The pointer (or the keyboard focus) wakes a sleeping cat.
	const [noticed, setNoticed] = useState(false);
	const mood: LoungeMood = activity.mood === "error" ? "upset" : noticed ? "awake" : "asleep";
	const look = catLook(agent.session.id);
	const runtime = agent.session.runtime ?? DEFAULT_AGENT_RUNTIME;
	const title = sessionTitle(agent.session);
	return (
		<button
			type="button"
			className={`studio-spot runtime-${runtime} tint-${look.tint}`}
			style={{ "--cat-phase": `-${look.phase}s`, "--enter-delay": enterDelay(index) } as CSSProperties}
			onClick={() => store.selectSession(agent.session)}
			onPointerEnter={() => setNoticed(true)}
			onPointerLeave={() => setNoticed(false)}
			onFocus={() => setNoticed(true)}
			onBlur={() => setNoticed(false)}
			title={`${sessionTitle(agent.session, { full: true })} · ${locationText(agent, (node) => store.nodeName(node))}${
				activity.detail ? `\n${activity.label}：${activity.detail}` : ""
			}`}
			aria-label={`${look.name}（${agentRuntimeLabel(runtime)}）${activity.label}。会话：${title}`}
		>
			<span className="studio-scene">
				<LoungeCat mood={mood} look={look} />
			</span>
			<span className="studio-spot-text">
				<span className="studio-nick">
					<AgentIcon runtime={runtime} size={12} />
					{look.name}
				</span>
				<span className="studio-title">{title}</span>
				<span className="studio-location">
					{mood === "upset" ? "上次出错了 · " : ""}
					{relativeTime(agent.session.modifiedAt)}
				</span>
			</span>
		</button>
	);
}

/** Subagents the agent started, as kittens hopping on the floor beside its desk. */
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
