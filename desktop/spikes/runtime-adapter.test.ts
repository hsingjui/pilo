// M0 spike 4: live runtime events reduce through the shared runtime adapter.
// `nsh check` types the adapter through `types/conversation-runtime-adapter.d.ts`.
import { expect, test } from "nsh/test";

import {
	createConversationState,
	reduceConversation,
} from "@/lib/chat/conversation-reducer";
import { toConversationAction } from "@/lib/chat/conversation-runtime-adapter";
import { reducerContext } from "../src/reducer-context";

test("live runtime events reduce through the runtime adapter", () => {
	const live = [
		{ type: "assistant_message_start", generation: 1 },
		{ type: "assistant_text_delta", generation: 1, delta: "hel" },
		{ type: "assistant_text_delta", generation: 1, delta: "lo" },
		{
			type: "assistant_message_end",
			generation: 1,
			stopReason: "stop",
			errorMessage: null,
			usage: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, total: 10 },
		},
	];
	const ctx = reducerContext(() => 10_000);
	let state = reduceConversation(
		createConversationState(),
		{
			type: "local_user_submit",
			clientMessageId: "u1",
			text: "hi",
			timestampMs: 1,
		},
		ctx,
	);
	state = reduceConversation(
		state,
		{ type: "local_assistant_pending", timestampMs: 1 },
		ctx,
	);
	for (const event of live) {
		const action = toConversationAction(event);
		if (action) state = reduceConversation(state, action, ctx);
	}
	expect(state.messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
	]);
	expect(state.messages[1]?.text).toBe("hello");
});
