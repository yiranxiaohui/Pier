import { describe, expect, it } from "vitest";
import {
	acceptLanguage,
	browserLocale,
	cursorKeyword,
	dialogPopup,
	keyEvent,
	macCommands,
	mouseEvent,
	parseSelect,
} from "../src/browser/embed.ts";

describe("the panel's input for a windowless browser", () => {
	it("maps mouse input to the DevTools protocol", () => {
		expect(
			mouseEvent({ type: "mouse", event: "down", x: 10, y: 20, button: "left", buttons: 1, clickCount: 2 }),
		).toEqual({
			type: "mousePressed",
			x: 10,
			y: 20,
			modifiers: 0,
			button: "left",
			buttons: 1,
			clickCount: 2,
		});
		expect(mouseEvent({ type: "mouse", event: "move", x: 1, y: 2, modifiers: 8 })).toMatchObject({
			type: "mouseMoved",
			button: "none",
			clickCount: 0,
			modifiers: 8,
		});
		// The wheel has no button; its deltas are required.
		expect(mouseEvent({ type: "mouse", event: "wheel", x: 1, y: 2, button: "left", deltaY: 120 })).toEqual({
			type: "mouseWheel",
			x: 1,
			y: 2,
			modifiers: 0,
			button: "none",
			buttons: 0,
			clickCount: 0,
			deltaX: 0,
			deltaY: 120,
		});
	});

	it("types characters on keyDown and sends shortcuts as raw keys", () => {
		const a = { type: "key", event: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" } as const;
		expect(keyEvent(a, "win32")).toMatchObject({
			type: "keyDown",
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			text: "a",
			unmodifiedText: "a",
		});
		expect(keyEvent({ ...a, event: "up", text: undefined }, "win32")).toMatchObject({ type: "keyUp" });
		expect(keyEvent({ ...a, text: undefined, modifiers: 2 }, "win32")).not.toHaveProperty("text");
		expect(keyEvent({ ...a, text: undefined, modifiers: 2 }, "win32")).toMatchObject({ type: "rawKeyDown" });
		expect(
			keyEvent({ type: "key", event: "down", key: "1", code: "Numpad1", keyCode: 97, text: "1", location: 3 }),
		).toMatchObject({
			isKeypad: true,
			location: 3,
		});
	});

	it("adds macOS editing commands, which the page cannot run by itself", () => {
		const key = (code: string, modifiers: number) =>
			({ type: "key", event: "down", key: "x", code, keyCode: 0, modifiers }) as const;
		expect(macCommands(key("KeyA", 4))).toEqual(["selectAll"]);
		expect(macCommands(key("KeyZ", 4 | 8))).toEqual(["redo"]);
		expect(macCommands(key("ArrowLeft", 4 | 8))).toEqual(["moveToBeginningOfLineAndModifySelection"]);
		expect(macCommands(key("Backspace", 1))).toEqual(["deleteWordBackward"]);
		expect(macCommands(key("KeyA", 0))).toEqual([]);
		expect(keyEvent(key("KeyC", 4), "darwin")).toMatchObject({ commands: ["copy"] });
		expect(keyEvent(key("KeyC", 4), "win32")).not.toHaveProperty("commands");
	});

	it("reads select lists from the page script and refuses anything else", () => {
		const payload = JSON.stringify({
			rect: { x: 10, y: 20, width: 100, height: 24 },
			options: [{ label: "A" }, { label: "B", disabled: true, group: "G" }, { label: 5 }],
			selected: 1,
		});
		expect(parseSelect(payload)).toEqual({
			kind: "select",
			rect: { x: 10, y: 20, width: 100, height: 24 },
			options: [{ label: "A" }, { label: "B", disabled: true, group: "G" }, { label: "" }],
			selected: 1,
		});
		expect(
			parseSelect(JSON.stringify({ rect: { x: 0, y: 0, width: 1, height: 1 }, options: [], selected: 3 }))?.selected,
		).toBe(-1);
		expect(parseSelect("not json")).toBeUndefined();
		expect(parseSelect(JSON.stringify({ rect: { x: "1" }, options: [] }))).toBeUndefined();
		expect(parseSelect(JSON.stringify({ rect: { x: 0, y: 0, width: 1, height: 1 } }))).toBeUndefined();
		expect(parseSelect(42)).toBeUndefined();
	});

	it("shows only cursor keywords, never a page's image", () => {
		expect(cursorKeyword("pointer")).toBe("pointer");
		expect(cursorKeyword("url(https://evil.example/c.png) 4 4, grab")).toBe("grab");
		expect(cursorKeyword("url(x.png), auto")).toBe("default");
		expect(cursorKeyword("-webkit-grab")).toBe("default");
		expect(cursorKeyword(undefined)).toBe("default");
	});

	it("describes dialogs and the user's language", () => {
		expect(dialogPopup({ type: "prompt", message: "Name?", defaultPrompt: "Ann" })).toEqual({
			kind: "dialog",
			dialog: "prompt",
			message: "Name?",
			defaultPrompt: "Ann",
		});
		expect(dialogPopup({ type: "weird", message: 3 })).toEqual({ kind: "dialog", dialog: "alert", message: "3" });
		expect(browserLocale("zh-CN")).toBe("zh-CN");
		expect(browserLocale("en")).toBe("en");
		expect(browserLocale("--lang=x")).toBeUndefined();
		expect(browserLocale(undefined)).toBeUndefined();
		expect(acceptLanguage("zh-CN")).toBe("zh-CN,zh;q=0.9,en;q=0.8");
		expect(acceptLanguage("en-US")).toBe("en-US,en;q=0.9");
		expect(acceptLanguage("en")).toBe("en");
	});
});
