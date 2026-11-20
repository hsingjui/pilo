import type {
	PiloClientEvent,
	PiloClientEventOptions,
	PiloClientStartChatInput,
} from "@/lib/api/pilo-client";
import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { ProjectPiModels } from "@/lib/api/pi-models-types";
import type { PiSessionSnapshot } from "@/lib/api/pi-runtime-types";
import type { ConversationEvent } from "@/lib/chat/conversation-types";
import type { Project } from "@/lib/api/projects-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";
import type {
	SessionHistory,
	SessionHistoryResult,
	SessionIndexEntry,
	SessionUiStateUpdate,
} from "@/lib/api/sessions-types";
import type {
	HostPreferenceValues,
	PreferencesSnapshot,
} from "@/lib/host-preferences-types";
import type { SessionReadState } from "@/lib/session-read-state";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import type { PiCommandClient } from "../client/chat-rpc";
import type { NshPiloClientBootstrap } from "../client/nsh-pilo-client";
import type { AppStoreClient } from "../state/app-store";
import type { ChatTranscriptClient } from "../state/chat-transcript-store";

/** The native calls the scripted client answers beyond the app stores. */
export type ScriptedChatClient = PiCommandClient & {
	startChat: (input: PiloClientStartChatInput) => Promise<PiSessionSnapshot>;
	stopChat: (sessionKey: string, reason?: string) => Promise<void>;
	loadModels: (projectId: string) => Promise<ProjectPiModels | null>;
	saveModels: (snapshot: ProjectPiModels) => Promise<ProjectPiModels>;
	loadModelScope: (projectId: string) => Promise<ProjectModelScope>;
	saveModelScope: (
		projectId: string,
		models: ProjectScopedModel[] | null,
	) => Promise<ProjectModelScope>;
	updateSessionUiState: (
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	) => Promise<SessionIndexEntry>;
};

export type AppScript = {
	projects?: Project[];
	preferences?: PreferencesSnapshot;
	themeSettings?: ThemeSettings;
	/** A project's saved sessions; none when left out. */
	sessions?: (projectId: string) => Promise<SessionIndexEntry[]>;
	chatSessions?: ChatSessionRuntimeState[];
	/** A saved session's settled history; no events when left out. */
	history?: (sessionPath: string) => Promise<ConversationEvent[]>;
	/** Metadata merged into the `loadHistory` answer's `history`. */
	historyMeta?: Partial<SessionHistory>;
	readStates?: SessionReadState[];
	/** Replaces a bootstrap's answer; `undefined` answers from the script. */
	bootstrap?: (attempt: number) => Promise<NshPiloClientBootstrap> | undefined;
	/**
	 * Answers a command sent over the chat command channel. A reply object is
	 * delivered as an `rpc_message` response carrying the command's `id`;
	 * `undefined` leaves the command unanswered (its rpc times out).
	 */
	onCommand?: (
		sessionKey: string,
		command: Record<string, unknown>,
	) => Record<string, unknown> | undefined;
	/** The snapshot `startChat` resolves with; a running one by default. */
	onStartChat?: (
		input: PiloClientStartChatInput,
	) => PiSessionSnapshot | Promise<PiSessionSnapshot>;
	/** A project's saved model catalog; `loadModels` answers null otherwise. */
	models?: Record<string, ProjectPiModels>;
	/** A project's saved model scope; null inherits Pi when left out. */
	modelScopes?: Record<string, ProjectModelScope | null>;
	/** The index entry `updateSessionUiState` resolves with. */
	onUpdateSessionUiState?: (
		sessionPath: string,
		update: SessionUiStateUpdate,
		projectId?: string,
	) => SessionIndexEntry;
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
	const commands: [string, Record<string, unknown>][] = [];
	const savedModels = new Map<string, ProjectPiModels>();
	const modelScopes = new Map(Object.entries(script.modelScopes ?? {}));
	const running = new Set<string>();
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
	const client: AppStoreClient & ChatTranscriptClient & ScriptedChatClient = {
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
		// No Pi runs for a scripted chat, so its transcript is its history.
		chatTranscriptSnapshot: () => Promise.reject(new Error("no Pi is running")),
		startChat(input) {
			running.add(input.sessionKey);
			return Promise.resolve(
				script.onStartChat?.(input) ?? {
					generation: 0,
					state: "running",
					connection: null,
					projectId: input.projectId,
				},
			);
		},
		stopChat(sessionKey) {
			running.delete(sessionKey);
			return Promise.resolve();
		},
		sendChatCommand(sessionKey, command) {
			commands.push([sessionKey, command]);
			const reply = script.onCommand?.(sessionKey, command);
			if (reply !== undefined && typeof command.id === "string") {
				const message = { type: "response", id: command.id, ...reply };
				queueMicrotask(() =>
					emit({ type: "rpc_message", sessionKey, message }),
				);
			}
			return Promise.resolve();
		},
		loadModels: (projectId) =>
			Promise.resolve(
				savedModels.get(projectId) ?? script.models?.[projectId] ?? null,
			),
		saveModels(snapshot) {
			savedModels.set(snapshot.projectId, snapshot);
			return Promise.resolve(snapshot);
		},
		loadModelScope: (projectId) =>
			Promise.resolve(
				modelScopes.get(projectId) ?? {
					projectId,
					models: null,
					updatedAtMs: 0,
				},
			),
		saveModelScope(projectId, models: ProjectScopedModel[] | null) {
			const scope = {
				projectId,
				models,
				updatedAtMs: Date.now(),
			} as ProjectModelScope;
			modelScopes.set(projectId, scope);
			emit({ type: "project_model_scope_changed", scope });
			return Promise.resolve(scope);
		},
		updateSessionUiState(sessionPath, update, projectId) {
			return Promise.resolve(
				script.onUpdateSessionUiState?.(sessionPath, update, projectId) ??
					({
						sessionPath,
						pinned: update.pinned,
						titleOverride: update.titleOverride,
					} as SessionIndexEntry),
			);
		},
		loadHistory: async (_projectId, sessionPath) =>
			({
				history: {
					events: (await script.history?.(sessionPath)) ?? [],
					...script.historyMeta,
				},
				fingerprint: null,
			}) as SessionHistoryResult,
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
		/** Every command sent through `sendChatCommand`, in order. */
		commands,
		/** The runtime shuts down: its event stream ends for good. */
		close() {
			closed = true;
			for (const listener of listeners) listener.onStatus(false);
		},
	};
}
