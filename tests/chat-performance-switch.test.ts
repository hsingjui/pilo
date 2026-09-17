import assert from "node:assert/strict";
import test from "node:test";

import {
	summarizeChatSessionSwitchSamples,
	type ChatSessionSwitchSample,
} from "../src/lib/chat-performance-switch.ts";

function sample(
	durationMs: number,
	overrides: Partial<ChatSessionSwitchSample> = {},
): ChatSessionSwitchSample {
	return {
		fromSessionId: "a",
		requestedSessionId: "b",
		readySessionId: "b",
		durationMs,
		slowScrollFrames: 0,
		verySlowScrollFrames: 0,
		longTasks: 0,
		longTaskMs: 0,
		timestamp: "2026-09-16T00:00:00.000Z",
		...overrides,
	};
}

test("switch summary reports median, nearest-rank p95 and worst", () => {
	const summary = summarizeChatSessionSwitchSamples([
		sample(40),
		sample(20),
		sample(30),
		sample(10),
		sample(50),
	]);

	assert.equal(summary.count, 5);
	assert.equal(summary.medianMs, 30);
	assert.equal(summary.p95Ms, 50);
	assert.equal(summary.worstMs, 50);
});

test("switch summary aggregates slow frames and long tasks", () => {
	const summary = summarizeChatSessionSwitchSamples([
		sample(20, {
			slowScrollFrames: 2,
			verySlowScrollFrames: 1,
			longTasks: 1,
			longTaskMs: 51.24,
		}),
		sample(40, {
			slowScrollFrames: 3,
			verySlowScrollFrames: 2,
			longTasks: 2,
			longTaskMs: 100.31,
		}),
	]);

	assert.equal(summary.medianMs, 30);
	assert.equal(summary.slowScrollFrames, 5);
	assert.equal(summary.verySlowScrollFrames, 3);
	assert.equal(summary.longTasks, 3);
	assert.equal(summary.longTaskMs, 151.6);
});

test("empty switch summary stays explicit instead of inventing percentiles", () => {
	assert.deepEqual(summarizeChatSessionSwitchSamples([]), {
		count: 0,
		medianMs: null,
		p95Ms: null,
		worstMs: null,
		slowScrollFrames: 0,
		verySlowScrollFrames: 0,
		longTasks: 0,
		longTaskMs: 0,
	});
});
