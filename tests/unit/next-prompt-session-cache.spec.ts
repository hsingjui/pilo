import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { PiloClient } from "../../shared/api/pilo-client.ts";
import type {
	PiAgentState,
	PiModel,
	PiloRuntimeEvent,
} from "../../shared/api/pi-runtime-types.ts";
import type {
	NextPromptRequest,
	NextPromptSettings,
} from "../../shared/next-prompt.ts";
import {
	createNextPromptSessionCache,
	type NextPromptSessionOptions,
} from "../../shared/chat/next-prompt-session-cache.ts";

const model: PiModel = {
	provider: "test",
	id: "model",
	name: "Test model",
	reasoning: false,
};
const settings: NextPromptSettings = {
	connectionId: "connection",
	enabled: true,
	model: null,
	updatedAtMs: 1,
};

function agentState(sessionKey: string): PiAgentState {
	return {
		sessionId: `session-${sessionKey}`,
		model,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		messageCount: 2,
		pendingMessageCount: 0,
	};
}

function completion(sessionKey: string): PiloRuntimeEvent {
	return {
		type: "assistant_message_end",
		sessionKey,
		generation: 1,
		stopReason: "stop",
		errorMessage: null,
	};
}

function result(
	request: NextPromptRequest,
	text = "Next step",
): Extract<PiloRuntimeEvent, { type: "extension_ui_request" }> {
	return {
		type: "extension_ui_request",
		sessionKey: request.sessionKey,
		generation: request.generation,
		id: request.requestId,
		method: "setWidget",
		title: null,
		message: null,
		options: [],
		placeholder: null,
		prefill: null,
		timeout: null,
		notifyType: null,
		statusKey: null,
		statusText: null,
		widgetKey: "pilo.next-prompt.v1",
		widgetLines: [
			JSON.stringify({
				requestId: request.requestId,
				sessionId: request.sessionId,
				leafId: "leaf",
				revision: request.revision,
				status: "ready",
				text,
			}),
		],
		widgetPlacement: null,
		text: null,
	};
}

function unexpectedCall(): never {
	assert.fail("Unexpected PiloClient call");
}

function setup(t: TestContext) {
	t.mock.method(console, "info", () => {});
	const requests: NextPromptRequest[] = [];
	const client: PiloClient = {
		bootstrap: unexpectedCall,
		listSessions: unexpectedCall,
		loadSessionReadStates: unexpectedCall,
		markSessionRead: unexpectedCall,
		searchSessions: unexpectedCall,
		loadHistory: unexpectedCall,
		readHistoryImage: unexpectedCall,
		readProjectImage: unexpectedCall,
		generateSessionTitle: unexpectedCall,
		deleteSession: unexpectedCall,
		archiveSession: unexpectedCall,
		unarchiveSession: unexpectedCall,
		loadModels: unexpectedCall,
		loadModelScope: unexpectedCall,
		saveModelScope: unexpectedCall,
		loadCacheKeepAliveSettings: unexpectedCall,
		saveCacheKeepAliveSettings: unexpectedCall,
		loadNextPromptSettings: unexpectedCall,
		saveNextPromptSettings: unexpectedCall,
		requestNextPrompt: async (request) => {
			requests.push({ ...request });
		},
		startChat: unexpectedCall,
		stopChat: unexpectedCall,
		chatState: unexpectedCall,
		sendChatCommand: unexpectedCall,
		connectEvents: unexpectedCall,
	};
	const getSessionState = t.mock.fn(async (sessionKey: string) =>
		agentState(sessionKey),
	);
	const cache = createNextPromptSessionCache();
	cache.setTransport(client, "0", true);
	t.after(() => cache.clear("test_cleanup"));
	const options = (
		sessionKey: string,
		overrides: Partial<NextPromptSessionOptions> = {},
	): NextPromptSessionOptions => ({
		client,
		connectionId: settings.connectionId,
		sessionKey,
		sessionId: `session-${sessionKey}`,
		draft: "",
		hasAttachments: false,
		active: true,
		busy: false,
		blocked: false,
		model,
		connected: true,
		getSessionState,
		...overrides,
	});
	const generated = () => requests.filter((request) => !request.cancel);
	const cancelled = () => requests.filter((request) => request.cancel);
	const settle = async (sessionKey: string) => {
		const count = generated().length;
		cache.handleEvent(completion(sessionKey));
		await Promise.resolve();
		assert.equal(generated().length, count + 1);
		const request = generated().at(-1);
		assert.ok(request);
		assert.equal(request.sessionKey, sessionKey);
		return request;
	};
	return {
		cache,
		client,
		options,
		getSessionState,
		generated,
		cancelled,
		settle,
	};
}

test("mounting, hydration and replay do not generate predictions", async (t) => {
	const { cache, options, getSessionState, generated, settle } = setup(t);
	const a = options("a");
	cache.update(a, settings, false);
	cache.update({ ...a, loading: true, sessionId: null }, settings, false);
	cache.update(a, settings, false);
	cache.handleEvent(completion("a"), false);
	await Promise.resolve();
	assert.equal(getSessionState.mock.callCount(), 0);
	assert.deepEqual(generated(), []);

	const request = await settle("a");
	assert.equal(getSessionState.mock.calls[0].arguments[0], "a");
	assert.equal(request.sessionId, a.sessionId);
	assert.equal(request.revision, settings.updatedAtMs);
});

test("a session that settles after selection changes retains its result through hydration", async (t) => {
	const { cache, options, generated, cancelled, settle } = setup(t);
	const a = options("a", { busy: true });
	const b = options("b");
	cache.update(a, settings, false);
	cache.update({ ...a, active: false }, settings, false);
	cache.update(b, settings, false);
	const request = await settle("a");
	cache.handleEvent(result(request, "Continue A"));
	assert.equal(cache.getResult(b), null);
	assert.equal(cache.getResult({ ...a, active: false, busy: false }), null);

	const returning = { ...a, busy: false, loading: true, sessionId: null };
	cache.update(returning, settings, false);
	assert.equal(cache.getResult(returning), null);
	const hydrated = { ...a, busy: false };
	cache.update(hydrated, settings, false);
	assert.deepEqual(cache.getResult(hydrated), {
		text: "Continue A",
		unavailable: false,
	});
	assert.equal(generated().length, 1);
	assert.deepEqual(cancelled(), []);
});

test("switching repeatedly while pending or ready neither cancels nor regenerates", async (t) => {
	const { cache, options, generated, cancelled, settle } = setup(t);
	const a = options("a");
	const b = options("b");
	cache.update(a, settings, false);
	const request = await settle("a");
	for (const selection of [b, a, b]) cache.update(selection, settings, false);
	assert.deepEqual(cancelled(), []);
	cache.handleEvent(result(request, "Continue A"));
	for (const selection of [a, b, a]) cache.update(selection, settings, false);
	assert.equal(cache.getResult(a)?.text, "Continue A");
	assert.equal(cache.getResult(b), null);
	assert.equal(generated().length, 1);
	assert.deepEqual(cancelled(), []);
});

for (const action of ["typing", "attachments", "escape"] as const) {
	test(`${action} in B cancels only B and ignores its late result`, async (t) => {
		const { cache, options, cancelled, settle } = setup(t);
		const a = options("a");
		const b = options("b");
		cache.update(a, settings, false);
		const requestA = await settle("a");
		cache.update(b, settings, false);
		const requestB = await settle("b");
		if (action === "escape") cache.dismiss("b");
		else
			cache.update(
				{
					...b,
					draft: action === "typing" ? "My own prompt" : "",
					hasAttachments: action === "attachments",
				},
				settings,
				false,
			);
		assert.deepEqual(cancelled(), [{ ...requestB, cancel: true }]);
		cache.handleEvent(result(requestB, "Stale B"));
		cache.handleEvent(result(requestA, "Continue A"));
		cache.update(b, settings, false);
		assert.equal(cache.getResult(b), null);
		assert.equal(cache.getResult(a)?.text, "Continue A");
	});
}

for (const reason of ["disconnect", "resync"] as const) {
	test(`${reason} clears ready and pending work without restoring replayed results`, async (t) => {
		const { cache, client, options, generated, cancelled, settle } = setup(t);
		const a = options("a");
		const b = options("b");
		cache.update(a, settings, false);
		const requestA = await settle("a");
		cache.handleEvent(result(requestA, "Continue A"));
		cache.update(b, settings, false);
		const requestB = await settle("b");
		if (reason === "disconnect") cache.setTransport(client, "0", false);
		else cache.invalidate("transport_resync");
		assert.deepEqual(cancelled(), [
			{ ...requestA, cancel: true },
			{ ...requestB, cancel: true },
		]);
		assert.equal(cache.getResult(a), null);
		assert.equal(cache.getResult(b), null);
		if (reason === "disconnect") {
			cache.handleEvent(completion("a"));
			await Promise.resolve();
			assert.equal(generated().length, 2);
		}
		cache.setTransport(client, "1", true);
		cache.handleEvent(result(requestA));
		cache.handleEvent(result(requestB));
		cache.handleEvent(completion("a"), false);
		await Promise.resolve();
		assert.equal(cache.getResult(a), null);
		assert.equal(cache.getResult(b), null);
		assert.equal(generated().length, 2);

		const fresh = await settle("a");
		assert.notEqual(fresh.requestId, requestA.requestId);
		cache.handleEvent(result(requestA));
		assert.equal(cache.getResult(a), null);
		cache.handleEvent(result(fresh, "Fresh A"));
		assert.equal(cache.getResult(a)?.text, "Fresh A");
	});
}

test("background draft startup resolves the live identity before requesting", async (t) => {
	const { cache, options, generated, cancelled } = setup(t);
	const state = Promise.withResolvers<PiAgentState>();
	const a = options("a", {
		sessionId: null,
		model: null,
		getSessionState: () => state.promise,
	});
	cache.update(a, settings, false);
	cache.handleEvent(completion("a"));
	cache.update(options("b"), settings, false);
	assert.deepEqual(generated(), []);
	state.resolve(agentState("a"));
	await Promise.resolve();
	const [request] = generated();
	assert.ok(request);
	assert.equal(request.sessionKey, "a");
	assert.equal(request.sessionId, "session-a");
	cache.handleEvent(result(request, "Continue A"));
	cache.update({ ...a, sessionId: "session-a", model }, settings, false);
	assert.equal(cache.getResult(options("a"))?.text, "Continue A");
	assert.deepEqual(cancelled(), []);
});

test("dismissal during the state lookup prevents a late prediction request", async (t) => {
	const { cache, options, generated, cancelled } = setup(t);
	const state = Promise.withResolvers<PiAgentState>();
	const a = options("a", { getSessionState: () => state.promise });
	cache.update(a, settings, false);
	cache.handleEvent(completion("a"));
	cache.dismiss("a");
	state.resolve(agentState("a"));
	await Promise.resolve();
	assert.deepEqual(generated(), []);
	assert.deepEqual(cancelled(), []);
	assert.equal(cache.getResult(a), null);
});

test("results must match request, session, generation and settings revision", async (t) => {
	const { cache, options, settle } = setup(t);
	const a = options("a");
	cache.update(a, settings, false);
	const request = await settle("a");
	for (const stale of [
		{ ...request, requestId: "old-request" },
		{ ...request, sessionId: "old-session" },
		{ ...request, generation: request.generation + 1 },
		{ ...request, revision: request.revision + 1 },
	]) {
		cache.handleEvent(result(stale));
		assert.equal(cache.getResult(a), null);
	}
	cache.handleEvent(result(request, "Current result"));
	assert.equal(cache.getResult(a)?.text, "Current result");
});
