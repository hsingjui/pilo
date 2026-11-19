import { type Accessor, signal } from "nsh";

import type { PiloClientEvent } from "@/lib/api/pilo-client";
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
	"chatState" | "chatTranscriptSnapshot"
>;

export type ChatTranscriptState = {
	/** The open chat, or `null` when none is. */
	sessionKey: string | null;
	/**
	 * `loading` until a snapshot is applied, `ready` while the conversation
	 * is exact and kept current, `not_loaded` when the runtime has no
	 * snapshot to give (Pi is not running for the chat, or its turns cannot
	 * be rebuilt), `failed` when the read itself failed.
	 */
	status: "closed" | "loading" | "ready" | "not_loaded" | "failed";
	/** What the chat shows; kept from before while a newer read is awaited. */
	conversation: ConversationState | null;
	message?: string;
};

const closed: ChatTranscriptState = {
	sessionKey: null,
	status: "closed",
	conversation: null,
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

/**
 * Whether the event shows a Pi process running for the chat that the last
 * read did not find: its process came up, or it is the first event of a
 * process newer than `seen`, the newest one known so far.
 */
function showsNewProcess(event: PiloClientEvent, seen: number | undefined) {
	if (event.type === "process_state") return event.state === "running";
	return (
		"generation" in event && (seen === undefined || event.generation > seen)
	);
}

/**
 * The transcript of the one open chat, for a chat whose Pi is running. It is
 * read as a snapshot at a point of the event stream and kept current from
 * the events after that point; the owner passes it every event batch and
 * tells it when the stream lost events. Opening a chat starts nothing.
 */
export class ChatTranscriptStore {
	private readonly current = signal(closed);
	readonly state: Accessor<ChatTranscriptState> = this.current;

	private readonly client: ChatTranscriptClient;
	private readonly context: ConversationReducerContext;
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

	constructor(
		client: ChatTranscriptClient,
		context: ConversationReducerContext,
	) {
		this.client = client;
		this.context = context;
	}

	/** Shows the chat; `connected` says whether events are being received. */
	open(sessionKey: string, connected: boolean, window?: ChatTranscriptWindow) {
		this.window = window;
		this.reset();
		this.current.set({ sessionKey, status: "loading", conversation: null });
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
		this.buffer = undefined;
		this.cut = undefined;
		this.waiting = false;
		this.seen = undefined;
	}

	/**
	 * Reads the open chat again: the stream lost events or was reconnected,
	 * so the events after the last snapshot can no longer be trusted.
	 */
	refresh() {
		if (this.current().sessionKey === null) return Promise.resolve();
		return this.read();
	}

	/** Takes a batch of runtime events, in order, of any chat or of none. */
	receive(events: readonly PiloClientEvent[]) {
		const { sessionKey, status } = this.current();
		if (sessionKey === null) return;
		const later: PiloClientEvent[] = [];
		for (const event of events) {
			if (event.sessionKey !== sessionKey) continue;
			if (this.buffer) {
				// Looked at when the read in flight is done.
				this.buffer.push(event);
				continue;
			}
			if (this.waiting) {
				if (settles(event)) void this.read(true);
			} else if (this.cut) {
				if ("generation" in event && event.generation > this.cut.generation) {
					// Pi was restarted: the snapshot is of the old process.
					this.flush(later);
					void this.read();
				} else if (followsSnapshot(this.cut, event)) {
					later.push(event);
				}
			} else if (
				(status === "not_loaded" || status === "failed") &&
				showsNewProcess(event, this.seen)
			) {
				// Pi came up for a chat that had no transcript to give, as it
				// does when the first prompt is sent.
				void this.read();
			}
			this.see(event);
		}
		this.flush(later);
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
	 * Reads the chat's runtime state and, if Pi is running, its snapshot.
	 * `settled` marks the one read made because the turn of a truncated
	 * snapshot is over: if that read is truncated too, the chat cannot be
	 * read this way and is left as not loaded instead of asked again.
	 */
	private async read(settled = false) {
		const read = ++this.reads;
		const state = this.current();
		const sessionKey = state.sessionKey;
		if (sessionKey === null) return;
		this.buffer = [];
		this.cut = undefined;
		this.waiting = false;
		if (state.status !== "loading") {
			this.current.set({
				sessionKey,
				status: "loading",
				conversation: state.conversation,
			});
		}
		const finish = (next: Omit<ChatTranscriptState, "sessionKey">) => {
			const buffered = this.buffer ?? [];
			this.buffer = undefined;
			this.current.set({ sessionKey, ...next });
			const seen = this.seen;
			for (const event of buffered) this.see(event);
			// Pi may have come up while this read was finding none.
			if (
				(next.status === "not_loaded" || next.status === "failed") &&
				buffered.some((event) => showsNewProcess(event, seen))
			) {
				void this.read();
			}
		};
		try {
			const runtime = await this.client.chatState(sessionKey);
			if (this.reads !== read) return;
			if (runtime) this.sawProcess(runtime.snapshot.generation);
			if (runtime?.snapshot.state !== "running") {
				finish({ status: "not_loaded", conversation: state.conversation });
				return;
			}
			const snapshot = await this.client.chatTranscriptSnapshot(
				sessionKey,
				this.window,
			);
			if (this.reads !== read) return;
			const buffered = this.buffer ?? [];
			const conversation = conversationFromSnapshot(
				snapshot,
				buffered,
				this.context,
			);
			if (conversation) {
				this.cut = {
					sessionKey,
					generation: snapshot.generation,
					eventSequence: snapshot.eventSequence,
				};
				finish({ status: "ready", conversation });
				if (
					buffered.some(
						(event) =>
							"generation" in event && event.generation > snapshot.generation,
					)
				) {
					void this.read();
				}
			} else if (settled) {
				finish({ status: "not_loaded", conversation: state.conversation });
			} else {
				finish({ status: "loading", conversation: state.conversation });
				// The turn may have settled while the snapshot was on its way.
				if (
					buffered.some(
						(event) =>
							event.sequence > snapshot.eventSequence && settles(event),
					)
				) {
					void this.read(true);
				} else {
					this.waiting = true;
				}
			}
		} catch (error) {
			if (this.reads !== read) return;
			finish({
				status: "failed",
				conversation: state.conversation,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
