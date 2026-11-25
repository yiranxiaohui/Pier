import type { BrowserImage } from "@pier/protocol";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { Rect } from "../lib/browser-context.ts";

export type AnnotationTool = "select" | "region" | "draw" | "erase";

/** A freehand mark on the screenshot, in its pixels. */
export interface Stroke {
	points: Array<{ x: number; y: number }>;
	width: number;
}

export const STROKE_COLOR = "#ef4444";
/** On screen, whatever the screenshot's scale. */
const STROKE_PX = 3;
const ERASER_PX = 10;
const MIN_REGION_PX = 6;

/** Where the screenshot shows inside the layer: scaled to fit, centred like the live view. */
function fit(box: { width: number; height: number }, image: { width: number; height: number }) {
	const scale = Math.min(box.width / image.width, box.height / image.height) || 1;
	const width = image.width * scale;
	const height = image.height * scale;
	return { scale, left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

function strokePath(stroke: Stroke): string {
	const [first, ...rest] = stroke.points;
	if (!first) return "";
	// A dot for a single click.
	if (!rest.length) return `M${first.x} ${first.y}l0.01 0`;
	return `M${first.x} ${first.y}${rest.map((p) => `L${p.x} ${p.y}`).join("")}`;
}

function near(stroke: Stroke, point: { x: number; y: number }, radius: number): boolean {
	const limit = (radius + stroke.width / 2) ** 2;
	return stroke.points.some((p, i) => {
		const prev = stroke.points[i - 1] ?? p;
		// Distance to the segment from the previous point.
		const dx = p.x - prev.x;
		const dy = p.y - prev.y;
		const length = dx * dx + dy * dy;
		const t = length ? Math.max(0, Math.min(1, ((point.x - prev.x) * dx + (point.y - prev.y) * dy) / length)) : 0;
		const x = prev.x + t * dx - point.x;
		const y = prev.y + t * dy - point.y;
		return x * x + y * y <= limit;
	});
}

/**
 * The frozen screenshot of the page for the region, draw and erase tools: drag a rectangle to
 * keep only that part, draw over it in red, rub marks out. Coordinates are the screenshot's own.
 */
export function BrowserAnnotator({
	shot,
	tool,
	region,
	strokes,
	onRegion,
	onStrokes,
}: {
	shot: BrowserImage;
	tool: Exclude<AnnotationTool, "select">;
	region?: Rect | undefined;
	strokes: Stroke[];
	onRegion(region: Rect | undefined): void;
	onStrokes(strokes: Stroke[]): void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [box, setBox] = useState({ width: 0, height: 0 });
	const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } }>();
	const [drawing, setDrawing] = useState<Stroke>();
	const pointer = useRef<number | undefined>(undefined);
	useEffect(() => {
		const el = root.current;
		if (!el) return;
		const update = () => setBox({ width: el.clientWidth, height: el.clientHeight });
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const placed = fit(box, shot);
	const toImage = (e: ReactPointerEvent) => {
		const rect = root.current?.getBoundingClientRect();
		const x = (e.clientX - (rect?.left ?? 0) - placed.left) / placed.scale;
		const y = (e.clientY - (rect?.top ?? 0) - placed.top) / placed.scale;
		return { x: Math.max(0, Math.min(shot.width, x)), y: Math.max(0, Math.min(shot.height, y)) };
	};
	const erase = (point: { x: number; y: number }, current: Stroke[]) => {
		const kept = current.filter((stroke) => !near(stroke, point, ERASER_PX / placed.scale));
		if (kept.length !== current.length) onStrokes(kept);
		return kept;
	};
	const latest = useRef(strokes);
	latest.current = strokes;

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || !placed.width) return;
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		pointer.current = e.pointerId;
		const point = toImage(e);
		if (tool === "region") setDrag({ from: point, to: point });
		else if (tool === "draw") setDrawing({ points: [point], width: STROKE_PX / placed.scale });
		else latest.current = erase(point, latest.current);
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (pointer.current !== e.pointerId) return;
		const point = toImage(e);
		if (tool === "region") setDrag((d) => (d ? { ...d, to: point } : d));
		else if (tool === "draw")
			setDrawing((stroke) => {
				const last = stroke?.points[stroke.points.length - 1];
				// Skip points closer than a pixel on screen.
				if (!stroke || (last && Math.hypot(last.x - point.x, last.y - point.y) * placed.scale < 1.5)) return stroke;
				return { ...stroke, points: [...stroke.points, point] };
			});
		else latest.current = erase(point, latest.current);
	};
	const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (pointer.current !== e.pointerId) return;
		pointer.current = undefined;
		if (tool === "region" && drag) {
			const x = Math.min(drag.from.x, drag.to.x);
			const y = Math.min(drag.from.y, drag.to.y);
			const width = Math.abs(drag.to.x - drag.from.x);
			const height = Math.abs(drag.to.y - drag.from.y);
			// A click without dragging clears the region.
			onRegion(
				width * placed.scale < MIN_REGION_PX || height * placed.scale < MIN_REGION_PX
					? undefined
					: { x, y, width, height },
			);
			setDrag(undefined);
		} else if (tool === "draw" && drawing) {
			onStrokes([...latest.current, drawing]);
			setDrawing(undefined);
		}
	};

	const shown =
		drag !== undefined
			? {
					x: Math.min(drag.from.x, drag.to.x),
					y: Math.min(drag.from.y, drag.to.y),
					width: Math.abs(drag.to.x - drag.from.x),
					height: Math.abs(drag.to.y - drag.from.y),
				}
			: region;
	const all = drawing ? [...strokes, drawing] : strokes;
	return (
		<div
			ref={root}
			className={`browser-annotator tool-${tool}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		>
			{placed.width ? (
				<svg
					className="browser-annotator-canvas"
					style={{ left: placed.left, top: placed.top, width: placed.width, height: placed.height }}
					viewBox={`0 0 ${shot.width} ${shot.height}`}
					aria-hidden="true"
				>
					<image href={`data:${shot.mimeType};base64,${shot.data}`} width={shot.width} height={shot.height} />
					{all.map((stroke, i) => (
						<path
							// biome-ignore lint/suspicious/noArrayIndexKey: strokes are only appended or removed.
							key={i}
							d={strokePath(stroke)}
							fill="none"
							stroke={STROKE_COLOR}
							strokeWidth={stroke.width}
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					))}
					{shown ? (
						<>
							<path
								className="browser-annotator-dim"
								fillRule="evenodd"
								d={`M0 0H${shot.width}V${shot.height}H0Z M${shown.x} ${shown.y}h${shown.width}v${shown.height}h${-shown.width}Z`}
							/>
							<rect
								className="browser-annotator-region"
								x={shown.x}
								y={shown.y}
								width={shown.width}
								height={shown.height}
								strokeWidth={1.5 / placed.scale}
								strokeDasharray={`${5 / placed.scale} ${4 / placed.scale}`}
							/>
						</>
					) : null}
				</svg>
			) : null}
		</div>
	);
}

/** The screenshot with its marks, cut to the region: an image for the composer. */
export async function renderAnnotated(
	shot: BrowserImage,
	strokes: Stroke[],
	region: Rect | undefined,
): Promise<{ data: string; mimeType: string }> {
	const image = new Image();
	image.src = `data:${shot.mimeType};base64,${shot.data}`;
	await image.decode();
	const crop = region ?? { x: 0, y: 0, width: shot.width, height: shot.height };
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(crop.width));
	canvas.height = Math.max(1, Math.round(crop.height));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("无法生成截图");
	context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
	context.translate(-crop.x, -crop.y);
	context.strokeStyle = STROKE_COLOR;
	context.lineCap = "round";
	context.lineJoin = "round";
	for (const stroke of strokes) {
		const [first, ...rest] = stroke.points;
		if (!first) continue;
		context.lineWidth = stroke.width;
		context.beginPath();
		context.moveTo(first.x, first.y);
		if (!rest.length) context.lineTo(first.x + 0.01, first.y);
		for (const p of rest) context.lineTo(p.x, p.y);
		context.stroke();
	}
	let url = canvas.toDataURL("image/png");
	let mimeType = "image/png";
	// Keep large captures small enough for the model's request.
	if (url.length > 6_000_000) {
		url = canvas.toDataURL("image/jpeg", 0.9);
		mimeType = "image/jpeg";
	}
	return { data: url.slice(url.indexOf(",") + 1), mimeType };
}
