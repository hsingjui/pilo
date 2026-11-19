import type { Pilo } from "app/native";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { PiSessionSnapshot } from "@/lib/api/pi-runtime-types";
import type {
	PiloClient,
	PiloClientBootstrap,
	PiloClientEvent,
	PiloClientEventMessage,
	PiloClientEventOptions,
	PiloClientStartChatInput,
} from "@/lib/api/pilo-client";
import type { Project } from "@/lib/api/projects-types";
import type {
	SessionDeleteResult,
	SessionHistoryFingerprint,
	SessionIndexEntry,
	SessionSearchMatch,
} from "@/lib/api/sessions-types";
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
	| "nextEvents"
	| "startChat"
	| "stopChat"
	| "chatState"
	| "sendChatCommand"
	| "listProjects"
	| "listSessions"
	| "searchSessions"
	| "generateSessionTitle"
	| "deleteSession"
	| "readHistoryImage"
	| "readProjectImage"
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
	| "searchSessions"
	| "generateSessionTitle"
	| "deleteSession"
	| "readHistoryImage"
	| "readProjectImage"
	| "loadSessionReadStates"
	| "markSessionRead"
	| "connectEvents"
	| "startChat"
	| "stopChat"
	| "chatState"
	| "sendChatCommand"
>;

/**
 * Image bytes as the native module returns them: over an `ArrayBuffer`, never
 * a shared one, which its generated declaration does not say.
 */
type ImageBytes = Uint8Array<ArrayBuffer>;

/** What `nextEvents` resolves with, as `desktop/README.md` lists it. */
type NativeEventBatch =
	| { type: "events"; events: PiloClientEvent[] }
	| { type: "gap"; firstMissed: number; lastMissed: number }
	| { type: "closed" };

/** Well under the native queue bound of 2,048 events. */
const EVENT_BATCH_SIZE = 256;

/**
 * `PiloClient` for the nsh desktop app. The native module serializes the same
 * runtime types the Tauri commands return, so this is the one place its
 * untyped JSON takes the shared types.
 */
export class NshPiloClient implements BridgedPiloClient {
	private readonly pilo: PiloNative;
	private readonly listeners = new Set<PiloClientEventOptions>();
	private polling = false;
	private streamClosed = false;
	/** A batch that arrived after its last listener left, for the next one. */
	private held: NativeEventBatch | undefined;

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

	/** Messages of the project's saved sessions that contain the query. */
	async searchSessions(
		projectId: string,
		query: string,
		limit?: number,
	): Promise<SessionSearchMatch[]> {
		return (await this.pilo.searchSessions(
			projectId,
			query,
			limit,
		)) as SessionSearchMatch[];
	}

	/** A title from the naming model, or null when none is configured. */
	generateSessionTitle(projectId: string, message: string) {
		return this.pilo.generateSessionTitle(projectId, message);
	}

	/** Deletes a session that `listSessions` has returned. */
	async deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult> {
		return (await this.pilo.deleteSession(
			projectId,
			sessionPath,
		)) as SessionDeleteResult;
	}

	/**
	 * The bytes of one image attachment in a session file. A fingerprint from
	 * the history that named the image rejects a file that changed since.
	 */
	async readHistoryImage(
		projectId: string,
		sessionPath: string,
		imageId: string,
		fingerprint?: SessionHistoryFingerprint,
	) {
		return (await this.pilo.readHistoryImage(
			projectId,
			sessionPath,
			imageId,
			fingerprint,
		)) as ImageBytes;
	}

	/** The bytes of an image at a path relative to the project. */
	async readProjectImage(projectId: string, path: string) {
		return (await this.pilo.readProjectImage(projectId, path)) as ImageBytes;
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

	/** Starts or resumes Pi for the key and resolves once it is ready. */
	async startChat(input: PiloClientStartChatInput): Promise<PiSessionSnapshot> {
		return (await this.pilo.startChat(input)) as PiSessionSnapshot;
	}

	/** Stops Pi for the key; a session that is not running is left alone. */
	stopChat(sessionKey: string, reason?: string) {
		return this.pilo.stopChat(sessionKey, reason);
	}

	/** Live runtime state for the key, without transcript text. */
	async chatState(sessionKey: string): Promise<ChatSessionRuntimeState | null> {
		return (await this.pilo.chatState(
			sessionKey,
		)) as ChatSessionRuntimeState | null;
	}

	/**
	 * Resolves once the Pi RPC command is sent. Its response and the turn's
	 * events arrive through `connectEvents`.
	 */
	sendChatCommand(sessionKey: string, command: Record<string, unknown>) {
		return this.pilo.sendChatCommand(sessionKey, command);
	}

	/** Whether the runtime shut down: its event stream never resumes. */
	get closed() {
		return this.streamClosed;
	}

	/**
	 * Delivers runtime events in sequence order, starting with those queued
	 * since the native module was created. A listener can therefore receive
	 * events at or below the `latestSequence` of its own bootstrap: state that
	 * the bootstrap snapshot already holds skips them, but chat deltas are not
	 * dropped by that sequence (see `desktop/README.md`). The module has no
	 * replay cursor, so `after` is not honored: a `resyncRequired` message
	 * names the last sequence the queue dropped, and the listener bootstraps
	 * again. `onStatus(false)` follows a runtime shutdown or a failed poll;
	 * connecting again resumes a failed stream.
	 */
	connectEvents(options: PiloClientEventOptions): Promise<() => void> {
		if (this.streamClosed) {
			options.onStatus(false);
			return Promise.resolve(() => {});
		}
		this.listeners.add(options);
		options.onStatus(true);
		void this.poll();
		return Promise.resolve(() => {
			if (this.listeners.delete(options)) options.onStatus(false);
		});
	}

	/** Await before the app quits; later calls reject. */
	shutdown() {
		return this.pilo.shutdown();
	}

	/** Keeps one native poll in flight while anyone listens. */
	private async poll() {
		if (this.polling) return;
		this.polling = true;
		try {
			while (this.listeners.size > 0) {
				const batch =
					this.held ??
					((await this.pilo.nextEvents(EVENT_BATCH_SIZE)) as NativeEventBatch);
				this.held = undefined;
				if (batch.type === "closed") {
					this.streamClosed = true;
					break;
				}
				if (this.listeners.size === 0) {
					this.held = batch;
					break;
				}
				this.publish(
					batch.type === "gap"
						? { type: "resyncRequired", latestSequence: batch.lastMissed }
						: batch,
				);
			}
		} catch (error) {
			console.error("Pilo event polling failed", error);
		}
		this.polling = false;
		this.disconnect();
	}

	private publish(message: PiloClientEventMessage) {
		for (const listener of [...this.listeners]) {
			notify(() => listener.onMessage(message));
		}
	}

	private disconnect() {
		const listeners = [...this.listeners];
		this.listeners.clear();
		for (const listener of listeners) {
			notify(() => listener.onStatus(false));
		}
	}
}

/** One listener that throws must not stop the stream for the others. */
function notify(call: () => void) {
	try {
		call();
	} catch (error) {
		console.error("Pilo event listener failed", error);
	}
}
