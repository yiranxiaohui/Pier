/**
 * Every `title` shows as a small pill (see .tooltip in overlays.css) instead of the WebView's native
 * tooltip, so components keep writing plain `title` attributes. While the pointer is over an element
 * its `title` is moved aside, which keeps the native tooltip from opening too, and is put back when
 * the pointer leaves, so assistive technology still reads it.
 */

/** How long the pointer rests on an element before its tooltip opens. */
const SHOW_DELAY_MS = 300;
/** Moving on to the next element this soon after a tooltip closed opens its tooltip at once. */
const SKIP_DELAY_MS = 300;
/** Distance from the element, and the least distance from the window's edges. */
const GAP = 6;
const MARGIN = 8;

export function installTooltips(): void {
	const tip = document.createElement("div");
	tip.className = "tooltip";
	tip.setAttribute("role", "tooltip");
	document.body.appendChild(tip);

	let target: Element | undefined;
	let text = "";
	let timer: number | undefined;
	let closedAt = 0;
	/** Clicked, typed on or scrolled: no tooltip until the pointer has left it. */
	let dismissed: Element | undefined;

	// React sets `title` again when its text changes while the pointer is still there: take the new text.
	const observer = new MutationObserver(() => {
		const next = target?.getAttribute("title");
		if (!target || next == null) return;
		text = next;
		target.removeAttribute("title");
		if (tip.classList.contains("open")) place();
	});

	function place(): void {
		if (!target?.isConnected || !text.trim()) {
			hide();
			return;
		}
		tip.textContent = text;
		const box = target.getBoundingClientRect();
		const width = tip.offsetWidth;
		const height = tip.offsetHeight;
		// Below the element, or above it when the window's bottom edge is too close.
		let top = box.bottom + GAP;
		if (top + height > window.innerHeight - MARGIN) top = box.top - GAP - height;
		const left = Math.min(Math.max(MARGIN, box.left + box.width / 2 - width / 2), window.innerWidth - MARGIN - width);
		tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
		tip.classList.add("open");
	}

	function hide(): void {
		window.clearTimeout(timer);
		if (tip.classList.contains("open")) closedAt = performance.now();
		tip.classList.remove("open");
		observer.disconnect();
		if (target && !target.hasAttribute("title")) target.setAttribute("title", text);
		target = undefined;
	}

	function dismiss(): void {
		dismissed = target;
		hide();
	}

	document.addEventListener("pointerover", (event) => {
		const over = event.target instanceof Element ? event.target : undefined;
		// Moving within the element (onto its icon, say) keeps its tooltip.
		if (!over || target?.contains(over) || dismissed?.contains(over)) return;
		hide();
		const element = over.closest("[title]");
		// An iframe's title names the frame for assistive technology; there is nothing to point at.
		if (!element || element.tagName === "IFRAME") return;
		const title = element.getAttribute("title") ?? "";
		if (!title.trim()) return;
		target = element;
		text = title;
		element.removeAttribute("title");
		observer.observe(element, { attributes: true, attributeFilter: ["title"] });
		const quick = performance.now() - closedAt < SKIP_DELAY_MS;
		timer = window.setTimeout(place, quick ? 0 : SHOW_DELAY_MS);
	});
	document.addEventListener("pointerout", (event) => {
		const to = event.relatedTarget instanceof Node ? event.relatedTarget : undefined;
		if (dismissed && !(to && dismissed.contains(to))) dismissed = undefined;
		if (target && !(to && target.contains(to))) hide();
	});
	// Acting on the element, scrolling or leaving the window closes the tooltip.
	for (const type of ["pointerdown", "keydown", "wheel"] as const) {
		document.addEventListener(type, dismiss, { capture: true, passive: true });
	}
	window.addEventListener("blur", hide);
}
