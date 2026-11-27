import { cleanup, computed, effect, untracked } from "nsh";

import { chatSessionKey } from "@shared/api/chat-session-key";
import { runtimeSessionPathKey } from "@shared/chat/chat-session-runtime-model";
import type { ConversationReducerContext } from "@shared/chat/conversation-types";
import {
	getPiQuickCycleThinkingLevel,
	isPiScopeCatalogResolved,
} from "@shared/pi-model-selection";
import {
	type AppState,
	isExternalTurnOpen,
	isTemporarySessionId,
} from "../state/app-state";
import type { AppStore } from "../state/app-store";
import type {
	ChatRunConfigOptions,
	ChatRunConfigStore,
} from "../state/chat-run-config";
import type {
	ChatTranscriptStore,
	ChatTranscriptTarget,
} from "../state/chat-transcript-store";
import type { ModelCatalogStore } from "../state/model-catalog";
import { isForkRuntime } from "./session-fork";

/** Ids and times for the messages this app builds, as the WebUI makes them. */
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
 * one gets the key the WebUI gives it. Whoever starts a chat for a
 * saved session must use the same key.
 */
export function openChatTarget(state: AppState): ChatTranscriptTarget | null {
	const open = state.navigation.session;
	if (!open) return null;
	const { projectId, sessionPath } = open;
	if (!sessionPath) {
		// A path returned during Pi startup is not yet a saved session.
		return open.sessionId
			? { sessionKey: chatSessionKey(projectId, open.sessionId), projectId }
			: null;
	}
	const pathKey = runtimeSessionPathKey(sessionPath);
	const held = state.chatSessions.find(
		(chat) =>
			chat.projectId === projectId &&
			chat.sessionPath &&
			runtimeSessionPathKey(chat.sessionPath) === pathKey &&
			// Fork helpers briefly report the source path, but never own its UI.
			!isForkRuntime(chat.sessionKey),
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

/**
 * Whether `next` is the new chat `previous` showed, now that Pi has named the
 * file it saves it to: the same chat, not another one to open again.
 */
function namesDraftFile(
	previous: ChatTranscriptTarget | null,
	next: ChatTranscriptTarget,
): next is ChatTranscriptTarget & { sessionPath: string } {
	return (
		previous !== null &&
		previous.sessionKey === next.sessionKey &&
		previous.projectId === next.projectId &&
		!previous.sessionPath &&
		!!next.sessionPath
	);
}

/** Keeps `chat` on the session that is open in `store`, closed without one. */
export function followOpenSession(store: AppStore, chat: ChatTranscriptStore) {
	// Compared as text, so the chat is opened again only when it is another.
	const target = computed(() => JSON.stringify(openChatTarget(store.state())));
	let shown: ChatTranscriptTarget | null = null;
	effect(() => {
		const next = JSON.parse(target()) as ChatTranscriptTarget | null;
		untracked(() => {
			const previous = shown;
			shown = next;
			if (!next) {
				chat.close();
				return;
			}
			if (namesDraftFile(previous, next)) {
				chat.adoptSessionPath(next.sessionPath);
				return;
			}
			const state = store.state();
			const held = state.chatSessions.find(
				(entry) => entry.sessionKey === next.sessionKey,
			);
			const freshDraft = !next.sessionPath && !held;
			const knownRunning = held?.snapshot?.state === "running";
			const indexedEntry = next.sessionPath
				? state.sessionIndexes[next.projectId]?.sessions.find(
						(entry) => entry.sessionPath === next.sessionPath,
					)
				: undefined;
			const expectedFingerprint =
				indexedEntry &&
				typeof indexedEntry.fileSize === "number" &&
				indexedEntry.fileMtimeNs !== undefined &&
				String(indexedEntry.fileMtimeNs) !== ""
					? {
							fileSize: indexedEntry.fileSize,
							fileMtimeNs: String(indexedEntry.fileMtimeNs),
						}
					: null;
			void chat.open(next, store.connected, {
				freshDraft,
				knownRunning,
				expectedFingerprint,
				external: isExternalTurnOpen(state, next.projectId, next.sessionPath),
			});
		});
	});
	// An external Pi's turn shows as running, and reaches the chat through
	// the session file, as the WebUI follows it.
	const external = computed(() => {
		const state = store.state();
		const open = openChatTarget(state);
		return (
			!!open && isExternalTurnOpen(state, open.projectId, open.sessionPath)
		);
	});
	effect(() => {
		const open = external();
		untracked(() => chat.setExternalTurnOpen(open));
	});
	const file = computed(
		() => {
			const state = store.state();
			const open = openChatTarget(state);
			if (!open?.sessionPath) return null;
			const entry = state.sessionIndexes[open.projectId]?.sessions.find(
				(session) => session.sessionPath === open.sessionPath,
			);
			return entry
				? {
						sessionKey: open.sessionKey,
						version: `${entry.fileSize}:${entry.fileMtimeNs}`,
					}
				: null;
		},
		{
			equals: (a, b) =>
				a?.sessionKey === b?.sessionKey && a?.version === b?.version,
		},
	);
	let indexed: { sessionKey: string; version: string } | null = null;
	effect(() => {
		const next = file();
		untracked(() => {
			const previous = indexed;
			indexed = next;
			if (
				previous &&
				next &&
				previous.sessionKey === next.sessionKey &&
				previous.version !== next.version
			)
				chat.historyChanged();
		});
	});
}

/**
 * Ends a temporary chat once another chat is open, as the WebUI does:
 * Pi saved nothing of it to come back to.
 * 当传入 `onLeaving` 且临时会话已有内容时，给予短暂缓冲期并允许一键返回，避免手滑点错直接销毁。
 */
export function endLeftTemporaryChats(
	store: AppStore,
	chat: ChatTranscriptStore,
	stopChat: (sessionKey: string, reason?: string) => Promise<void>,
	options?: {
		graceMs?: number;
		/**
		 * Notify the UI that a temporary chat is pending cleanup.
		 * Return a dismiss callback when a toast's `onDismiss` owns the cleanup
		 * trigger (`onDismiss` passed here), so hover-paused toasts stay in sync.
		 */
		onLeaving?: (info: {
			projectId: string;
			sessionId: string;
			sessionKey: string;
			graceMs: number;
			restore: () => void;
			onDismiss: () => void;
		}) => (() => void) | void;
	},
) {
	const temporary = computed(() => {
		const open = store.state().navigation.session;
		return open?.sessionId && isTemporarySessionId(open.sessionId)
			? {
					projectId: open.projectId,
					sessionId: open.sessionId,
					sessionKey: chatSessionKey(open.projectId, open.sessionId),
				}
			: null;
	});
	let shown: {
		projectId: string;
		sessionId: string;
		sessionKey: string;
	} | null = null;
	const pendingStops = new Map<
		string,
		{ timer?: ReturnType<typeof setTimeout>; dismissToast?: () => void }
	>();
	const cancelPending = (sessionKey: string) => {
		const entry = pendingStops.get(sessionKey);
		if (!entry) return;
		pendingStops.delete(sessionKey);
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.dismissToast?.();
	};
	cleanup(() => {
		for (const [sessionKey, entry] of pendingStops) {
			if (entry.timer !== undefined) clearTimeout(entry.timer);
			chat.discardTemporary(sessionKey);
		}
		pendingStops.clear();
	});
	effect(() => {
		const next = temporary();
		untracked(() => {
			if (next) cancelPending(next.sessionKey);
			const left = shown;
			shown = next;
			if (!left || left.sessionKey === next?.sessionKey) return;
			const state = store.state();
			const hasContent =
				chat.hasTemporaryMessages(left.sessionKey) ||
				state.chatSessions.some(
					(chat) => chat.sessionKey === left.sessionKey,
				) ||
				state.pendingDrafts.has(left.sessionKey);
			const stopChatNow = () => {
				chat.discardTemporary(left.sessionKey);
				void stopChat(left.sessionKey, "temporary_chat_left").catch(
					(error: unknown) => {
						console.warn("Failed to stop the temporary chat", error);
					},
				);
			};
			if (!hasContent || !options?.onLeaving) {
				cancelPending(left.sessionKey);
				stopChatNow();
				return;
			}
			cancelPending(left.sessionKey);
			const graceMs = options.graceMs ?? 8_000;
			const entry: {
				timer?: ReturnType<typeof setTimeout>;
				dismissToast?: () => void;
			} = {};
			pendingStops.set(left.sessionKey, entry);
			const commitStop = () => {
				if (pendingStops.get(left.sessionKey) !== entry) return;
				pendingStops.delete(left.sessionKey);
				if (entry.timer !== undefined) clearTimeout(entry.timer);
				stopChatNow();
			};
			const dismissToast = options.onLeaving({
				...left,
				graceMs,
				restore: () => {
					if (pendingStops.get(left.sessionKey) !== entry) return;
					cancelPending(left.sessionKey);
					store.selectDraft(left.projectId, left.sessionId);
				},
				onDismiss: commitStop,
			});
			if (typeof dismissToast === "function") {
				entry.dismissToast = dismissToast;
			} else if (pendingStops.get(left.sessionKey) === entry) {
				entry.timer = setTimeout(commitStop, graceMs);
			}
		});
	});
}

/** Only a starred project default overrides Pi; the probed default is a preview. */
function initialRunConfig(
	catalog: ModelCatalogStore,
	projectId: string,
): ChatRunConfigOptions {
	const state = catalog.state();
	if (!state?.loaded || !state.scope || state.projectId !== projectId) {
		return { initialSource: "pending" };
	}
	const snapshot = state.provisional ? null : state.catalog;
	const projectDefault = snapshot ? catalog.scopeDefaultModel : null;
	if (
		!projectDefault &&
		state.scope.models?.some((model) => model.isDefault) &&
		(!snapshot || !isPiScopeCatalogResolved(snapshot.models))
	) {
		return { initialSource: "pending" };
	}
	return {
		initialSource: projectDefault ? "scope" : "pi",
		initialModel: projectDefault ?? snapshot?.defaultModel ?? undefined,
		initialThinkingLevel: projectDefault
			? (getPiQuickCycleThinkingLevel(projectDefault) ?? undefined)
			: (snapshot?.defaultThinkingLevel ?? undefined),
	};
}

/**
 * Keeps `runConfig` on the session that is open in `store` and `catalog` on
 * its project: a saved session's config seeds from history and Pi, and only
 * a fresh draft starts from the project's Scope default.
 */
export function followRunConfig(
	store: AppStore,
	runConfig: ChatRunConfigStore,
	catalog: ModelCatalogStore,
	chat?: Pick<ChatTranscriptStore, "historyMetadata">,
) {
	const projectId = computed(() => store.state().navigation.projectId);
	effect(() => {
		const next = projectId();
		untracked(() => {
			if (!next) return;
			const project = store.state().projects.find(({ id }) => id === next);
			void catalog.open(next, project?.connection.id);
		});
	});
	const target = computed(() => JSON.stringify(openChatTarget(store.state())));
	let shown: ChatTranscriptTarget | null = null;
	effect(() => {
		const next = JSON.parse(target()) as ChatTranscriptTarget | null;
		untracked(() => {
			const previous = shown;
			shown = next;
			if (next && namesDraftFile(previous, next)) {
				// Opening it again would drop the selection a send is applying.
				runConfig.adoptSessionPath(next.sessionPath);
			} else if (next) {
				const state = store.state();
				const readLiveDraft =
					state.pendingDrafts.has(next.sessionKey) ||
					state.chatSessions.some(
						(chat) => chat.sessionKey === next.sessionKey && chat.initialized,
					);
				void runConfig.open(
					next,
					next.sessionPath
						? { skipHistoryLoad: Boolean(chat) }
						: readLiveDraft
							? { readLiveDraft }
							: initialRunConfig(catalog, next.projectId),
				);
				const meta = chat ? untracked(chat.historyMetadata) : null;
				if (meta && meta.sessionKey === next.sessionKey) {
					runConfig.applyHistory(meta.history, meta.sessionKey);
				}
			} else {
				runConfig.close();
			}
		});
	});
	if (chat) {
		effect(() => {
			const meta = chat.historyMetadata();
			if (!meta) return;
			untracked(() => runConfig.applyHistory(meta.history, meta.sessionKey));
		});
	}
	// A late catalog still enriches saved models or supplies new-chat defaults.
	effect(() => {
		const state = catalog.state();
		const next = openChatTarget(store.state());
		if (!next || !state?.loaded || state.projectId !== next.projectId) return;
		if (next.sessionPath) {
			untracked(() => runConfig.enrichSavedModel());
		} else {
			const { initialModel, initialThinkingLevel, initialSource } =
				initialRunConfig(catalog, next.projectId);
			untracked(() =>
				runConfig.adoptInitial(
					initialModel ?? null,
					initialThinkingLevel ?? null,
					initialSource,
				),
			);
		}
	});
}
