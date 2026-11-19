import type {
	PiloClientEvent,
	PiloClientEventOptions,
} from "@/lib/api/pilo-client";
import type { Project } from "@/lib/api/projects-types";
import type {
	HostPreferenceValues,
	PreferencesSnapshot,
} from "@/lib/host-preferences-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import type { NshPiloClientBootstrap } from "../client/nsh-pilo-client";
import type { AppStoreClient } from "../state/app-store";

export type AppScript = {
	projects?: Project[];
	preferences?: PreferencesSnapshot;
	themeSettings?: ThemeSettings;
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
					chatSessions: [],
					latestSequence: sequence,
					preferences: script.preferences ?? HOST_DEFAULT_PREFERENCES,
				})
			);
		},
		listProjects: () => Promise.resolve(projects),
		listSessions: () => Promise.resolve([]),
		loadSessionReadStates: () => Promise.resolve([]),
		loadThemeSettings: () =>
			Promise.resolve(script.themeSettings ?? HOST_DEFAULT_THEME),
		markSessionRead: () => Promise.reject(new Error("no session to mark")),
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
		/** Delivers runtime events to the app, in order. */
		emit(...events: object[]) {
			const message = {
				type: "events" as const,
				events: events.map(
					(event) => ({ ...event, sequence: ++sequence }) as PiloClientEvent,
				),
			};
			for (const listener of listeners) listener.onMessage(message);
		},
		/** The runtime shuts down: its event stream ends for good. */
		close() {
			closed = true;
			for (const listener of listeners) listener.onStatus(false);
		},
	};
}
