/** Opt-in layout regression: PIER_TEST_BROWSER=/path/to/chrome bun run test apps/desktop/test/composer-images.test.ts */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChromiumBrowser } from "../../../packages/host/src/browser/chromium.ts";

const executable = process.env.PIER_TEST_BROWSER;
const styles = ["tokens", "base", "composer", "newchat"]
	.map((name) => readFileSync(new URL(`../src/styles/${name}.css`, import.meta.url), "utf8"))
	.join("\n");

interface Rect {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}

interface Layout {
	composer: Rect;
	row: Rect;
	input: Rect;
	clientWidth: number;
	scrollWidth: number;
	images: Array<{ frame: Rect; image: Rect; button: Rect; fit: string; buttonVisible: boolean }>;
}

// Exercise the actual stylesheet in a rendering engine; a DOM mock cannot detect flex overflow.
describe.skipIf(!executable)("composer image layout", () => {
	let browser: ChromiumBrowser | undefined;
	let profile: string | undefined;

	beforeAll(async () => {
		profile = mkdtempSync(join(tmpdir(), "pier-composer-images-"));
		browser = await ChromiumBrowser.start(profile, "about:blank", undefined, () => {}, {
			executable,
			args: ["--headless=new", "--no-sandbox", "--window-size=1200,900"],
		});
	});

	afterAll(async () => {
		await browser?.close();
		if (profile) rmSync(profile, { recursive: true, force: true });
	});

	async function render(width: number, newChat: boolean, sizes: Array<[number, number]>): Promise<Layout> {
		const attachments = sizes
			.map(([width, height]) => {
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`;
				const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
				return `<div class="composer-image"><img src="${src}" alt="test image"><button type="button" title="移除" onclick="this.parentElement.remove()">×</button></div>`;
			})
			.join("");
		// Keep the same attachment/input structure shared by Composer and NewChatView.
		const markup = `<div class="session-bottom${newChat ? " new-chat-bottom" : ""}" style="width:${width}px; margin:20px"><div class="composer"><div class="composer-images">${attachments}</div><div class="composer-input" contenteditable="true">Draft text</div><div class="composer-toolbar"><button type="button">Send</button></div></div></div>`;
		const result = await browser?.action({
			action: "evaluate",
			expression: `(async () => {
				document.head.innerHTML = '<style>' + ${JSON.stringify(styles)} + '</style>';
				document.body.innerHTML = ${JSON.stringify(markup)};
				await Promise.all(Array.from(document.images, image => image.decode()));
				const rect = element => element.getBoundingClientRect().toJSON();
				const composer = document.querySelector('.composer');
				return {
					composer: rect(composer),
					row: rect(document.querySelector('.composer-images')),
					input: rect(document.querySelector('.composer-input')),
					clientWidth: composer.clientWidth,
					scrollWidth: composer.scrollWidth,
					images: Array.from(document.querySelectorAll('.composer-image'), frame => {
						const image = frame.querySelector('img');
						const button = frame.querySelector('button');
						const bounds = button.getBoundingClientRect();
						return { frame: rect(frame), image: rect(image), button: rect(button),
							fit: getComputedStyle(image).objectFit,
							buttonVisible: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === button };
					})
				};
			})()`,
		});
		return JSON.parse(result?.text ?? "null") as Layout;
	}

	function expectContained(layout: Layout) {
		expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
		for (const { frame, image, button, fit, buttonVisible } of layout.images) {
			expect(frame.width).toBeLessThanOrEqual(160);
			expect(frame.left).toBeGreaterThanOrEqual(layout.row.left);
			expect(frame.right).toBeLessThanOrEqual(layout.row.right);
			expect(image.width).toBeLessThanOrEqual(frame.width);
			expect(image.height).toBe(64);
			expect(fit).toBe("contain");
			expect(button.left).toBeGreaterThanOrEqual(layout.composer.left);
			expect(button.right).toBeLessThanOrEqual(layout.composer.right);
			expect(button.top).toBeGreaterThanOrEqual(layout.composer.top);
			expect(button.bottom).toBeLessThanOrEqual(layout.input.top);
			expect(buttonVisible).toBe(true);
		}
		expect(layout.input.top).toBeGreaterThanOrEqual(layout.row.bottom);
	}

	for (const newChat of [false, true]) {
		describe(newChat ? "new chat" : "existing session", () => {
			it.each([900, 360, 240])("contains wide and tall images in a %ipx composer area", async (width) => {
				const layout = await render(width, newChat, [
					[12000, 100],
					[100, 12000],
					[800, 600],
				]);
				expectContained(layout);
				expect(layout.images).toHaveLength(3);
			});

			it("wraps multiple images and keeps their remove buttons clickable", async () => {
				const layout = await render(
					460,
					newChat,
					Array.from({ length: 16 }, () => [12000, 100] as [number, number]),
				);
				expectContained(layout);
				expect(layout.images).toHaveLength(16);
				expect(new Set(layout.images.map(({ frame }) => frame.top)).size).toBeGreaterThan(1);
				await browser?.action({ action: "click", selector: ".composer-image button" });
				const remaining = await browser?.action({
					action: "evaluate",
					expression: "document.querySelectorAll('.composer-image').length",
				});
				expect(remaining?.text).toBe("15");
			});
		});
	}
});
