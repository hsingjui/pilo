import type { Pilo } from "app/native";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { PiloClient, PiloClientBootstrap } from "@/lib/api/pilo-client";
import type { Project } from "@/lib/api/projects-types";
import type { SessionIndexEntry } from "@/lib/api/sessions-types";
import type {
	PreferencePatch,
	PreferencesSnapshot,
} from "@/lib/host-preferences-types";
import type {
	ThemeSettings,
	ThemeSettingsUpdate,
} from "@/lib/theme-settings-types";

/** The native calls the client makes; a test can pass a stand-in. */
export type PiloNative = Pick<
	Pilo,
	| "bootstrap"
	| "listProjects"
	| "listSessions"
	| "loadSessionReadStates"
	| "markSessionRead"
	| "loadPreferences"
	| "savePreferences"
	| "loadThemeSettings"
	| "saveThemeSettings"
	| "shutdown"
>;

export type NshPiloClientBootstrap = PiloClientBootstrap & {
	preferences: PreferencesSnapshot;
};

/**
 * The `PiloClient` calls the native module answers today. The rest of the
 * interface joins this list as the module gains the matching calls, so the
 * client never carries a method that can only fail.
 */
type BridgedPiloClient = Pick<
	PiloClient,
	| "loadPreferences"
	| "savePreferences"
	| "bootstrap"
	| "loadThemeSettings"
	| "saveThemeSettings"
	| "listSessions"
	| "loadSessionReadStates"
	| "markSessionRead"
>;

/**
 * `PiloClient` for the nsh desktop app. The native module serializes the same
 * runtime types the Tauri commands return, so this is the one place its
 * untyped JSON takes the shared types.
 */
export class NshPiloClient implements BridgedPiloClient {
	private readonly pilo: PiloNative;

	constructor(pilo: PiloNative) {
		this.pilo = pilo;
	}

	async bootstrap(): Promise<NshPiloClientBootstrap> {
		const snapshot = await this.pilo.bootstrap();
		return {
			projects: snapshot.projects as Project[],
			chatSessions: snapshot.chatSessions as ChatSessionRuntimeState[],
			latestSequence: snapshot.eventSequence,
			preferences: snapshot.preferences as PreferencesSnapshot,
		};
	}

	async listProjects(): Promise<Project[]> {
		return (await this.pilo.listProjects()) as Project[];
	}

	async listSessions(projectId: string): Promise<SessionIndexEntry[]> {
		return (await this.pilo.listSessions(projectId)) as SessionIndexEntry[];
	}

	loadSessionReadStates() {
		return this.pilo.loadSessionReadStates();
	}

	markSessionRead(projectId: string, sessionPath: string, revision: number) {
		return this.pilo.markSessionRead(projectId, sessionPath, revision);
	}

	async loadPreferences(): Promise<PreferencesSnapshot> {
		return (await this.pilo.loadPreferences()) as PreferencesSnapshot;
	}

	async savePreferences(patch: PreferencePatch): Promise<PreferencesSnapshot> {
		return (await this.pilo.savePreferences(patch)) as PreferencesSnapshot;
	}

	async loadThemeSettings(): Promise<ThemeSettings> {
		return (await this.pilo.loadThemeSettings()) as ThemeSettings;
	}

	async saveThemeSettings(update: ThemeSettingsUpdate): Promise<ThemeSettings> {
		return (await this.pilo.saveThemeSettings(update)) as ThemeSettings;
	}

	/** Await before the app quits; later calls reject. */
	shutdown() {
		return this.pilo.shutdown();
	}
}
