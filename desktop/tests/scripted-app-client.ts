import type {
	PiloClientEvent,
	PiloClientEventOptions,
} from "@/lib/api/pilo-client";
import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { Project } from "@/lib/api/projects-types";
import type { SessionIndexEntry } from "@/lib/api/sessions-types";
import type {
	HostPreferenceValues,
	PreferencesSnapshot,
} from "@/lib/host-preferences-types";
import type { SessionReadState } from "@/lib/session-read-state";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import type { NshPiloClientBootstrap } from "../client/nsh-pilo-client";
import type { AppStoreClient } from "../state/app-store";

export type AppScript = {
	projects?: Project[];
	preferences?: PreferencesSnapshot;
	themeSettings?: ThemeSettings;
	/** A project's saved sessions; none when left out. */
	sessions?: (projectId: string) => Promise<SessionIndexEntry[]>;
	chatSessions?: ChatSessionRuntimeState[];
	readStates?: SessionReadState[];
	/** Replaces a bootstrap's answer; `undefined` answers from the script. */
	bootstrap?: (attempt: number) => Promise<NshPiloClientBootstrap> | undefined;
};

/** A new Host's preferences and theme, as far as the shell reads them. */
export const HOST_DEFAULT_VALUES = {
	locale: "en-US",
	pageFontFamily: "inter",
	codeFontFamily: "jetbrains-mono",
	codeFontSize: 14,
} as HostPreferenceValues;

const HOST_DEFAULT_PREFERENCES: PreferencesSnapshot = {
	revision: 0,
	values: HOST_DEFAULT_VALUES,
};

const HOST_DEFAULT_THEME = {
	revision: 0,
	theme: "system",
	themeFamily: "lody",
} as ThemeSettings;

/** A client for the app store that answers from `script`, without a runtime. */
export function scriptedClient(script: AppScript = {}) {
	const listeners = new Set<PiloClientEventOptions>();
	const projects = script.projects ?? [];
	let attempts = 0;
	let sequence = 0;
	let closed = false;
	/** Delivers runtime events to the app, in order. */
	const emit = (...events: object[]) => {
		const message = {
			type: "events" as const,
			events: events.map(
				(event) => ({ ...event, sequence: ++sequence }) as PiloClientEvent,
			),
		};
		for (const listener of listeners) listener.onMessage(message);
	};
	const client: AppStoreClient = {
		get closed() {
			return closed;
		},
		bootstrap() {
			attempts += 1;
			return (
				script.bootstrap?.(attempts) ??
				Promise.resolve({
					projects,
					chatSessions: script.chatSessions ?? [],
					latestSequence: sequence,
					preferences: script.preferences ?? HOST_DEFAULT_PREFERENCES,
				})
			);
		},
		// A scripted chat keeps the state the bootstrap gave it.
		chatState: (sessionKey) =>
			Promise.resolve(
				script.chatSessions?.find((chat) => chat.sessionKey === sessionKey) ??
					null,
			),
		listProjects: () => Promise.resolve(projects),
		listSessions: (projectId) =>
			script.sessions?.(projectId) ?? Promise.resolve([]),
		loadSessionReadStates: () => Promise.resolve(script.readStates ?? []),
		loadThemeSettings: () =>
			Promise.resolve(script.themeSettings ?? HOST_DEFAULT_THEME),
		markSessionRead(projectId, sessionPath, revision) {
			const read = script.readStates?.find(
				(state) =>
					state.projectId === projectId && state.sessionPath === sessionPath,
			);
			if (!read) return Promise.reject(new Error("no session to mark"));
			const state = { ...read, readRevision: revision };
			emit({ type: "session_read_state_changed", state });
			return Promise.resolve(state);
		},
		connectEvents(options) {
			listeners.add(options);
			options.onStatus(true);
			return Promise.resolve(() => {
				listeners.delete(options);
			});
		},
	};
	return {
		client,
		emit,
		/** The runtime shuts down: its event stream ends for good. */
		close() {
			closed = true;
			for (const listener of listeners) listener.onStatus(false);
		},
	};
}
