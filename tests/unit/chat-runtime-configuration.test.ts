import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useChatRuntimeConfiguration } from "../../src/components/chat/use-chat-runtime-configuration.ts";
import type { PiAgentState, PiModel } from "../../src/lib/api/pi-runtime.ts";

type Options = Parameters<typeof useChatRuntimeConfiguration>[0];

const cachedModel: PiModel = {
	id: "cached",
	name: "Cached default",
	provider: "test",
	reasoning: false,
};
const currentModel: PiModel = {
	id: "current",
	name: "Current Pi default",
	provider: "test",
	reasoning: true,
	thinkingLevels: ["low", "high"],
};
const scopedModel: PiModel = {
	...currentModel,
	id: "scoped",
	defaultThinkingLevel: "low",
	scopeOrder: 0,
	scopeThinkingLevel: "high",
};

function setup(
	initial: Partial<
		Pick<
			Options["session"],
			"initialModel" | "initialThinkingLevel" | "temporary"
		>
	> = {},
) {
	let state: PiAgentState = {
		model: currentModel,
		thinkingLevel: "high",
		isStreaming: false,
		isCompacting: false,
		messageCount: 0,
		pendingMessageCount: 0,
	};
	const changes: string[] = [];
	const modelSelectionDirtyRef = { current: false };
	const thinkingSelectionDirtyRef = { current: false };
	const modelUpdates: Parameters<Options["setSelectedModel"]>[0][] = [];
	const thinkingUpdates: Parameters<Options["setSelectedThinkingLevel"]>[0][] =
		[];
	const levelUpdates: Parameters<Options["setThinkingLevels"]>[0][] = [];
	const client: Options["client"] = {
		setPiModel: async (model) => {
			changes.push(`model:${model.id}`);
			state = { ...state, model: scopedModel, thinkingLevel: "low" };
			return scopedModel;
		},
		setPiThinkingLevel: async (level) => {
			changes.push(`thinking:${level}`);
			state = { ...state, thinkingLevel: level };
		},
		getPiAgentState: async () => state,
		getAvailablePiThinkingLevels: async () => ({
			levels: ["low", "high"],
		}),
	};
	const captured: {
		prepare?: ReturnType<typeof useChatRuntimeConfiguration>;
	} = {};
	function Harness({
		onPrepare,
	}: {
		onPrepare: (
			callback: ReturnType<typeof useChatRuntimeConfiguration>,
		) => void;
	}) {
		const prepareConfiguration = useChatRuntimeConfiguration({
			session: {
				id: "draft-1",
				title: "New chat",
				projectRecord: {
					id: "project-1",
					name: "Project",
					path: "/project",
					connection: { id: "local", name: "Local", kind: { type: "local" } },
					metadata: {
						cwd: "/project",
						gitBranch: null,
						piVersion: "1.0.0",
						refreshedAtMs: 0,
					},
					createdAtMs: 0,
					lastOpenedAtMs: 0,
				},
				...initial,
			},
			client,
			selectedModel: cachedModel,
			selectedThinkingLevel: "off",
			modelSelectionDirtyRef,
			thinkingSelectionDirtyRef,
			setSelectedModel: (value) => modelUpdates.push(value),
			setSelectedThinkingLevel: (value) => thinkingUpdates.push(value),
			setThinkingLevels: (value) => levelUpdates.push(value),
		});
		onPrepare(prepareConfiguration);
		return null;
	}
	// SSR only captures the hook callback. Invoking it below exercises the real startup logic.
	renderToStaticMarkup(
		createElement(Harness, {
			onPrepare: (callback) => {
				captured.prepare = callback;
			},
		}),
	);
	assert.ok(captured.prepare);
	return {
		prepare: captured.prepare,
		state,
		changes,
		modelUpdates,
		thinkingUpdates,
		levelUpdates,
		modelSelectionDirtyRef,
		thinkingSelectionDirtyRef,
	};
}

for (const temporary of [false, true]) {
	test(`an untouched ${temporary ? "temporary" : "persistent"} chat uses Pi defaults and updates the picker`, async () => {
		const run = setup({ temporary });
		await run.prepare(run.state);
		assert.deepEqual(run.changes, []);
		assert.deepEqual(run.modelUpdates, [currentModel]);
		assert.deepEqual(run.thinkingUpdates, ["high"]);
		assert.deepEqual(run.levelUpdates, [["low", "high"]]);
		assert.equal(run.modelSelectionDirtyRef.current, true);
		assert.equal(run.thinkingSelectionDirtyRef.current, true);
		await run.prepare(run.state);
		assert.equal(run.modelUpdates.length, 1);
	});
}

test("a picked Scope thinking level is applied after switching models, even when it matched the startup level", async () => {
	const run = setup({
		initialModel: scopedModel,
		initialThinkingLevel: "high",
	});
	await run.prepare(run.state);
	assert.deepEqual(run.changes, ["model:scoped", "thinking:high"]);
	assert.deepEqual(run.modelUpdates, [scopedModel]);
	assert.deepEqual(run.thinkingUpdates, ["high"]);
});

test("a thinking-only choice does not override Pi's current default model", async () => {
	const run = setup({ initialThinkingLevel: "low" });
	await run.prepare(run.state);
	assert.deepEqual(run.changes, ["thinking:low"]);
	assert.deepEqual(run.modelUpdates, [currentModel]);
	assert.deepEqual(run.thinkingUpdates, ["low"]);
});
