import { type ReactNode, useState } from "react";
import { MAX_ZOOM, MIN_ZOOM, zoomLabel } from "../lib/document-preview.ts";
import { IconChevronDown, IconChevronUp, IconMinus, IconPlus } from "./Icons.tsx";

/** The bar above a PDF or Word document in the preview (PdfPreview, DocxPreview). */
export function DocumentToolbar({ children }: { children: ReactNode }) {
	return <div className="document-toolbar">{children}</div>;
}

/** Previous / next page and the current page, which can be typed to jump there. */
export function PageNavigator({
	page,
	pages,
	onGo,
}: {
	page: number;
	/** Undefined until the document has loaded. */
	pages: number | undefined;
	onGo: (page: number) => void;
}) {
	/** What is being typed into the page box; it shows the current page otherwise. */
	const [draft, setDraft] = useState<string>();
	const shown = draft ?? String(page);
	return (
		<span className="document-pages">
			<button
				type="button"
				className="ghost icon"
				title="上一页"
				disabled={!pages || page <= 1}
				onClick={() => onGo(page - 1)}
			>
				<IconChevronUp size={14} />
			</button>
			<button
				type="button"
				className="ghost icon"
				title="下一页"
				disabled={!pages || page >= pages}
				onClick={() => onGo(page + 1)}
			>
				<IconChevronDown size={14} />
			</button>
			<input
				className="document-page-input"
				aria-label="页码"
				inputMode="numeric"
				disabled={!pages}
				value={shown}
				onFocus={(event) => event.currentTarget.select()}
				onChange={(event) => setDraft(event.target.value.replace(/\D/g, "").slice(0, 6))}
				onBlur={() => setDraft(undefined)}
				onKeyDown={(event) => {
					if (event.key !== "Enter") return;
					const target = Number(shown);
					if (target > 0) onGo(target);
					setDraft(undefined);
				}}
			/>
			<span className="document-page-count">/ {pages ?? "–"}</span>
		</span>
	);
}

export interface ZoomPreset {
	label: string;
	title: string;
	active: boolean;
	onSelect: () => void;
}

/** Zoom out / in by steps around the current zoom, plus the viewer's fitting presets. */
export function ZoomControls({
	scale,
	disabled,
	onZoom,
	presets,
}: {
	scale: number;
	disabled: boolean;
	onZoom: (direction: 1 | -1) => void;
	presets: ZoomPreset[];
}) {
	return (
		<span className="document-zoom">
			<button
				type="button"
				className="ghost icon"
				title="缩小（Ctrl / ⌘ + 滚轮）"
				disabled={disabled || scale <= MIN_ZOOM}
				onClick={() => onZoom(-1)}
			>
				<IconMinus size={14} />
			</button>
			<span className="document-zoom-value">{zoomLabel(scale)}</span>
			<button
				type="button"
				className="ghost icon"
				title="放大（Ctrl / ⌘ + 滚轮）"
				disabled={disabled || scale >= MAX_ZOOM}
				onClick={() => onZoom(1)}
			>
				<IconPlus size={14} />
			</button>
			<span className="segmented">
				{presets.map((preset) => (
					<button
						key={preset.label}
						type="button"
						className={preset.active ? "active" : ""}
						title={preset.title}
						aria-pressed={preset.active}
						disabled={disabled}
						onClick={preset.onSelect}
					>
						{preset.label}
					</button>
				))}
			</span>
		</span>
	);
}
