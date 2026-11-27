import { type Accessor, computed, lifecycle, signal } from "nsh";

import { chatSessionKey } from "@shared/api/chat-session-key";
import {
	runtimeSessionIdFromKey,
	runtimeSessionPathKey,
} from "@shared/chat/chat-session-runtime-model";
import type {
	PiloClientEvent,
	PiloClientEventMessage,
} from "@shared/api/pilo-client";
import type { Project } from "@shared/api/projects-types";
import type { SessionDeleteResult } from "@shared/api/sessions-types";
import type { SessionReadState } from "@shared/session-read-state";
import type { ThemeSettings } from "@shared/theme-settings-types";
import type {
	NshPiloClient,
	NshPiloClientBootstrap,
} from "../client/nsh-pilo-client";
import {
	type AppAction,
	type AppState,
	type SessionSelection,
	changesChatSession,
	changesSessionIndex,
	createAppState,
	createDraftSessionId,
	createTemporarySessionId,
	isDraftSessionId,
	isSessionUnread,
	isStaleEvent,
	isTemporarySessionId,
	readStateKey,
	reduceAppState,
} from "./app-state";
import type {
	ChatTranscriptStore,
	ChatTranscriptTarget,
} from "./chat-transcript-store";

export type AppStoreBootstrap = NshPiloClientBootstrap & {
	uiState?: {
		themeSettings: ThemeSettings;
		sessionReadStates: SessionReadState[];
	};
};

export type AppStoreClient = Partial<
	// Optional: a client without the probe shows no external Pi turns.
	Pick<NshPiloClient, "externalSessionActivity">
> &
	Pick<
		NshPiloClient,
		| "chatState"
		| "listProjects"
		| "addProject"
		| "listSessions"
		| "removeProject"
		| "loadSessionReadStates"
		| "loadThemeSettings"
		| "markSessionRead"
		| "updateSessionUiState"
		| "deleteSession"
		| "connectEvents"
		| "closed"
	> & {
		bootstrap(): Promise<AppStoreBootstrap>;
		/** A transient disconnect leaves subscriptions registered. */
		readonly reconnectsEvents?: boolean;
	};

/**
 * The app state as one signal, kept current from the Pilo client: a bootstrap
 * fills it, runtime events move it, and a gap in the event stream or a
 * reconnect bootstraps again. Events that arrive while a bootstrap is in
 * flight wait for it, so they are applied to the snapshot they follow.
 */
export class AppStore {
	private readonly current = signal(createAppState());
	readonly state: Accessor<AppState> = this.current;
	/** The active navigation session slice, isolated from unrelated AppState changes. */
	readonly openSession = computed(() => this.current().navigation.session);
	/** The saved session whose chat is visible in the foreground. */
	readonly viewedSessionKey = computed(() => {
		const open = this.openSession();
		return open?.sessionPath &&
			lifecycle() === "active" &&
			this.showsChat(open.projectId)
			? readStateKey(open.projectId, open.sessionPath)
			: null;
	});

	isViewingSession(projectId: string, sessionPath: string) {
		return this.viewedSessionKey() === readStateKey(projectId, sessionPath);
	}

	private readonly pendingNewChatFocus = signal<SessionSelection | null>(null);
	/** A one-shot focus request for the draft the user just opened. */
	readonly newChatFocus = computed(() => {
		const open = this.current().navigation.session;
		return open?.sessionId && open === this.pendingNewChatFocus()
			? chatSessionKey(open.projectId, open.sessionId)
			: null;
	});

	private readonly liveListeners = new Set<
		(event: PiloClientEvent | null) => void
	>();
	private readonly messageListeners = new Set<
		(message: PiloClientEventMessage | null) => void
	>();
	private readonly client: AppStoreClient;
	private readonly chat: ChatTranscriptStore | undefined;
	/** Identifies the current event connection; unset while disconnected. */
	private connection: object | undefined;
	private disconnect: (() => void) | undefined;
	/** Whether a sync finished on the current event connection. */
	private synced = false;
	/** Whether the stream was resumed and has delivered no event since. */
	private resumed = false;
	private syncing: Promise<void> | undefined;
	private syncAgain = false;
	/** The most recent confirmed gap still awaiting a fresh bootstrap. */
	private temporaryGap: object | undefined;
	private readonly pending: PiloClientEvent[] = [];
	/** Counts project reads, so a reload superseded by a newer read is dropped. */
	private projectReads = 0;
	private readonly sessionReads = new Map<string, number>();
	private readonly sessionScans = new Map<string, Promise<void>>();
	private readonly sessionRefreshes = new Map<
		string,
		{ next: "cache" | "unwatched" | null }
	>();
	/** Counts external activity reads, so one a push or newer read overtook is dropped. */
	private readonly externalReads = new Map<string, number>();
	/** Counts applied bootstraps, each of which replaces the chat states. */
	private bootstraps = 0;
	/** The chats whose runtime state is being read, and whether to read again. */
	private readonly chatReads = new Map<string, { again: boolean }>();

	/**
	 * `chat`, when given, is the open chat's transcript: it gets every event
	 * batch as it arrives, and is read again when the stream lost events or
	 * was reconnected.
	 */
	constructor(
		client: AppStoreClient,
		chat?: ChatTranscriptStore,
		private readonly onLiveEvent?: (event: PiloClientEvent) => void,
		private readonly showsChat: (projectId: string) => boolean = () => true,
	) {
		this.client = client;
		this.chat = chat;
	}

	/** Whether runtime events are being received. */
	get connected() {
		return this.connection !== undefined;
	}

	/** Reads the theme for the first frame without waiting for the snapshot. */
	async preloadThemeSettings() {
		const settings = await this.client.loadThemeSettings();
		this.apply({ type: "theme_settings_loaded", settings });
	}

	/** Connects to runtime events and loads the first snapshot. */
	start() {
		this.resumed = false;
		return this.open();
	}

	/** Recovers from a failed status: reconnects if needed and loads again. */
	retry() {
		return this.connection ? this.sync() : this.start();
	}

	private async open() {
		await this.connect();
		if (!this.connection) return;
		// Events from before this connection are not on top of the chat's
		// last snapshot any more.
		void this.chat?.resync();
		await this.sync();
	}

	/**
	 * Loads, or loads again, the saved sessions of one project. A read the
	 * user did not ask for (`showProgress` false) keeps the project row as it
	 * is, as the WebUI's background refreshes do.
	 */
	loadSessions(projectId: string, showProgress = true) {
		return this.trackScan(
			projectId,
			this.readSessions(projectId, showProgress, "scan"),
		);
	}

	/** Track reads that may scan so background index reads can wait for them. */
	private trackScan(projectId: string, read: Promise<void>) {
		const scan = read.finally(() => {
			if (this.sessionScans.get(projectId) === scan) {
				this.sessionScans.delete(projectId);
			}
		});
		this.sessionScans.set(projectId, scan);
		return scan;
	}

	private async readBackgroundSessions(
		projectId: string,
		mode: "cache" | "unwatched",
	) {
		// Both modes can return the cached index. Wait for scans to commit
		// before claiming a read sequence so an older index cannot win.
		let scan = this.sessionScans.get(projectId);
		while (scan) {
			// oxlint-disable-next-line no-await-in-loop -- A newer scan may have started in the meantime.
			await scan;
			scan = this.sessionScans.get(projectId);
		}
		const read = this.readSessions(projectId, false, mode);
		return mode === "unwatched" ? this.trackScan(projectId, read) : read;
	}

	private async readSessions(
		projectId: string,
		showProgress: boolean,
		mode: "scan" | "cache" | "unwatched",
	) {
		const read = (this.sessionReads.get(projectId) ?? 0) + 1;
		this.sessionReads.set(projectId, read);
		if (showProgress) {
			this.apply({ type: "sessions_loading", projectId });
			// Pushes keep it current from here, as the WebUI read it once
			// per project it lists.
			void this.loadExternalActivity(projectId);
		}
		let action: AppAction;
		try {
			const sessions = await this.client.listSessions(
				projectId,
				mode === "cache",
				mode === "unwatched",
			);
			action = { type: "sessions_loaded", projectId, sessions };
		} catch (error) {
			// A background read must not replace an already loaded list with an error.
			if (
				!showProgress &&
				this.current().sessionIndexes[projectId]?.status === "loaded"
			) {
				return;
			}
			action = { type: "sessions_failed", projectId, message: describe(error) };
		}
		if (this.sessionReads.get(projectId) === read) this.apply(action);
	}

	/** Removes a project; the runtime's answer replaces the catalog. */
	async removeProject(projectId: string) {
		const projects = await this.client.removeProject(projectId);
		this.apply({ type: "projects_loaded", projects });
	}

	/** Adds a project on a connection, then reloads the catalog. */
	async addProject(connectionId: string, path: string): Promise<Project> {
		const project = await this.client.addProject(connectionId, path);
		await this.reloadProjects();
		return project;
	}

	/** Opens a new chat in the project, or keeps its already open draft. */
	selectProject(projectId: string, { focusComposer = true } = {}) {
		this.selectNewChat(projectId, { temporary: false, focusComposer });
	}

	/**
	 * Opens a temporary chat in the project, which Pi does not save, or keeps
	 * the empty one already open there.
	 */
	selectTemporary(projectId: string) {
		this.selectNewChat(projectId, { temporary: true, focusComposer: true });
	}

	clearNewChatFocus() {
		this.pendingNewChatFocus.set(null);
	}

	private selectNewChat(
		projectId: string,
		{
			temporary,
			focusComposer,
		}: { temporary: boolean; focusComposer: boolean },
	) {
		const state = this.current();
		const openId = this.keepsOpenDraft(projectId, temporary)
			? state.navigation.session?.sessionId
			: undefined;
		const openKey = openId && chatSessionKey(projectId, openId);
		// A draft no longer has a sidebar row, so return to it via its project.
		const recover =
			!temporary &&
			!(openKey && state.unsentDrafts?.has(openKey)) &&
			[...(state.unsentDrafts ?? [])].find(
				([key, draft]) =>
					draft.projectId === projectId &&
					!state.pendingDrafts.has(key) &&
					!state.sentDrafts?.has(key),
			);
		const restoredId =
			recover && runtimeSessionIdFromKey(recover[0], projectId);
		if (!openId || restoredId) {
			this.apply({
				type: "project_selected",
				projectId,
				sessionId:
					restoredId ||
					(temporary ? createTemporarySessionId() : createDraftSessionId()),
			});
		}
		const open = this.current().navigation.session;
		if (focusComposer && open?.projectId === projectId) {
			this.pendingNewChatFocus.set(open);
		}
	}

	/** Whether the open chat is an unused new one of that kind in the project. */
	private keepsOpenDraft(projectId: string, temporary: boolean) {
		const state = this.current();
		const open = state.navigation.session;
		if (
			open?.projectId !== projectId ||
			open.sessionId === undefined ||
			isTemporarySessionId(open.sessionId) !== temporary
		)
			return false;
		const sessionKey = chatSessionKey(projectId, open.sessionId);
		const hasMessages =
			this.chat?.state().sessionKey === sessionKey &&
			this.chat.messageCount() > 0;
		const active = state.chatSessions.some(
			(chat) => chat.sessionKey === sessionKey && chat.activeTurn,
		);
		return (
			!hasMessages &&
			!active &&
			!state.pendingDrafts.has(sessionKey) &&
			!state.sentDrafts?.has(sessionKey)
		);
	}

	/** Keeps background startup state before Pi has accepted the prompt. */
	setPendingDraft(
		{ sessionKey, projectId }: ChatTranscriptTarget,
		text: string | null,
	) {
		this.current.update((state) => {
			if (text === null && !state.pendingDrafts.has(sessionKey)) return state;
			const pendingDrafts = new Map(state.pendingDrafts);
			if (text === null) pendingDrafts.delete(sessionKey);
			else {
				pendingDrafts.set(sessionKey, {
					projectId,
					title: text.replace(/\s+/g, " ").trim(),
					startedAt: Date.now(),
				});
			}
			return { ...state, pendingDrafts };
		});
	}

	/** Makes an accepted prompt visible even if Pi has not yet echoed it. */
	confirmDraft(
		{ sessionKey, sessionPath }: ChatTranscriptTarget,
		text: string,
	) {
		if (!sessionPath) this.apply({ type: "draft_sent", sessionKey, text });
	}

	/** Keeps unsent new chats reachable via their project, not the sidebar list. */
	setUnsentDraft(
		{ sessionKey, projectId, sessionPath }: ChatTranscriptTarget,
		text: string | null,
	) {
		const sessionId = runtimeSessionIdFromKey(sessionKey, projectId);
		if (!sessionId || !isDraftSessionId(sessionId)) return;
		const title = sessionPath
			? null
			: (text?.replace(/\s+/g, " ").trim() ?? null);
		this.current.update((state) => {
			const previous = state.unsentDrafts?.get(sessionKey);
			if ((previous?.title ?? null) === title) return state;
			const unsentDrafts = new Map(state.unsentDrafts);
			if (title === null) unsentDrafts.delete(sessionKey);
			else {
				unsentDrafts.set(sessionKey, {
					projectId,
					title,
					startedAt: previous?.startedAt ?? Date.now(),
				});
			}
			return { ...state, unsentDrafts };
		});
	}

	/** Opens again a new chat Pi has not saved yet, by its draft session id. */
	selectDraft(projectId: string, sessionId: string) {
		this.apply({ type: "project_selected", projectId, sessionId });
	}

	/**
	 * Opens a session and, as the user is now looking at it, acknowledges its
	 * completed turns.
	 */
	selectSession(projectId: string, sessionPath: string) {
		const sessions = this.current().sessionIndexes[projectId]?.sessions;
		const pathKey = runtimeSessionPathKey(sessionPath);
		// Pi can report a different Windows spelling than the session index.
		const indexed =
			sessions?.find((entry) => entry.sessionPath === sessionPath) ??
			sessions?.find(
				(entry) => runtimeSessionPathKey(entry.sessionPath) === pathKey,
			);
		const path = indexed?.sessionPath ?? sessionPath;
		this.apply({ type: "session_selected", projectId, sessionPath: path });
		const opened = this.current().navigation.session;
		if (opened?.projectId === projectId && opened.sessionPath === path) {
			this.acknowledgeOpenSession();
		}
	}

	/**
	 * Renames a saved session. The sidebar shows the new title from the
	 * `sessions_indexed` event the runtime sends after the write.
	 */
	renameSession(projectId: string, sessionPath: string, title: string) {
		const session = this.current().sessionIndexes[projectId]?.sessions.find(
			(entry) => entry.sessionPath === sessionPath,
		);
		if (!session) return Promise.resolve();
		return this.client
			.updateSessionUiState(
				sessionPath,
				{ pinned: session.pinned, titleOverride: title },
				projectId,
			)
			.then(() => undefined);
	}

	/** Deletes a saved session; the one open in the chat pane closes. */
	async deleteSession(
		projectId: string,
		sessionPath: string,
	): Promise<SessionDeleteResult> {
		const result = await this.client.deleteSession(projectId, sessionPath);
		this.apply({ type: "session_deleted", projectId, sessionPath });
		return result;
	}

	/**
	 * Tells the runtime the user has seen the open session's completed turns,
	 * when it has any they have not. The state follows the runtime's read-state
	 * event.
	 */
	acknowledgeOpenSession() {
		const state = this.current();
		const opened = state.navigation.session;
		const { projectId, sessionPath } = opened ?? {};
		if (
			!projectId ||
			!sessionPath ||
			!isSessionUnread(state, projectId, sessionPath)
		) {
			return;
		}
		const read = state.readStates[readStateKey(projectId, sessionPath)];
		if (!read) return;
		this.client
			.markSessionRead(projectId, read.sessionPath, read.completedRevision)
			.catch((error: unknown) => {
				console.error("Marking the session read failed", error);
			});
	}

	/** Null invalidates work that depends on an uninterrupted live stream. */
	subscribeLiveEvents(listener: (event: PiloClientEvent | null) => void) {
		this.liveListeners.add(listener);
		return () => {
			this.liveListeners.delete(listener);
		};
	}

	/** Subscribes to raw stream messages (including events at or below bootstrap); null signals disconnect. */
	subscribeEventMessages(
		listener: (message: PiloClientEventMessage | null) => void,
	) {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	/** Stops listening to runtime events. */
	stop() {
		const disconnect = this.disconnect;
		const connected = this.connected;
		this.connection = undefined;
		this.disconnect = undefined;
		this.synced = false;
		disconnect?.();
		if (connected) {
			for (const listener of this.liveListeners) listener(null);
			for (const listener of this.messageListeners) listener(null);
		}
	}

	private apply(...actions: AppAction[]) {
		this.current.set(actions.reduce(reduceAppState, this.current()));
	}

	private async connect() {
		this.stop();
		const connection = {};
		this.connection = connection;
		const disconnect = await this.client.connectEvents({
			onMessage: (message) => {
				if (this.connection === connection) this.receive(message);
			},
			onStatus: (connected) => {
				if (connected || this.connection !== connection) return;
				if (this.client.reconnectsEvents && !this.client.closed) {
					for (const listener of this.liveListeners) listener(null);
					for (const listener of this.messageListeners) listener(null);
				} else {
					this.dropped();
				}
			},
		});
		if (this.connection === connection) {
			this.disconnect = disconnect;
		} else {
			disconnect();
		}
	}

	/**
	 * The stream ended without `stop()`. After a runtime shutdown it stays
	 * closed. Otherwise a poll failed: a stream that had finished a sync is
	 * resumed and loaded again, once. If it drops again before delivering an
	 * event, or before its load finished, it waits for `retry()`, so a poll
	 * that keeps failing cannot reconnect and bootstrap in a loop.
	 */
	private dropped() {
		const resume = this.synced && !this.resumed;
		this.stop();
		if (this.client.closed) {
			this.apply({ type: "closed" });
		} else if (resume) {
			this.resumed = true;
			void this.open();
		} else {
			this.apply({
				type: "bootstrap_failed",
				message: "The runtime event stream stopped.",
			});
		}
	}

	private receive(message: PiloClientEventMessage) {
		for (const listener of this.messageListeners) listener(message);
		if (message.type === "resyncRequired") {
			for (const listener of this.liveListeners) listener(null);
			void this.chat?.resync();
			// A WebUI reconnect can still replay the reply's real end event.
			if (!message.replayPending) this.temporaryGap = {};
			void this.sync();
		} else if (message.type === "events") {
			this.resumed = false;
			// A chat's events are ordered by its own transcript snapshot, not
			// by the bootstrap, so they do not wait for a sync in flight.
			this.chat?.receive(message.events);
			if (this.syncing) {
				this.pending.push(...message.events);
			} else {
				for (const event of message.events) this.handle(event);
			}
		}
	}

	private handle(event: PiloClientEvent) {
		if (isStaleEvent(this.current(), event)) return;
		if (event.type === "external_session_activity_changed") {
			const reads = this.externalReads.get(event.projectId) ?? 0;
			this.externalReads.set(event.projectId, reads + 1);
		}
		this.apply({ type: "event", event });
		if (event.sequence > this.current().latestSequence) {
			this.onLiveEvent?.(event);
			for (const listener of this.liveListeners) listener(event);
		}
		if (event.sessionKey !== undefined && changesChatSession(event)) {
			void this.refreshChatSession(event.sessionKey);
		}
		if (event.type === "configuration_changed") {
			void this.reloadProjects();
		} else if (
			event.type === "sessions_indexed" ||
			event.type === "assistant_message_start" ||
			changesSessionIndex(event)
		) {
			this.refreshSessionsFor(event);
		}
	}

	/** Reads a project's saved sessions again after an event that can change them. */
	private refreshSessionsFor(event: PiloClientEvent) {
		const state = this.current();
		const chat = state.chatSessions.find(
			(chat) => chat.sessionKey === event.sessionKey,
		);
		const projectId = event.projectId ?? chat?.projectId;
		if (!projectId) return;
		const index = state.sessionIndexes[projectId];
		if (event.type === "assistant_message_start") {
			// The user message is on disk by now. Find the new file without
			// waiting for the reply, but don't scan for each tool step of saved chats.
			const path = chat?.sessionPath;
			const open = state.navigation.session;
			const openDraft =
				open?.sessionId &&
				chatSessionKey(open.projectId, open.sessionId) === event.sessionKey;
			if (
				path
					? index?.sessions.some((entry) => entry.sessionPath === path)
					: !openDraft
			) {
				return;
			}
		}
		if (index || projectId === state.navigation.projectId) {
			// The Host's session watcher indexes file writes itself; a turn or
			// rename event scans only a project it does not watch.
			void this.refreshSessionIndex(
				projectId,
				event.type === "sessions_indexed" ? "cache" : "unwatched",
			);
		}
	}

	/** Coalesce updates without letting a cache read replace a queued scan. */
	private async refreshSessionIndex(
		projectId: string,
		mode: "cache" | "unwatched",
	) {
		const pending = this.sessionRefreshes.get(projectId);
		if (pending) {
			if (pending.next !== "unwatched") pending.next = mode;
			return;
		}
		const refresh: { next: "cache" | "unwatched" | null } = { next: mode };
		this.sessionRefreshes.set(projectId, refresh);
		try {
			while (refresh.next) {
				const mode = refresh.next;
				refresh.next = null;
				// oxlint-disable-next-line no-await-in-loop -- Keep background reads for this project serial.
				await this.readBackgroundSessions(projectId, mode);
			}
		} finally {
			this.sessionRefreshes.delete(projectId);
		}
	}

	/**
	 * Reads one chat's runtime state after an event that can change it, as
	 * the WebUI reads its chat states again on such events. One read per
	 * chat is in flight at a time; events during it cause one more after.
	 */
	async refreshChatSession(sessionKey: string) {
		const pending = this.chatReads.get(sessionKey);
		if (pending) {
			pending.again = true;
			return;
		}
		const read = { again: false };
		this.chatReads.set(sessionKey, read);
		do {
			read.again = false;
			const bootstraps = this.bootstraps;
			try {
				const chat = await this.client.chatState(sessionKey);
				// A bootstrap applied meanwhile is newer than this answer.
				if (this.bootstraps === bootstraps) {
					this.apply({ type: "chat_session_loaded", sessionKey, chat });
				}
			} catch {
				// The state shown stays until the chat's next event or the next
				// bootstrap; a runtime that stopped answering ends the stream.
			}
		} while (read.again);
		this.chatReads.delete(sessionKey);
	}

	/**
	 * Reads which of the project's sessions an external Pi runs a turn in.
	 * The Host pushes later changes; a push that arrives meanwhile wins.
	 */
	private async loadExternalActivity(projectId: string) {
		if (!this.client.externalSessionActivity) return;
		const read = (this.externalReads.get(projectId) ?? 0) + 1;
		this.externalReads.set(projectId, read);
		try {
			const activities = await this.client.externalSessionActivity(projectId);
			if (this.externalReads.get(projectId) === read) {
				this.apply({ type: "external_activity_loaded", projectId, activities });
			}
		} catch (error) {
			// Unknown activity is not proof that external turns ended.
			console.debug("Reading external Pi activity failed", error);
		}
	}

	private async reloadProjects() {
		const read = ++this.projectReads;
		try {
			const projects = await this.client.listProjects();
			if (this.projectReads === read) {
				this.apply({ type: "projects_loaded", projects });
			}
		} catch (error) {
			if (this.projectReads === read) {
				this.apply({ type: "bootstrap_failed", message: describe(error) });
			}
		}
	}

	/** One bootstrap at a time; a request during one runs another after it. */
	private sync() {
		if (this.syncing) {
			this.syncAgain = true;
			return this.syncing;
		}
		this.syncing = this.runSync();
		return this.syncing;
	}

	private async runSync() {
		do {
			this.syncAgain = false;
			const temporaryGap = this.temporaryGap;
			this.projectReads += 1;
			const connection = this.connection;
			// A load for a stream that ended since is not shown: nothing would
			// keep it current.
			const current = () => this.connection === connection;
			try {
				// Theme settings and read states are read after the bootstrap cut,
				// so they hold every event at or below it.
				const snapshot = await this.client.bootstrap();
				const [settings, states] = await Promise.all([
					snapshot.uiState?.themeSettings ?? this.client.loadThemeSettings(),
					snapshot.uiState?.sessionReadStates ??
						this.client.loadSessionReadStates(),
				]);
				if (!current()) continue;
				this.bootstraps += 1;
				if (temporaryGap && temporaryGap === this.temporaryGap) {
					this.temporaryGap = undefined;
					this.chat?.reconcileTemporaryTurns(snapshot);
				}
				this.apply(
					{ type: "bootstrapped", snapshot },
					{ type: "theme_settings_loaded", settings },
					{ type: "read_states_loaded", states },
				);
				for (const projectId of Object.keys(this.current().sessionIndexes)) {
					void this.refreshSessionIndex(projectId, "unwatched");
					// Pushes may have been missed while the stream was out.
					void this.loadExternalActivity(projectId);
				}
				this.synced = true;
			} catch (error) {
				if (current()) {
					this.apply({ type: "bootstrap_failed", message: describe(error) });
				}
			}
		} while (this.syncAgain);
		// Cleared in the same step as the queue is emptied: an event that
		// arrived between the two would wait for a sync that may never come.
		this.syncing = undefined;
		for (const event of this.pending.splice(0)) this.handle(event);
	}
}

function describe(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
