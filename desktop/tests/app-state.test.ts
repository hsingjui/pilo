import { expect, test } from "nsh/test";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import type { PreferencesSnapshot } from "@shared/host-preferences-types";
import type { SessionReadState } from "@shared/session-read-state";
import type { ThemeSettings } from "@shared/theme-settings-types";
import {
	type AppAction,
	type AppState,
	activeProject,
	changesChatSession,
	createAppState,
	isSessionUnread,
	isStaleEvent,
	readStateKey,
	reduceAppState,
} from "../state/app-state";

const project = (id: string) => ({ id, name: id }) as Project;
const preferences = (revision: number) =>
	({ revision, locale: "en-US" }) as unknown as PreferencesSnapshot;
const theme = (revision: number) => ({ revision }) as ThemeSettings;
const session = (sessionPath: string) =>
	({ projectId: "p1", sessionPath }) as SessionIndexEntry;
const read = (
	sessionPath: string,
	completedRevision: number,
	readRevision: number,
): SessionReadState => ({
	projectId: "p1",
	sessionPath,
	completedRevision,
	readRevision,
});
const event = (sequence: number, body: object) =>
	({ ...body, sequence }) as PiloClientEvent;

function reduce(state: AppState, ...actions: AppAction[]) {
	return actions.reduce(reduceAppState, state);
}

/** A ready state whose bootstrap cut is sequence 10. */
function ready(...actions: AppAction[]) {
	return reduce(
		createAppState(),
		{
			type: "bootstrapped",
			snapshot: {
				projects: [project("p1"), project("p2")],
				chatSessions: [],
				latestSequence: 10,
				preferences: preferences(3),
			},
		},
		...actions,
	);
}

test("the state starts empty and a bootstrap makes it ready", () => {
	expect(createAppState()).toEqual({
		status: { type: "starting" },
		latestSequence: 0,
		projects: [],
		chatSessions: [],
		preferences: null,
		themeSettings: null,
		sessionIndexes: {},
		readStates: {},
		navigation: { projectId: null, session: null },
	});

	const state = ready();
	expect(state.status).toEqual({ type: "ready" });
	expect(state.latestSequence).toBe(10);
	expect(state.projects.map(({ id }) => id)).toEqual(["p1", "p2"]);
	expect(state.preferences).toEqual(preferences(3));
});

test("a failed bootstrap keeps the last data and a later one recovers", () => {
	const failed = ready({ type: "bootstrap_failed", message: "disk error" });
	expect(failed.status).toEqual({ type: "failed", message: "disk error" });
	expect(failed.projects.length).toBe(2);

	const recovered = reduce(failed, {
		type: "bootstrapped",
		snapshot: {
			projects: [],
			chatSessions: [],
			latestSequence: 20,
			preferences: preferences(3),
		},
	});
	expect(recovered.status).toEqual({ type: "ready" });
	expect(recovered.projects).toEqual([]);
	expect(reduce(recovered, { type: "closed" }).status).toEqual({
		type: "closed",
	});
});

test("preferences and theme settings only move to a newer revision", () => {
	const state = ready(
		{ type: "theme_settings_loaded", settings: theme(5) },
		{
			type: "event",
			event: event(11, {
				type: "preferences_changed",
				settings: preferences(2),
			}),
		},
		{
			type: "event",
			event: event(12, { type: "theme_settings_changed", settings: theme(4) }),
		},
		{ type: "theme_settings_loaded", settings: theme(5) },
	);
	expect(state.preferences?.revision).toBe(3);
	expect(state.themeSettings?.revision).toBe(5);

	const newer = reduce(
		state,
		{
			type: "event",
			event: event(13, {
				type: "preferences_changed",
				settings: preferences(4),
			}),
		},
		{
			type: "event",
			event: event(14, { type: "theme_settings_changed", settings: theme(6) }),
		},
		{
			type: "bootstrapped",
			snapshot: {
				projects: [],
				chatSessions: [],
				latestSequence: 12,
				preferences: preferences(3),
			},
		},
	);
	expect(newer.preferences?.revision).toBe(4);
	expect(newer.themeSettings?.revision).toBe(6);
});

test("snapshot-backed events at or below the bootstrap cut are skipped", () => {
	const state = ready();
	const stale = [
		event(10, { type: "preferences_changed", settings: preferences(9) }),
		event(10, { type: "theme_settings_changed", settings: theme(9) }),
		event(9, { type: "configuration_changed" }),
		event(9, { type: "sessions_indexed", projectId: "p1" }),
		event(8, { type: "session_index_error", projectId: "p1", message: "x" }),
		event(7, { type: "session_read_state_changed", state: read("a", 5, 0) }),
	];
	for (const item of stale) {
		expect(isStaleEvent(state, item)).toBe(true);
		expect(reduce(state, { type: "event", event: item })).toBe(state);
	}

	expect(
		isStaleEvent(
			state,
			event(11, { type: "preferences_changed", settings: preferences(9) }),
		),
	).toBe(false);
	// The bootstrap cut is not a transcript watermark.
	expect(
		isStaleEvent(
			state,
			event(4, { type: "assistant_text_delta", generation: 1, delta: "hi" }),
		),
	).toBe(false);
});

test("a session list keeps its entries while it reloads or fails", () => {
	const loading = ready({ type: "sessions_loading", projectId: "p1" });
	expect(loading.sessionIndexes).toEqual({
		p1: { status: "loading", sessions: [] },
	});

	const loaded = reduce(loading, {
		type: "sessions_loaded",
		projectId: "p1",
		sessions: [session("a")],
	});
	expect(loaded.sessionIndexes.p1).toEqual({
		status: "loaded",
		sessions: [session("a")],
	});
	expect(
		reduce(loaded, { type: "sessions_loading", projectId: "p1" }).sessionIndexes
			.p1,
	).toEqual({ status: "loading", sessions: [session("a")] });
	expect(
		reduce(loaded, {
			type: "sessions_failed",
			projectId: "p1",
			message: "offline",
		}).sessionIndexes.p1,
	).toEqual({ status: "failed", sessions: [session("a")], message: "offline" });
	expect(
		reduce(loaded, {
			type: "event",
			event: event(11, {
				type: "session_index_error",
				projectId: "p1",
				message: "index broke",
			}),
		}).sessionIndexes.p1,
	).toEqual({
		status: "failed",
		sessions: [session("a")],
		message: "index broke",
	});
});

test("session lists of removed projects are dropped", () => {
	const state = ready(
		{ type: "sessions_loaded", projectId: "p1", sessions: [session("a")] },
		{ type: "sessions_loaded", projectId: "p2", sessions: [session("b")] },
	);
	const reloaded = reduce(state, {
		type: "projects_loaded",
		projects: [project("p2")],
	});
	expect(Object.keys(reloaded.sessionIndexes)).toEqual(["p2"]);

	const bootstrapped = reduce(state, {
		type: "bootstrapped",
		snapshot: {
			projects: [project("p1")],
			chatSessions: [],
			latestSequence: 30,
			preferences: preferences(3),
		},
	});
	expect(Object.keys(bootstrapped.sessionIndexes)).toEqual(["p1"]);

	// A load that finishes after its project was removed changes nothing.
	expect(
		reduce(bootstrapped, {
			type: "sessions_loaded",
			projectId: "p2",
			sessions: [session("b")],
		}),
	).toBe(bootstrapped);
});

test("read revisions only grow and a full load removes deleted sessions", () => {
	const state = ready(
		{
			type: "read_states_loaded",
			states: [read("a", 2, 2), read("b", 1, 1)],
		},
		{
			type: "event",
			event: event(11, {
				type: "session_read_state_changed",
				state: read("a", 3, 2),
			}),
		},
	);
	expect(isSessionUnread(state, "p1", "a")).toBe(true);
	expect(isSessionUnread(state, "p1", "b")).toBe(false);
	expect(isSessionUnread(state, "p1", "missing")).toBe(false);

	// An older snapshot must not undo the completion the event reported.
	const reloaded = reduce(state, {
		type: "read_states_loaded",
		states: [read("a", 2, 2)],
	});
	expect(reloaded.readStates).toEqual({
		[readStateKey("p1", "a")]: read("a", 3, 2),
	});

	const acknowledged = reduce(reloaded, {
		type: "event",
		event: event(12, {
			type: "session_read_state_changed",
			state: read("a", 3, 3),
		}),
	});
	expect(isSessionUnread(acknowledged, "p1", "a")).toBe(false);
});

test("events the state does not hold leave it untouched", () => {
	const state = ready();
	for (const body of [
		{ type: "configuration_changed" },
		{ type: "sessions_indexed", projectId: "p1" },
		{ type: "assistant_text_delta", generation: 1, delta: "hi" },
	]) {
		expect(reduce(state, { type: "event", event: event(11, body) })).toBe(
			state,
		);
	}
});

test("the active project is the chosen one, else the first, else none", () => {
	expect(activeProject(createAppState())).toBe(null);
	const state = ready();
	expect(activeProject(state)?.id).toBe("p1");
	expect(
		activeProject(reduce(state, { type: "project_selected", projectId: "p2" }))
			?.id,
	).toBe("p2");
	expect(reduce(state, { type: "project_selected", projectId: "gone" })).toBe(
		state,
	);
});

test("opening a session selects its project and choosing a project closes it", () => {
	const opened = ready({
		type: "session_selected",
		projectId: "p2",
		sessionPath: "a",
	});
	expect(opened.navigation).toEqual({
		projectId: "p2",
		session: { projectId: "p2", sessionPath: "a" },
	});
	expect(
		reduce(opened, { type: "project_selected", projectId: "p1" }).navigation,
	).toEqual({ projectId: "p1", session: null });
	expect(
		reduce(opened, {
			type: "session_selected",
			projectId: "gone",
			sessionPath: "b",
		}),
	).toBe(opened);
});

test("a selection survives a new project list only while its project does", () => {
	const opened = ready({
		type: "session_selected",
		projectId: "p2",
		sessionPath: "a",
	});
	const kept = reduce(opened, {
		type: "projects_loaded",
		projects: [project("p2"), project("p3")],
	});
	expect(kept.navigation).toEqual(opened.navigation);

	const removed = reduce(opened, {
		type: "bootstrapped",
		snapshot: {
			projects: [project("p1")],
			chatSessions: [],
			latestSequence: 20,
			preferences: preferences(3),
		},
	});
	expect(removed.navigation).toEqual({ projectId: null, session: null });
	expect(activeProject(removed)?.id).toBe("p1");
	expect(
		reduce(opened, { type: "projects_loaded", projects: [] }).navigation,
	).toEqual({ projectId: null, session: null });
});

const chat = (sessionKey: string, activeTurn = false) =>
	({ sessionKey, projectId: "p1", activeTurn }) as ChatSessionRuntimeState;

test("a chat's runtime state is added, replaced in place and removed", () => {
	const started = ready(
		{ type: "chat_session_loaded", sessionKey: "k1", chat: chat("k1") },
		{ type: "chat_session_loaded", sessionKey: "k2", chat: chat("k2") },
	);
	expect(started.chatSessions).toEqual([chat("k1"), chat("k2")]);

	const busy = reduce(started, {
		type: "chat_session_loaded",
		sessionKey: "k1",
		chat: chat("k1", true),
	});
	expect(busy.chatSessions).toEqual([chat("k1", true), chat("k2")]);
	// The other chat's state is the same object, so its views do not rerun.
	expect(busy.chatSessions[1]).toBe(started.chatSessions[1]);

	const stopped = reduce(busy, {
		type: "chat_session_loaded",
		sessionKey: "k1",
		chat: null,
	});
	expect(stopped.chatSessions).toEqual([chat("k2")]);
});

test("a chat with no runtime state that the app does not hold changes nothing", () => {
	const state = ready();
	expect(
		reduce(state, {
			type: "chat_session_loaded",
			sessionKey: "k1",
			chat: null,
		}),
	).toBe(state);
});

test("a bootstrap replaces the chat states that were read before it", () => {
	const state = reduce(
		ready({ type: "chat_session_loaded", sessionKey: "k1", chat: chat("k1") }),
		{
			type: "bootstrapped",
			snapshot: {
				projects: [project("p1")],
				chatSessions: [chat("k2")],
				latestSequence: 20,
				preferences: preferences(3),
			},
		},
	);
	expect(state.chatSessions).toEqual([chat("k2")]);
});

test("the events that can change a chat's runtime state are told from the rest", () => {
	const response = (command: string) => ({
		type: "rpc_message",
		message: { type: "response", command, success: true },
	});
	for (const body of [
		{ type: "process_state", state: "running" },
		{ type: "process_state", state: "stopped" },
		{ type: "pi_reattached", active: false },
		{ type: "user_message_start", text: "hello" },
		{ type: "assistant_message_start" },
		{ type: "assistant_message_end" },
		{ type: "auto_retry_start" },
		{ type: "compaction_start" },
		{ type: "compaction_end" },
		{ type: "runtime_error", message: "failed" },
		response("prompt"),
		response("compact"),
		response("set_session_name"),
		response("get_state"),
	]) {
		expect(changesChatSession(event(11, body))).toBe(true);
	}
	for (const body of [
		{ type: "assistant_text_delta", delta: "text" },
		{ type: "assistant_thinking_delta", delta: "text" },
		{ type: "tool_execution_start" },
		{ type: "tool_execution_end" },
		{ type: "queue_update" },
		{ type: "extension_ui_request" },
		response("set_model"),
		{ type: "rpc_message", message: { type: "extension_ui_response" } },
		{ type: "rpc_message", message: null },
		{ type: "sessions_indexed", projectId: "p1" },
		{ type: "session_turn_completed", projectId: "p1" },
	]) {
		expect(changesChatSession(event(11, body))).toBe(false);
	}
});
