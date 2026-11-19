import { describe, expect, it } from "vitest";
import { clientEvent, clientMessage, clientMessages } from "../src/client-messages.ts";

const assistant = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "plan", thinkingSignature: "enc-1" },
		{ type: "thinking", thinking: "", thinkingSignature: "enc-2", redacted: true },
		{ type: "text", text: "done", textSignature: "sig" },
		{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" }, thoughtSignature: "g" },
	],
	stopReason: "toolUse",
};
const stripped = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "plan" },
		{ type: "thinking", thinking: "", redacted: true },
		{ type: "text", text: "done" },
		{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
	],
	stopReason: "toolUse",
};

describe("messages sent to clients", () => {
	it("leaves out provider signatures and keeps everything else", () => {
		expect(clientMessage(assistant)).toEqual(stripped);
		// The agent's own message is not changed.
		expect(assistant.content[0]).toHaveProperty("thinkingSignature", "enc-1");
	});

	it("returns the same objects when there is nothing to leave out", () => {
		const user = { role: "user", content: [{ type: "text", text: "hi" }] };
		const plain = { role: "user", content: "hi" };
		expect(clientMessage(user)).toBe(user);
		expect(clientMessage(plain)).toBe(plain);
		const list = [user, plain];
		expect(clientMessages(list)).toBe(list);
		expect(clientMessages([user, assistant])).toEqual([user, stripped]);
	});

	it("strips the messages events carry", () => {
		expect(clientEvent({ type: "message_end", message: assistant })).toEqual({
			type: "message_end",
			message: stripped,
		});
		expect(clientEvent({ type: "turn_end", message: assistant, toolResults: [] })).toEqual({
			type: "turn_end",
			message: stripped,
			toolResults: [],
		});
		expect(clientEvent({ type: "agent_end", messages: [assistant] })).toEqual({
			type: "agent_end",
			messages: [stripped],
		});
		expect(
			clientEvent({
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 3, toolCall: assistant.content[3] },
			}),
		).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 3, toolCall: stripped.content[3] },
		});
		const other = { type: "session.status", state: "idle" };
		expect(clientEvent(other)).toBe(other);
		const delta = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } };
		expect(clientEvent(delta)).toBe(delta);
	});
});
