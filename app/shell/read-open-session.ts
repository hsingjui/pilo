import { computed, effect, untracked } from "nsh";

import type { AppStore } from "../state/app-store";

/** Marks completed turns read while the user is viewing their chat. */
export function followOpenSessionRead(store: AppStore) {
	// Track both session and revision: a different chat or a newer turn can
	// need acknowledgement while the previous write is still in flight.
	const unseen = computed(() => {
		const key = store.viewedSessionKey();
		if (key === null || !store.isShown()) return null;
		const read = store.state().readStates[key];
		return read && read.completedRevision > read.readRevision
			? `${key}\n${read.completedRevision}`
			: null;
	});
	effect(() => {
		if (unseen() === null) return;
		untracked(() => store.acknowledgeOpenSession());
	});
}
