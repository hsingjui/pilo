import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
	new URL(
		"../../crates/pilo-server/extensions/stream-guard.js",
		import.meta.url,
	),
	"utf8",
).replace("export default function (pi)", "function install(pi)");

type Message = {
	role: string;
	stopReason: string;
	errorMessage?: string;
	content: { type: string; text?: string }[];
};
type Context = { signal: AbortSignal; abort: () => void };
type Handler = (
	event: { message?: Message },
	ctx: Context,
) => { message: Message } | undefined;

function loadExtension(timeout?: string) {
	const handlers = new Map<string, Handler>();
	const timers = new Map<number, { at: number; callback: () => void }>();
	let now = 0;
	let sequence = 0;
	let aborts = 0;
	let controller = new AbortController();
	const ctx = {
		get signal() {
			return controller.signal;
		},
		abort: () => {
			aborts++;
			controller.abort();
		},
	};
	runInNewContext(`${source}\ninstall(pi);`, {
		process: { env: { PILO_MODEL_STREAM_IDLE_TIMEOUT_MS: timeout } },
		setTimeout: (callback: () => void, delay: number) => {
			timers.set(++sequence, { at: now + delay, callback });
			return sequence;
		},
		clearTimeout: (id: number) => timers.delete(id),
		pi: {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
		},
	});
	const emit = (name: string, eventMessage?: Message) =>
		handlers.get(name)?.({ message: eventMessage }, ctx);
	return {
		emit,
		timers,
		get aborts() {
			return aborts;
		},
		get signal() {
			return controller.signal;
		},
		start: () => {
			controller = new AbortController();
			emit("before_agent_start");
			emit("agent_start");
			emit("before_provider_request");
		},
		continue: () => {
			controller = new AbortController();
			emit("agent_start");
			emit("before_provider_request");
		},
		advance: (milliseconds: number) => {
			now += milliseconds;
			for (const [id, timer] of timers) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.callback();
			}
		},
		cancel: () => controller.abort(),
	};
}

function message(stopReason = "aborted"): Message {
	return {
		role: "assistant",
		stopReason,
		errorMessage:
			"OpenAI Responses stream ended before a terminal response event",
		content: [{ type: "text", text: "preserve partial response" }],
	};
}

test("stalled request is cancelled even before headers or message_start", () => {
	const extension = loadExtension();
	assert.equal(extension.timers.size, 0, "factory must not start timers");
	extension.start();
	extension.advance(119_999);
	assert.equal(extension.aborts, 0);
	extension.advance(1);
	assert.equal(extension.aborts, 1);
	assert.equal(extension.signal.aborted, true);
	const original = message();
	const replacement = extension.emit("message_end", original)?.message;
	assert.equal(replacement?.stopReason, "error");
	assert.match(replacement?.errorMessage ?? "", /^PILO_STREAM_STALLED:/);
	assert.match(replacement?.errorMessage ?? "", /120000 ms/);
	assert.equal(replacement?.content, original.content);
	assert.equal(original.stopReason, "aborted", "return a replacement message");
	assert.equal(extension.timers.size, 0);
});

test("automatic retries rearm the guard without another before_agent_start", () => {
	const extension = loadExtension();
	extension.start();
	extension.advance(100_000);
	const failure = { ...message("error"), errorMessage: "503 overloaded" };
	assert.equal(extension.emit("message_end", failure), undefined);
	extension.emit("agent_end");
	extension.advance(600_000);
	assert.equal(extension.aborts, 0, "retry backoff must not count as a stall");
	extension.continue();
	assert.equal(extension.timers.size, 1, "the retry request must be watched");
	extension.advance(119_999);
	assert.equal(extension.aborts, 0);
	extension.advance(1);
	assert.equal(extension.aborts, 1);
	assert.equal(extension.signal.aborted, true);
	const original = message();
	const replacement = extension.emit("message_end", original)?.message;
	assert.equal(replacement?.stopReason, "error");
	assert.match(replacement?.errorMessage ?? "", /^PILO_STREAM_STALLED:/);
	assert.equal(replacement?.content, original.content);
});

test("pre-settlement continuations get a fresh idle deadline", () => {
	const extension = loadExtension();
	extension.start();
	extension.emit("message_end", message("stop"));
	extension.emit("agent_end");
	extension.advance(600_000);
	extension.continue();
	assert.equal(extension.timers.size, 1);
	extension.advance(100_000);
	extension.emit("provider_stream_event");
	extension.advance(100_000);
	assert.equal(
		extension.aborts,
		0,
		"continuation progress renews the deadline",
	);
	extension.advance(20_000);
	assert.equal(extension.aborts, 1);
});

test("requests outside agent execution never start the guard", () => {
	const extension = loadExtension();
	for (const phase of ["session_start", "before_agent_start", "agent_end"]) {
		extension.emit(phase);
		extension.emit("before_provider_request");
		extension.emit("provider_stream_event");
		extension.emit("message_update");
		extension.advance(600_000);
		assert.equal(extension.timers.size, 0, phase);
		assert.equal(extension.aborts, 0, phase);
	}
});

test("raw provider events and normalized updates extend only the idle deadline", () => {
	for (const event of ["provider_stream_event", "message_update"]) {
		const extension = loadExtension();
		extension.start();
		for (let i = 0; i < 5; i++) {
			extension.advance(100_000);
			extension.emit(event);
		}
		assert.equal(extension.aborts, 0, "long active requests must not time out");
		assert.equal(extension.timers.size, 1);
		extension.advance(120_000);
		assert.equal(extension.aborts, 1);
	}
});

test("completed assistant messages disarm the guard during long tools and idle", () => {
	const extension = loadExtension();
	extension.start();
	assert.equal(extension.emit("message_end", message("toolUse")), undefined);
	extension.advance(600_000);
	assert.equal(extension.aborts, 0);
	extension.emit("provider_stream_event");
	assert.equal(
		extension.timers.size,
		0,
		"background events must not arm the guard",
	);
	extension.emit("before_provider_request");
	extension.advance(120_000);
	assert.equal(extension.aborts, 1, "the next model request is guarded");
});

test("tool result messages cannot disarm an active model request", () => {
	const extension = loadExtension();
	extension.start();
	extension.emit("message_end", { ...message("stop"), role: "toolResult" });
	extension.advance(120_000);
	assert.equal(extension.aborts, 1);
});

test("manual cancellation stays aborted and does not become a stream failure", () => {
	const extension = loadExtension();
	extension.start();
	extension.cancel();
	extension.advance(600_000);
	extension.emit("provider_stream_event");
	assert.equal(extension.timers.size, 0);
	assert.equal(extension.aborts, 0);
	assert.equal(extension.emit("message_end", message()), undefined);
});

test("late events cannot rearm a timed-out request or poison a new turn", () => {
	const extension = loadExtension();
	extension.start();
	extension.advance(120_000);
	extension.emit("message_update");
	extension.emit("provider_stream_event");
	assert.equal(extension.timers.size, 0);
	extension.emit("message_end", message());
	extension.emit("agent_end");
	extension.start();
	assert.equal(extension.emit("message_end", message("stop")), undefined);
	extension.advance(120_000);
	assert.equal(extension.aborts, 1);
});

test("session lifecycle cleanup removes timers and ignores background requests", () => {
	for (const event of [
		"agent_end",
		"session_start",
		"session_switch",
		"session_shutdown",
	]) {
		const extension = loadExtension();
		extension.start();
		extension.emit(event);
		extension.emit("before_provider_request");
		extension.advance(120_000);
		assert.equal(extension.timers.size, 0);
		assert.equal(extension.aborts, 0);
		assert.equal(extension.emit("message_end", message()), undefined);
	}
});

test("ordinary provider errors are not replaced with a stalled-stream error", () => {
	const extension = loadExtension();
	extension.start();
	const original = message("error");
	assert.equal(extension.emit("message_end", original), undefined);
	extension.advance(120_000);
	assert.equal(extension.aborts, 0);
});

test("idle timeout accepts bounded positive milliseconds and rejects invalid values", () => {
	const custom = loadExtension("5000");
	custom.start();
	custom.advance(4999);
	assert.equal(custom.aborts, 0);
	custom.advance(1);
	assert.equal(custom.aborts, 1);
	for (const value of ["", "0", "-1", "NaN", "Infinity", "1.5", "2147483648"]) {
		const extension = loadExtension(value);
		extension.start();
		extension.advance(119_999);
		assert.equal(extension.aborts, 0, value);
		extension.advance(1);
		assert.equal(extension.aborts, 1, value);
	}
});
