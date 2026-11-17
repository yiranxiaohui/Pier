import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconX } from "./Icons.tsx";

/** Full-size view of an image. Closes on a backdrop click, Esc or the close button. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Esc is handled on window.
		<div className="lightbox" onClick={(e) => e.target === e.currentTarget && onClose()}>
			<img src={src} alt={alt} />
			<button type="button" className="ghost icon lightbox-close" onClick={onClose} title="关闭（Esc）">
				<IconX size={18} />
			</button>
		</div>,
		document.body,
	);
}

/** A thumbnail that opens the full-size image in a lightbox. */
export function ImageThumb({ src, alt }: { src: string; alt: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" className="message-image" onClick={() => setOpen(true)} title="查看大图">
				<img src={src} alt={alt} />
			</button>
			{open ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
		</>
	);
}
