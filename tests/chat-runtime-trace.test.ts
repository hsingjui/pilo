import assert from "node:assert/strict";
import test from "node:test";

import {
	ChatRuntimeTraceRecorder,
	parseChatRuntimeTrace,
	replayChatRuntimeTrace,
	serializeChatRuntimeTrace,
	type ChatRuntimeTraceEntry,
} from "../src/lib/chat-runtime-trace.ts";

const textDelta = (generation: number, delta: string) => ({
	type: "assistant_text_delta" as const,
	generation,
	delta,
});

test("runtime trace recorder stores relative timestamps and detached event snapshots", () => {
	const recorder = new ChatRuntimeTraceRecorder();
	const event = textDelta(3, "hello");
	recorder.start(100);
	recorder.record("session-a", event, 112.3456);
	const trace = recorder.stop();

	assert.deepEqual(trace, [
		{
			t: 12.346,
			sessionId: "session-a",
			event,
		},
	]);
	assert.equal(recorder.recording, false);
});

test("runtime trace JSONL round-trips multiple sessions in event order", () => {
	const trace: ChatRuntimeTraceEntry[] = [
		{ t: 0, sessionId: "session-a", event: textDelta(1, "a") },
		{ t: 8.5, sessionId: "session-b", event: textDelta(2, "b") },
		{ t: 11, sessionId: "session-a", event: textDelta(1, "c") },
	];
	assert.deepEqual(
		parseChatRuntimeTrace(serializeChatRuntimeTrace(trace)),
		trace,
	);
});

test("runtime trace parser rejects malformed entries with a line number", () => {
	assert.throws(
		() =>
			parseChatRuntimeTrace(
				'{"t":0,"sessionId":"session-a","event":{"type":"assistant_text_delta"}}',
			),
		/line 1/,
	);
});

test("runtime trace replay preserves order and scales inter-event delays", async () => {
	const trace: ChatRuntimeTraceEntry[] = [
		{ t: 0, sessionId: "session-a", event: textDelta(1, "a") },
		{ t: 20, sessionId: "session-b", event: textDelta(2, "b") },
		{ t: 50, sessionId: "session-a", event: textDelta(1, "c") },
	];
	const delays: number[] = [];
	const replayed: string[] = [];

	await replayChatRuntimeTrace(
		trace,
		(entry) => {
			replayed.push(`${entry.sessionId}:${entry.event.type}`);
		},
		{
			speed: 2,
			sleep: async (delayMs) => {
				delays.push(delayMs);
			},
		},
	);

	assert.deepEqual(delays, [10, 15]);
	assert.deepEqual(replayed, [
		"session-a:assistant_text_delta",
		"session-b:assistant_text_delta",
		"session-a:assistant_text_delta",
	]);
});

test("runtime trace replay rejects invalid speeds", async () => {
	await assert.rejects(
		replayChatRuntimeTrace([], () => undefined, { speed: 0 }),
		/greater than 0/,
	);
});
