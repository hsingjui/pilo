import { signal } from "nsh";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import type { PiPromptResult } from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import {
	chatSubmissionMessage,
	createChatSubmission,
	toPiImageContents,
	type ChatSubmission,
} from "@shared/chat/chat-submission";
import {
	requestPiRpcReply,
	type PiCommandClient,
} from "../app/client/chat-rpc";
import type {
	ComposerQueue,
	ComposerQueueKind,
	ComposerStore,
	ComposerTarget,
} from "../app/composer/composer-store";
import { t } from "../app/shell/i18n";

type RemoteQueuedMessage = {
	id: number;
	kind: ComposerQueueKind;
	submission: ChatSubmission;
};

type PiQueue = Pick<
	Extract<PiloClientEvent, { type: "queue_update" }>,
	"steering" | "followUp"
>;
type SessionQueue = { observed: PiQueue; local: RemoteQueuedMessage[] };

const queueKinds = ["steer", "follow_up"] as const;

function messagesFor(queue: PiQueue, kind: ComposerQueueKind) {
	return kind === "steer" ? queue.steering : queue.followUp;
}

/** Pi reports text only. Match from the tail because Pi takes items in FIFO order. */
function matchQueue(queue: PiQueue, local: readonly RemoteQueuedMessage[]) {
	return queueKinds.flatMap((kind) => {
		const candidates = local.filter((entry) => entry.kind === kind);
		return [...messagesFor(queue, kind)]
			.reverse()
			.map((text) => {
				const index = candidates.findLastIndex(
					(entry) => chatSubmissionMessage(entry.submission) === text,
				);
				return {
					text,
					entry: index < 0 ? undefined : candidates.splice(index, 1)[0],
				};
			})
			.reverse();
	});
}

export class RemoteChatQueue implements ComposerQueue {
	private sequence = 0;
	private readonly sessions = new Map<string, SessionQueue>();
	private readonly revision = signal(0);
	private readonly changing = signal<ReadonlySet<string>>(new Set());

	constructor(private readonly client: PiCommandClient) {}

	busy(sessionKey: string) {
		return this.changing().has(sessionKey);
	}

	items(sessionKey: string | null) {
		this.revision();
		const state =
			sessionKey === null ? undefined : this.sessions.get(sessionKey);
		if (!state) return [];
		const matched = matchQueue(state.observed, state.local);
		// Never clear a queue that we already know includes another client's
		// messages: Pi has no per-item removal and does not return their images.
		return matched.every(({ entry }) => entry !== undefined)
			? matched.flatMap(({ entry }) => (entry ? [entry] : []))
			: [];
	}

	receive(event: PiloClientEvent) {
		if (!event.sessionKey) return;
		if (event.type === "process_state" && event.state !== "running") {
			if (this.sessions.delete(event.sessionKey))
				this.revision.update((n) => n + 1);
			return;
		}
		if (event.type !== "queue_update") return;
		const state = this.sessions.get(event.sessionKey);
		this.set(event.sessionKey, {
			observed: event,
			local: matchQueue(event, state?.local ?? []).flatMap(({ entry }) =>
				entry ? [entry] : [],
			),
		});
	}

	reset() {
		this.sessions.clear();
		this.revision.update((n) => n + 1);
	}

	async enqueue(
		target: ComposerTarget,
		kind: ComposerQueueKind,
		submission: ChatSubmission,
	) {
		const result = await this.send(target, kind, submission);
		if (result?.disposition === "handled" || result?.disposition === "started")
			return;
		const state = this.sessions.get(target.sessionKey);
		if (!state) return;
		const entry = { id: ++this.sequence, kind, submission };
		this.set(target.sessionKey, {
			...state,
			// Pi sends queue_update before acknowledging the enqueue. If it has
			// already taken this message, don't leave it available for a later match.
			local: matchQueue(state.observed, [...state.local, entry]).flatMap(
				({ entry }) => (entry ? [entry] : []),
			),
		});
	}

	async change(
		composer: ComposerStore,
		id: number,
		action: "edit" | "send_now",
	) {
		const target = composer.target();
		if (
			!target ||
			composer.state().sending ||
			composer.readOnly() ||
			composer.compacting() ||
			this.busy(target.sessionKey)
		)
			return;
		const known = this.items(target.sessionKey);
		if (!known.some((entry) => entry.id === id)) return;
		this.changing.update((keys) => new Set([...keys, target.sessionKey]));
		const unsent: ChatSubmission[] = [];
		try {
			const cleared = await this.rpc<PiQueue>(target.sessionKey, {
				type: "clear_queue",
			});
			if (!cleared) throw new Error("Pi did not return the cleared queue");
			// Pi may have consumed an item since the button was pressed. Only send
			// or edit the selected message if it was actually removed by clear_queue.
			const removed = matchQueue(cleared, known);
			const selected = removed.find(({ entry }) => entry?.id === id)?.entry;
			if (removed.some(({ entry }) => entry === undefined)) {
				unsent.push(
					...removed.map(
						({ text, entry }) =>
							entry?.submission ?? createChatSubmission(text),
					),
				);
				throw new Error(t("chat.retrieveFailed"));
			}
			const remaining = removed.flatMap(({ entry }) =>
				entry && entry.id !== id ? [entry] : [],
			);
			unsent.push(...remaining.map((entry) => entry.submission));
			if (selected && action === "send_now") {
				unsent.unshift(selected.submission);
				await this.rpc(target.sessionKey, { type: "abort" });
				const result = await this.send(target, "prompt", selected.submission);
				unsent.shift();
				if (result?.disposition === "handled") {
					// The extension handled the input without starting a turn.
					composer.restoreQueuedDraft(target, unsent);
					return;
				}
			} else if (selected) {
				composer.restoreQueuedDraft(target, [selected.submission]);
			}
			for (const entry of remaining) {
				await this.enqueue(target, entry.kind, entry.submission);
				unsent.shift();
			}
		} catch (error) {
			composer.restoreQueuedDraft(target, unsent);
			composer.setStatus(userErrorMessage(error), target.sessionKey);
		} finally {
			this.changing.update(
				(keys) => new Set([...keys].filter((key) => key !== target.sessionKey)),
			);
		}
	}

	private set(sessionKey: string, state: SessionQueue) {
		this.sessions.set(sessionKey, state);
		this.revision.update((n) => n + 1);
	}

	private send(
		target: ComposerTarget,
		type: ComposerQueueKind | "prompt",
		submission: ChatSubmission,
	) {
		return this.rpc<PiPromptResult>(
			target.sessionKey,
			{
				type,
				message: chatSubmissionMessage(submission),
				...(submission.images.length > 0
					? { images: toPiImageContents(submission.images) }
					: {}),
			},
			120_000,
		);
	}

	private async rpc<T>(
		sessionKey: string,
		command: Record<string, unknown>,
		timeoutMs?: number,
	) {
		const reply = await requestPiRpcReply<T>(
			this.client,
			sessionKey,
			command,
			timeoutMs,
		);
		if (!reply) throw new Error(t("chat.promptUnconfirmed"));
		return reply.data;
	}
}
