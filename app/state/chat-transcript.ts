import { alignHistoryMessages } from "@shared/chat/chat-history-window-model";
import type { PiloRuntimeEvent } from "@shared/api/pi-runtime-types";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { SessionHistory } from "@shared/api/sessions-types";
import { setActiveTurnStartedAt } from "@shared/chat/conversation-reducer";
import {
	coalesceConversationActions,
	reduceConversationActions,
	replayConversationEvents,
} from "@shared/chat/conversation-replay";
import { toConversationAction } from "@shared/chat/conversation-runtime-adapter";
import type {
	ChatConversationImage,
	ConversationAction,
	ConversationReducerContext,
	ConversationState,
} from "@shared/chat/conversation-types";
import type { ChatTranscriptSnapshot } from "@shared/api/host-methods";

export type LocalPromptEcho = {
	text: string;
	images?: ChatConversationImage[];
	clientMessageId: string;
	workClockStartedAtMs?: number;
	sequence?: number;
};

/** Applies a chat's runtime events through the shared adapter and reducer. */
export function applyChatEvents(
	conversation: ConversationState,
	events: readonly PiloRuntimeEvent[],
	context: ConversationReducerContext,
	localPromptEcho?: LocalPromptEcho,
): ConversationState {
	const echo =
		localPromptEcho &&
		events.findLast(
			(event) =>
				event.type === "user_message_start" &&
				(!("sequence" in event) || event.sequence === localPromptEcho.sequence),
		);
	const actions: ConversationAction[] = [];
	for (const event of events) {
		const action = toConversationAction(event);
		if (!action) continue;
		if (
			"sequence" in event &&
			(action.type === "user_message_start" ||
				action.type === "assistant_message_start")
		) {
			action.workClockStartedAtMs = performance.now();
		}
		if (
			localPromptEcho &&
			event === echo &&
			action.type === "user_message_start" &&
			action.text === localPromptEcho.text
		) {
			if (localPromptEcho.images?.length) {
				action.images ??= localPromptEcho.images;
				action.sourceEntryId = localPromptEcho.clientMessageId;
			}
			action.workClockStartedAtMs =
				localPromptEcho.workClockStartedAtMs ?? action.workClockStartedAtMs;
		}
		actions.push(action);
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
	localPromptEcho?: LocalPromptEcho,
): ConversationState | null {
	if (snapshot.live.type === "truncated") return null;
	const clockStart =
		snapshot.liveElapsedMs === undefined
			? undefined
			: performance.now() - snapshot.liveElapsedMs;
	const conversation = conversationFromHistory(
		snapshot.history.history,
		context,
	);
	const later = streamed.filter((event) => followsSnapshot(snapshot, event));
	let live = snapshot.live.type === "active" ? snapshot.live.events : [];
	if (snapshot.liveUserImages?.length) {
		const byUser = new Map(
			snapshot.liveUserImages.map(({ userIndex, images }) => [
				userIndex,
				images,
			]),
		);
		let userIndex = 0;
		live = live.map((event) => {
			if (event.type !== "user_message_start") return event;
			const images = byUser.get(userIndex++);
			return images ? { ...event, images } : event;
		});
	}
	const echoSequence = localPromptEcho?.sequence;
	const echoAfterSnapshot =
		echoSequence !== undefined && echoSequence > snapshot.eventSequence;
	const projected = applyChatEvents(
		conversation,
		live,
		context,
		echoAfterSnapshot ? undefined : localPromptEcho,
	);
	return applyChatEvents(
		setActiveTurnStartedAt(
			projected,
			context,
			snapshot.liveStartedAtMs,
			clockStart,
		),
		later,
		context,
		echoAfterSnapshot ? localPromptEcho : undefined,
	);
}
