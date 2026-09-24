import { useState } from "react";

import type { SidebarSession } from "@/components/sidebar/types";

/**
 * Tracks unread dots for agent runs: a session flips to unread when it goes
 * from running to idle, and clears when selected. Derived during render from the
 * previous frame's activity to avoid a setState cascade inside an effect.
 */
export function useSessionUnread(
	sessions: readonly SidebarSession[],
	selectedSessionId: string | null,
): ReadonlySet<string> {
	const [sessionUnreadState, setSessionUnreadState] = useState<{
		prevActive: Map<string, boolean>;
		unread: ReadonlySet<string>;
	}>(() => ({ prevActive: new Map(), unread: new Set() }));
	{
		const { prevActive, unread: currentUnread } = sessionUnreadState;
		const nextActive = new Map<string, boolean>();
		let unread: ReadonlySet<string> = currentUnread;
		let activeChanged = false;
		for (const session of sessions) {
			const wasActive = prevActive.get(session.id) === true;
			const active = Boolean(session.active);
			nextActive.set(session.id, active);
			if (wasActive !== active) activeChanged = true;
			if (
				wasActive &&
				!active &&
				session.id !== selectedSessionId &&
				!unread.has(session.id)
			) {
				unread = new Set(unread).add(session.id);
			}
		}
		if (selectedSessionId && unread.has(selectedSessionId)) {
			const cleared = new Set(unread);
			cleared.delete(selectedSessionId);
			unread = cleared;
		}
		if (activeChanged || unread !== currentUnread) {
			setSessionUnreadState({ prevActive: nextActive, unread });
		}
	}
	return sessionUnreadState.unread;
}
