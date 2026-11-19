import { replayConversationEvents } from "@/lib/chat/conversation-replay";
import type {
	ConversationEvent,
	ConversationReducerContext,
	ConversationState,
} from "@/lib/chat/conversation-types";

/** Conversations for the chat fixtures, built by the shared reducer. */

export const startedAt = Date.UTC(2026, 10, 20, 9, 0);

export function context(): ConversationReducerContext {
	let id = 0;
	return {
		createMessageId: (kind) => `${kind}-${++id}`,
		createContentId: (kind) => `${kind}-${++id}`,
		now: () => startedAt,
		formatTime: (timestampMs) =>
			new Date(timestampMs).toISOString().slice(11, 16),
	};
}

/** A settled turn: a prompt and its reply. */
export function turn(
	index: number,
	prompt: string,
	reply: string,
	end: Partial<Extract<ConversationEvent, { type: "assistant_turn_end" }>> = {},
): ConversationEvent[] {
	const timestampMs = startedAt + index * 60_000;
	return [
		{ type: "user_message_start", text: prompt, timestampMs },
		{ type: "assistant_message_start", timestampMs },
		{ type: "assistant_text_delta", delta: reply, timestampMs },
		{ type: "assistant_turn_end", stopReason: "stop", timestampMs, ...end },
	];
}

/**
 * A chat of `count` messages. The reducer copies the messages for every
 * event, so a long chat is built in parts: no single call into JS runs long.
 */
export async function long(
	count: number,
	reducer = context(),
): Promise<ConversationState> {
	let conversation = replayConversationEvents([], reducer);
	const turns = count / 2;
	for (let first = 0; first < turns; first += 500) {
		const events: ConversationEvent[] = [];
		for (let index = first; index < Math.min(first + 500, turns); index++) {
			events.push(
				...turn(index, `Question ${index + 1}`, `Answer ${index + 1}`),
			);
		}
		conversation = replayConversationEvents(events, reducer, conversation);
		await new Promise((resolve) => setTimeout(resolve));
	}
	return conversation;
}
