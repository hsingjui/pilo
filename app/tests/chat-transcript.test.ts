import { expect, test } from "nsh/test";

import type { PiloRuntimeEvent } from "@shared/api/pi-runtime-types";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import { replayConversationEvents } from "@shared/chat/conversation-replay";
import type {
	ConversationReducerContext,
	ConversationState,
} from "@shared/chat/conversation-types";
import { initializeI18n, setAppLocale } from "../shell/i18n";
import type { ChatTranscriptSnapshot } from "../client/nsh-pilo-client";
import {
	applyChatEvents,
	conversationFromSnapshot,
	followsSnapshot,
} from "../state/chat-transcript";
// One real Pi turn (relay/deepseek-flash: a bash tool call, then text),
// recorded through `NshPiloClient` on the native module. `cut` is the
// snapshot taken right after the tool finished, `settled` the one taken when
// the turn was over, and `streamed` every event the listener received from
// the prompt to the end of the turn, including those of no chat. The
// payloads are as received; only the events before that prompt are left out.
import recording from "./chat-transcript-recording.json";

const cut = recording.cut as unknown as ChatTranscriptSnapshot;
const settled = recording.settled as unknown as ChatTranscriptSnapshot;
const streamed = recording.streamed as unknown as PiloClientEvent[];

function context(): ConversationReducerContext {
	let id = 0;
	return {
		createMessageId: (kind) => `${kind}-${++id}`,
		createContentId: (kind) => `${kind}-${++id}`,
		now: () => 0,
		formatTime: () => "00:00",
	};
}

/**
 * What a transcript shows, without the parts that differ between a streamed
 * message and the same message read from the session file: ids, times, and
 * the tool result's bookkeeping fields.
 */
function shown(conversation: ConversationState | null) {
	return conversation?.messages.map((message) =>
		message.role === "assistant"
			? {
					role: message.role,
					text: message.text,
					streaming: message.streaming,
					completion: message.completion,
					stopReason: message.stopReason,
					usage: message.usage,
					content: message.content?.map((item) =>
						item.type === "tool"
							? {
									type: item.type,
									id: item.id,
									toolName: item.toolName,
									args: item.args,
									status: item.status,
									isError: item.isError,
									output: (item.result as { content?: unknown } | undefined)
										?.content,
								}
							: { type: item.type, text: item.text },
					),
				}
			: { role: message.role, text: message.text },
	);
}

const chat = { sessionKey: "k1", projectId: "p1", generation: 1 };
const snapshot = (
	live: ChatTranscriptSnapshot["live"],
	eventSequence = 10,
): ChatTranscriptSnapshot => ({
	eventSequence,
	sessionKey: chat.sessionKey,
	generation: chat.generation,
	history: {
		history: {
			events: [{ type: "user_message_start", text: "saved question" }],
		} as ChatTranscriptSnapshot["history"]["history"],
		fingerprint: null,
	},
	live,
});
const texts = (conversation: ConversationState | null) =>
	conversation?.messages.map((message) => message.text);

test("a recorded Pi turn replayed from its mid-turn snapshot equals its settled history", () => {
	// The recording has what the rule must handle: a snapshot of a running
	// turn, events the snapshot already holds, and events after it.
	expect(cut.live.type).toBe("active");
	expect(settled.live.type).toBe("idle");
	expect(streamed.some((event) => event.sequence <= cut.eventSequence)).toBe(
		true,
	);
	expect(streamed.some((event) => event.sequence > cut.eventSequence)).toBe(
		true,
	);

	const replayed = conversationFromSnapshot(cut, streamed, context());
	const expected = replayConversationEvents(
		settled.history.history.events,
		context(),
	);

	expect(replayed?.active).toBe(null);
	expect(shown(replayed)).toEqual(shown(expected));
	// Both turns, and the second with its tool call followed by text.
	expect(shown(replayed)?.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"user",
		"assistant",
	]);
	expect(
		shown(replayed)
			?.at(-1)
			?.content?.map((item) => item.type),
	).toEqual(["tool", "text"]);
});

test("the recorded mid-turn snapshot alone shows the turn still running", () => {
	const conversation = conversationFromSnapshot(cut, [], context());
	const reply = shown(conversation)?.at(-1);

	expect(conversation?.active === null).toBe(false);
	expect(reply?.streaming).toBe(true);
	// The tool has finished and the text after it has not started.
	expect(reply?.content?.map((item) => item.status ?? item.type)).toEqual([
		"complete",
	]);
});

test("recorded events apply the same in one batch or as they arrived", () => {
	const later = streamed.filter((event) => followsSnapshot(cut, event));
	let conversation = conversationFromSnapshot(cut, [], context());
	for (const event of later) {
		conversation =
			conversation && applyChatEvents(conversation, [event], context());
	}

	expect(shown(conversation)).toEqual(
		shown(conversationFromSnapshot(cut, streamed, context())),
	);
});

test("an idle snapshot is its saved history", () => {
	expect(
		texts(conversationFromSnapshot(snapshot({ type: "idle" }), [], context())),
	).toEqual(["saved question"]);
});

test("a truncated snapshot gives no conversation", () => {
	const later: PiloClientEvent = {
		...chat,
		type: "user_message_start",
		text: "new question",
		sequence: 11,
	};
	expect(
		conversationFromSnapshot(
			snapshot({ type: "truncated" }),
			[later],
			context(),
		),
	).toBe(null);
});

test("only later events of the same chat and Pi process follow a snapshot", () => {
	const delta = (
		sequence: number,
		text: string,
		from: Partial<typeof chat> = {},
	): PiloClientEvent => ({
		...chat,
		...from,
		type: "assistant_text_delta",
		delta: text,
		sequence,
	});
	const live: PiloRuntimeEvent[] = [
		{ ...chat, type: "user_message_start", text: "new question" },
		{ ...chat, type: "assistant_message_start" },
		{ ...chat, type: "assistant_text_delta", delta: "one" },
	];
	const conversation = conversationFromSnapshot(
		snapshot({ type: "active", events: live }),
		[
			// Already in the snapshot.
			delta(9, " stale"),
			delta(10, " at the cut"),
			delta(11, " two"),
			delta(12, " other chat", { sessionKey: "k2" }),
			delta(13, " old process", { generation: 0 }),
			{ type: "configuration_changed", sequence: 14 },
			delta(15, " three"),
		],
		context(),
	);

	expect(texts(conversation)).toEqual([
		"saved question",
		"new question",
		"one two three",
	]);
});

test("events without transcript content leave the conversation as it is", () => {
	const conversation = replayConversationEvents(
		[{ type: "user_message_start", text: "question" }],
		context(),
	);
	expect(
		applyChatEvents(
			conversation,
			[
				{ ...chat, type: "queue_update", steering: [], followUp: [] },
				{ type: "sessions_indexed", projectId: "p1" },
			],
			context(),
		),
	).toBe(conversation);
});

test("text the WebUI reducer writes follows the desktop app's language", async () => {
	const failedReply = () => {
		const reply = applyChatEvents(
			replayConversationEvents([], context()),
			[
				{ ...chat, type: "user_message_start", text: "question" },
				{ ...chat, type: "assistant_message_start" },
				{
					...chat,
					type: "assistant_message_end",
					stopReason: "error",
					errorMessage: null,
					usage: null,
				},
			],
			context(),
		).messages.at(-1);
		return reply?.role === "assistant" ? reply.errorMessage : undefined;
	};

	initializeI18n("zh-CN");
	expect(failedReply()).toBe("Pi 返回了错误结果。");
	setAppLocale("en-US");
	expect(failedReply()).toBe("Pi returned an error result.");
});
