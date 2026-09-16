import assert from "node:assert/strict";
import test from "node:test";

import {
	chatRuntimeReplayTargetKey,
	listChatRuntimeReplayTargets,
	registerChatRuntimeReplayTarget,
	replayChatRuntimeTraceToUi,
} from "../src/lib/chat-runtime-replay.ts";

const delta = (generation: number, text: string) => ({
	type: "assistant_text_delta" as const,
	generation,
	delta: text,
});

test("UI replay routes interleaved sessions to mapped mounted targets and flushes once", async () => {
	const eventsA: string[] = [];
	const eventsB: string[] = [];
	let flushA = 0;
	let flushB = 0;
	let resetA = 0;
	let resetB = 0;
	const unregisterA = registerChatRuntimeReplayTarget({
		projectId: "project",
		sessionId: "target-a",
		isActive: () => true,
		isBusy: () => false,
		dispatchEvent: (event) => eventsA.push(event.type),
		flush: () => {
			flushA += 1;
		},
		reset: () => {
			resetA += 1;
		},
	});
	const unregisterB = registerChatRuntimeReplayTarget({
		projectId: "project",
		sessionId: "target-b",
		isActive: () => false,
		isBusy: () => false,
		dispatchEvent: (event) => eventsB.push(event.type),
		flush: () => {
			flushB += 1;
		},
		reset: () => {
			resetB += 1;
		},
	});

	try {
		await replayChatRuntimeTraceToUi(
			[
				{ t: 0, sessionId: "source-a", event: delta(1, "a") },
				{ t: 0, sessionId: "source-b", event: delta(2, "b") },
				{ t: 0, sessionId: "source-a", event: delta(1, "c") },
			],
			{
				resetTargets: true,
				sessionMap: {
					"source-a": "target-a",
					"source-b": chatRuntimeReplayTargetKey("project", "target-b"),
				},
			},
		);
		assert.deepEqual(eventsA, ["assistant_text_delta", "assistant_text_delta"]);
		assert.deepEqual(eventsB, ["assistant_text_delta"]);
		assert.equal(flushA, 1);
		assert.equal(flushB, 1);
		assert.equal(resetA, 1);
		assert.equal(resetB, 1);
		assert.equal(listChatRuntimeReplayTargets().length >= 2, true);
	} finally {
		unregisterA();
		unregisterB();
	}
});

test("UI replay refuses to inject into a live busy target", async () => {
	const unregister = registerChatRuntimeReplayTarget({
		projectId: "project",
		sessionId: "busy-target",
		isActive: () => true,
		isBusy: () => true,
		dispatchEvent: () => undefined,
		flush: () => undefined,
		reset: () => undefined,
	});
	try {
		await assert.rejects(
			replayChatRuntimeTraceToUi(
				[{ t: 0, sessionId: "busy-target", event: delta(1, "x") }],
				{ resetTargets: true },
			),
			/live runtime turn/,
		);
	} finally {
		unregister();
	}
});
