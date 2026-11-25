import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { PiEventWriter } from "../src/stream/pi-events.js";

const model: Model<Api> = {
	id: "test",
	name: "Test",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
};

describe("PiEventWriter", () => {
	it("balances blocks when switching thought and text", async () => {
		const writer = new PiEventWriter(model);
		writer.thinking("think");
		writer.text("answer");
		writer.done("stop");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
	});

	it("emits a valid empty response", async () => {
		const writer = new PiEventWriter(model);
		writer.done("stop");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_end", "done"]);
	});

	it("emits a complete synthetic tool call", async () => {
		const writer = new PiEventWriter(model);
		writer.toolCall("call-1", "permission", { requestId: "one" });
		writer.done("toolUse");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(writer.message.stopReason).toBe("toolUse");
	});

	it("preserves nested JSON tool arguments", () => {
		const writer = new PiEventWriter(model);
		const args = { nested: [null, true, 4, { text: "value" }] };
		writer.toolCall("call-json", "echo", args);
		expect(writer.message.content[0]).toMatchObject({ arguments: args });
	});

	it.each([undefined, NaN, Infinity, 1n, () => true, new Date()])("rejects non-JSON tool input: %s", (value) => {
		const writer = new PiEventWriter(model);
		expect(() => writer.toolCall("call-invalid", "echo", { value })).toThrow("valid JSON object");
		expect(writer.message.content).toHaveLength(0);
	});

	it("rejects cyclic tool input without overflowing the stack", () => {
		const args: Record<string, unknown> = {};
		args.self = args;
		expect(() => new PiEventWriter(model).toolCall("call-cycle", "echo", args)).toThrow("valid JSON object");
	});

	it("terminates errors once", async () => {
		const writer = new PiEventWriter(model);
		writer.fail(new Error("failed"));
		writer.done("stop");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "error" });
	});
});

describe("mapSessionUpdate tool activity", () => {
	it("normalizes native tool titles to one line and keeps bounded output", async () => {
		const { mapSessionUpdate } = await import("../src/acp/events.js");
		const start = mapSessionUpdate({
			sessionId: "s1",
			update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Run\n  npm\ttest", kind: "execute" },
		});
		expect(start).toEqual([{ type: "tool", start: true, id: "tc-1", title: "Run npm test", status: "pending", output: "" }]);

		const update = mapSessionUpdate({
			sessionId: "s1",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tc-1",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "x".repeat(5_000) } }],
			},
		});
		expect(update).toEqual([{ type: "tool", start: false, id: "tc-1", status: "completed", output: "x".repeat(2_000) }]);
	});
});
