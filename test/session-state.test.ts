import { describe, expect, it } from "vitest";

import { decodeSessionState, findSessionSelector, sessionModels, sessionModes, splitSessionModelId } from "../src/acp/session-state.js";

function splitState(id = "thinking_level") {
	return decodeSessionState({ configOptions: [
		{ id: "model", name: "Model", type: "select", currentValue: "gemini-a", options: [{ value: "gemini-a", name: "Gemini A" }] },
		{ id, name: "Thinking", ...(id === "custom-thinking" ? { category: "thought_level" } : {}), type: "select", currentValue: "high",
			options: [{ group: "levels", name: "Levels", options: ["off", "low", "medium", "high"].map((value) => ({ value, name: value })) }] },
	] });
}

const modelSelector = {
	id: "model", name: "Model", type: "select", currentValue: "modern",
	options: [{ value: "modern", name: "Modern" }],
};

describe("ACP session configuration", () => {
	it("reads stable model and mode selectors without categories", () => {
		const state = decodeSessionState({
			configOptions: [modelSelector, { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] }],
		});
		expect(sessionModels(state)).toEqual({ currentModelId: "modern", availableModels: [{ modelId: "modern", name: "Modern" }] });
		expect(sessionModes(state)?.currentModeId).toBe("default");
	});

	it("synthesizes effort-qualified models when model and thought_level selectors are split", () => {
		const state = decodeSessionState({
			configOptions: [
				{
					id: "model",
					name: "Model",
					category: "model",
					type: "select",
					currentValue: "gemini-3.8-flash",
					options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
				},
				{
					id: "thinking_level",
					name: "Thinking Level",
					category: "thought_level",
					type: "select",
					currentValue: "medium",
					options: [
						{ value: "low", name: "Low" },
						{ value: "medium", name: "Medium" },
						{ value: "high", name: "High" },
					],
				},
			],
		});
		expect(sessionModels(state)).toEqual({
			currentModelId: "gemini-3.8-flash-medium",
			availableModels: [
				{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
				{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
				{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			],
		});
	});

	it.each(["thinking_level", "thought_level", "custom-thinking"])("uses one lookup for discovery and selection (%s)", (id) => {
		const state = splitState(id);
		expect(findSessionSelector(state, "thought_level")?.id).toBe(id);
		expect(sessionModels(state)?.currentModelId).toBe("gemini-a-high");
		for (const model of sessionModels(state)!.availableModels) {
			expect(splitSessionModelId(state, model.modelId)).toEqual({ base: "gemini-a", effort: model.modelId.slice("gemini-a-".length) });
		}
		expect(splitSessionModelId(state, "gemini-a-off")).toEqual({ base: "gemini-a", effort: "off" });
		expect(splitSessionModelId(state, "gemini-a-unknown")).toEqual({ base: "gemini-a", effort: "unknown" });
	});

	it("preserves native qualified IDs and gives exact IDs precedence over splitting", () => {
		const state = splitState();
		const selector = findSessionSelector(state, "model")!;
		selector.options = [{ value: "gemini-a", name: "Gemini A" }, { value: "gemini-a-off", name: "Native Off" }];
		selector.currentValue = "gemini-a-off";
		expect(sessionModels(state)?.currentModelId).toBe("gemini-a-off");
		expect(sessionModels(state)?.availableModels.some((model) => model.modelId === "gemini-a-off-high")).toBe(false);
		expect(splitSessionModelId(state, "gemini-a-off")).toBeUndefined();
	});

	it.each([
		null,
		{ configOptions: [{ ...modelSelector, currentValue: false }] },
		{ configOptions: [{ ...modelSelector, options: [{ value: 123, name: "Bad" }] }] },
	])("rejects malformed session state without leaking server data: %j", (state) => {
		expect(() => decodeSessionState(state)).toThrow("Invalid ACP session configuration");
	});
});
