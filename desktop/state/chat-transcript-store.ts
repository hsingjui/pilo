import { type Accessor, signal } from "nsh";

import {
	alignHistoryMessages,
	buildHistoryPrefix,
	HISTORY_PAGE_MESSAGE_COUNT,
	HISTORY_PREFETCH_MESSAGES,
	INITIAL_HISTORY_MESSAGE_COUNT,
	sameHistoryFingerprint,
} from "@shared/chat/chat-history-window-model";
import { createChatHistoryWindowStore } from "@shared/chat/chat-history-window-store";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import type {
	SessionHistoryFingerprint,
	SessionHistoryResult,
} from "@shared/api/sessions-types";
import type { AssistantPendingStatus } from "@shared/chat/chat-activity-state";
import { createConversationState } from "@shared/chat/conversation-reducer";
import {
	reduceConversationActions,
	replayConversationEvents,
} from "@shared/chat/conversation-replay";
import type {
	ChatConversationImage,
	ChatMessage,
	ConversationAction,
	ConversationReducerContext,
	ConversationState,
} from "@shared/chat/conversation-types";
import type {
	ChatTranscriptSnapshot,
	ChatTranscriptWindow,
	NshPiloClient,
} from "../client/nsh-pilo-client";
import {
	applyChatEvents,
	conversationFromHistory,
	conversationFromSnapshot,
	followsSnapshot,
} from "./chat-transcript";

export type ChatTranscriptClient = Pick<
	NshPiloClient,
	"chatState" | "chatTranscriptSnapshot" | "loadHistory"
>;

/** The chat to show: its session key, and where its saved session is. */
export type ChatTranscriptTarget = {
	sessionKey: string;
	projectId: string;
	/** The session file; absent for a chat that was never saved. */
	sessionPath?: string | null;
};

export type ChatTranscriptState = {
	/** The open chat, or `null` when none is. */
	sessionKey: string | null;
	/**
	 * `loading` while a read is awaited or a turn that cannot be rebuilt is
	 * waited out, `ready` when the conversation is the chat's, `not_loaded`
	 * when there is nothing to read it from (its turns cannot be rebuilt and
	 * it has no session file), `failed` when the read itself failed.
	 */
	status: "closed" | "loading" | "ready" | "not_loaded" | "failed";
	/**
	 * The chat's newest messages, and the turn in progress; kept from before
	 * while a newer read is awaited. A read loads the session's last
	 * messages, and the events of the chat add to them.
	 */
	conversation: ConversationState | null;
	/**
	 * Every saved message before the conversation's, oldest first, so that
	 * message `i` of the session is at index `i`. One that is not loaded is
	 * a placeholder: `historyPlaceholder` is set, `text` is a preview and
	 * `historyEstimatedChars` its estimated length. It has the id the
	 * message keeps once loaded, and `loadRange` loads it in its place. The
	 * array changes when messages are loaded or the chat is read again, not
	 * as a turn streams.
	 */
	historyPrefix: readonly ChatMessage[];
	/**
	 * Where the conversation came from. One from a `snapshot` is exact and
	 * follows the chat's events as they arrive. One from the session file's
	 * settled `history` shows finished turns only: a running turn appears
	 * when it has settled.
	 */
	source: "snapshot" | "history" | null;
	message?: string;
};

const noMessages: readonly ChatMessage[] = [];

const closed: ChatTranscriptState = {
	sessionKey: null,
	status: "closed",
	conversation: null,
	historyPrefix: noMessages,
	source: null,
};

/** The session file a read's placeholders stand for. */
type SavedHistory = {
	projectId: string;
	sessionPath: string;
	/** The file as the read found it; a page of a changed file is not used. */
	fingerprint: SessionHistoryFingerprint;
	/** The messages before the read's window, none of them loaded. */
	placeholders: readonly ChatMessage[];
	/** The loaded messages `historyPrefix` was last built with. */
	shown: ReadonlyMap<number, ChatMessage>;
	/** The first messages of the pages being read. */
	pages: Set<number>;
};

/**
 * A prompt sent from this app as the chat's next turn, shown before Pi
 * echoes it: the actions that put it and its pending reply on screen.
 */
type LocalTurn = {
	clientMessageId: string;
	actions: ConversationAction[];
};

/** The conversation without a local turn's prompt and pending reply. */
function withoutLocalTurn(
	conversation: ConversationState,
	clientMessageId: string,
): ConversationState {
	const owned = conversation.active?.localClientMessageId === clientMessageId;
	const replyId = owned ? conversation.active?.assistantMessageId : undefined;
	return {
		...conversation,
		messages: conversation.messages.filter(
			(message) => message.id !== clientMessageId && message.id !== replyId,
		),
		pendingUsers: conversation.pendingUsers.filter(
			(pending) => pending.clientMessageId !== clientMessageId,
		),
		active: owned ? null : conversation.active,
	};
}

/** What a read asks for: the session's last messages and its message index. */
const firstWindow: ChatTranscriptWindow = {
	messageLimit: INITIAL_HISTORY_MESSAGE_COUNT,
	includeMessageIndex: true,
};

/** Whether the event says no turn is running in the chat any more. */
function settles(event: PiloClientEvent) {
	return (
		event.type === "assistant_message_end" ||
		event.type === "runtime_error" ||
		(event.type === "pi_reattached" && !event.active) ||
		piExited(event)
	);
}

/** Whether the event says the chat's Pi process is gone. */
function piExited(event: PiloClientEvent) {
	return (
		event.type === "process_state" &&
		(event.state === "failed" || event.state === "stopped")
	);
}

/** Whether the event is one the Host counts as a turn having started. */
function startsTurn(event: PiloClientEvent) {
	return (
		event.type === "user_message_start" ||
		event.type === "assistant_message_start" ||
		event.type === "auto_retry_start"
	);
}

/**
 * The transcript of the one open chat. Opening a chat starts nothing.
 *
 * While Pi runs for the chat, the transcript is read as a snapshot at a
 * point of the event stream and kept current from the events after that
 * point; the owner passes in every event batch and says when the stream
 * lost events. When no snapshot can be had (no Pi is running, or the
 * runtime cannot rebuild the chat's turn), the session file's settled
 * history is shown instead. A snapshot is tried again when Pi comes up
 * and when the next turn starts.
 *
 * Either way a read loads only the session's last messages. The ones before
 * them are held in the Tauri app's history window store and shown as
 * `historyPrefix`: placeholders, which `loadRange` loads a page at a time
 * as the WebUI does. Message `i` of the session is always at index `i` of
 * `messages()`: a message is loaded, or put back to its placeholder, in its
 * place.
 */
export class ChatTranscriptStore {
	private readonly current = signal(closed);
	readonly state: Accessor<ChatTranscriptState> = this.current;
	/**
	 * Every message of the chat in order: the history prefix, then the
	 * conversation's. The array is built when this is read after either
	 * changed, which costs a copy of the prefix: reading it for each event
	 * of a streaming turn is what a long session pays for. It is not a
	 * `computed`, which would build it for each event whether read or not.
	 */
	readonly messages: Accessor<readonly ChatMessage[]> = () => {
		const { conversation, historyPrefix } = this.current();
		const loaded = conversation?.messages ?? noMessages;
		if (historyPrefix.length === 0) return loaded;
		if (
			this.joined?.historyPrefix !== historyPrefix ||
			this.joined.loaded !== loaded
		) {
			this.joined = {
				historyPrefix,
				loaded,
				messages: [...historyPrefix, ...loaded],
			};
		}
		return this.joined.messages;
	};
	/** What `messages` last joined. */
	private joined:
		| {
				historyPrefix: readonly ChatMessage[];
				loaded: readonly ChatMessage[];
				messages: readonly ChatMessage[];
		  }
		| undefined;

	private readonly client: ChatTranscriptClient;
	private readonly context: ConversationReducerContext;
	private target: ChatTranscriptTarget | undefined;
	/** The session's message index and which of its older messages are loaded. */
	private readonly older = createChatHistoryWindowStore();
	/** Where the placeholders of the last read can be loaded from, if anywhere. */
	private saved: SavedHistory | undefined;
	/** The range of messages last asked for, loaded again after each read. */
	private wanted: { startIndex: number; endIndex: number } | undefined;
	/**
	 * The file a page came from instead of the one the chat was read from,
	 * when the chat was read again for it; `undefined` when it was not. A
	 * later page from that same file does not read the chat again, since
	 * the last read did not get the chat onto it: that costs one read per
	 * change of the file, however often a range is asked for. A turn ending
	 * forgets it, since a read may then give another file.
	 */
	private rereadFor: SessionHistoryFingerprint | null | undefined;
	/** Counts reads, so one superseded by a newer read is dropped. */
	private reads = 0;
	/** The chat's events since the read in flight was requested. */
	private buffer: PiloClientEvent[] | undefined;
	/** The snapshot the conversation was built from, while it is exact. */
	private cut:
		| Pick<
				ChatTranscriptSnapshot,
				"sessionKey" | "generation" | "eventSequence"
		  >
		| undefined;
	/** Whether a truncated snapshot's turn is being waited out. */
	private waiting = false;
	/** The newest Pi process of the chat that a read or an event has shown. */
	private seen: number | undefined;
	/** Whether the last read found Pi running for the chat. */
	private running = false;
	/** Whether a snapshot was already tried for the turn now running. */
	private tried = false;
	/**
	 * Whether the chat is a new one that nothing was read for: its first Pi
	 * starts after the chat was opened, so each of its events arrives here.
	 */
	private fresh = false;
	/** The prompt sent from this app that Pi has not echoed yet. */
	private local: LocalTurn | undefined;

	constructor(
		client: ChatTranscriptClient,
		context: ConversationReducerContext,
	) {
		this.client = client;
		this.context = context;
	}

	/** Shows the chat. A fresh draft has no file or running Pi to read yet. */
	open(
		target: ChatTranscriptTarget,
		connected: boolean,
		options?: { freshDraft: boolean },
	) {
		const freshDraft = options?.freshDraft;
		this.reset();
		this.target = target;
		this.fresh = !!freshDraft;
		this.current.set({
			sessionKey: target.sessionKey,
			status: freshDraft ? "ready" : "loading",
			conversation: freshDraft ? createConversationState() : null,
			historyPrefix: noMessages,
			source: null,
		});
		// A draft reads once Pi starts. If disconnected, `refresh()` reads
		// once the event stream is back.
		return connected && !freshDraft ? this.read() : Promise.resolve();
	}

	close() {
		this.reset();
		this.current.set(closed);
	}

	/**
	 * The open new chat now has the file Pi saves it to; it is the same chat,
	 * so nothing is read again. The file is where its settled history is read
	 * from once Pi no longer runs for it.
	 */
	adoptSessionPath(sessionPath: string) {
		if (this.target) this.target = { ...this.target, sessionPath };
	}

	/**
	 * Shows a prompt the user sent as the open chat's next turn, with a
	 * pending reply, as the Tauri app does before Pi has started or echoed
	 * it; Pi's echo then takes its place. Gives the turn's id, or `null` when
	 * the chat is not open, not shown yet, or already has such a turn.
	 */
	submitLocal(
		sessionKey: string,
		text: string,
		images: ChatConversationImage[],
	): string | null {
		if (
			this.target?.sessionKey !== sessionKey ||
			!this.current().conversation ||
			this.local
		) {
			return null;
		}
		const timestampMs = this.context.now();
		const clientMessageId = this.context.createMessageId("user");
		this.local = {
			clientMessageId,
			actions: [
				{
					type: "local_user_submit",
					clientMessageId,
					text,
					images,
					timestampMs,
				},
				{ type: "local_assistant_pending", timestampMs, pendingStatus: null },
			],
		};
		this.applyLocal(this.local.actions);
		return clientMessageId;
	}

	/**
	 * What a local turn's pending reply waits for: Pi to start, or Pi to take
	 * the prompt; nothing once it has.
	 */
	setLocalStatus(clientMessageId: string, status?: AssistantPendingStatus) {
		const { local } = this;
		if (local?.clientMessageId !== clientMessageId) return;
		const action: ConversationAction = {
			type: "local_assistant_status",
			clientMessageId,
			status,
		};
		local.actions.push(action);
		this.applyLocal([action]);
	}

	/** Takes back a local turn whose prompt did not start a turn. */
	dropLocal(clientMessageId: string) {
		if (this.local?.clientMessageId !== clientMessageId) return;
		this.local = undefined;
		const state = this.current();
		if (!state.conversation) return;
		this.current.set({
			...state,
			conversation: withoutLocalTurn(state.conversation, clientMessageId),
		});
	}

	private applyLocal(actions: readonly ConversationAction[]) {
		const state = this.current();
		if (!state.conversation) return;
		this.current.set({
			...state,
			conversation: reduceConversationActions(
				state.conversation,
				actions,
				this.context,
			),
		});
	}

	/** A conversation a read gave, with the local turn still waiting for Pi. */
	private withLocal(conversation: ConversationState) {
		return this.local
			? reduceConversationActions(
					conversation,
					this.local.actions,
					this.context,
				)
			: conversation;
	}

	/** Forgets the chat that was open, and drops a read of it in flight. */
	private reset() {
		this.reads += 1;
		this.older.initialize([], 0);
		this.saved = undefined;
		this.wanted = undefined;
		this.rereadFor = undefined;
		this.joined = undefined;
		this.target = undefined;
		this.buffer = undefined;
		this.cut = undefined;
		this.waiting = false;
		this.seen = undefined;
		this.running = false;
		this.tried = false;
		this.fresh = false;
		this.local = undefined;
	}

	/**
	 * Reads the open chat again: the stream lost events or was reconnected,
	 * so the events after the last snapshot can no longer be trusted.
	 */
	refresh() {
		return this.target ? this.read() : Promise.resolve();
	}

	/** Takes a batch of runtime events, in order, of any chat or of none. */
	receive(events: readonly PiloClientEvent[]) {
		const sessionKey = this.target?.sessionKey;
		if (sessionKey === undefined) return;
		const later: PiloClientEvent[] = [];
		let turnOver = false;
		for (const event of events) {
			if (event.sessionKey !== sessionKey) continue;
			turnOver ||= settles(event);
			// Pi's echo of the local prompt, or the end of its process, takes
			// the place of what was shown for it.
			if (event.type === "user_message_start" || settles(event)) {
				this.local = undefined;
			}
			if (this.buffer) {
				// Looked at when the read in flight is done.
				this.buffer.push(event);
			} else if (this.cut) {
				if ("generation" in event && event.generation > this.cut.generation) {
					// Pi was restarted: the snapshot is of the old process.
					this.flush(later);
					void this.read();
				} else if (followsSnapshot(this.cut, event)) {
					if (event.type === "pi_reattached" || piExited(event)) {
						// Reattachment may have missed Pi events without a Host stream
						// gap; a Pi that exited leaves the settled history, without
						// the turn it may have been running.
						this.flush(later);
						void this.read();
					} else {
						later.push(event);
					}
				}
				this.see(event);
			} else if (this.fresh && "generation" in event) {
				// A new chat's first Pi: all of its events follow the empty
				// conversation, so they are applied as they come, without a
				// snapshot read that would replace the turn on screen.
				this.fresh = false;
				this.running = true;
				this.cut = {
					sessionKey,
					generation: event.generation,
					eventSequence: event.sequence - 1,
				};
				later.push(event);
				this.see(event);
			} else {
				this.react(event);
			}
		}
		this.flush(later);
		if (turnOver) {
			// What could not be loaded during the turn may be loadable now.
			this.rereadFor = undefined;
			this.fill();
		}
	}

	/**
	 * Takes an event of a chat that has no snapshot to apply it to, and reads
	 * the chat when the event says a read could now give more than the last.
	 */
	private react(event: PiloClientEvent) {
		const { status } = this.current();
		const turnOver = settles(event);
		if (turnOver) this.tried = false;
		if (this.waiting) {
			// The turn a truncated snapshot could not rebuild is over.
			if (turnOver) void this.read(true);
		} else if (this.showsNewProcess(event)) {
			// Pi came up for the chat, as it does when the first prompt is sent.
			void this.read();
		} else if (this.running && status !== "failed") {
			if (turnOver) {
				// The settled history has that turn now.
				void this.read(true);
			} else if (startsTurn(event) && !this.tried) {
				// A turn the runtime can rebuild puts the chat back on a
				// snapshot; try only once per turn.
				this.tried = true;
				void this.read();
			}
		}
		this.see(event);
	}

	/**
	 * Whether the event shows a Pi process running for the chat that the last
	 * read did not find: its process reached the running state, or it is the
	 * first event of a process newer than any seen so far.
	 */
	private showsNewProcess(event: PiloClientEvent) {
		if (!("generation" in event)) return false;
		if (this.seen === undefined || event.generation > this.seen) {
			return event.type !== "process_state" || event.state === "running";
		}
		return (
			!this.running &&
			event.type === "process_state" &&
			event.state === "running"
		);
	}

	private see(event: PiloClientEvent) {
		if ("generation" in event) this.sawProcess(event.generation);
	}

	private sawProcess(generation: number) {
		if (this.seen === undefined || generation > this.seen) {
			this.seen = generation;
		}
	}

	/**
	 * Loads the placeholders among messages `startIndex` to `endIndex` of
	 * `messages()`, the range a list shows, and a few around them, in the
	 * WebUI's pages. The messages stay loaded while they are in the range
	 * last asked for; of the others, only the most recently loaded are kept.
	 * Asking for messages that are loaded reads nothing.
	 */
	loadRange(startIndex: number, endIndex: number) {
		this.wanted = { startIndex, endIndex };
		this.fill();
	}

	/** Reads the pages of the wanted range that are not loaded or on their way. */
	private fill() {
		const { saved, wanted } = this;
		if (!saved || !wanted || this.current().status !== "ready") return;
		const end = this.older.getSnapshot().runtimeBaseStart - 1;
		const first = Math.max(0, wanted.startIndex - HISTORY_PREFETCH_MESSAGES);
		const last = Math.min(end, wanted.endIndex + HISTORY_PREFETCH_MESSAGES);
		// Keeps the range loaded, and may put others back to placeholders.
		this.older.setPinnedRange(first, last);
		this.showPrefix();
		const size = HISTORY_PAGE_MESSAGE_COUNT;
		for (
			let start = Math.floor(first / size) * size;
			start <= last;
			start += size
		) {
			const pageEnd = Math.min(end, start + size - 1);
			if (
				this.older.isRangeHydrated(start, pageEnd) ||
				saved.pages.has(start)
			) {
				continue;
			}
			saved.pages.add(start);
			void this.loadPage(saved, start, pageEnd - start + 1);
		}
	}

	private async loadPage(
		saved: SavedHistory,
		startMessage: number,
		messageLimit: number,
	) {
		try {
			const { history, fingerprint } = await this.client.loadHistory(
				saved.projectId,
				saved.sessionPath,
				{
					startMessage,
					messageLimit,
					includeMessageIndex: false,
					fingerprint: saved.fingerprint,
				},
			);
			if (this.saved !== saved) return;
			if (!sameHistoryFingerprint(saved.fingerprint, fingerprint)) {
				// The file changed since the chat was read, so the page may not
				// be of the messages the placeholders stand for.
				if (
					this.rereadFor === undefined ||
					!sameHistoryFingerprint(this.rereadFor, fingerprint)
				) {
					this.rereadFor = fingerprint;
					void this.read();
				}
				return;
			}
			const start = history.windowStartMessage ?? startMessage;
			const { messages } = alignHistoryMessages(
				replayConversationEvents(history.events, this.context),
				this.older.getSnapshot().directory,
				start,
			);
			this.older.hydrate(start, messages);
			this.showPrefix();
		} catch {
			// The page stays as placeholders; asking for it again reads it again.
		} finally {
			saved.pages.delete(startMessage);
		}
	}

	/** Shows the placeholders with the loaded messages in their places. */
	private showPrefix() {
		const { saved } = this;
		const { hydrated } = this.older.getSnapshot();
		if (!saved || saved.shown === hydrated) return;
		saved.shown = hydrated;
		// Not `buildHistoryPrefix`, which would build every placeholder again.
		const historyPrefix = saved.placeholders.slice();
		for (const [index, message] of hydrated) historyPrefix[index] = message;
		this.current.set({ ...this.current(), historyPrefix });
	}

	/**
	 * Takes the message index a read came with, and gives the messages
	 * before the read's window, none of them loaded yet. A read with no
	 * index, as of a chat with no session file, has none before it.
	 */
	private prefixOf(
		projectId: string,
		result?: SessionHistoryResult,
		sessionPath?: string | null,
	) {
		const { messageIndex = [], windowStartMessage = 0 } = result?.history ?? {};
		this.older.initialize(messageIndex, windowStartMessage);
		const snapshot = this.older.getSnapshot();
		const placeholders = buildHistoryPrefix(snapshot);
		// Without the file's fingerprint a page could not be told from one of
		// a changed file, so the placeholders stay as they are.
		this.saved =
			placeholders.length > 0 && sessionPath && result?.fingerprint
				? {
						projectId,
						sessionPath,
						fingerprint: result.fingerprint,
						placeholders,
						shown: snapshot.hydrated,
						pages: new Set(),
					}
				: undefined;
		return placeholders.length > 0 ? placeholders : noMessages;
	}

	private flush(events: PiloClientEvent[]) {
		const state = this.current();
		if (events.length === 0 || !state.conversation || !this.cut) return;
		const conversation = applyChatEvents(
			state.conversation,
			events.splice(0),
			this.context,
		);
		if (conversation !== state.conversation) {
			this.current.set({ ...state, conversation });
		}
	}

	/**
	 * Reads the chat's runtime state, then its snapshot if Pi is running, or
	 * its settled history if not. A truncated snapshot of a running turn is
	 * waited out: nothing new is shown until the turn has settled.
	 *
	 * `settled` marks the read made because a turn is over. A snapshot that
	 * is truncated then, or with no turn running, will not get better by
	 * waiting, so the settled history is read instead.
	 */
	private async read(settled = false) {
		const read = ++this.reads;
		const target = this.target;
		if (!target) return;
		const { sessionKey } = target;
		const shown = this.current();
		this.buffer = [];
		this.cut = undefined;
		this.waiting = false;
		this.fresh = false;
		if (shown.status !== "loading") {
			this.current.set({
				sessionKey,
				status: "loading",
				conversation: shown.conversation,
				historyPrefix: shown.historyPrefix,
				source: shown.source,
			});
		}
		/** Ends the read; `after` is the snapshot's cut, when it took one. */
		const finish = (
			next: Pick<ChatTranscriptState, "status" | "message"> &
				Partial<
					Pick<ChatTranscriptState, "conversation" | "historyPrefix" | "source">
				>,
			after = -1,
		) => {
			const buffered = this.buffer ?? [];
			this.buffer = undefined;
			this.current.set({
				sessionKey,
				// Not `shown`'s: a local turn may have been shown during the read.
				conversation: this.current().conversation,
				// Not `shown`'s: messages may have been loaded during the read.
				historyPrefix: this.current().historyPrefix,
				source: shown.source,
				...next,
			});
			return buffered.filter((event) => event.sequence > after);
		};
		try {
			const runtime = await this.client.chatState(sessionKey);
			if (this.reads !== read) return;
			if (runtime) this.sawProcess(runtime.snapshot.generation);
			this.running = runtime?.snapshot.state === "running";
			let after = -1;
			if (this.running) {
				const snapshot = await this.client.chatTranscriptSnapshot(
					sessionKey,
					firstWindow,
				);
				if (this.reads !== read) return;
				const events = this.buffer ?? [];
				if (
					snapshot.live.type !== "truncated" &&
					events.some(
						(event) =>
							event.type === "pi_reattached" &&
							followsSnapshot(snapshot, event),
					)
				) {
					void this.read();
					return;
				}
				const conversation = conversationFromSnapshot(
					snapshot,
					events,
					this.context,
				);
				if (conversation) {
					// A snapshot taken after Pi took the local prompt holds its echo.
					if (
						snapshot.live.type === "active" &&
						snapshot.live.events.some(
							(event) => event.type === "user_message_start",
						)
					) {
						this.local = undefined;
					}
					this.cut = {
						sessionKey,
						generation: snapshot.generation,
						eventSequence: snapshot.eventSequence,
					};
					const buffered = finish({
						status: "ready",
						conversation: this.withLocal(conversation),
						historyPrefix: this.prefixOf(
							target.projectId,
							snapshot.history,
							runtime?.sessionPath ?? target.sessionPath,
						),
						source: "snapshot",
					});
					this.fill();
					for (const event of buffered) this.see(event);
					if (this.seen !== undefined && this.seen > snapshot.generation) {
						void this.read();
					}
					return;
				}
				after = snapshot.eventSequence;
				if (!settled && (runtime?.activeTurn || runtime?.compacting)) {
					const later = finish({ status: "loading" }, after);
					this.waiting = true;
					// The turn may have settled while the snapshot was on its way.
					for (const event of later) this.receive([event]);
					return;
				}
			}
			// No snapshot can be had now: the settled history is what there is.
			const sessionPath = runtime?.sessionPath ?? target.sessionPath;
			let result: Pick<ChatTranscriptState, "status"> &
				Partial<
					Pick<ChatTranscriptState, "conversation" | "historyPrefix" | "source">
				>;
			if (sessionPath) {
				const settledHistory = await this.client.loadHistory(
					target.projectId,
					sessionPath,
					firstWindow,
				);
				if (this.reads !== read) return;
				result = {
					status: "ready",
					conversation: this.withLocal(
						conversationFromHistory(settledHistory.history, this.context),
					),
					historyPrefix: this.prefixOf(
						target.projectId,
						settledHistory,
						sessionPath,
					),
					source: "history",
				};
			} else if (this.running) {
				// A chat that was never saved, with turns that cannot be rebuilt.
				result = { status: "not_loaded" };
			} else {
				result = {
					status: "ready",
					conversation: this.withLocal(
						replayConversationEvents([], this.context),
					),
					historyPrefix: this.prefixOf(target.projectId),
					source: "history",
				};
			}
			// Pi may have come up, or a turn started or ended, meanwhile.
			for (const event of finish(result, after)) this.receive([event]);
			this.fill();
		} catch (error) {
			if (this.reads !== read) return;
			const later = finish({
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
			for (const event of later) this.receive([event]);
		}
	}
}
