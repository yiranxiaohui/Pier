import { type MouseEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../lib/store.tsx";
import { ContextMenu, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import { IconCopy, IconDownload, IconX } from "./Icons.tsx";

/** The right-click menu of a chat image (`src` is a data URL): copy or save it. */
function useImageMenu(src: string) {
	const store = useStore();
	const [position, setPosition] = useState<ContextMenuPosition>();
	const onContextMenu = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		setPosition(contextMenuPosition(event));
	};
	const menu = position ? (
		<ContextMenu
			position={position}
			label="图片"
			stayOnScroll
			items={[
				{ label: "复制图片", icon: <IconCopy size={14} />, onSelect: () => void store.copyImage(src) },
				{ label: "保存图片…", icon: <IconDownload size={14} />, onSelect: () => void store.saveImage(src) },
			]}
			onClose={() => setPosition(undefined)}
		/>
	) : null;
	return { onContextMenu, menu };
}

/** Full-size view of an image. Closes on a backdrop click, Esc or the close button. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
	const store = useStore();
	const { onContextMenu, menu } = useImageMenu(src);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(
		<>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Esc is handled on window. */}
			<div className="lightbox" onClick={(e) => e.target === e.currentTarget && onClose()}>
				<img src={src} alt={alt} onContextMenu={onContextMenu} />
				<div className="lightbox-actions">
					<button type="button" className="ghost icon" onClick={() => void store.copyImage(src)} title="复制图片">
						<IconCopy size={17} />
					</button>
					<button type="button" className="ghost icon" onClick={() => void store.saveImage(src)} title="保存图片…">
						<IconDownload size={17} />
					</button>
					<button type="button" className="ghost icon" onClick={onClose} title="关闭（Esc）">
						<IconX size={18} />
					</button>
				</div>
			</div>
			{menu}
		</>,
		document.body,
	);
}

/** A thumbnail that opens the full-size image in a lightbox; right-click copies or saves it. */
export function ImageThumb({ src, alt }: { src: string; alt: string }) {
	const [open, setOpen] = useState(false);
	const { onContextMenu, menu } = useImageMenu(src);
	return (
		<>
			<button
				type="button"
				className="message-image"
				onClick={() => setOpen(true)}
				onContextMenu={onContextMenu}
				title="查看大图，右键可复制或保存"
			>
				<img src={src} alt={alt} />
			</button>
			{open ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
			{menu}
		</>
	);
}
