import { useCallback, useEffect, useRef } from "react";

import { coalesceConversationActions } from "@/lib/conversation-reducer";
import type { ConversationAction } from "@/lib/conversation-types";

function isFrameBatchedAction(action: ConversationAction) {
	return (
		action.type === "assistant_text_delta" ||
		action.type === "assistant_thinking_delta" ||
		action.type === "tool_execution_update"
	);
}

export function useRuntimeConversationDispatch(
	dispatchConversationBatch: (
		targetSessionId: string,
		actions: readonly ConversationAction[],
	) => void,
) {
	const pendingRuntimeActionsRef = useRef<{
		sessionId: string;
		actions: ConversationAction[];
	} | null>(null);
	const runtimeActionFrameRef = useRef<number | null>(null);

	const flushRuntimeActions = useCallback(() => {
		if (runtimeActionFrameRef.current !== null) {
			cancelAnimationFrame(runtimeActionFrameRef.current);
			runtimeActionFrameRef.current = null;
		}
		const pending = pendingRuntimeActionsRef.current;
		pendingRuntimeActionsRef.current = null;
		if (!pending || pending.actions.length === 0) return;
		dispatchConversationBatch(
			pending.sessionId,
			coalesceConversationActions(pending.actions),
		);
	}, [dispatchConversationBatch]);

	const queueRuntimeAction = useCallback(
		(sessionId: string, action: ConversationAction) => {
			if (
				pendingRuntimeActionsRef.current &&
				pendingRuntimeActionsRef.current.sessionId !== sessionId
			) {
				flushRuntimeActions();
			}
			const pending = pendingRuntimeActionsRef.current ?? {
				sessionId,
				actions: [],
			};
			pending.actions.push(action);
			pendingRuntimeActionsRef.current = pending;
			if (runtimeActionFrameRef.current !== null) return;
			runtimeActionFrameRef.current = requestAnimationFrame(() => {
				runtimeActionFrameRef.current = null;
				flushRuntimeActions();
			});
		},
		[flushRuntimeActions],
	);

	const dispatchConversationActions = useCallback(
		(targetSessionId: string, actions: readonly ConversationAction[]) => {
			flushRuntimeActions();
			dispatchConversationBatch(targetSessionId, actions);
		},
		[dispatchConversationBatch, flushRuntimeActions],
	);

	const dispatchConversation = useCallback(
		(targetSessionId: string, action: ConversationAction) => {
			dispatchConversationActions(targetSessionId, [action]);
		},
		[dispatchConversationActions],
	);

	useEffect(
		() => () => {
			if (runtimeActionFrameRef.current !== null) {
				cancelAnimationFrame(runtimeActionFrameRef.current);
			}
			runtimeActionFrameRef.current = null;
			pendingRuntimeActionsRef.current = null;
		},
		[],
	);

	return {
		queueRuntimeAction,
		dispatchConversationActions,
		dispatchConversation,
	};
}

export { isFrameBatchedAction };
