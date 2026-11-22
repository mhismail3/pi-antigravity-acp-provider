import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { findSessionSelector, sessionModels } from "../src/acp/session-state.js";
import { projectModels } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";
import { AntigravityRuntime } from "../src/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/model-selection-agent.mjs", import.meta.url));
function connection(scenario: string, options: Partial<AntigravityConnectionOptions> = {}) {
	return new AntigravityAcpConnection({ cwd: process.cwd(), ...options, command: process.execPath, args: [fixture, scenario] });
}

// These tests use the actual ACP SDK/transport and runtime, not mocks of the
// selector methods. The child reports the model it really used in each reply.
describe("model selection integration", () => {
	it.each(["split", "thinking-alias", "thought-alias", "category-only"])("can select every discovered ID and restore it (%s)", async (scenario) => {
		const acp = connection(scenario);
		try {
			const session = await acp.newSession(process.cwd());
			for (const model of sessionModels(session)!.availableModels) {
				await acp.setModel(session.sessionId, model.modelId);
				expect(sessionModels(acp.getSessionState(session.sessionId))?.currentModelId).toBe(model.modelId);
			}
			await acp.setModel(session.sessionId, "gemini-b-low");
			await acp.setModel(session.sessionId, "gemini-b-medium");
			expect(sessionModels(await acp.resumeSession(session.sessionId, process.cwd()))?.currentModelId).toBe("gemini-b-medium");
			expect(sessionModels(await acp.loadSession(session.sessionId, process.cwd()))?.currentModelId).toBe("gemini-b-medium");
		} finally { await acp.close(); }
	});

	it("prefers an exact native model ID to splitting a matching suffix", async () => {
		const acp = connection("native-id");
		try {
			const session = await acp.newSession(process.cwd());
			await acp.setModel(session.sessionId, "gemini-a-low");
			const state = acp.getSessionState(session.sessionId);
			expect(findSessionSelector(state, "model")?.currentValue).toBe("gemini-a-low");
			expect(findSessionSelector(state, "thought_level")?.currentValue).toBe("high");
		} finally { await acp.close(); }
	});

	it("rejects a silently ignored model selector update", async () => {
		const acp = connection("ignored-base");
		try {
			const session = await acp.newSession(process.cwd());
			await expect(acp.setModel(session.sessionId, "gemini-b-low")).rejects.toThrow("did not confirm the requested model selection");
		} finally { await acp.close(); }
	});

	it.each([
		["disappearing", "did not confirm the requested thought_level selection"],
		["reject-low", "did not confirm the requested thought_level selection"],
		["model-drift", "changed the model during thought_level selection"],
	])("does not claim success after a partial selection (%s)", async (scenario, message) => {
		const acp = connection(scenario);
		try {
			const session = await acp.newSession(process.cwd());
			await expect(acp.setModel(session.sessionId, "gemini-b-low")).rejects.toThrow(message);
		} finally { await acp.close(); }
	});

	it.each([
		["selector-auth", "auth"],
		["selector-protocol", "protocol"],
	])("does not treat a real selector error as a fallback opportunity (%s)", async (scenario, code) => {
		const acp = connection(scenario);
		try {
			const session = await acp.newSession(process.cwd());
			await expect(acp.setModel(session.sessionId, "gemini-b-low")).rejects.toMatchObject({
				code, message: expect.stringContaining("Selector update rejected"), cause: expect.any(Error),
			});
		} finally { await acp.close(); }
	});

	it("refuses to prompt when the session omits stable model configuration", async () => {
		const runtime = new AntigravityRuntime((options) => connection("missing-model-selector", options), "default");
		try {
			const model = projectModels([{ modelId: "gemini-a-high", name: "Gemini A (High)" }])[0]!;
			const result = await runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{ sessionId: "missing-model-selector", reasoning: "high" }).stream.result();
			expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("did not advertise a model selector") });
		} finally { await runtime.close(); }
	});

	it("starts empty and replaces a stale catalog with the authoritative live inventory, including empty", async () => {
		const runtime = new AntigravityRuntime((options) => connection("empty-catalog", options));
		const { provider } = createAntigravityProvider(runtime);
		const publish = async ({ update }: ModelsPublication) => { update?.(); return true; };
		try {
			expect(provider.getModels()).toEqual([]);
			await provider.refreshModels!({ allowNetwork: false, signal: new AbortController().signal,
				stored: { models: projectModels([{ modelId: "gemini-unavailable", name: "Unavailable" }]) }, publish });
			expect(provider.getModels().map((model) => model.id)).toEqual(["gemini-unavailable"]);
			expect(provider.getModels()[0]?.name).toContain("cached; access unverified");
			await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal, publish });
			expect(provider.getModels()).toEqual([]);
		} finally { await runtime.close(); }
	});

	it.each(["model-specific", "initial-fixed"])("discovers and selects each model's own efforts (%s)", async (scenario) => {
		const runtime = new AntigravityRuntime((options) => connection(scenario, options));
		try {
			const inventory = await runtime.discoverModels(undefined);
			expect(inventory.map((model) => model.modelId)).toEqual([
				...(scenario === "initial-fixed" ? ["gemini-a"] : ["gemini-a-low", "gemini-a-medium", "gemini-a-high"]), "gemini-b-xhigh",
			]);
			const model = projectModels(inventory).find((candidate) => candidate.id === "gemini-b-xhigh")!;
			const result = await runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{ sessionId: "model-specific", reasoning: "xhigh" }).stream.result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "gemini-b/xhigh" }]);
		} finally { await runtime.close(); }
	});

	it("rejects unadvertised models without invoking a draft selection fallback", async () => {
		const acp = connection("split");
		try {
			const session = await acp.newSession(process.cwd());
			await expect(acp.setModel(session.sessionId, "gemini-unavailable-high")).rejects.toThrow("not advertised");
			await expect(acp.setModel(session.sessionId, "gemini-a-unknown")).rejects.toThrow("not advertised");
		} finally { await acp.close(); }
	});

	it("publishes discovered reasoning models and applies effort changes on a warm provider session", async () => {
		const runtime = new AntigravityRuntime((options) => connection("split", options));
		const { provider } = createAntigravityProvider(runtime);
		try {
			let published = false;
			await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
				publish: async ({ update }) => { update?.(); published = true; return true; } });
			expect(published).toBe(true);
			const model = provider.getModels().find((candidate) => candidate.id === "gemini-b")!;
			expect(model).toMatchObject({ reasoning: true, thinkingLevelMap: { low: "gemini-b-low", high: "gemini-b-high" } });
			const firstContext = { messages: [{ role: "user" as const, content: "first", timestamp: 1 }] };
			const first = await runtime.stream(model, firstContext, { sessionId: "warm-effort", reasoning: "low" }).stream.result();
			expect(first.content).toEqual([{ type: "text", text: "gemini-b/low" }]);
			const generation = (await runtime.snapshot()).processes[0]?.generation;
			const second = await runtime.stream(model, { messages: [...firstContext.messages, first,
				{ role: "user", content: "second", timestamp: 2 }] }, { sessionId: "warm-effort", reasoning: "high" }).stream.result();
			expect(second.content).toEqual([{ type: "text", text: "gemini-b/high" }]);
			expect((await runtime.snapshot()).processes[0]?.generation).toBe(generation);
		} finally { await runtime.close(); }
	});

	it("persists the discovered catalog and restores it during the next offline startup phase", async () => {
		const runtime = new AntigravityRuntime((options) => connection("split", options));
		const { provider } = createAntigravityProvider(runtime);
		const persisted: ModelsStoreEntry[] = [];
		const publish = async ({ persist, update }: ModelsPublication) => {
			if (persist) persisted.push(persist);
			update?.();
			return true;
		};
		try {
			await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal, publish });
			expect(persisted).toHaveLength(1);
			const stored = persisted[0]!;
			expect(stored.checkedAt).toEqual(expect.any(Number));
			expect(stored.models.map((model) => model.id)).toEqual(provider.getModels().map((model) => model.id));
			expect(stored.models.some((model) => model.id === "gemini-b")).toBe(true);
		} finally { await runtime.close(); }

		const offline = new AntigravityRuntime(() => { throw new Error("offline restore must not spawn ACP"); });
		const restarted = createAntigravityProvider(offline).provider;
		try {
			expect(restarted.getModels().some((model) => model.id === "gemini-b")).toBe(false);
			await restarted.refreshModels!({ allowNetwork: false, signal: new AbortController().signal,
				stored: JSON.parse(JSON.stringify(persisted[0])), publish });
			expect(persisted).toHaveLength(1);
			expect(restarted.getModels().find((model) => model.id === "gemini-b"))
				.toMatchObject({ reasoning: true, thinkingLevelMap: { low: "gemini-b-low", high: "gemini-b-high" } });
		} finally { await offline.close(); }
	});

	it("keeps the catalog empty when nothing usable was persisted", async () => {
		const offline = new AntigravityRuntime(() => { throw new Error("offline restore must not spawn ACP"); });
		const { provider } = createAntigravityProvider(offline);
		const before = provider.getModels().map((model) => model.id);
		let published = 0;
		try {
			const foreign = { models: [{ id: "gpt-x", provider: "openai", api: "openai-completions" }] } as unknown as ModelsStoreEntry;
			for (const stored of [undefined, { models: [] }, foreign]) {
				await provider.refreshModels!({ allowNetwork: false, signal: new AbortController().signal, ...(stored ? { stored } : {}),
					publish: async () => { published += 1; return true; } });
			}
			expect(published).toBe(0);
			expect(provider.getModels().map((model) => model.id)).toEqual(before);
			expect(before).toEqual([]);
		} finally { await offline.close(); }
	});

	it("discards both warm and saved bindings after a partial selection, then safely retries the original model", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-selection-recovery-"));
		const store = new AcpSessionStore(path.join(directory, "sessions.json"));
		const connections: AntigravityAcpConnection[] = [];
		const runtime = new AntigravityRuntime((options) => {
			const acp = connection("reject-low", options);
			connections.push(acp);
			return acp;
		}, "default", store);
		const models = projectModels(["a", "b"].flatMap((base) => ["low", "medium", "high"].map((effort) => ({
			modelId: `gemini-${base}-${effort}`, name: `Gemini ${base.toUpperCase()} (${effort})`,
		}))));
		const modelA = models.find((model) => model.id === "gemini-a")!;
		const modelB = models.find((model) => model.id === "gemini-b")!;
		const context = { messages: [{ role: "user" as const, content: "first", timestamp: 1 }] };
		const options = { sessionId: "selection-recovery", reasoning: "high" as const };
		try {
			const first = await runtime.stream(modelA, context, options).stream.result();
			expect(first.content).toEqual([{ type: "text", text: "gemini-a/high" }]);
			expect(store.get(options.sessionId)).toBeDefined();
			const next = { messages: [...context.messages, first, { role: "user" as const, content: "next", timestamp: 2 }] };
			const failed = await runtime.stream(modelB, next, { ...options, reasoning: "low" }).stream.result();
			expect(failed.stopReason).toBe("error");
			expect((await runtime.snapshot()).bindings).toBe(0);
			expect(store.get(options.sessionId)).toBeUndefined();
			expect(connections[0]?.process.alive).toBe(false);
			const retry = await runtime.stream(modelA, next, options).stream.result();
			expect(retry.content).toEqual([{ type: "text", text: "gemini-a/high" }]);
			expect(connections).toHaveLength(2);
		} finally { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
	});
});
