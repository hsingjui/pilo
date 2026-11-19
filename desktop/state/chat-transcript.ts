import { alignHistoryMessages } from "@/components/chat/chat-history-window-model";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime-types";
import type { PiloClientEvent } from "@/lib/api/pilo-client";
import type { SessionHistory } from "@/lib/api/sessions-types";
import {
	coalesceConversationActions,
	reduceConversationActions,
	replayConversationEvents,
} from "@/lib/chat/conversation-replay";
import { toConversationAction } from "@/lib/chat/conversation-runtime-adapter";
import type {
	ConversationAction,
	ConversationReducerContext,
	ConversationState,
} from "@/lib/chat/conversation-types";
import type { ChatTranscriptSnapshot } from "../client/nsh-pilo-client";

/**
 * Applies a chat's runtime events to its conversation in order, through the
 * WebUI's adapter and reducer. Events that carry no transcript content are
 * skipped.
 */
export function applyChatEvents(
	conversation: ConversationState,
	events: readonly PiloRuntimeEvent[],
	context: ConversationReducerContext,
): ConversationState {
	const actions: ConversationAction[] = [];
	for (const event of events) {
		const action = toConversationAction(event);
		if (action) actions.push(action);
	}
	if (actions.length === 0) return conversation;
	return reduceConversationActions(
		conversation,
		coalesceConversationActions(actions),
		context,
	);
}

/**
 * Whether a streamed event belongs on top of the snapshot: the same chat and
 * Pi process, published after the snapshot's cut. The snapshot already holds
 * the chat's events up to the cut, and other chats are not its concern.
 */
export function followsSnapshot(
	snapshot: Pick<
		ChatTranscriptSnapshot,
		"sessionKey" | "generation" | "eventSequence"
	>,
	event: PiloClientEvent,
): boolean {
	return (
		event.sessionKey === snapshot.sessionKey &&
		"generation" in event &&
		event.generation === snapshot.generation &&
		event.sequence > snapshot.eventSequence
	);
}

/**
 * The conversation of a window of saved history. When the window came with
 * the session's message index, each message takes the id of its index
 * entry, which is the id its placeholder has while it is not loaded.
 */
export function conversationFromHistory(
	history: SessionHistory,
	context: ConversationReducerContext,
): ConversationState {
	const conversation = replayConversationEvents(history.events, context);
	const { messageIndex, windowStartMessage } = history;
	return messageIndex && windowStartMessage !== undefined
		? alignHistoryMessages(conversation, messageIndex, windowStartMessage)
		: conversation;
}

/**
 * The conversation a transcript snapshot stands for, which replaces whatever
 * the chat showed before: its saved history, then the turn in progress, then
 * the events of `streamed` that follow the snapshot. `streamed` is what the
 * listener received since before the snapshot was requested, in order.
 *
 * A truncated snapshot gives `null`: its history is empty rather than the
 * chat's, so there is nothing exact to show from it.
 */
export function conversationFromSnapshot(
	snapshot: ChatTranscriptSnapshot,
	streamed: readonly PiloClientEvent[],
	context: ConversationReducerContext,
): ConversationState | null {
	if (snapshot.live.type === "truncated") return null;
	let conversation = conversationFromHistory(snapshot.history.history, context);
	if (snapshot.live.type === "active") {
		conversation = applyChatEvents(conversation, snapshot.live.events, context);
	}
	return applyChatEvents(
		conversation,
		streamed.filter((event) => followsSnapshot(snapshot, event)),
		context,
	);
}
