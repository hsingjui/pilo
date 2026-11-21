import type { PiloRuntimeEvent } from "@shared/api/pi-runtime-types";
import type { ChatSubmission } from "@shared/chat/chat-submission";
import type { ConversationState } from "@shared/chat/conversation-types";

type PendingUsers = ConversationState["pendingUsers"];

type QueuedSubmission = {
	submission: ChatSubmission;
	queueKind: "steer" | "follow_up";
};

/** A null submission still occupies an echo slot, e.g. for a direct prompt. */
type ParkedSubmission = {
	clientMessageId: string;
	submission: ChatSubmission | null;
};

export function isStreamStalled(errorMessage?: string | null): boolean {
	return errorMessage?.startsWith("PILO_STREAM_STALLED:") ?? false;
}

export class RemoteChatQueue {
	private readonly active = new Map<string, QueuedSubmission>();
	private readonly parked = new Map<string, ParkedSubmission[]>();

	addActive(id: string, item: QueuedSubmission) {
		this.active.set(id, item);
	}

	getActive(id: string) {
		return this.active.get(id);
	}

	snapshotActive() {
		return [...this.active.entries()];
	}

	removeActive(id: string) {
		return this.active.delete(id);
	}

	has(id: string) {
		return (
			this.active.has(id) ||
			[...this.parked.values()].some((items) =>
				items.some((item) => item.clientMessageId === id && item.submission),
			)
		);
	}

	/** False once a stall, echo or queue action has taken the submission. */
	forget(id: string) {
		if (this.removeActive(id)) return true;
		for (const [sessionKey, items] of this.parked) {
			const index = items.findIndex(
				(item) => item.clientMessageId === id && item.submission,
			);
			if (index < 0) continue;
			// It never reached Pi, so no echo will consume its slot.
			items.splice(index, 1);
			if (!items.some((item) => item.submission))
				this.parked.delete(sessionKey);
			return true;
		}
		return false;
	}

	park(sessionKey: string | null, pendingUsers: PendingUsers) {
		if (sessionKey && this.active.size > 0) {
			// Keep every unacknowledged user slot in send order for background echoes.
			const items = pendingUsers.map((pending) => ({
				clientMessageId: pending.clientMessageId,
				submission: pending.queueKind
					? (this.active.get(pending.clientMessageId)?.submission ?? null)
					: null,
			}));
			if (items.some((item) => item.submission)) {
				this.parked.set(sessionKey, [
					...(this.parked.get(sessionKey) ?? []),
					...items,
				]);
			}
		}
		this.active.clear();
	}

	acknowledgeActive(pending: PendingUsers[number] | undefined) {
		if (pending?.queueKind) this.removeActive(pending.clientMessageId);
	}

	takeStalledActive(pendingUsers: PendingUsers) {
		const recovered: { clientMessageId: string; submission: ChatSubmission }[] =
			[];
		for (const pending of pendingUsers) {
			if (!pending.queueKind) continue;
			const id = pending.clientMessageId;
			const queued = this.active.get(id);
			if (!queued) continue;
			this.removeActive(id);
			recovered.push({ clientMessageId: id, submission: queued.submission });
		}
		return recovered;
	}

	handleParkedEvent(event: PiloRuntimeEvent): ChatSubmission[] | undefined {
		if (!event.sessionKey) return;
		const items = this.parked.get(event.sessionKey);
		if (!items) return;
		if (event.type === "user_message_start") items.shift();
		const settled =
			event.type === "assistant_message_end" ||
			(event.type === "process_state" &&
				(event.state === "stopped" || event.state === "failed"));
		if (settled || !items.some((item) => item.submission)) {
			this.parked.delete(event.sessionKey);
		}
		if (
			event.type === "assistant_message_end" &&
			isStreamStalled(event.errorMessage)
		) {
			// Pi cleared its queue before settling; return only unacknowledged input.
			return items.flatMap((item) =>
				item.submission ? [item.submission] : [],
			);
		}
	}
}
