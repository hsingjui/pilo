import { useState } from "react";

import { chatUiStateKey } from "@/components/app/app-chat-state";

import type { SidebarSession } from "@/components/sidebar/types";
import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import {
	chatRuntimeHasOpenTurn,
	runtimeSessionIdFromKey,
} from "@/lib/chat/chat-session-runtime-model";

/**
 * Tracks unread dots for agent runs: a session flips to unread when it goes
 * from running to idle while its process is still running, and clears when
 * selected. A failed/stopped process is not a completed turn. Derived during
 * render from the previous frame's activity to avoid an effect cascade.
 */
export function useSessionUnread(
	sessions: readonly SidebarSession[],
	selectedSessionKey: string | null,
	runtimeStates: readonly ChatSessionRuntimeState[],
): ReadonlySet<string> {
	const [sessionUnreadState, setSessionUnreadState] = useState<{
		prevActive: Map<string, boolean>;
		prevRuntimeIds: ReadonlySet<string>;
		unread: ReadonlySet<string>;
	}>(() => ({
		prevActive: new Map(),
		prevRuntimeIds: new Set(),
		unread: new Set(),
	}));
	{
		const {
			prevActive,
			prevRuntimeIds,
			unread: currentUnread,
		} = sessionUnreadState;
		const nextActive = new Map<string, boolean>();
		const nextRuntimeIds = new Set<string>();
		let unread: ReadonlySet<string> = currentUnread;
		let activeChanged = false;
		let runtimeChanged = false;
		for (const session of sessions) {
			const key = chatUiStateKey(session.projectId, session.id);
			const runtime = runtimeStates.find(
				(state) =>
					state.projectId === session.projectId &&
					((session.sessionPath && state.sessionPath === session.sessionPath) ||
						runtimeSessionIdFromKey(state.sessionKey, state.projectId) ===
							session.id),
			);
			if (runtime) nextRuntimeIds.add(key);
			if (prevRuntimeIds.has(key) !== Boolean(runtime)) runtimeChanged = true;
			const wasActive = prevActive.get(key) === true;
			// Controller busy flags can clear before the runtime snapshot refreshes.
			const active = Boolean(session.active) || chatRuntimeHasOpenTurn(runtime);
			nextActive.set(key, active);
			if (!prevActive.has(key) || wasActive !== active) activeChanged = true;
			if (
				wasActive &&
				!active &&
				// A removed Host runtime was stopped, not successfully settled.
				(runtime
					? runtime.snapshot.state === "running"
					: !prevRuntimeIds.has(key)) &&
				key !== selectedSessionKey &&
				!unread.has(key)
			) {
				unread = new Set(unread).add(key);
			}
		}
		if (selectedSessionKey && unread.has(selectedSessionKey)) {
			const cleared = new Set(unread);
			cleared.delete(selectedSessionKey);
			unread = cleared;
		}
		for (const id of unread) {
			if (nextActive.has(id)) continue;
			const cleared = new Set(unread);
			cleared.delete(id);
			unread = cleared;
		}
		if (
			activeChanged ||
			runtimeChanged ||
			nextActive.size !== prevActive.size ||
			nextRuntimeIds.size !== prevRuntimeIds.size ||
			unread !== currentUnread
		) {
			setSessionUnreadState({
				prevActive: nextActive,
				prevRuntimeIds: nextRuntimeIds,
				unread,
			});
		}
	}
	return sessionUnreadState.unread;
}
