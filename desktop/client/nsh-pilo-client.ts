import type { Pilo } from "app/native";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { ProjectPiModels } from "@/lib/api/pi-models-types";
import type {
	PiModel,
	PiloRuntimeEvent,
	PiSessionSnapshot,
} from "@/lib/api/pi-runtime-types";
import type {
	PiloClient,
	PiloClientBootstrap,
	PiloClientEvent,
	PiloClientEventMessage,
	PiloClientEventOptions,
	PiloClientHistoryOptions,
	PiloClientStartChatInput,
} from "@/lib/api/pilo-client";
import type { Project } from "@/lib/api/projects-types";
import type {
	SessionDeleteResult,
	SessionHistoryFingerprint,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionSearchMatch,
} from "@/lib/api/sessions-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";
import type { CacheKeepAliveSettings } from "@/lib/cache-keep-alive";
import type {
	NextPromptModel,
	NextPromptRequest,
	NextPromptSettings,
} from "@/lib/next-prompt-types";
import type {
	PromptEnhancementModel,
	PromptEnhancementSettings,
} from "@/lib/prompt-enhancement-types";
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
	| "chatTranscriptSnapshot"
	| "sendChatCommand"
	| "listProjects"
	| "listSessions"
	| "searchSessions"
	| "generateSessionTitle"
	| "deleteSession"
	| "loadHistory"
	| "readHistoryImage"
	| "readProjectImage"
	| "loadConnectionModels"
	| "loadModels"
	| "loadModelScope"
	| "saveModelScope"
	| "loadCacheKeepAliveSettings"
	| "saveCacheKeepAliveSettings"
	| "loadNextPromptSettings"
	| "saveNextPromptSettings"
	| "requestNextPrompt"
	| "loadPromptEnhancementSettings"
	| "savePromptEnhancementSettings"
	| "enhancePrompt"
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

/** The messages of a session's saved history a transcript snapshot reads. */
export type ChatTranscriptWindow = Omit<
	PiloClientHistoryOptions,
	"fingerprint"
>;

/**
 * A chat's transcript at one point of the event stream. Unless `live` is
 * truncated, every event of the session up to `eventSequence` is already in
 * `history` or `live`.
 */
export type ChatTranscriptSnapshot = {
	eventSequence: number;
	sessionKey: string;
	generation: number;
	history: SessionHistoryResult;
	live:
		| { type: "idle" }
		/** The turn in progress, as its events in order up to the cut. */
		| { type: "active"; events: PiloRuntimeEvent[] }
		/**
		 * The running turn cannot be rebuilt from this cut, and `history` is
		 * empty rather than the session's. Load the transcript again once the
		 * turn has settled.
		 */
		| { type: "truncated" };
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
	| "loadHistory"
	| "readHistoryImage"
	| "readProjectImage"
	| "loadConnectionModels"
	| "loadModels"
	| "loadModelScope"
	| "saveModelScope"
	| "loadCacheKeepAliveSettings"
	| "saveCacheKeepAliveSettings"
	| "loadNextPromptSettings"
	| "saveNextPromptSettings"
	| "requestNextPrompt"
	| "loadPromptEnhancementSettings"
	| "savePromptEnhancementSettings"
	| "enhancePrompt"
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
	 * A window of a saved session's history, read from its file without
	 * starting Pi; by default the last 256 messages with the message index.
	 * It is the settled history only: it has no place in the event stream,
	 * so a turn in progress is not in it and events cannot be applied on top.
	 */
	async loadHistory(
		projectId: string,
		sessionPath: string,
		options?: PiloClientHistoryOptions,
	): Promise<SessionHistoryResult> {
		return (await this.pilo.loadHistory(
			projectId,
			sessionPath,
			options,
		)) as SessionHistoryResult;
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

	/** Pi's current user-level model catalog for the connection. */
	async loadConnectionModels(connectionId: string): Promise<PiModel[]> {
		return (await this.pilo.loadConnectionModels(connectionId)) as PiModel[];
	}

	/**
	 * The project's saved model catalog, or null when none is cached. It does
	 * not start Pi or refresh the cache.
	 */
	async loadModels(projectId: string): Promise<ProjectPiModels | null> {
		return (await this.pilo.loadModels(projectId)) as ProjectPiModels | null;
	}

	/** The project's model scope; `models: null` means it inherits Pi's. */
	async loadModelScope(projectId: string): Promise<ProjectModelScope> {
		return (await this.pilo.loadModelScope(projectId)) as ProjectModelScope;
	}

	/**
	 * Replaces the project's model scope with the ordered list, `[]` for an
	 * empty one, or restores inheriting Pi's with `null`. Listeners also get
	 * the new scope as a `project_model_scope_changed` event.
	 */
	async saveModelScope(
		projectId: string,
		models: ProjectScopedModel[] | null,
	): Promise<ProjectModelScope> {
		return (await this.pilo.saveModelScope(
			projectId,
			models,
		)) as ProjectModelScope;
	}

	/** The connection's saved cache keep-alive policies, one per model. */
	async loadCacheKeepAliveSettings(
		connectionId: string,
	): Promise<CacheKeepAliveSettings[]> {
		return (await this.pilo.loadCacheKeepAliveSettings(
			connectionId,
		)) as CacheKeepAliveSettings[];
	}

	/**
	 * Saves one model's policy and returns it with the `updatedAtMs` the Host
	 * assigned. Listeners also get it as `cache_keep_alive_settings_changed`.
	 */
	async saveCacheKeepAliveSettings(
		settings: CacheKeepAliveSettings,
	): Promise<CacheKeepAliveSettings> {
		return (await this.pilo.saveCacheKeepAliveSettings(
			settings,
		)) as CacheKeepAliveSettings;
	}

	/** The connection's next-prompt settings; disabled when never saved. */
	async loadNextPromptSettings(
		connectionId: string,
	): Promise<NextPromptSettings> {
		return (await this.pilo.loadNextPromptSettings(
			connectionId,
		)) as NextPromptSettings;
	}

	/**
	 * Replaces the connection's next-prompt settings; a `null` model follows
	 * the chat's. Listeners also get them as `next_prompt_settings_changed`.
	 */
	async saveNextPromptSettings(
		connectionId: string,
		enabled: boolean,
		model: NextPromptModel | null,
	): Promise<NextPromptSettings> {
		return (await this.pilo.saveNextPromptSettings(
			connectionId,
			enabled,
			model,
		)) as NextPromptSettings;
	}

	/**
	 * Asks a running, idle chat for a next-prompt suggestion, or cancels the
	 * request with the same identity. It resolves once the request is sent;
	 * the suggestion arrives through `connectEvents`.
	 */
	requestNextPrompt(request: NextPromptRequest) {
		return this.pilo.requestNextPrompt(request);
	}

	/** The connection's prompt enhancement settings; disabled when never saved. */
	async loadPromptEnhancementSettings(
		connectionId: string,
	): Promise<PromptEnhancementSettings> {
		return (await this.pilo.loadPromptEnhancementSettings(
			connectionId,
		)) as PromptEnhancementSettings;
	}

	/**
	 * Replaces the connection's prompt enhancement settings; a `null` model
	 * follows the chat's. Listeners also get them as
	 * `prompt_enhancement_settings_changed`.
	 */
	async savePromptEnhancementSettings(
		connectionId: string,
		enabled: boolean,
		model: PromptEnhancementModel | null,
	): Promise<PromptEnhancementSettings> {
		return (await this.pilo.savePromptEnhancementSettings(
			connectionId,
			enabled,
			model,
		)) as PromptEnhancementSettings;
	}

	/**
	 * The draft rewritten by the project's connection, which must have prompt
	 * enhancement enabled. Its saved model is used, else `model` (the
	 * chat's), else Pi's default. The rewrite runs outside the chat: it
	 * neither enters the transcript nor waits behind a running turn.
	 */
	enhancePrompt(
		projectId: string,
		draft: string,
		model: PromptEnhancementModel | null,
	) {
		return this.pilo.enhancePrompt(projectId, draft, model);
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

	async savePreferences(
		patch: PreferencePatch,
		initial?: boolean,
	): Promise<PreferencesSnapshot> {
		// Ordinary saves keep the one-argument native call.
		const saved =
			initial === undefined
				? await this.pilo.savePreferences(patch)
				: await this.pilo.savePreferences(patch, initial);
		return saved as PreferencesSnapshot;
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
	 * The transcript of a started chat, without starting Pi. Connect to the
	 * events before calling, so that those above the snapshot's
	 * `eventSequence` can be applied on top of it. Without a window it reads
	 * the whole saved history.
	 */
	async chatTranscriptSnapshot(
		sessionKey: string,
		window?: ChatTranscriptWindow,
	): Promise<ChatTranscriptSnapshot> {
		return (await this.pilo.chatTranscriptSnapshot(
			sessionKey,
			window,
		)) as ChatTranscriptSnapshot;
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
