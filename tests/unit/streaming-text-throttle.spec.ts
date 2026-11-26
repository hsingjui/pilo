import assert from "node:assert/strict";
import test from "node:test";

import { createStreamingTextThrottle } from "@shared/chat/streaming-text-throttle";

function createFakeClock() {
	let current = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();

	return {
		now: () => current,
		schedule: (fn: () => void, delayMs: number) => {
			const id = nextId++;
			timers.set(id, { at: current + delayMs, fn });
			return id;
		},
		cancel: (handle: unknown) => {
			timers.delete(handle as number);
		},
		advance(ms: number) {
			current += ms;
			for (;;) {
				let dueId: number | undefined;
				let dueAt = Number.POSITIVE_INFINITY;
				for (const [id, entry] of timers) {
					if (entry.at <= current && entry.at < dueAt) {
						dueId = id;
						dueAt = entry.at;
					}
				}
				if (dueId === undefined) break;
				const entry = timers.get(dueId);
				timers.delete(dueId);
				entry?.fn();
			}
		},
		pendingCount: () => timers.size,
	};
}

test("streaming throttle commits first chunk immediately and coalesces rapid deltas", () => {
	const clock = createFakeClock();
	const committed: string[] = [];
	const throttle = createStreamingTextThrottle({
		intervalMs: 75,
		now: clock.now,
		schedule: clock.schedule,
		cancel: clock.cancel,
		onCommit: (text) => committed.push(text),
	});

	throttle.push("H", true, "m1:t0");
	assert.deepEqual(committed, ["H"]);

	clock.advance(16);
	throttle.push("He", true, "m1:t0");
	clock.advance(16);
	throttle.push("Hel", true, "m1:t0");
	clock.advance(16);
	throttle.push("Hell", true, "m1:t0");
	// Still within the 75ms window — no intermediate rebuilds yet.
	assert.deepEqual(committed, ["H"]);
	assert.equal(clock.pendingCount(), 1);

	// Advancing past 75ms commits the latest accumulated text once.
	clock.advance(27);
	assert.deepEqual(committed, ["H", "Hell"]);
	assert.equal(clock.pendingCount(), 0);

	// Subsequent burst coalesces again.
	clock.advance(20);
	throttle.push("Hello ", true, "m1:t0");
	clock.advance(20);
	throttle.push("Hello world", true, "m1:t0");
	assert.deepEqual(committed, ["H", "Hell"]);
	clock.advance(35);
	assert.deepEqual(committed, ["H", "Hell", "Hello world"]);
});

test("streaming throttle flushes synchronously when streaming finishes or textKey switches", () => {
	const clock = createFakeClock();
	const committed: string[] = [];
	const throttle = createStreamingTextThrottle({
		intervalMs: 75,
		now: clock.now,
		schedule: clock.schedule,
		cancel: clock.cancel,
		onCommit: (text) => committed.push(text),
	});

	throttle.push("Start", true, "m1:t0");
	clock.advance(10);
	throttle.push("Start + more", true, "m1:t0");
	assert.deepEqual(committed, ["Start"]);

	// Stream ends before timer fires: must commit immediately and cancel timer.
	clock.advance(10);
	throttle.push("Start + more!", false, "m1:t0");
	assert.deepEqual(committed, ["Start", "Start + more!"]);
	assert.equal(clock.pendingCount(), 0);

	// Recycled row switches textKey while streaming: commits immediately.
	throttle.push("New row", true, "m2:t0");
	assert.deepEqual(committed, ["Start", "Start + more!", "New row"]);

	clock.advance(10);
	throttle.push("New row delta", true, "m2:t0");
	assert.equal(clock.pendingCount(), 1);

	// Dispose cancels pending trailing commit.
	throttle.dispose();
	assert.equal(clock.pendingCount(), 0);
	clock.advance(100);
	assert.deepEqual(committed, ["Start", "Start + more!", "New row"]);
});

test("streaming throttle renders first non-empty text immediately after empty initial state", () => {
	const clock = createFakeClock();
	const committed: string[] = [];
	const throttle = createStreamingTextThrottle({
		intervalMs: 75,
		now: clock.now,
		schedule: clock.schedule,
		cancel: clock.cancel,
		onCommit: (text) => committed.push(text),
	});

	throttle.push("", true, "m1:t0");
	assert.deepEqual(committed, [""]);

	clock.advance(10);
	throttle.push("First token", true, "m1:t0");
	assert.deepEqual(committed, ["", "First token"]);
});

test("streaming throttle does not reset cadence on unchanged pushes and clears timer when reverting to committed text", () => {
	const clock = createFakeClock();
	const committed: string[] = [];
	const throttle = createStreamingTextThrottle({
		intervalMs: 75,
		now: clock.now,
		schedule: clock.schedule,
		cancel: clock.cancel,
		onCommit: (text) => committed.push(text),
	});

	throttle.push("Hello", false, "m1:t0");
	assert.deepEqual(committed, ["Hello"]);

	// Unchanged non-streaming push after the window should not push out the next commit.
	clock.advance(100);
	throttle.push("Hello", false, "m1:t0");
	clock.advance(5);
	throttle.push("Hello!", true, "m1:t0");
	assert.deepEqual(committed, ["Hello", "Hello!"]);

	// Pending trailing text cleared if value returns to the already committed text.
	clock.advance(10);
	throttle.push("Hello! more", true, "m1:t0");
	assert.equal(clock.pendingCount(), 1);
	throttle.push("Hello!", true, "m1:t0");
	assert.equal(clock.pendingCount(), 0);
	clock.advance(100);
	assert.deepEqual(committed, ["Hello", "Hello!"]);
});
