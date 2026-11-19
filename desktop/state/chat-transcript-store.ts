import { type Accessor, signal } from "nsh";

import type { PiloClientEvent } from "@/lib/api/pilo-client";
import { replayConversationEvents } from "@/lib/chat/conversation-replay";
import type {
	ConversationReducerContext,
	ConversationState,
} from "@/lib/chat/conversation-types";
import type {
	ChatTranscriptSnapshot,
	ChatTranscriptWindow,
	NshPiloClient,
} from "../client/nsh-pilo-client";
import {
	applyChatEvents,
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
	/** What the chat shows; kept from before while a newer read is awaited. */
	conversation: ConversationState | null;
	/**
	 * Where the conversation came from. One from a `snapshot` is exact and
	 * follows the chat's events as they arrive. One from the session file's
	 * settled `history` shows finished turns only: a running turn appears
	 * when it has settled.
	 */
	source: "snapshot" | "history" | null;
	message?: string;
};

const closed: ChatTranscriptState = {
	sessionKey: null,
	status: "closed",
	conversation: null,
	source: null,
};

/** Whether the event says no turn is running in the chat any more. */
function settles(event: PiloClientEvent) {
	return (
		event.type === "assistant_message_end" ||
		event.type === "runtime_error" ||
		(event.type === "pi_reattached" && !event.active) ||
		(event.type === "process_state" &&
			(event.state === "failed" || event.state === "stopped"))
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
 * runtime cannot rebuild the chat's turns, as for every remote chat), the
 * session file's settled history is shown instead, and a snapshot is tried
 * again when Pi comes up and when the next turn starts.
 */
export class ChatTranscriptStore {
	private readonly current = signal(closed);
	readonly state: Accessor<ChatTranscriptState> = this.current;

	private readonly client: ChatTranscriptClient;
	private readonly context: ConversationReducerContext;
	private target: ChatTranscriptTarget | undefined;
	private window: ChatTranscriptWindow | undefined;
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

	constructor(
		client: ChatTranscriptClient,
		context: ConversationReducerContext,
	) {
		this.client = client;
		this.context = context;
	}

	/** Shows the chat; `connected` says whether events are being received. */
	open(
		target: ChatTranscriptTarget,
		connected: boolean,
		window?: ChatTranscriptWindow,
	) {
		this.reset();
		this.target = target;
		this.window = window;
		this.current.set({
			sessionKey: target.sessionKey,
			status: "loading",
			conversation: null,
			source: null,
		});
		// Without the event stream there is nothing to apply on top of a
		// snapshot; `refresh()` reads it once the stream is back.
		return connected ? this.read() : Promise.resolve();
	}

	close() {
		this.reset();
		this.current.set(closed);
	}

	/** Forgets the chat that was open, and drops a read of it in flight. */
	private reset() {
		this.reads += 1;
		this.target = undefined;
		this.buffer = undefined;
		this.cut = undefined;
		this.waiting = false;
		this.seen = undefined;
		this.running = false;
		this.tried = false;
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
		for (const event of events) {
			if (event.sessionKey !== sessionKey) continue;
			if (this.buffer) {
				// Looked at when the read in flight is done.
				this.buffer.push(event);
			} else if (this.cut) {
				if ("generation" in event && event.generation > this.cut.generation) {
					// Pi was restarted: the snapshot is of the old process.
					this.flush(later);
					void this.read();
				} else if (followsSnapshot(this.cut, event)) {
					later.push(event);
				}
				this.see(event);
			} else {
				this.react(event);
			}
		}
		this.flush(later);
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
				// snapshot; one try per turn, since a remote chat's never can.
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
		if (shown.status !== "loading") {
			this.current.set({
				sessionKey,
				status: "loading",
				conversation: shown.conversation,
				source: shown.source,
			});
		}
		/** Ends the read; `after` is the snapshot's cut, when it took one. */
		const finish = (
			next: Pick<ChatTranscriptState, "status" | "message"> &
				Partial<Pick<ChatTranscriptState, "conversation" | "source">>,
			after = -1,
		) => {
			const buffered = this.buffer ?? [];
			this.buffer = undefined;
			this.current.set({
				sessionKey,
				conversation: shown.conversation,
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
					this.window,
				);
				if (this.reads !== read) return;
				const conversation = conversationFromSnapshot(
					snapshot,
					this.buffer ?? [],
					this.context,
				);
				if (conversation) {
					this.cut = {
						sessionKey,
						generation: snapshot.generation,
						eventSequence: snapshot.eventSequence,
					};
					const buffered = finish({
						status: "ready",
						conversation,
						source: "snapshot",
					});
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
				Partial<Pick<ChatTranscriptState, "conversation" | "source">>;
			if (sessionPath) {
				const { history } = await this.client.loadHistory(
					target.projectId,
					sessionPath,
					this.window,
				);
				if (this.reads !== read) return;
				result = {
					status: "ready",
					conversation: replayConversationEvents(history.events, this.context),
					source: "history",
				};
			} else if (this.running) {
				// A chat that was never saved, with turns that cannot be rebuilt.
				result = { status: "not_loaded" };
			} else {
				result = {
					status: "ready",
					conversation: replayConversationEvents([], this.context),
					source: "history",
				};
			}
			// Pi may have come up, or a turn started or ended, meanwhile.
			for (const event of finish(result, after)) this.receive([event]);
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
