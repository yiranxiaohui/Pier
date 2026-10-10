import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { type BrowserCommand, BrowserCommandSchema, type BrowserResult } from "@pier/protocol";
import { Type } from "typebox";

/** Uses the dedicated browser the user opened for this workspace; normal Pier tool approvals apply. */
export function createBrowserExtension(
	run: (command: BrowserCommand, browserId?: string, signal?: AbortSignal) => Promise<BrowserResult>,
): InlineExtension {
	return {
		name: "pier-browser",
		factory: (pi) => {
			pi.registerTool({
				name: "pier_browser",
				label: "浏览器",
				description:
					"Operate the local-rendered browser the user opened from the workspace browser button. Browser pages render on the client computer and use the workspace host network when configured. Actions: tabs lists tabId values; navigate requires url; snapshot reads text and controls; click/fill require a CSS selector; fill requires text; press requires key; evaluate requires expression; screenshot returns an image. No browser is opened automatically.",
				parameters: Type.Object({
					action: Type.Union(
						["tabs", "navigate", "snapshot", "click", "fill", "press", "evaluate", "screenshot"].map((a) =>
							Type.Literal(a),
						),
					),
					browserId: Type.Optional(Type.String()),
					tabId: Type.Optional(Type.String()),
					url: Type.Optional(Type.String()),
					selector: Type.Optional(Type.String()),
					text: Type.Optional(Type.String()),
					key: Type.Optional(Type.String()),
					expression: Type.Optional(Type.String()),
				}),
				execute: async (_id, params, signal) => {
					const result = await run(BrowserCommandSchema.parse(params), params.browserId, signal);
					return {
						content: [
							...(result.text ? [{ type: "text" as const, text: result.text }] : []),
							...(result.image ? [{ type: "image" as const, ...result.image }] : []),
						],
						details: {},
					};
				},
			});
		},
	};
}
