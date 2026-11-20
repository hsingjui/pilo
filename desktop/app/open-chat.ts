import { computed, effect, untracked } from "nsh";

import { chatSessionKey } from "@/lib/api/chat-session-key";
import type { ConversationReducerContext } from "@/lib/chat/conversation-types";
import {
	getProjectScopeDefaultModel,
	isPiScopeCatalogResolved,
} from "@/lib/pi-model-selection";
import type { AppState } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import type { ChatRunConfigStore } from "../state/chat-run-config";
import type {
	ChatTranscriptStore,
	ChatTranscriptTarget,
} from "../state/chat-transcript-store";
import type { ModelCatalogStore } from "../state/model-catalog";

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
	if (!sessionPath) {
		// A chat that was never saved answers to the id the app made for it,
		// and to the file Pi saves it to once it has one.
		if (!open.sessionId) return null;
		const sessionKey = chatSessionKey(projectId, open.sessionId);
		const held = state.chatSessions.find(
			(chat) => chat.sessionKey === sessionKey,
		);
		return { sessionKey, projectId, sessionPath: held?.sessionPath };
	}
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

/**
 * A new chat's initial run configuration: the project Scope's default model
 * and thinking level; empty while the catalog or the scope is unresolved.
 */
function initialRunConfig(catalog: ModelCatalogStore) {
	const state = catalog.state();
	const models = state?.catalog?.models;
	if (!models) return {};
	const scopeResolved =
		state?.scope?.models != null || isPiScopeCatalogResolved(models);
	const model = scopeResolved
		? (getProjectScopeDefaultModel(models, state?.scope) ??
			state?.catalog?.defaultModel ??
			null)
		: null;
	return {
		initialModel: model ?? undefined,
		initialThinkingLevel:
			model?.scopeThinkingLevel ??
			state?.catalog?.defaultThinkingLevel ??
			undefined,
	};
}

/**
 * Keeps `runConfig` on the session that is open in `store` and `catalog` on
 * its project: a saved session's config seeds from history and Pi, a new one
 * starts from the project's Scope default.
 */
export function followRunConfig(
	store: AppStore,
	runConfig: ChatRunConfigStore,
	catalog: ModelCatalogStore,
) {
	const projectId = computed(() => store.state().navigation.projectId);
	effect(() => {
		const next = projectId();
		untracked(() => {
			if (next) void catalog.open(next);
		});
	});
	const target = computed(() => JSON.stringify(openChatTarget(store.state())));
	effect(() => {
		const next = JSON.parse(target()) as ChatTranscriptTarget | null;
		untracked(() => {
			if (next) {
				void runConfig.open(
					next,
					next.sessionPath ? {} : initialRunConfig(catalog),
				);
			} else {
				runConfig.close();
			}
		});
	});
	// A scope default that resolved after a new chat opened still applies.
	effect(() => {
		const state = catalog.state();
		const next = openChatTarget(store.state());
		if (!next?.sessionPath && state?.loaded) {
			const { initialModel, initialThinkingLevel } = initialRunConfig(catalog);
			untracked(() =>
				runConfig.adoptInitial(
					initialModel ?? null,
					initialThinkingLevel ?? null,
				),
			);
		}
	});
}
