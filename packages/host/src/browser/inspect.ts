/** What the panel's element picker runs in a page through CDP (see `ChromiumBrowser.control`). */

/** DevTools' inspector colours, in the blue of a selection. */
export const HIGHLIGHT = {
	showInfo: true,
	showStyles: false,
	showRulers: false,
	showAccessibilityInfo: false,
	showExtensionLines: false,
	contentColor: { r: 59, g: 130, b: 246, a: 0.24 },
	paddingColor: { r: 59, g: 130, b: 246, a: 0.12 },
	borderColor: { r: 37, g: 99, b: 235, a: 0.95 },
	marginColor: { r: 245, g: 158, b: 11, a: 0.14 },
};

export const TEXT_LIMIT = 2000;
export const HTML_LIMIT = 6000;

/** What `DESCRIBE` returns, before the screenshot of the element is added. */
export interface DescribedElement {
	url: string;
	title: string;
	label: string;
	selector: string;
	tag: string;
	text: string;
	html: string;
	rect: { x: number; y: number; width: number; height: number };
	viewport: { width: number; height: number; scrollX: number; scrollY: number };
}

/**
 * Called on the picked node (`Runtime.callFunctionOn`): its DevTools-style label, a selector
 * that matches only it, its text and HTML (cut), and where it is in the top-level viewport
 * (adding the offsets of same-origin frames it sits in).
 */
export const DESCRIBE = `function () {
	const el = this.nodeType === 1 ? this : this.parentElement;
	if (!el) return null;
	const doc = el.ownerDocument;
	const win = doc.defaultView;
	const esc = (value) => (win.CSS && win.CSS.escape ? win.CSS.escape(value) : String(value).replace(/[^\\w-]/g, (c) => "\\\\" + c));
	const unique = (selector) => {
		try {
			return doc.querySelectorAll(selector).length === 1;
		} catch {
			return false;
		}
	};
	const classes = (e) => Array.from(e.classList).filter((c) => /^[A-Za-z_-][\\w-]*$/.test(c));
	const step = (e) => {
		if (e.id && unique("#" + esc(e.id))) return { part: "#" + esc(e.id), anchored: true };
		let part = e.localName + classes(e).slice(0, 2).map((c) => "." + esc(c)).join("");
		const parent = e.parentElement;
		if (parent) {
			const same = Array.from(parent.children).filter((c) => c.localName === e.localName);
			if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
		}
		return { part, anchored: false };
	};
	let selector = "";
	for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 12; node = node.parentElement, depth++) {
		const { part, anchored } = step(node);
		selector = selector ? part + " > " + selector : part;
		if (anchored || unique(selector)) break;
	}
	const rect = el.getBoundingClientRect();
	let x = rect.x;
	let y = rect.y;
	let top = win;
	try {
		while (top.frameElement) {
			const frame = top.frameElement;
			const r = frame.getBoundingClientRect();
			x += r.x + frame.clientLeft;
			y += r.y + frame.clientTop;
			top = top.parent;
		}
	} catch {}
	const label = el.localName + (el.id ? "#" + el.id : "") + Array.from(el.classList).slice(0, 3).map((c) => "." + c).join("");
	const text = String(el.innerText || el.textContent || "").replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
	const html = el.outerHTML;
	return {
		url: doc.URL,
		title: (top.document && top.document.title) || doc.title,
		label,
		selector,
		tag: el.localName,
		text: text.length > ${TEXT_LIMIT} ? text.slice(0, ${TEXT_LIMIT}) + "…" : text,
		html: html.length > ${HTML_LIMIT} ? html.slice(0, ${HTML_LIMIT}) + "…" : html,
		rect: { x, y, width: rect.width, height: rect.height },
		viewport: { width: top.innerWidth, height: top.innerHeight, scrollX: top.scrollX, scrollY: top.scrollY },
	};
}`;

/** The visible part of an element, as a `Page.captureScreenshot` clip (document coordinates). */
export function visibleClip(
	described: Pick<DescribedElement, "rect" | "viewport">,
): { x: number; y: number; width: number; height: number; scale: 1 } | undefined {
	const { rect, viewport } = described;
	const left = Math.max(0, rect.x);
	const top = Math.max(0, rect.y);
	const right = Math.min(viewport.width, rect.x + rect.width);
	const bottom = Math.min(viewport.height, rect.y + rect.height);
	if (right - left < 1 || bottom - top < 1) return undefined;
	return {
		x: left + viewport.scrollX,
		y: top + viewport.scrollY,
		width: right - left,
		height: bottom - top,
		scale: 1,
	};
}

/** Width and height of a base64 PNG or JPEG, from its header. */
export function imageSize(data: string): { width: number; height: number } {
	const bytes = Buffer.from(data.slice(0, 64 * 1024), "base64");
	if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	// JPEG: walk the segments up to a start-of-frame marker.
	let offset = 2;
	while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
		const marker = bytes[offset + 1] as number;
		const length = bytes.readUInt16BE(offset + 2);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
		}
		offset += 2 + length;
	}
	return { width: 0, height: 0 };
}
