/**
 * What the workspace browser adds to a message: an element picked on the page and/or a
 * marked-up screenshot, described as plain text the Agent can read (`Draft.contexts`). The
 * screenshot itself travels as an ordinary image attachment.
 */
import type { BrowserElement } from "@pier/protocol";
import type { DraftContext } from "./store.tsx";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The text sent for a draft: what the user typed, then its contexts (so the message, and a title
 * made from it, starts with the user's words).
 */
export function promptWithContexts(text: string, contexts: readonly DraftContext[] | undefined): string {
	const blocks = (contexts ?? []).map((context) => context.text.trim()).filter(Boolean);
	if (!blocks.length) return text;
	return text ? `${text}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
}

export type MessagePart =
	| { type: "text"; text: string }
	| { type: "context"; kind: DraftContext["kind"]; label: string; note?: string | undefined; text: string };

const BLOCK = /<(browser-element|browser-screenshot)>\n([\s\S]*?)\n<\/\1>/g;

/** A sent message split into its text and the browser picks in it, for a compact transcript. */
export function splitMessageContexts(message: string): MessagePart[] {
	const parts: MessagePart[] = [];
	let last = 0;
	for (const match of message.matchAll(BLOCK)) {
		const index = match.index ?? 0;
		const before = message.slice(last, index).trim();
		if (before) parts.push({ type: "text", text: before });
		const body = match[2] ?? "";
		const line = (key: string) => body.match(new RegExp(`^${key}：(.*)$`, "m"))?.[1]?.trim();
		const element = match[1] === "browser-element";
		const note = line("说明");
		parts.push({
			type: "context",
			kind: element ? "element" : "screenshot",
			label: element
				? (line("元素")?.split("，")[0] ?? "元素")
				: /截取的/.test(line("截图") ?? "")
					? "区域截图"
					: "页面截图",
			...(note ? { note } : {}),
			text: match[0],
		});
		last = index + match[0].length;
	}
	const rest = message.slice(last).trim();
	if (rest) parts.push({ type: "text", text: rest });
	return parts;
}

/** A Markdown code fence longer than any run of backticks in `text`. */
function fence(text: string, language: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const marks = "`".repeat(Math.max(3, longest + 1));
	return `${marks}${language}\n${text}\n${marks}`;
}

const round = (value: number) => Math.round(value);

function oneLine(text: string, limit: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

export interface BrowserSelection {
	page: { url: string; title: string };
	element?: BrowserElement | undefined;
	/** A screenshot of the visible page goes with it. */
	screenshot?:
		| {
				/** The screenshot's size, in its pixels. */
				size: { width: number; height: number };
				/** The marked region, in the screenshot's pixels; the image is cut to it. */
				region?: Rect | undefined;
				/** The user drew on it. */
				drawn: boolean;
				/** The element's own screenshot (no region or drawing). */
				elementOnly?: boolean;
		  }
		| undefined;
	note?: string | undefined;
}

/** The chip and the Agent's text for what was picked in the browser. */
export function selectionContext(selection: BrowserSelection, id: string): DraftContext {
	const { page, element, screenshot } = selection;
	const note = selection.note?.trim() || undefined;
	const lines: string[] = [`页面：${page.title ? `${page.title}（${page.url}）` : page.url}`];
	if (element) {
		const { x, y, width, height } = element.rect;
		lines.push(`元素：${element.label}，${round(width)}×${round(height)}，位于视口 (${round(x)}, ${round(y)})`);
		lines.push(`选择器：${element.selector}`);
		if (element.text) lines.push(`文本：${oneLine(element.text, 500)}`);
		lines.push(`HTML：\n${fence(element.html, "html")}`);
	}
	if (screenshot) {
		if (screenshot.elementOnly) lines.push("截图：见附图（该元素的截图）");
		else {
			const { size, region } = screenshot;
			const where = region
				? `从页面可见区域的 ${size.width}×${size.height} 截图中截取的 (${round(region.x)}, ${round(region.y)}) 起 ${round(region.width)}×${round(region.height)} 部分`
				: `页面可见区域，${size.width}×${size.height}`;
			lines.push(`截图：见附图（${where}${screenshot.drawn ? "，红色笔迹是标注" : ""}）`);
		}
	}
	if (note) lines.push(`说明：${note}`);
	const tag = element ? "browser-element" : "browser-screenshot";
	return {
		id,
		kind: element ? "element" : "screenshot",
		label: element ? element.label : screenshot?.region ? "区域截图" : "页面截图",
		...(note ? { note } : {}),
		text: `<${tag}>\n${lines.join("\n")}\n</${tag}>`,
	};
}

/**
 * Normalize what is typed into the address bar: a URL as is, `localhost:3000` or a host name
 * with `http(s)://` added, anything else as a web search.
 */
export function addressToUrl(input: string): string | undefined {
	const text = input.trim();
	if (!text) return undefined;
	if (/^https?:\/\//i.test(text)) {
		try {
			return new URL(text).href;
		} catch {
			return undefined;
		}
	}
	if (/^about:blank$/i.test(text)) return undefined;
	const host = text.split(/[/?#]/)[0] ?? "";
	// localhost, an IP address or a bare host name with a port (a development server) go over HTTP.
	const plain =
		/^(localhost|\[[\da-f:]+\])(:\d+)?$/i.test(host) ||
		/^\d{1,3}(?:\.\d{1,3}){3}(:\d+)?$/.test(host) ||
		/^[\w-]+:\d+$/.test(host);
	const domain = /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(host);
	if ((plain || domain) && !/\s/.test(text)) {
		try {
			return new URL(`${plain ? "http" : "https"}://${text}`).href;
		} catch {
			return undefined;
		}
	}
	return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

/** What the address bar shows for a page: nothing for an empty one. */
export function displayUrl(url: string | undefined): string {
	return !url || url === "about:blank" ? "" : url;
}
