import { computed, effect, untracked } from "nsh";

import { chatSessionKey } from "@/lib/api/chat-session-key";
import type { ConversationReducerContext } from "@/lib/chat/conversation-types";
import type { AppState } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import type {
	ChatTranscriptStore,
	ChatTranscriptTarget,
} from "../state/chat-transcript-store";

/** Ids and times for the messages this app builds, as the Tauri app makes them. */
export function conversationContext(): ConversationReducerContext {
	let sequence = 0;
	const id = (kind: string) => `local-${kind}-${Date.now()}-${++sequence}`;
	return {
		createMessageId: id,
		createContentId: id,
		now: () => Date.now(),
		formatTime(timestampMs) {
			const date = new Date(timestampMs);
			const hours = String(date.getHours()).padStart(2, "0");
			const minutes = String(date.getMinutes()).padStart(2, "0");
			return `${hours}:${minutes}`;
		},
	};
}

/**
 * The chat of the open session, or `null` when no session is open or it is
 * not in its project's saved sessions. A chat the runtime already holds for
 * the session keeps the key it was started with; a saved session without
 * one gets the key the Tauri app gives it. Whoever starts a chat for a
 * saved session must use the same key.
 */
export function openChatTarget(state: AppState): ChatTranscriptTarget | null {
	const open = state.navigation.session;
	if (!open) return null;
	const { projectId, sessionPath } = open;
	const held = state.chatSessions.find(
		(chat) => chat.projectId === projectId && chat.sessionPath === sessionPath,
	);
	if (held) return { sessionKey: held.sessionKey, projectId, sessionPath };
	const saved = state.sessionIndexes[projectId]?.sessions.find(
		(entry) => entry.sessionPath === sessionPath,
	);
	if (!saved) return null;
	return {
		sessionKey: chatSessionKey(projectId, saved.piSessionId),
		projectId,
		sessionPath,
	};
}

/** Keeps `chat` on the session that is open in `store`, closed without one. */
export function followOpenSession(store: AppStore, chat: ChatTranscriptStore) {
	// Compared as text, so the chat is opened again only when it is another.
	const target = computed(() => JSON.stringify(openChatTarget(store.state())));
	effect(() => {
		const next = JSON.parse(target()) as ChatTranscriptTarget | null;
		untracked(() => {
			if (next) void chat.open(next, store.connected);
			else chat.close();
		});
	});
}
