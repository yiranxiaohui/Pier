import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { cleanTitle, needsTitle, summarizeTitle, type TitleModels, titleWidth } from "../src/session-titles.ts";

const MODEL = { provider: "p", id: "m" } as Model<Api>;

function answer(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason } as AssistantMessage;
}

function models(reply: AssistantMessage | undefined, seen: Context[] = []): TitleModels {
	return {
		newSessionDefaults: () =>
			reply
				? { model: { provider: "p", id: "m", name: "m", reasoning: false, input: ["text"], thinkingLevels: ["off"] } }
				: {},
		modelRuntime: {
			getModel: (provider, modelId) => (provider === "p" && modelId === "m" ? MODEL : undefined),
			completeSimple: async (_model, context) => {
				seen.push(context);
				return reply as AssistantMessage;
			},
		},
	};
}

describe("session titles", () => {
	it("measures width in CJK characters, two narrow ones to a wide one", () => {
		expect(titleWidth("你好")).toBe(2);
		expect(titleWidth("fix it")).toBe(3);
		expect(titleWidth("  修   bug ")).toBe(3);
	});

	it("summarizes only prompts wider than 12 CJK characters", () => {
		expect(needsTitle("修一下登录页的样式问题吧")).toBe(false);
		expect(needsTitle("修一下登录页的样式问题吧谢谢")).toBe(true);
		expect(needsTitle("fix the login page styles!")).toBe(true);
		expect(needsTitle("fix the login styles")).toBe(false);
		expect(needsTitle("/skill:review 帮我把整个仓库的代码都审查一遍")).toBe(false);
	});

	it("keeps the first line of an answer without labels, quotes or closing punctuation", () => {
		expect(cleanTitle("「重构登录流程」。")).toBe("重构登录流程");
		expect(cleanTitle("**标题：** 重构登录流程\n解释……")).toBe("重构登录流程");
		expect(cleanTitle('\n\nTitle: "Fix the login flow."')).toBe("Fix the login flow");
		expect(cleanTitle("# 升级 Node.js")).toBe("升级 Node.js");
		expect(cleanTitle("。\n")).toBeUndefined();
		expect(cleanTitle("长".repeat(40))).toBe("长".repeat(30));
	});

	it("asks the default model, without thinking, and cleans its answer", async () => {
		const seen: Context[] = [];
		expect(
			await summarizeTitle(models(answer("《整理会话列表》"), seen), "/w", "帮我整理一下侧边栏里的会话列表样式"),
		).toBe("整理会话列表");
		expect(seen).toHaveLength(1);
		expect(JSON.stringify(seen[0]?.messages)).toContain("帮我整理一下侧边栏里的会话列表样式");
	});

	it("gives no title without a model or when the request fails", async () => {
		expect(await summarizeTitle(models(undefined), "/w", "一条很长很长很长很长很长的消息")).toBeUndefined();
		expect(await summarizeTitle(models(answer("", "error")), "/w", "一条很长很长很长很长很长的消息")).toBeUndefined();
	});
});
