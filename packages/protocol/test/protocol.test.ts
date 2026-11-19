import { describe, expect, it } from "vitest";
import {
	isMethodName,
	isProtocolCompatible,
	MethodParamsSchemas,
	PierProtocolError,
	PROTOCOL_VERSION,
	parseClientFrame,
	parseContextLimit,
	parseHostFrame,
	parseProtocolVersion,
} from "../src/index.ts";

describe("protocol version", () => {
	it("parses major.minor", () => {
		expect(parseProtocolVersion("1.0")).toEqual({ major: 1, minor: 0 });
		expect(parseProtocolVersion("12.34")).toEqual({ major: 12, minor: 34 });
		expect(parseProtocolVersion("1")).toBeUndefined();
		expect(parseProtocolVersion("v1.0")).toBeUndefined();
	});

	it("is compatible only within the same major version", () => {
		expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
		expect(isProtocolCompatible("1.9", "1.0")).toBe(true);
		expect(isProtocolCompatible("2.0", "1.0")).toBe(false);
		expect(isProtocolCompatible("garbage", "1.0")).toBe(false);
	});
});

describe("frames", () => {
	it("parses valid request frames", () => {
		const frame = parseClientFrame(
			JSON.stringify({ type: "req", id: "r1", method: "session.prompt", params: { sessionId: "s", text: "hi" } }),
		);
		expect(frame).toEqual({ type: "req", id: "r1", method: "session.prompt", params: { sessionId: "s", text: "hi" } });
	});

	it("rejects malformed request frames", () => {
		expect(parseClientFrame("not json")).toBeUndefined();
		expect(parseClientFrame(JSON.stringify({ type: "req", method: "x" }))).toBeUndefined();
		expect(parseClientFrame(JSON.stringify({ type: "res", id: "1", ok: true, result: {} }))).toBeUndefined();
		expect(parseClientFrame(JSON.stringify({ type: "req", id: "", method: "x" }))).toBeUndefined();
	});

	it("parses host frames", () => {
		expect(parseHostFrame(JSON.stringify({ type: "res", id: "1", ok: true, result: { a: 1 } }))).toMatchObject({
			ok: true,
		});
		expect(
			parseHostFrame(JSON.stringify({ type: "res", id: "1", ok: false, error: { code: "NOT_FOUND", message: "x" } })),
		).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		expect(
			parseHostFrame(JSON.stringify({ type: "evt", sessionId: "s", seq: 3, event: { type: "agent_start", extra: 1 } })),
		).toEqual({ type: "evt", sessionId: "s", seq: 3, event: { type: "agent_start", extra: 1 } });
		expect(
			parseHostFrame(JSON.stringify({ type: "res", id: "1", ok: false, error: { code: "WHAT", message: "x" } })),
		).toBeUndefined();
		expect(parseHostFrame(JSON.stringify({ type: "evt", event: {} }))).toBeUndefined();
	});
});

describe("method params", () => {
	it("knows every method name", () => {
		expect(isMethodName("session.prompt")).toBe(true);
		expect(isMethodName("toString")).toBe(false);
		expect(isMethodName("session.nope")).toBe(false);
	});

	it("validates prompt params", () => {
		const schema = MethodParamsSchemas["session.prompt"];
		expect(schema.safeParse({ sessionId: "s", text: "hi" }).success).toBe(true);
		expect(schema.safeParse({ sessionId: "s", text: "hi", streamingBehavior: "steer" }).success).toBe(true);
		expect(schema.safeParse({ sessionId: "s", text: "hi", streamingBehavior: "later" }).success).toBe(false);
		expect(schema.safeParse({ sessionId: "", text: "hi" }).success).toBe(false);
		expect(
			schema.safeParse({ sessionId: "s", text: "x", images: [{ type: "image", data: "AAA", mimeType: "image/png" }] })
				.success,
		).toBe(true);
		expect(
			schema.safeParse({ sessionId: "s", text: "x", images: [{ type: "image", data: "AAA", mimeType: "text/html" }] })
				.success,
		).toBe(false);
	});

	it("accepts either sessionId or path for session.open", () => {
		const schema = MethodParamsSchemas["session.open"];
		expect(schema.safeParse({ workspaceId: "w", sessionId: "s" }).success).toBe(true);
		expect(schema.safeParse({ workspaceId: "w", path: "/tmp/x.jsonl" }).success).toBe(true);
		expect(schema.safeParse({ workspaceId: "w" }).success).toBe(false);
	});

	it("validates ui responses", () => {
		const schema = MethodParamsSchemas["ui.respond"];
		expect(schema.safeParse({ sessionId: "s", requestId: "r", response: { decision: "allow_once" } }).success).toBe(
			true,
		);
		expect(schema.safeParse({ sessionId: "s", requestId: "r", response: { decision: "maybe" } }).success).toBe(false);
	});

	it("allows omitted params for parameterless methods", () => {
		expect(MethodParamsSchemas["workspace.list"].safeParse(undefined).success).toBe(true);
		expect(MethodParamsSchemas["host.info"].safeParse({}).success).toBe(true);
	});

	it("accepts resource types for deletion and keeps extension-only clients compatible", () => {
		const schema = MethodParamsSchemas["extension.delete"];
		expect(schema.safeParse({ path: "/extensions/demo.js" }).success).toBe(true);
		for (const type of ["extensions", "skills", "prompts", "themes"]) {
			expect(schema.safeParse({ type, path: "/resource", workspaceId: "w" }).success).toBe(true);
		}
		expect(schema.safeParse({ type: "packages", path: "/resource" }).success).toBe(false);
	});
});

describe("PierProtocolError", () => {
	it("serializes to the wire shape", () => {
		expect(new PierProtocolError("CONFLICT", "busy").toJSON()).toEqual({ code: "CONFLICT", message: "busy" });
		expect(new PierProtocolError("BAD_REQUEST", "bad", { field: "x" }).toJSON()).toEqual({
			code: "BAD_REQUEST",
			message: "bad",
			data: { field: "x" },
		});
	});
});

describe("context limits (1.64)", () => {
	it("parses token counts with units and separators", () => {
		expect(parseContextLimit("200k")).toBe(200_000);
		expect(parseContextLimit(" 1.5M ")).toBe(1_500_000);
		expect(parseContextLimit("200,000")).toBe(200_000);
		expect(parseContextLimit("200 000")).toBe(200_000);
		expect(parseContextLimit("20万")).toBe(200_000);
		expect(parseContextLimit("150000")).toBe(150_000);
		for (const bad of ["", "k", "-5", "abc", "1e6", "0", "200 tokens", "999m"])
			expect(parseContextLimit(bad)).toBeUndefined();
	});

	it("validates contextLimit.set", () => {
		const schema = MethodParamsSchemas["contextLimit.set"];
		expect(schema.parse({ sessionId: "s", limit: 200_000, asDefault: true })).toEqual({
			sessionId: "s",
			limit: 200_000,
			asDefault: true,
		});
		expect(schema.parse({ sessionId: "s", limit: null })).toEqual({ sessionId: "s", limit: null });
		for (const limit of [0, -1, 1.5, 200_000_000, "200k", undefined]) {
			expect(schema.safeParse({ sessionId: "s", limit }).success).toBe(false);
		}
	});
});
