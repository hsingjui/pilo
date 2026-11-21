import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import {
	chatRuntimeShowsActivity,
	runtimeSessionPathKey,
} from "@shared/chat/chat-session-runtime-model";
import type { SessionExternalActivity } from "@/lib/api/sessions";

export type ProjectExternalActivity = {
	openTurnPaths: ReadonlySet<string>;
};

export type ProjectRuntimeActivity = ReadonlyMap<string, ReadonlySet<string>>;

export function sameStringSet(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
) {
	if (left.size !== right.size) return false;
	for (const value of left) {
		if (!right.has(value)) return false;
	}
	return true;
}

export function sameRuntimeActivity(
	left: ProjectRuntimeActivity,
	right: ProjectRuntimeActivity,
) {
	if (left.size !== right.size) return false;
	for (const [projectId, paths] of left) {
		const nextPaths = right.get(projectId);
		if (!nextPaths || nextPaths.size !== paths.size) return false;
		for (const path of paths) {
			if (!nextPaths.has(path)) return false;
		}
	}
	return true;
}

export function runtimeActivityFromStates(
	states: readonly ChatSessionRuntimeState[],
	projectIds?: ReadonlySet<string>,
): ProjectRuntimeActivity {
	const mutable = new Map<string, Set<string>>();
	for (const state of states) {
		if (
			(projectIds && !projectIds.has(state.projectId)) ||
			!chatRuntimeShowsActivity(state) ||
			!state.sessionPath
		) {
			continue;
		}
		let paths = mutable.get(state.projectId);
		if (!paths) {
			paths = new Set();
			mutable.set(state.projectId, paths);
		}
		paths.add(runtimeSessionPathKey(state.sessionPath));
	}
	return mutable;
}

export function toProjectExternalActivity(
	activities: readonly SessionExternalActivity[],
): ProjectExternalActivity {
	return {
		openTurnPaths: new Set(
			activities
				.filter((activity) => activity.turnOpen)
				.map((activity) => activity.path),
		),
	};
}

export {
	mergeProjectSessions,
	sameSessionIndexEntry,
} from "@shared/sidebar/session-index";
