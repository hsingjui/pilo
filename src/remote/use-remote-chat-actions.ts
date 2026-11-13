import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import {
	type ChatImageAttachment,
	type ChatSubmission,
	summarizeChatImages,
	toPiImageContents,
} from "@/lib/chat/chat-submission";
import { reduceConversationActions } from "@/lib/chat/conversation-replay";
import type {
	ConversationAction,
	ConversationState,
} from "@/lib/chat/conversation-types";
import type {
	PiAgentState,
	PiModel,
	PiThinkingLevel,
} from "@/lib/api/pi-runtime";
import {
	PI_PROMPT_RPC_TIMEOUT_MS,
	runtimeErrorMessage,
	type PiPromptResult,
} from "@/lib/api/pi-runtime";
import { chatRuntimeHasOpenTurn } from "@/lib/chat/chat-session-runtime-model";
import { randomId } from "@/lib/utils";
import { reducerContext } from "./remote-app-model";
import type {
	QueuedSubmission,
	RemoteSessionRpc,
} from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

export type PendingProjectMcpPrompt = {
	sessionKey: string;
	clientMessageId: string;
	submission: ChatSubmission;
	shouldAutoTitle: boolean;
};

type SubmissionPhase = "preparing" | "sending";

type UseRemoteChatActionsOptions = {
	client: WebPiloClient | null;
	activeSessionKey: string | null;
	activeSessionKeyRef: RefObject<string | null>;
	getDraft: () => string;
	readOnly: boolean;
	hasSelectedSession: boolean;
	hasIdentifiedSession: boolean;
	autoTitleRequestedRef: RefObject<boolean>;
	pendingProjectMcpPromptsRef: RefObject<Map<string, PendingProjectMcpPrompt>>;
	projectMcpApprovalRequestedRef: RefObject<Set<string>>;
	queuedSubmissionsRef: RefObject<Map<string, QueuedSubmission>>;
	ensureDraftRuntime: (onStarting?: () => void) => Promise<void>;
	tryHandleComposerCommand: (submission: ChatSubmission) => Promise<boolean>;
	requestAutoTitle: (message: string) => void;
	clearComposer: () => void;
	handleComposerChange: (value: string) => void;
	setImages: Dispatch<SetStateAction<ChatImageAttachment[]>>;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	setConversation: Dispatch<SetStateAction<ConversationState>>;
	setAgentState: Dispatch<SetStateAction<PiAgentState | null>>;
	setDraftModel: Dispatch<SetStateAction<PiModel | null>>;
	setDraftThinkingLevel: Dispatch<SetStateAction<PiThinkingLevel | null>>;
	rpcForSession: RemoteSessionRpc;
};

export function useRemoteChatActions({
	client,
	activeSessionKey,
	activeSessionKeyRef,
	getDraft,
	readOnly,
	hasSelectedSession,
	hasIdentifiedSession,
	autoTitleRequestedRef,
	pendingProjectMcpPromptsRef,
	projectMcpApprovalRequestedRef,
	queuedSubmissionsRef,
	ensureDraftRuntime,
	tryHandleComposerCommand,
	requestAutoTitle,
	clearComposer,
	handleComposerChange,
	setImages,
	handleExpiredAuth,
	setFatalError,
	setConversation,
	setAgentState,
	setDraftModel,
	setDraftThinkingLevel,
	rpcForSession,
}: UseRemoteChatActionsOptions) {
	const [submissionPhases, setSubmissionPhases] = useState(
		new Map<string, SubmissionPhase>(),
	);
	const sendingSessionKeysRef = useRef(new Set<string>());
	const submissionPhase = activeSessionKey
		? submissionPhases.get(activeSessionKey)
		: undefined;
	const sending = submissionPhase !== undefined;
	const composerLocked = submissionPhase === "preparing";
	const setSubmissionPhase = useCallback(
		(sessionKey: string, phase: SubmissionPhase | null) => {
			if (phase) sendingSessionKeysRef.current.add(sessionKey);
			else sendingSessionKeysRef.current.delete(sessionKey);
			setSubmissionPhases((current) => {
				const next = new Map(current);
				if (phase) next.set(sessionKey, phase);
				else next.delete(sessionKey);
				return next;
			});
		},
		[],
	);
	const recoveredSubmissionsRef = useRef(new Map<string, ChatSubmission[]>());
	const [recoveryRevision, setRecoveryRevision] = useState(0);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Failed submissions belong to their original runtime session, including after draft identification or returning from the background. recoveryRevision 是重新回填输入框的显式触发代，不是 effect 读取的值。 */
	useEffect(() => {
		void recoveryRevision;
		if (!activeSessionKey) return;
		const recovered = recoveredSubmissionsRef.current.get(activeSessionKey);
		if (!recovered) return;
		recoveredSubmissionsRef.current.delete(activeSessionKey);
		handleComposerChange(
			[getDraft(), ...recovered.map((item) => item.text)]
				.filter(Boolean)
				.join("\n\n"),
		);
		setImages((current) => [
			...new Map(
				[...current, ...recovered.flatMap((item) => item.images)].map(
					(image) => [image.id, image],
				),
			).values(),
		]);
	}, [
		activeSessionKey,
		getDraft,
		handleComposerChange,
		recoveryRevision,
		setImages,
	]);
	/* oxlint-enable react/set-state-in-effect */

	const runLocalAction = useCallback(
		(action: ConversationAction) => {
			setConversation((current) =>
				reduceConversationActions(current, [action], reducerContext),
			);
		},
		[setConversation],
	);

	const sendPrompt = useCallback(
		async (
			targetSessionKey: string,
			submission: ChatSubmission,
			clientMessageId: string,
		) => {
			const isActiveSession = () =>
				activeSessionKeyRef.current === targetSessionKey;
			if (isActiveSession()) {
				runLocalAction({
					type: "local_assistant_status",
					clientMessageId,
					status: "sending",
				});
			}
			const result = await rpcForSession<PiPromptResult>(
				targetSessionKey,
				{
					type: "prompt",
					message: submission.text,
					images: toPiImageContents(submission.images),
				},
				PI_PROMPT_RPC_TIMEOUT_MS,
			);
			if (
				(!result?.disposition || result.disposition === "started") &&
				isActiveSession()
			) {
				runLocalAction({ type: "local_assistant_status", clientMessageId });
			}
			if (result?.disposition !== "handled") return true;
			const runtime = await client?.chatState(targetSessionKey);
			if (chatRuntimeHasOpenTurn(runtime)) return true;
			setConversation((current) =>
				isActiveSession()
					? reduceConversationActions(
							current,
							[
								{ type: "local_user_queue_failed", clientMessageId },
								{ type: "local_turn_abort", timestampMs: Date.now() },
							],
							reducerContext,
						)
					: current,
			);
			return false;
		},
		[
			activeSessionKeyRef,
			client,
			rpcForSession,
			runLocalAction,
			setConversation,
		],
	);

	const sendSubmission = useCallback(
		async (
			submission: ChatSubmission,
			mode: "prompt" | "steer" | "follow_up",
		) => {
			if (!client || !activeSessionKey || readOnly) return;
			if (!submission.text.trim() && submission.images.length === 0) return;
			if (sendingSessionKeysRef.current.has(activeSessionKey)) return;
			const submissionSessionKey = activeSessionKey;
			const isActiveSession = () =>
				activeSessionKeyRef.current === submissionSessionKey;
			const shouldAutoTitle =
				mode === "prompt" &&
				!hasSelectedSession &&
				!autoTitleRequestedRef.current;
			const now = Date.now();
			const clientMessageId = randomId();
			const descriptors = summarizeChatImages(submission.images);
			let queuedClientMessageId: string | null = null;
			// Lock before the first await; React's disabled state may not have rendered yet.
			setSubmissionPhase(submissionSessionKey, "preparing");
			try {
				if (mode === "prompt" && (await tryHandleComposerCommand(submission)))
					return;
				// 乐观更新：与桌面端 beginTurn 对齐，先落本地 user / assistant-pending
				// 消息，再启动 runtime，避免 startChat 期间输入框毫无反馈。
				if (mode === "prompt") {
					runLocalAction({
						type: "local_user_submit",
						clientMessageId,
						text: submission.text,
						images: descriptors,
						timestampMs: now,
					});
					runLocalAction({
						type: "local_assistant_pending",
						timestampMs: now,
						pendingStatus: null,
					});
				} else {
					queuedClientMessageId = clientMessageId;
					queuedSubmissionsRef.current.set(clientMessageId, {
						submission,
						queueKind: mode,
					});
					runLocalAction({
						type: "local_user_queue",
						clientMessageId,
						text: submission.text,
						images: descriptors,
						queueKind: mode,
						timestampMs: now,
					});
				}
				clearComposer();
				// The submitted draft is owned by this request; editing can resume now.
				setSubmissionPhase(submissionSessionKey, "sending");
				await ensureDraftRuntime(
					mode === "prompt"
						? () => {
								if (!isActiveSession()) return;
								runLocalAction({
									type: "local_assistant_status",
									clientMessageId,
									status: "starting",
								});
							}
						: undefined,
				);
				const accepted =
					mode === "prompt"
						? await sendPrompt(
								submissionSessionKey,
								submission,
								clientMessageId,
							)
						: (
								await rpcForSession<PiPromptResult>(submissionSessionKey, {
									type: mode,
									message: submission.text,
									images: toPiImageContents(submission.images),
								})
							)?.disposition !== "handled";
				if (!isActiveSession()) return;
				if (!accepted) {
					queuedSubmissionsRef.current.delete(clientMessageId);
					// `sendPrompt` already rolled back its own optimistic prompt; queued
					// steer/follow-up messages still need the local rollback here.
					if (mode !== "prompt") {
						runLocalAction({
							type: "local_user_queue_failed",
							clientMessageId,
						});
					}
					return;
				}
				if (shouldAutoTitle) requestAutoTitle(submission.text);
			} catch (error) {
				if (
					!queuedClientMessageId &&
					projectMcpApprovalRequestedRef.current.has(submissionSessionKey)
				) {
					// Keep the original prompt with its session while MCP approval restarts Pi.
					if (!pendingProjectMcpPromptsRef.current.has(submissionSessionKey)) {
						pendingProjectMcpPromptsRef.current.set(submissionSessionKey, {
							sessionKey: submissionSessionKey,
							clientMessageId,
							submission,
							shouldAutoTitle,
						});
					}
					return;
				}
				if (!isActiveSession()) {
					recoveredSubmissionsRef.current.set(submissionSessionKey, [
						...(recoveredSubmissionsRef.current.get(submissionSessionKey) ??
							[]),
						submission,
					]);
					setRecoveryRevision((value) => value + 1);
					return;
				}
				if (queuedClientMessageId) {
					queuedSubmissionsRef.current.delete(queuedClientMessageId);
					runLocalAction({
						type: "local_user_queue_failed",
						clientMessageId: queuedClientMessageId,
					});
				} else {
					runLocalAction({ type: "local_user_queue_failed", clientMessageId });
					runLocalAction({
						type: "conversation_runtime_error",
						message: runtimeErrorMessage(error),
						timestampMs: Date.now(),
					});
				}
				recoveredSubmissionsRef.current.set(submissionSessionKey, [
					...(recoveredSubmissionsRef.current.get(submissionSessionKey) ?? []),
					submission,
				]);
				setRecoveryRevision((value) => value + 1);
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSubmissionPhase(submissionSessionKey, null);
			}
		},
		[
			activeSessionKey,
			activeSessionKeyRef,
			autoTitleRequestedRef,
			clearComposer,
			client,
			ensureDraftRuntime,
			handleExpiredAuth,
			pendingProjectMcpPromptsRef,
			projectMcpApprovalRequestedRef,
			queuedSubmissionsRef,
			readOnly,
			requestAutoTitle,
			rpcForSession,
			runLocalAction,
			sendPrompt,
			hasSelectedSession,
			tryHandleComposerCommand,
			setFatalError,
			setSubmissionPhase,
		],
	);

	const handleEditQueued = useCallback(
		async (clientMessageId: string) => {
			if (!client || !activeSessionKey) return;
			const item = queuedSubmissionsRef.current.get(clientMessageId);
			if (!item) return;
			const remaining = [...queuedSubmissionsRef.current.entries()].filter(
				([id]) => id !== clientMessageId,
			);
			const targetSessionKey = activeSessionKey;
			const isActiveSession = () =>
				activeSessionKeyRef.current === targetSessionKey;
			setSubmissionPhase(targetSessionKey, "preparing");
			try {
				await rpcForSession<void>(targetSessionKey, { type: "clear_queue" });
				await remaining.reduce<Promise<void>>(
					(promise, [, queued]) =>
						promise.then(() =>
							rpcForSession<void>(targetSessionKey, {
								type: queued.queueKind,
								message: queued.submission.text,
								images: toPiImageContents(queued.submission.images),
							}),
						),
					Promise.resolve(),
				);
				if (!isActiveSession()) {
					recoveredSubmissionsRef.current.set(targetSessionKey, [
						...(recoveredSubmissionsRef.current.get(targetSessionKey) ?? []),
						item.submission,
					]);
					setRecoveryRevision((value) => value + 1);
					return;
				}
				queuedSubmissionsRef.current.delete(clientMessageId);
				runLocalAction({
					type: "local_user_queue_failed",
					clientMessageId,
				});
				handleComposerChange(item.submission.text);
				setImages(item.submission.images);
			} catch (error) {
				if (!handleExpiredAuth(error) && isActiveSession()) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSubmissionPhase(targetSessionKey, null);
			}
		},
		[
			activeSessionKey,
			activeSessionKeyRef,
			client,
			handleComposerChange,
			handleExpiredAuth,
			queuedSubmissionsRef,
			rpcForSession,
			runLocalAction,
			setFatalError,
			setImages,
			setSubmissionPhase,
		],
	);

	const sendNow = useCallback(
		async (submission: ChatSubmission, queuedClientMessageId?: string) => {
			if (
				!client ||
				!activeSessionKey ||
				readOnly ||
				activeSessionKeyRef.current !== activeSessionKey ||
				sendingSessionKeysRef.current.has(activeSessionKey)
			)
				return;
			const targetSessionKey = activeSessionKey;
			const isActiveSession = () =>
				activeSessionKeyRef.current === targetSessionKey;
			const runTargetAction = (action: ConversationAction) => {
				setConversation((current) =>
					isActiveSession()
						? reduceConversationActions(current, [action], reducerContext)
						: current,
				);
			};
			const clientMessageId = queuedClientMessageId ?? randomId();
			const queued = [...queuedSubmissionsRef.current.entries()];
			const remaining = queued.filter(([id]) => id !== clientMessageId);
			setSubmissionPhase(targetSessionKey, "preparing");
			if (!queuedClientMessageId) clearComposer();
			let queueCleared = false;
			let optimisticSubmitted = false;
			let promptSent = false;
			let replayedCount = 0;
			try {
				await rpcForSession<void>(targetSessionKey, { type: "clear_queue" });
				queueCleared = true;
				await rpcForSession<void>(targetSessionKey, { type: "abort" });
				runTargetAction({
					type: "local_turn_abort",
					timestampMs: Date.now(),
				});
				if (isActiveSession()) {
					for (const [id] of queued) {
						queuedSubmissionsRef.current.delete(id);
						runTargetAction({
							type: "local_user_queue_failed",
							clientMessageId: id,
						});
					}
				}

				const now = Date.now();
				if (isActiveSession()) {
					runTargetAction({
						type: "local_user_submit",
						clientMessageId,
						text: submission.text,
						images: summarizeChatImages(submission.images),
						timestampMs: now,
					});
					runTargetAction({
						type: "local_assistant_pending",
						timestampMs: now,
						pendingStatus: "sending",
					});
					optimisticSubmitted = true;
				}
				const started = await sendPrompt(
					targetSessionKey,
					submission,
					clientMessageId,
				);
				promptSent = true;
				if (!started) {
					// `sendPrompt` already rolled back the optimistic prompt.
					if (remaining.length > 0) {
						recoveredSubmissionsRef.current.set(targetSessionKey, [
							...(recoveredSubmissionsRef.current.get(targetSessionKey) ?? []),
							...remaining.map(([, pending]) => pending.submission),
						]);
						setRecoveryRevision((value) => value + 1);
					}
					return;
				}

				if (isActiveSession()) {
					for (const [id, pending] of remaining) {
						queuedSubmissionsRef.current.set(id, pending);
						runTargetAction({
							type: "local_user_queue",
							clientMessageId: id,
							text: pending.submission.text,
							images: summarizeChatImages(pending.submission.images),
							queueKind: pending.queueKind,
							timestampMs: now,
						});
					}
				}
				await remaining.reduce<Promise<void>>(
					(promise, [, pending]) =>
						promise.then(async () => {
							await rpcForSession<void>(targetSessionKey, {
								type: pending.queueKind,
								message: pending.submission.text,
								images: toPiImageContents(pending.submission.images),
							});
							replayedCount += 1;
						}),
					Promise.resolve(),
				);
			} catch (error) {
				if (optimisticSubmitted && !promptSent) {
					runTargetAction({
						type: "local_user_queue_failed",
						clientMessageId,
					});
					runTargetAction({
						type: "local_turn_abort",
						timestampMs: Date.now(),
					});
				}
				// Keep acknowledged queue entries; recover the failed entry and its unsent tail.
				const failedQueued = promptSent
					? remaining.slice(replayedCount)
					: queueCleared
						? queued
						: [];
				if (isActiveSession()) {
					for (const [id] of failedQueued) {
						queuedSubmissionsRef.current.delete(id);
						runTargetAction({
							type: "local_user_queue_failed",
							clientMessageId: id,
						});
					}
				}
				const recovered = promptSent
					? failedQueued.map(([, pending]) => pending.submission)
					: queueCleared || !queuedClientMessageId
						? [
								submission,
								...failedQueued
									.filter(([id]) => id !== clientMessageId)
									.map(([, pending]) => pending.submission),
							]
						: [];
				if (recovered.length > 0) {
					recoveredSubmissionsRef.current.set(targetSessionKey, [
						...(recoveredSubmissionsRef.current.get(targetSessionKey) ?? []),
						...recovered,
					]);
					setRecoveryRevision((value) => value + 1);
				}
				if (!handleExpiredAuth(error) && isActiveSession()) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSubmissionPhase(targetSessionKey, null);
			}
		},
		[
			activeSessionKey,
			activeSessionKeyRef,
			clearComposer,
			client,
			handleExpiredAuth,
			queuedSubmissionsRef,
			readOnly,
			rpcForSession,
			sendPrompt,
			setConversation,
			setFatalError,
			setSubmissionPhase,
		],
	);

	const handleSendQueuedNow = useCallback(
		async (clientMessageId: string) => {
			const item = queuedSubmissionsRef.current.get(clientMessageId);
			if (!item) return;
			await sendNow(item.submission, clientMessageId);
		},
		[queuedSubmissionsRef, sendNow],
	);

	const handleSendNow = useCallback(
		async (submission: ChatSubmission) => {
			if (!client || !activeSessionKey || readOnly) return;
			if (!submission.text.trim() && submission.images.length === 0) return;
			if (await tryHandleComposerCommand(submission)) return;
			await sendNow(submission);
		},
		[activeSessionKey, client, readOnly, sendNow, tryHandleComposerCommand],
	);

	const resumeProjectMcpPrompt = useCallback(
		async (sessionKey: string) => {
			const pending = pendingProjectMcpPromptsRef.current.get(sessionKey);
			pendingProjectMcpPromptsRef.current.delete(sessionKey);
			projectMcpApprovalRequestedRef.current.delete(sessionKey);
			if (!pending || !client) return;

			const isActiveSession = () => activeSessionKeyRef.current === sessionKey;
			setSubmissionPhase(sessionKey, "sending");
			try {
				const started = await sendPrompt(
					pending.sessionKey,
					pending.submission,
					pending.clientMessageId,
				);
				if (isActiveSession() && pending.shouldAutoTitle && started) {
					requestAutoTitle(pending.submission.text);
				}
			} catch (error) {
				if (isActiveSession()) {
					runLocalAction({
						type: "conversation_runtime_error",
						message: runtimeErrorMessage(error),
						timestampMs: Date.now(),
					});
					recoveredSubmissionsRef.current.set(sessionKey, [
						...(recoveredSubmissionsRef.current.get(sessionKey) ?? []),
						pending.submission,
					]);
					setRecoveryRevision((value) => value + 1);
					if (!handleExpiredAuth(error)) {
						setFatalError(
							error instanceof Error ? error.message : String(error),
						);
					}
				} else {
					console.error(
						"Failed to resume background MCP-approved prompt",
						error,
					);
				}
			} finally {
				setSubmissionPhase(sessionKey, null);
			}
		},
		[
			activeSessionKeyRef,
			client,
			handleExpiredAuth,
			pendingProjectMcpPromptsRef,
			projectMcpApprovalRequestedRef,
			requestAutoTitle,
			runLocalAction,
			sendPrompt,
			setFatalError,
			setSubmissionPhase,
		],
	);

	const failProjectMcpPrompt = useCallback(
		(sessionKey: string, error: unknown) => {
			const pending = pendingProjectMcpPromptsRef.current.get(sessionKey);
			pendingProjectMcpPromptsRef.current.delete(sessionKey);
			projectMcpApprovalRequestedRef.current.delete(sessionKey);
			if (!pending || activeSessionKey !== sessionKey) return;
			runLocalAction({
				type: "conversation_runtime_error",
				message: runtimeErrorMessage(error),
				timestampMs: Date.now(),
			});
			recoveredSubmissionsRef.current.set(sessionKey, [
				...(recoveredSubmissionsRef.current.get(sessionKey) ?? []),
				pending.submission,
			]);
			setRecoveryRevision((value) => value + 1);
		},
		[
			activeSessionKey,
			pendingProjectMcpPromptsRef,
			projectMcpApprovalRequestedRef,
			runLocalAction,
		],
	);

	const cancelProjectMcpPrompt = useCallback(
		(sessionKey: string) => {
			const pending = pendingProjectMcpPromptsRef.current.get(sessionKey);
			pendingProjectMcpPromptsRef.current.delete(sessionKey);
			projectMcpApprovalRequestedRef.current.delete(sessionKey);
			if (!pending || activeSessionKey !== sessionKey) return;
			runLocalAction({ type: "local_turn_abort", timestampMs: Date.now() });
		},
		[
			activeSessionKey,
			pendingProjectMcpPromptsRef,
			projectMcpApprovalRequestedRef,
			runLocalAction,
		],
	);

	const stop = useCallback(async () => {
		if (!client || !activeSessionKey) return;
		pendingProjectMcpPromptsRef.current.delete(activeSessionKey);
		projectMcpApprovalRequestedRef.current.delete(activeSessionKey);
		runLocalAction({ type: "local_turn_abort", timestampMs: Date.now() });
		await client
			.sendChatCommand(activeSessionKey, { type: "abort" })
			.catch(() => undefined);
	}, [
		activeSessionKey,
		client,
		pendingProjectMcpPromptsRef,
		projectMcpApprovalRequestedRef,
		runLocalAction,
	]);

	const changeModel = useCallback(
		async (model: PiModel) => {
			if (!hasIdentifiedSession) {
				setDraftModel(model);
				setDraftThinkingLevel(model.defaultThinkingLevel ?? null);
				return;
			}
			if (!activeSessionKey) return;
			const targetSessionKey = activeSessionKey;
			const isActiveSession = () =>
				activeSessionKeyRef.current === targetSessionKey;
			try {
				await ensureDraftRuntime();
				if (!isActiveSession()) return;
				const next = await rpcForSession<PiModel>(targetSessionKey, {
					type: "set_model",
					provider: model.provider,
					modelId: model.id,
				});
				if (isActiveSession()) {
					setAgentState((current) =>
						current ? { ...current, model: next } : current,
					);
				}
			} catch (error) {
				if (isActiveSession())
					setFatalError(error instanceof Error ? error.message : String(error));
			}
		},
		[
			activeSessionKey,
			activeSessionKeyRef,
			ensureDraftRuntime,
			hasIdentifiedSession,
			rpcForSession,
			setAgentState,
			setDraftModel,
			setDraftThinkingLevel,
			setFatalError,
		],
	);

	const changeThinking = useCallback(
		async (level: PiThinkingLevel) => {
			if (!hasIdentifiedSession) {
				setDraftThinkingLevel(level);
				return;
			}
			if (!activeSessionKey) return;
			const targetSessionKey = activeSessionKey;
			const isActiveSession = () =>
				activeSessionKeyRef.current === targetSessionKey;
			try {
				await ensureDraftRuntime();
				if (!isActiveSession()) return;
				await rpcForSession<void>(targetSessionKey, {
					type: "set_thinking_level",
					level,
				});
				if (isActiveSession()) {
					setAgentState((current) =>
						current ? { ...current, thinkingLevel: level } : current,
					);
				}
			} catch (error) {
				if (isActiveSession())
					setFatalError(error instanceof Error ? error.message : String(error));
			}
		},
		[
			activeSessionKey,
			activeSessionKeyRef,
			ensureDraftRuntime,
			hasIdentifiedSession,
			rpcForSession,
			setAgentState,
			setDraftThinkingLevel,
			setFatalError,
		],
	);

	return {
		sending,
		composerLocked,
		sendSubmission,
		handleEditQueued,
		handleSendQueuedNow,
		handleSendNow,
		stop,
		changeModel,
		changeThinking,
		resumeProjectMcpPrompt,
		failProjectMcpPrompt,
		cancelProjectMcpPrompt,
	};
}
