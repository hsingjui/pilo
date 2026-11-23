import { computed, effect, lifecycle, untracked } from "nsh";

import { isSessionUnread, readStateKey } from "../state/app-state";
import type { AppStore } from "../state/app-store";

/**
 * Marks the open session read when a turn ends in it while the user is
 * looking: the app is active. A turn that ends while the app is not is
 * marked read once the user comes back to it.
 */
export function followOpenSessionRead(store: AppStore) {
	// The unseen revision, not a flag: a turn that ends before the runtime has
	// answered for the one before it is acknowledged too.
	const unseen = computed(() => {
		if (lifecycle() !== "active") return null;
		const state = store.state();
		const open = state.navigation.session;
		if (
			!open?.sessionPath ||
			!isSessionUnread(state, open.projectId, open.sessionPath)
		) {
			return null;
		}
		const read =
			state.readStates[readStateKey(open.projectId, open.sessionPath)];
		return read?.completedRevision ?? null;
	});
	effect(() => {
		if (unseen() === null) return;
		untracked(() => store.acknowledgeOpenSession());
	});
}
