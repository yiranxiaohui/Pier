import { describe, expect, it } from "vitest";
import { keyText, screenViewport } from "../src/components/BrowserScreen.tsx";

describe("the panel's page view", () => {
	it("asks for the panel's size at the screen's pixel ratio, within the browser's limits", () => {
		expect(screenViewport(689.6, 814.2, 1.25)).toEqual({ width: 689, height: 814, scale: 1.25 });
		expect(screenViewport(40, 30, 1)).toEqual({ width: 100, height: 100, scale: 1 });
		// A huge panel on a dense screen keeps the picture under 4096 device pixels a side.
		expect(screenViewport(3000, 1000, 2)).toEqual({ width: 3000, height: 1000, scale: 1.37 });
		expect(screenViewport(800, 600, 0)).toMatchObject({ scale: 1 });
	});

	it("types characters, Enter and AltGr characters, but not shortcuts", () => {
		const key = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "metaKey", boolean>> = {}) =>
			keyText({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods });
		expect(key("a")).toBe("a");
		expect(key("A")).toBe("A");
		expect(key("😀")).toBe("😀");
		expect(key("Enter")).toBe("\r");
		expect(key("Tab")).toBeUndefined();
		expect(key("a", { ctrlKey: true })).toBeUndefined();
		expect(key("a", { metaKey: true })).toBeUndefined();
		expect(key("@", { ctrlKey: true, altKey: true })).toBe("@");
	});
});
