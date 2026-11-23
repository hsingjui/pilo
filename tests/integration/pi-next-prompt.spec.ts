import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
	new URL(
		"../../crates/pilo-server/extensions/next-prompt.js",
		import.meta.url,
	),
	"utf8",
).replace("export default function (pi)", "function install(pi)");

type Response = {
	stopReason: string;
	content: { type: string; text: string }[];
};
type Result = { requestId: string; text: string | null; status: string };

function loadExtension() {
	const handlers = new Map<
		string,
		(event: { aborted?: boolean }, ctx: unknown) => void
	>();
	const commands = new Map<
		string,
		(args: string, ctx: unknown) => Promise<void>
	>();
	const timers = new Map<number, () => void>();
	const results: Result[] = [];
	const response = Promise.withResolvers<Response>();
	let timerId = 0;
	let calls = 0;
	let signal: AbortSignal | undefined;
	const ctx = {
		mode: "rpc",
		isIdle: () => true,
		model: { provider: "mock", id: "model" },
		ui: {
			setWidget: (key: string, lines: string[]) => {
				if (key !== "pilo.next-prompt.v1") return;
				const { requestId, text, status }: Result = JSON.parse(lines[0]);
				results.push({ requestId, text, status });
			},
		},
		sessionManager: {
			getSessionId: () => "session",
			getLeafId: () => "leaf",
			getBranch: () => [
				{
					type: "message",
					message: { role: "assistant", stopReason: "stop" },
				},
			],
			buildSessionProjection: () => ({ entries: [] }),
		},
		modelRegistry: {
			hasConfiguredAuth: () => true,
			streamSimple: (
				_model: unknown,
				_context: unknown,
				options: { signal: AbortSignal },
			) => {
				calls++;
				signal = options.signal;
				// Deliberately ignore abort: the caller must enforce its own deadline.
				return { result: () => response.promise };
			},
		},
	};
	runInNewContext(`${source}\ninstall(pi);`, {
		AbortController,
		setTimeout: (callback: () => void, delay: number) => {
			assert.equal(delay, 15_000);
			timers.set(++timerId, callback);
			return timerId;
		},
		clearTimeout: (id: number) => timers.delete(id),
		pi: {
			on: (
				name: string,
				handler: (event: { aborted?: boolean }, ctx: unknown) => void,
			) => handlers.set(name, handler),
			registerCommand: (
				name: string,
				spec: { handler: (args: string, ctx: unknown) => Promise<void> },
			) => commands.set(name, spec.handler),
		},
	});
	const emit = (event: string) => {
		const handler = handlers.get(event);
		assert.ok(handler);
		handler({}, ctx);
	};
	emit("agent_settled");
	return {
		results,
		response,
		timers,
		emit,
		get calls() {
			return calls;
		},
		get signal() {
			return signal;
		},
		request: (requestId: string, cancel = false) => {
			const command = commands.get("pilo-next-prompt");
			assert.ok(command);
			return command(
				JSON.stringify({
					requestId,
					sessionId: "session",
					revision: 1,
					model: null,
					cancel,
				}),
				ctx,
			);
		},
		expire: async () => {
			for (const callback of timers.values()) callback();
			await setImmediate();
		},
	};
}

const ready: Response = {
	stopReason: "stop",
	content: [{ type: "text", text: "run the tests" }],
};

test("prediction timeout answers all subscribers without waiting for abort", async () => {
	const extension = loadExtension();
	await extension.request("one");
	await extension.request("two");
	assert.equal(extension.calls, 1);
	await extension.expire();
	assert.equal(extension.signal?.aborted, true);
	assert.deepEqual(extension.results, [
		{ requestId: "one", text: null, status: "unavailable" },
		{ requestId: "two", text: null, status: "unavailable" },
	]);
	assert.equal(extension.timers.size, 0);

	// A timed-out job is complete, including for clients joining afterwards.
	await extension.request("three");
	assert.equal(extension.results[2].status, "unavailable");
	assert.equal(extension.calls, 1);
	extension.response.resolve(ready);
	await setImmediate();
	assert.equal(extension.results.length, 3, "late success must not publish");
});

test("prediction timeout also answers when the provider honors abort", async () => {
	const extension = loadExtension();
	await extension.request("one");
	extension.signal?.addEventListener("abort", () => {
		extension.response.resolve({ stopReason: "aborted", content: [] });
	});
	await extension.expire();
	assert.deepEqual(extension.results, [
		{ requestId: "one", text: null, status: "unavailable" },
	]);
});

test("late prediction failure does not publish again after timeout", async () => {
	const extension = loadExtension();
	await extension.request("one");
	await extension.expire();
	assert.equal(extension.results.length, 1);
	extension.response.reject(new Error("late provider failure"));
	await setImmediate();
	assert.equal(extension.results.length, 1);
	assert.equal(extension.results[0].status, "unavailable");
});

test("prediction timeout excludes a cancelled subscriber", async () => {
	const extension = loadExtension();
	await extension.request("one");
	await extension.request("two");
	await extension.request("one", true);
	assert.equal(extension.signal?.aborted, false);
	await extension.expire();
	assert.deepEqual(extension.results, [
		{ requestId: "two", text: null, status: "unavailable" },
	]);
});

test("last-subscriber cancellation stays silent even when abort is ignored", async () => {
	const extension = loadExtension();
	await extension.request("one");
	await extension.request("one", true);
	assert.equal(extension.signal?.aborted, true);
	await extension.expire();
	assert.deepEqual(extension.results, []);
});

test("compaction invalidates prediction without a later timeout result", async () => {
	const extension = loadExtension();
	await extension.request("one");
	extension.emit("session_before_compact");
	assert.equal(extension.signal?.aborted, true);
	assert.equal(extension.results[0].status, "cancelled");
	await extension.expire();
	extension.response.resolve(ready);
	await setImmediate();
	assert.equal(extension.results.length, 1);
	await extension.request("stale");
	assert.equal(extension.results[1].status, "cancelled");
});

test("prediction completing before the deadline clears its timer", async () => {
	const extension = loadExtension();
	await extension.request("one");
	extension.response.resolve(ready);
	await setImmediate();
	assert.deepEqual(extension.results, [
		{ requestId: "one", text: "run the tests", status: "ready" },
	]);
	assert.equal(extension.timers.size, 0);
	assert.equal(extension.signal?.aborted, false);
});
