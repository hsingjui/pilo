import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { PiloClientEvent } from "@/lib/api/pilo-client";
import type { Project } from "@/lib/api/projects-types";
import type { SessionIndexEntry } from "@/lib/api/sessions-types";
import type { PreferencesSnapshot } from "@/lib/host-preferences-types";
import type { SessionReadState } from "@/lib/session-read-state";
import type { ThemeSettings } from "@/lib/theme-settings-types";

export type StartupStatus =
	| { type: "starting" }
	| { type: "ready" }
	| { type: "failed"; message: string }
	| { type: "closed" };

/** One project's saved sessions; a reload keeps the last list on screen. */
export type SessionIndexState = {
	status: "loading" | "loaded" | "failed";
	sessions: SessionIndexEntry[];
	message?: string;
};

export type SessionSelection = { projectId: string; sessionPath: string };

/**
 * What the user is looking at. It is kept in memory only, like the selection
 * of the Tauri app: a restart opens the first project with no session.
 */
export type Navigation = {
	/** The project chosen for a new chat; unset until the user picks one. */
	projectId: string | null;
	/** The open session, if any. */
	session: SessionSelection | null;
};

export type AppState = {
	status: StartupStatus;
	/** Event cut of the last bootstrap. */
	latestSequence: number;
	projects: Project[];
	chatSessions: ChatSessionRuntimeState[];
	preferences: PreferencesSnapshot | null;
	themeSettings: ThemeSettings | null;
	sessionIndexes: Record<string, SessionIndexState>;
	readStates: Record<string, SessionReadState>;
	navigation: Navigation;
};

export type AppSnapshot = {
	projects: Project[];
	chatSessions: ChatSessionRuntimeState[];
	latestSequence: number;
	preferences: PreferencesSnapshot;
};

export type AppAction =
	| { type: "bootstrapped"; snapshot: AppSnapshot }
	| { type: "bootstrap_failed"; message: string }
	| { type: "closed" }
	| { type: "projects_loaded"; projects: Project[] }
	| { type: "theme_settings_loaded"; settings: ThemeSettings }
	| { type: "read_states_loaded"; states: SessionReadState[] }
	| { type: "sessions_loading"; projectId: string }
	| {
			type: "sessions_loaded";
			projectId: string;
			sessions: SessionIndexEntry[];
	  }
	| { type: "sessions_failed"; projectId: string; message: string }
	| { type: "project_selected"; projectId: string }
	| { type: "session_selected"; projectId: string; sessionPath: string }
	| { type: "event"; event: PiloClientEvent };

export function createAppState(): AppState {
	return {
		status: { type: "starting" },
		latestSequence: 0,
		projects: [],
		chatSessions: [],
		preferences: null,
		themeSettings: null,
		sessionIndexes: {},
		readStates: {},
		navigation: { projectId: null, session: null },
	};
}

/** The chosen project, else the first one, as long as it still exists. */
export function activeProject(state: AppState): Project | null {
	const { projectId } = state.navigation;
	return (
		state.projects.find(({ id }) => id === projectId) ??
		state.projects[0] ??
		null
	);
}

export function readStateKey(projectId: string, sessionPath: string) {
	return `${projectId}\n${sessionPath}`;
}

export function isSessionUnread(
	state: AppState,
	projectId: string,
	sessionPath: string,
) {
	const read = state.readStates[readStateKey(projectId, sessionPath)];
	return read !== undefined && read.completedRevision > read.readRevision;
}

function newer<T extends { revision: number }>(current: T | null, next: T) {
	return current === null || next.revision > current.revision ? next : current;
}

function withSessionIndex(
	state: AppState,
	projectId: string,
	update: (current: SessionIndexState | undefined) => SessionIndexState,
): AppState {
	// A load can finish after its project was removed.
	if (!hasProject(state.projects, projectId)) return state;
	return {
		...state,
		sessionIndexes: {
			...state.sessionIndexes,
			[projectId]: update(state.sessionIndexes[projectId]),
		},
	};
}

/** Replies, snapshots and events can arrive out of order; revisions only grow. */
function mergeReadState(
	current: SessionReadState | undefined,
	next: SessionReadState,
): SessionReadState {
	if (!current) return next;
	return {
		...next,
		completedRevision: Math.max(
			current.completedRevision,
			next.completedRevision,
		),
		readRevision: Math.max(current.readRevision, next.readRevision),
	};
}

function withoutRemovedProjects(
	sessionIndexes: AppState["sessionIndexes"],
	projects: Project[],
) {
	const projectIds = new Set(projects.map(({ id }) => id));
	return Object.fromEntries(
		Object.entries(sessionIndexes).filter(([projectId]) =>
			projectIds.has(projectId),
		),
	);
}

function hasProject(projects: Project[], projectId: string) {
	return projects.some(({ id }) => id === projectId);
}

/** Drops a selection whose project is gone from a new project list. */
function withKnownSelection(
	{ projectId, session }: Navigation,
	projects: Project[],
): Navigation {
	return {
		projectId:
			projectId !== null && hasProject(projects, projectId) ? projectId : null,
		session:
			session && hasProject(projects, session.projectId) ? session : null,
	};
}

/**
 * Whether a bootstrap, and the loads that follow it, already hold what this
 * event reports. The native queue starts at module creation, so such events
 * can arrive after the snapshot that includes them. Chat events are never
 * stale by this rule: the bootstrap cut is not a transcript watermark.
 */
export function isStaleEvent(state: AppState, event: PiloClientEvent) {
	switch (event.type) {
		case "preferences_changed":
		case "theme_settings_changed":
		case "configuration_changed":
		case "sessions_indexed":
		case "session_index_error":
		case "session_read_state_changed":
			return event.sequence <= state.latestSequence;
		default:
			return false;
	}
}

function reduceEvent(state: AppState, event: PiloClientEvent): AppState {
	if (isStaleEvent(state, event)) return state;
	switch (event.type) {
		case "preferences_changed":
			return {
				...state,
				preferences: newer(state.preferences, event.settings),
			};
		case "theme_settings_changed":
			return {
				...state,
				themeSettings: newer(state.themeSettings, event.settings),
			};
		case "session_index_error":
			return withSessionIndex(state, event.projectId, (current) => ({
				status: "failed",
				sessions: current?.sessions ?? [],
				message: event.message,
			}));
		case "session_read_state_changed": {
			const key = readStateKey(event.state.projectId, event.state.sessionPath);
			return {
				...state,
				readStates: {
					...state.readStates,
					[key]: mergeReadState(state.readStates[key], event.state),
				},
			};
		}
		default:
			return state;
	}
}

export function reduceAppState(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "bootstrapped": {
			const { snapshot } = action;
			return {
				...state,
				status: { type: "ready" },
				latestSequence: snapshot.latestSequence,
				projects: snapshot.projects,
				chatSessions: snapshot.chatSessions,
				preferences: newer(state.preferences, snapshot.preferences),
				sessionIndexes: withoutRemovedProjects(
					state.sessionIndexes,
					snapshot.projects,
				),
				navigation: withKnownSelection(state.navigation, snapshot.projects),
			};
		}
		case "bootstrap_failed":
			return { ...state, status: { type: "failed", message: action.message } };
		case "closed":
			return { ...state, status: { type: "closed" } };
		case "projects_loaded":
			return {
				...state,
				projects: action.projects,
				sessionIndexes: withoutRemovedProjects(
					state.sessionIndexes,
					action.projects,
				),
				navigation: withKnownSelection(state.navigation, action.projects),
			};
		case "theme_settings_loaded":
			return {
				...state,
				themeSettings: newer(state.themeSettings, action.settings),
			};
		case "read_states_loaded":
			return {
				...state,
				readStates: Object.fromEntries(
					action.states.map((read) => {
						const key = readStateKey(read.projectId, read.sessionPath);
						return [key, mergeReadState(state.readStates[key], read)];
					}),
				),
			};
		case "sessions_loading":
			return withSessionIndex(state, action.projectId, (current) => ({
				status: "loading",
				sessions: current?.sessions ?? [],
			}));
		case "sessions_loaded":
			return withSessionIndex(state, action.projectId, () => ({
				status: "loaded",
				sessions: action.sessions,
			}));
		case "sessions_failed":
			return withSessionIndex(state, action.projectId, (current) => ({
				status: "failed",
				sessions: current?.sessions ?? [],
				message: action.message,
			}));
		case "project_selected":
			if (!hasProject(state.projects, action.projectId)) return state;
			return {
				...state,
				navigation: { projectId: action.projectId, session: null },
			};
		case "session_selected": {
			const { projectId, sessionPath } = action;
			if (!hasProject(state.projects, projectId)) return state;
			return {
				...state,
				navigation: { projectId, session: { projectId, sessionPath } },
			};
		}
		case "event":
			return reduceEvent(state, action.event);
	}
}
