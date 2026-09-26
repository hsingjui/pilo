import assert from "node:assert/strict";
import test from "node:test";

import type { ChatSessionRuntimeState } from "../src/lib/chat-session-client.ts";
import {
	findReusableChatRuntime,
	runtimeSessionIdFromKey,
} from "../src/lib/chat-session-runtime-model.ts";

function runtime(
	sessionKey: string,
	sessionPath: string,
	state: ChatSessionRuntimeState["snapshot"]["state"] = "running",
): ChatSessionRuntimeState {
	return {
		sessionKey,
		projectId: "project-1",
		sessionPath,
		prepared: true,
		initialized: true,
		activeTurn: true,
		snapshot: {
			generation: 1,
			state,
			connection: null,
			projectId: "project-1",
		},
	};
}

test("reuses the Host runtime that already owns an indexed session path", () => {
	const draftRuntime = runtime(
		JSON.stringify(["project-1", "draft-runtime-id"]),
		"/sessions/real-session.jsonl",
	);
	const reusable = findReusableChatRuntime(
		[draftRuntime],
		"project-1",
		"/sessions/real-session.jsonl",
	);
	assert.equal(reusable?.sessionKey, draftRuntime.sessionKey);
	assert.equal(
		runtimeSessionIdFromKey(reusable!.sessionKey, "project-1"),
		"draft-runtime-id",
	);
});

test("does not reuse stopped runtimes or keys from another project", () => {
	const stopped = runtime(
		JSON.stringify(["project-1", "stopped-id"]),
		"/sessions/a.jsonl",
		"stopped",
	);
	assert.equal(
		findReusableChatRuntime([stopped], "project-1", "/sessions/a.jsonl"),
		null,
	);
	assert.equal(
		runtimeSessionIdFromKey(
			JSON.stringify(["project-2", "runtime-id"]),
			"project-1",
		),
		null,
	);
});
