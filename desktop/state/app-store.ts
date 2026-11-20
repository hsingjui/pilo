import { type Accessor, signal } from "nsh";

import type {
	PiloClientEvent,
	PiloClientEventMessage,
} from "@/lib/api/pilo-client";
import type { Project } from "@/lib/api/projects-types";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import {
	type AppAction,
	type AppState,
	changesChatSession,
	createAppState,
	createDraftSessionId,
	isSessionUnread,
	isStaleEvent,
	readStateKey,
	reduceAppState,
} from "./app-state";
import type { ChatTranscriptStore } from "./chat-transcript-store";

export type AppStoreClient = Pick<
	NshPiloClient,
	| "bootstrap"
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
>;

/**
 * The app state as one signal, kept current from the Pilo client: a bootstrap
 * fills it, runtime events move it, and a gap in the event stream or a
 * reconnect bootstraps again. Events that arrive while a bootstrap is in
 * flight wait for it, so they are applied to the snapshot they follow.
 */
export class AppStore {
	private readonly current = signal(createAppState());
	readonly state: Accessor<AppState> = this.current;

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
	private readonly pending: PiloClientEvent[] = [];
	/** Counts project reads, so a reload superseded by a newer read is dropped. */
	private projectReads = 0;
	private readonly sessionReads = new Map<string, number>();
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
	) {
		this.client = client;
		this.chat = chat;
	}

	/** Whether runtime events are being received. */
	get connected() {
		return this.connection !== undefined;
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
		void this.chat?.refresh();
		await this.sync();
	}

	/** Loads, or loads again, the saved sessions of one project. */
	async loadSessions(projectId: string) {
		const read = (this.sessionReads.get(projectId) ?? 0) + 1;
		this.sessionReads.set(projectId, read);
		this.apply({ type: "sessions_loading", projectId });
		let action: AppAction;
		try {
			const sessions = await this.client.listSessions(projectId);
			action = { type: "sessions_loaded", projectId, sessions };
		} catch (error) {
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

	/** Chooses the project for a new chat and closes the open session. */
	selectProject(projectId: string) {
		this.apply({
			type: "project_selected",
			projectId,
			sessionId: createDraftSessionId(),
		});
	}

	/**
	 * Opens a session and, as the user is now looking at it, acknowledges its
	 * completed turns.
	 */
	selectSession(projectId: string, sessionPath: string) {
		this.apply({ type: "session_selected", projectId, sessionPath });
		const opened = this.current().navigation.session;
		if (opened?.projectId === projectId && opened.sessionPath === sessionPath) {
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
			.then(() => undefined)
			.catch((error: unknown) => {
				console.error("Renaming the session failed", error);
			});
	}

	/** Deletes a saved session; the one open in the chat pane closes. */
	async deleteSession(projectId: string, sessionPath: string) {
		try {
			await this.client.deleteSession(projectId, sessionPath);
		} catch (error) {
			console.error("Deleting the session failed", error);
			return;
		}
		this.apply({ type: "session_deleted", projectId, sessionPath });
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
			.markSessionRead(projectId, sessionPath, read.completedRevision)
			.catch((error: unknown) => {
				console.error("Marking the session read failed", error);
			});
	}

	/** Stops listening to runtime events. */
	stop() {
		const disconnect = this.disconnect;
		this.connection = undefined;
		this.disconnect = undefined;
		this.synced = false;
		disconnect?.();
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
				if (!connected && this.connection === connection) this.dropped();
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
		if (message.type === "resyncRequired") {
			void this.chat?.refresh();
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
		this.apply({ type: "event", event });
		if (event.sequence > this.current().latestSequence)
			this.onLiveEvent?.(event);
		if (event.sessionKey !== undefined && changesChatSession(event)) {
			void this.loadChatSession(event.sessionKey);
		}
		if (event.type === "configuration_changed") {
			void this.reloadProjects();
		} else if (
			event.type === "sessions_indexed" &&
			event.projectId in this.current().sessionIndexes
		) {
			void this.loadSessions(event.projectId);
		}
	}

	/**
	 * Reads one chat's runtime state after an event that can change it, as
	 * the WebUI reads its chat states again on such events. One read per
	 * chat is in flight at a time; events during it cause one more after.
	 */
	private async loadChatSession(sessionKey: string) {
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
					this.client.loadThemeSettings(),
					this.client.loadSessionReadStates(),
				]);
				if (!current()) continue;
				this.bootstraps += 1;
				this.apply(
					{ type: "bootstrapped", snapshot },
					{ type: "theme_settings_loaded", settings },
					{ type: "read_states_loaded", states },
				);
				for (const projectId of Object.keys(this.current().sessionIndexes)) {
					void this.loadSessions(projectId);
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
