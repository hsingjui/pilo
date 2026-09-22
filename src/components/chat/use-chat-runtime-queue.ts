/* oxlint-disable no-await-in-loop */
import { useCallback, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import type {
	ActiveTurn,
	BeginTurnRef,
	BufferedQueuedMessage,
	ChatSessionClient,
} from "@/components/chat/chat-runtime-types";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import { createLocalMessageId } from "@/components/chat/use-chat-conversation";
import {
	chatSubmissionHasContent,
	createChatSubmission,
	summarizeChatImages,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { cacheLocalChatImages } from "@/lib/chat-image-media";
import type { ConversationAction } from "@/lib/conversation-types";
import { runtimeErrorMessage } from "@/lib/pi-runtime";

function combineQueuedSubmissions(
	items: readonly BufferedQueuedMessage[],
): ChatSubmission {
	return createChatSubmission(
		items
			.map((item) => item.submission.text)
			.filter(Boolean)
			.join("\n\n"),
		items.flatMap((item) => item.submission.images),
	);
}

type UseChatRuntimeQueueOptions = {
	session: ChatSession;
	client: ChatSessionClient;
	activeTurnRef: RefObject<ActiveTurn | null>;
	activeTurnSessionIdRef?: { current: string | null };
	beginTurnRef: BeginTurnRef;
	setActiveTurnSessionId: (sessionId: string | null) => void;
	dispatchConversation: (
		targetSessionId: string,
		action: ConversationAction,
	) => void;
	clearDraft: () => void;
	restoreSubmission: (submission: ChatSubmission) => void;
	recoverSubmission: (submission: ChatSubmission) => void;
};

export function useChatRuntimeQueue({
	session,
	client,
	activeTurnRef,
	activeTurnSessionIdRef,
	beginTurnRef,
	setActiveTurnSessionId,
	dispatchConversation,
	clearDraft,
	restoreSubmission,
	recoverSubmission,
}: UseChatRuntimeQueueOptions) {
	const bufferedQueuedMessagesRef = useRef<BufferedQueuedMessage[]>([]);
	const queuedMessagesRef = useRef(new Map<string, BufferedQueuedMessage>());
	const [pendingSteering, setPendingSteering] = useState(0);
	const [pendingFollowUps, setPendingFollowUps] = useState(0);

	const setPendingQueueCounts = useCallback(
		(steering: number, followUps: number) => {
			setPendingSteering(steering);
			setPendingFollowUps(followUps);
		},
		[],
	);
	const setPendingSteeringCount = useCallback((count: number) => {
		setPendingSteering(count);
	}, []);

	const acknowledgeQueuedMessage = useCallback(
		(turn: ActiveTurn, text: string) => {
			for (const [id, item] of queuedMessagesRef.current) {
				if (item.turn === turn && item.submission.text === text) {
					queuedMessagesRef.current.delete(id);
					break;
				}
			}
		},
		[],
	);

	const takeQueuedMessages = useCallback((turn: ActiveTurn) => {
		const queued = [...queuedMessagesRef.current.values()].filter(
			(item) => item.turn === turn,
		);
		if (queued.length === 0) return queued;
		for (const item of queued) {
			if (queuedMessagesRef.current.get(item.clientMessageId) === item) {
				queuedMessagesRef.current.delete(item.clientMessageId);
			}
		}
		const queuedIds = new Set(queued.map((item) => item.clientMessageId));
		bufferedQueuedMessagesRef.current =
			bufferedQueuedMessagesRef.current.filter(
				(item) => !queuedIds.has(item.clientMessageId),
			);
		return queued;
	}, []);

	const removeQueuedMessagesFromConversation = useCallback(
		(turn: ActiveTurn, items: readonly BufferedQueuedMessage[]) => {
			for (const item of items) {
				dispatchConversation(turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId: item.clientMessageId,
				});
			}
		},
		[dispatchConversation],
	);

	const restoreQueuedMessages = useCallback(
		(items: readonly BufferedQueuedMessage[]) => {
			if (items.length === 0) return;
			recoverSubmission(combineQueuedSubmissions(items));
		},
		[recoverSubmission],
	);

	const releaseActiveTurn = useCallback(
		(turn: ActiveTurn, options: { preserveQueued?: boolean } = {}) => {
			if (activeTurnRef.current !== turn) return;
			if (!options.preserveQueued && !turn.preserveQueuedOnRelease) {
				const discarded = takeQueuedMessages(turn);
				removeQueuedMessagesFromConversation(turn, discarded);
				restoreQueuedMessages(discarded);
			}
			activeTurnRef.current = null;
			if (activeTurnSessionIdRef?.current === turn.sessionId) {
				activeTurnSessionIdRef.current = null;
			}
			setActiveTurnSessionId(null);
			setPendingSteering(0);
			setPendingFollowUps(0);
		},
		[
			activeTurnRef,
			activeTurnSessionIdRef,
			removeQueuedMessagesFromConversation,
			restoreQueuedMessages,
			setActiveTurnSessionId,
			takeQueuedMessages,
		],
	);

	const sendQueuedMessage = useCallback(
		(item: BufferedQueuedMessage) => {
			const request =
				item.queued === "steer"
					? client.sendPiSteer(item.submission.text, item.submission.images)
					: client.sendPiFollowUp(item.submission.text, item.submission.images);
			void request.catch((error) => {
				if (queuedMessagesRef.current.get(item.clientMessageId) !== item)
					return;
				queuedMessagesRef.current.delete(item.clientMessageId);
				bufferedQueuedMessagesRef.current =
					bufferedQueuedMessagesRef.current.filter(
						(candidate) => candidate.clientMessageId !== item.clientMessageId,
					);
				dispatchConversation(item.turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId: item.clientMessageId,
				});
				recoverSubmission(item.submission);
				toast.error(
					item.queued === "steer" ? "无法调整当前回复" : "无法排队发送",
					{ description: runtimeErrorMessage(error) },
				);
			});
		},
		[client, dispatchConversation, recoverSubmission],
	);

	const flushBufferedQueuedMessages = useCallback(
		(turn: ActiveTurn) => {
			const ready = bufferedQueuedMessagesRef.current.filter(
				(item) => item.turn === turn,
			);
			if (ready.length === 0) return;
			bufferedQueuedMessagesRef.current =
				bufferedQueuedMessagesRef.current.filter((item) => item.turn !== turn);
			for (const item of ready) sendQueuedMessage(item);
		},
		[sendQueuedMessage],
	);

	const queueMessage = useCallback(
		(submission: ChatSubmission, queued: "steer" | "follow_up") => {
			const normalized = createChatSubmission(
				submission.text,
				submission.images,
			);
			const turn = activeTurnRef.current;
			if (
				!chatSubmissionHasContent(normalized) ||
				!turn ||
				turn.sessionId !== session.id
			) {
				return;
			}

			const messageId = createLocalMessageId("user");
			const timestampMs = Date.now();
			cacheLocalChatImages(normalized.images);
			dispatchConversation(turn.sessionId, {
				type: "local_user_queue",
				clientMessageId: messageId,
				text: normalized.text,
				images: summarizeChatImages(normalized.images),
				queueKind: queued,
				timestampMs,
			});
			clearDraft();

			const item: BufferedQueuedMessage = {
				turn,
				clientMessageId: messageId,
				submission: normalized,
				queued,
				timestampMs,
			};
			queuedMessagesRef.current.set(messageId, item);
			if (turn.generation === null || !turn.queueReady) {
				bufferedQueuedMessagesRef.current.push(item);
				return;
			}
			sendQueuedMessage(item);
		},
		[
			activeTurnRef,
			clearDraft,
			dispatchConversation,
			sendQueuedMessage,
			session.id,
		],
	);

	const replayQueuedMessages = useCallback(
		async (turn: ActiveTurn, excludedId?: string) => {
			const queued = [...queuedMessagesRef.current.values()].filter(
				(item) => item.turn === turn && item.clientMessageId !== excludedId,
			);
			await client.clearPiQueue();
			for (const item of queued) {
				if (item.queued === "steer") {
					await client.sendPiSteer(
						item.submission.text,
						item.submission.images,
					);
				} else {
					await client.sendPiFollowUp(
						item.submission.text,
						item.submission.images,
					);
				}
			}
		},
		[client],
	);

	const handleEditQueued = useCallback(
		async (clientMessageId: string) => {
			const item = queuedMessagesRef.current.get(clientMessageId);
			const turn = activeTurnRef.current;
			if (!item || !turn || item.turn !== turn || turn.sessionId !== session.id)
				return;
			try {
				if (turn.queueReady) await replayQueuedMessages(turn, clientMessageId);
				bufferedQueuedMessagesRef.current =
					bufferedQueuedMessagesRef.current.filter(
						(candidate) => candidate.clientMessageId !== clientMessageId,
					);
				queuedMessagesRef.current.delete(clientMessageId);
				dispatchConversation(turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId,
				});
				restoreSubmission(item.submission);
			} catch (error) {
				const remaining = takeQueuedMessages(turn);
				try {
					await client.clearPiQueue();
				} catch {
					// The runtime may already be unavailable. Local state still needs to
					// become authoritative instead of leaving a half-replayed queue visible.
				}
				removeQueuedMessagesFromConversation(turn, remaining);
				restoreQueuedMessages(remaining);
				toast.error("取回失败，消息已恢复到输入框", {
					description: runtimeErrorMessage(error),
				});
			}
		},
		[
			activeTurnRef,
			client,
			dispatchConversation,
			removeQueuedMessagesFromConversation,
			replayQueuedMessages,
			restoreQueuedMessages,
			restoreSubmission,
			session.id,
			takeQueuedMessages,
		],
	);

	const handleSendQueuedNow = useCallback(
		async (clientMessageId: string) => {
			const item = queuedMessagesRef.current.get(clientMessageId);
			const turn = activeTurnRef.current;
			const beginTurn = beginTurnRef.current;
			if (
				!item ||
				!turn ||
				item.turn !== turn ||
				turn.sessionId !== session.id ||
				!beginTurn
			) {
				return;
			}

			const queued = [...queuedMessagesRef.current.values()].filter(
				(candidate) => candidate.turn === turn,
			);
			const remaining = queued.filter(
				(candidate) => candidate.clientMessageId !== clientMessageId,
			);
			turn.preserveQueuedOnRelease = true;

			try {
				let runtimeStopped = false;
				let piQueueCleared = false;
				if (turn.queueReady) {
					try {
						await client.clearPiQueue();
						piQueueCleared = true;
					} catch (error) {
						if (session.temporary) throw error;
						console.warn(
							"Pi queue clear failed; restarting runtime before send-now",
							error,
						);
						await client.stop("send_now_queue_clear_failed");
						runtimeStopped = true;
					}
				}
				if (!runtimeStopped && turn.generation !== null && turn.promptSent) {
					try {
						await client.abortPiReply("send_now");
					} catch (error) {
						if (session.temporary) {
							if (piQueueCleared) await replayQueuedMessages(turn);
							throw error;
						}
						console.warn(
							"Pi abort failed; restarting runtime before send-now",
							error,
						);
						await client.stop("send_now_abort_failed");
					}
				}

				const detached = takeQueuedMessages(turn);
				removeQueuedMessagesFromConversation(turn, detached);
				dispatchConversation(turn.sessionId, {
					type: "local_turn_abort",
					timestampMs: Date.now(),
				});
				releaseActiveTurn(turn, { preserveQueued: true });

				const nextTurnPromise = beginTurn(item.submission);
				const nextTurn = activeTurnRef.current;
				if (!nextTurn) {
					restoreQueuedMessages(remaining);
					await nextTurnPromise;
					return;
				}

				for (const queuedItem of remaining) {
					const rebound: BufferedQueuedMessage = {
						...queuedItem,
						turn: nextTurn,
					};
					queuedMessagesRef.current.set(rebound.clientMessageId, rebound);
					bufferedQueuedMessagesRef.current.push(rebound);
					dispatchConversation(nextTurn.sessionId, {
						type: "local_user_queue",
						clientMessageId: rebound.clientMessageId,
						text: rebound.submission.text,
						images: summarizeChatImages(rebound.submission.images),
						queueKind: rebound.queued,
						timestampMs: rebound.timestampMs,
					});
				}
				await nextTurnPromise;
			} catch (error) {
				if (activeTurnRef.current === turn) {
					turn.preserveQueuedOnRelease = false;
				} else {
					const stranded = takeQueuedMessages(turn);
					removeQueuedMessagesFromConversation(turn, stranded);
					restoreQueuedMessages(stranded);
				}
				toast.error("无法立即发送消息", {
					description: runtimeErrorMessage(error),
				});
			}
		},
		[
			activeTurnRef,
			beginTurnRef,
			client,
			dispatchConversation,
			releaseActiveTurn,
			removeQueuedMessagesFromConversation,
			replayQueuedMessages,
			restoreQueuedMessages,
			session.id,
			session.temporary,
			takeQueuedMessages,
		],
	);

	const handleSteer = useCallback(
		(submission: ChatSubmission) => queueMessage(submission, "steer"),
		[queueMessage],
	);

	const handleFollowUp = useCallback(
		(submission: ChatSubmission) => queueMessage(submission, "follow_up"),
		[queueMessage],
	);

	const handleStop = useCallback(() => {
		const turn = activeTurnRef.current;
		if (!turn || turn.sessionId !== session.id) return;
		const queued = takeQueuedMessages(turn);
		removeQueuedMessagesFromConversation(turn, queued);
		restoreQueuedMessages(queued);
		dispatchConversation(turn.sessionId, {
			type: "local_turn_abort",
			timestampMs: Date.now(),
		});
		releaseActiveTurn(turn, { preserveQueued: true });
		if (turn.generation === null || !turn.promptSent) return;

		void (async () => {
			let mustStopRuntime = false;
			if (turn.queueReady) {
				try {
					await client.clearPiQueue();
				} catch (error) {
					console.warn("Pi queue clear failed while stopping", error);
					mustStopRuntime = true;
				}
			}
			if (!mustStopRuntime) {
				try {
					await client.abortPiReply("stop_turn");
				} catch (error) {
					console.warn("Pi abort failed; stopping chat runtime", error);
					mustStopRuntime = true;
				}
			}
			if (!mustStopRuntime) return;
			try {
				await client.stop("stop_turn_abort_failed");
			} catch (stopError) {
				toast.error("停止 Pi 失败", {
					description: runtimeErrorMessage(stopError),
				});
			}
		})();
	}, [
		activeTurnRef,
		client,
		dispatchConversation,
		releaseActiveTurn,
		removeQueuedMessagesFromConversation,
		restoreQueuedMessages,
		session.id,
		takeQueuedMessages,
	]);

	return {
		pendingSteering,
		pendingFollowUps,
		setPendingQueueCounts,
		setPendingSteeringCount,
		acknowledgeQueuedMessage,
		releaseActiveTurn,
		flushBufferedQueuedMessages,
		queueMessage,
		handleSteer,
		handleFollowUp,
		handleEditQueued,
		handleSendQueuedNow,
		handleStop,
	};
}
