import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useState,
} from "react";

import {
	type ChatImageAttachment,
	type ChatSubmission,
	summarizeChatImages,
	toPiImageContents,
} from "@/lib/chat-submission";
import { reduceConversationActions } from "@/lib/conversation-replay";
import type {
	ConversationAction,
	ConversationState,
} from "@/lib/conversation-types";
import type { PiAgentState, PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import { runtimeErrorMessage } from "@/lib/pi-runtime";
import { randomId } from "@/lib/utils";
import { reducerContext } from "./remote-app-model";
import type { QueuedSubmission, RemoteRpc } from "./use-remote-chat-transport";
import type { WebPiloClient } from "./web-pilo-client";

type UseRemoteChatActionsOptions = {
	client: WebPiloClient | null;
	activeSessionKey: string | null;
	readOnly: boolean;
	hasSelectedSession: boolean;
	hasIdentifiedSession: boolean;
	autoTitleRequestedRef: MutableRefObject<boolean>;
	queuedSubmissionsRef: MutableRefObject<Map<string, QueuedSubmission>>;
	ensureDraftRuntime: () => Promise<void>;
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
	rpc: RemoteRpc;
};

export function useRemoteChatActions({
	client,
	activeSessionKey,
	readOnly,
	hasSelectedSession,
	hasIdentifiedSession,
	autoTitleRequestedRef,
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
	rpc,
}: UseRemoteChatActionsOptions) {
	const [sending, setSending] = useState(false);

	const runLocalAction = useCallback(
		(action: ConversationAction) => {
			setConversation((current) =>
				reduceConversationActions(current, [action], reducerContext),
			);
		},
		[setConversation],
	);

	const sendSubmission = useCallback(
		async (
			submission: ChatSubmission,
			mode: "prompt" | "steer" | "follow_up",
		) => {
			if (!client || !activeSessionKey || readOnly) return;
			if (!submission.text.trim() && submission.images.length === 0) return;
			if (mode === "prompt" && (await tryHandleComposerCommand(submission)))
				return;
			const shouldAutoTitle =
				mode === "prompt" &&
				!hasSelectedSession &&
				!autoTitleRequestedRef.current;
			const now = Date.now();
			const clientMessageId = randomId();
			const descriptors = summarizeChatImages(submission.images);
			let queuedClientMessageId: string | null = null;
			// 乐观更新：与桌面端 beginTurn 对齐，先落本地 user / assistant-pending
			// 消息，再启动 runtime，避免 startChat 期间输入框毫无反馈。
			setSending(true);
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
			try {
				await ensureDraftRuntime();
				await client.sendChatCommand(activeSessionKey, {
					type: mode,
					message: submission.text,
					images: toPiImageContents(submission.images),
				});
				if (shouldAutoTitle) requestAutoTitle(submission.text);
			} catch (error) {
				if (queuedClientMessageId) {
					queuedSubmissionsRef.current.delete(queuedClientMessageId);
					runLocalAction({
						type: "local_user_queue_failed",
						clientMessageId: queuedClientMessageId,
					});
				} else {
					runLocalAction({
						type: "conversation_runtime_error",
						message: runtimeErrorMessage(error),
						timestampMs: Date.now(),
					});
				}
				handleComposerChange(submission.text);
				setImages(submission.images);
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSending(false);
			}
		},
		[
			activeSessionKey,
			autoTitleRequestedRef,
			clearComposer,
			client,
			ensureDraftRuntime,
			handleComposerChange,
			handleExpiredAuth,
			queuedSubmissionsRef,
			readOnly,
			requestAutoTitle,
			runLocalAction,
			hasSelectedSession,
			tryHandleComposerCommand,
			setFatalError,
			setImages,
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
			setSending(true);
			try {
				await rpc<void>({ type: "clear_queue" });
				await remaining.reduce<Promise<void>>(
					(promise, [, queued]) =>
						promise.then(() =>
							rpc<void>({
								type: queued.queueKind,
								message: queued.submission.text,
								images: toPiImageContents(queued.submission.images),
							}),
						),
					Promise.resolve(),
				);
				queuedSubmissionsRef.current.delete(clientMessageId);
				runLocalAction({
					type: "local_user_queue_failed",
					clientMessageId,
				});
				handleComposerChange(item.submission.text);
				setImages(item.submission.images);
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSending(false);
			}
		},
		[
			activeSessionKey,
			client,
			handleComposerChange,
			handleExpiredAuth,
			queuedSubmissionsRef,
			rpc,
			runLocalAction,
			setFatalError,
			setImages,
		],
	);

	const handleSendQueuedNow = useCallback(
		async (clientMessageId: string) => {
			if (!client || !activeSessionKey) return;
			const item = queuedSubmissionsRef.current.get(clientMessageId);
			if (!item) return;
			const queued = [...queuedSubmissionsRef.current.entries()];
			const remaining = queued.filter(([id]) => id !== clientMessageId);
			setSending(true);
			try {
				await rpc<void>({ type: "clear_queue" });
				await rpc<void>({ type: "abort" });
				runLocalAction({
					type: "local_turn_abort",
					timestampMs: Date.now(),
				});
				for (const [id] of queued) {
					runLocalAction({
						type: "local_user_queue_failed",
						clientMessageId: id,
					});
				}
				queuedSubmissionsRef.current.clear();

				const now = Date.now();
				runLocalAction({
					type: "local_user_submit",
					clientMessageId,
					text: item.submission.text,
					images: summarizeChatImages(item.submission.images),
					timestampMs: now,
				});
				await client.sendChatCommand(activeSessionKey, {
					type: "prompt",
					message: item.submission.text,
					images: toPiImageContents(item.submission.images),
				});

				for (const [id, pending] of remaining) {
					queuedSubmissionsRef.current.set(id, pending);
					runLocalAction({
						type: "local_user_queue",
						clientMessageId: id,
						text: pending.submission.text,
						images: summarizeChatImages(pending.submission.images),
						queueKind: pending.queueKind,
						timestampMs: now,
					});
				}
				await remaining.reduce<Promise<void>>(
					(promise, [, pending]) =>
						promise.then(() =>
							rpc<void>({
								type: pending.queueKind,
								message: pending.submission.text,
								images: toPiImageContents(pending.submission.images),
							}),
						),
					Promise.resolve(),
				);
			} catch (error) {
				if (!handleExpiredAuth(error)) {
					setFatalError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				setSending(false);
			}
		},
		[
			activeSessionKey,
			client,
			handleExpiredAuth,
			queuedSubmissionsRef,
			rpc,
			runLocalAction,
			setFatalError,
		],
	);

	const stop = useCallback(async () => {
		if (!client || !activeSessionKey) return;
		runLocalAction({ type: "local_turn_abort", timestampMs: Date.now() });
		await client
			.sendChatCommand(activeSessionKey, { type: "abort" })
			.catch(() => undefined);
	}, [activeSessionKey, client, runLocalAction]);

	const changeModel = useCallback(
		async (model: PiModel) => {
			if (!hasIdentifiedSession) {
				setDraftModel(model);
				setDraftThinkingLevel(model.defaultThinkingLevel ?? null);
				return;
			}
			try {
				const next = await rpc<PiModel>({
					type: "set_model",
					provider: model.provider,
					modelId: model.id,
				});
				setAgentState((current) =>
					current ? { ...current, model: next } : current,
				);
			} catch (error) {
				setFatalError(error instanceof Error ? error.message : String(error));
			}
		},
		[
			hasIdentifiedSession,
			rpc,
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
			try {
				await rpc<void>({ type: "set_thinking_level", level });
				setAgentState((current) =>
					current ? { ...current, thinkingLevel: level } : current,
				);
			} catch (error) {
				setFatalError(error instanceof Error ? error.message : String(error));
			}
		},
		[
			hasIdentifiedSession,
			rpc,
			setAgentState,
			setDraftThinkingLevel,
			setFatalError,
		],
	);

	return {
		sending,
		sendSubmission,
		handleEditQueued,
		handleSendQueuedNow,
		stop,
		changeModel,
		changeThinking,
	};
}
