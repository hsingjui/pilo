import { listChatSessionRuntimeStates } from "@/lib/chat-session-client";
import type {
	SessionExternalActivity,
	SessionIndexEntry,
} from "@/lib/sessions";

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
	states: Awaited<ReturnType<typeof listChatSessionRuntimeStates>>,
	projectIds?: ReadonlySet<string>,
): ProjectRuntimeActivity {
	const mutable = new Map<string, Set<string>>();
	for (const state of states) {
		if (
			(projectIds && !projectIds.has(state.projectId)) ||
			!state.activeTurn ||
			state.snapshot.state !== "running" ||
			!state.sessionPath
		) {
			continue;
		}
		let paths = mutable.get(state.projectId);
		if (!paths) {
			paths = new Set();
			mutable.set(state.projectId, paths);
		}
		paths.add(state.sessionPath);
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

export function sameSessionIndexEntry(
	a: SessionIndexEntry,
	b: SessionIndexEntry,
) {
	return (
		a.connectionId === b.connectionId &&
		a.projectId === b.projectId &&
		a.piSessionId === b.piSessionId &&
		a.sessionPath === b.sessionPath &&
		a.name === b.name &&
		a.cwd === b.cwd &&
		a.createdAt === b.createdAt &&
		a.updatedAt === b.updatedAt &&
		a.messageCount === b.messageCount &&
		a.lastMessageAt === b.lastMessageAt &&
		a.firstUserMessagePreview === b.firstUserMessagePreview &&
		a.fileSize === b.fileSize &&
		a.fileMtimeNs === b.fileMtimeNs &&
		a.lastOffset === b.lastOffset &&
		a.pinned === b.pinned &&
		a.titleOverride === b.titleOverride
	);
}

export function mergeProjectSessions(
	current: SessionIndexEntry[],
	projectId: string,
	sessions: SessionIndexEntry[],
) {
	const previousByPath = new Map(
		current
			.filter((session) => session.projectId === projectId)
			.map((session) => [session.sessionPath, session] as const),
	);
	const nextProjectSessions = sessions.map((session) => {
		const previous = previousByPath.get(session.sessionPath);
		return previous && sameSessionIndexEntry(previous, session)
			? previous
			: session;
	});
	const next = [
		...current.filter((session) => session.projectId !== projectId),
		...nextProjectSessions,
	];
	if (
		next.length === current.length &&
		next.every((session, index) => session === current[index])
	) {
		return current;
	}
	return next;
}
