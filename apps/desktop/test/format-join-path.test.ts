import { describe, expect, it } from "vitest";
import { joinPath } from "../src/lib/format.ts";

describe("joinPath", () => {
	it("joins POSIX paths", () => {
		expect(joinPath("/home/me/project", "src/lib")).toBe("/home/me/project/src/lib");
		expect(joinPath("/", "etc")).toBe("/etc");
		expect(joinPath("/home/me/project", "")).toBe("/home/me/project");
	});

	it("uses backslashes for Windows paths", () => {
		expect(joinPath("C:\\Users\\me\\project", "src/lib")).toBe("C:\\Users\\me\\project\\src\\lib");
		expect(joinPath("D:\\", "work")).toBe("D:\\work");
		expect(joinPath("\\\\server\\share", "a/b")).toBe("\\\\server\\share\\a\\b");
	});
});
