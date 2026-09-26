import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useRef,
} from "react";

import type { ChatSubmission } from "@/lib/chat-submission";
import { reduceConversationActions } from "@/lib/conversation-replay";
import type {
	ConversationAction,
	ConversationState,
} from "@/lib/conversation-types";
import { toConversationAction } from "@/lib/conversation-runtime-adapter";
import type { PiloClientEventMessage } from "@/lib/pilo-client";
import { runtimeErrorMessage } from "@/lib/pi-runtime";
import type { PiloRuntimeEvent } from "@/lib/pi-runtime";
import { REMOTE_SEQUENCE_KEY } from "./remote-client";
import {
	isRpcResponse,
	reducerContext,
	type RetryState,
} from "./remote-app-model";
import type { WebPiloClient } from "./web-pilo-client";

type PendingRpc = {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	timer: number;
};

export type QueuedSubmission = {
	submission: ChatSubmission;
	queueKind: "steer" | "follow_up";
};

export type RemoteRpc = <T>(
	command: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<T>;

export type RemoteSessionRpc = <T>(
	targetSessionKey: string,
	command: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<T>;

type UseRemoteChatTransportOptions = {
	client: WebPiloClient | null;
	handleExpiredAuth: (error: unknown) => boolean;
	setFatalError: (message: string | null) => void;
	setResyncKey: Dispatch<SetStateAction<number>>;
	setConversation: Dispatch<SetStateAction<ConversationState>>;
	scheduleRuntimeActivityRefresh: () => void;
	refreshAllSessions: () => Promise<void>;
	refreshAgentConfigRef: MutableRefObject<(() => Promise<void>) | null>;
	activeSessionKeyRef: MutableRefObject<string | null>;
	queuedSubmissionsRef: MutableRefObject<Map<string, QueuedSubmission>>;
	setCompacting: Dispatch<SetStateAction<boolean>>;
	setRetryState: Dispatch<SetStateAction<RetryState | null>>;
};

export function useRemoteChatTransport({
	client,
	handleExpiredAuth,
	setFatalError,
	setResyncKey,
	setConversation,
	scheduleRuntimeActivityRefresh,
	refreshAllSessions,
	refreshAgentConfigRef,
	activeSessionKeyRef,
	queuedSubmissionsRef,
	setCompacting,
	setRetryState,
}: UseRemoteChatTransportOptions) {
	const rpcSequenceRef = useRef(0);
	const pendingRpcRef = useRef(new Map<string, PendingRpc>());

	const handleSocketMessage = useCallback(
		(message: PiloClientEventMessage) => {
			if (message.type === "resyncRequired") {
				window.localStorage.setItem(
					REMOTE_SEQUENCE_KEY,
					String(message.latestSequence),
				);
				setResyncKey((value) => value + 1);
				return;
			}
			if (message.type !== "events") return;
			let lastSequence = 0;
			const actions: ConversationAction[] = [];
			for (const event of message.events) {
				lastSequence = Math.max(lastSequence, event.sequence);
				if (event.type === "rpc_message" && isRpcResponse(event.message)) {
					const id = event.message.id;
					if (id) {
						const pending = pendingRpcRef.current.get(id);
						if (pending) {
							window.clearTimeout(pending.timer);
							pendingRpcRef.current.delete(id);
							if (event.message.success) pending.resolve(event.message.data);
							else
								pending.reject(
									new Error(event.message.error || "Pi command failed"),
								);
						}
					}
				}
				// Running/unread markers track every session, not just the visible one.
				switch (event.type) {
					case "user_message_start":
					case "assistant_message_start":
					case "assistant_message_end":
					case "runtime_error":
						scheduleRuntimeActivityRefresh();
						break;
					case "process_state":
						if (event.state === "stopped" || event.state === "failed") {
							scheduleRuntimeActivityRefresh();
						}
						break;
				}
				if (event.sessionKey !== activeSessionKeyRef.current) continue;
				switch (event.type) {
					case "compaction_start":
						setCompacting(true);
						break;
					case "compaction_end":
						setCompacting(false);
						break;
					case "auto_retry_start":
						setRetryState({
							kind: "agent",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						});
						break;
					case "auto_retry_end":
						setRetryState(null);
						break;
					case "summarization_retry_scheduled":
						setRetryState({
							kind: "summary",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						});
						break;
					case "summarization_retry_finished":
						setRetryState(null);
						break;
				}
				const action = toConversationAction(event as PiloRuntimeEvent);
				if (action) actions.push(action);
				if (event.type === "assistant_message_end") {
					window.setTimeout(() => {
						void refreshAllSessions();
						void refreshAgentConfigRef.current?.();
					}, 500);
				}
			}
			if (lastSequence > 0) {
				window.localStorage.setItem(REMOTE_SEQUENCE_KEY, String(lastSequence));
			}
			if (actions.length > 0) {
				setConversation((current) => {
					let next = current;
					for (const action of actions) {
						if (action.type === "user_message_start") {
							const pending = next.pendingUsers[0];
							if (pending?.queueKind) {
								queuedSubmissionsRef.current.delete(pending.clientMessageId);
							}
						}
						next = reduceConversationActions(next, [action], reducerContext);
					}
					return next;
				});
			}
		},
		[
			activeSessionKeyRef,
			queuedSubmissionsRef,
			refreshAgentConfigRef,
			refreshAllSessions,
			scheduleRuntimeActivityRefresh,
			setCompacting,
			setConversation,
			setResyncKey,
			setRetryState,
		],
	);

	const rpcForSession = useCallback(
		async <T>(
			targetSessionKey: string,
			command: Record<string, unknown>,
			timeoutMs = 10_000,
		): Promise<T> => {
			if (!client) throw new Error("Chat is not ready");
			rpcSequenceRef.current += 1;
			const id = "remote-" + Date.now() + "-" + String(rpcSequenceRef.current);
			const response = new Promise<T>((resolve, reject) => {
				const timer = window.setTimeout(() => {
					pendingRpcRef.current.delete(id);
					reject(new Error("Pi command timed out"));
				}, timeoutMs);
				pendingRpcRef.current.set(id, {
					resolve: (value) => resolve(value as T),
					reject,
					timer,
				});
			});
			try {
				await client.sendChatCommand(targetSessionKey, { ...command, id });
			} catch (error) {
				const pending = pendingRpcRef.current.get(id);
				if (pending) {
					window.clearTimeout(pending.timer);
					pendingRpcRef.current.delete(id);
					pending.reject(error);
				}
			}
			return response;
		},
		[client],
	);

	const rpc = useCallback(
		<T>(command: Record<string, unknown>, timeoutMs = 10_000) => {
			const targetSessionKey = activeSessionKeyRef.current;
			if (!targetSessionKey) throw new Error("Chat is not ready");
			return rpcForSession<T>(targetSessionKey, command, timeoutMs);
		},
		[rpcForSession, activeSessionKeyRef],
	);

	// 与桌面端 chat-page.tsx 的 abortPiRetry 对齐；abort_retry 已在 Remote 命令白名单内。
	const abortPiRetry = useCallback(
		() =>
			rpc<void>({ type: "abort_retry" })
				.then(() => setRetryState(null))
				.catch((error: unknown) => {
					if (!handleExpiredAuth(error))
						setFatalError(runtimeErrorMessage(error));
				}),
		[rpc, handleExpiredAuth, setFatalError, setRetryState],
	);

	return { handleSocketMessage, rpcForSession, rpc, abortPiRetry };
}
