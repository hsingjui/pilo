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
import { randomId } from "@shared/random-id";
import { requestPiRpcReply, type PiCommandClient } from "../client/chat-rpc";
import type {
	ComposerQueue,
	ComposerQueueEnqueueResult,
	ComposerQueueKind,
	ComposerStore,
	ComposerTarget,
} from "../composer/composer-store";
import { t } from "../shell/i18n";

type LocalQueuedMessage = {
	id: number;
	kind: ComposerQueueKind;
	submission: ChatSubmission;
	/** True while the enqueue RPC is awaiting Pi's reply. */
	inFlight: boolean;
	/** True once a `queue_update` from Pi has observed this entry. */
	observedByPi: boolean;
};

type PiQueue = Pick<
	Extract<PiloClientEvent, { type: "queue_update" }>,
	"steering" | "followUp"
>;

type SessionQueue = {
	observed: PiQueue | null;
	local: LocalQueuedMessage[];
};

export type QueuedMessageItem = {
	/** Stable rendering key for `<Each>`. */
	key: string;
	/** Local entry id (> 0) when queued by this client; `null` when observed from another client. */
	id: number | null;
	kind: ComposerQueueKind;
	submission: ChatSubmission;
	/** True while the enqueue RPC has not yet been acknowledged. */
	inFlight: boolean;
};

const queueKinds = ["steer", "follow_up"] as const;

function messagesFor(queue: PiQueue, kind: ComposerQueueKind) {
	return kind === "steer" ? queue.steering : queue.followUp;
}

/** Pi reports text only. Match from the tail because Pi takes items in FIFO order. */
function matchQueue(queue: PiQueue, local: readonly LocalQueuedMessage[]) {
	return queueKinds.flatMap((kind) => {
		const candidates = local.filter((entry) => entry.kind === kind);
		return [...messagesFor(queue, kind)]
			.reverse()
			.map((text) => {
				const index = candidates.findLastIndex(
					(entry) => chatSubmissionMessage(entry.submission) === text,
				);
				return {
					kind,
					text,
					entry: index < 0 ? undefined : candidates.splice(index, 1)[0],
				};
			})
			.reverse();
	});
}

function sortByQueueKind<T extends { kind: ComposerQueueKind }>(
	items: T[],
): T[] {
	return [
		...items.filter((item) => item.kind === "steer"),
		...items.filter((item) => item.kind === "follow_up"),
	];
}

/**
 * Tracks queued `steer` and `follow_up` messages per session for both the
 * desktop app and the Remote WebUI, supporting retrieve-to-edit, interrupt-and-
 * send-now, and queue preservation across stop/send-now transitions.
 */
export class ChatQueueStore implements ComposerQueue {
	private sequence = 0;
	readonly queueOwner = randomId();
	private readonly sessions = new Map<string, SessionQueue>();
	private readonly sendChains = new Map<string, Promise<void>>();
	private readonly stopEpochs = new Map<string, number>();
	private readonly revision = signal(0);
	private readonly changing = signal<ReadonlyMap<string, { stopped: boolean }>>(
		new Map(),
	);

	constructor(private readonly client: PiCommandClient) {}

	busy(sessionKey: string) {
		return this.changing().has(sessionKey);
	}

	items(sessionKey: string | null): QueuedMessageItem[] {
		this.revision();
		const state =
			sessionKey === null ? undefined : this.sessions.get(sessionKey);
		if (!state) return [];

		const result: QueuedMessageItem[] = [];
		const matchedIds = new Set<number>();

		if (state.observed) {
			const matched = matchQueue(state.observed, state.local);
			let remoteIndex = 0;
			for (const { kind, text, entry } of matched) {
				if (entry) {
					matchedIds.add(entry.id);
					result.push({
						key: `local:${entry.id}`,
						id: entry.id,
						kind: entry.kind,
						submission: entry.submission,
						inFlight: entry.inFlight,
					});
				} else {
					result.push({
						key: `remote:${kind}:${remoteIndex++}`,
						id: null,
						kind,
						submission: createChatSubmission(text),
						inFlight: false,
					});
				}
			}
		}

		// Keep optimistic entries visible until Pi's `queue_update` confirms or consumes them.
		for (const entry of state.local) {
			if (matchedIds.has(entry.id)) continue;
			if (!entry.inFlight && entry.observedByPi) continue;
			result.push({
				key: `local:${entry.id}`,
				id: entry.id,
				kind: entry.kind,
				submission: entry.submission,
				inFlight: entry.inFlight,
			});
		}

		return sortByQueueKind(result);
	}

	/**
	 * Whether every queued entry for `sessionKey` is locally owned and settled,
	 * so `clear_queue` + replay cannot drop another client's attachments.
	 */
	canMutate(sessionKey: string | null): boolean {
		if (!sessionKey || this.busy(sessionKey)) return false;
		const list = this.items(sessionKey);
		return (
			list.length > 0 &&
			list.every((item) => item.id !== null && !item.inFlight)
		);
	}

	receive(event: PiloClientEvent) {
		if (!event.sessionKey) return;
		if (event.type === "process_state" && event.state !== "running") {
			if (this.sessions.delete(event.sessionKey)) {
				this.revision.update((n) => n + 1);
			}
			return;
		}
		if (event.type !== "queue_update") return;

		const state = this.sessions.get(event.sessionKey);
		const matched = matchQueue(event, state?.local ?? []);
		const matchedIds = new Set<number>();
		const nextLocal: LocalQueuedMessage[] = [];
		for (const { entry } of matched) {
			if (!entry) continue;
			matchedIds.add(entry.id);
			nextLocal.push(
				entry.observedByPi ? entry : { ...entry, observedByPi: true },
			);
		}
		// Preserve entries whose enqueue RPC has not returned yet and has not been seen by Pi.
		for (const entry of state?.local ?? []) {
			if (matchedIds.has(entry.id)) continue;
			if (entry.inFlight && !entry.observedByPi) nextLocal.push(entry);
		}

		if (
			event.steering.length === 0 &&
			event.followUp.length === 0 &&
			nextLocal.length === 0
		) {
			if (this.sessions.delete(event.sessionKey)) {
				this.revision.update((n) => n + 1);
			}
			return;
		}

		this.set(event.sessionKey, {
			observed: {
				steering: [...event.steering],
				followUp: [...event.followUp],
			},
			local: nextLocal,
		});
	}

	reset() {
		if (this.sessions.size === 0) return;
		this.sessions.clear();
		this.revision.update((n) => n + 1);
	}

	async enqueue(
		target: ComposerTarget,
		kind: ComposerQueueKind,
		submission: ChatSubmission,
		canDispatch?: () => boolean,
		beforeSend?: () => Promise<boolean>,
	): Promise<ComposerQueueEnqueueResult> {
		const entry: LocalQueuedMessage = {
			id: ++this.sequence,
			kind,
			submission,
			inFlight: true,
			observedByPi: false,
		};
		const epoch = this.stopEpochs.get(target.sessionKey) ?? 0;
		const existing = this.sessions.get(target.sessionKey);
		this.set(target.sessionKey, {
			observed: existing?.observed ?? null,
			local: [...(existing?.local ?? []), entry],
		});

		const isCancelled = () =>
			(this.stopEpochs.get(target.sessionKey) ?? 0) !== epoch ||
			(canDispatch !== undefined && !canDispatch());

		const previous =
			this.sendChains.get(target.sessionKey) ?? Promise.resolve();
		const task = previous.then(
			async (): Promise<ComposerQueueEnqueueResult> => {
				if (isCancelled()) {
					this.removeLocal(target.sessionKey, entry.id);
					return "cancelled";
				}
				if (beforeSend) {
					const ready = await beforeSend();
					if (!ready || isCancelled()) {
						this.removeLocal(target.sessionKey, entry.id);
						return "cancelled";
					}
				}

				let result: PiPromptResult | undefined;
				try {
					result = await this.send(
						target,
						kind,
						submission,
						() => !isCancelled(),
					);
				} catch (error) {
					this.removeLocal(target.sessionKey, entry.id);
					if (isCancelled()) return "cancelled";
					throw error;
				}

				if (
					result?.disposition === "handled" ||
					result?.disposition === "started"
				) {
					this.removeLocal(target.sessionKey, entry.id);
					return result.disposition;
				}

				const current = this.sessions.get(target.sessionKey);
				if (!current) return "queued";
				const stored = current.local.find(
					(candidate) => candidate.id === entry.id,
				);
				if (!stored) return "queued";

				const updatedLocal = current.local.map((candidate) =>
					candidate.id === entry.id
						? { ...candidate, inFlight: false }
						: candidate,
				);
				if (current.observed && stored.observedByPi) {
					this.reconcileObserved(
						target.sessionKey,
						current.observed,
						updatedLocal,
					);
				} else {
					this.set(target.sessionKey, {
						observed: current.observed,
						local: updatedLocal,
					});
				}
				return "queued";
			},
		);

		const tail = task.then(
			() => undefined,
			() => undefined,
		);
		this.sendChains.set(target.sessionKey, tail);
		void tail.finally(() => {
			if (this.sendChains.get(target.sessionKey) === tail) {
				this.sendChains.delete(target.sessionKey);
			}
		});
		return task;
	}

	/**
	 * Claims a prompt that Pi queued (`disposition: "queued"`) as locally owned
	 * so it stays editable and reconciled with `queue_update`.
	 */
	adoptQueued(
		sessionKey: string,
		kind: ComposerQueueKind,
		submission: ChatSubmission,
	) {
		const entry: LocalQueuedMessage = {
			id: ++this.sequence,
			kind,
			submission,
			inFlight: false,
			observedByPi: false,
		};
		const current = this.sessions.get(sessionKey);
		const nextLocal = [...(current?.local ?? []), entry];
		if (current?.observed) {
			const matched = matchQueue(current.observed, nextLocal);
			const matchedIds = new Set(
				matched.flatMap(({ entry: item }) => (item ? [item.id] : [])),
			);
			const updatedLocal = nextLocal.map((candidate) =>
				candidate.id === entry.id && matchedIds.has(entry.id)
					? { ...candidate, observedByPi: true }
					: candidate,
			);
			this.reconcileObserved(sessionKey, current.observed, updatedLocal);
		} else {
			this.set(sessionKey, { observed: null, local: nextLocal });
		}
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
			!this.canMutate(target.sessionKey)
		)
			return;
		const known = this.localEntries(target.sessionKey);
		if (!known.some((entry) => entry.id === id)) return;

		const change = this.startChange(target.sessionKey);
		const canDispatch = () => !change.stopped;
		const unsent: ChatSubmission[] = [];
		try {
			const cleared = await this.clearOwnedQueue(target.sessionKey);

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
				await this.rpc(
					target.sessionKey,
					{ type: "abort" },
					undefined,
					canDispatch,
				);
				const result = await this.send(
					target,
					"prompt",
					selected.submission,
					canDispatch,
				);
				unsent.shift();
				if (result?.disposition === "handled") {
					// The extension handled the input without starting a turn.
					composer.restoreQueuedDraft(target, unsent);
					return;
				}
			} else if (selected) {
				composer.restoreQueuedDraft(target, [selected.submission]);
			}
			await this.replayRemaining(target, remaining, unsent, canDispatch);
		} catch (error) {
			composer.restoreQueuedDraft(target, unsent);
			if (!change.stopped) {
				composer.reportError(
					action === "send_now"
						? t("chat.immediateSendFailed")
						: t("chat.retrieveFailed"),
					userErrorMessage(error),
					target.sessionKey,
				);
			}
		} finally {
			this.finishChange(target.sessionKey);
		}
	}

	/**
	 * Handles a composer `send_now` submission while a turn is running and the
	 * session has locally owned queued messages: clears the queue, aborts, sends
	 * the prompt, and replays the cleared queue. Returns `false` if there is no
	 * mutable local queue so the composer can run plain `abort` + `prompt`.
	 */
	async sendNow(
		target: ComposerTarget,
		submission: ChatSubmission,
		composer: ComposerStore,
		canDispatchPrompt: () => boolean,
	): Promise<boolean> {
		if (!this.canMutate(target.sessionKey)) return false;
		const known = this.localEntries(target.sessionKey);
		if (known.length === 0) return false;

		const change = this.startChange(target.sessionKey);
		const canDispatch = () => !change.stopped;
		const unsentRemaining: ChatSubmission[] = [];
		let promptSent = false;
		let cancelled = false;
		try {
			const cleared = await this.clearOwnedQueue(target.sessionKey);

			const removed = matchQueue(cleared, known);
			if (removed.some(({ entry }) => entry === undefined)) {
				unsentRemaining.push(
					...removed.map(
						({ text, entry }) =>
							entry?.submission ?? createChatSubmission(text),
					),
				);
				throw new Error(t("chat.retrieveFailed"));
			}
			const remaining = removed.flatMap(({ entry }) => (entry ? [entry] : []));
			unsentRemaining.push(...remaining.map((entry) => entry.submission));

			await this.rpc(
				target.sessionKey,
				{ type: "abort" },
				undefined,
				canDispatch,
			);
			const result = await this.send(target, "prompt", submission, () => {
				cancelled = change.stopped || !canDispatchPrompt();
				return !cancelled;
			});
			promptSent = true;
			if (result?.disposition === "handled") {
				composer.restoreQueuedDraft(target, unsentRemaining);
				return true;
			}
			await this.replayRemaining(
				target,
				remaining,
				unsentRemaining,
				canDispatch,
			);
			return true;
		} catch (error) {
			composer.restoreQueuedDraft(target, unsentRemaining);
			if (cancelled || change.stopped) return promptSent;
			if (!promptSent) throw error;
			composer.reportError(
				t("chat.queueFailed"),
				userErrorMessage(error),
				target.sessionKey,
			);
			return true;
		} finally {
			this.finishChange(target.sessionKey);
		}
	}

	/**
	 * Clears locally owned queued messages before `abort` and restores them to
	 * the composer draft so stopping a turn never drops queued input.
	 */
	async clearForStop(
		target: ComposerTarget,
		composer: ComposerStore,
	): Promise<void> {
		this.stopEpochs.set(
			target.sessionKey,
			(this.stopEpochs.get(target.sessionKey) ?? 0) + 1,
		);
		const change = this.changing().get(target.sessionKey);
		if (change) {
			change.stopped = true;
			return;
		}
		if (!this.canMutate(target.sessionKey)) return;
		const known = this.localEntries(target.sessionKey);
		if (known.length === 0) return;

		this.startChange(target.sessionKey);
		try {
			const cleared = await this.clearOwnedQueue(target.sessionKey);
			const removed = matchQueue(cleared, known);
			const restored = removed.map(
				({ text, entry }) => entry?.submission ?? createChatSubmission(text),
			);
			composer.restoreQueuedDraft(target, restored);
		} catch (error) {
			composer.reportError(
				t("chat.retrieveFailed"),
				userErrorMessage(error),
				target.sessionKey,
			);
		} finally {
			this.finishChange(target.sessionKey);
		}
	}

	private async clearOwnedQueue(sessionKey: string) {
		const cleared = await this.rpc<PiQueue>(sessionKey, {
			type: "clear_queue",
			piloQueueOwner: this.queueOwner,
		});
		if (!cleared) throw new Error("Pi did not return the cleared queue");
		return cleared;
	}

	private localEntries(sessionKey: string): LocalQueuedMessage[] {
		const state = this.sessions.get(sessionKey);
		if (!state) return [];
		return state.local;
	}

	private async replayRemaining(
		target: ComposerTarget,
		remaining: readonly LocalQueuedMessage[],
		unsent: ChatSubmission[],
		canDispatch: () => boolean,
	) {
		for (const entry of remaining) {
			// oxlint-disable-next-line no-await-in-loop -- Replayed queue entries must preserve FIFO order.
			const outcome = await this.enqueue(
				target,
				entry.kind,
				entry.submission,
				canDispatch,
			);
			if (outcome === "cancelled") {
				throw new Error(t("chat.promptUnconfirmed"));
			}
			unsent.shift();
		}
	}

	private reconcileObserved(
		sessionKey: string,
		observed: PiQueue,
		local: readonly LocalQueuedMessage[],
	) {
		const matched = matchQueue(observed, local);
		const matchedIds = new Set<number>();
		const nextLocal: LocalQueuedMessage[] = [];
		for (const { entry } of matched) {
			if (!entry) continue;
			matchedIds.add(entry.id);
			nextLocal.push(entry);
		}
		for (const entry of local) {
			if (matchedIds.has(entry.id)) continue;
			if (entry.inFlight || !entry.observedByPi) nextLocal.push(entry);
		}
		if (
			observed.steering.length === 0 &&
			observed.followUp.length === 0 &&
			nextLocal.length === 0
		) {
			this.sessions.delete(sessionKey);
			this.revision.update((n) => n + 1);
			return;
		}
		this.set(sessionKey, { observed, local: nextLocal });
	}

	private removeLocal(sessionKey: string, id: number) {
		const state = this.sessions.get(sessionKey);
		if (!state) return;
		const nextLocal = state.local.filter((entry) => entry.id !== id);
		if (nextLocal.length === state.local.length) return;
		const observedEmpty =
			!state.observed ||
			(state.observed.steering.length === 0 &&
				state.observed.followUp.length === 0);
		if (observedEmpty && nextLocal.length === 0) {
			this.sessions.delete(sessionKey);
			this.revision.update((n) => n + 1);
			return;
		}
		this.set(sessionKey, { observed: state.observed, local: nextLocal });
	}

	private startChange(sessionKey: string) {
		const change = { stopped: false };
		this.changing.update((changes) => new Map(changes).set(sessionKey, change));
		return change;
	}

	private finishChange(sessionKey: string) {
		this.changing.update((changes) => {
			const next = new Map(changes);
			next.delete(sessionKey);
			return next;
		});
	}

	private set(sessionKey: string, state: SessionQueue) {
		this.sessions.set(sessionKey, state);
		this.revision.update((n) => n + 1);
	}

	private send(
		target: ComposerTarget,
		type: ComposerQueueKind | "prompt",
		submission: ChatSubmission,
		canDispatch?: () => boolean,
	) {
		return this.rpc<PiPromptResult>(
			target.sessionKey,
			{
				type,
				piloQueueOwner: this.queueOwner,
				message: chatSubmissionMessage(submission),
				...(submission.images.length > 0
					? { images: toPiImageContents(submission.images) }
					: {}),
			},
			120_000,
			canDispatch,
		);
	}

	private async rpc<T>(
		sessionKey: string,
		command: Record<string, unknown>,
		timeoutMs?: number,
		canDispatch?: () => boolean,
	) {
		const reply = await requestPiRpcReply<T>(
			this.client,
			sessionKey,
			command,
			timeoutMs,
			canDispatch,
		);
		if (!reply) throw new Error(t("chat.promptUnconfirmed"));
		return reply.data;
	}
}
